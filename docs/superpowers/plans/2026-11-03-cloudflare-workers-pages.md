# rememberKey Cloudflare Workers + Pages Implementation Plan

> 状态说明：本文保留原始实施计划，复选框不代表当前进度；当前实现与验证边界以根目录 `README.md` 和部署教程为准。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 复用现有 Cloudflare 后端草稿，交付 Pages + Workers + D1 版本，并无损迁移旧 Go/MySQL 账号、密文及同步状态。

**Architecture:** Pages 提供 React/PWA 静态资源；薄 Pages Function 经 `API` service binding 转发同源 API 到内部 Worker；Worker 独占 D1。迁移使用离线一致性快照、空目标库导入与全量校验，域名改变时另迁浏览器密文状态。

**Tech Stack:** React 19、TypeScript 5.7、Vite 6、libsodium、Cloudflare Pages Functions、Workers、D1、锁定版本 Wrangler/Vitest；独立 Go 1.23+ 离线迁移工具。

**Spec:** [设计与迁移约束](../specs/2026-11-03-cloudflare-workers-pages-design.md)。实施者必须先读取该文档。

## Global Constraints

- 用户已确认：旧版 Go + MySQL 中的账号和密钥数据需要保留并迁移。
- 浏览器始终同源访问；API 路径、密文格式、签名消息、账号公钥和记录 ID 保持兼容。
- Worker 是唯一业务 API，D1 是目标版本唯一业务存储；Pages Function 不复制业务逻辑。
- 不记录密码、恢复码、私钥、明文记录、token 或迁移密钥；不重新序列化签名 envelope。
- Worker 的 `RK_ORIGIN` 与 Pages 的 `RK_ORIGIN` 必须等于该环境唯一公开页面 origin。
- API Worker 使用 `workers_dev=false`、`preview_urls=false`，不配置公开路由或自定义域。
- 预发布独立 Worker、D1 和固定 staging origin；不接受 `*.pages.dev` 通配 Origin。
- 导入只允许空目标库；行数、逐表全量摘要、序号高水位与业务验收全部通过才开放写入。
- 不迁移旧会话，用户重新认证；设备撤销、账号停用和邀请使用状态必须保留。
- 当前已有暂存/未暂存改动必须保留；本计划不授权覆盖、回退或自动提交这些既有改动。

---

## 交付顺序与估时

| 任务 | 可独立评审的交付物 | 粗估工作日 | 前置 |
| --- | --- | --- | --- |
| 1 | 与静态资源解耦的内部 API Worker | 0.5–1 | 当前基线 |
| 2 | Pages 同源入口与本地可运行链路 | 1 | 1 |
| 3 | MySQL/D1 数据迁移工具及旧协议兼容 | 1.5–2.5 | 1 |
| 4 | 浏览器密文状态迁移与旧站迁移入口 | 1–2 | 3 的格式契约 |
| 5 | 环境隔离、发布校验、CI/CD 与操作文档 | 0.5–1 | 2、3、4 |
| 6 | Cloudflare 预发布及真实迁移预演报告 | 1 | 5 |
| 7 | 正式迁移、发布与恢复记录 | 0.5–1 | 6 |

总计约 6–10 个工作日，依赖实际数据量、旧 origin 可访问性和 Cloudflare 账号/域名准备；不包含等待外部权限的时间。若 origin 不变，任务 4 的跨域导入路径可不作为切换前置，但同域旧缓存/outbox 验收仍然必须执行。

实施前记录 `git status --short`、`git diff` 和暂存差异；生成只含可交付源码的基线清单，保留已有暂存状态。任务完成可形成独立提交，但只提交该任务经审查的文件及改动段落。

## 文件与责任映射

