# EdgeOne Pages 部署支持

## 概述

将 DS2API 项目从仅支持 Vercel Serverless 部署改造为同时支持 EdgeOne Pages 部署。用户可通过 EdgeOne Pages 一键部署本项目，获得面向中国区域优化的访问体验，同时保留现有 Vercel 部署路径不受影响。

---

## 需求列表

### 1. 配置文件迁移

**用户故事：** 作为项目维护者，我希望将 `vercel.json` 中的路由、重写、标头配置迁移为 EdgeOne Pages 兼容的 `edgeone.json` 格式，以便在 EdgeOne 平台上实现等效的请求路由和行为。

**验收标准：**

1. 创建 [`edgeone.json`](./edgeone.json:1) 文件，包含与 `vercel.json` 等效的重定向（redirects）、重写（rewrites）和自定义标头（headers）配置。
2. `edgeone.json` 中的路由规则覆盖所有现有 `vercel.json` 中的规则，包括：
   - `/v1/chat/completions` 路由到 Go 入口（`/api/index`）和 Node 入口（`/api/chat-stream`）
   - 所有 `/admin/*` 路径路由到 `/api/index` 或静态管理页面
   - 根路径 `/*` 的兜底重写
3. `edgeone.json` 遵循 EdgeOne Pages 的配置语法规范，例如使用 `"/*"` 代替 `"/(.*)"` 作为通配符。
4. 保留原有 `vercel.json` 文件不变，确保现有 Vercel 部署路径不受影响。
5. 在 `edgeone.json` 中配置与 Vercel 等效的构建命令（`npm ci --prefix webui && npm run build --prefix webui`）和输出目录（`static`）。

### 2. Node.js 云函数适配

**用户故事：** 作为开发者，我希望将现有的 Node.js API 路由处理函数适配为 EdgeOne Pages Functions 的 `onRequest` 系列函数签名，以便在 EdgeOne 平台上正常处理 HTTP 请求。

**验收标准：**

1. 创建 EdgeOne Pages 版本的流式入口函数（例如 `functions/api/chat-stream.js`），将现有的 [`api/chat-stream.js`](api/chat-stream.js:1) 中的逻辑适配为 EdgeOne Pages Functions 格式。
2. 新函数使用 `export default` 导出，函数签名为 `onRequestPost(context)`，接收 `context` 对象（包含 `request`、`env`、`params` 等）而非 Node.js 原生的 `(req, res)`。
3. 在新函数内部，从 `context` 对象中提取请求信息（method、headers、body），并适配响应方式（EdgeOne 使用 `Response` 对象）。
4. 流式代理的核心逻辑（prepare、stream、release）保持不变，但需替换底层网络请求库为 EdgeOne 兼容的实现（如使用全局 `fetch` 替代 Node.js `http` 模块，如果现有代码已使用 `fetch` 则直接兼容）。
5. 新增 `functions/api/index.js`（Go 入口的 Node 适配层），将请求转发至 Go 编译产物或对应的 Go 函数入口，或直接重写路由规则使 Go 函数作为独立云函数部署。
6. 处理 EdgeOne Pages 环境变量注入方式，确保 `DS2API_CONFIG_JSON`、`DS2API_ADMIN_KEY` 等关键配置可正常读取。
7. 保留原有 `api/` 目录下的 Vercel 版本文件不变，EdgeOne 专用文件放在新目录（如 `functions/`）中。

### 3. Go 云函数适配

**用户故事：** 作为项目维护者，我希望 Go 后端在 EdgeOne Pages 环境中能够正常编译和运行，处理非流式请求和管理接口。

**验收标准：**

1. 确定 EdgeOne Pages 是否原生支持 Go runtime（或需通过自定义构建步骤生成可执行文件）。如果支持，配置 `edgeone.json` 中的 Go 函数入口。
2. 如果不支持 Go runtime，调整架构为：Go 编译为独立可执行文件，EdgeOne Pages Functions 通过子进程或 HTTP 调用本地 Go 服务，或探索在构建阶段将 Go 编译为 WASM 并通过 Node.js 加载的方案。
3. 确保 Go 后端读取环境变量的方式与 EdgeOne Pages 兼容（如 `PORT` 变量冲突处理）。
4. 保证 Go 模块路径导入兼容性（当前通过 `api/index.go` → `app` → `internal/server` 避免了 `internal` 包直接暴露的问题，确认该模式在 EdgeOne 构建环境中有效）。

