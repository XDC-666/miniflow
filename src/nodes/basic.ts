import {
  assertCodeAllowed,
  evaluateExpression,
} from "../utils/interpolate.js";
import { registerNode } from "./registry.js";

registerNode({
  type: "condition",
  label: "条件判断",
  description:
    "对表达式求值，输出 { result: boolean }。配合连线上可选的 condition 即可实现分支流程",
  example: { expression: "$json.status === 200" },
  async run({ params, input, ctx }) {
    const expression = String(params.expression ?? "$json");
    const value = evaluateExpression(expression, ctx.scope(input));
    return { result: Boolean(value), value };
  },
});

registerNode({
  type: "template",
  label: "模板渲染",
  description:
    "渲染一段带 {{ }} 占位的文本。插值已在参数解析阶段完成，该节点主要用于整理输出结构",
  example: { template: "仓库 {{ $json.full_name }} 有 {{ $json.stargazers_count }} 个 star" },
  async run({ params }) {
    return { text: String(params.template ?? "") };
  },
});

registerNode({
  type: "code",
  label: "JavaScript 代码",
  description:
    "执行一段 JS。可用变量：$input（上游数据）、$node（各节点输出）、$json（同 $input）。最后用 return 返回结果",
  example: {
    code: "return $input.items.slice(0, 5).map(i => i.title);",
  },
  async run({ params, input, ctx }) {
    assertCodeAllowed("code 节点");
    const code = String(params.code ?? "");
    if (!code.trim()) throw new Error("code 节点缺少 code 参数");

    const scope = ctx.scope(input);
    const fn = new Function(
      "$input",
      "$json",
      "$node",
      "$ctx",
      `"use strict";\n${code}\n//# sourceURL=miniflow-code`,
    );
    const result = await fn(input, input, scope.$node, ctx);
    return result ?? null;
  },
});

registerNode({
  type: "delay",
  label: "延迟等待",
  description: "暂停一段时间再继续，常用于限流或等待异步任务（最长 5 分钟）",
  example: { ms: 1500 },
  async run({ params }) {
    const ms = Math.min(Math.max(Number(params.ms ?? 1000), 0), 300_000);
    await new Promise((resolve) => setTimeout(resolve, ms));
    return { delayedMs: ms };
  },
});
