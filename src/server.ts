import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import type { TaskManager } from "./task-manager";

export type TaskServerOptions = {
  /** API route prefix. Defaults to "/api". */
  prefix?: string;
  /** Enable CORS on all API routes. Defaults to true. */
  cors?: boolean;
};

/**
 * Build a Hono app with task management routes mounted under `prefix`.
 * Mount it into your own app or pass `app.fetch` to `@hono/node-server`'s serve().
 */
export function createTaskServer(tm: TaskManager, options: TaskServerOptions = {}): Hono {
  const prefix = options.prefix ?? "/api";
  const enableCors = options.cors ?? true;

  const app = new Hono();

  if (enableCors) {
    app.use(`${prefix}/*`, cors());
  }

  app.get(`${prefix}/tasks`, (c) => c.json({ ok: true, tasks: tm.list() }));

  app.get(`${prefix}/task/logs/history`, (c) => {
    const id = c.req.query("id") ?? "";
    if (!tm.status(id)) return c.json({ ok: false, error: `任务不存在: ${id}` }, 404);
    const since = Number(c.req.query("since") ?? 0);
    return c.json({ ok: true, logs: tm.getLogs(id, since) });
  });

  app.get(`${prefix}/task/logs`, (c) => {
    const id = c.req.query("id") ?? "";
    if (!tm.status(id)) return c.json({ ok: false, error: `任务不存在: ${id}` }, 404);

    return streamSSE(c, async (stream) => {
      let chain: Promise<void> = Promise.resolve();
      const write = (entry: { event: string; data: string }) => {
        chain = chain.then(() => stream.writeSSE(entry)).catch(() => {});
        return chain;
      };

      let aborted = false;
      const unsubscribe = tm.subscribeLogs(id, (entry) => {
        write({ event: "log", data: JSON.stringify(entry) });
      });
      stream.onAbort(() => {
        aborted = true;
        unsubscribe();
      });

      while (!aborted) {
        await stream.sleep(15000);
        if (aborted) break;
        write({ event: "ping", data: "" });
      }
    });
  });

  app.all(`${prefix}/task`, async (c) => {
    const query = c.req.query();
    const body: Record<string, unknown> =
      c.req.method === "POST"
        ? await c.req.json<Record<string, unknown>>().catch(() => ({}))
        : {};

    const action = String(body.action ?? query.action ?? "").toLowerCase();
    const id = String(body.id ?? query.id ?? "");

    try {
      switch (action) {
        case "status": {
          const status = tm.status(id);
          if (!status) return c.json({ ok: false, error: `任务不存在: ${id}` }, 404);
          return c.json({ ok: true, status });
        }
        case "start": {
          const result = tm.start(id);
          return c.json({ ok: true, ...result, status: tm.status(id) });
        }
        case "stop": {
          const result = tm.stop(id);
          return c.json({ ok: true, ...result, status: tm.status(id) });
        }
        default:
          return c.json(
            {
              ok: false,
              error: "缺少或不支持的 action",
              usage: { list: `GET ${prefix}/tasks`, task: `${prefix}/task?action=status|start|stop&id=<id>` },
            },
            400,
          );
      }
    } catch (err) {
      return c.json({ ok: false, error: (err as Error).message }, 404);
    }
  });

  return app;
}