| 文件 | 动作与职责 |
| --- | --- |
| `worker/src/index.ts`、`types.ts` | 修改：API-only 入口与绑定类型 |
| `worker/src/sync.ts` | 修改：旧 Go 与已有 Worker 的幂等哈希兼容 |
| `worker/wrangler.jsonc`、`package.json` | 修改：内部 Worker、各环境 D1、明确迁移脚本 |
| `worker/test/index.test.ts`、`sync.test.ts`、`test/fixtures/legacy-operations.json` | 新增/修改：入口与旧操作黄金样本 |
| `web/functions/[[path]].ts`、`web/cloudflare/proxy.ts` | 新增：Pages 入口与可独立测试的薄转发函数 |
| `web/wrangler.jsonc`、`tsconfig.pages.json` | 新增：Pages 环境绑定及独立 Functions 类型检查 |
| `web/public/_routes.json`、`_headers` | 新增/修改：Functions 路由范围、CSP 和静态缓存 |
| `web/package.json`、`package-lock.json`、`vite.config.ts` | 修改：固定 Wrangler/类型依赖、Pages 命令、静态缓存排除 |
| `web/src/migration.ts`、`migration.test.ts`、`store.ts`、`App.tsx` | 新增/修改：浏览器加密迁移及事务恢复 |
| `tools/migrate/go.mod`、`go.sum`、`cmd/migrate/main.go` | 新增：离线 CLI 与独立依赖 |
| `tools/migrate/internal/migration/{schema,snapshot,sql,manifest}.go` 及对应 `_test.go` | 新增：字段映射、一致性读取、SQL 编码、摘要与预检 |
| `tools/migrate/cmd/fixtures/main.go` | 新增：使用 Go 编码器生成协议黄金样本 |
| `worker/scripts/migrate-d1.mjs`、`verify-d1.mjs` | 新增：空库导入、逐表读取与源清单比对 |
| `scripts/dev-cloudflare.mjs`、`verify-cloudflare-config.mjs` | 新增：本地链路与发布配置校验 |
| `scripts/e2e.mjs`、`browser-e2e/` | 修改/新增：Pages 协议测试与真实客户端浏览器测试 |
| `.github/workflows/ci.yml`、`deploy-cloudflare.yml` | 修改/新增：验证与受保护环境发布 |
| `.gitignore`、根/worker/web README、`PROTOCOL.md` | 修改：迁移敏感工件忽略、命令及部署契约 |
| `docs/operations/cloudflare-migration.md` | 新增：停写、导入、切换、分阶段回滚与实测记录模板 |

## Task 1：让 Worker 独立承担 API

**Files:** 修改 `worker/src/index.ts`、`worker/src/types.ts`、`worker/wrangler.jsonc`、`worker/package.json`；新增 `worker/test/index.test.ts`。

**Interfaces:** 消费现有 `Env.DB`、`RK_ORIGIN`、可选 `RK_BOOTSTRAP_TOKEN`；继续产出 `default.fetch(request: Request, env: Env): Promise<Response>`，不再依赖 `ASSETS`。保留 `RouteContext` 和所有业务模块签名。

- [ ] **Step 1：加入入口行为测试并确认现有静态分支使新测试失败。** 在 `worker/test/index.test.ts` 写入下列案例，并补 `/healthz`、D1 不可用的 `/readyz`、错误 Origin 的写请求和未知 `/api/v1` 路由案例。

```ts
import { expect, it } from 'vitest';
import handler from '../src/index';
import type { Env } from '../src/types';

it('returns JSON 404 outside API without requiring an asset binding', async () => {
  const env = { DB: {} as D1Database, RK_ORIGIN: 'https://keys.example.com' } as Env;
  const response = await handler.fetch(new Request('https://keys.example.com/assets/missing.js'), env);
  expect(response.status).toBe(404);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(await response.json()).toEqual({ error: { code: 'not_found', message: 'not found' } });
});
```

运行：`npm --prefix worker test -- test/index.test.ts`。预期新增入口测试先失败，不能依赖假的 `ASSETS` 让它通过。

- [ ] **Step 2：移除 Assets 回退与 `Env.ASSETS`，非 API 路由输出现有协议错误。** 保留 Origin 校验、限流、认证、健康检查和安全头的顺序；未知 API 不得渲染 HTML。静态分支替换为：

```ts
if (!pathname.startsWith('/api/')) {
  return withSecurityHeaders(errorResponse(new HttpError(404, 'not_found')), API_SECURITY_HEADERS);
}
```

