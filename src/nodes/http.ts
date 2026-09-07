import { registerNode } from "./registry.js";

registerNode({
  type: "http",
  label: "HTTP 请求",
  description: "发起 HTTP 请求，返回 { status, ok, headers, data }，data 会在响应是 JSON 时自动解析",
  example: {
    method: "GET",
    url: "https://api.github.com/repos/facebook/react",
    headers: { Accept: "application/vnd.github+json" },
  },
  async run({ params }) {
    const url = params.url;
    if (typeof url !== "string" || !url) {
      throw new Error("http 节点缺少 url 参数");
    }

    const method = String(params.method ?? "GET").toUpperCase();
    const headers: Record<string, string> = { ...(params.headers ?? {}) };
    const timeoutMs = Number(params.timeoutMs ?? 15000);

    let body: string | undefined;
    if (params.body !== undefined && method !== "GET" && method !== "HEAD") {
      if (typeof params.body === "string") {
        body = params.body;
      } else {
        body = JSON.stringify(params.body);
        headers["content-type"] = headers["content-type"] ?? "application/json";
      }
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method,
        headers,
        body,
        signal: controller.signal,
      });
      const text = await res.text();
      let data: unknown = text;
      try {
        data = JSON.parse(text);
      } catch {
        /* 非 JSON 响应就保留原始文本 */
      }
      return {
        status: res.status,
        ok: res.ok,
        headers: Object.fromEntries(res.headers.entries()),
        data,
      };
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        throw new Error(`HTTP 请求超时（${timeoutMs}ms）：${url}`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  },
});
