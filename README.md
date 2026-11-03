# rememberKey

自托管的 API Key 统一管理应用。密钥在浏览器端加密后才上传，服务端只保存密文，管理员（包括 Cloudflare 账号持有者）也无法解密任何用户的密钥库。

当前部署形态是 **Cloudflare Pages + Workers + D1**：Pages 提供前端静态资源，Pages Function 通过 Service binding 把同源 API 请求转发到内部 Worker，D1 为唯一数据存储。不需要自建服务器、反向代理或数据库。迁移前基于 Go + MySQL + Docker/Caddy 的实现已退役，保留在 `legacy/` 仅供历史参考。

- 接口与加密格式契约：[PROTOCOL.md](PROTOCOL.md)
- Cloudflare 部署教程：[docs/cloudflare-deployment.md](docs/cloudflare-deployment.md)
- Worker 与 D1 运维：[worker/README.md](worker/README.md)
- 前端实现与限制：[web/README.md](web/README.md)

## 架构

```
浏览器 / PWA（全部加密：Argon2id + XChaCha20-Poly1305 + X25519 + Ed25519）
        │  HTTPS，同源 /api/v1
        ▼
Cloudflare Pages ─── 静态资源（web/dist）
        │  Pages Function + API Service binding
        ▼
内部 Cloudflare Worker ─── D1（只有密文与账号元数据）
```

- **服务端**：TypeScript Cloudflare Worker（`worker/`），D1 是唯一存储，无第三方运行时依赖。
- **客户端**：React 19 + TypeScript + Vite，`libsodium-wrappers-sumo` 提供密码学原语。
- **加密**：Argon2id13 派生主密钥，XChaCha20-Poly1305 加密，X25519 sealed box 封装数据密钥，Ed25519 签名认证。
- **同源**：前端与 API 使用同一个 Pages 公开 origin，不返回 CORS 头；所有非 GET/HEAD API 请求校验 `Origin` 必须等于 `RK_ORIGIN`，否则 `403 origin_rejected`。API Worker 不公开独立入口。
- **会话**：access token 15 分钟（`Authorization: Bearer`），刷新令牌 30 天、轮换 + 重用检测；刷新 cookie `Secure`（HTTPS 下）、`HttpOnly`、`SameSite=Strict`、`Path=/api/v1/auth`。

### 密钥分层

1. 用户主密码经 Argon2id 派生密钥，解封根密钥；恢复码可独立解封同一根密钥。
2. 根密钥解封身份签名私钥与加密私钥。
3. 每条记录使用独立随机数据密钥加密，数据密钥再经账户公钥封装。

服务端可见的只有：账号、设备、记录数量、密文大小与同步时间。**搜索在客户端解密后进行，服务端不建明文索引。**

## 需求达成情况

| 需求 | 实现状态 | 说明 |
| --- | --- | --- |
| 服务端一键部署 | 已实现（Cloudflare） | Pages + 内部 Worker + D1 配置与 Direct Upload 命令已提供，见 [部署教程](docs/cloudflare-deployment.md)；真实账号部署仍需验收 |
| 非对称密钥认证 | 已实现 | HTTPS + 端到端加密 + Ed25519 公钥认证；不使用 OpenSSH 密钥或 SSH 隧道 |
| 用户权限校验 | 已实现 | 管理员/普通用户角色，服务端按 `account_id` 强隔离；管理员不能解密用户数据 |
| 数据同步 + 离线存储 | 已实现 | 客户端 IndexedDB 密文缓存 + 签名 outbox；冲突不静默覆盖 |
| 多平台轻量客户端 | 部分实现 | Web/PWA 已实现；桌面端为实验性工程（`desktop/`） |

## 部署到 Cloudflare

前置条件：Cloudflare 账号、Node.js 20+（CI 使用 22.x）和 npm。先安装依赖并登录：

```sh
npm ci --prefix web
npm ci --prefix worker
cd worker && npx wrangler login
```

然后按照 [Cloudflare 部署教程](docs/cloudflare-deployment.md) 依次创建隔离的 D1、配置两个环境的 `RK_ORIGIN`、应用 migrations、部署内部 Worker，并通过 Direct Upload 发布 Pages。教程同时覆盖首位管理员引导、自定义域、验证、备份与回滚。

旧 Go/MySQL 数据不能直接当作全新部署切换；需要保留账号、密文、设备和同步历史时，先阅读 [离线迁移工具说明](tools/migrate/README.md)。

## 本地开发

在仓库根目录执行：

```sh
npm ci --prefix web
npm ci --prefix worker
npm --prefix web run build
cp worker/.dev.vars.example worker/.dev.vars  # PowerShell: Copy-Item
node scripts/dev-cloudflare.mjs
```

浏览器打开 `http://127.0.0.1:8788`。脚本会应用本地 D1 migrations，启动内部 API（8787）和 Pages（8788），并在退出时停止自己创建的子进程；Windows 下也会处理 `workerd` 临时目录问题。

需要隔离的测试数据时，使用一个新的显式状态目录：

```sh
node scripts/dev-cloudflare.mjs --persist-to .tools/localdata/cloudflare-e2e --bootstrap-token dev-bootstrap-token-for-integration
```

不要复用该目录重复跑需要空账号表的 e2e。需要 Vite 热更新时仍可运行 `npm --prefix web run dev`，但单独启动的 Worker 必须把 `RK_ORIGIN` 临时覆盖为 Vite origin；完整 Pages 链路更接近生产，优先推荐。

