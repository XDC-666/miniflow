import {
  chat,
  type ChatMessage,
  type ToolDefinition,
} from "../llm/client.js";
import { registerNode } from "./registry.js";

/** 工具返回内容的长度上限，避免把超长网页塞爆上下文 */
const MAX_TOOL_RESULT = 4000;

const TOOL_CATALOG: Record<string, ToolDefinition> = {
  http_request: {
    type: "function",
    function: {
      name: "http_request",
      description:
        "发起 HTTP 请求，抓取网页内容或调用接口。返回状态码与响应正文（过长会被截断）。",
      parameters: {
        type: "object",
        properties: {
          method: {
            type: "string",
            enum: ["GET", "POST", "PUT", "DELETE"],
            description: "HTTP 方法，默认 GET",
          },
          url: { type: "string", description: "完整 URL，需包含 http(s)://" },
          body: { type: "string", description: "请求体，POST/PUT 时使用" },
        },
        required: ["url"],
      },
    },
  },
  current_time: {
    type: "function",
    function: {
      name: "current_time",
      description: "获取当前的 UTC 时间，ISO 8601 格式。",
      parameters: { type: "object", properties: {} },
    },
  },
};

async function executeTool(name: string, rawArgs: string): Promise<string> {
  let args: Record<string, any> = {};
  try {
    args = rawArgs ? JSON.parse(rawArgs) : {};
  } catch {
    return `参数解析失败，期望 JSON：${rawArgs}`;
  }

  if (name === "current_time") {
    return new Date().toISOString();
  }

  if (name === "http_request") {
    try {
      const method = String(args.method ?? "GET").toUpperCase();
      const res = await fetch(String(args.url), {
        method,
        body: args.body ? String(args.body) : undefined,
        headers: args.body ? { "content-type": "application/json" } : undefined,
      });
      const text = await res.text();
      return JSON.stringify({
        status: res.status,
        body: text.slice(0, MAX_TOOL_RESULT),
      });
    } catch (err) {
      return `请求失败：${(err as Error).message}`;
    }
  }

  return `未知工具：${name}`;
}

registerNode({
  type: "agent",
  label: "AI Agent（工具调用）",
  description:
    "带工具调用的 ReAct 循环：模型可反复调用 http_request / current_time，直到能给出最终答案",
  example: {
    system: "你是一个调研助手，先查资料再回答，并在结尾注明信息来源。",
    prompt: "查一下 Node.js 当前 LTS 版本，并用一句话说明它带来的主要变化。",
    tools: ["http_request", "current_time"],
    maxIterations: 8,
  },
  async run({ params }) {
    const maxIterations = Number(params.maxIterations ?? 8);
    const requested = Array.isArray(params.tools)
      ? (params.tools as string[])
      : ["http_request", "current_time"];
    const tools = requested
      .map((name) => TOOL_CATALOG[name])
      .filter((t): t is ToolDefinition => Boolean(t));

    if (tools.length === 0) {
      throw new Error("agent 节点没有可用工具，请检查 tools 参数");
    }

    const messages: ChatMessage[] = [
      {
        role: "system",
        content: String(
          params.system ??
            "你是一个可以使用工具的 AI 助手。需要外部信息时先调用工具，信息充分后再给出最终回答。",
        ),
      },
      { role: "user", content: String(params.prompt ?? "") },
    ];

    const steps: Array<{
      iteration: number;
      tool: string;
      arguments: string;
      result: string;
    }> = [];

    let answer = "";
    let iterations = 0;
    const model = params.model ? String(params.model) : undefined;
    const temperature =
      params.temperature !== undefined ? Number(params.temperature) : undefined;

    for (let i = 1; i <= maxIterations; i++) {
      iterations = i;
      const result = await chat({
        messages,
        model,
        temperature,
        tools,
        toolChoice: "auto",
      });

      if (result.toolCalls.length > 0) {
        messages.push({
          role: "assistant",
          content: result.content || "",
          tool_calls: result.toolCalls,
        });
        for (const call of result.toolCalls) {
          const output = await executeTool(
            call.function.name,
            call.function.arguments,
          );
          steps.push({
            iteration: i,
            tool: call.function.name,
            arguments: call.function.arguments,
            result: output.slice(0, MAX_TOOL_RESULT),
          });
          messages.push({
            role: "tool",
            tool_call_id: call.id,
            content: output,
          });
        }
        continue;
      }

      answer = result.content;
      break;
    }

    // 达到迭代上限仍没给出结论时，再问一次并禁用工具，强制模型收尾
    if (!answer) {
      const final = await chat({
        messages: [
          ...messages,
          {
            role: "user",
            content: "工具调用已达上限，请基于已获得的信息直接给出最终回答。",
          },
        ],
        model,
        temperature,
        tools,
        toolChoice: "none",
      });
      answer = final.content;
    }

    return {
      text: answer,
      steps,
      iterations,
      toolCalls: steps.length,
    };
  },
});
