import { test } from "node:test";
import assert from "node:assert/strict";
import {
  interpolateString,
  interpolateDeep,
  evaluateCondition,
  runSandboxedCode,
} from "../src/utils/interpolate.js";
import { assertSafeUrl } from "../src/utils/url.js";

const scope = {
  $json: { name: "world", nested: { secret: "xyz" } },
  $node: {},
  $env: { PUBLIC: "ok" },
  $payload: null,
} as unknown as Record<string, unknown>;

test("process.env 在表达式中不可达（密钥不泄露）", () => {
  process.env.MINIFLOW_TEST_SECRET = "LEAK_VALUE_SHOULD_NOT_APPEAR";
  let out: string | undefined;
  try {
    out = interpolateString("{{ process.env.MINIFLOW_TEST_SECRET }}", scope);
  } catch {
    out = undefined; // 抛错也视为安全（未泄露）
  }
  assert.ok(
    out === undefined || out === "" || !String(out).includes("LEAK_VALUE_SHOULD_NOT_APPEAR"),
    `process.env 疑似可被读取，输出为: ${out}`,
  );
  delete process.env.MINIFLOW_TEST_SECRET;
});

test("通过 .constructor 链逃逸到宿主 realm 被阻断", () => {
  assert.throws(() =>
    interpolateString(
      "{{ $json.constructor.constructor('return process')() }}",
      scope,
    ),
  );
});

test("通过 globalThis 原型链逃逸到宿主 realm 被阻断", () => {
  // 经典 vm 逃逸：globalThis.constructor.constructor('return process')()
  assert.throws(() =>
    interpolateString(
      "{{ globalThis.constructor.constructor('return process')() }}",
      scope,
    ),
  );
  // require 等模块加载器不存在
  assert.throws(() => interpolateString("{{ require('os') }}", scope));
});

test("综合探针：完整 env 无法通过任何表达式逃逸", () => {
  process.env.MINIFLOW_PROBE = "PROBE_SHOULD_NEVER_LEAK_12345";
  const probes = [
    "{{ process.env.MINIFLOW_PROBE }}",
    "{{ globalThis.process.env.MINIFLOW_PROBE }}",
    "{{ $json.constructor.constructor('return process')().env.MINIFLOW_PROBE }}",
    "{{ globalThis.constructor.constructor('return process')().env.MINIFLOW_PROBE }}",
  ];
  for (const p of probes) {
    let out: string | undefined;
    try {
      out = interpolateString(p, scope);
    } catch {
      out = undefined; // 抛错 = 安全
    }
    assert.ok(
      out === undefined ||
        out === "" ||
        !String(out).includes("PROBE_SHOULD_NEVER_LEAK_12345"),
      `表达式泄露了宿主 env：${p} => ${out}`,
    );
  }
  delete process.env.MINIFLOW_PROBE;
});

test("$env 白名单仍正常工作", () => {
  assert.equal(interpolateString("{{ $env.PUBLIC }}", scope), "ok");
});

test("正常插值、条件、深层插值不受影响", () => {
  assert.equal(interpolateString("hello {{ $json.name }}", scope), "hello world");
  assert.equal(
    evaluateCondition("$json.nested.secret == 'xyz'", scope),
    true,
  );
  assert.deepEqual(interpolateDeep({ a: "{{ $json.name }}" }, scope), {
    a: "world",
  });
});

test("SSRF: 拦截 localhost / 回环地址", async () => {
  await assert.rejects(() => assertSafeUrl("http://localhost:3000/"));
  await assert.rejects(() => assertSafeUrl("http://127.0.0.1/"));
  await assert.rejects(() => assertSafeUrl("http://[::1]/"));
});

test("SSRF: 拦截云元数据 / 链路本地 169.254.169.254", async () => {
  await assert.rejects(() =>
    assertSafeUrl("http://169.254.169.254/latest/meta-data/"),
  );
});

test("SSRF: 拦截私网保留段 10/172.16-31/192.168", async () => {
  await assert.rejects(() => assertSafeUrl("http://10.0.0.1/"));
  await assert.rejects(() => assertSafeUrl("http://192.168.1.1/"));
  await assert.rejects(() => assertSafeUrl("http://172.16.0.1/"));
  await assert.rejects(() => assertSafeUrl("http://172.31.255.255/"));
});

