import { chat, tryParseJson, type ChatMessage } from "../llm/client.js";
import { registerNode } from "./registry.js";

registerNode({
  type: "llm",
  label: "LLM 调用",
  description:
    "调用一次大语言模型。支持 system / prompt、温度、结构化 JSON 输出，可用于摘要、分类、抽取、翻译等",
  example: {
    system: "你是一个严谨的技术编辑，只输出 JSON。",
    prompt: "请把以下内容压缩成 3 条要点：{{ $json.data }}",
    model: "gpt-4o-mini",
    temperature: 0.3,
    json: true,
  },
  async run({ params }) {
    const messages: ChatMessage[] = [];
    if (params.system) {
      messages.push({ role: "system", content: String(params.system) });
    }
    const prompt = params.prompt ?? "";
    messages.push({ role: "user", content: String(prompt) });

    const result = await chat({
      messages,
      model: params.model ? String(params.model) : undefined,
      temperature:
        params.temperature !== undefined ? Number(params.temperature) : undefined,
      maxTokens: params.maxTokens ? Number(params.maxTokens) : undefined,
      json: Boolean(params.json),
    });

    return {
      text: result.content,
      json: tryParseJson(result.content),
      model: result.model,
      usage: result.usage ?? null,
    };
  },
});
