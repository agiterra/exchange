/**
 * Wire HTTP Server — Hono-based.
 *
 * Routes:
 *   GET  /health
 *   GET  /agents                         — list registered agents
 *   POST /agents/register                — register/update agent
 *   POST /agents/connect                 — create session, start SSE delivery
 *   POST /agents/disconnect              — end session
 *   POST /agents/ack                     — advance session cursor
 *   GET  /agents/:id/stream              — SSE stream for agent
 *   POST /agents/:id/sessions/:sid/heartbeat — session keepalive
 *   GET  /agents/:id/plan                — get agent plan
 *   PUT  /agents/:id/plan                — set agent plan
 *   GET  /agents/:id/peek                — read agent's screen output (operator only)
 *   POST /agents/:id/message             — send IPC message to agent (operator only)
 *   POST /agents/:id/webhooks            — register webhook for agent
 *   POST /webhooks/:agent/:plugin        — inbound webhook delivery
 *   GET  /                               — dashboard (WebAuthn protected, future)
 */

import { watchFile, existsSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";
import { tmpdir } from "os";
import Database from "bun:sqlite";
import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Context } from "hono";
import type { Store } from "./store.js";
import type { Router } from "./router.js";
import type { MessageEmitter, SSEWriter } from "./emitter.js";
import {
  getOperatorFromSession,
  createSession as createAuthSession,
  generateRegistrationOptions,
  generateAuthenticationOptions,
  getRpIds,
  getExpectedOrigins,
} from "./auth.js";
import { verifyRegistrationResponse, verifyAuthenticationResponse } from "@simplewebauthn/server";
import type { Logger } from "pino";
import { evaluateFilter, evaluateExpression, validateFilter } from "./filter.js";
import { renderDashboard as _initialRenderDashboard, renderLogin } from "./dashboard.js";
import { dirname } from "path";
import { fileURLToPath } from "url";

// Hot-reload dashboard: re-import on file change via file:// URL cache busting
const __dirname = dirname(fileURLToPath(import.meta.url));
const dashboardPath = join(__dirname, "dashboard.ts");
let _renderDashboard = _initialRenderDashboard;
const dashboardRefreshListeners = new Set<() => void>();
const dashboardStateListeners = new Set<() => void>();

/** Notify dashboard SSE clients of state change. */
function notifyDashboard() {
  for (const listener of dashboardStateListeners) listener();
}
let _serverLog: Logger | null = null;

async function reloadDashboard() {
  try {
    const mod = await import(`file://${dashboardPath}?v=${Date.now()}`);
    _renderDashboard = mod.renderDashboard;
    _serverLog?.info({ event: "dashboard_reloaded" }, "dashboard reloaded");
    for (const listener of dashboardRefreshListeners) {
      listener();
    }
  } catch (e) {
    _serverLog?.error({ event: "dashboard_reload_failed", err: e }, "dashboard reload failed");
  }
}
watchFile(dashboardPath, { interval: 1000 }, () => reloadDashboard());

type ServerDeps = {
  port: number;
  store: Store;
  router: Router;
  emitter: MessageEmitter;
  log: Logger;
  heartbeats: import("./heartbeat.js").HeartbeatScheduler;
  /** Called on any clean session-end path (reconnect dedup + /agents/disconnect).
   *  Used by index.ts to purge session-scoped webhooks immediately rather than
   *  waiting for the reconciler. */
  onSessionEnd?: (sessionId: string, agentId: string) => void;
};

// --- JWT verification ---

function b64urlDecode(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}


/**
 * Verify JWT Bearer token — Ed25519 signature + body hash integrity.
 * Returns verified claims and sender info. Does not require any specific claims
 * beyond iss and body_hash.
 */
async function verifyJwt(
  headers: Record<string, string>,
  rawBody: string,
  store: Store,
): Promise<{ sender: string; sender_display_name: string; claims: Record<string, unknown> }> {
  const authHeader = headers["authorization"] ?? "";
  if (!authHeader.startsWith("Bearer ")) {
    throw new Error("missing bearer token");
  }
  const token = authHeader.slice(7);

  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("invalid JWT: expected 3 parts");
  const [headerB64, payloadB64, sigB64] = parts;

  const claims = JSON.parse(new TextDecoder().decode(b64urlDecode(payloadB64)));
  const sender = claims.iss;
  if (!sender) throw new Error("missing iss claim");

  const agent = store.getAgent(sender);
  if (!agent) throw new Error(`unknown sender: ${sender}`);

  // Verify Ed25519 signature
  const pubBytes = Uint8Array.from(atob(agent.pubkey), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("raw", pubBytes, "Ed25519", false, ["verify"]);
  const sigBytes = b64urlDecode(sigB64);
  const signingInput = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const valid = await crypto.subtle.verify("Ed25519", key, sigBytes, signingInput);
  if (!valid) throw new Error("invalid JWT signature");

  // Verify body hash
  if (!claims.body_hash) throw new Error("missing body_hash claim");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(rawBody));
  const bodyHash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  if (bodyHash !== claims.body_hash) throw new Error("body hash mismatch");

  return { sender, sender_display_name: agent.display_name, claims };
}

/**
 * Verify JWT for message routing — requires topic claim.
 */
// --- Webhook Cleanup (VM-lite) ---

export async function runCleanup(
  code: string,
  ctx: { meta: Record<string, unknown>; secrets: Record<string, string> },
): Promise<void> {
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const fn = new AsyncFunction("meta", "secrets", "fetch", code);
  await fn(ctx.meta, ctx.secrets, fetch);
}

