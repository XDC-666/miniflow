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

/**
 * 注入沙箱的「标准内置对象」必须来自【一个全新的 realm】，绝不能直接用宿主的。
 *
 * 原因（真实逃逸案例）：`Date` / `Object` / `Promise` 在宿主里都是「函数对象」，
 * 而函数的 `.constructor` 就是宿主的 `Function` 构造器，于是
 *   `Date.constructor('return process')().env.OPENAI_API_KEY`
 * 可以直接造出宿主函数、读到全部环境变量 —— Proxy 只包住了全局对象本身，
 * 管不到这些内置对象身上的 `.constructor`，此路绕过了所有拦截。
 *
 * 新 realm 的内置对象，其 `.constructor` 指向【新 realm 的 Function】，
 * 在新 realm 里 `process` 根本不存在，因此逃逸链断在这里。
 */
const REALM_GLOBALS: Record<string, unknown> = (() => {
  const probe = createContext({});
  return new Script(
    `({JSON,Math,Date,Array,Object,String,Number,Boolean,RegExp,Map,Set,Symbol,` +
      `Promise,BigInt,parseInt,parseFloat,isNaN,isFinite,` +
      `encodeURIComponent,decodeURIComponent,URIError,` +
      `Error,TypeError,RangeError,SyntaxError,EvalError})`,
  ).runInContext(probe) as Record<string, unknown>;
})();

/**
 * 沙箱内的 console 空实现：避免表达式/节点日志污染宿主 stdout，也杜绝信息外泄。
 * 定义在包装函数体内（新 realm 中构造），而不是把宿主的 console 对象塞进去。
 */
const CONSOLE_SHIM = `const console={log(){},warn(){},error(){},info(){},debug(){},trace(){}};`;

/**
 * 用 Proxy 包裹全局对象，拦截逃逸属性与危险全局标识符，
 * 让 expressions 拿不到宿主 realm 的任何对象。
 */
function makeContext(guarded: Record<string, unknown>): Context {
  const target: Record<string, unknown> = { ...REALM_GLOBALS, ...guarded };
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

/** 构造隔离上下文：注入数据先经 sandboxGuard 包裹，再交给 Proxy 全局 */
function buildContext(scope: Record<string, unknown>): Context {
  const guarded: Record<string, unknown> = {};
  for (const k of Object.keys(scope)) {
    guarded[k] = sandboxGuard(scope[k]);
  }
  return makeContext(guarded);
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
  const context = buildContext(scope);
  try {
    // "use strict" + IIFE：表达式内的 `this` 不指向宿主对象；console 用空实现遮蔽
    const script = new Script(
      `"use strict"; (function(){ ${CONSOLE_SHIM}\n return (${expr}); })()`,
    );
    return script.runInContext(context, { timeout: 200 });
  } catch (err) {
    throw new Error(
      `表达式 "{{ ${expr} }}" 求值失败：${(err as Error).message}`,
    );
  }
}

/**
 * code 节点的执行超时（毫秒）。
 * code 节点跑在主线程，若没有超时，一句 `while(true){}` 就会占满事件循环，
 * 导致整个服务失去响应（连 /api/health 都不回）。因此必须有硬超时。
 */
export function codeTimeoutMs(): number {
  const n = Number(process.env.MINIFLOW_CODE_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 5_000;
}

/**
 * 在沙箱中执行一段 JS 代码体（支持 `return`，也支持 async 返回 Promise）。
 *
 * 双层超时：
 *  1) vm 的 `timeout` 中断同步死循环（这是 new Function 做不到的）；
 *  2) 若代码返回 Promise，再套一层 Promise.race，
 *     避免 await 一个永不 resolve 的 Promise 把流程永久挂住。
 *
 * 与表达式共用同一套 Proxy 沙箱，因此拿不到 process / require 等宿主对象。
 */
export async function runSandboxedCode(
  code: string,
  scope: Record<string, unknown>,
  timeoutMs: number = codeTimeoutMs(),
): Promise<unknown> {
  if (SAFE_MODE) {
    throw new Error("已启用 MINIFLOW_SAFE_MODE，code 节点被禁用");
  }

  const context = buildContext(scope);
  let result: unknown;
  try {
    // 包成 async 函数，支持顶层 await；返回值一律是 Promise，由下面的 race 接超时
    const script = new Script(
      `"use strict"; (async function(){ ${CONSOLE_SHIM}\n${code}\n})()`,
    );
    result = script.runInContext(context, { timeout: timeoutMs });
  } catch (err) {
    const message = (err as Error)?.message ?? String(err);
    if (/timed out/i.test(message)) {
      throw new Error(`代码执行超时（${timeoutMs}ms），已中断`);
    }
    throw new Error(`代码执行失败：${message}`);
  }

  const thenable = result as PromiseLike<unknown> | null;
  if (thenable && typeof (thenable as { then?: unknown }).then === "function") {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        Promise.resolve(thenable),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error(`代码执行超时（${timeoutMs}ms），已中断`)),
            timeoutMs,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  return result;
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