test("SSRF: 拦截非 http/https 协议", async () => {
  await assert.rejects(() => assertSafeUrl("file:///etc/passwd"));
  await assert.rejects(() => assertSafeUrl("gopher://evil/"));
  await assert.rejects(() => assertSafeUrl("ftp://example.com/"));
});

test("SSRF: 放行公网 IP 字面量（不依赖 DNS）", async () => {
  // 8.8.8.8 是公网 DNS，net.isIP>0 直接走字面量层放行
  await assert.doesNotReject(() => assertSafeUrl("http://8.8.8.8/"));
  await assert.doesNotReject(() => assertSafeUrl("https://1.1.1.1/"));
});

// ---------- 内置对象 .constructor 逃逸链（真实事故回归） ----------
// 事故：曾把宿主的 JSON/Math/Date 等直接注入沙箱。它们都是「函数对象」，
// 其 .constructor 就是宿主 Function，于是
//   Date.constructor('return process')().env.OPENAI_API_KEY
// 可读到全部环境变量（Proxy 只包住全局对象，管不到内置对象身上的 .constructor）。
// 修复：改为注入「新 realm」的内置对象，其 .constructor 指向新 realm 的 Function。
const BUILTIN_NAMES = [
  "JSON", "Math", "Date", "Array", "Object", "String", "Number",
  "Boolean", "RegExp", "Map", "Set", "Symbol", "Promise", "BigInt",
  "parseInt", "parseFloat", "isNaN", "isFinite",
  "encodeURIComponent", "decodeURIComponent",
  "Error", "TypeError", "RangeError", "SyntaxError", "URIError",
];

test("内置对象 constructor 逃逸链全部被阻断", () => {
  process.env.MINIFLOW_PROBE = "PROBE_SHOULD_NEVER_LEAK_99999";
  try {
    for (const name of BUILTIN_NAMES) {
      for (const chain of [
        `${name}.constructor('return process')().env.MINIFLOW_PROBE`,
        `${name}.constructor.constructor('return process')().env.MINIFLOW_PROBE`,
      ]) {
        let out: string | undefined;
        try {
          out = interpolateString(`{{ ${chain} }}`, scope);
        } catch {
          out = undefined; // 抛错 = 安全
        }
        assert.ok(
          out === undefined ||
            out === "" ||
            !String(out).includes("PROBE_SHOULD_NEVER_LEAK_99999"),
          `内置对象 ${name} 存在 constructor 逃逸：${chain} => ${out}`,
        );
      }
    }
  } finally {
    delete process.env.MINIFLOW_PROBE;
  }
});

test("沙箱内置对象仍然可用（JSON/Math/Date/Promise 未被误伤）", () => {
  assert.equal(interpolateString("{{ JSON.stringify({a:1}) }}", scope), '{"a":1}');
  assert.equal(interpolateString("{{ Math.max(1,2) }}", scope), "2");
  assert.equal(interpolateString("{{ typeof new Date().toISOString() }}", scope), "string");
  assert.equal(interpolateString("{{ $json.name }}", scope), "world");
});

// ---------- code 节点超时（防主线程被死循环占满） ----------
test("code 节点：同步死循环被硬超时中断", async () => {
  const t0 = Date.now();
  await assert.rejects(() => runSandboxedCode("while(true){}", {}, 300));
  assert.ok(Date.now() - t0 < 3000, "死循环中断耗时应接近超时值");
});

test("code 节点：永不 resolve 的 Promise 被中断", async () => {
  await assert.rejects(
    () => runSandboxedCode("return new Promise(()=>{});", {}, 300),
  );
});

test("code 节点：正常代码与顶层 await 仍可用", async () => {
  const r = await runSandboxedCode(
    "return $input.items.slice(0,2).map(i=>i*2);",
    { $input: { items: [1, 2, 3] } },
    1000,
  );
  assert.deepEqual(r, [2, 4]);

  const r2 = await runSandboxedCode(
    "return await Promise.resolve($json.x + 1);",
    { $json: { x: 41 } },
    1000,
  );
  assert.equal(r2, 42);
});

test("code 节点：沙箱内 process / require 不可达", async () => {
  assert.equal(await runSandboxedCode("return typeof process;", {}, 1000), "undefined");
  assert.equal(await runSandboxedCode("return typeof require;", {}, 1000), "undefined");
});
