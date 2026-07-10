import { readdir } from "node:fs/promises";
import { join } from "node:path";

export type LogLevel = "INFO" | "WARN" | "ERROR";

export type LogEntry = {
  seq: number;
  time: string;
  level: LogLevel;
  message: string;
};

export type TaskContext = {
  taskId: string;
  log: (message: string, level?: LogLevel) => void;
};

export type TaskDefinition = {
  id: string;
  name: string;
  description?: string;
  /** Loop interval in milliseconds. Defaults to 3000ms. -1 = run once then stop. */
  intervalMs?: number;
  /** Auto-start when loadTasks() registers this task. Defaults to false. */
  autoStart?: boolean;
  onStart?: (ctx: TaskContext) => void;
  tick: (ctx: TaskContext) => void | Promise<void>;
  onStop?: (ctx: TaskContext) => void;
};

type RunningState = {
  timer: ReturnType<typeof setInterval> | undefined;
  startedAt: Date;
  ticks: number;
};

export type TaskStatus = {
  id: string;
  name: string;
  description: string;
  intervalMs: number;
  autoStart: boolean;
  status: "running" | "stopped";
  startedAt: string | null;
  ticks: number;
};

const DEFAULT_INTERVAL = 3000;
const LOG_CAP = 500;

export class TaskManager {
  private registry = new Map<string, TaskDefinition>();
  private running = new Map<string, RunningState>();
  private logs = new Map<string, LogEntry[]>();
  private logSeq = new Map<string, number>();
  private logSubs = new Map<string, Set<(entry: LogEntry) => void>>();

  private appendLog(id: string, message: string, level: LogLevel): void {
    const seq = (this.logSeq.get(id) ?? 0) + 1;
    this.logSeq.set(id, seq);
    const entry: LogEntry = { seq, time: new Date().toISOString(), level, message };

    const buffer = this.logs.get(id) ?? [];
    buffer.push(entry);
    if (buffer.length > LOG_CAP) buffer.splice(0, buffer.length - LOG_CAP);
    this.logs.set(id, buffer);

    const subs = this.logSubs.get(id);
    if (subs) for (const fn of subs) fn(entry);

    console.log(`[${id}] ${message}`);
  }

  getLogs(id: string, since = 0): LogEntry[] {
    return (this.logs.get(id) ?? []).filter((e) => e.seq > since);
  }

  subscribeLogs(id: string, listener: (entry: LogEntry) => void): () => void {
    const set = this.logSubs.get(id) ?? new Set();
    set.add(listener);
    this.logSubs.set(id, set);
    return () => set.delete(listener);
  }

  /** Register a single task definition. */
  register(def: TaskDefinition): void {
    if (!def.id || typeof def.tick !== "function") {
      console.warn(`[task-manager] 跳过无效任务: ${def.id}`);
      return;
    }
    if (this.registry.has(def.id)) {
      console.warn(`[task-manager] 任务 id 重复，已忽略: ${def.id}`);
      return;
    }
    this.registry.set(def.id, def);
    console.log(`[task-manager] 已注册任务: ${def.id} (${def.name})`);
    if (def.autoStart) {
      this.start(def.id);
      console.log(`[task-manager] 自动启动任务: ${def.id}`);
    }
  }

  /** Discover and register every *.task.ts|js file in a folder. */
  async loadTasks(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    const files = entries
      .filter(e => e.isFile() && /\.task\.(ts|js)$/.test(e.name))
      .map(e => join(dir, e.name));
    for (const file of files) {
      try {
        const mod = (await import(file)) as { default?: TaskDefinition };
        const def = mod.default;
        if (!def) {
          console.warn(`[task-manager] 跳过无效任务文件: ${file}`);
          continue;
        }
        this.register(def);
      } catch (err) {
        console.error(`[task-manager] 加载任务文件失败: ${file}`, err);
      }
    }
    console.log(`[task-manager] 共加载 ${this.registry.size} 个任务`);
  }

  private makeContext(id: string): TaskContext {
    return {
      taskId: id,
      log: (message, level = "INFO") => this.appendLog(id, message, level),
    };
  }

  start(id: string): { started: boolean; reason?: string } {
    const def = this.registry.get(id);
    if (!def) throw new Error(`任务不存在: ${id}`);
    if (this.running.has(id)) return { started: false, reason: "already-running" };

    const ctx = this.makeContext(id);
    const interval = def.intervalMs ?? DEFAULT_INTERVAL;
    const state: RunningState = { timer: undefined, startedAt: new Date(), ticks: 0 };

    const runTick = async () => {
      state.ticks += 1;
      try {
        await def.tick(ctx);
      } catch (err) {
        console.error(`[${id}] tick 执行出错`, err);
      }
    };

    def.onStart?.(ctx);
    this.running.set(id, state);

    if (interval === -1) {
      runTick().then(() => this.stop(id));
    } else {
      runTick();
      state.timer = setInterval(runTick, interval);
    }

    return { started: true };
  }

  stop(id: string): { stopped: boolean; reason?: string } {
    const def = this.registry.get(id);
    if (!def) throw new Error(`任务不存在: ${id}`);
    const state = this.running.get(id);
    if (!state) return { stopped: false, reason: "not-running" };

    if (state.timer !== undefined) clearInterval(state.timer);
    this.running.delete(id);
    def.onStop?.(this.makeContext(id));
    return { stopped: true };
  }

  status(id: string): TaskStatus | null {
    const def = this.registry.get(id);
    if (!def) return null;
    const state = this.running.get(id);
    return {
      id: def.id,
      name: def.name,
      description: def.description ?? "",
      intervalMs: def.intervalMs ?? DEFAULT_INTERVAL,
      autoStart: def.autoStart ?? false,
      status: state ? "running" : "stopped",
      startedAt: state ? state.startedAt.toISOString() : null,
      ticks: state ? state.ticks : 0,
    };
  }

  list(): TaskStatus[] {
    return [...this.registry.keys()].map((id) => this.status(id)!);
  }

  stopAll(): void {
    for (const id of [...this.running.keys()]) this.stop(id);
  }
}