### 4. 构建与部署流程

**用户故事：** 作为 DevOps 工程师，我希望通过 EdgeOne Pages 控制台或 CLI 一键部署本项目，构建流程自动完成前端构建并部署到 EdgeOne 全球边缘节点。

**验收标准：**

1. 在 `edgeone.json` 中正确定义构建命令和输出目录，与项目根目录的 `vercel.json` 中的构建配置等效。
2. 构建命令应在 EdgeOne Pages 环境中成功执行：Node.js 版本满足 `webui/package.json` 要求（>=20.19 或 >=22.12），前端依赖通过 npm 镜像源安装（支持使用中国镜像加速）。
3. 构建输出目录（`static`）包含前端管理界面静态文件（`admin/index.html`、JS/CSS 资源等），以及 API 函数入口文件（Go 二进制或 Node.js 函数文件）。
4. 提供部署说明文档，指导用户如何在 EdgeOne Pages 控制台创建项目、关联 GitHub 仓库、配置环境变量并完成首次部署。
5. 验证生产环境部署后的功能完整性：健康检查（`/healthz`）、模型列表（`/v1/models`）、聊天补全（`/v1/chat/completions`）和管理界面（`/admin`）均可正常访问。

### 5. 文档更新

**用户故事：** 作为项目使用者，我希望在 [`docs/DEPLOY.md`](docs/DEPLOY.md:1) 中看到 EdgeOne Pages 部署的完整指南，以便按照步骤顺利完成部署。

**验收标准：**

1. 在 [`docs/DEPLOY.md`](docs/DEPLOY.md:1) 中添加“EdgeOne Pages 部署”章节，包含：
   - 前置要求（EdgeOne 账号、GitHub 仓库关联）
   - 环境变量配置说明（`DS2API_ADMIN_KEY`、`DS2API_CONFIG_JSON` 等）
   - 通过 EdgeOne 控制台创建项目的分步指南
   - CLI 部署方式（如有）
   - 自定义域名配置
   - 常见问题排查
2. 更新部署方式优先级建议，将 EdgeOne Pages 加入推荐列表。
3. 如存在英文版部署文档（`docs/DEPLOY.en.md`），同步更新。

### 6. 兼容性与测试

**用户故事：** 作为 QA 工程师，我希望验证 EdgeOne Pages 部署后的功能与 Vercel 部署完全对等，确保用户体验一致。

**验收标准：**

1. 编写或适配现有测试脚本，验证 Node.js 流式代理在 EdgeOne 环境中的行为正确性（SSE 流式响应、工具调用、多轮对话、错误处理）。
2. 测试边缘情况：请求超时处理、并发请求、大负载响应、`content_filter` 错误等。
3. 确保 Vercel 部署路径不受影响，通过环境变量区分运行时（如当前 `isVercelRuntime()` 检测 `process.env.VERCEL`），EdgeOne 路径应新增 `isEdgeOneRuntime()` 检测逻辑，并在路由时选择正确的函数入口。
4. 对比 Vercel 与 EdgeOne 部署的响应延迟和吞吐量，记录性能基线。

### 7. 运行时检测与兼容路径

**用户故事：** 作为开发者，我希望系统能自动检测当前运行环境（Vercel / EdgeOne / 本地），并根据环境加载对应的适配逻辑，避免硬编码平台依赖。

**验收标准：**

1. 在 Node.js 代码中新增 `isEdgeOneRuntime()` 检测函数（如通过 `process.env.EDGEONE` 或类似环境变量），并确保流式处理路径在 EdgeOne 环境下正确激活。
2. 保持 `isVercelRuntime()` 的行为不变，两种平台的检测逻辑互不冲突。
3. 非 Vercel/EdgeOne 环境（本地、Docker 等）继续使用纯 Go 链路，不受新增代码影响。

---

## 非功能性需求

- **可维护性：** EdgeOne 专用函数文件与 Vercel 文件分离，便于独立维护和调试。
- **向后兼容：** 现有 Vercel 部署用户无需做任何改动。
- **性能：** EdgeOne 部署的响应延迟应优于或等同于 Vercel（利用国内节点加速）。
- **安全性：** 环境变量和密钥管理遵循 EdgeOne 平台最佳实践，不在代码中硬编码敏感信息。