- [ ] **Step 3：配置内部 Worker。** 删除 `assets` 段；保留 `compatibility_date: 2026-10-01` 和现有锁定依赖；显式配置 `env.preview`、`env.production` 的名称、D1 和 `RK_ORIGIN`。两个环境设置 `workers_dev: false`、`preview_urls: false`，不添加 routes。迁移命令区分 local/preview/production，不让 `--remote` 默认指向不明环境。

运行：`npm --prefix worker run typecheck`、`npm --prefix worker test`；在 `worker/` 执行 `npx wrangler deploy --dry-run --env preview --outdir .tmp/bundle`，检查 bundle 不再需要 `web/dist`。远程资源 ID 的配置在任务 5/6 完成后再验证真实部署。

- [ ] **Step 4：评审并保存任务差异。** 验收：API-only dry-run 和原有测试通过；没有账号/加密/同步协议重写。可提交：`refactor: decouple worker API from static assets`。

## Task 2：Pages 静态站点与同源 API

**Files:** 新增 `web/functions/[[path]].ts`、`web/cloudflare/proxy.ts`、`proxy.test.ts`、`web/wrangler.jsonc`、`web/tsconfig.pages.json`、`web/public/_routes.json`、`scripts/dev-cloudflare.mjs`；修改 `web/public/_headers`、`web/package.json`、锁文件、`vite.config.ts` 和 `.gitignore`。

**Interfaces:** `PagesEnv = { API: Fetcher; RK_ORIGIN: string }`；`proxyRequest(request: Request, env: PagesEnv): Promise<Response>`。Pages `onRequest: PagesFunction<PagesEnv>` 只调用该函数。Worker 由 `API` 绑定注入，不给浏览器下发 Worker URL。

- [ ] **Step 1：加入转发契约测试。** 在 `web/cloudflare/proxy.test.ts` 验证 URL/query/method/body、Authorization、Origin、Cookie 原样到达，响应的 Set-Cookie、状态码和 no-store 保留。使用 Vitest `vi.fn` 模拟 `Fetcher`，包括流式请求正文仅消费一次。核心案例：

```ts
import { expect, it, vi } from 'vitest';
import { proxyRequest } from './proxy';

it('preserves the host-only refresh cookie', async () => {
  const value = 'rk_refresh=rotated; Path=/api/v1/auth; Secure; HttpOnly; SameSite=Strict';
  const fetch = vi.fn(async () => new Response(null, {
    status: 204, headers: { 'set-cookie': value, 'cache-control': 'no-store' },
  }));
  const response = await proxyRequest(new Request('https://keys.example.com/api/v1/auth/refresh', {
    method: 'POST', headers: { Origin: 'https://keys.example.com', Cookie: 'rk_refresh=old' },
  }), { API: { fetch } as unknown as Fetcher, RK_ORIGIN: 'https://keys.example.com' });
  expect(response.status).toBe(204);
  expect(response.headers.get('set-cookie')).toBe(value);
  expect(fetch).toHaveBeenCalledOnce();
});
```

运行 `npm --prefix web test -- cloudflare/proxy.test.ts`，先看到模块缺失失败。另测固定 origin 之外的请求拒绝、绑定异常返回 503/no-store，以及 API 404 不回落首页。

- [ ] **Step 2：实现薄转发，加入路由限制。** 转发前核对 `new URL(request.url).origin === env.RK_ORIGIN`，不改写为内部 Worker 域名、不伪造 Origin；调用 `env.API.fetch(new Request(request, { redirect: 'manual' }))` 并保留原 Response。异常返回 `{error:{code:'upstream_unavailable',message:'upstream unavailable'}}`，状态 503，附 no-store/nosniff/no-referrer。不得在异常日志输出请求头或正文。

`web/public/_routes.json` 内容：

```json
{"version":1,"include":["/api","/api/*","/healthz","/readyz"],"exclude":[]}
```

`_headers` 为静态响应设置 `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; connect-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`，附 nosniff/no-referrer。`/`、`/index.html`、`/sw.js` 使用 no-cache；`/assets/*` 使用带哈希资源的长期 immutable 缓存。验证现有 UI 和 WASM 可运行后才收紧到该 CSP。

