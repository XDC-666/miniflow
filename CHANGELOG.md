# 更新日志

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.2.0] - 2026-09-09

### 安全（重要）

- **阻断内置对象 `constructor` 逃逸链（高危）**
  此前沙箱直接把宿主的 `JSON` / `Math` / `Date` 等内置对象注入 vm 上下文。它们都是函数对象，
  其 `.constructor` 指向宿主的 `Function`，因此
  `Date.constructor('return process')().env.OPENAI_API_KEY` 可以直接读到服务端全部环境变量。
  修复方式：改为注入**全新 realm** 的内置对象（`REALM_GLOBALS`），其 `.constructor` 指向新 realm 的
  `Function`，逃逸链在新 realm 内即断。已补充覆盖 25 个内置对象 × 2 条链的回归测试。

### 可用性（重要）

- **LLM 请求增加超时**：`src/llm/client.ts` 的 `fetch` 此前没有 `signal`，模型服务假死会让整条工作流
  永久悬挂；而 webhook 触发是同步等待 run 结束的，会连带把外部调用方一起挂住。
  现在默认 120s，可用 `MINIFLOW_LLM_TIMEOUT_MS` 配置。
- **code 节点增加硬超时**：此前用裸 `new Function` 在主线程执行且无超时，一句 `while(true){}`
  就会占满事件循环、**整个服务失去响应**（连 `/api/health` 都不回）。
  现在 code 节点改在 vm 沙箱内执行，双层超时：vm 的 `timeout` 中断同步死循环，
  `Promise.race` 兜住永不 resolve 的 Promise。默认 5s，可用 `MINIFLOW_CODE_TIMEOUT_MS` 配置。

### 变更（Behavior Change）

- **code 节点现在运行在沙箱内**，因此不再能访问 `require` / `process` 等宿主对象
  （此前可以）。文档化的可用变量 `$input` / `$json` / `$node` 保持不变，
  且新增支持顶层 `await`。如果你依赖 `require`，请改为把逻辑放到自定义节点里。

### 新增

- 节点级容错：节点参数 `onError: "continue"` 可让该节点失败后不中断整条流程
  （其余分支继续跑完，整体仍记为 `failed`）。
- 运行记录清理接口 `DELETE /api/runs`：支持 `?keep=N` 保留最近 N 条，
  或 `?workflowId=xxx` 限定某个工作流（此前 `runs` 表只增不减）。
- CI：GitHub Actions 在 Node 20 / 22 上跑类型检查 + 测试 + 构建。
- `npm run typecheck` / `npm run verify`：类型检查现已覆盖 `test/`（此前只检查 `src/`）。
- CORS 支持 `MINIFLOW_CORS_ORIGINS` 白名单（此前固定为 `*`）。
- 示例工作流改用标记文件去重，避免用户改名后重复导入。
- 新增 `CONTRIBUTING.md`、Dependabot 配置，以及 engine / store / api 三组核心测试。

### 修复

- `tsconfig.json` 的 `exclude` 里 `tests` 拼写错误（实际目录为 `test`）。
- `server.ts` 中 `bad(reply: any, ...)` 丢失 Fastify 类型，已改为 `FastifyReply`。

## [0.1.0] - 2026-09-07

- 首个版本：DAG 工作流引擎，7 种节点（http / llm / agent / condition / code / template / delay），
  3 种触发（手动 / webhook / 定时），SQLite 持久化，零依赖单页控制台。
- 安全基线：表达式 vm 沙箱、SSRF 防护、响应体上限、SAFE_MODE。
