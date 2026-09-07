import "dotenv/config";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { WorkflowSchema } from "./engine/types.js";
import { createServer } from "./server.js";
import { Scheduler } from "./scheduler.js";
import { Store } from "./store/db.js";

const here = dirname(fileURLToPath(import.meta.url));
const rootDir = join(here, "..");

/** 首次启动时把 examples/ 下的工作流导入数据库 */
function seedExamples(store: Store): number {
  const dir = join(rootDir, "examples");
  if (!existsSync(dir)) return 0;

  const existing = new Set(store.listWorkflows().map((w) => w.name));
  let count = 0;

  for (const file of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    try {
      const raw = JSON.parse(readFileSync(join(dir, file), "utf8"));
      const parsed = WorkflowSchema.safeParse(raw);
      if (!parsed.success) {
        console.warn(`[seed] 跳过 ${file}：格式不符合工作流定义`);
        continue;
      }
      if (existing.has(parsed.data.name)) continue;
      store.createWorkflow(parsed.data);
      count++;
    } catch (err) {
      console.warn(`[seed] 跳过 ${file}：${(err as Error).message}`);
    }
  }
  return count;
}

async function main(): Promise<void> {
  const dbFile = process.env.MINIFLOW_DB ?? join(rootDir, "data", "miniflow.db");
  const store = new Store(dbFile);
  const seeded = seedExamples(store);

  const scheduler = new Scheduler(store);
  const app = await createServer({
    store,
    onWorkflowsChanged: () => {
      console.log(`[scheduler] 已加载 ${scheduler.resync()} 个定时任务`);
    },
  });
  const jobCount = scheduler.resync();

  const port = Number(process.env.PORT ?? 3000);
  const host = process.env.HOST ?? "127.0.0.1";

  await app.listen({ port, host });

  const workflowCount = store.listWorkflows().length;
  const baseURL = process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";
  const hasKey = Boolean(process.env.OPENAI_API_KEY);

  console.log("");
  console.log("  MiniFlow 已启动");
  console.log(`  ├─ 控制台    http://${host}:${port}`);
  console.log(`  ├─ 健康检查  http://${host}:${port}/api/health`);
  console.log(`  ├─ 工作流    ${workflowCount} 个${seeded ? `（新导入 ${seeded} 个示例）` : ""}`);
  console.log(`  ├─ 定时任务  ${jobCount} 个`);
  console.log(`  └─ 模型服务  ${baseURL}（密钥${hasKey ? "已配置" : "未配置"}）`);
  console.log("");
  if (!hasKey) {
    console.log("  提示：未检测到 OPENAI_API_KEY，LLM / Agent 节点会报错。");
    console.log("        复制 .env.example 为 .env 并填入密钥后重启即可。");
    console.log("");
  }

  const shutdown = async (): Promise<void> => {
    scheduler.stop();
    await app.close();
    store.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("启动失败：", err);
  process.exit(1);
});
