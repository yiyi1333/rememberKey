# rememberKey Web / PWA

React 19 + TypeScript + Vite，遵循根目录 PROTOCOL.md v1；仅同源部署。所有依赖版本在 package.json 与 package-lock.json 中固定。

## 开发与校验

```sh
npm ci
npm test
npm run build
npm run dev
```

完整的本地 Pages → Worker 链路从仓库根目录运行 `node scripts/dev-cloudflare.mjs`，浏览器访问 `http://127.0.0.1:8788`。单独使用 Vite 热更新时，`/api` 代理至 `http://127.0.0.1:8787`（`wrangler dev`），Worker 的 `RK_ORIGIN` 必须与 Vite Origin 一致，否则写请求返回 `403 origin_rejected`。生产由 Cloudflare Pages 提供 `dist`，Pages Function 通过 `API` Service binding 转发同源 API；不要将登录、刷新 cookie 或 API 搬到第三方源。必须 HTTPS（localhost 开发例外）。`public/_headers` 的 CSP 使用 `script-src 'self' 'wasm-unsafe-eval'` 支持 libsodium WASM，并保持 `connect-src 'self'`，不需要宽泛的 `unsafe-eval`。部署步骤见 [../docs/cloudflare-deployment.md](../docs/cloudflare-deployment.md)。

## 已实现的纵向切片

- 首位管理员引导 / 邀请注册：本地生成账户签名、加密及设备密钥，展示一次性恢复码。
- 固定 Argon2id13 3 次 / 64 MiB 密码派生，XChaCha20-Poly1305 根密钥/私钥/设备包装，X25519 sealed-box 记录数据密钥。
- Ed25519 设备注册证明、公钥 challenge 登录；opaque bearer 仅模块内存，refresh 使用 credentials include、服务端 HttpOnly cookie。
- 本地公钥固定；在线登录拒绝公钥突变；离线用已缓存 bundle 解锁并验证私钥对应公钥。
- IndexedDB 只保存密文与必要元数据。记录和原样签名 outbox 在一个事务保存。每个记录仅允许一个待同步操作，避免离线编辑产生虚假的 baseRevision。
- 推送重试、拉取分页、每条远端签名验证、版本冲突保留。用户明确选择采用远端或以当前服务器版本重新签名提交本地值；从不隐式覆盖冲突。
- 记录创建、编辑、删除、本地搜索、复制、链接协议限制、标签、到期时间显示；空库不生成模拟密钥。
- 主密码重新包装、恢复码解锁后可进入安全设置改密码、设备列表与撤销、当前会话退出。
- 管理员成员停用/启用、一次性邀请、最近 100 条审计（不宣称完整审计分页 UI）。
- 仅加密备份导出；导入限制 8 MiB/2000 条、同账户和公钥验证、全部记录签名与解密验证通过后，逐条以新 ID 导入副本，不覆盖已有记录。单条原子，不保证整个备份导入的全有或全无。
- PWA manifest + 构建时生成静态资源白名单 Service Worker。API、跨域、非 GET、带查询参数请求绝不缓存。首页导航优先网络、离线回退已缓存壳。更新在下一次应用生命周期应用，不强制接管运行中的页面。
- 无操作 5 分钟或页面进入后台立即锁定，清除明文 UI、可控密钥 Uint8Array 尽力 memzero；页面锁定不等于撤销 refresh cookie，重新打开仍需本地解密。

## 真实限制 / 安全边界

- 不支持团队共享、完整根密钥轮换、硬件密钥、独立签名发布、历史日志裁剪、大快照分页，均未伪装成可用功能。
- 桌面原生 SQLite / 凭据桥接不在此模块内。此客户端依赖浏览器 IndexedDB + 同源 cookie，不可直接作为跨源桌面登录客户端。
- 浏览器 JavaScript 无法证明所有密码、剪贴板或字符串副本已从物理内存擦除。复制后 30 秒仅在浏览器允许读取且剪贴板仍为该值时尝试清空；系统/其他应用剪贴板历史无法控制。
- IndexedDB 是同源存储；同源 XSS、恶意扩展、被攻陷设备仍可读取解锁期明文。建议严格 CSP、无第三方脚本、可信 HTTPS 分发。
- 已撤销设备持有的历史密文及曾获得的密钥无法远程擦除；设备撤销只阻止未来服务端访问，非根密钥轮换。
- Argon2id 当前在主线程执行，低端设备会有短暂停顿；未宣称后台 Worker KDF 已实现。
- 锁定只清除内存 bearer，不立即撤销服务器会话；安全设置提供显式会话撤销。离线已有缓存无法感知服务器撤销，是离线解密的固有边界。
- 密文备份当前仅支持已知同账户导入；新浏览器应先正常登录或恢复码登录以建立受信账户和设备，再导入。备份不包含设备私钥或 plaintext recovery code。
- 日期仅作展示，不会自动撤销服务商实际 API Key。secret 为空或格式错误的记录由客户端校验；平台不验证服务商密钥真实性。
- 尚需以真实浏览器完成离线/重启/设备撤销竞态等完整 E2E 验收；单元测试不替代独立密码学审计。
