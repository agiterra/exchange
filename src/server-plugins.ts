/**
 * Server-plugin lifecycle bus — the generic, additive extension point that lets
 * a config-declared Wire *Server Plugin* (a long-lived sidecar enrolled as a
 * permanent integration agent, e.g. `wallet`) receive broker lifecycle events.
 *
 * This is NOT wallet-specific — wallet is merely its first consumer (it
 * subscribes to `agent_reaped` for delegation hygiene). Absent a `serverPlugins`
 * config entry, nothing is ever emitted: behavior is byte-identical to before,
 * so existing deployments carry zero risk.
 *
 * Events are delivered as an ordinary unicast Wire message from the server
 * identity (`wire`) to the plugin's reserved agent id, so they reuse routing,
 * SSE, replay, and federation with no new branch. The plugin authorizes off
 * the REVOKE-ONLY fail-safe direction (a spurious reap can only *remove* access,
 * never grant it) plus its own backstops — we do not claim the locally-delivered
 * frame is signature-verified by the plugin.
 *
 * See design-wallet-wire-server-plugin.md §3.1 / §3.3.
 */
import type { Logger } from "pino";
import type { Router } from "./router.js";
import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

export type ServerPluginEvent = {
  type: "agent_reaped";
  agent_id: string;
  pubkey: string;
  reason: "timeout" | "clean_disconnect";
  at: number;
};
// future event types (additive): agent_registered, agent_dependents_purged, server_start …

export interface ServerPluginConfig {
  /** Human label; conventionally equals the reserved agent id. */
  name: string;
  /** Reserved identity this plugin is enrolled as (permanent integration agent). */
  agentId: string;
  /** Generic event-type allow-list — only declared types are delivered. */
  events: string[];
}

export class ServerPluginBus {
  private log: Logger;
  constructor(
    private cfg: ServerPluginConfig[],
    private router: Router,
    log: Logger,
  ) {
    this.log = log.child({ component: "server-plugin-bus" });
  }

  /** True if any configured plugin subscribes to this event type (cheap pre-check). */
  hasSubscribers(type: ServerPluginEvent["type"]): boolean {
    return this.cfg.some((p) => p.events.includes(type));
  }

  /**
   * Emit a lifecycle event to every config-declared plugin that subscribes to
   * its type. Delivery is a normal unicast — no new routing branch, no SSE
   * change — and it federates for free if the plugin ever moves to a peer.
   *
   * Errors are logged and never swallowed (value #4), and never propagate to
   * the caller: a failed lifecycle emit must not break `softReapAgent` or any
   * other hot path that fires it.
   */
  emit(ev: ServerPluginEvent): void {
    for (const p of this.cfg) {
      if (!p.events.includes(ev.type)) continue;
      try {
        this.router.route({
          source: "wire", // server identity as the sender
          dest: p.agentId,
          topic: `server-plugin.lifecycle.${ev.type}`,
          payload: JSON.stringify(ev),
        });
      } catch (e) {
        this.log.error(
          { event: "server_plugin_emit_error", plugin: p.agentId, type: ev.type, err: e },
          "server-plugin lifecycle emit failed",
        );
      }
    }
  }
}

/**
 * Load the server-plugin allow-list (the §3.1 config block). Source precedence:
 *   1. WIRE_SERVER_PLUGINS env var — a JSON array — if set + non-empty.
 *   2. ~/.wire/server-plugins.json, if it exists.
 *   3. Otherwise empty → no plugins, no lifecycle emission (unchanged behavior).
 * Malformed config is logged and treated as empty: a bad config can never
 * silently grant a plugin events; it just gets none (fail-safe).
 */
export function loadServerPlugins(log?: Logger): ServerPluginConfig[] {
  const parse = (raw: string, src: string): ServerPluginConfig[] | null => {
    try {
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr)) throw new Error("serverPlugins config must be a JSON array");
      return arr
        .filter((p: { agentId?: string }) => p && p.agentId)
        .map((p: { name?: string; agentId: string; events?: unknown[] }) => ({
          name: String(p.name ?? p.agentId),
          agentId: String(p.agentId),
          events: Array.isArray(p.events) ? p.events.map(String) : [],
        }));
    } catch (e) {
      log?.error({ event: "server_plugins_config_error", src, err: e }, "invalid serverPlugins config — ignoring");
      return null;
    }
  };
  const env = (process.env.WIRE_SERVER_PLUGINS ?? "").trim();
  if (env) {
    const r = parse(env, "env:WIRE_SERVER_PLUGINS");
    if (r) return r;
  }
  const file = join(homedir(), ".wire", "server-plugins.json");
  if (existsSync(file)) {
    const r = parse(readFileSync(file, "utf8"), file);
    if (r) return r;
  }
  return [];
}
