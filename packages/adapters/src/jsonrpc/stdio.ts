/**
 * Minimal JSON-RPC 2.0 client over NDJSON stdio.
 *
 * Codex app-server omits the `"jsonrpc":"2.0"` field on the wire (MCP-style).
 * This client never requires it on inbound frames and never writes it unless
 * `includeJsonrpc` is set.
 */

import { terminateSubprocess } from "@divisio/shared/spawn";

export type JsonRpcId = string | number;

export interface JsonRpcRequest {
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  method: string;
  params?: unknown;
}

export interface JsonRpcSuccess {
  id: JsonRpcId;
  result: unknown;
}

export interface JsonRpcFailure {
  id: JsonRpcId;
  error: { code: number; message: string; data?: unknown };
}

export type JsonRpcInbound =
  | { kind: "notification"; method: string; params: unknown }
  | { kind: "request"; id: JsonRpcId; method: string; params: unknown }
  | { kind: "response"; id: JsonRpcId; result: unknown }
  | { kind: "error"; id: JsonRpcId; error: { code: number; message: string; data?: unknown } };

export type JsonRpcHandler = (msg: JsonRpcInbound) => void;

export interface JsonRpcStdioOptions {
  /** Include `"jsonrpc":"2.0"` on outbound frames. Default false (Codex). */
  includeJsonrpc?: boolean;
  onMessage: JsonRpcHandler;
  onClose?: (code: number | null, signal: string | null) => void;
  onStderr?: (chunk: string) => void;
}

export class JsonRpcStdioClient {
  private nextId = 1;
  private readonly pending = new Map<
    string,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private buffer = "";
  private closed = false;
  private readonly includeJsonrpc: boolean;
  private readonly proc: Bun.Subprocess<"pipe", "pipe", "pipe">;

  constructor(
    cmd: string[],
    private readonly options: JsonRpcStdioOptions & { cwd?: string; env?: NodeJS.ProcessEnv },
  ) {
    this.includeJsonrpc = options.includeJsonrpc ?? false;
    this.proc = Bun.spawn({
      cmd,
      cwd: options.cwd,
      // Always explicit: PATH repair does not apply to an inherited environ.
      env: { ...(process.env as Record<string, string>), ...(options.env ?? {}) },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    void this.readStdout();
    void this.readStderr();
    void this.watchExit();
  }

  /** Send a request and wait for the matching response. */
  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (this.closed) return Promise.reject(new Error("json-rpc client closed"));
    const id = this.nextId++;
    const key = String(id);
    const frame: Record<string, unknown> = { id, method };
    if (params !== undefined) frame.params = params;
    if (this.includeJsonrpc) frame.jsonrpc = "2.0";

    return new Promise<T>((resolve, reject) => {
      this.pending.set(key, {
        resolve: (v) => resolve(v as T),
        reject,
      });
      this.write(frame).catch((err) => {
        this.pending.delete(key);
        reject(err instanceof Error ? err : new Error(String(err)));
      });
    });
  }

  /** Fire-and-forget notification (no id). */
  async notify(method: string, params?: unknown): Promise<void> {
    const frame: Record<string, unknown> = { method };
    if (params !== undefined) frame.params = params;
    if (this.includeJsonrpc) frame.jsonrpc = "2.0";
    await this.write(frame);
  }

  /** Respond to a server-initiated request. */
  async respond(id: JsonRpcId, result: unknown): Promise<void> {
    const frame: Record<string, unknown> = { id, result };
    if (this.includeJsonrpc) frame.jsonrpc = "2.0";
    await this.write(frame);
  }

  async respondError(id: JsonRpcId, code: number, message: string): Promise<void> {
    const frame: Record<string, unknown> = { id, error: { code, message } };
    if (this.includeJsonrpc) frame.jsonrpc = "2.0";
    await this.write(frame);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      this.proc.stdin.end();
    } catch {
      /* ignore */
    }
    await terminateSubprocess(this.proc);
    this.rejectAll(new Error("json-rpc client closed"));
  }

  private async write(frame: Record<string, unknown>): Promise<void> {
    const line = JSON.stringify(frame) + "\n";
    const writer = this.proc.stdin;
    writer.write(line);
    await writer.flush();
  }

  private async readStdout(): Promise<void> {
    const reader = this.proc.stdout.getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        this.buffer += decoder.decode(value, { stream: true });
        const lines = this.buffer.split("\n");
        this.buffer = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          this.dispatchLine(trimmed);
        }
      }
    } catch {
      /* process died */
    }
  }

  private async readStderr(): Promise<void> {
    if (!this.options.onStderr) return;
    const reader = this.proc.stderr.getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        this.options.onStderr(decoder.decode(value));
      }
    } catch {
      /* ignore */
    }
  }

  private async watchExit(): Promise<void> {
    const code = await this.proc.exited;
    this.closed = true;
    this.rejectAll(new Error(`process exited ${code}`));
    this.options.onClose?.(code, null);
  }

  private dispatchLine(line: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }

    const id = msg["id"];
    const method = msg["method"];

    if (typeof method === "string" && id !== undefined && id !== null) {
      this.options.onMessage({
        kind: "request",
        id: id as JsonRpcId,
        method,
        params: msg["params"],
      });
      return;
    }

    if (typeof method === "string") {
      this.options.onMessage({
        kind: "notification",
        method,
        params: msg["params"],
      });
      return;
    }

    if (id !== undefined && id !== null && "result" in msg) {
      const key = String(id);
      const pending = this.pending.get(key);
      if (pending) {
        this.pending.delete(key);
        pending.resolve(msg["result"]);
      } else {
        this.options.onMessage({ kind: "response", id: id as JsonRpcId, result: msg["result"] });
      }
      return;
    }

    if (id !== undefined && id !== null && "error" in msg) {
      const key = String(id);
      const pending = this.pending.get(key);
      const errObj = msg["error"] as { code?: number; message?: string; data?: unknown };
      const error = {
        code: typeof errObj?.code === "number" ? errObj.code : -1,
        message: typeof errObj?.message === "string" ? errObj.message : "rpc error",
        data: errObj?.data,
      };
      if (pending) {
        this.pending.delete(key);
        pending.reject(new Error(error.message));
      } else {
        this.options.onMessage({ kind: "error", id: id as JsonRpcId, error });
      }
    }
  }

  private rejectAll(err: Error): void {
    for (const [, p] of this.pending) p.reject(err);
    this.pending.clear();
  }
}
