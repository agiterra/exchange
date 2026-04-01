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
import { createServer } from "./server.js";

const port = parseInt(process.env.WIRE_PORT ?? "9800", 10);
const dbPath = process.env.WIRE_DB ?? `${process.env.HOME}/.wire/wire.db`;
// Heartbeat: 10s interval from clients. Stale after 15s, disconnected after 60s.
const staleMs = parseInt(process.env.STALE_MS ?? "15000", 10);
const disconnectMs = parseInt(process.env.DISCONNECT_MS ?? "60000", 10);
const reconcilerIntervalMs = parseInt(process.env.RECONCILER_INTERVAL_MS ?? "10000", 10);
const ephemeralTtlMs = parseInt(process.env.EPHEMERAL_TTL_MS ?? "60000", 10); // 1 minute default

export const log = pino({ name: "wire" });

const store = new Store(dbPath);
const emitter = new MessageEmitter();
const router = new Router(store, emitter, log);
const server = createServer({ port, store, router, emitter, log });

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

  // Before reaping ephemeral agents, collect their webhooks for external cleanup
  const candidates = store.getEphemeralCandidates(ephemeralTtlMs);
  for (const agentId of candidates) {
    const webhooks = store.getWebhooksForAgent(agentId);
    for (const wh of webhooks) {
      if (wh.meta) {
        try {
          const meta = JSON.parse(wh.meta);
          if (meta.hook_id && meta.repo) {
            // Delete GitHub webhook
            const ghToken = process.env.GITHUB_TOKEN;
            if (ghToken) {
              fetch(`https://api.github.com/repos/${meta.repo}/hooks/${meta.hook_id}`, {
                method: "DELETE",
                headers: { Authorization: `Bearer ${ghToken}`, "User-Agent": "wire-server" },
              }).then((res) => {
                if (res.ok || res.status === 404) {
                  log.info({ event: "github_hook_deleted", repo: meta.repo, hookId: meta.hook_id, agent: agentId }, "GitHub webhook deleted");
                } else {
                  log.error({ event: "github_hook_delete_failed", repo: meta.repo, hookId: meta.hook_id, status: res.status }, "GitHub webhook delete failed");
                }
              }).catch((e) => {
                log.error({ event: "github_hook_delete_error", repo: meta.repo, hookId: meta.hook_id, err: e }, "GitHub webhook delete error");
              });
            }
          }
        } catch {}
      }
    }
  }

  const removed = store.cleanEphemeralAgents(ephemeralTtlMs);
  if (removed.length > 0) {
    log.info({ event: "ephemeral_cleanup", agents: removed }, `removed ${removed.length} ephemeral agent(s)`);
  }
}, reconcilerIntervalMs);

log.info({ port, db: dbPath }, `The Wire running on http://localhost:${port}`);
