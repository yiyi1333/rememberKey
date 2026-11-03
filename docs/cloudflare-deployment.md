# rememberKey 部署到 Cloudflare 教程

本文介绍如何把当前项目部署为 **Cloudflare Pages + Workers + D1**，适用于全新部署，并同时建立相互隔离的预发布和生产环境。

> 如果要保留 `legacy/` 中旧 Go + MySQL 系统的账号、密文、设备和同步历史，不要把“全新部署”当作数据迁移。请先阅读 [离线迁移工具说明](../tools/migrate/README.md)，在停写、导出、导入和全量校验完成前不要开放新环境写入。

## 1. 部署架构

```text
浏览器 / PWA
    │ HTTPS，同一公开域名
    ▼
Cloudflare Pages
    ├── 静态文件：HTML、JS、CSS、WASM、PWA
    └── /api/*、/healthz、/readyz
            │ Pages Function + API Service binding
            ▼
    内部 Cloudflare Worker
            │ DB binding
            ▼
        Cloudflare D1
```

需要注意：

- 浏览器只访问 Pages 域名，前端通过相对路径 `/api/v1` 调用 API。
- API Worker 不公开 `workers.dev` 地址，也不绑定自定义域，只接受 Pages 的 Service binding 调用。
- D1 是唯一业务数据库，不需要 Go、MySQL、Docker、VPS 或反向代理。
- 预发布和生产使用不同的 Worker、D1 与 origin，不能共用数据库。
- `RK_ORIGIN` 是安全校验的一部分，必须与浏览器地址栏中的精确 origin 一致。

## 2. 本教程使用的资源名称

| 资源 | 预发布 | 生产 |
| --- | --- | --- |
| Pages 项目 | `rememberkey-web` | `rememberkey-web` |
| Pages 分支 | `staging` | `main`（生产分支） |
| 页面 origin | `https://staging.rememberkey-web.pages.dev` | `https://rememberkey-web.pages.dev` |
| API Worker | `rememberkey-api-preview` | `rememberkey-api` |
| D1 数据库 | `rememberkey-preview` | `rememberkey` |

Pages 项目名需要在你的 Cloudflare 账号内可用。如果改用其他项目名，必须同步修改：

1. `web/wrangler.jsonc` 的 `name`；
2. 两个配置文件中的 Pages origin；
3. 后续 `pages project create` 和 `pages deploy` 命令中的项目名。

## 3. 前置准备

准备以下内容：

- 一个 Cloudflare 账号，建议开启 MFA；
- Node.js 20 或更高版本，推荐 Node.js 22；
- npm；
- 一个可选的自定义域名，例如 `keys.example.com`。

在仓库根目录安装锁定版本的依赖：

```sh
npm ci --prefix web
npm ci --prefix worker
```

登录并确认当前 Cloudflare 账号：

```sh
cd worker
npx wrangler login
npx wrangler whoami
```

`wrangler login` 会打开浏览器完成授权。不要在全局安装另一套 Wrangler；本文命令都使用项目锁定的版本。

## 4. 创建两个 D1 数据库

仍在 `worker/` 目录执行：

```sh
npx wrangler d1 create rememberkey-preview
npx wrangler d1 create rememberkey
```

保存两条命令输出中的 `database_id`，然后编辑 `worker/wrangler.jsonc`：

- 顶层 `d1_databases[0].database_id`：填入生产库 `rememberkey` 的 ID；
- `env.production.d1_databases[0].database_id`：填入生产库 ID；
- `env.preview.d1_databases[0].database_id`：填入预发布库 `rememberkey-preview` 的 ID；
- 所有 `binding` 必须保持为 `DB`，`migrations_dir` 必须保持为 `migrations`。

配置结果应类似：

```jsonc
{
  "d1_databases": [{
    "binding": "DB",
    "database_name": "rememberkey",
    "database_id": "<生产 database_id>",
    "migrations_dir": "migrations"
  }],
  "env": {
    "preview": {
      "d1_databases": [{
        "binding": "DB",
        "database_name": "rememberkey-preview",
        "database_id": "<预发布 database_id>",
        "migrations_dir": "migrations"
      }]
    },
    "production": {
      "d1_databases": [{
        "binding": "DB",
        "database_name": "rememberkey",
        "database_id": "<生产 database_id>",
        "migrations_dir": "migrations"
      }]
    }
  }
}
```

