/**
 * 模板插值：把 "你好 {{ $json.name }}" 这类字符串里的表达式求值后替换掉。
 *
 * 安全说明：表达式通过 new Function 求值，等价于执行 JS。
 * 因此 MiniFlow 默认假定「能创建工作流的人是可信的」——这和 n8n、Huginn 等自部署
 * 工具的假设一致。若要把服务暴露给不信任的用户，请设置 MINIFLOW_SAFE_MODE=1，
 * 此时所有表达式都会被禁用（仅保留字面量）。
 */

const SAFE_MODE = process.env.MINIFLOW_SAFE_MODE === "1";

/** 在 safe mode 下禁止执行任意 JS（code 节点、表达式求值） */
export function assertCodeAllowed(what: string): void {
  if (SAFE_MODE) {
    throw new Error(`已启用 MINIFLOW_SAFE_MODE，${what} 被禁用`);
  }
}

/** 在给定作用域里求值一段 JS 表达式 */
export function evaluateExpression(
  expr: string,
  scope: Record<string, unknown>,
): unknown {
  if (SAFE_MODE) {
    throw new Error(
      "已启用 MINIFLOW_SAFE_MODE，表达式求值被禁用：" + expr.trim(),
    );
  }
  const keys = Object.keys(scope);
  const values = keys.map((k) => scope[k]);
  const fn = new Function(
    ...keys,
    `"use strict"; return (${expr});\n//# sourceURL=miniflow-expr`,
  );
  return fn(...values);
}

function stringify(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/** 替换字符串中所有 {{ ... }} */
export function interpolateString(
  template: string,
  scope: Record<string, unknown>,
): string {
  if (typeof template !== "string" || !template.includes("{{")) return template;
  return template.replace(/\{\{([\s\S]+?)\}\}/g, (_match, rawExpr: string) => {
    const expr = rawExpr.trim();
    if (!expr) return "";
    try {
      return stringify(evaluateExpression(expr, scope));
    } catch (err) {
      throw new Error(
        `表达式 "{{ ${expr} }}" 求值失败：${(err as Error).message}`,
      );
    }
  });
}

/** 递归处理对象 / 数组 / 字符串里的模板 */
export function interpolateDeep<T>(
  value: T,
  scope: Record<string, unknown>,
): T {
  if (typeof value === "string") {
    return interpolateString(value, scope) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => interpolateDeep(item, scope)) as unknown as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = interpolateDeep(v, scope);
    }
    return out as T;
  }
  return value;
}

/** 求布尔条件（用于 condition 节点和带条件的连线） */
export function evaluateCondition(
  expr: string,
  scope: Record<string, unknown>,
): boolean {
  const result = evaluateExpression(expr, scope);
  return Boolean(result);
}
