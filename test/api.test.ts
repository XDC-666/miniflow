import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import "../src/nodes/index.js";
import { createServer } from "../src/server.js";
import { Store } from "../src/store/db.js";
import type { Workflow } from "../src/engine/types.js";

async function withApp(
  fn: (app: Awaited<ReturnType<typeof createServer>>, store: Store) => Promise<void>,
) {
  const dir = mkdtempSync(join(tmpdir(), "miniflow-api-"));
  const store = new Store(join(dir, "test.db"));
  const app = await createServer({ store });
  await app.ready();
  try {
    await fn(app, store);
  } finally {
    await app.close();
    store.close();
  }
}

/** 沙箱产出的对象属于新 realm，deepStrictEqual 会比对原型，故按 JSON 结构比较 */
function plain(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

const sample: Workflow = {
  name: "接口测试工作流",
  enabled: true,
  trigger: { type: "manual" },
  nodes: [{ id: "a", type: "code", params: { code: "return { ok: true };" } }],
  edges: [],
};

test("GET /api/health 返回 ok", async () => {
  await withApp(async (app) => {
    const res = await app.inject({ method: "GET", url: "/api/health" });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().status, "ok");
  });
});

test("GET /api/nodes 返回节点清单", async () => {
  await withApp(async (app) => {
    const res = await app.inject({ method: "GET", url: "/api/nodes" });
    assert.equal(res.statusCode, 200);
    const types = res.json().nodes.map((n: { type: string }) => n.type);
    assert.ok(types.includes("http"));
    assert.ok(types.includes("code"));
  });
});

test("工作流 CRUD 接口", async () => {
  await withApp(async (app) => {
    const created = await app.inject({
      method: "POST",
      url: "/api/workflows",
      payload: sample,
    });
    assert.equal(created.statusCode, 201);
    const id = created.json().workflow.id as string;

    const got = await app.inject({ method: "GET", url: `/api/workflows/${id}` });
    assert.equal(got.statusCode, 200);
    assert.equal(got.json().workflow.name, sample.name);

    const listed = await app.inject({ method: "GET", url: "/api/workflows" });
    assert.equal(listed.json().workflows.length, 1);

    const updated = await app.inject({
      method: "PUT",
      url: `/api/workflows/${id}`,
      payload: { ...sample, name: "改过的名字" },
    });
    assert.equal(updated.statusCode, 200);
    assert.equal(updated.json().workflow.name, "改过的名字");

    const removed = await app.inject({ method: "DELETE", url: `/api/workflows/${id}` });
    assert.equal(removed.statusCode, 200);
    assert.equal(
      (await app.inject({ method: "GET", url: `/api/workflows/${id}` })).statusCode,
      404,
    );
  });
});

test("非法工作流被 zod 校验拦截并返回 400", async () => {
  await withApp(async (app) => {
    const res = await app.inject({
      method: "POST",
      url: "/api/workflows",
      payload: { name: "", nodes: [] },
    });
    assert.equal(res.statusCode, 400);
    assert.ok(res.json().error);
  });
});

test("不存在的资源返回 404", async () => {
  await withApp(async (app) => {
    assert.equal(
      (await app.inject({ method: "GET", url: "/api/workflows/nope" })).statusCode,
      404,
    );
    assert.equal(
      (await app.inject({ method: "GET", url: "/api/runs/nope" })).statusCode,
      404,
    );
  });
});

test("POST /api/workflows/:id/run 同步等待时返回完整运行记录", async () => {
  await withApp(async (app) => {
    const created = await app.inject({
      method: "POST",
      url: "/api/workflows",
      payload: sample,
    });
    const id = created.json().workflow.id as string;

    const res = await app.inject({
      method: "POST",
      url: `/api/workflows/${id}/run`,
      payload: { wait: true },
    });
    assert.equal(res.statusCode, 200);
    const run = res.json().run;
    assert.equal(run.status, "success");
    assert.deepEqual(plain(run.results[0].output), { ok: true });
  });
});

test("GET /api/runs 返回运行历史", async () => {
  await withApp(async (app) => {
    const created = await app.inject({
      method: "POST",
      url: "/api/workflows",
      payload: sample,
    });
    const id = created.json().workflow.id as string;
    await app.inject({
      method: "POST",
      url: `/api/workflows/${id}/run`,
      payload: { wait: true },
    });

    const res = await app.inject({ method: "GET", url: "/api/runs" });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().runs.length, 1);
  });
});

test("DELETE /api/runs：保留最近 N 条 / 清空 / 参数校验", async () => {
  await withApp(async (app) => {
    const created = await app.inject({
      method: "POST",
      url: "/api/workflows",
      payload: sample,
    });
    const id = created.json().workflow.id as string;

    for (let i = 0; i < 3; i++) {
      await app.inject({
        method: "POST",
        url: `/api/workflows/${id}/run`,
        payload: { wait: true },
      });
    }
    assert.equal((await app.inject({ method: "GET", url: "/api/runs" })).json().runs.length, 3);

    // 保留最近 1 条
    const pruned = await app.inject({ method: "DELETE", url: "/api/runs?keep=1" });
    assert.equal(pruned.statusCode, 200);
    assert.equal(pruned.json().removed, 2);
    assert.equal((await app.inject({ method: "GET", url: "/api/runs" })).json().runs.length, 1);

    // 清空
    const cleared = await app.inject({ method: "DELETE", url: "/api/runs" });
    assert.equal(cleared.statusCode, 200);
    assert.equal((await app.inject({ method: "GET", url: "/api/runs" })).json().runs.length, 0);

    // 非法 keep 应被拒绝
    assert.equal((await app.inject({ method: "DELETE", url: "/api/runs?keep=0" })).statusCode, 400);
    assert.equal((await app.inject({ method: "DELETE", url: "/api/runs?keep=abc" })).statusCode, 400);
  });
});

test("webhook：未匹配的路径返回 404", async () => {
  await withApp(async (app) => {
    const res = await app.inject({
      method: "POST",
      url: "/api/webhook/not-exist",
      payload: {},
    });
    assert.equal(res.statusCode, 404);
  });
});

test("根路径返回控制台页面", async () => {
  await withApp(async (app) => {
    const res = await app.inject({ method: "GET", url: "/" });
    assert.equal(res.statusCode, 200);
    assert.match(res.headers["content-type"] as string, /text\/html/);
  });
});