不要保留全零占位 ID，也不要把预发布环境指向生产数据库。数据库 ID 不是密码，但不应把数据库导出文件或访问凭据提交到仓库。

## 5. 创建 Pages 项目

进入 `web/` 目录：

```sh
cd ../web
npx wrangler pages project create rememberkey-web --production-branch main
```

如果项目已经存在，跳过该命令。若在 Dashboard 手动创建，请选择 **Direct Upload / 直接上传**，并将生产分支设置为 `main`。本教程不使用 Pages 的 Git 自动集成。

这里的 `main` 是 Pages 的生产分支名称，不要求你本地必须存在同名 Git 分支；后续直接上传时通过 `--branch main` 指定生产部署，通过 `--branch staging` 指定预发布部署。

## 6. 配置公开 origin

检查 `web/wrangler.jsonc` 和 `worker/wrangler.jsonc`，确保同一环境的 `RK_ORIGIN` 完全一致：

```text
preview:    https://staging.rememberkey-web.pages.dev
production: https://rememberkey-web.pages.dev
```

origin 必须满足以下规则：

- 包含协议和主机，例如 `https://rememberkey-web.pages.dev`；
- 生产环境必须使用 HTTPS；
- 不带尾斜杠、路径、查询参数或用户信息；
- 不使用 `*.pages.dev` 通配符；
- 预发布只使用固定的 `staging` 分支别名，不使用每次部署生成的随机哈希域名。

两个文件中的值必须一起修改。只改一边会导致 Pages 转发层或 Worker 返回 `403 origin_rejected`。

## 7. 应用 D1 migrations

回到 `worker/` 目录，分别迁移预发布库和生产库：

```sh
cd ../worker
npm run db:migrate:preview
npm run db:migrate:production
```

这两条命令分别等价于对 `rememberkey-preview` 和 `rememberkey` 执行远程 D1 迁移。命令可能要求确认目标数据库，执行前应核对数据库名称和环境。

后续只有新增 `worker/migrations/000N_*.sql` 时才需要再次执行对应环境的迁移；不要修改已经应用过的旧迁移文件。

## 8. 部署内部 API Worker

首次部署两个 Worker：

```sh
npx wrangler deploy --env preview
npx wrangler deploy --env production
```

当前配置已经为两个环境设置：

```jsonc
"workers_dev": false,
"preview_urls": false
```

因此 Worker 没有公开浏览器入口，这是预期行为。不要给 `rememberkey-api` 或 `rememberkey-api-preview` 添加公开 routes 或自定义域。

## 9. 设置首位管理员引导令牌

全新空数据库需要一个引导令牌来注册首位管理员。为两个环境分别设置不同的随机令牌：

```sh
npx wrangler secret put RK_BOOTSTRAP_TOKEN --env preview
npx wrangler secret put RK_BOOTSTRAP_TOKEN --env production
```

每条命令都会交互式要求输入值。请使用密码管理器生成高强度随机字符串，并临时安全保存，稍后注册首位管理员时需要使用。

注意：

- secret 设置在 **Worker** 上，不是 Pages 上；
- 不要把令牌写入 `wrangler.jsonc`、前端代码、Git 或命令行参数；
- 令牌只在账号表为空时有效；
- 如果通过旧系统迁移导入了已有账号，不要设置引导令牌，应使用原账号重新认证。

## 10. 构建并部署 Pages

进入 `web/` 目录并构建前端：

```sh
cd ../web
npm run build
```

构建产物位于 `web/dist`，`web/public/_headers` 和 `_routes.json` 会一并复制到产物中。然后先发布预发布环境：

```sh
npm run pages:deploy -- --project-name rememberkey-web --branch staging
```

预发布验证通过后，再发布生产环境：

```sh
npm run pages:deploy -- --project-name rememberkey-web --branch main
```

Pages 会根据部署分支选择配置：

- `staging` 等非生产分支使用 `env.preview`；
- 生产分支 `main` 使用 `env.production`。