## 构建与测试

```sh
# Web：单元测试、Pages Functions 类型检查与生产构建
npm --prefix web test
npm --prefix web run typecheck:pages
npm --prefix web run build

# Worker：类型检查与单元测试
npm --prefix worker run typecheck
npm --prefix worker test

# MySQL → D1 离线迁移工具
cd tools/migrate && go test ./...
```

端到端测试先用上述 `--persist-to ... --bootstrap-token ...` 命令启动一套全新的本地 Pages 链路，再在另一个终端从仓库根目录执行：

```sh
# Linux / macOS
RK_BASE=http://127.0.0.1:8788 RK_BOOTSTRAP_TOKEN=dev-bootstrap-token-for-integration node scripts/e2e.mjs

# Windows PowerShell
$env:RK_BASE = "http://127.0.0.1:8788"
$env:RK_BOOTSTRAP_TOKEN = "dev-bootstrap-token-for-integration"
node scripts/e2e.mjs
```

`scripts/e2e.mjs` 覆盖 52 项协议断言，要求 D1 中还没有账号，并会一次性用掉引导令牌；重跑前必须使用新的隔离状态目录。

CI 见 [.github/workflows/ci.yml](.github/workflows/ci.yml)：Ubuntu + Node 22 + Go 1.23，执行 Web/Worker/迁移工具测试，并通过本地 Pages → Service binding → Worker 链路运行协议 e2e；不连接真实 Cloudflare 生产资源。

## 项目结构

```
worker/        API-only Cloudflare Worker、D1 schema、迁移与校验脚本
web/           React 19 + TypeScript + Vite 前端、Pages Functions 与配置
tools/migrate/ 旧 MySQL → D1 离线导出工具及测试
docs/          Cloudflare 设计、实施计划与部署教程
desktop/       实验性 Tauri 桌面端
scripts/       本地 Pages/Worker 启动器与协议级 e2e
legacy/        已退役的 Go + MySQL + Docker/Caddy 实现，仅供历史参考
.github/       ci.yml（Linux 验证）与 desktop.yml
```

## 威胁模型与安全边界（务必阅读）

- **主密码或恢复码全部丢失则数据不可恢复。** 服务端没有任何明文、根密钥或重置能力，管理员也无法代你解锁。
- **公开的账户查询接口会返回加密密钥。** 这允许账号枚举与针对 `passwordWrap` 的离线口令猜测。Argon2id 只能延缓、不能消除该风险，请使用强主密码。
- **设备撤销只阻止后续服务端访问，无法远程擦除已下载或被解密的离线数据**，也不等同于轮换全部密钥。
- 端到端加密不防御已解锁设备上的恶意软件、恶意浏览器扩展或被篡改的客户端。**Cloudflare 账号或部署的 Worker 代码被攻陷时，攻击者可以篡改下发的前端脚本**；请为 Cloudflare 账号开启 MFA、限制成员权限并审计部署，必要时使用 Cloudflare Access 等访问控制。
- 浏览器无法保证密码、剪贴板或内存副本被物理擦除；剪贴板延时清空仅在浏览器允许时尽力执行。
- 速率限制在 Worker **per-isolate 的内存中计数**（30 次/60 秒），不同 isolate、冷启动之间不共享，仅尽力而为；需要硬性保证请使用 Cloudflare WAF Rate Limiting 规则。
- D1 中只有密文与账号元数据，但仍然敏感：请保护 Cloudflare 账号、限制 D1 访问权限，并将 `wrangler d1 export` 的备份加密存放。

## 已知限制（v1）

- 请求正文最大 2 MiB，单个加密信封最大 128 KiB。
- 单次同步最多 100 条 operation；快照最多 10000 条，超出返回 `409 snapshot_too_large`（大快照分页未实现）。
- 默认未启用 D1 Read Replication；若启用读副本，副本读取有复制延迟，本实现未使用 D1 Sessions API 强制一致性读，启用前需重新评估会话与同步游标路径。
- 以下均为明确未实现，不要假定可用：完整根密钥轮换、团队共享密钥库、硬件密钥（WebAuthn/FIDO2）、历史日志裁剪与过期游标 `410` 重同步、明文导入导出、移动原生客户端、独立签名的发行产物。
- 桌面端（`desktop/`）为实验性工程，原生安全存储与刷新流程尚未完成验证。

**未验证**：真实 Cloudflare 账号部署、远程 D1、自定义域证书、真实 MySQL 数据迁移、WAF 限流规则、多 isolate 并发行为、Tauri 原生构建和独立密码学审计。仓库 CI 验证本地 Pages/Worker/D1 链路与协议 e2e，上述未验证内容不得当作已完成交付。

## 进一步阅读

- [PROTOCOL.md](PROTOCOL.md) —— 冻结的 v1 接口与加密格式契约
- [docs/cloudflare-deployment.md](docs/cloudflare-deployment.md) —— Pages + Worker + D1 部署教程
- [worker/README.md](worker/README.md) —— Worker、D1 迁移、备份、回滚与排错
- [tools/migrate/README.md](tools/migrate/README.md) —— 旧 MySQL 数据离线迁移约束
- [web/README.md](web/README.md) —— 前端实现细节与安全边界
- `legacy/` —— 已退役的 Go + MySQL 部署实现（历史参考）
