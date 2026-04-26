/**
 * The Wire — entry point.
 *
 * Persistent multi-agent message broker, event log, and registry.
 */

import { join } from "path";
import { homedir } from "os";
import { readdirSync, readFileSync, unlinkSync } from "fs";
import { config } from "dotenv";
import pino from "pino";

// Load all Wire config from ~/.wire/.env
config({ path: join(homedir(), ".wire", ".env") });
import { Store } from "./store.js";
import { Router } from "./router.js";
import { MessageEmitter } from "./emitter.js";
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
// Heartbeat: 10s interval from clients. Stale after 15s, disconnected after 60s.
const staleMs = parseInt(process.env.STALE_MS ?? "15000", 10);
const disconnectMs = parseInt(process.env.DISCONNECT_MS ?? "60000", 10);
const reconcilerIntervalMs = parseInt(process.env.RECONCILER_INTERVAL_MS ?? "10000", 10);
const ephemeralTtlMs = parseInt(process.env.EPHEMERAL_TTL_MS ?? "300000", 10); // 5 minutes — must exceed agent boot time

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
const heartbeats = new HeartbeatScheduler(store, router, log);

const server = createServer({ port, store, router, emitter, log, heartbeats });
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
    }
  }

  // Check session files for dead Claude Code processes
  const sessionsDir = join(homedir(), ".wire", "sessions");
  try {
    const files = readdirSync(sessionsDir).filter((f) => f.endsWith(".json"));
    for (const file of files) {
      try {
        const data = JSON.parse(readFileSync(join(sessionsDir, file), "utf-8"));
        if (data.ccPid) {
          try { process.kill(data.ccPid, 0); } catch {
            // Claude Code process is dead — disconnect and clean up
            log.info({ event: "cc_dead", agentId: data.agentId, ccPid: data.ccPid, sessionId: data.sessionId }, "Claude Code dead, disconnecting");
            store.disconnectSession(data.sessionId);
            emitter.closeAndUnregister(data.agentId, data.sessionId);
            unlinkSync(join(sessionsDir, file));
          }
        }
      } catch {}
    }
  } catch {}

  // Before reaping ephemeral agents, run client-provided cleanup code for their webhooks
  const candidates = store.getEphemeralCandidates(ephemeralTtlMs);
  for (const agentId of candidates) {
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
  }

  const removed = store.cleanEphemeralAgents(ephemeralTtlMs);
  if (removed.length > 0) {
    log.info({ event: "ephemeral_cleanup", agents: removed }, `removed ${removed.length} ephemeral agent(s)`);
  }
}, reconcilerIntervalMs);

log.info({ port, db: dbPath }, `The Wire running on http://localhost:${port}`);