必须从 `web/` 目录部署 `dist`，这样 Wrangler 才能同时读取 `web/wrangler.jsonc` 和 `web/functions/`。不要把 API Worker 的地址写入前端环境变量，也不要改成跨域 API。

## 11. 验证部署

将下面的域名替换为正在验证的环境。Windows PowerShell 中可以把 `curl` 换成 `curl.exe`。

### 11.1 健康检查

```sh
curl https://staging.rememberkey-web.pages.dev/healthz
curl https://staging.rememberkey-web.pages.dev/readyz
```

预期结果：

```text
ok
ready
```

`/healthz` 只表示 Worker 可运行；`/readyz` 还会实际查询 D1。生产环境使用同样检查：

```sh
curl https://rememberkey-web.pages.dev/healthz
curl https://rememberkey-web.pages.dev/readyz
```

### 11.2 页面与 API

1. 用浏览器打开对应 Pages origin，确认 React 页面和静态资源正常加载。
2. 确认页面没有 CSP、WASM 或 Service Worker 相关报错。
3. 访问一个不存在的 API 路径，应返回 JSON 404，而不是 SPA 的 HTML 首页：

   ```sh
   curl -i https://staging.rememberkey-web.pages.dev/api/v1/not-found
   ```

4. 使用预发布环境的引导令牌注册预发布首位管理员，再测试登录、退出、新建记录和刷新页面后的会话恢复。
5. 预发布通过后，使用生产引导令牌注册生产首位管理员。

预发布测试数据不会同步到生产环境，因为两个环境使用不同的 D1。

### 11.3 删除引导令牌

首位管理员创建成功后，引导令牌不再起作用，可以删除：

```sh
cd ../worker
npx wrangler secret delete RK_BOOTSTRAP_TOKEN --env preview
npx wrangler secret delete RK_BOOTSTRAP_TOKEN --env production
```

后续用户应由管理员在应用中创建一次性邀请，不要重新开放引导注册。

## 12. 绑定自定义域名（可选）

例如希望生产地址为 `https://keys.example.com`：

1. 在 Cloudflare Dashboard 中进入 **Workers & Pages → rememberkey-web → Custom domains**。
2. 为 **Pages 项目**绑定 `keys.example.com`，按页面提示完成 DNS 与证书配置。
3. 不要把这个域名绑定到内部 API Worker。
4. 将 `web/wrangler.jsonc` 和 `worker/wrangler.jsonc` 中生产环境的 `RK_ORIGIN` 同时改为：

   ```jsonc
   "RK_ORIGIN": "https://keys.example.com"
   ```

5. 重新部署生产 Worker 和 Pages：

   ```sh
   cd worker
   npx wrangler deploy --env production

   cd ../web
   npm run build
   npm run pages:deploy -- --project-name rememberkey-web --branch main
   ```

6. 检查新地址：

   ```sh
   curl https://keys.example.com/healthz
   curl https://keys.example.com/readyz
   ```

当前实现只接受一个精确 `RK_ORIGIN`。切换为自定义域后，旧 `pages.dev` 域名可能仍能显示静态页面，但其 API 写请求会被拒绝；日常使用应只保留并传播配置的正式 origin。

如果公开 origin 发生变化，浏览器中原有的 IndexedDB、加密设备私钥、离线 outbox 和公钥固定状态不会自动跨域迁移。已有用户的生产环境不要直接换域；应先完成浏览器状态迁移方案与验证。

## 13. 后续更新

在仓库根目录执行常规校验：

```sh
npm --prefix web test
npm --prefix web run typecheck:pages
npm --prefix web run build
npm --prefix worker run typecheck
npm --prefix worker test
```

发布预发布版本：

```sh
cd worker
npx wrangler deploy --env preview
# 仅当包含新 D1 migration 时执行：
npm run db:migrate:preview

cd ../web
npm run build
npm run pages:deploy -- --project-name rememberkey-web --branch staging
```

验证后再按相同顺序发布生产版本。一般顺序为：**先部署兼容当前 schema 的 Worker，再应用必要的向后兼容迁移，最后部署 Pages**。涉及破坏性 schema 变更时不能只按这个简单顺序操作，必须先设计兼容窗口和回滚方案。

## 14. 备份与回滚

### D1 备份

在 `worker/` 目录执行：

