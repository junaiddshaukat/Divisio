/**
 * Shared plumbing for adapters that can run over the agent protocol.
 *
 * Several CLIs expose both a print mode and a protocol mode. The protocol mode
 * is strictly better — one warm process per thread, and real tool approvals —
 * but it is not always present, so every such adapter needs the same three
 * things: resolve which transport is available, report capabilities that match
 * the transport actually in use, and open a protocol session with resume.
 *
 * Keeping that here means a new protocol-capable provider costs an argv.
 */

import type { AdapterCapabilities, EmitRuntimeEvent } from "@divisio/contracts";
import { logger } from "@divisio/shared/log";
import { cachedAcpSupport, probeAcpSupport, refreshAcpSupport } from "./probe.ts";
import { AcpSession } from "./session.ts";

const log = logger("adapter:acp");

export class AcpTransport {
  /** Null until resolved. Null is treated as "not proven", never as "yes". */
  private supported: boolean | null = null;

  /**
   * Set once this agent has actually asked permission for a tool call.
   *
   * Approvals are claimed from evidence rather than from the transport. The
   * protocol carries a permission request and this client answers one
   * correctly, but whether an agent *sends* one is that agent's own policy —
   * at least one speaks the protocol and still runs its tools without asking.
   * Claiming supervision for such an agent is the most dangerous kind of
   * wrong, because the user believes they are supervising something they are
   * not. Until an agent has asked once, we say we cannot mediate.
   *
   * The approve/deny bar does not depend on this: it appears whenever a real
   * request is pending, so the first one is answerable like any other.
   */
  private mediationObserved = false;

  constructor(private readonly cmd: string[]) {}

  get isSupported(): boolean | null {
    return this.supported;
  }

  /** Structured only once the protocol transport is proven. */
  get tier(): "structured" | "stream" {
    return this.supported === true ? "structured" : "stream";
  }

  /**
   * Capabilities for the transport actually in use.
   *
   * `approvals` is the whole point of the distinction: the print fallback
   * cannot mediate a tool call, and a UI control that decides nothing is worse
   * than an absent one.
   */
  capabilities(base: AdapterCapabilities): AdapterCapabilities {
    return { ...base, approvals: this.supported === true && this.mediationObserved };
  }

  /**
   * Called from `detect()`, which runs across every adapter each time the UI
   * loads and must not block. A signed-in agent can take seconds to answer, so
   * report what is known and let the probe settle in the background.
   */
  noteDetect(): void {
    // Only ever upgrade from unknown: a live session already proved what this
    // transport can do, and a cache expiry must not drop it back to null.
    if (this.supported === null) this.supported = cachedAcpSupport(this.cmd);
    refreshAcpSupport(this.cmd);
  }

  /**
   * Open a protocol session, or return null to use the adapter's fallback.
   *
   * A successful handshake IS the probe, so this never runs a separate one —
   * that would pay the agent's startup cost twice, which is the dominant part
   * of opening a thread.
   */
  async open(input: {
    cwd: string;
    emit: EmitRuntimeEvent;
    resumeId: string | null;
    threadId: string;
    onExit(session: AcpSession): void;
  }): Promise<{ session: AcpSession; nativeId: string } | null> {
    if (this.supported === false) return null;

    const session = new AcpSession({
      cmd: this.cmd,
      cwd: input.cwd,
      emit: input.emit,
      onExit: () => input.onExit(session),
      onMediationObserved: () => {
        this.mediationObserved = true;
      },
    });

    try {
      const init = await session.start();

      if (input.resumeId && init.agentCapabilities?.loadSession) {
        try {
          await session.loadConversation(input.resumeId);
          this.supported = true;
          return { session, nativeId: input.resumeId };
        } catch (err) {
          // A stale id must not cost the user their ability to send.
          log.info("resume failed, starting a fresh conversation", { detail: String(err) });
        }
      }

      const nativeId = await session.openConversation();
      this.supported = true;
      return { session, nativeId };
    } catch (err) {
      log.warn("protocol transport unavailable, using fallback", {
        threadId: input.threadId,
        detail: String(err),
      });
      this.supported = false;
      await session.close().catch(() => undefined);
      return null;
    }
  }

  /** Resolve support without opening a session. For tests and diagnostics. */
  async probe(cwd?: string): Promise<boolean> {
    this.supported = await probeAcpSupport(this.cmd, cwd);
    return this.supported;
  }
}