- [ ] **Step 3：建立 Pages 配置和本地命令。** `web/package.json` 增加固定版本 Wrangler 与 Workers 类型的 devDependency、`pages:dev`、`pages:deploy`、`typecheck:pages`；Pages 类型配置独立包含 `functions`、`cloudflare`，不污染浏览器类型环境。配置 `pages_build_output_dir: './dist'`；local/production/preview 均显式声明 `API` service binding 和 `RK_ORIGIN`，本地为 8788。

`scripts/dev-cloudflare.mjs` 使用 Node 子进程启动本地 Worker 与 Pages，统一处理 Windows `.cmd`、项目内临时目录、信号退出和端口检查。不删除已有 D1 状态；测试必须传独立 `--persist-to` 目录。脚本结束停止自己创建的子进程，不使用全局进程名批量终止。

单独手动联调的命令约定如下，两个终端同时运行：

```powershell
# worker/：dev 包装器保留项目内 TEMP，覆盖为页面 origin
npm run dev -- --port 8787 --var RK_ORIGIN:http://127.0.0.1:8788
# web/：本地 Worker 的配置名称为 rememberkey-api
npm run pages:dev -- --port 8788 --service API=rememberkey-api
```

- [ ] **Step 4：通过真实本地链路验收。** 运行 web/worker 单元测试、两侧类型检查、Web 构建和 Pages Functions 编译；从 `http://127.0.0.1:8788` 访问首页、静态文件、`/healthz`、`/readyz` 和未知 API。使用独立空 D1，以 `RK_BASE=http://127.0.0.1:8788` 执行现有 `scripts/e2e.mjs`。检查静态资源不经过 Functions，SW 不缓存 API。可提交：`feat: deploy web through pages with bound worker API`。

## Task 3：旧协议兼容与服务端数据迁移

**Files:** 新增 `tools/migrate/` 中映射、读取、SQL、清单模块及测试；新增 `worker/scripts/migrate-d1.mjs`、`verify-d1.mjs` 和黄金 fixture；修改 `worker/src/sync.ts`、`worker/test/sync.test.ts`、`.gitignore`。

**Interfaces:**

- `go run ./cmd/migrate export --out <目录>`：从环境变量 `RK_MIGRATION_MYSQL_DSN` 读取源连接；输出 `manifest.json`、按表 JSONL 与有序 SQL 分片，拒绝覆盖已有输出目录。
- `go run ./cmd/fixtures`：输出 `{operation, canonical, hash}` 数组，包含普通、删除、空白与转义样本。
- `node worker/scripts/migrate-d1.mjs --source <目录> --env preview|production --local|--remote`：检查目标空库、manifest、schema 和分片后导入；生产远程参数必须全部显式给出。
- `node worker/scripts/verify-d1.mjs --source <目录> --env preview|production --local|--remote`：经锁定 Wrangler 查询 D1，全量比对并输出机器可读报告；失败退出码非零。
- Manifest 固定 `format='rememberKey-mysql-d1'`、`version=1`；含列类型/顺序、每表主键、行数、全量摘要、seq 最大值和源 auto_increment。JSONL 文本值用 UTF-8 字节 base64，整数为十进制字符串，NULL 为显式 null；逐行摘要编码采用固定列顺序的 `[类型,值]` 数组。

- [ ] **Step 1：建立有独立来源的兼容样本。** `tools/migrate/cmd/fixtures/main.go` 使用与 `legacy/server/sync.go` 相同字段顺序的 Go struct 和 `encoding/json.Marshal`，加 `crypto/sha256` 输出黄金 fixture；将结果存入 `worker/test/fixtures/legacy-operations.json`，测试不在运行时由 Worker 自己计算期望值。

```ts
import fixtures from './fixtures/legacy-operations.json';

it.each(fixtures)('accepts the legacy Go hash: $name', async fixture => {
  expect(await operationHash(fixture.operation)).toBe(fixture.hash);
});
```

