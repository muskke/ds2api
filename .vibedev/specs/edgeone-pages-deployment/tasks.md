# EdgeOne Pages 部署支持 — 任务清单

## 概述

基于[设计文档](./design.md)和[需求文档](./requirements.md)，以下任务清单涵盖将 DS2API 项目适配到 EdgeOne Pages 所需的所有编码工作。

---

## 任务列表

### 1. 创建 EdgeOne Pages 配置文件

- [ ] 1.1 创建 `edgeone.json` 配置文件
  - 定义构建命令：`npm ci --prefix webui && npm run build --prefix webui -- --outDir ../static/admin --emptyOutDir`
  - 定义输出目录：`static`
  - 配置路由重写规则：将 `/v1/chat/completions` 路由到 Node Function，其余 `/v1/*`、`/admin/*`、`/*` 路由到 Go Cloud Function
  - 配置自定义响应头：`/admin/assets/*` 设置长缓存，`/admin/*` 设置禁止缓存
  - 配置 Node Functions 的 `included_files`，包含 `internal/js/**` 模块
  - **需求引用**：需求 1.1, 1.2, 1.3, 1.4, 1.5（配置文件迁移）

### 2. 创建 Go Cloud Function 入口

- [ ] 2.1 创建 `cloud-functions/index.go` 文件
  - 实现 `func main()` 作为入口，使用 Chi 框架的 Framework 模式
  - 调用 `config.LoadDotEnv()` 加载环境变量，`config.RefreshLogger()` 初始化日志
  - 调用 `webui.EnsureBuiltOnStartup()` 确保前端静态文件可用
  - 通过 `app.NewHandler()` 获取完整的 Chi 路由器
  - 监听 `PORT` 环境变量指定的端口，默认 `9000`
  - 复用现有的 `ds2api/app` 包，不修改任何现有 Go 业务代码
  - **需求引用**：需求 3.1, 3.3, 3.4（Go 云函数适配）

- [ ] 2.2 验证 `cloud-functions/index.go` 可编译
  - 在本地执行 `go build -o /dev/null ./cloud-functions/index.go` 确认编译通过
  - **需求引用**：需求 3.1（Go 云函数适配）

### 3. 创建 Node.js 流式函数

- [ ] 3.1 创建 `functions/api/chat-stream.js` 文件
  - 实现 `export async function onRequestPost(context)` 作为 EdgeOne Pages Function 入口
  - 从 `context.request` 获取请求信息（method、headers、body），从 `context.env` 获取环境变量
  - 处理 OPTIONS 请求返回 204，非 POST 请求返回 405
  - 实现流式代理逻辑：调用 Go Cloud Function 的 `__stream_prepare` 获取准备信息，直连 DeepSeek 进行 SSE 流式转发，最后调用 `__stream_release` 释放资源
  - 使用 Web Streams API（`TransformStream` / `ReadableStream`）替代 Node.js `ServerResponse` 实现流式响应
  - 复用 `internal/js/chat-stream/` 下的 SSE 解析、工具筛分、CORS 等共享模块
  - 新增 `isEdgeOneRuntime()` 检测函数，通过 `process.env.EDGEONE_RUNTIME` 判断运行环境
  - 内部调用 Go Cloud Function 时使用部署域名（`new URL(request.url)` 构建）
  - **需求引用**：需求 2.1, 2.2, 2.3, 2.4, 2.6, 2.7（Node.js 云函数适配）

### 4. 适配运行时检测逻辑

- [ ] 4.1 在 `internal/js/chat-stream/index.js` 中新增 `isEdgeOneRuntime()` 函数
  - 检测 `process.env.EDGEONE_RUNTIME` 或 `process.env.EDGEONE` 环境变量
  - 保持现有 `isVercelRuntime()` 逻辑不变，两者互不冲突
  - 添加 `isServerlessRuntime()` 辅助函数，统一判断 Vercel 或 EdgeOne 环境
  - **需求引用**：需求 7.1, 7.2, 7.3（运行时检测与兼容路径）

### 5. 编写自动化测试

- [ ] 5.1 为 `isEdgeOneRuntime()` 编写单元测试
  - 测试在设置 `EDGEONE_RUNTIME` 环境变量时返回 `true`
  - 测试在未设置任何平台环境变量时返回 `false`
  - 测试与 `isVercelRuntime()` 的互斥性
  - **需求引用**：需求 6.1, 6.3（兼容性与测试）

- [ ] 5.2 为 `functions/api/chat-stream.js` 编写单元测试
  - 测试 `onRequestPost` 正常处理 POST 请求
  - 测试 OPTIONS 请求返回 204
  - 测试非 POST 请求返回 405
  - 测试通过 `context.env` 正确读取环境变量
  - 测试流式响应体的正确处理
  - **需求引用**：需求 6.1, 6.2（兼容性与测试）

- [ ] 5.3 为 `cloud-functions/index.go` 编写编译验证测试
  - 验证 Go Cloud Function 入口在目标平台可正常编译
  - 验证导入路径和依赖在 EdgeOne 构建环境中可用
  - **需求引用**：需求 3.4（Go 云函数适配）

### 6. 验证 Vercel 兼容性

- [ ] 6.1 确保现有 Vercel 部署不受影响
  - 验证 `api/chat-stream.js` 和 `api/index.go` 未被修改
  - 验证 `vercel.json` 保持不变
  - 运行现有测试套件确保无回归
  - **需求引用**：需求 6.3, 非功能性需求（向后兼容）
