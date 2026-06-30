/**
 * The Wire — entry point.
 *
 * Persistent multi-agent message broker, event log, and registry.
 */

import { join } from "path";
import { homedir } from "os";
import { readdirSync, readFileSync, unlinkSync } from "fs";
import { execFileSync } from "child_process";
import { config } from "dotenv";
import pino from "pino";

/**
 * Returns true if `pid` is a launchd-orphan (its parent is PID 1) or already
 * dead. Used by the session reaper to detect surviving bun MCP processes
 * whose Claude Code parent has exited — they keep heartbeating and would
 * otherwise pin a phantom session forever.
 */
function isOrphanOrDead(pid: number): boolean {
  try {
    const out = execFileSync("ps", ["-p", String(pid), "-o", "ppid="], {
      stdio: ["ignore", "pipe", "ignore"],
    }).toString().trim();
    if (!out) return true; // no row = dead
    return parseInt(out, 10) === 1;
  } catch {
    return true; // ps failed = dead
  }
}

// Load all Wire config from ~/.wire/.env
config({ path: join(homedir(), ".wire", ".env") });
import { Store } from "./store.js";
import { Router } from "./router.js";
import { MessageEmitter } from "./emitter.js";
import { ServerPluginBus, loadServerPlugins } from "./server-plugins.js";
import { createServer, runCleanup } from "./server.js";
import { HeartbeatScheduler } from "./heartbeat.js";
import { runCli } from "./cli.js";
import { loadOrCreateServerIdentity } from "./identity.js";

// CLI dispatch. Non-serve commands (peer add/list/remove/update-url,
// version, pubkey) exit here without starting the server. The -1
// sentinel means "continue into the normal server startup below."
const cliArgv = process.argv.slice(2);
const cliResult = await runCli(cliArgv);
if (cliResult.exit !== -1) {
  if (cliResult.stdout) process.stdout.write(cliResult.stdout);
  if (cliResult.stderr) process.stderr.write(cliResult.stderr);
  process.exit(cliResult.exit);
}

const port = parseInt(process.env.WIRE_PORT ?? "9800", 10);
const dbPath = process.env.WIRE_DB ?? `${process.env.HOME}/.wire/wire.db`;
// Heartbeat: 10s interval from clients. Stale after 20s, disconnected after 30s.
const staleMs = parseInt(process.env.STALE_MS ?? "20000", 10);
const disconnectMs = parseInt(process.env.DISCONNECT_MS ?? "30000", 10);
const reconcilerIntervalMs = parseInt(process.env.RECONCILER_INTERVAL_MS ?? "10000", 10);
// Lifecycle: two-phase reap. Identity stays permanent in both phases —
// agent rows are NEVER hard-deleted (per Tim's never-hard-delete directive,
// 2026-05-15).
//   reapGraceMs   — agent goes greyed-out after this long with no session
//                   heartbeat (and at least this long after register, for
//                   never-connected agents)
//   deleteGraceMs — ephemeral agents' dependent rows (webhooks, dead sessions)
//                   get purged this long after going greyed. Permanent agents'
//                   dependents are never purged — they keep state for a clean
//                   reconnect later.
const reapGraceMs = parseInt(process.env.REAP_GRACE_MS ?? "20000", 10);
const deleteGraceMs = parseInt(process.env.DELETE_GRACE_MS ?? "3600000", 10);
// Webhook janitor: any webhook whose owning agent has no session that has
// heartbeated within this window is swept (cleanup JS runs, row deleted).
// Applies to both ephemerals and permanent agents — permanents re-register
// their webhooks on reconnect. Default matches deleteGraceMs (1h).
const webhookStaleMs = parseInt(process.env.WEBHOOK_STALE_MS ?? "3600000", 10);

export const log = pino({ name: "wire" });

process.on("unhandledRejection", (err) => {
  log.error({ event: "unhandled_rejection", err }, "unhandled promise rejection");
});

process.on("uncaughtException", (err) => {
  log.fatal({ event: "uncaught_exception", err }, "uncaught exception");
  process.exit(1);
});

const store = new Store(dbPath);
const emitter = new MessageEmitter();

// Server identity — Ed25519 keypair for peer-to-peer federation (v1.1.0).
// Generated on first boot; pubkey is what you paste when peering.
const serverIdentity = await loadOrCreateServerIdentity();
log.info({ event: "server_identity", pubkey: serverIdentity.pubkeyB64 }, "server identity loaded");

// Our peer name in outgoing JWTs — defaults to hostname but can be
// overridden via WIRE_PEER_NAME so two Wires on the same hostname
// can coexist (dev / test / CI).
const ourPeerName = (process.env.WIRE_PEER_NAME ?? "").trim() || require("os").hostname().toLowerCase();

const router = new Router(store, emitter, log, { ourPeerName, identity: serverIdentity });