export function createServer({ port, store, router, emitter, log, heartbeats, onSessionEnd }: ServerDeps) {
  _serverLog = log;
  const app = new Hono();

  app.use("*", cors());

  // Global error handler — log and return 500
  app.onError((err, c) => {
    log.error({ event: "unhandled_error", method: c.req.method, path: c.req.path, err: { message: err.message, stack: err.stack } }, "unhandled error");
    return c.json({ error: "internal server error", detail: err.message }, 500);
  });

  // Cache raw body text so signature verification works after c.req.json()
  app.use("*", async (c, next) => {
    if (c.req.method === "POST" || c.req.method === "PUT" || c.req.method === "DELETE") {
      (c as any).set("rawBody", await c.req.raw.clone().text());
    }
    await next();
  });

  // --- Auth primitives ---

  /** Check for authenticated operator via WebAuthn session cookie or dashboard token. */
  const DASHBOARD_TOKEN = process.env.WIRE_DASHBOARD_TOKEN;

  function isOperator(c: Context): boolean {
    if (getOperatorFromSession(c.req.header("cookie"), store)) return true;
    if (DASHBOARD_TOKEN) {
      // Check token cookie
      const cookies = c.req.header("cookie") ?? "";
      const tokenCookie = cookies.split(";").map(s => s.trim()).find(s => s.startsWith("wire_token="));
      if (tokenCookie && tokenCookie.split("=")[1] === DASHBOARD_TOKEN) return true;
      // Check query param (initial entry point)
      const tokenParam = new URL(c.req.url).searchParams.get("token");
      if (tokenParam === DASHBOARD_TOKEN) return true;
    }
    return false;
  }

  /** Verify a session belongs to the given agent. */
  function isSessionOwner(sessionId: string, agentId: string): boolean {
    const session = store.getSession(sessionId);
    return !!session && session.agent_id === agentId;
  }


  /**
   * Verify JWT and return authenticated agent ID.
   * Combines auth check + agent_id extraction for endpoints where
   * the caller IS the agent (connect, disconnect, ack, heartbeat).
   */
  async function requireAuthenticatedAgent(c: Context): Promise<{ agentId: string } | Response> {
    const authHeader = c.req.header("authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return c.json({ error: "Authorization: Bearer <JWT> required" }, 401);
    }
    try {
      const { sender } = await verifyJwt(
        { authorization: authHeader },
        (c as any).get("rawBody") ?? "",
        store,
      );
      const agent = store.getAgent(sender);
      if (!agent) return c.json({ error: `agent '${sender}' not registered` }, 404);
      return { agentId: sender };
    } catch (e: any) {
      return c.json({ error: `JWT verification failed: ${e.message}` }, 403);
    }
  }

  // --- Auth gates (return error Response or null for authorized) ---

  /** Require authenticated agent (JWT Bearer). */
  async function requireAgent(c: Context, agentId: string): Promise<Response | null> {
    const agent = store.getAgent(agentId);
    if (!agent) return c.json({ error: `agent '${agentId}' not registered` }, 404);

    const authHeader = c.req.header("authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return c.json({ error: "Authorization: Bearer <JWT> required" }, 401);
    }

    try {
      const { sender } = await verifyJwt(
        { authorization: authHeader },
        (c as any).get("rawBody") ?? "",
        store,
      );
      if (sender === agentId) return null;
      return c.json({ error: "JWT issuer does not match agent" }, 403);
    } catch (e: any) {
      return c.json({ error: `JWT verification failed: ${e.message}` }, 403);
    }
  }

  /** Require agent owns the session (+ agent signature). */
  async function requireAgentSession(c: Context, agentId: string, sessionId: string): Promise<Response | null> {
    const err = await requireAgent(c, agentId);
    if (err) return err;
    if (!isSessionOwner(sessionId, agentId)) return c.json({ error: "session does not belong to agent" }, 403);
    return null;
  }

  /** Require authenticated operator (WebAuthn). */
  function requireOperator(c: Context): Response | null {
    if (isOperator(c)) return null;
    return c.json({ error: "operator authentication required" }, 401) as unknown as Response;
  }

  /** Require either operator auth or JWT signed by any registered agent. */
  async function requireAgentOrOperator(c: Context): Promise<Response | null> {
    if (isOperator(c)) return null;

    const authHeader = c.req.header("authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return c.json({ error: "Authorization: Bearer <JWT> or operator session required" }, 401);
    }

    try {
      await verifyJwt(
        { authorization: authHeader },
        (c as any).get("rawBody") ?? "",
        store,
      );
      return null;
    } catch (e: any) {
      return c.json({ error: `JWT verification failed: ${e.message}` }, 403);
    }
  }

  // --- Health ---

  app.get("/health", (c) => {
    return c.json({ status: "ok", ts: Date.now() });
  });

  // --- Federation (v1.1.0) ---
  // GET /peers/agents/:id  — unauthenticated existence probe. Returns
  //   200 if the agent is locally registered, 404 otherwise. Peers call
  //   this to decide whether to forward a message to us.
  app.get("/peers/agents/:id", (c) => {
    const id = c.req.param("id");
    const agent = store.getAgent(id);
    if (agent) return c.json({ ok: true, id });
    return c.json({ ok: false, id }, 404);
  });

  // POST /peers/refresh  — peer announces its current public base_url
  //   (used after ngrok rotates the random hostname). Same JWT shape
  //   as /peers/forward. We update peers.base_url and clear the
  //   router's discovery cache so subsequent forwards re-resolve.
  app.post("/peers/refresh", async (c) => {
    const auth = c.req.header("authorization") ?? "";
    const jwt = auth.replace(/^Bearer /, "");
    if (!jwt) return c.json({ error: "missing Bearer JWT" }, 401);
    const body = (c as any).get("rawBody") ?? await c.req.text();
    try {
      const { verifyRefreshJwt } = await import("./federation.js");
      const { peer, announced } = await verifyRefreshJwt(jwt, body, store);
      if (peer.base_url !== announced.base_url) {
        store.updatePeerUrl(peer.name, announced.base_url);
      }
      store.updatePeerLastSeen(peer.name, Date.now());
      // Invalidate discovery cache so old base_url isn't served via
      // a cached agent->peer mapping.
      (router as any).invalidateDiscoveryFor?.(peer.name);
      return c.json({ ok: true, peer: peer.name, base_url: announced.base_url });
    } catch (e) {
      return c.json({ error: "peer refresh rejected", detail: (e as Error).message }, 401);
    }
  });

  // POST /peers/forward  — accept a message forwarded by a peer Wire.
  //   Authorization: Bearer <outer-JWT> signed by the peer's server
  //   identity. Body is the original envelope exactly as the peer's
  //   router stored it. We verify the JWT, then call router.route so
  //   the message lands in our own store + reaches the local agent.
  app.post("/peers/forward", async (c) => {
    const auth = c.req.header("authorization") ?? "";
    const jwt = auth.replace(/^Bearer /, "");
    if (!jwt) return c.json({ error: "missing Bearer JWT" }, 401);
    const body = (c as any).get("rawBody") ?? await c.req.text();
    try {
      const { verifyForwardedJwt } = await import("./federation.js");
      const { peer, envelope } = await verifyForwardedJwt(jwt, body, store);
      // Route through normal pipeline so local storage + delivery both happen.
      const { message, deliveries } = router.route({
        source: envelope.source,
        source_id: envelope.source_id ?? undefined,
        source_cc_session: envelope.source_cc_session ?? undefined,
        dest: envelope.dest,
        dest_cc_session: envelope.dest_cc_session ?? undefined,
        topic: envelope.topic,
        payload: envelope.payload,
        raw: envelope.raw ?? undefined,
      });
      store.updatePeerLastSeen(peer.name, Date.now());
      return c.json({ seq: message.seq, delivered_to: deliveries, forwarded_by: peer.name });
    } catch (e) {
      return c.json({ error: "peer forward rejected", detail: (e as Error).message }, 401);
    }
  });

  // --- Agent Registry ---

  app.get("/agents", (c) => {
    // ?kind=agent (default) | integration | all
    const kindParam = c.req.query("kind");
    const kind = kindParam === "integration" ? "integration"
      : kindParam === "all" ? "all"
      : "agent";
    // ?include_reaped=1 — include reaped (greyed) agents in the response.
    // Default behavior excludes them: enumerating live agents is the
    // 99% case and the default shouldn't mislead (37-vs-1 surprise on
    // 2026-05-26 from Tim). Dashboards / audit views opt in explicitly.
    const includeReaped = c.req.query("include_reaped") === "1";
    const agents = store.getAllAgents(kind).filter(
      (a) => includeReaped || a.reaped_at == null,
    );
    const result = agents.map((a) => {
      const online = emitter.isConnected(a.id) || store.hasConnectedSession(a.id);
      // connection_status drives dashboard rendering:
      //   connected     — active SSE session, recent heartbeat
      //   connecting    — registered, no session yet, within reap grace
      //   disconnected  — soft-reaped (greyed); recoverable on next register/heartbeat
      let connection_status: "connected" | "connecting" | "disconnected";
      if (a.reaped_at != null) {
        connection_status = "disconnected";
      } else if (online) {
        connection_status = "connected";
      } else {
        connection_status = "connecting";
      }
      return {
        ...a,
        online,
        connection_status,
        sessions: store.getActiveSessions(a.id).length,
      };
    });
    return c.json(result);
  });

  app.post("/agents/register", async (c) => {
    const body = await c.req.json();
    const { id, display_name, pubkey, permanent, pronouns, force_rotate, kind } = body;

    if (!id || !display_name || !pubkey) {
      return c.json({ error: "missing required fields: id, display_name, pubkey" }, 400);
    }

    // Validate kind if provided; otherwise defaults to 'agent' in upsertAgent.
    if (kind != null && kind !== "agent" && kind !== "integration") {
      return c.json({ error: `invalid kind '${kind}'. Allowed: 'agent', 'integration'.` }, 400);
    }

    // getAgent now returns greyed agents too. Distinguish by reaped_at.
    const existing = store.getAgent(id);
    const isGreyed = existing != null && existing.reaped_at != null;

    // Reject silent key rotation. If any record exists with a different pubkey
    // and the caller didn't pass force_rotate=true, fail loudly so a sponsor
    // doesn't accidentally orphan a still-running process that holds the
    // previous private key (the Eclair-on-2026-05-01 case).
    if (existing && existing.pubkey !== pubkey && !force_rotate) {
      return c.json({
        error: `agent '${id}' already registered with a different key. Pass force_rotate=true to replace the keypair (this will permanently lock out any process still holding the previous private key).`,
        code: "agent_exists_pubkey_mismatch",
        existing: !isGreyed,
        reaped: isGreyed,
      }, 409);
    }

    let authPath: string;
    if (existing && existing.permanent) {
      authPath = isGreyed ? "permanent-readmission" : "permanent-reregister";
      // Permanent agent (alive or greyed) — must prove identity with own key
      const err = await requireAgent(c, id);
      if (err) return err;
    } else if (existing && !existing.permanent && !isGreyed) {
      authPath = "ephemeral-reregister";
      // Ephemeral agent re-registering while still alive — allow the agent itself or any sponsoring agent
      const selfErr = await requireAgent(c, id);
      if (selfErr) {
        const sponsorErr = await requireAgentOrOperator(c);
        if (sponsorErr) return sponsorErr;
      }
    } else if (permanent) {
      authPath = "new-permanent";
      // New permanent agent — operator only
      const err = requireOperator(c);
      if (err) return err;
    } else {
      authPath = isGreyed ? "reaped-readmission" : "new-ephemeral";
      // Greyed ephemeral phoning home with the matching pubkey: must prove
      // possession of the private key. Body's pubkey field is just
      // declarative — without verifying the JWT signature against the
      // stored pubkey we'd accept any caller who scraped the public key
      // from /agents?kind=all. The endpoint would still be a no-op in
      // practice (clearReap only fires on /connect and /heartbeat, both
      // gated by JWT), but registers should require auth as a hard rule.
      //
      // Truly new ephemeral: requires sponsor or operator auth.
      if (isGreyed && existing!.pubkey === pubkey) {
        const err = await requireAgent(c, id);
        if (err) return err;
      } else {
        const err = await requireAgentOrOperator(c);
        if (err) return err;
      }
    }

    log.info({
      event: "register",
      agentId: id,
      authPath,
      bodyPermanent: permanent,
      existingPermanent: existing?.permanent ?? null,
      greyed: isGreyed,
      pubkeyMatch: existing ? existing.pubkey === pubkey : null,
    }, `REGISTER ${id} via ${authPath}`);

    store.upsertAgent({ id, display_name, pubkey, permanent: !!permanent, pronouns, kind });

    return c.json({ agent_id: id, registered: true }, 201);
  });

  // --- Session Lifecycle ---

  app.post("/agents/connect", async (c) => {
    const auth = await requireAuthenticatedAgent(c);
    if (auth instanceof Response) return auth;
    const { agentId } = auth;

    const body = await c.req.json();

    // Close existing connected sessions for same cc_session_id (reconnect dedup)
    if (body.cc_session_id) {
      const oldSessions = store.getSessionsByCCSession(agentId, body.cc_session_id);
      for (const old of oldSessions) {
        store.disconnectSession(old.id);
        emitter.closeAndUnregister(agentId, old.id);
        onSessionEnd?.(old.id, agentId);
      }
    }

    store.touchAgent(agentId);
    // Successful new session = liveness signal. Clear any greyed state.
    if (store.clearReap(agentId)) {
      log.info({ event: "agent_un_greyed", agent: agentId, via: "connect" }, `agent ${agentId} → connected (un-greyed)`);
    }
    // cc_session_id identifies the Claude Code session (survives SSE reconnects)
    const session = store.createSession(agentId, "claude-code", body.cc_session_id);
    notifyDashboard();

    return c.json({
      session_id: session.id,
      cc_session_id: session.cc_session_id,
      last_ack_seq: session.last_ack_seq,
    });
  });

  app.post("/agents/disconnect", async (c) => {
    const auth = await requireAuthenticatedAgent(c);
    if (auth instanceof Response) return auth;
    const { agentId } = auth;

    const body = await c.req.json();
    const { session_id } = body;

    if (!session_id) {
      return c.json({ error: "missing session_id" }, 400);
    }

    if (!isSessionOwner(session_id, agentId)) {
      return c.json({ error: "session does not belong to agent" }, 403);
    }

    store.disconnectSession(session_id);
    emitter.closeAndUnregister(agentId, session_id);
    onSessionEnd?.(session_id, agentId);

    // Clean shutdown: if this was the agent's last live session, soft-reap.
    //
    // Identity is permanent — agent row stays. Ephemeral dependent rows
    // (webhooks, dead sessions) get purged later by the reaper after
    // deleteGraceMs.
    //
    // Per Tim 2026-05-15 (`.knowledge/feedback/wire-identity-never-hard-delete.md`):
    //   "Fondant should not be hard-deleting anyone, ever."
    const reapGraceMs = parseInt(process.env.REAP_GRACE_MS ?? "20000", 10);
    if (!store.agentHasLiveSession(agentId, reapGraceMs)) {
      store.softReapAgent(agentId);
      log.info({ event: "agent_soft_reap", agent: agentId, via: "clean_disconnect" }, `agent ${agentId} → greyed (clean shutdown)`);
    }
    notifyDashboard();
    return c.json({ disconnected: true });
  });

  app.post("/agents/ack", async (c) => {
    const auth = await requireAuthenticatedAgent(c);
    if (auth instanceof Response) return auth;
    const { agentId } = auth;

    const body = await c.req.json();
    const { session_id, seq } = body;

    if (!session_id || seq == null) {
      return c.json({ error: "missing session_id or seq" }, 400);
    }

    if (!isSessionOwner(session_id, agentId)) {
      return c.json({ error: "session does not belong to agent" }, 403);
    }

    store.ackSession(session_id, seq);
    return c.json({ acked: seq });
  });

  // --- Temporal Query ---

  app.get("/agents/:id/recent", async (c) => {
    const agentId = c.req.param("id");

    // Reading another agent's message history is sensitive — payloads
    // can carry anything. Require the target agent's JWT or operator auth.
    if (!isOperator(c)) {
      const err = await requireAgent(c, agentId);
      if (err) return err;
    }

    const minutes = parseInt(c.req.query("minutes") ?? "10", 10);
    const limit = parseInt(c.req.query("limit") ?? "100", 10);
    const cutoff = Date.now() - minutes * 60_000;

    const agent = store.getAgent(agentId);
    if (!agent) {
      return c.json({ error: `agent '${agentId}' not registered` }, 404);
    }

    // Get recent messages across all names for this agent
    const messages = store.getRecentMessages(agentId, cutoff, limit);
    return c.json({ agent_id: agentId, minutes, count: messages.length, messages });
  });

  // --- SSE Stream ---

  app.get("/agents/:id/stream", async (c) => {
    const agentId = c.req.param("id");
    const sessionId = c.req.query("session_id");

    log.info({ event: "sse_request", agentId, sessionId }, "SSE stream requested");

    if (!sessionId) {
      log.warn({ event: "sse_no_session", agentId }, "SSE: missing session_id");
      return c.json({ error: "missing session_id" }, 400);
    }

    if (!isSessionOwner(sessionId, agentId)) {
      log.warn({ event: "sse_auth_fail", agentId, sessionId }, "SSE: invalid session");
      return c.json({ error: "invalid session" }, 403);
    }

    store.markSessionConnected(sessionId);
    log.info({ event: "sse_open", agentId, sessionId }, "SSE stream opening");

    return new Response(
      new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder();
          const writer: SSEWriter = {
            write(data: string) {
              try {
                controller.enqueue(encoder.encode(data));
              } catch (e) {
                log.warn({ event: "sse_write_fail", agentId, sessionId, err: String(e) }, "SSE write failed");
                emitter.unregister(agentId, sessionId!);
              }
            },
            close() {
              log.info({ event: "sse_writer_close", agentId, sessionId }, "SSE writer closed");
              try { controller.close(); } catch {}
            },
          };

          emitter.register(agentId, sessionId!, writer);
          writer.write(": connected\n\n");

          // Periodic SSE keepalive comment. Without this, idle agents
          // (no inbound messages) hit wire-tools' 300s silence-timeout
          // every ~5 minutes and reconnect — which fires the
          // "Wire connection LOST / RESTORED" channel notification pair
          // and looks like a flap to operators. 30s interval is well
          // under the 300s client timeout and ngrok's ~256s idle close.
          // Real SSE event-frame keepalive. SSE comments (`:`-prefixed
          // lines) don't transit reliably — tested 1KB and 32KB padded
          // comment forms; both fire on the server (sse_keepalive
          // logged every 30s) but never reach the client (verified via
          // direct localhost curl AND by the 300s silence-timeout
          // continuing to fire on all real clients).
          //
          // Event-frame keepalives DO transit. The data payload is a
          // Wire-envelope-shaped JSON with topic `wire.keepalive` —
          // wire-tools v2.6.3+ filters this topic from delivery so it
          // never appears as a channel notification. Older wire-tools
          // clients will see a phantom notification per ping; the fix
          // is on the wire-tools side. Document in the release note.
          let keepaliveCount = 0;
          const keepalive = setInterval(() => {
            try {
              const data = JSON.stringify({
                seq: 0,
                source: "wire",
                topic: "wire.keepalive",
                payload: null,
                created_at: Date.now(),
              });
              controller.enqueue(encoder.encode(`event: keepalive\ndata: ${data}\n\n`));
              keepaliveCount++;
              log.debug({ event: "sse_keepalive", agentId, sessionId, count: keepaliveCount }, "SSE keepalive sent");
            } catch (e) {
              // Controller already closed (client gone before the abort
              // handler fired). Stop the timer AND drop the dead writer from
              // the emitter — matching write()'s cleanup — so live emits stop
              // hitting it. Leaving it registered wastes an enqueue-throw per
              // message during reconnect storms. Never rethrows.
              log.warn({ event: "sse_keepalive_fail", agentId, sessionId, err: String(e) }, "SSE keepalive failed");
              clearInterval(keepalive);
              emitter.unregister(agentId, sessionId!);
            }
          }, 30_000);

          const session = store.getSession(sessionId!);
          const replaySeq = session?.last_ack_seq ?? 0;
          log.info({ event: "sse_replay", agentId, sessionId, fromSeq: replaySeq }, "SSE replaying backlog");
          router.replay(agentId, sessionId!);

          c.req.raw.signal.addEventListener("abort", () => {
            log.info({ event: "sse_abort", agentId, sessionId }, "SSE client disconnected");
            clearInterval(keepalive);
            emitter.unregister(agentId, sessionId!);
          });
        },
      }),
      {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        },
      },
    );
  });

  // --- Heartbeat ---

  app.post("/agents/:id/sessions/:sid/heartbeat", async (c) => {
    const agentId = c.req.param("id");
    const sessionId = c.req.param("sid");

    const err = await requireAgentSession(c, agentId, sessionId);
    if (err) return err;

    store.heartbeatSession(sessionId);
    // Heartbeat = liveness signal. Clear greyed state if applicable.
    if (store.clearReap(agentId)) {
      log.info({ event: "agent_un_greyed", agent: agentId, via: "heartbeat" }, `agent ${agentId} → connected (un-greyed)`);
    }
    return c.json({ ok: true });
  });

  // --- Agent Plan ---

  app.get("/agents/:id/plan", (c) => {
    const agentId = c.req.param("id");
    const plan = store.getAgentPlan(agentId);
    if (plan === null) {
      return c.json({ agent_id: agentId, plan: null });
    }
    return c.json({ agent_id: agentId, plan });
  });

  app.put("/agents/:id/plan", async (c) => {
    const agentId = c.req.param("id");

    // Agent can only update its own plan
    const err = await requireAgent(c, agentId);
    if (err) return err;

    const body = await c.req.json();
    store.setAgentPlan(agentId, body.plan ?? "");
    return c.json({ agent_id: agentId, updated: true });
  });

  // --- Agent Peek (operator reads screen output) ---

  app.get("/agents/:id/peek", async (c) => {
    const err = requireOperator(c);
    if (err) return err;

    const agentId = c.req.param("id");
    const crewDb = join(process.env.HOME ?? "/tmp", ".wire", "crews.db");
    if (!existsSync(crewDb)) {
      return c.json({ error: "crew database not found at " + crewDb }, 500);
    }

    const db = new Database(crewDb, { readonly: true });
    try {
      const row = db.query("SELECT screen_name FROM agents WHERE id = ?").get(agentId) as { screen_name: string } | null;
      if (!row) {
        return c.json({ error: `agent '${agentId}' not found in crew database` }, 404);
      }

      const tmpFile = join(tmpdir(), `wire-peek-${agentId}-${Date.now()}.txt`);
      try {
        execSync(`/opt/homebrew/bin/screen -S ${row.screen_name} -X hardcopy ${tmpFile}`, { timeout: 5000 });
        const output = Bun.file(tmpFile);
        const text = await output.text();
        execSync(`rm -f ${tmpFile}`);
        return c.json({ agent_id: agentId, screen_name: row.screen_name, output: text.trimEnd() });
      } catch (e: any) {
        return c.json({
          error: `failed to read screen for '${agentId}' (screen: ${row.screen_name})`,
          detail: e.message,
          stderr: e.stderr?.toString(),
        }, 500);
      }
    } finally {
      db.close();
    }
  });

  // --- Agent Send Message (operator sends IPC to agent) ---

  app.post("/agents/:id/message", async (c) => {
    const err = requireOperator(c);
    if (err) return err;

    const agentId = c.req.param("id");
    const agent = store.getAgent(agentId);
    if (!agent) {
      return c.json({ error: `agent '${agentId}' not registered` }, 404);
    }

    const body = await c.req.json();
    const text = body.message || body.text;
    if (!text) {
      return c.json({ error: "missing 'message' field" }, 400);
    }

    const operatorId = getOperatorFromSession(c.req.header("cookie"), store);
    const operator = operatorId ? store.getOperator(operatorId) : null;
    const operatorName = operator?.display_name ?? "operator";
    const payload = JSON.stringify({
      type: "operator-message",
      from: operatorName,
      message: text,
    });

    const { message, deliveries } = router.route({
      source: operatorName,
      dest: agentId,
      topic: "ipc",
      payload,
    });

    return c.json({
      seq: message.seq,
      delivered_to: deliveries,
    });
  });

  // --- Webhook Registration ---

  app.post("/agents/:id/webhooks", async (c) => {
    const agentId = c.req.param("id");

    // Authenticated agent or operator can register webhooks
    const err = await requireAgentOrOperator(c);
    if (err) return err;

    const body = await c.req.json();
    const { plugin, name, validator, webhook_secret, filter: filterExpr, meta, cleanup, dedup, session_id, responder, ack_early } = body;

    if (!plugin) {
      return c.json({ error: "missing plugin" }, 400);
    }
    if (!name) {
      return c.json({ error: "missing name" }, 400);
    }

    // Validate filter expression if provided
    if (filterExpr) {
      const filterErr = validateFilter(filterExpr);
      if (filterErr) {
        return c.json({ error: `invalid filter: ${filterErr}` }, 400);
      }
    }

    // Idempotent registration: if a webhook already exists for this
    // (agent, plugin, name), return it untouched rather than hitting the
    // UNIQUE constraint. Lets permanent-agent plugins re-register on boot
    // to self-heal without churning the URL or overwriting secrets/filter.
    const existing = store.getWebhookByName(agentId, plugin, name);
    if (existing) {
      return c.json({
        webhook_id: existing.id,
        url: `/webhooks/${agentId}/${plugin}/${name}`,
        registered: false,
      });
    }

    const secretsMap = webhook_secret
      ? JSON.stringify({ webhook_secret })
      : body.secrets ? JSON.stringify(body.secrets) : undefined;

    const webhookId = store.createWebhook({
      agentId,
      plugin,
      name,
      validator: validator ?? (webhook_secret ? "hmac" : "jwt-default"),
      secretsMap,
      filter: filterExpr,
      meta: meta ? JSON.stringify(meta) : undefined,
      cleanup: cleanup ?? undefined,
      dedup: dedup ?? undefined,
      sessionId: typeof session_id === "string" && session_id.length > 0 ? session_id : undefined,
      responder: typeof responder === "string" && responder.length > 0 ? responder : undefined,
      ackEarly: ack_early === true || ack_early === 1,
    });

    return c.json({
      webhook_id: webhookId,
      url: `/webhooks/${agentId}/${plugin}/${name}`,
      registered: true,
    });
  });

  app.delete("/agents/:id/webhooks/:webhookId", async (c) => {
    const agentId = c.req.param("id");
    const webhookId = parseInt(c.req.param("webhookId"), 10);

    const err = await requireAgentOrOperator(c);
    if (err) return err;

    const webhook = store.getWebhookById(webhookId);
    if (!webhook || webhook.agent_id !== agentId) {
      return c.json({ error: "webhook not found" }, 404);
    }

    // Run client-provided cleanup code if registered
    if (webhook.cleanup) {
      const secrets = webhook.secrets_map ? JSON.parse(webhook.secrets_map) : {};
      const meta = webhook.meta ? JSON.parse(webhook.meta) : {};
      runCleanup(webhook.cleanup, { meta, secrets }).catch(() => {});
    }

    store.deleteWebhook(webhookId);
    return c.json({ deleted: webhookId });
  });

  // --- Inbound Webhook ---

  /** Shared webhook delivery logic. */
  async function handleWebhook(
    c: Context,
    agentId: string,
    plugin: string,
    webhook: ReturnType<typeof store.getWebhookById> | null,
  ): Promise<Response> {
    const rawBody = (c as any).get("rawBody") ?? await c.req.text();
    const headers: Record<string, string> = {};
    c.req.raw.headers.forEach((v, k) => { headers[k] = v; });

    let source = agentId;
    let topic = `webhook.${plugin}`;
    let parsedBody: unknown;
    try { parsedBody = JSON.parse(rawBody); } catch { parsedBody = rawBody; }

    if (webhook) {
      const secrets = webhook.secrets_map ? JSON.parse(webhook.secrets_map) : {};
      const validatorCode = webhook.validator;

      if (validatorCode && validatorCode !== "jwt-default") {
        // Directory includes every identity (agents + integrations) — validators
        // resolve sender pubkeys regardless of identity kind.
        const agents = store.getAllAgents("all");
        const directory: Record<string, { pubkey: string; display_name: string }> = {};
        for (const a of agents) directory[a.id] = { pubkey: a.pubkey, display_name: a.display_name };

        try {
          const result = await runValidator(validatorCode, {
            headers, body: rawBody, secrets, directory,
          });
          if (!result) {
            return c.json({ error: "webhook validation failed" }, 401);
          }
          if (typeof result === "object" && result !== null) {
            const r = result as Record<string, unknown>;
            if (r.source) source = String(r.source);
            if (r.topic) topic = String(r.topic);
          }
        } catch (e) {
          return c.json({ error: "validator error", detail: String(e) }, 401);
        }
      } else {
        try {
          const { sender } = await verifyJwt(headers, rawBody, store);
          source = sender;
        } catch (e) {
          return c.json({ error: "webhook auth failed", detail: String(e) }, 401);
        }
      }

      // Responder: post-validator, pre-route. Plugin-provided JS that can
      // short-circuit with a custom HTTP response (e.g. handshake echoes).
      // Wire treats the code as opaque — protocol-specific handling lives
      // in whichever tools package generated it.
      if (webhook.responder) {
        try {
          const result = await runResponder(webhook.responder, {
            headers, body: rawBody, parsedBody, secrets,
          });
          if (result !== null && result !== undefined) {
            const r = result as { body?: unknown; status?: number };
            const status = (r.status ?? 200) as 200;
            return c.json(r.body ?? {}, status);
          }
        } catch (e) {
          return c.json({ error: "responder error", detail: String(e) }, 500);
        }
      }

      if (webhook.filter) {
        if (!evaluateFilter(webhook.filter, { headers, payload: parsedBody })) {
          return c.json({ filtered: true, delivered: false });
        }
      }

      // Dedup: client-provided expression extracts idempotency key
      if (webhook.dedup) {
        try {
          const key = evaluateExpression(webhook.dedup, { headers, payload: parsedBody });
          if (key && typeof key === "string") {
            const existing = store.getMessageBySourceId(key);
            if (existing) {
              return c.json({ duplicate: true, existing_seq: existing.seq, delivered: false });
            }
            // Pass source_id through to route() for storage
            (c as any).set("dedupKey", key);
          }
        } catch {}
      }
    } else {
      try {
        const { sender } = await verifyJwt(headers, rawBody, store);
        source = sender;
      } catch (e) {
        return c.json({ error: "webhook auth failed", detail: String(e) }, 401);
      }
    }

    // Build envelope and route. When the inbound matched a registered
    // webhook row, surface its id + name so receivers can self-cleanup
    // (e.g. github-claude-code unregistering on pull_request.closed).
    const envelope = {
      source,
      topic,
      dest: agentId,
      plugin,
      ...(webhook ? { webhook_id: webhook.id, webhook_name: webhook.name } : {}),
      headers,
      payload: parsedBody,
    };

    const dedupKey = (c as any).get("dedupKey") as string | undefined;
    const routeInput = {
      source,
      source_id: dedupKey,
      dest: agentId,
      topic,
      payload: JSON.stringify(envelope),
      raw: rawBody,
    };

    // ack_early: ACK the sender the instant the message is persisted
    // (writeMessage commits seq + source_id synchronously inside routeAsync,
    // so a retry that lands mid-fan-out is still caught by the dedup check
    // above), then fan out to subscribers asynchronously. Severs an external
    // sender's retry clock (e.g. Slack's ~3s http_timeout, which otherwise
    // re-delivers up to 3× under transient fan-out latency and floods
    // subscribers with duplicates) from downstream delivery cost. Opt-in per
    // webhook; without it, delivery stays synchronous and the caller receives
    // the per-recipient delivery result.
    if (webhook?.ack_early) {
      const { message } = router.routeAsync(routeInput);
      return c.json({ seq: message.seq, queued: true });
    }

    const { message, deliveries } = router.route(routeInput);
    return c.json({
      seq: message.seq,
      delivered_to: deliveries,
    });
  }

  // Route with name — direct webhook lookup
  app.post("/webhooks/:agent/:plugin/:name", async (c) => {
    const agentId = c.req.param("agent");
    const plugin = c.req.param("plugin");
    const name = c.req.param("name");

    const webhook = store.getWebhookByName(agentId, plugin, name);
    if (!webhook) {
      return c.json({ error: "webhook not found" }, 404);
    }

    return handleWebhook(c, agentId, plugin, webhook);
  });

  // Route without name — no webhook registration, JWT auth only
  app.post("/webhooks/:agent/:plugin", async (c) => {
    const agentId = c.req.param("agent");
    const plugin = c.req.param("plugin");

    return handleWebhook(c, agentId, plugin, null);
  });

  // --- Broadcast (no dest — delivers to all agents) ---

  app.post("/broadcast/:topic", async (c) => {
    const topic = c.req.param("topic");
    const rawBody = (c as any).get("rawBody") ?? await c.req.text();
    const headers: Record<string, string> = {};
    c.req.raw.headers.forEach((v, k) => { headers[k] = v; });

    // Require an explicit broadcast-intent header. The same JWT-signed body
    // would otherwise also reach /webhooks/<dest>/<topic> for unicast; the
    // header forces callers to declare "yes, I really mean to fan out to
    // every subscriber on this topic." Prevents the silent-broadcast pattern
    // where omitting `dest` in an SDK call lands status updates in every
    // ipc-subscriber's inbox (the Tarte 2026-05-26 firehose case).
    if (headers["x-wire-broadcast"] !== "1") {
      return c.json({
        error: "broadcast requires explicit intent header 'X-Wire-Broadcast: 1' (prevents silent fan-out via accidental omitted dest)",
      }, 400);
    }

    let source: string;
    try {
      const { sender } = await verifyJwt(headers, rawBody, store);
      source = sender;
    } catch (e) {
      return c.json({ error: "broadcast auth failed", detail: String(e) }, 401);
    }

    let parsedBody: unknown;
    try { parsedBody = JSON.parse(rawBody); } catch { parsedBody = rawBody; }

    const envelope = {
      source,
      topic: `webhook.${topic}`,
      plugin: topic,
      headers,
      payload: parsedBody,
    };

    const { message, deliveries } = router.route({
      source,
      topic: `webhook.${topic}`,
      payload: JSON.stringify(envelope),
      raw: rawBody,
    });

    return c.json({
      seq: message.seq,
      delivered_to: deliveries,
    });
  });

  // --- Scheduled Heartbeats ---

  app.post("/heartbeats", async (c) => {
    // Scheduling a heartbeat is effectively scheduling a recurring prompt
    // injection into the target agent. Must be authenticated.
    const err = await requireAgentOrOperator(c);
    if (err) return err;

    const body = await c.req.json() as {
      agent_id: string;
      cron: string;
      prompt: string;
      created_by?: string;
    };
    if (!body.agent_id || !body.cron || !body.prompt) {
      return c.json({ error: "agent_id, cron, and prompt are required" }, 400);
    }
    const createdBy = body.created_by ?? "system";
    const hb = heartbeats.add({
      agent_id: body.agent_id,
      cron: body.cron,
      prompt: body.prompt,
      created_by: createdBy,
    });
    log.info({ event: "heartbeat_created", id: hb.id, agent: body.agent_id, cron: body.cron }, "heartbeat created");
    return c.json(hb);
  });

  app.get("/heartbeats", async (c) => {
    // Listing heartbeats reveals scheduled prompts (which can include
    // sensitive instructions). Require auth.
    const err = await requireAgentOrOperator(c);
    if (err) return err;
    const agentId = c.req.query("agent_id");
    return c.json(store.listHeartbeats(agentId ?? undefined));
  });

  app.delete("/heartbeats/:id", async (c) => {
    // Deleting another agent's scheduled prompts is a mutation; require auth.
    const err = await requireAgentOrOperator(c);
    if (err) return err;
    const id = c.req.param("id");
    heartbeats.remove(id);
    return c.json({ deleted: id });
  });

  // --- Plugin settings (generic KV per plugin namespace) ---

  /**
   * List all settings under a namespace.
   * Public read by design — namespaces are broadcast-friendly. The
   * wallet-vault directory specifically is consumed by the browser
   * extension (kind=integration) which doesn't carry a signing key for
   * casual reads, and by any dashboard. INTEGRITY (writes) is gated by
   * namespace ownership (PUT/DELETE require requireAuthenticatedAgent
   * below) — that's where the security boundary lives.
   */
  app.get("/plugin_settings/:namespace", (c) => {
    const namespace = c.req.param("namespace");
    return c.json(store.listPluginSettings(namespace));
  });

  /** Read a single setting key. Public read — see above. */
  app.get("/plugin_settings/:namespace/:key", (c) => {
    const namespace = c.req.param("namespace");
    const key = c.req.param("key");
    const value = store.getPluginSetting(namespace, key);
    if (value === null) return c.json({ error: "not found" }, 404);
    return c.json({ namespace, key, value });
  });

  /**
   * Write a setting. Auth: operator OR an authenticated agent whose ID
   * matches the namespace (i.e. the wallet-vault integration writes the
   * wallet-vault namespace; brioche cannot scribble on it).
   */
  app.put("/plugin_settings/:namespace/:key", async (c) => {
    const namespace = c.req.param("namespace");
    const key = c.req.param("key");

    let writer: string;
    if (isOperator(c)) {
      writer = "operator";
    } else {
      const auth = await requireAuthenticatedAgent(c);
      if (auth instanceof Response) return auth;
      if (auth.agentId !== namespace) {
        return c.json({
          error: `agent '${auth.agentId}' cannot write namespace '${namespace}' (writer must be operator or match the namespace)`,
        }, 403);
      }
      writer = auth.agentId;
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "body must be valid JSON" }, 400);
    }
    const value = (body as { value?: unknown })?.value;
    if (value === undefined) {
      return c.json({ error: "body.value is required" }, 400);
    }

    store.setPluginSetting(namespace, key, value, writer);

    // Notify subscribers. Broadcast (no dest) so any agent or integration
    // that subscribes to "plugin_settings.updated" gets the live mutation.
    router.route({
      source: "wire",
      topic: "plugin_settings.updated",
      payload: JSON.stringify({ namespace, key, value, updated_by: writer, updated_at: Date.now() }),
    });

    return c.json({ namespace, key, value, updated_by: writer });
  });

  /** Delete a setting. Same auth as PUT. */
  app.delete("/plugin_settings/:namespace/:key", async (c) => {
    const namespace = c.req.param("namespace");
    const key = c.req.param("key");

    let writer: string;
    if (isOperator(c)) {
      writer = "operator";
    } else {
      const auth = await requireAuthenticatedAgent(c);
      if (auth instanceof Response) return auth;
      if (auth.agentId !== namespace) {
        return c.json({
          error: `agent '${auth.agentId}' cannot delete from namespace '${namespace}'`,
        }, 403);
      }
      writer = auth.agentId;
    }

    const removed = store.deletePluginSetting(namespace, key);
    if (removed) {
      router.route({
        source: "wire",
        topic: "plugin_settings.deleted",
        payload: JSON.stringify({ namespace, key, deleted_by: writer, deleted_at: Date.now() }),
      });
    }
    return c.json({ namespace, key, deleted: removed });
  });

  // --- Dashboard ---

  app.get("/", (c) => {
    if (!isOperator(c)) {
      return c.html(renderLogin(store.hasOwner()));
    }

    // Resolve operator name — token auth uses a generic name
    const operatorId = getOperatorFromSession(c.req.header("cookie"), store);
    const operator = operatorId ? store.getOperator(operatorId) : null;
    const displayName = operator?.display_name ?? "Operator";

    // Hide reaped EPHEMERAL agents — they're transient and clutter the
    // dashboard. Reaped PERMANENT agents (personai) stay visible (greyed)
    // so operators see their persistent team at a glance even when not
    // currently running. All identity rows stay in the DB; reaped-
    // readmission un-greys both kinds on next register/connect/heartbeat.
    const agents = store.getAllAgents()
      .filter((a) => a.reaped_at == null || a.permanent === 1)
      .map((a) => ({
        ...a,
        online: emitter.isConnected(a.id) || store.hasConnectedSession(a.id),
        sessions: store.getActiveSessions(a.id).length,
      }));

    // Set token cookie if auth was via query param (so subsequent fetches are auto-authenticated)
    const tokenParam = new URL(c.req.url).searchParams.get("token");
    const headers: Record<string, string> = {};
    if (tokenParam && tokenParam === DASHBOARD_TOKEN) {
      headers["Set-Cookie"] = `wire_token=${tokenParam}; Path=/; HttpOnly; SameSite=Strict; Max-Age=604800`;
    }
    return c.html(_renderDashboard(agents, displayName), 200, headers);
  });

  // --- Recent messages endpoint (for dashboard backfill) ---

  app.get("/messages/recent", (c) => {
    if (!isOperator(c)) {
      return c.json({ error: "unauthorized" }, 401);
    }
    const limit = parseInt(c.req.query("limit") ?? "50", 10);
    const messages = store.getRecentIpcLogMessages(limit).map((msg) => {
      let content: unknown;
      try {
        const envelope = JSON.parse(msg.payload);
        content = envelope.payload ?? msg.payload;
      } catch { content = msg.payload; }
      return {
        seq: msg.seq,
        source: msg.source,
        dest: msg.dest,
        topic: msg.topic,
        content,
        deliveries: [],
        created_at: msg.created_at,
      };
    });
    return c.json(messages);
  });

  // --- Dashboard SSE (live agent status) ---

  app.get("/dashboard/stream", (c) => {
    if (!isOperator(c)) {
      return c.json({ error: "unauthorized" }, 401);
    }

    return new Response(
      new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder();
          const write = (data: string) => {
            try { controller.enqueue(encoder.encode(data)); } catch {}
          };

          // Send initial state. Hide reaped EPHEMERAL agents — they're
          // transient debris. Keep reaped permanents (personai) visible,
          // greyed, so operators see their team at a glance.
          const sendState = () => {
            const agents = store.getAllAgents()
              .filter((a) => a.reaped_at == null || a.permanent === 1)
              .map((a) => ({
                ...a,
                online: emitter.isConnected(a.id) || store.hasConnectedSession(a.id),
                sessions: store.getActiveSessions(a.id).length,
              }));
            write(`data: ${JSON.stringify(agents)}\n\n`);
          };

          sendState();

          // Push on state changes + poll every 3s as fallback
          dashboardStateListeners.add(sendState);
          const interval = setInterval(sendState, 3000);

          // Live message log (backfill handled client-side via /messages/recent).
          // Match the same IPC-family pattern as store.getRecentIpcLogMessages:
          // legacy `ipc`/`ipc.*` and the webhook-envelope `webhook.ipc`/`webhook.ipc.*`.
          // Anything else (webhook.github, webhook.operator-relay, heartbeat, etc.)
          // belongs in other panels, not the agent-to-agent IPC log.
          const unsubRoute = router.onRoute((msg, deliveries) => {
            const t = msg.topic;
            const isIpcFamily =
              t === "ipc" ||
              t.startsWith("ipc.") ||
              t === "webhook.ipc" ||
              t.startsWith("webhook.ipc.");
            if (!isIpcFamily) return;
            let content: unknown;
            try {
              const envelope = JSON.parse(msg.payload);
              content = envelope.payload ?? msg.payload;
            } catch { content = msg.payload; }
            write(`event: wire_message\ndata: ${JSON.stringify({
              seq: msg.seq,
              source: msg.source,
              dest: msg.dest,
              topic: msg.topic,
              content,
              deliveries,
              created_at: msg.created_at,
            })}\n\n`);
          });

          // Hot-reload: tell client to refresh when dashboard.ts changes
          const onRefresh = () => {
            write(`event: refresh\ndata: reload\n\n`);
          };
          dashboardRefreshListeners.add(onRefresh);

          c.req.raw.signal.addEventListener("abort", () => {
            clearInterval(interval);
            unsubRoute();
            dashboardStateListeners.delete(sendState);
            dashboardRefreshListeners.delete(onRefresh);
          });
        },
      }),
      {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      },
    );
  });

  // --- Auth: Registration (first-claim or invite) ---

  app.post("/auth/register/options", async (c) => {
    const body = await c.req.json();
    const displayName = body.display_name ?? "Operator";

    if (store.hasOwner()) {
      return c.json({ error: "instance already claimed" }, 403);
    }

    const operatorId = crypto.randomUUID();
    const options = generateRegistrationOptions(store, operatorId, displayName);
    return c.json({ ...options, _operatorId: operatorId });
  });

  app.post("/auth/register/verify", async (c) => {
    const body = await c.req.json();
    const { id, rawId, response: resp, display_name, type } = body;

    if (!id || !resp?.attestationObject || !resp?.clientDataJSON) {
      return c.json({ error: "invalid registration response" }, 400);
    }

    // First-claim-owns: only the first passkey claims ownership. Once an owner
    // exists, registration is closed — additional operators arrive via the
    // request/approve flow (not yet built), never by self-registering.
    if (store.hasOwner()) {
      return c.json({ error: "instance already claimed" }, 403);
    }

    // Full FIDO2 attestation verification: checks the challenge was one we
    // issued (and consumes it, one-time), the origin/RP ID match, and extracts
    // the COSE public key we'll verify future assertions against.
    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response: {
          id,
          rawId,
          response: {
            clientDataJSON: resp.clientDataJSON,
            attestationObject: resp.attestationObject,
            transports: resp.transports,
          },
          clientExtensionResults: {},
          type: type ?? "public-key",
        },
        expectedChallenge: (ch) => store.consumeChallenge(ch),
        expectedOrigin: getExpectedOrigins(),
        expectedRPID: getRpIds(),
        requireUserVerification: false,
      });
    } catch (e: any) {
      return c.json({ error: `registration verification failed: ${e.message}` }, 400);
    }

    if (!verification.verified || !verification.registrationInfo) {
      return c.json({ error: "registration not verified" }, 400);
    }

    const { credential } = verification.registrationInfo;
    const operatorId = crypto.randomUUID();
    const token = crypto.randomUUID();
    store.createOperator(operatorId, display_name ?? "Operator", "owner", token);
    store.upsertCredential(
      credential.id,
      operatorId,
      Buffer.from(credential.publicKey),
      credential.counter,
      credential.transports?.join(","),
    );

    const { cookie } = createAuthSession(operatorId, store);
    c.header("Set-Cookie", cookie);
    return c.json({ registered: true, role: "owner" });
  });

  // --- Auth: Login ---

  app.post("/auth/login/options", async (c) => {
    const options = generateAuthenticationOptions(store);

    // Don't send allowCredentials — let the browser use discoverable credentials (passkeys).
    // This avoids the ArrayBuffer conversion issue and is the modern passkey flow.
    return c.json(options);
  });

  app.post("/auth/login/verify", async (c) => {
    const body = await c.req.json();
    const { id, rawId, response: resp, type } = body;

    if (!id || !resp?.clientDataJSON || !resp?.authenticatorData || !resp?.signature) {
      return c.json({ error: "invalid authentication response" }, 400);
    }

    const stored = store.getCredential(id);
    if (!stored) {
      return c.json({ error: "unknown credential" }, 401);
    }

    // Full FIDO2 assertion verification: the signature over
    // authenticatorData ‖ SHA-256(clientDataJSON) must verify against the stored
    // public key, the challenge must be one we issued (consumed one-time), and
    // the origin/RP ID must match. Nothing here trusts the client's say-so.
    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response: {
          id,
          rawId,
          response: {
            clientDataJSON: resp.clientDataJSON,
            authenticatorData: resp.authenticatorData,
            signature: resp.signature,
            userHandle: resp.userHandle,
          },
          clientExtensionResults: {},
          type: type ?? "public-key",
        },
        expectedChallenge: (ch) => store.consumeChallenge(ch),
        expectedOrigin: getExpectedOrigins(),
        expectedRPID: getRpIds(),
        credential: {
          id: stored.credential_id,
          publicKey: new Uint8Array(stored.public_key),
          counter: stored.counter,
        },
        requireUserVerification: false,
      });
    } catch (e: any) {
      return c.json({ error: `authentication failed: ${e.message}` }, 401);
    }

    if (!verification.verified) {
      return c.json({ error: "authentication failed" }, 401);
    }

    // Persist the rolling signature counter to detect cloned authenticators.
    store.updateCredentialCounter(stored.credential_id, verification.authenticationInfo.newCounter);

    const { cookie } = createAuthSession(stored.operator_id, store);
    c.header("Set-Cookie", cookie);
    return c.json({ authenticated: true });
  });

  app.get("/auth/logout", (c) => {
    c.header("Set-Cookie", "wire_session=; Path=/; HttpOnly; Max-Age=0");
    return c.redirect("/");
  });

  // --- Catch-all ---

  app.all("*", (c) => {
    return c.json({ error: "not found" }, 404);
  });

  // --- Start ---

  const server = Bun.serve({
    port,
    fetch: app.fetch,
    idleTimeout: 255, // seconds; default 12s kills SSE connections
  });

  return server;
}

