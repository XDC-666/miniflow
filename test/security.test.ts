import { test } from "node:test";
import assert from "node:assert/strict";
import {
  interpolateString,
  interpolateDeep,
  evaluateCondition,
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
