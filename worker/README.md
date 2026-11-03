# rememberKey Worker —— API、D1 与运维

本目录提供 rememberKey 的 **API-only Cloudflare Worker**。生产公开入口是 Cloudflare Pages：Pages Function 通过 `API` Service binding 转发 `/api/*`、`/healthz` 和 `/readyz`，Worker 自身不公开 `workers.dev`、preview URL、路由或自定义域。D1 是唯一业务数据存储，Worker 不保存前端静态资源。

- 完整部署步骤：[../docs/cloudflare-deployment.md](../docs/cloudflare-deployment.md)
- 旧 MySQL 数据迁移：[../tools/migrate/README.md](../tools/migrate/README.md)
- 接口与加密格式：[../PROTOCOL.md](../PROTOCOL.md)

## 目录

| 路径 | 作用 |
| --- | --- |
| `src/index.ts` | API 入口：配置校验、Origin 强制、限流、路由和健康检查 |
| `src/auth.ts` / `sync.ts` / `admin.ts` | 账号与设备、同步、管理接口 |
| `migrations/0001_init.sql` | D1 schema v1 |
| `scripts/dev.mjs` | 单独启动 Worker 的 Windows 临时目录包装器 |
| `scripts/migrate-d1.mjs` | 将离线 MySQL 导出导入空的隔离 D1 |
| `scripts/verify-d1.mjs` | 全量核对导入结果、序号高水位与 transient 表 |
| `wrangler.jsonc` | local/preview/production 的 D1、`RK_ORIGIN` 与私有入口配置 |
| `.dev.vars.example` | 本地引导令牌模板；实际 `.dev.vars` 不入库 |

## 环境与公开入口

| 环境 | 页面 origin | Worker | D1 |
| --- | --- | --- | --- |
| 本地 | `http://127.0.0.1:8788` | 本地 `rememberkey-api`，8787 | 本地 D1 |
| 预发布 | `https://staging.rememberkey-web.pages.dev` | `rememberkey-api-preview` | `rememberkey-preview` |
| 生产 | `https://rememberkey-web.pages.dev` 或自定义域 | `rememberkey-api` | `rememberkey` |

Pages 与 Worker 的同环境 `RK_ORIGIN` 必须完全一致。预发布和生产数据库 ID 必须不同，不能使用全零占位值部署。自定义域只绑定 Pages；修改公开 origin 时必须同时更新 `web/wrangler.jsonc` 和本目录配置，再重新部署两端。

## 本地开发

推荐从仓库根目录启动完整 Pages → Service binding → Worker 链路：

```sh
npm ci --prefix web
npm ci --prefix worker
npm --prefix web run build
cp worker/.dev.vars.example worker/.dev.vars  # PowerShell: Copy-Item
node scripts/dev-cloudflare.mjs
```

打开 `http://127.0.0.1:8788`。启动器会应用本地 migrations、启动两个进程并处理 Windows 临时目录；`Ctrl+C` 只停止本次创建的子进程。

协议 e2e 需要一套全新的显式状态目录：

```sh
node scripts/dev-cloudflare.mjs \
  --persist-to .tools/localdata/cloudflare-e2e \
  --bootstrap-token dev-bootstrap-token-for-integration
```

然后在另一个终端执行：

```sh
# Linux / macOS
RK_BASE=http://127.0.0.1:8788 \
RK_BOOTSTRAP_TOKEN=dev-bootstrap-token-for-integration \
node scripts/e2e.mjs

# Windows PowerShell
$env:RK_BASE = "http://127.0.0.1:8788"
$env:RK_BOOTSTRAP_TOKEN = "dev-bootstrap-token-for-integration"
node scripts/e2e.mjs
```

e2e 要求账号表为空，并会消耗引导令牌。重跑时使用新的 `--persist-to` 目录，不要删除或复用需要保留的数据。

### 单独启动 API Worker

只调试 API 时可在本目录执行：

```sh
npm ci
npm run db:migrate:local
cp .dev.vars.example .dev.vars
npm run dev -- --var RK_ORIGIN:http://127.0.0.1:8787
```

此时 API 位于 `http://127.0.0.1:8787`，没有前端静态资源；非 API 路径返回 JSON 404。`npm run dev` 会处理 Windows 下 `workerd` 的临时目录问题，不建议直接换成全局 Wrangler。