在本任务引入的 fixture 对象中同时输出 `name`；tsconfig 开启 JSON 导入。覆盖 envelope 含 `<>&`、U+2028/U+2029、反斜线、空白、中文和 null 的样本。先运行新测试确认差异，再实现 Go JSON 转义兼容。若需兼容已有 Worker 写入哈希，额外定义 `compatibleOperationHashes(op: OperationLike): Promise<string[]>`，读取旧幂等项时只接受这两个确定算法产生的哈希，新写入继续使用固定 Go 兼容算法；不能跳过 hash 比较。

- [ ] **Step 2：实现一致性导出与保真 SQL。** Go 模块使用现有 `github.com/go-sql-driver/mysql v1.9.2`，以 `sql.LevelRepeatableRead`、`ReadOnly: true` 开启快照事务；只枚举设计文档的七张持久表。按固定主键顺序流式读取，数据值不能拼接为 SQL 标识符；表列来自固定映射。迁移工具不修改旧服务源码或源库。

文本字面量编码函数与独立测试：

```go
func textLiteral(value []byte) string {
    return "CAST(X'" + hex.EncodeToString(value) + "' AS TEXT)"
}

func TestTextLiteral(t *testing.T) {
    got := textLiteral([]byte("a'\n"))
    if got != "CAST(X'61270a' AS TEXT)" {
        t.Fatalf("unexpected SQL literal: %s", got)
    }
}
```

测试 NULL/空串、UTF-8、数字边界、墓碑、邀请 used=1、设备 revoked、缺失账号引用、异常 role、NOT NULL 差异及目标 NOCASE 碰撞。seq/revision/version 超出安全整数范围必须中止。按源实际 `AUTO_INCREMENT` 和 max(seq) 的较大高水位初始化 `sqlite_sequence`，测试导入后的首次插入继续递增。

- [ ] **Step 3：实现空库导入与全量验证。** Node 脚本通过 `spawn` 参数数组调用已锁定 Wrangler，明确 `--config`、`--env`、`--local/--remote`；迁移脚本文件按 manifest 顺序加载，不执行目录中的任意其他文件。默认单条 INSERT，按实测平台大小上限分片，禁止 `INSERT OR REPLACE`、禁止复制 MySQL DDL、禁止迁移 D1 内部表。允许存在 D1 schema/migrations 系统记录，七张持久业务表以及所有会话/挑战表必须为空。

校验脚本通过固定 schema 查询语句和主键 keyset 分页取 D1 数据；整数列先 `CAST(... AS TEXT)` 再返回，文本转回 UTF-8 字节。复用 manifest 的摘要编码定义，核对所有持久表，不只抽样。额外验证 transient 会话表为空、旧邀请未复活、seq 高水位和活跃管理员存在。

```powershell
# tools/migrate/
go test ./...
go run ./cmd/migrate export --out ../../.tools/migration/rehearsal
# 仓库根目录；此时使用独立本地测试 D1
node worker/scripts/migrate-d1.mjs --source .tools/migration/rehearsal --env preview --local
node worker/scripts/verify-d1.mjs --source .tools/migration/rehearsal --env preview --local
```

`.gitignore` 忽略 `.tools/migration/`、本地数据库、连接配置和报告中的敏感明细；导出文件本身仍含敏感账号元数据及密文，存放于访问受控且加密的备份目录，不上传 CI 公共 artifacts。

- [ ] **Step 4：在 MySQL fixture → 本地 D1 上证明迁移。** fixture 包含真实客户端生成的可解密账号、两个设备、删除墓碑、已有游标、重复提交结果、冲突结果、已用邀请和已撤销设备。保留原 ID 登录并解锁；原 operationId 重放不新增 revision；旧 cursor 续拉结果一致。模拟中途分片失败，确认程序退出且入口不开放，重试使用新空库。可提交：`feat: migrate legacy mysql vault data to d1`。

## Task 4：保留浏览器设备与离线修改

**Files:** 新增 `web/src/migration.ts`、`migration.test.ts`；修改 `web/src/store.ts`、`App.tsx`，新增浏览器验收用例；新增操作文档中的旧站迁移入口步骤。

**Interfaces:**

