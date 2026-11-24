# 独立部署

1. 登录自己的 Cloudflare 账号，创建独立 Worker 和 D1 数据库，将返回的 UUID 填入 wrangler 配置的 `database_id`；仓库中的 UUID 是占位符。
2. 在自己的 Cloudflare 账号配置加密秘密，不要将真实值提交到 Git。
3. 应用迁移、构建并部署；域名路由请按自己的域名配置。首次使用先在本地或测试环境核对。

```sh
pnpm exec wrangler login
pnpm exec wrangler d1 create NAME
# 将返回的 UUID 填入 wrangler.json，按其 binding 创建自己的 R2 桶。
pnpm exec wrangler d1 migrations apply DB --remote
pnpm build
pnpm exec wrangler deploy
```

Node.js 24，pnpm 11.25.0。部署前设置所需的加密秘密，确保上传文件的桶不对外公开。不要把示例 UUID 当作可用资源；不要复制他人的生产配置。

使用 `pnpm exec wrangler secret put STUDIO_PASSWORD_PEPPER` 保存自行生成的随机秘密，R2 绑定名为 STUDIO_MEDIA。scripts/assert-independent-deploy.mjs 和运维脚本中的资源断言为示例值；需要按自己的部署逐项更新。原生产专用工作流保留为参考模板，并通过仓库名和发布分支条件阻止在本公开仓库运行。请先在测试资源验证，再配置自己的发布流程。