// --- Webhook Responder (VM-lite, post-validator short-circuit) ---

async function runResponder(
  code: string,
  ctx: {
    headers: Record<string, string>;
    body: string;
    parsedBody: unknown;
    secrets: Record<string, string>;
  },
): Promise<unknown> {
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const fn = new AsyncFunction("headers", "body", "parsedBody", "secrets", code);
  return await fn(ctx.headers, ctx.body, ctx.parsedBody, ctx.secrets);
}

// --- Webhook Validator (VM-lite) ---

async function runValidator(
  code: string,
  ctx: {
    headers: Record<string, string>;
    body: string;
    secrets: Record<string, string>;
    directory?: Record<string, { pubkey: string; display_name: string }>;
  },
): Promise<unknown> {
  // Use AsyncFunction constructor for lightweight validation.
  // The validator runs in the same process — the trust model is
  // "operator trusts agent-provided code" (same as installing a plugin).
  // AsyncFunction allows validators to use await (e.g., crypto.subtle).
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const fn = new AsyncFunction(
    "headers",
    "body",
    "secrets",
    "crypto",
    "directory",
    "rawBody",
    code,
  );
  const rawBody = ctx.body;
  return await fn(ctx.headers, ctx.body, ctx.secrets, {
    subtle: crypto.subtle,
    createHmac: (algo: string, key: string) => {
      const encoder = new TextEncoder();
      const keyData = encoder.encode(key);
      return {
        update(data: string) {
          const d = encoder.encode(data);
          (this as any)._data = d;
          (this as any)._keyData = keyData;
          (this as any)._algo = algo;
          return this;
        },
        async digest(encoding: string) {
          const k = await crypto.subtle.importKey(
            "raw",
            (this as any)._keyData,
            { name: "HMAC", hash: (this as any)._algo === "sha256" ? "SHA-256" : "SHA-512" },
            false,
            ["sign"],
          );
          const sig = await crypto.subtle.sign("HMAC", k, (this as any)._data);
          return Buffer.from(sig).toString(encoding as BufferEncoding);
        },
      };
    },
    // Ed25519 verify (available to all validators)
    async verifyEd25519(pubkeyB64: string, signatureB64: string, data: string): Promise<boolean> {
      try {
        const pubBytes = Uint8Array.from(atob(pubkeyB64), (c) => c.charCodeAt(0));
        const sigBytes = Uint8Array.from(atob(signatureB64), (c) => c.charCodeAt(0));
        const dataBytes = new TextEncoder().encode(data);
        const key = await crypto.subtle.importKey("raw", pubBytes, { name: "Ed25519" }, false, ["verify"]);
        return await crypto.subtle.verify("Ed25519", key, sigBytes, dataBytes);
      } catch {
        return false;
      }
    },
  }, ctx.directory ?? {}, rawBody);
}
