import { readFile, access } from "node:fs/promises";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { serve as honoServe } from "@hono/node-server";
import { TaskManager } from "./task-manager";
import { createTaskServer } from "./server";

export type ServeOptions = {
  port?: number;
  tasksDir?: string;
  prefix?: string;
  cors?: boolean;
};

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const PUBLIC_DIR = join(__dirname, "../dashboard");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js":   "application/javascript",
  ".css":  "text/css",
  ".svg":  "image/svg+xml",
  ".ico":  "image/x-icon",
  ".png":  "image/png",
  ".jpg":  "image/jpeg",
  ".woff2": "font/woff2",
};

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function serveStatic(pathname: string): Promise<Response> {
  const clean = pathname.split("?")[0];
  const candidates =
    clean === "/" || clean === ""
      ? [join(PUBLIC_DIR, "index.html")]
      : [join(PUBLIC_DIR, clean), join(PUBLIC_DIR, clean, "index.html")];

  for (const filePath of candidates) {
    if (await fileExists(filePath)) {
      const data = await readFile(filePath);
      return new Response(data, {
        headers: { "Content-Type": MIME[extname(filePath)] ?? "application/octet-stream" },
      });
    }
  }

  // SPA fallback
  const data = await readFile(join(PUBLIC_DIR, "index.html"));
  return new Response(data, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

export async function serve(options: ServeOptions = {}): Promise<void> {
  const { port = 3000, tasksDir, prefix = "/api", cors } = options;

  const tm = new TaskManager();
  if (tasksDir) await tm.loadTasks(tasksDir);

  const app = createTaskServer(tm, { prefix, cors });

  app.get("*", async (c) => {
    const { pathname } = new URL(c.req.url);
    return serveStatic(pathname);
  });

  function shutdown() {
    console.log("\n[server] 正在停止所有任务并退出…");
    tm.stopAll();
    process.exit(0);
  }
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  honoServe({ fetch: app.fetch, port });
  console.log(`[server] 正在监听端口 ${port}`);
}
