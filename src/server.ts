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
 *   POST /agents/:id/webhooks            — register webhook for agent
 *   POST /webhooks/:agent/:plugin        — inbound webhook delivery
 *   GET  /                               — dashboard (WebAuthn protected, future)
 */

import { existsSync, readFileSync, watch, watchFile } from "fs";
import { homedir } from "os";
import { join } from "path";
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
} from "./auth.js";
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

export function createServer({ port, store, router, emitter, log }: ServerDeps) {
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

  // --- Agent Registry ---

  app.get("/agents", (c) => {
    const agents = store.getAllAgents();
    const result = agents.map((a) => ({
      ...a,
      online: emitter.isConnected(a.id) || store.hasConnectedSession(a.id),
      sessions: store.getActiveSessions(a.id).length,
    }));
    return c.json(result);
  });

  app.post("/agents/register", async (c) => {
    const body = await c.req.json();
    const { id, display_name, pubkey, permanent } = body;

    if (!id || !display_name || !pubkey) {
      return c.json({ error: "missing required fields: id, display_name, pubkey" }, 400);
    }

    const existing = store.getAgent(id);
    if (existing && existing.permanent) {
      // Permanent agent re-registering — must prove identity
      const err = await requireAgent(c, id);
      if (err) return err;
    } else if (existing && !existing.permanent) {
      // Ephemeral agent re-registering — allow the agent itself or any sponsoring agent
      const selfErr = await requireAgent(c, id);
      if (selfErr) {
        const sponsorErr = await requireAgentOrOperator(c);
        if (sponsorErr) return sponsorErr;
      }
    } else if (permanent) {
      // New permanent agent — operator only
      const err = requireOperator(c);
      if (err) return err;
    } else {
      // New ephemeral agent — check for a reaped agent with matching pubkey (re-admission)
      const reaped = store.getReapedAgent(id);
      if (reaped && reaped.pubkey === pubkey) {
        // Same agent, same key — let them back in
      } else {
        // Truly new — must be registered by an authenticated agent or operator
        const err = await requireAgentOrOperator(c);
        if (err) return err;
      }
    }

    store.upsertAgent({ id, display_name, pubkey, permanent: !!permanent });

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
      }
    }

    store.touchAgent(agentId);
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

  app.get("/agents/:id/recent", (c) => {
    const agentId = c.req.param("id");
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

          const session = store.getSession(sessionId!);
          const replaySeq = session?.last_ack_seq ?? 0;
          log.info({ event: "sse_replay", agentId, sessionId, fromSeq: replaySeq }, "SSE replaying backlog");
          router.replay(agentId, sessionId!);

          c.req.raw.signal.addEventListener("abort", () => {
            log.info({ event: "sse_abort", agentId, sessionId }, "SSE client disconnected");
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

  // --- Webhook Registration ---

  app.post("/agents/:id/webhooks", async (c) => {
    const agentId = c.req.param("id");

    // Authenticated agent or operator can register webhooks
    const err = await requireAgentOrOperator(c);
    if (err) return err;

    const body = await c.req.json();
    const { plugin, name, validator, webhook_secret, filter: filterExpr, meta, cleanup, dedup } = body;

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
        const agents = store.getAllAgents();
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

    // Build envelope and route
    const envelope = {
      source,
      topic,
      dest: agentId,
      plugin,
      headers,
      payload: parsedBody,
    };

    const dedupKey = (c as any).get("dedupKey") as string | undefined;
    const { message, deliveries } = router.route({
      source,
      source_id: dedupKey,
      dest: agentId,
      topic,
      payload: JSON.stringify(envelope),
      raw: rawBody,
    });

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

  // --- Dashboard ---

  app.get("/", (c) => {
    if (!isOperator(c)) {
      return c.html(renderLogin(store.hasOwner()));
    }

    // Resolve operator name — token auth uses a generic name
    const operatorId = getOperatorFromSession(c.req.header("cookie"), store);
    const operator = operatorId ? store.getOperator(operatorId) : null;
    const displayName = operator?.display_name ?? "Operator";

    const agents = store.getAllAgents().map((a) => ({
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
    const messages = store.getRecentMessagesByCount(limit).map((msg) => {
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

  // --- Tasks endpoint ---

  app.get("/tasks", (c) => {
    if (!isOperator(c)) {
      return c.json({ error: "unauthorized" }, 401);
    }
    const tasksPath = join(homedir(), ".wire", "tasks.json");
    if (!existsSync(tasksPath)) {
      return c.json({ tasks: [], completed: [] });
    }
    try {
      const data = JSON.parse(readFileSync(tasksPath, "utf-8"));
      return c.json(data, 200, {
        "Cache-Control": "no-cache, no-store, must-revalidate",
        "Pragma": "no-cache",
      });
    } catch {
      return c.json({ error: "failed to read tasks" }, 500);
    }
  });

  app.get("/tasks/stream", (c) => {
    if (!isOperator(c)) {
      return c.json({ error: "unauthorized" }, 401);
    }
    const tasksPath = join(homedir(), ".wire", "tasks.json");

    return new Response(
      new ReadableStream({
        start(controller) {
          const enc = new TextEncoder();
          const send = () => {
            try {
              if (existsSync(tasksPath)) {
                const data = readFileSync(tasksPath, "utf-8");
                controller.enqueue(enc.encode(`data: ${data.replace(/\n/g, "")}\n\n`));
              }
            } catch {}
          };
          // Send initial state
          send();
          // Watch for file changes
          if (existsSync(tasksPath)) {
            const watcher = watch(tasksPath, { persistent: false }, () => send());
            c.req.raw.signal.addEventListener("abort", () => watcher.close());
          }
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

          // Send initial state
          const sendState = () => {
            const agents = store.getAllAgents().map((a) => ({
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

          // Live message log (backfill handled client-side via /messages/recent)
          const unsubRoute = router.onRoute((msg, deliveries) => {
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
    const { id, rawId, response: resp, display_name } = body;

    if (!id || !resp?.attestationObject || !resp?.clientDataJSON) {
      return c.json({ error: "invalid registration response" }, 400);
    }

    // Store the credential — simplified verification for passkey registration.
    // Full FIDO2 attestation verification requires cbor decoding of the attestation object.
    // For the local trust model (operator on own machine), we store the credential ID
    // and extract the public key on first auth.
    const operatorId = body._operatorId ?? crypto.randomUUID();
    const role = store.hasOwner() ? "member" : "owner";
    const token = crypto.randomUUID();

    store.createOperator(operatorId, display_name ?? "Operator", role, token);

    // Store credential with attestation as public key placeholder
    const attestationBytes = Buffer.from(rawId, "base64url");
    store.upsertCredential(id, operatorId, attestationBytes, 0);

    const { cookie } = createAuthSession(operatorId, store);
    c.header("Set-Cookie", cookie);
    return c.json({ registered: true, role });
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
    const { id } = body;

    if (!id) {
      return c.json({ error: "missing credential id" }, 400);
    }

    const credential = store.getCredential(id);
    if (!credential) {
      return c.json({ error: "unknown credential" }, 401);
    }

    // Simplified verification: credential exists and belongs to a registered operator.
    // Full FIDO2 assertion verification (signature check against stored public key)
    // requires extracting the COSE public key from the attestation, which we defer.
    // The trust model is local machine — passkey biometric IS the auth.
    const { cookie } = createAuthSession(credential.operator_id, store);
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
  });

  return server;
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