```sh
npx wrangler d1 export rememberkey --remote --env production --output backup.sql
```

导出文件虽然主要包含密文和账号元数据，仍然属于敏感文件。应加密存放、限制访问，并且不要提交到 Git 或上传到公开 CI artifacts。

### 应用回滚

查看并回滚 Worker：

```sh
npx wrangler deployments list --env production
npx wrangler rollback --env production
```

Pages 可在 Dashboard 的项目 **Deployments** 中选择此前已验证的部署进行回滚。

回滚 Worker 或 Pages **不会回滚 D1 数据**。如果新版本已经修改 schema 或写入新数据，只能回滚到仍兼容当前数据库的版本；不要直接恢复到旧数据库或旧 MySQL 入口，否则可能丢失新写入。

## 15. 常见问题

| 现象 | 检查与处理 |
| --- | --- |
| `403 origin_rejected` | 核对 Pages 与 Worker 的同环境 `RK_ORIGIN`；确认协议、域名、端口完全一致且没有尾斜杠。预发布必须使用固定 `staging` 别名，不能使用随机部署域名。 |
| 所有请求返回 `500 internal_error` | 使用 `npx wrangler tail --env production` 查看是否出现 `invalid RK_ORIGIN`。生产必须使用合法 HTTPS origin，修正后重新部署 Worker 和 Pages。 |
| `/readyz` 返回 503 | 检查当前环境的 D1 `database_id`、`database_name` 和 `DB` binding，并确认已执行对应环境的远程 migration。 |
| API 返回 `503 upstream_unavailable` | 检查 Pages 的 `API` Service binding 是否指向对应环境的 Worker，以及该 Worker 是否已经成功部署。 |
| 首位管理员注册返回 `403 invalid_invitation` | 检查 secret 是否设置在正确的 Worker 环境、输入值是否一致、账号表是否真的为空。首位管理员创建后应改用一次性邀请。 |
| 预发布环境读到了生产数据 | 立即停写并检查 `env.preview` 的 D1 ID 与 API Service binding；预发布和生产不能共享 Worker 或数据库。 |
| 页面正常但 API 都失败 | 静态资源由 Pages 直接提供，API 则经过 Function 和 Service binding；分别检查 `/healthz`、`/readyz`、Pages 绑定与 Worker 日志。 |
| 构建后缺少安全头或路由规则 | 确认从 `web/` 执行 `npm run build`，并部署生成的 `dist`；检查 `web/public/_headers` 和 `_routes.json` 是否存在于仓库中。 |

查看生产 Worker 实时日志：

```sh
cd worker
npx wrangler tail --env production
```

预发布环境把参数改为 `--env preview`。日志中不应记录密码、恢复码、私钥、明文记录、访问令牌或刷新 cookie。

## 16. 上线安全检查清单

- [ ] Cloudflare 账号已开启 MFA，并限制成员与 API Token 权限。
- [ ] 预发布和生产使用不同的 D1 与 Worker。
- [ ] 两个配置文件的同环境 `RK_ORIGIN` 完全一致。
- [ ] API Worker 没有公开 `workers.dev`、preview URL 或自定义域。
- [ ] `/healthz` 返回 `ok`，`/readyz` 返回 `ready`。
- [ ] 首位管理员已创建，引导令牌已删除。
- [ ] 注册、登录、刷新、退出、邀请、记录增删改和离线恢复已在预发布验证。
- [ ] 页面 CSP/WASM 正常，API 不被 Service Worker 或 CDN 缓存。
- [ ] D1 已建立加密备份与恢复流程。
- [ ] 如果来自旧 Go/MySQL，全量数据摘要、账号解锁、设备撤销、游标和幂等重放已单独验收。
- [ ] 已理解安全边界：主密码和恢复码都丢失后，服务端与 Cloudflare 管理员均无法恢复明文数据。

## 官方参考

- [Pages Direct Upload](https://developers.cloudflare.com/pages/get-started/direct-upload/)
- [Pages Wrangler 配置](https://developers.cloudflare.com/pages/functions/wrangler-configuration/)
- [Pages Service bindings](https://developers.cloudflare.com/pages/functions/bindings/#service-bindings)
- [D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/)
