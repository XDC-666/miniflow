/**
 * OpenAI 兼容的 Chat Completions 客户端。
 * 只用 fetch 实现、零 SDK 依赖，因此同一套代码可以对接：
 *   - OpenAI            OPENAI_BASE_URL=https://api.openai.com/v1
 *   - DeepSeek          OPENAI_BASE_URL=https://api.deepseek.com/v1
 *   - 月之暗面 Kimi     OPENAI_BASE_URL=https://api.moonshot.cn/v1
 *   - 阿里通义千问      OPENAI_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
 *   - 本地 Ollama       OPENAI_BASE_URL=http://localhost:11434/v1
 */

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  name?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ChatOptions {
  messages: ChatMessage[];
  model?: string;
  temperature?: number;
  maxTokens?: number;
  /** 要求模型返回合法 JSON */
  json?: boolean;
  tools?: ToolDefinition[];
  toolChoice?: "auto" | "none";
}

export interface ChatResult {
  content: string;
  toolCalls: ToolCall[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  model: string;
}

function defaultModel(): string {
  return process.env.LLM_MODEL || "gpt-4o-mini";
}

export async function chat(opts: ChatOptions): Promise<ChatResult> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "缺少 OPENAI_API_KEY。请在 .env 中配置，或改用不需要密钥的本地模型（如 Ollama）。",
    );
  }

  const baseURL = (
    process.env.OPENAI_BASE_URL || "https://api.openai.com/v1"
  ).replace(/\/+$/, "");
  const model = opts.model || defaultModel();
  const url = `${baseURL}/chat/completions`;

  const body: Record<string, unknown> = {
    model,
    messages: opts.messages,
    temperature: opts.temperature ?? 0.7,
  };
  if (opts.maxTokens) body.max_tokens = opts.maxTokens;
  if (opts.json) body.response_format = { type: "json_object" };
  if (opts.tools && opts.tools.length > 0) {
    body.tools = opts.tools;
    body.tool_choice = opts.toolChoice ?? "auto";
  }

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new Error(`无法连接模型服务 ${url}：${(err as Error).message}`);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `模型服务返回错误 ${res.status}：${text.slice(0, 500) || res.statusText}`,
    );
  }

  const data = (await res.json()) as any;
  const choice = data?.choices?.[0];
  if (!choice) throw new Error("模型服务返回内容为空");

  return {
    content: choice.message?.content ?? "",
    toolCalls: choice.message?.tool_calls ?? [],
    usage: data.usage,
    model: data.model ?? model,
  };
}

/** 尝试把模型输出解析成 JSON，失败则返回 null */
export function tryParseJson(text: string): unknown | null {
  if (!text) return null;
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/, "")
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}