// Server-plugin lifecycle bus — delivers generic broker lifecycle events
// (e.g. agent_reaped) to config-declared Wire Server Plugins (sidecars enrolled
// as permanent integration agents, e.g. `wallet`). Absent a serverPlugins
// config the bus is never wired, so the store fires no sink — behavior is
// byte-identical to before for existing deployments.
const serverPlugins = loadServerPlugins(log);
if (serverPlugins.length) {
  const serverPluginBus = new ServerPluginBus(serverPlugins, router, log);
  store.setLifecycleSink((ev) => serverPluginBus.emit(ev));
  log.info(
    { event: "server_plugins_loaded", plugins: serverPlugins.map((p) => p.agentId) },
    "server-plugin lifecycle bus active",
  );
}

const heartbeats = new HeartbeatScheduler(store, router, log);

/**
 * Purge webhooks scoped to a specific session_id. Runs cleanup JS (best-effort,
 * async, non-blocking) then deletes the row. Called on any path that ends a
 * session — clean disconnect, reconnect dedup, reconciler timeout, orphan reap.
 * Agent-scoped webhooks (session_id NULL) are untouched here; they fall to the
 * janitor on heartbeat staleness.
 */
function purgeSessionScopedWebhooks(sessionId: string): void {
  const hooks = store.getWebhooksBySession(sessionId);
  if (hooks.length === 0) return;
  for (const wh of hooks) {
    if (wh.cleanup) {
      const secrets = wh.secrets_map ? JSON.parse(wh.secrets_map) : {};
      const meta = wh.meta ? JSON.parse(wh.meta) : {};
      runCleanup(wh.cleanup, { meta, secrets }).then(() => {
        log.info({ event: "session_scoped_cleanup_ok", agent: wh.agent_id, webhook_id: wh.id, plugin: wh.plugin, name: wh.name }, "session-scoped webhook cleanup ok");
      }).catch((e) => {
        log.error({ event: "session_scoped_cleanup_error", agent: wh.agent_id, webhook_id: wh.id, plugin: wh.plugin, name: wh.name, err: e }, "session-scoped webhook cleanup error");
      });
    }
    store.deleteWebhook(wh.id);
    log.info({ event: "session_scoped_webhook_swept", agent: wh.agent_id, webhook_id: wh.id, session: sessionId, plugin: wh.plugin, name: wh.name }, `session-end: swept webhook ${wh.id}`);
  }
}

const server = createServer({ port, store, router, emitter, log, heartbeats, onSessionEnd: purgeSessionScopedWebhooks });
heartbeats.start();

// Boot-time peer announcement (v1.1.0 federation). If we have a public
// URL configured, fan out a /peers/refresh to every registered peer so
// they learn our (possibly rotated) ngrok hostname. Best-effort —
// failures are logged, not fatal. Skip on first boot when no peers
// exist yet, and skip in dev when WIRE_PUBLIC_URL is unset.
const ourPublicUrl = (process.env.WIRE_PUBLIC_URL ?? "").trim();
if (ourPublicUrl) {
  const { announceUrlToPeer } = await import("./federation.js");
  const peers = store.listPeers();
  if (peers.length > 0) {
    log.info({ event: "peer_announce_boot", count: peers.length, our_url: ourPublicUrl }, "announcing public URL to peers");
    void Promise.all(peers.map((p) =>
      announceUrlToPeer(p, ourPeerName, serverIdentity, ourPublicUrl, log).catch((err) =>
        log.warn({ event: "peer_announce_error", peer: p.name, err: String(err) }, "peer announcement crashed"),
      ),
    ));
  }
} else {
  log.debug({ event: "peer_announce_skipped" }, "WIRE_PUBLIC_URL not set — no peer announcement");
}