```ts
export interface MigrationState {
  format: 'rememberKey-origin-migration';
  version: 1;
  sourceOrigin: string;
  targetOrigin: string;
  exportedAt: string;
  account: LocalAccount;
  records: StoredRecord[];
  outbox: PendingOperation[];
  cursor: number;
}
export interface SealedMigration {
  format: 'rememberKey-origin-migration-sealed';
  version: 1;
  nonce: string;
  ciphertext: string;
}
export function exportMigration(targetOrigin: string): Promise<{
  file: SealedMigration; transferKey: string;
}>;
export function importMigration(file: SealedMigration, transferKey: string,
  unlock: { password: string } | { recoveryCode: string }): Promise<void>;
export function readMigrationState(targetOrigin: string): Promise<MigrationState>;
export function restoreMigrationState(state: MigrationState): Promise<void>;
```

前三种现有账户/记录类型来自 `web/src/types.ts`。存储函数由 `store.ts` 提供；加密与校验函数由 `migration.ts` 提供，UI 只负责文件、迁移密钥和用户解锁输入。

- [ ] **Step 1：补本地状态原子导入测试。** 使用现有 fake-indexeddb，覆盖有 pending/outbox、冲突、已提交记录、公钥固定和 cursor 的完整状态。`restoreMigrationState` 在一个 `meta/records/outbox` 读写事务内检查目标为空并写入；验证失败或事务异常后仍全空。测试旧状态已有任一数据时拒绝覆盖。

```ts
it('never replaces an existing local vault during migration', async () => {
  const current = await getLocal();
  if (!current) throw Error('test fixture must create the existing account first');
  const before = await readMigrationState('https://new.example.com');
  await expect(restoreMigrationState(before)).rejects.toThrow();
  expect(await getLocal()).toEqual(current);
});
```

该测试的 beforeEach 使用真实测试账号生成器创建已有账户；另为成功导入案例独立清空 fixture，不从生产数据初始化测试。

- [ ] **Step 2：实现迁移包与校验。** `exportMigration` 从同一 readonly 事务读取快照，独立随机 32 字节 transferKey，使用现有 libsodium 的 XChaCha20-Poly1305 和固定 AAD `rememberKey:origin-migration:1` 包装 JSON。迁移密钥不写入文件；UI 显示一次并要求用户另存。读取前检查文件大小上限 64 MiB、schema 和条数上限 10000；超限停止并提示先在旧端完成同步或分批恢复，不截断。

导入校验目标 origin、账户服务端公钥、device proof/有效性、所有记录签名及 envelope 解密；用 `LocalAccount.deviceWrap` 解封设备私钥验证公钥匹配；pending 记录按其 baseRevision 验证，已提交记录要求 revision=baseRevision+1。签名 outbox 的 operationId/envelope/signature 原样恢复，冲突双方分别验证。先全部校验，最后调用存储事务，不把解密后的记录写入 IndexedDB。对过期 keyBundle 版本、被撤销设备或与服务器公钥不同的包保持文件原状并拒绝自动恢复，不覆写服务端账号。

- [ ] **Step 3：加入旧 origin 的迁移入口交付。** 将当前 Web 产物打包为可供旧 Go 服务静态托管的迁移工具版，仅增加安全设置中的“导出设备迁移包”；保持旧 `/api/v1` 协议及旧站 origin，实测旧后端登录/读取。生产旧入口切换前先部署该版本并让有离线数据的设备完成导出；离线设备保留原数据和原入口恢复安排，不能清空缓存或强制注销以跳过迁移。

- [ ] **Step 4：验证两条路径。** 同 origin 切换：已有 IndexedDB + outbox 不清空，重新认证可继续同步。跨 origin：两个真实浏览器 origin 分别导出、导入、联网重试、重启与冲突处理，确认无重复记录、无私钥明文文件、错误迁移密钥/密码/签名不产生部分导入。可提交：`feat: preserve encrypted browser state across origin migration`。

## Task 5：环境配置、CI/CD 与运维入口

**Files:** 新增 `scripts/verify-cloudflare-config.mjs`、`.github/workflows/deploy-cloudflare.yml`、`docs/operations/cloudflare-migration.md`；修改现有 CI、README、PROTOCOL、环境配置和 `.gitignore`。

**Interfaces:** `node scripts/verify-cloudflare-config.mjs --env preview|production` 验证静态配置并输出非敏感摘要，错误退出码非零；发布 workflow 消费 `CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID` 和受保护环境配置，输出 Worker version 与 Pages deployment ID。

