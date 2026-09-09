/**
 * 飞书事件消费：`lark-cli event consume <key>` 子进程流式 NDJSON。
 * - 阻塞 stderr 直到 ready 标记再开始读 stdout
 * - 手动按 \n 切行（协议要求）
 * - 停止 = 关闭子进程 stdin（优雅退出，避免服务端订阅泄漏）
 */
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { resolveLarkBin } from "../runtime.ts";

export interface ConsumerHandle {
  key: string;
  stop(): void;
}

/** consume 子进程 stderr 尾部缓存（reject 时附带，供冲突判定） */
const stderrTails = new WeakMap<Error, string>();
export function stderrOf(e: unknown): string {
  return (e instanceof Error && stderrTails.get(e)) || "";
}

export function consumeEvent(
  key: string,
  as: "bot" | "user",
  onEvent: (e: any) => void,
  env: Record<string, string>,
  onExit?: (code: number | null) => void,
): Promise<ConsumerHandle> {
  return new Promise((resolve, reject) => {
    let child: ChildProcessByStdio<null, Readable, Readable>;
    try {
      // 用 --timeout 使 consume 成为 bounded run（忽略 stdin EOF，常驻订阅），
      // 否则 unlimited 模式依赖 stdin keepalive，后台/守护进程下 stdin=/dev/null 会立即 EOF 退出。
      child = spawn(resolveLarkBin(), ["event", "consume", key, "--as", as, "--timeout", "6h"], {
        env: { ...process.env, ...env },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (e: any) {
      reject(e);
      return;
    }

    let ready = false;
    let outBuf = "";
    let errTail = "";
    const readyMark = `[event] ready event_key=${key}`;

    const failTimer = setTimeout(() => {
      if (!ready) {
        reject(new Error(`事件订阅 ${key} 启动超时`));
        try {
          child.kill("SIGTERM");
        } catch {
          /* ignore */
        }
      }
    }, 30_000);

    child.stderr.on("data", (d: Buffer) => {
      const s = String(d);
      errTail = (errTail + s).slice(-2000);
      process.stderr.write(`[event:${key}] ${s}`);
      if (!ready && s.includes(readyMark)) {
        clearTimeout(failTimer);
        ready = true;
        resolve({
          key,
          stop() {
            try {
              child.kill("SIGTERM");
            } catch {
              /* ignore */
            }
          },
        });
      }
    });

    child.stdout.on("data", (d: Buffer) => {
      if (!ready) return;
      outBuf += String(d);
      let idx: number;
      while ((idx = outBuf.indexOf("\n")) >= 0) {
        const line = outBuf.slice(0, idx).trim();
        outBuf = outBuf.slice(idx + 1);
        if (!line) continue;
        try {
          onEvent(JSON.parse(line));
        } catch {
          process.stderr.write(`[event:${key}] 无法解析事件行: ${line.slice(0, 200)}\n`);
        }
      }
    });

    child.on("error", (e: any) => {
      if (!ready) {
        clearTimeout(failTimer);
        stderrTails.set(e, errTail);
        reject(e);
      }
    });

    child.on("exit", (code) => {
      if (!ready) {
        clearTimeout(failTimer);
        const e = new Error(`事件订阅 ${key} 提前退出 code=${code}`);
        stderrTails.set(e, errTail);
        reject(e);
      } else {
        process.stderr.write(`[event:${key}] 已退出 code=${code}\n`);
        onExit?.(code);
      }
    });
  });
}
