import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Store } from "../src/store/db.js";
import type { RunRecord, Workflow } from "../src/engine/types.js";

function freshStore(): Store {
  const dir = mkdtempSync(join(tmpdir(), "miniflow-test-"));
  return new Store(join(dir, "test.db"));
}

function wf(name: string): Workflow {
  return {
    name,
    enabled: true,
    trigger: { type: "manual" },
    nodes: [{ id: "a", type: "code", params: { code: "return 1;" } }],
    edges: [],
  };
}

function run(id: string, workflowId: string): RunRecord {
  return {
    id,
    workflowId,
    workflowName: "t",
    status: "success",
    trigger: "manual",
    startedAt: new Date().toISOString(),
    results: [],
  };
}

test("工作流 CRUD：创建 / 读取 / 列表 / 更新 / 删除", () => {
  const store = freshStore();

  const created = store.createWorkflow(wf("第一个"));
  assert.ok(created.id, "应自动生成 id");
  assert.equal(store.getWorkflow(created.id)?.name, "第一个");
  assert.equal(store.listWorkflows().length, 1);

  const updated = store.updateWorkflow(created.id, { ...wf("改名了"), id: created.id });
  assert.equal(updated?.name, "改名了");
  assert.equal(store.getWorkflow(created.id)?.name, "改名了");

  assert.equal(store.deleteWorkflow(created.id), true);
  assert.equal(store.getWorkflow(created.id), null);
  assert.equal(store.listWorkflows().length, 0);

  store.close();
});

test("工作流操作：不存在的 id 返回 null / false 而不是抛错", () => {
  const store = freshStore();
  assert.equal(store.getWorkflow("nope"), null);
  assert.equal(store.updateWorkflow("nope", wf("x")), null);
  assert.equal(store.deleteWorkflow("nope"), false);
  store.close();
});

test("运行记录：保存 / 读取 / 按工作流过滤 / 数量上限", () => {
  const store = freshStore();
  const w = store.createWorkflow(wf("带运行记录"));

  store.saveRun(run("r1", w.id));
  store.saveRun(run("r2", w.id));
  assert.equal(store.getRun("r1")?.id, "r1");
  assert.equal(store.listRuns(w.id).length, 2);
  assert.equal(store.listRuns("other-id").length, 0);

  // limit 应被夹在 1..500 之间
  assert.ok(store.listRuns(undefined, 0).length >= 1, "limit=0 应被夹到 1");
  assert.ok(store.listRuns(undefined, 99999).length <= 500);

  // 删除工作流时其运行记录一并清理
  store.deleteWorkflow(w.id);
  assert.equal(store.listRuns(w.id).length, 0);

  store.close();
});

test("pruneRuns：保留最近 N 条，其余删除", () => {
  const store = freshStore();
  const w = store.createWorkflow(wf("瘦身"));

  for (let i = 1; i <= 5; i++) {
    store.saveRun({
      ...run(`r${i}`, w.id),
      startedAt: new Date(Date.now() + i).toISOString(),
    });
  }
  assert.equal(store.listRuns(w.id).length, 5);

  const removed = store.pruneRuns(2, w.id);
  assert.equal(removed, 3);
  assert.equal(store.listRuns(w.id).length, 2);

  // keep 会被夹到至少 1
  store.pruneRuns(0, w.id);
  assert.equal(store.listRuns(w.id).length, 1);

  store.close();
});

test("clearRuns：清理全部运行记录", () => {
  const store = freshStore();
  const w = store.createWorkflow(wf("清理"));
  store.saveRun(run("r1", w.id));
  assert.equal(store.listRuns().length, 1);
  store.clearRuns();
  assert.equal(store.listRuns().length, 0);
  store.close();
});
