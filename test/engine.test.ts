import { test } from "node:test";
import assert from "node:assert/strict";

// 导入即注册全部内置节点
import "../src/nodes/index.js";
import { executeWorkflow } from "../src/engine/executor.js";
import type { Workflow } from "../src/engine/types.js";

const base = {
  id: "wf_test",
  enabled: true,
  trigger: { type: "manual" as const },
};

/**
 * 沙箱里 return 出来的对象属于「新 realm」，其原型是新 realm 的 Object.prototype，
 * deepStrictEqual 会因原型不同而失败（这正是沙箱隔离的副作用，功能上无影响）。
 * 因此按 JSON 结构比较——这才是有意义的语义。
 */
function plain(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

test("线性执行：上游输出作为下游输入传递", async () => {
  const wf: Workflow = {
    ...base,
    name: "线性",
    nodes: [
      { id: "a", type: "code", params: { code: "return { n: 1 };" } },
      { id: "b", type: "code", params: { code: "return { n: $json.n + 10 };" } },
    ],
    edges: [{ from: "a", to: "b" }],
  };

  const record = await executeWorkflow({ workflow: wf });
  assert.equal(record.status, "success");
  assert.equal(record.results.length, 2);
  assert.deepEqual(plain(record.results[0].output), { n: 1 });
  assert.deepEqual(plain(record.results[1].output), { n: 11 });
});

test("条件分支：满足条件的分支执行，另一分支被跳过", async () => {
  const wf: Workflow = {
    ...base,
    name: "分支",
    nodes: [
      { id: "start", type: "code", params: { code: "return { score: 90 };" } },
      { id: "high", type: "code", params: { code: "return 'high';" } },
      { id: "low", type: "code", params: { code: "return 'low';" } },
    ],
    edges: [
      { from: "start", to: "high", condition: "$json.score >= 60" },
      { from: "start", to: "low", condition: "$json.score < 60" },
    ],
  };

  const record = await executeWorkflow({ workflow: wf });
  assert.equal(record.status, "success");

  const byId = Object.fromEntries(record.results.map((r) => [r.nodeId, r]));
  assert.equal(byId.high.status, "success");
  assert.equal(byId.high.output, "high");
  assert.equal(byId.low.status, "skipped");
  assert.equal(byId.low.output, null);
});

test("节点失败：整条运行标记 failed，执行立即中止（fail-fast）", async () => {
  const wf: Workflow = {
    ...base,
    name: "失败",
    nodes: [
      { id: "a", type: "code", params: { code: "throw new Error('boom');" } },
      { id: "b", type: "code", params: { code: "return 1;" } },
    ],
    edges: [{ from: "a", to: "b" }],
  };

  const record = await executeWorkflow({ workflow: wf });
  assert.equal(record.status, "failed");
  assert.match(record.error ?? "", /boom/);

  const byId = Object.fromEntries(record.results.map((r) => [r.nodeId, r]));
  assert.equal(byId.a.status, "failed");
  // 当前语义是「失败即中止」：下游节点不产生结果记录（而不是标记为 skipped）
  assert.equal(byId.b, undefined);
  assert.equal(record.results.length, 1);
});

test("onError=continue：失败不中断，其余分支跑完，整体仍记 failed", async () => {
  const wf: Workflow = {
    ...base,
    name: "容错",
    nodes: [
      {
        id: "boom",
        type: "code",
        params: { code: "throw new Error('x');", onError: "continue" },
      },
      { id: "after", type: "code", params: { code: "return 'down';" } },
      { id: "other", type: "code", params: { code: "return 'independent';" } },
    ],
    edges: [{ from: "boom", to: "after" }],
  };

  const record = await executeWorkflow({ workflow: wf });
  const byId = Object.fromEntries(record.results.map((r) => [r.nodeId, r]));

  assert.equal(byId.boom.status, "failed");
  // 失败节点没有有效输出，其下游不激活 → skipped
  assert.equal(byId.after.status, "skipped");
  // 独立起点不受影响，照常执行
  assert.equal(byId.other.status, "success");
  assert.equal(byId.other.output, "independent");
  // 流程跑完了，但有过失败，整体仍记为 failed
  assert.equal(record.status, "failed");
  assert.equal(record.results.length, 3);
});

test("环检测：存在循环依赖时抛错", async () => {
  const wf: Workflow = {
    ...base,
    name: "成环",
    nodes: [
      { id: "a", type: "code", params: { code: "return 1;" } },
      { id: "b", type: "code", params: { code: "return 2;" } },
    ],
    edges: [
      { from: "a", to: "b" },
      { from: "b", to: "a" },
    ],
  };

  await assert.rejects(() => executeWorkflow({ workflow: wf }), /循环依赖/);
});

test("payload：无上游的起始节点直接拿到触发载荷", async () => {
  const wf: Workflow = {
    ...base,
    name: "载荷",
    nodes: [{ id: "a", type: "code", params: { code: "return $json;" } }],
    edges: [],
  };

  const record = await executeWorkflow({ workflow: wf, payload: { x: 42 } });
  assert.equal(record.status, "success");
  assert.deepEqual(plain(record.results[0].output), { x: 42 });
});

test("未知节点类型：报错而不是静默通过", async () => {
  const wf = {
    ...base,
    name: "未知节点",
    nodes: [{ id: "a", type: "not_a_node" as never, params: {} }],
    edges: [],
  } as unknown as Workflow;

  const record = await executeWorkflow({ workflow: wf });
  assert.equal(record.status, "failed");
});
