/**
 * 模板插值：把 "你好 {{ $json.name }}" 这类字符串里的表达式求值后替换。
 *
 * 安全模型（v2，已加固）
 * ------------------------
 * 表达式在 Node 内置 `vm` 模块创建的【隔离上下文】中求值。两层加固：
 *
 *  1) 全局对象层：传给 vm.createContext 的全局对象用 Proxy 包裹，拦截
 *     constructor / __proto__ / prototype 以及 process / global / require /
 *     Function / eval / Buffer / fetch 等危险标识符，统一返回 undefined。
 *     这切断了 `globalThis.constructor.constructor('return process')()` 这类
 *     经由【全局对象原型链】逃逸到宿主 realm 的路径（这是 new Function /
 *     裸 vm 最常见的逃逸手法）。
 *
 *  2) 注入数据层：注入给表达式的变量（$json / $node / $env / $payload / ...）
 *     被递归 Proxy 包裹，同样拦截 constructor 等属性，切断经由宿主对象
 *     （如 `{$json}.constructor.constructor(...)`）的逃逸路径。
 *
 *  - 单次求值硬超时 200ms，防止死循环耗尽事件循环。
 *  - 若启用 MINIFLOW_SAFE_MODE=1，所有表达式被禁用（仅字面量可用）。
 *
 * 说明：MiniFlow 仍假设「能创建工作流的人是可信的」，这点和 n8n / Huginn 一致；
 * 上面的沙箱是纵深防御，不是把不可信用户当可信。不要把服务暴露给不可信用户。
 */

import { createContext, Script, type Context } from "node:vm";

const SAFE_MODE = process.env.MINIFLOW_SAFE_MODE === "1";

/** 在 safe mode 下禁止执行任意 JS（code 节点、表达式求值） */
export function assertCodeAllowed(what: string): void {
  if (SAFE_MODE) {
    throw new Error(`已启用 MINIFLOW_SAFE_MODE，${what} 被禁用`);
  }
}

// 会被表达式利用来逃逸到宿主 realm 的属性，一律拦截
const TRAP_PROPS = new Set(["constructor", "__proto__", "prototype"]);

// 绝不允许从表达式触及的全局标识符（含 globalThis 逃逸用的全局对象原型链顶端）
const FORBIDDEN_GLOBALS = new Set([
  "process",
  "global",
  "globalThis",
  "require",
  "module",
  "exports",
  "Function",
  "eval",
  "Buffer",
  "fetch",
  "import",
  "Proxy",
  "Reflect",
  "setTimeout",
  "setInterval",
  "setImmediate",
  "queueMicrotask",
  "constructor",
]);

/**
 * 递归包裹注入对象：访问 trap 属性返回 undefined，切断逃逸链；
 * 其余属性透明转发并继续包裹。常见内置实例（Date/RegExp/Map/Set/Error）原样返回，
 * 避免破坏它们的行为。
 */
function sandboxGuard(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  const t = typeof value;
  if (t !== "object" && t !== "function") return value;
  if (
    value instanceof Date ||
    value instanceof RegExp ||
    value instanceof Map ||
    value instanceof Set ||
    value instanceof Error
  ) {
    return value;
  }
  return new Proxy(value as object, {
    get(target, prop, receiver) {
      const key = String(prop);
      if (TRAP_PROPS.has(key)) return undefined;
      return sandboxGuard(Reflect.get(target, prop, receiver));
    },
    has(target, prop) {
      if (TRAP_PROPS.has(String(prop))) return false;
      return Reflect.has(target, prop);
    },
    getOwnPropertyDescriptor(target, prop) {
      const d = Reflect.getOwnPropertyDescriptor(target, prop);
      if (d && !d.configurable) d.configurable = true;
      return d;
    },
  });
}

// 仅暴露安全的全局（新 realm 内置，无法触及宿主 process）
const SAFE_GLOBALS: Record<string, unknown> = {
  JSON,
  Math,
  Date,
  Array,
  Object,
  String,
  Number,
  Boolean,
  RegExp,
  Map,
  Set,
  Symbol,
  parseInt,
  parseFloat,
  isNaN,
  isFinite,
  encodeURIComponent,
  decodeURIComponent,
  Error,
  TypeError,
  RangeError,
  // 空实现的 console，避免表达式日志污染宿主 stdout，也杜绝信息外泄
  console: {
    log() {},
    warn() {},
    error() {},
    info() {},
  },
};

/**
 * 用 Proxy 包裹全局对象，拦截逃逸属性与危险全局标识符，
 * 让 expressions 拿不到宿主 realm 的任何对象。
 */
function makeContext(guarded: Record<string, unknown>): Context {
  const target: Record<string, unknown> = { ...SAFE_GLOBALS, ...guarded };
  const proxy = new Proxy(target, {
    get(t, prop, receiver) {
      const key = String(prop);
      if (TRAP_PROPS.has(key) || FORBIDDEN_GLOBALS.has(key)) return undefined;
      if (key === "globalThis") return proxy; // 指向受控代理，避免绕过
      return Reflect.get(t, prop, receiver);
    },
    has(t, prop) {
      const key = String(prop);
      if (TRAP_PROPS.has(key) || FORBIDDEN_GLOBALS.has(key)) return false;
      return Reflect.has(t, prop);
    },
    getOwnPropertyDescriptor(t, prop) {
      const d = Reflect.getOwnPropertyDescriptor(t, prop);
      if (d && !d.configurable) d.configurable = true;
      return d;
    },
  });
  return createContext(proxy);
}

/** 在隔离沙箱中求值一段 JS 表达式 */
export function evaluateExpression(
  expr: string,
  scope: Record<string, unknown>,
): unknown {
  if (SAFE_MODE) {
    throw new Error(
      "已启用 MINIFLOW_SAFE_MODE，表达式求值被禁用：" + expr.trim(),
    );
  }
  const guarded: Record<string, unknown> = {};
  for (const k of Object.keys(scope)) {
    guarded[k] = sandboxGuard(scope[k]);
  }
  const context = makeContext(guarded);
  try {
    // "use strict" + IIFE：表达式内的 `this` 不指向宿主对象
    const script = new Script(`"use strict"; (() => (${expr}))()`);
    return script.runInContext(context, { timeout: 200 });
  } catch (err) {
    throw new Error(
      `表达式 "{{ ${expr} }}" 求值失败：${(err as Error).message}`,
    );
  }
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