## 校验与迁移命令

```sh
npm run typecheck
npm test
npm run db:migrate:local
npm run db:migrate:preview
npm run db:migrate:production
```

远程命令会操作真实 Cloudflare 资源，执行前必须核对 `wrangler whoami`、环境、数据库名和 ID。新增 schema 变更时创建新的 `migrations/000N_*.sql`，不要修改已应用的迁移。

部署使用显式环境：

```sh
npx wrangler deploy --env preview
npx wrangler deploy --env production
```

首次建库、secret、Pages Direct Upload 和验证顺序见部署教程。已有旧系统数据时，不要把远程 schema migration 与数据导入混为一步：先停写并导出旧库，再按迁移工具说明导入空库和全量校验，验收前不得开放写入。

## 运维

- **实时日志**：`npx wrangler tail --env preview` 或 `--env production`。日志不应包含请求正文、密码、私钥或令牌。
- **健康检查**：通过 Pages origin 请求 `GET /healthz` 和 `GET /readyz`；后者执行 D1 `SELECT 1`。
- **备份**：`npx wrangler d1 export rememberkey --remote --env production --output backup.sql`。导出仍含敏感账号元数据与密文，必须加密存放。
- **回滚**：`npx wrangler deployments list --env production` 查看版本，`npx wrangler rollback --env production` 回滚 Worker；Pages 在 Dashboard 的 Deployments 中回滚。应用回滚不会回滚 D1 数据。
- **更新 schema**：先验证本地迁移，再执行目标环境的远程 migration。只允许部署仍兼容当前 D1 schema 的回滚版本。

## 安全与运行时事实

- **同源强制**：除 GET/HEAD 外的 API 请求必须带与 `RK_ORIGIN` 完全一致的 `Origin`，否则返回 `403 origin_rejected`。Pages Function 还拒绝固定公开 origin 之外的 API 请求。
- **会话**：access token 15 分钟；刷新令牌 30 天并轮换、检测重用。刷新 cookie 为 `rk_refresh`，`Path=/api/v1/auth`、`HttpOnly`、`SameSite=Strict`；HTTPS origin 下带 `Secure`。
- **限流**：认证、注册、账户查询和设备登记等路径使用每 isolate 内存计数（30 次/60 秒），不是分布式硬限制；硬性保证需要 Cloudflare WAF Rate Limiting。
- **D1 并发**：不使用交互式事务。revision 比较写入、challenge 消费、refresh 轮换、首位管理员唯一、邀请单次使用和 operationId 幂等由条件语句、唯一约束及原子 `DB.batch()` 保证。
- **D1 读副本**：默认未启用 Read Replication。本实现未使用 D1 Sessions API 强制一致性读，启用前必须重新评估会话与同步游标路径。
- **限制**：请求正文最大 2 MiB，加密信封最大 128 KiB，同步批次最多 100 个 operation，快照最多 10000 条。
- **真实部署边界**：本地测试不能替代真实 Cloudflare、自定义域、远程 D1、WAF、多 isolate 并发或真实旧数据迁移验收。

## 排错

| 现象 | 原因与处理 |
| --- | --- |
| Windows 下 `CreateDirectory: #5 access denied` | 使用根目录 `node scripts/dev-cloudflare.mjs` 或本目录 `npm run dev`，不要直接调用另一套全局 Wrangler。 |
| `403 origin_rejected` | 检查 Pages 与 Worker 的同环境 `RK_ORIGIN`，以及实际浏览器 origin。预发布不能使用随机部署哈希域名。 |
| 所有请求 `500 internal_error` | 查看 `wrangler tail` 是否出现 `invalid RK_ORIGIN`；生产必须为精确 HTTPS origin，不能带路径或尾斜杠。 |
| `503 upstream_unavailable` | Pages 的 `API` Service binding 未指向已部署的对应 Worker，或内部调用失败。 |
| `/readyz` 返回 503 | D1 migration 未应用，或当前环境的 `database_id`、数据库名、binding 配置错误。 |
| 首次注册 `403 invalid_invitation` | 引导 secret 未设置在正确环境、值不匹配，或账号表已非空。首位管理员之后使用一次性邀请。 |
| 非 API 路径返回 JSON 404 | API-only Worker 的预期行为；页面应通过 Pages 公开 origin 访问，而不是直接访问 Worker。 |