// Session reconciler — update status based on heartbeat age
setInterval(() => {
  const transitions = store.reconcileSessions(staleMs, disconnectMs);
  for (const t of transitions) {
    if (t.newStatus === "stale") {
      log.info({ event: "session_stale", agent: t.agentId, session: t.sessionId }, "session → stale");
    } else if (t.newStatus === "disconnected") {
      log.info({ event: "session_disconnected", agent: t.agentId, session: t.sessionId }, "session → disconnected");
      emitter.closeAndUnregister(t.agentId, t.sessionId);
      purgeSessionScopedWebhooks(t.sessionId);
    }
  }

  // Check session files for dead or orphaned Claude Code processes.
  // A session is reapable if ANY of these hold:
  //   - ccPid is null (legacy MCP that couldn't track its CC parent)
  //   - ccPid is dead (CC exited cleanly)
  //   - ccPid is alive but reparented to launchd (CC died, MCP survived as orphan)
  // When reaping, also SIGTERM the bun MCP pid so it doesn't reconnect with
  // a fresh session on the next iteration.
  const sessionsDir = join(homedir(), ".wire", "sessions");
  try {
    const files = readdirSync(sessionsDir).filter((f) => f.endsWith(".json"));
    for (const file of files) {
      try {
        const data = JSON.parse(readFileSync(join(sessionsDir, file), "utf-8"));
        const reason =
          data.ccPid == null
            ? "no_cc_pid"
            : isOrphanOrDead(data.ccPid)
              ? "cc_dead_or_orphan"
              : null;
        if (reason) {
          log.info({ event: "session_reap", reason, agentId: data.agentId, ccPid: data.ccPid, mcpPid: data.pid, sessionId: data.sessionId }, "reaping orphan session");
          store.disconnectSession(data.sessionId);
          emitter.closeAndUnregister(data.agentId, data.sessionId);
          purgeSessionScopedWebhooks(data.sessionId);
          if (data.pid) {
            try { process.kill(data.pid, "SIGTERM"); } catch {}
          }
          unlinkSync(join(sessionsDir, file));
        }
      } catch {}
    }
  } catch {}

  // --- Pass 1: soft-reap (grey out) inactive agents ---
  // Agents with no recent heartbeat (and outside the registration grace
  // window) get reaped_at set. They remain in the registry, in dashboard,
  // and remain authenticatable — any heartbeat / send / register clears
  // the greyed state via clearReap().
  const softReapIds = store.getSoftReapCandidates(reapGraceMs);
  for (const agentId of softReapIds) {
    store.softReapAgent(agentId);
    log.info({ event: "agent_soft_reap", agent: agentId }, `agent ${agentId} → greyed`);
  }

  // --- Pass 2: purge dependents of greyed ephemerals past the delete grace ---
  // Identity (agent row) is permanent and stays. We purge only the
  // ephemeral's webhooks (running their cleanup callbacks first to
  // tear down external state) and dead sessions. After purge, the agent
  // can still re-register at any time using the same id + pubkey and
  // pick up cleanly (no zombie sessions, no stale webhooks).
  //
  // Permanent agents are excluded by the query — their dependents stay.
  // The query also excludes agents whose dependents have already been
  // purged (`dependents_purged_at IS NOT NULL`), so this is idempotent
  // across reconciler ticks.
  const purgeIds = store.getDependentPurgeCandidates(deleteGraceMs);
  for (const agentId of purgeIds) {
    const webhooks = store.getWebhooksForAgent(agentId);
    for (const wh of webhooks) {
      if (wh.cleanup) {
        const secrets = wh.secrets_map ? JSON.parse(wh.secrets_map) : {};
        const meta = wh.meta ? JSON.parse(wh.meta) : {};
        runCleanup(wh.cleanup, { meta, secrets }).then(() => {
          log.info({ event: "webhook_cleanup_ok", agent: agentId }, "webhook cleanup ok");
        }).catch((e) => {
          log.error({ event: "webhook_cleanup_error", agent: agentId, err: e }, "webhook cleanup error");
        });
      }
    }
    store.purgeAgentDependents(agentId);
    log.info({ event: "agent_dependents_purged", agent: agentId }, `agent ${agentId} dependents purged (identity preserved)`);
  }

  // --- Webhook janitor ---
  // Sweep webhooks whose owning agent has no session heartbeating within
  // `webhookStaleMs`. Re-runnable per tick: catches webhooks registered AFTER
  // an ephemeral's one-shot dependent purge (the Madeleine/Tiramisu orphan
  // case from 2026-05), and also cleans webhooks belonging to permanent
  // agents that have gone offline (they can re-register on reconnect).
  const staleWebhooks = store.getStaleWebhooks(webhookStaleMs);
  for (const wh of staleWebhooks) {
    if (wh.cleanup) {
      const secrets = wh.secrets_map ? JSON.parse(wh.secrets_map) : {};
      const meta = wh.meta ? JSON.parse(wh.meta) : {};
      runCleanup(wh.cleanup, { meta, secrets }).then(() => {
        log.info({ event: "webhook_janitor_cleanup_ok", agent: wh.agent_id, webhook_id: wh.id, plugin: wh.plugin, name: wh.name }, "janitor: webhook cleanup ok");
      }).catch((e) => {
        log.error({ event: "webhook_janitor_cleanup_error", agent: wh.agent_id, webhook_id: wh.id, plugin: wh.plugin, name: wh.name, err: e }, "janitor: webhook cleanup error");
      });
    }
    store.deleteWebhook(wh.id);
    log.info({ event: "webhook_janitor_swept", agent: wh.agent_id, webhook_id: wh.id, plugin: wh.plugin, name: wh.name }, `janitor: swept stale webhook ${wh.id} (${wh.agent_id}/${wh.plugin}/${wh.name})`);
  }
}, reconcilerIntervalMs);

log.info({ port, db: dbPath }, `The Wire running on http://localhost:${port}`);