- [ ] **Step 1：加入配置校验与负例。** 核对两个配置的 origin 一致、API binding 指向正确环境、生产与预览 D1 不同、数据库 ID 有效且非全零、Worker 无公开路由/preview URL、Pages 函数路由完整。配置解析使用 Wrangler 支持的 JSONC 解析方式，不以正则剥注释。只在校验脚本测试夹具中放假 ID，不把测试夹具当部署配置。

```powershell
node scripts/verify-cloudflare-config.mjs --env preview
node scripts/verify-cloudflare-config.mjs --env production
```

缺少真实资源配置时预期明确失败；不得把“跳过校验”作为初次部署流程。

- [ ] **Step 2：扩展现有 CI。** Node 继续固定 22.14.0，依赖使用 npm ci。执行两侧单元测试、类型检查、Web 构建、Worker dry-run、Pages Functions 编译、隔离本地 D1 + Pages/Worker 链路、协议 E2E、Go 迁移测试及 MySQL fixture 到 D1 的迁移集成。GitHub Actions 临时 MySQL 只用于迁移测试，不成为目标运行服务。CI 不访问生产库、不导出真实数据。

- [ ] **Step 3：增加显式发布工作流。** `workflow_dispatch` 选择 preview/production，生产使用 GitHub environment 保护规则及独立最小权限凭据。先部署向后兼容的 API Worker，再从 `web/` 运行 Wrangler Pages 上传，避免从错误目录遗漏 `functions/`。一个环境一次发布，不能与数据导入并发。

```powershell
# preview：分别在 worker/ 与 web/ 执行
npx wrangler deploy --env preview
npx wrangler pages deploy dist --project-name rememberkey-web --branch staging
```

`rememberkey-web` 是计划采用的项目名，实施创建项目时核对可用性；名称改变必须同步配置、脚本及正式/固定 staging origin。初次迁移生产时，部署不自动开放入口；数据迁移仍按任务 7 执行。后续 schema 变更只允许版本化、向后兼容迁移，不在每次前端上传时重跑导入。

- [ ] **Step 4：更新可复现操作文档。** 写明本地两进程启动、Windows 临时目录、Direct Upload 的选择、首次建库/绑定、secret 的放置、固定预览域、旧站迁移工具版、停写验证、数据导入、备份恢复与新旧数据回滚边界。`PROTOCOL.md` 只更新部署传输层及幂等兼容说明，密码学格式保持 v1。可提交：`ci: validate and deploy isolated cloudflare environments`。

## Task 6：真实 Cloudflare 预发布与迁移预演

**Files:** 新增 `browser-e2e/` 真实浏览器测试和去敏验收报告；更新 `docs/operations/cloudflare-migration.md` 的实测资源/限制与演练耗时记录。

**Interfaces:** 使用 preview Pages 固定 staging origin，内部 API preview Worker，独立 preview D1；机器报告分开记录 build、local、cloudflare-preview、migration-rehearsal、browser 五项结果。

- [ ] **Step 1：在已准备的 Cloudflare 账号建立隔离资源。** 读取资源创建返回的实际数据库 ID，写入对应配置并再次运行任务 5 校验。确认固定 Pages 域名、HTTPS、service binding、Worker 私有入口设置。用空预演 D1 应用 schema，再部署 API 与 Pages；不可使用生产库做协议脚本初始化。

- [ ] **Step 2：预演一致性导出与导入。** 用只读源连接导出旧库，导入 preview D1，运行全量校验；记录行数、文本摘要、最大 seq、大小、导出/导入/核对耗时及异常。对真实迁移数据的浏览器解锁只由持有原密码/恢复码的用户本地完成，不收集凭据。验收操作会改变目标数据，验证后记录变化，生产仍使用停写后的新快照。

- [ ] **Step 3：完成真实业务及平台差异测试。** 浏览器测试包含正确/错误密码、恢复码、cookie 刷新轮换、退出与设备撤销、离线编辑/重启、在线重放、丢失响应的幂等提交、两设备冲突及跨账号隔离。以真实密码学创建测试记录验证解密；现有协议脚本中的模拟 bundle 仅用于协议断言。

