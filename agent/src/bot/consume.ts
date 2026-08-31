/**
 * 飞书事件消费：`lark-cli event consume <key>` 子进程流式 NDJSON。
 * - 阻塞 stderr 直到 ready 标记再开始读 stdout
 * - 手动按 \n 切行（协议要求）
 * - 停止 = 关闭子进程 stdin（优雅退出，避免服务端订阅泄漏）
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export interface ConsumerHandle {
  key: string;
  stop(): void;
}

export function consumeEvent(
  key: string,
  as: "bot" | "user",
  onEvent: (e: any) => void,
  env: Record<string, string>,
): Promise<ConsumerHandle> {
  return new Promise((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(process.env.LARK_CLI_BIN || "lark-cli", ["event", "consume", key, "--as", as], {
        env: { ...process.env, ...env },
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (e: any) {
      reject(e);
      return;
    }

    let ready = false;
    let outBuf = "";
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
      process.stderr.write(`[event:${key}] ${s}`);
      if (!ready && s.includes(readyMark)) {
        clearTimeout(failTimer);
        ready = true;
        resolve({
          key,
          stop() {
            try {
              child.stdin.end();
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
        reject(e);
      }
    });

    child.on("exit", (code) => {
      if (!ready) {
        clearTimeout(failTimer);
        reject(new Error(`事件订阅 ${key} 提前退出 code=${code}`));
      } else {
        process.stderr.write(`[event:${key}] 已退出 code=${code}\n`);
      }
    });
  });
}
