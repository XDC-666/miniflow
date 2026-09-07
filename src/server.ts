import Fastify, { type FastifyInstance } from "fastify";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { WorkflowSchema } from "./engine/types.js";
import { listNodes } from "./nodes/index.js";
import { startRun } from "./runner.js";
import type { Store } from "./store/db.js";

const here = dirname(fileURLToPath(import.meta.url));
const UI_PATH = join(here, "..", "web", "index.html");

export interface ServerOptions {
  store: Store;
  /** 工作流增删改后触发，用于刷新定时任务 */
  onWorkflowsChanged?: () => void;
}

function bad(reply: any, message: string, code = 400) {
  return reply.code(code).send({ error: message });
}

export async function createServer(opts: ServerOptions): Promise<FastifyInstance> {
  const { store, onWorkflowsChanged } = opts;
  const app = Fastify({ logger: false, bodyLimit: 2 * 1024 * 1024 });

  if (process.env.MINIFLOW_CORS === "1") {
    app.addHook("onRequest", async (req, reply) => {
      reply.header("access-control-allow-origin", "*");
      reply.header("access-control-allow-headers", "content-type,authorization");
      reply.header("access-control-allow-methods", "GET,POST,PUT,DELETE,OPTIONS");
      if (req.method === "OPTIONS") return reply.code(204).send();
    });
  }

  app.get("/api/health", async () => ({
    status: "ok",
    time: new Date().toISOString(),
    safeMode: process.env.MINIFLOW_SAFE_MODE === "1",
  }));

  // ---------- 节点能力清单（供 UI 和文档使用）----------
  app.get("/api/nodes", async () => ({
    nodes: listNodes().map((n) => ({
      type: n.type,
      label: n.label,
      description: n.description,
      example: n.example,
    })),
  }));

  // ---------- 工作流 CRUD ----------
  app.get("/api/workflows", async () => ({ workflows: store.listWorkflows() }));

  app.get("/api/workflows/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const wf = store.getWorkflow(id);
    return wf ? { workflow: wf } : bad(reply, "工作流不存在", 404);
  });

  app.post("/api/workflows", async (req, reply) => {
    const parsed = WorkflowSchema.safeParse(req.body);
    if (!parsed.success) {
      return bad(reply, parsed.error.issues.map((i) => i.message).join("; "));
    }
    const created = store.createWorkflow(parsed.data);
    onWorkflowsChanged?.();
    return reply.code(201).send({ workflow: created });
  });

  app.put("/api/workflows/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = WorkflowSchema.safeParse(req.body);
    if (!parsed.success) {
      return bad(reply, parsed.error.issues.map((i) => i.message).join("; "));
    }
    const updated = store.updateWorkflow(id, parsed.data);
    if (!updated) return bad(reply, "工作流不存在", 404);
    onWorkflowsChanged?.();
    return { workflow: updated };
  });

  app.delete("/api/workflows/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const ok = store.deleteWorkflow(id);
    if (!ok) return bad(reply, "工作流不存在", 404);
    onWorkflowsChanged?.();
    return { deleted: true };
  });

  // ---------- 运行 ----------
  app.post("/api/workflows/:id/run", async (req, reply) => {
    const { id } = req.params as { id: string };
    const wf = store.getWorkflow(id);
    if (!wf) return bad(reply, "工作流不存在", 404);

    const body = (req.body ?? {}) as { payload?: unknown; wait?: boolean };
    const query = req.query as { wait?: string };
    const wait = body.wait === true || query.wait === "1";

    const started = startRun(store, wf, "manual", body.payload ?? null);
    if (!wait) return reply.code(202).send({ runId: started.runId, status: "running" });

    const record = await started.done;
    return reply.code(record.status === "failed" ? 500 : 200).send({ run: record });
  });

  app.get("/api/runs", async (req) => {
    const { workflowId, limit } = req.query as { workflowId?: string; limit?: string };
    return { runs: store.listRuns(workflowId, Number(limit) || 50) };
  });

  app.get("/api/runs/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const run = store.getRun(id);
    return run ? { run } : bad(reply, "运行记录不存在", 404);
  });

  // ---------- Webhook 触发 ----------
  app.all("/api/webhook/:path", async (req, reply) => {
    const { path } = req.params as { path: string };
    const wf = store
      .listWorkflows()
      .find((w) => w.enabled && w.trigger.type === "webhook" && w.trigger.path === path);
    if (!wf) return bad(reply, `没有匹配路径 "${path}" 的 webhook 工作流`, 404);

    const payload = {
      method: req.method,
      headers: req.headers,
      query: req.query,
      body: req.body ?? null,
    };

    const started = startRun(store, wf, "webhook", payload);
    const record = await started.done;
    return reply.code(record.status === "failed" ? 500 : 200).send({ run: record });
  });

  // ---------- 简易 UI ----------
  app.get("/", async (_req, reply) => {
    try {
      return reply.type("text/html").send(readFileSync(UI_PATH, "utf8"));
    } catch {
      return reply
        .type("text/plain")
        .send("MiniFlow 已启动。UI 文件缺失，请使用 REST API：GET /api/workflows");
    }
  });

  return app;
}
