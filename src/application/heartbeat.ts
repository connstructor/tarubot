/**
 * An outside dead-man's switch (2.22.0; the owner's 2026-09-25 decision to make the production host
 * robust and disposable). While the bot is fully ready it pings a healthchecks.io check, whose URL
 * is HEALTHCHECKS_PING_URL. When the pings stop, healthchecks.io alerts the owner: the host is down,
 * the container is gone, the process hangs, or the bot has been unready for longer than the check's
 * grace period. That covers what the issue reporter can't, since the reporter runs inside the bot.
 *
 * It never sends a failure ping: a brief loss of readiness, such as a Discord reconnect, falls
 * within the check's grace period instead of alerting. Pings carry a one-line status summary for
 * the check's event log, never secrets, and never affect readiness or the bot's work.
 */
import { project } from "../config/project.js";

/** How often a ready bot pings; the check's period in healthchecks.io matches it. */
export const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000;
/** A failed ping is retried this much sooner, so one network blip doesn't use up the grace. */
export const HEARTBEAT_RETRY_MS = 60 * 1000;
/** One ping's deadline; a slow healthchecks.io never holds up the scheduler pass it runs in. */
const PING_TIMEOUT_MS = 5000;

/** The readiness fields the heartbeat reads (ApplicationLifecycle.status()). */
export interface HeartbeatStatus {
  readonly ready: boolean;
  readonly capabilities?: unknown;
  readonly lodestone?: {
    readonly cooldownSeconds: number;
    readonly selectors: { readonly revision: string; readonly source: string };
  };
}

/** Structured log output, as the composition root's logger provides it. */
export type HeartbeatLog = (
  level: "info" | "warn",
  fields: Record<string, unknown>,
  message: string,
) => void;

/** The one-line summary each ping carries: version, work state and the Lodestone. */
export function heartbeatSummary(environment: string, status: HeartbeatStatus): string {
  const metrics = (status.capabilities ?? {}) as Record<string, unknown>;
  const lodestone = status.lodestone;
  return [
    `TaruBot ${project.version} (${environment}) ready`,
    `pending ${metrics.pending ?? "?"}, blocked ${metrics.blocked ?? "?"}`,
    `degraded FCs ${metrics.degraded_fcs ?? "?"}`,
    lodestone
      ? `Lodestone cooldown ${lodestone.cooldownSeconds} s, selectors ${lodestone.selectors.revision.slice(0, 7)} (${lodestone.selectors.source})`
      : "Lodestone state unknown",
  ].join("; ");
}

export class Heartbeat {
  private status: () => HeartbeatStatus = () => ({ ready: false });
  /** When the next ping is due; the first comes on the first tick after the bot is ready. */
  private nextAt = 0;
  /** Whether the last attempt failed, so a failure streak logs once and its end once. */
  private failing = false;

  constructor(
    private readonly url: string,
    private readonly environment: string,
    private readonly log: HeartbeatLog = () => {},
    private readonly fetcher: (url: string, init: RequestInit) => Promise<Response> = fetch,
    private readonly clock: () => number = () => Date.now(),
  ) {}

  /** Whether a check URL is configured; empty turns the heartbeat off (DevBot, CI). */
  get enabled(): boolean {
    return this.url !== "";
  }

  /** The lifecycle's readiness, once the lifecycle exists (it is built after the heartbeat). */
  useStatus(status: () => HeartbeatStatus): void {
    this.status = status;
  }

  /**
   * Ping if one is due and the bot is ready. Called on every scheduler pass (30 s); never throws.
   * A success schedules the next ping HEARTBEAT_INTERVAL_MS later, a failure HEARTBEAT_RETRY_MS.
   */
  async tick(): Promise<void> {
    if (!this.enabled) return;
    const now = this.clock();
    if (now < this.nextAt) return;
    const status = this.status();
    // Silence, not a failure ping: the check's grace period decides when unreadiness alerts.
    if (!status.ready) return;
    // Claimed before the request, so an overlapping pass can't ping twice.
    this.nextAt = now + HEARTBEAT_RETRY_MS;
    try {
      const response = await this.fetcher(this.url, {
        method: "POST",
        headers: { "content-type": "text/plain", "user-agent": "TaruBot-heartbeat" },
        body: heartbeatSummary(this.environment, status),
        signal: AbortSignal.timeout(PING_TIMEOUT_MS),
      });
      await response.body?.cancel().catch(() => {});
      if (!response.ok) {
        this.failed(`HTTP ${response.status}`);
        return;
      }
      this.nextAt = now + HEARTBEAT_INTERVAL_MS;
      if (this.failing) this.log("info", {}, "Heartbeat pings are reaching healthchecks.io again");
      this.failing = false;
    } catch (error) {
      // A timeout, a network failure or a refused connection.
      this.failed(error instanceof Error ? error.name : "unknown");
    }
  }

  /** Log the start of a failure streak once. The URL is a credential of sorts: only the reason. */
  private failed(reason: string): void {
    if (!this.failing) this.log("warn", { reason }, "Heartbeat ping failed; retrying every minute");
    this.failing = true;
  }
}
