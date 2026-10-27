# rememberKey

自托管的 API Key 统一管理应用。密钥在客户端加密后才上传，服务端只保存密文，管理员也无法解密任何用户的密钥库。

本文件是交付说明的**唯一权威来源**，记录当前真实实现状态与未验证范围。逐项协议细节见 [PROTOCOL.md](PROTOCOL.md)。

## 需求达成情况

| 需求 | 实现状态 | 说明 |
| --- | --- | --- |
| 服务端一键部署 | 已实现 | [`deploy/compose.yaml`](deploy/compose.yaml) + [`scripts/deploy.sh`](scripts/deploy.sh)，Caddy 自动签发证书 |
| 非对称密钥认证 | 已实现 | 按批准方案采用 HTTPS + 端到端加密 + Ed25519 公钥认证，**不使用 OpenSSH 密钥、不使用 SSH 隧道** |
| 用户权限校验 | 已实现 | 管理员/普通用户角色，服务端按 `account_id` 强隔离；管理员不能解密用户数据 |
| 数据同步 + 离线存储 | 已实现 | 客户端 IndexedDB 密文缓存 + 签名 outbox；冲突不静默覆盖 |
| 多平台轻量客户端 | 部分实现 | Web/PWA 已实现并验证构建；桌面端为实验性工程，见下方限制 |

## 架构

```
浏览器 / PWA  ──HTTPS──┐
                       ├──> Caddy（TLS 终止、安全响应头）──> Go 服务（:8080）──> SQLite
桌面端（实验性）───────┘
```

- **服务端**：Go + 纯 Go SQLite 驱动（`modernc.org/sqlite`，CGO 可关闭），单实例部署。
- **客户端**：React 19 + TypeScript + Vite，`libsodium-wrappers-sumo` 提供密码学原语。
- **加密**：Argon2id13 派生主密钥，XChaCha20-Poly1305 加密，X25519 sealed box 封装数据密钥，Ed25519 签名认证。

### 密钥分层

1. 用户主密码经 Argon2id 派生密钥，解封根密钥；恢复码可独立解封同一根密钥。
2. 根密钥解封身份签名私钥与加密私钥。
3. 每条记录使用独立随机数据密钥加密，数据密钥再经账户公钥封装。

服务端可见的只有：账号、设备、记录数量、密文大小与同步时间。**搜索在客户端解密后进行，服务端不建明文索引。**

## 快速开始

### 一键部署（Linux 服务器）

前置条件：一台可解析公网域名的 Linux 主机，放行 TCP 80/443，已安装 Docker 与 Compose。

```sh
sudo bash scripts/deploy.sh vault.example.com admin@example.com
```

脚本会生成 `deploy/.env`（含随机 `RK_BOOTSTRAP_TOKEN`，权限 600）、准备数据目录属主并启动服务。首次注册时用该引导令牌创建首位管理员；之后由管理员发放一次性邀请。

备份与恢复：

```sh
sudo bash scripts/backup.sh                 # 停机一致性备份
sudo bash scripts/restore.sh <archive>      # 需显式确认
```

### 本地开发

```sh
# 后端
cd server && RK_DEV=true RK_ORIGIN=http://localhost:8080 \
  RK_DATA_DIR=../.tools/data RK_BOOTSTRAP_TOKEN=dev-token \
  RK_WEB_DIR=../web/dist go run .

# 前端
cd web && npm ci && npm run dev
```

生产强制 HTTPS Origin；仅 `RK_DEV=true` 且 Origin 为回环地址时允许 HTTP。

## 构建与测试

```sh
# 后端
cd server && go test ./...          # 10 项测试
go build -trimpath -o rememberkey .

# 前端
cd web && npm ci && npm run build && npm test   # 9 项测试

# 端到端（需先启动后端）
node scripts/e2e.mjs                # 35 项断言
```

仓库内便携工具链（非本机安装，供沙箱环境复现）：`.tools/go/bin/go.exe`。使用它时需把 Go 缓存显式指向工作区，否则默认缓存路径不可写：

```powershell
$env:GOCACHE="$PWD\server\.cache\build"; $env:GOMODCACHE="$PWD\server\.cache\mod"
& "$PWD\.tools\go\bin\go.exe" build -C server -o "$PWD\.tools\out\rememberkey.exe" .
```

前端构建在本机需要可用的子进程管道与可写临时目录（esbuild 依赖）。若系统 TEMP 不可写，可把 `TEMP`/`TMP` 指向项目内目录。

## 已验证范围

在本机实际执行并通过：

- 后端 `go test ./...` 全部通过（含一次消费 challenge、refresh 重放撤销、幂等冲突、跨账户隔离、签名校验、禁用账户、Origin 校验、并发同 revision 仅一个胜出）。`go vet` 通过。
- 后端编译产出可用二进制，并在 `127.0.0.1:8099` 实际启动、健康检查返回 200。
- **`scripts/e2e.mjs` 对真实后端 35 项断言全部通过**：引导注册与令牌不可重用、challenge 单次消费与错误签名拒绝、Origin 强制校验、首写生效与 revision 递增、operationId 重放幂等、篡改正文返回 409、陈旧 baseRevision 产生冲突而非静默覆盖、跨账户签名拒绝、变更流与快照一致、邀请一次性、跨账户数据完全隔离（同一记录 ID 在各账户中互不影响）、非管理员无法访问管理接口、设备撤销后令牌立即失效且不可重新注册。
- 前端 `npm run build` 成功，`npm test` 9 项通过。
- 部署脚本、Caddy 与 Compose 配置经人工审查一致（Caddy 容器内 8080/8443 对应公网 80/443）。

**未验证**：真实浏览器端到端流程（含离线与自动锁定）、Docker 镜像实际构建、Tauri 桌面构建与安装包、Windows/macOS 原生客户端、任何形式的独立密码学审计。上述内容不得当作已完成交付。

## 安全边界（务必阅读）

- **主密码或恢复码全部丢失则数据不可恢复。** 服务端没有任何明文、根密钥或重置能力，管理员也无法代你解锁。
- **公开的账户查询接口会返回加密密钥包**，这允许账号枚举与针对 `passwordWrap` 的离线口令猜测。Argon2id 只能延缓、不能消除该风险，请使用强主密码。
- 设备撤销只阻止后续服务端访问，**无法远程擦除已下载或被解密的离线数据**，也不等同于轮换全部密钥。
- 端到端加密不防御已解锁设备上的恶意软件、恶意浏览器扩展或被篡改的客户端；Web 服务被攻陷时仍可能投放恶意脚本。
- 浏览器无法保证密码、剪贴板或内存副本被物理擦除；剪贴板延时清空仅在浏览器允许时尽力执行。
- 单一 SQLite 实例，不支持多副本横向扩展。速率限制为进程级，位于反向代理后时按代理地址共享配额。

## 未实现的 v1 功能

以下均为明确未实现，不要假定可用：完整根密钥轮换、团队共享密钥库、硬件密钥（WebAuthn/FIDO2）、历史日志裁剪与过期游标 `410` 重同步、大快照分页（超过 10000 条返回 `snapshot_too_large`）、明文导入导出、移动原生客户端、独立签名的发行产物。

## 进一步阅读

- [PROTOCOL.md](PROTOCOL.md) —— 冻结的 v1 接口与加密格式契约
- [server/README.md](server/README.md) —— 后端存储、授权与运维限制
- [server/openapi.yaml](server/openapi.yaml) —— OpenAPI 描述
- [web/README.md](web/README.md) —— 前端实现细节与安全边界