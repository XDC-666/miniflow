# 贡献指南

感谢你愿意给 MiniFlow 提改进。这是个轻量项目，流程刻意保持简单。

## 开发前

```bash
npm install
cp .env.example .env      # 没有密钥也能跑 http / code / template / delay 节点
npm run dev               # 热重载启动，默认 http://127.0.0.1:3000
```

## 提交前必须跑通

```bash
npm run verify     # = npm run typecheck && npm test
```

- `typecheck`：对 `src/` **和** `test/` 做类型检查（`tsconfig.test.json`）。
- `test`：包含安全用例。**改动沙箱、SSRF、表达式求值相关代码时，这些测试是硬性闸门**。

CI 会在 Node 20 / 22 上跑同样的检查，PR 必须全绿。

## 安全相关改动（重点）

MiniFlow 会执行用户提供的表达式与代码，安全是底线。涉及以下文件时请格外小心，
**并且必须补对应的测试用例**：

| 文件 | 职责 |
|---|---|
| `src/utils/interpolate.ts` | 表达式 / code 节点的 vm 沙箱与超时 |
| `src/utils/url.ts` | 出站请求的 SSRF 校验 |
| `src/nodes/*.ts` | 各节点的入参与外部调用 |

已经踩过的坑，别再踩：

1. **不要把宿主的内置对象直接塞进沙箱。** `Date` / `Object` / `Promise` 在宿主里都是函数对象，
   其 `.constructor` 就是宿主的 `Function`，于是
   `Date.constructor('return process')().env.OPENAI_API_KEY` 能读到全部环境变量。
   必须注入**新 realm** 的内置对象（见 `REALM_GLOBALS`）。
2. **环境变量白名单不等于隔离。** 只要 `process` 在沙箱里可达，"只允许读 `$env.XXX`"就形同虚设。
3. **`npm audit` 要用官方源**，镜像源（如 npmmirror）不实现 audit 接口，会假报 0 漏洞：
   ```bash
   npm audit --registry=https://registry.npmjs.org
   ```
4. **别写"扫描失败就当通过"的兜底**（例如 `grep ... || echo "无"`）。
   命令报错时必须显式报"扫描失败"，否则等于没审。

## 新增一个节点

1. 在 `src/nodes/` 下新建文件，用 `registerNode({ type, label, description, example, run })` 注册。
2. 在 `src/nodes/index.ts` 里 `import` 一次。
3. 节点对外发请求的话，**必须先过 `assertSafeUrl()`**。
4. 补一个测试用例。

## 提交信息

用中文或英文都行，一句话说清改动，例如：

```
fix: 修复 LLM 请求缺少超时导致工作流悬挂
security: 阻断内置对象 constructor 逃逸链
```