同时验证 `/api/unknown` JSON404、SPA 子路由、CSP/WASM、Service Worker 更新与 API 缓存排除、其他 Pages 别名拒绝 API、错误 Origin 拒绝、内部 Worker 无公开入口、绑定异常 503、D1 batch 并发语义。核对 Pages → Worker 后的客户端 IP 表现，并在公开 Pages 入口配置和验证可用的限流措施；每 isolate 计数不作为分布式限流保证。

- [ ] **Step 4：演练恢复并出具放行结论。** 在隔离环境恢复 D1 导出，验证账号、旧记录、游标及 outbox；演练回滚 Worker/Pages 到兼容当前 D1 的已验证版本。报告中单独列出未完成项；只要存在数据摘要不一致、解密失败、幂等错误、跨环境串库或未解决的离线丢失风险，就不进入任务 7。

## Task 7：正式数据迁移与发布

**Files:** 更新 `docs/operations/cloudflare-migration.md` 的发布记录及只含摘要的验收报告；敏感导出与全量明细保存在受控备份目录。

**Interfaces:** 输入为已验证发布版本、可恢复旧系统备份、源只读连接、生产资源和用户本地迁移包；输出为正式 Pages origin、Worker/Pages 版本、D1 schema 版本及数据校验结论。

- [ ] **Step 1：准备可回退现场。** 保存旧 Go/MySQL 的可恢复备份与当前域名配置；完成旧站迁移入口分发、设备 outbox 检查和 D1 独立备份恢复演练。确认目标生产 D1 是空的且不对用户开放，真实账号套餐容量满足当前数据及增长余量。
- [ ] **Step 2：冻结全部写入口并取最终快照。** 在旧服务入口启用维护、停止其他写实例和后台写任务，验证签名写 API 不再成功；在冻结状态导出最终一致性快照及 manifest。清点快照版本和摘要，不能把之前的在线预演快照当作最终数据。
- [ ] **Step 3：导入、核对并切换入口。** 将最终快照导入新生产 D1，运行全部校验；旧账号解锁、角色、撤销状态、历史游标和重放抽验通过后，将固定正式 origin 接入 Pages，核对两侧 RK_ORIGIN、HTTPS、cookie 和 CSP。迁移已有账号后不启用 bootstrap secret。必要的验收写入视为 D1 已进入新写入阶段，适用下一步的第二类回滚约束。
- [ ] **Step 4：开放与记录。** 开放写入，确认首个新记录 seq 大于源高水位、旧设备同步及新设备登录正常；记录告警、Cloudflare 使用量与备份完成情况。旧 MySQL 保持冻结，不与 D1 双写。尚未完成离线设备迁移的条目继续单独标注待恢复。

失败处理必须遵守设计文档：无 D1 新写入时可以恢复旧入口；有新写入后先停写/备份，优先回滚兼容 D1 的应用版本，不能直接指回旧 MySQL。当前范围不交付 D1→MySQL 无损反向同步工具。

## 完成定义

- [ ] Pages、内部 Worker、D1 三者均在真实 Cloudflare 环境验证，并有固定正式入口。
- [ ] 旧账号、公钥、密文、设备/撤销、邀请状态、审计、历史游标、幂等结果迁移校验通过。
- [ ] 旧密码或恢复码可在客户端解锁旧数据，无需重新注册或重新生成账户密钥。
- [ ] 同 origin 的离线缓存/outbox 正常；发生 origin 变化的已参与迁移设备有加密导出/导入与重放证据，其他设备明确列为待恢复。
- [ ] 登录、刷新、退出、离线重启、冲突、管理员权限和跨账号隔离通过浏览器验收。
- [ ] 预发布不接触生产库，API/SW 缓存和域名准入检查通过。
- [ ] 备份与 D1 兼容版本回滚演练通过；已明确生产新写入后的回滚边界。
- [ ] 发布文档、版本记录和未完成项准确；桌面端不计入本次 Cloudflare 交付。

本次规划已完成仓库检查、现有测试和前端构建；上述实施任务均尚未执行。
