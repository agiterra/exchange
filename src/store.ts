/**
 * SQLite Store — the center of gravity.
 *
 * Every message gets a monotonic sequence number on write.
 * Each consumer has its own cursor (last_ack_seq on agent_sessions).
 * Replay is WHERE seq > last_ack_seq ORDER BY seq ASC.
 */

import { Database } from "bun:sqlite";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS messages (
    seq         INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at  INTEGER NOT NULL,
    source      TEXT NOT NULL,
    source_id   TEXT,
    dest        TEXT,
    topic       TEXT NOT NULL,
    payload     TEXT NOT NULL,
    raw         TEXT
);
CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);
CREATE INDEX IF NOT EXISTS idx_messages_topic ON messages(topic);
CREATE INDEX IF NOT EXISTS idx_messages_source_id ON messages(source, source_id);

CREATE TABLE IF NOT EXISTS agents (
    id              TEXT PRIMARY KEY,
    display_name    TEXT NOT NULL,
    pubkey          TEXT NOT NULL,
    permanent       INTEGER NOT NULL DEFAULT 0,
    created_at      INTEGER NOT NULL,
    last_seen_at    INTEGER,
    plan            TEXT,
    reaped_at       INTEGER,
    -- Identity kind. Default 'agent' = a humanlike participant (Claude session,
    -- codex agent, operator). Other kinds (e.g. 'integration') share the same
    -- Ed25519 + JWT + SSE plumbing but are filtered out of the default agent
    -- list so they don't pollute the crew dashboard.
    kind            TEXT NOT NULL DEFAULT 'agent'
);

CREATE TABLE IF NOT EXISTS agent_sessions (
    id              TEXT PRIMARY KEY,
    agent_id        TEXT NOT NULL REFERENCES agents(id),
    runtime         TEXT NOT NULL,
    name_url     TEXT,
    connected_at    INTEGER,
    disconnected_at INTEGER,
    last_ack_seq    INTEGER NOT NULL DEFAULT 0,
    updated_at      INTEGER NOT NULL,
    last_heartbeat  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_agent_sessions_agent ON agent_sessions(agent_id);

CREATE TABLE IF NOT EXISTS subscriptions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id    TEXT NOT NULL REFERENCES agents(id),
    topic       TEXT NOT NULL,
    filter      TEXT,
    created_at  INTEGER NOT NULL,
    UNIQUE(agent_id, topic)
);
CREATE INDEX IF NOT EXISTS idx_subscriptions_agent ON subscriptions(agent_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_topic ON subscriptions(topic);

CREATE TABLE IF NOT EXISTS delivery_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    message_seq INTEGER NOT NULL,
    agent_id    TEXT NOT NULL,
    attempted_at INTEGER NOT NULL,
    result      TEXT NOT NULL,
    error       TEXT
);
CREATE INDEX IF NOT EXISTS idx_delivery_log_message ON delivery_log(message_seq);
CREATE INDEX IF NOT EXISTS idx_delivery_log_agent ON delivery_log(agent_id, attempted_at);

CREATE TABLE IF NOT EXISTS webhooks (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id    TEXT NOT NULL REFERENCES agents(id),
    plugin      TEXT NOT NULL,
    name     TEXT NOT NULL,
    validator   TEXT,
    secrets_map TEXT,
    filter      TEXT,
    meta        TEXT,
    cleanup     TEXT,
    dedup       TEXT,
    created_at  INTEGER NOT NULL,
    UNIQUE(agent_id, plugin, name)
);
CREATE INDEX IF NOT EXISTS idx_webhooks_agent ON webhooks(agent_id);
CREATE INDEX IF NOT EXISTS idx_webhooks_plugin ON webhooks(agent_id, plugin);

CREATE TABLE IF NOT EXISTS operators (
    id              TEXT PRIMARY KEY,
    display_name    TEXT NOT NULL,
    role            TEXT NOT NULL DEFAULT 'member',
    token           TEXT NOT NULL UNIQUE,
    created_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS invites (
    code            TEXT PRIMARY KEY,
    created_by      TEXT NOT NULL REFERENCES operators(id),
    label           TEXT,
    used_by         TEXT REFERENCES operators(id),
    created_at      INTEGER NOT NULL,
    used_at         INTEGER
);

CREATE TABLE IF NOT EXISTS passkey_credentials (
    credential_id   TEXT PRIMARY KEY,
    operator_id     TEXT NOT NULL REFERENCES operators(id),
    public_key      BLOB NOT NULL,
    counter         INTEGER NOT NULL DEFAULT 0,
    transports      TEXT,
    created_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS heartbeats (
    id              TEXT PRIMARY KEY,
    agent_id        TEXT NOT NULL,
    cron            TEXT NOT NULL,
    prompt          TEXT NOT NULL,
    created_by      TEXT NOT NULL,
    active          INTEGER NOT NULL DEFAULT 1,
    last_fired      INTEGER,
    created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_heartbeats_agent ON heartbeats(agent_id);

CREATE TABLE IF NOT EXISTS challenges (
    id              TEXT PRIMARY KEY,
    challenge       TEXT NOT NULL,
    created_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS operator_sessions (
    id              TEXT PRIMARY KEY,
    operator_id     TEXT NOT NULL REFERENCES operators(id),
    created_at      INTEGER NOT NULL,
    expires_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_operator_sessions_operator ON operator_sessions(operator_id);

-- Peers table (v1.1.0 federation). Each Wire keeps a local list of
-- peer instances it knows how to forward messages to. There is no
-- central registry — pair peers by running 'wire peer add' on both
-- sides with the other's base_url + server pubkey (output of
-- 'wire peer pubkey'). Pubkeys are stable; base_url may rotate when
-- ngrok tunnels restart (update via 'wire peer update-url').
CREATE TABLE IF NOT EXISTS peers (
    name            TEXT PRIMARY KEY,        -- user alias ('home-mini')
    base_url        TEXT NOT NULL,           -- 'https://random.ngrok.app'
    pubkey          TEXT NOT NULL,           -- base64 Ed25519 pubkey of the peer Wire
    added_at        INTEGER NOT NULL,
    last_seen       INTEGER,
    notes           TEXT
);
CREATE INDEX IF NOT EXISTS idx_peers_pubkey ON peers(pubkey);
`;

export type Message = {
  seq: number;
  created_at: number;
  source: string;
  source_id: string | null;
  source_cc_session: string | null;
  dest: string | null;
  topic: string;
  payload: string;
  raw: string | null;
};

/** Identity-kind discriminator on the agents table. */
export type AgentKind = "agent" | "integration";

export type Agent = {
  id: string;
  display_name: string;
  pubkey: string;
  permanent: number; // 0 or 1 (SQLite boolean)
  created_at: number;
  last_seen_at: number | null;
  plan: string | null;
  pronouns: string | null;
  /** Timestamp of soft-reap (greyed-out). NULL when agent is active. */
  reaped_at: number | null;
  /**
   * Identity kind. 'agent' is the default and covers Claude / codex / operator
   * participants. 'integration' is for service integrations (e.g. the
   * wallet-vault Chrome extension) — same auth + transport, filtered out of
   * the default agent list.
   */
  kind: AgentKind;
};

export type SessionStatus = "connected" | "stale" | "disconnected";

export type AgentSession = {
  id: string;
  agent_id: string;
  runtime: string;
  name_url: string | null;
  connected_at: number | null;
  disconnected_at: number | null;
  last_ack_seq: number;
  updated_at: number;
  last_heartbeat: number | null;
  status: SessionStatus;
  cc_session_id: string | null;
};

export type Webhook = {
  id: number;
  agent_id: string;
  plugin: string;
  name: string;
  validator: string | null;
  secrets_map: string | null;
  filter: string | null;
  meta: string | null;
  cleanup: string | null;
  dedup: string | null;
  created_at: number;
};


export type Heartbeat = {
  id: string;
  agent_id: string;
  cron: string;
  prompt: string;
  created_by: string;
  active: number;
  last_fired: number | null;
  created_at: number;
};

export type Peer = {
  name: string;
  base_url: string;
  pubkey: string;
  added_at: number;
  last_seen: number | null;
  notes: string | null;
};

export class Store {
  private db: Database;

  constructor(dbPath?: string) {
    const path = dbPath ?? process.env.WIRE_DB ?? `${process.env.HOME}/.wire/wire.db`;
    this.db = new Database(path);
    this.db.exec("PRAGMA journal_mode=WAL;");
    this.db.exec("PRAGMA foreign_keys=ON;");
    this.db.exec(SCHEMA);
    this.migrate();
  }

  private migrate(): void {
    // Add permanent column if missing (pre-v0.4.0 databases)
    const cols = this.db.prepare("PRAGMA table_info(agents)").all() as { name: string }[];
    if (!cols.some((c) => c.name === "permanent")) {
      this.db.exec("ALTER TABLE agents ADD COLUMN permanent INTEGER NOT NULL DEFAULT 0");
    }

    // Add status column to agent_sessions (session lifecycle spec)
    const sessionCols = this.db.prepare("PRAGMA table_info(agent_sessions)").all() as { name: string }[];
    if (!sessionCols.some((c) => c.name === "status")) {
      this.db.exec("ALTER TABLE agent_sessions ADD COLUMN status TEXT NOT NULL DEFAULT 'connected'");
      this.db.exec("UPDATE agent_sessions SET status = 'disconnected' WHERE disconnected_at IS NOT NULL");
    }
    // Migrate old "reaped" status to "disconnected"
    this.db.exec("UPDATE agent_sessions SET status = 'disconnected' WHERE status = 'reaped'");

    // Add cc_session_id column — identifies the Claude Code session (survives SSE reconnects)
    if (!sessionCols.some((c) => c.name === "cc_session_id")) {
      this.db.exec("ALTER TABLE agent_sessions ADD COLUMN cc_session_id TEXT");
    }

    // Add source_cc_session to messages — sender's CC session for reply targeting
    const msgCols = this.db.prepare("PRAGMA table_info(messages)").all() as { name: string }[];
    if (!msgCols.some((c) => c.name === "source_cc_session")) {
      this.db.exec("ALTER TABLE messages ADD COLUMN source_cc_session TEXT");
    }

    // Add filter + meta columns to webhooks (name plugin infrastructure)
    const whCols = this.db.prepare("PRAGMA table_info(webhooks)").all() as { name: string }[];
    if (!whCols.some((c) => c.name === "filter")) {
      this.db.exec("ALTER TABLE webhooks ADD COLUMN filter TEXT");
    }
    if (!whCols.some((c) => c.name === "meta")) {
      this.db.exec("ALTER TABLE webhooks ADD COLUMN meta TEXT");
    }
    if (!whCols.some((c) => c.name === "cleanup")) {
      this.db.exec("ALTER TABLE webhooks ADD COLUMN cleanup TEXT");
    }
    if (!whCols.some((c) => c.name === "name")) {
      this.db.exec("ALTER TABLE webhooks ADD COLUMN name TEXT NOT NULL DEFAULT 'default'");
      this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_webhooks_name ON webhooks(agent_id, plugin, name)");
    }
    // Rebuild webhooks table to replace UNIQUE(agent_id, plugin) with UNIQUE(agent_id, plugin, name)
    const tableInfo = this.db.prepare("SELECT sql FROM sqlite_master WHERE tbl_name = 'webhooks' AND type = 'table'").get() as { sql: string } | null;
    if (tableInfo?.sql.includes("UNIQUE(agent_id, plugin)") && !tableInfo.sql.includes("UNIQUE(agent_id, plugin, name)")) {
      this.db.exec(`
        CREATE TABLE webhooks_new (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          agent_id    TEXT NOT NULL REFERENCES agents(id),
          plugin      TEXT NOT NULL,
          name        TEXT NOT NULL DEFAULT 'default',
          validator   TEXT,
          secrets_map TEXT,
          filter      TEXT,
          meta        TEXT,
          cleanup     TEXT,
          created_at  INTEGER NOT NULL,
          UNIQUE(agent_id, plugin, name)
        );
        INSERT INTO webhooks_new SELECT id, agent_id, plugin, name, validator, secrets_map, filter, meta, cleanup, created_at FROM webhooks;
        DROP TABLE webhooks;
        ALTER TABLE webhooks_new RENAME TO webhooks;
        CREATE INDEX idx_webhooks_agent ON webhooks(agent_id);
        CREATE INDEX idx_webhooks_plugin ON webhooks(agent_id, plugin);
      `);
    }

    // Add reaped_at column to agents
    const agentCols2 = this.db.prepare("PRAGMA table_info(agents)").all() as { name: string }[];
    if (!agentCols2.some((c) => c.name === "reaped_at")) {
      this.db.exec("ALTER TABLE agents ADD COLUMN reaped_at INTEGER");
    }

    // Add dedup column to webhooks
    const whCols2 = this.db.prepare("PRAGMA table_info(webhooks)").all() as { name: string }[];
    if (!whCols2.some((c) => c.name === "dedup")) {
      this.db.exec("ALTER TABLE webhooks ADD COLUMN dedup TEXT");
    }

    // Add pronouns column to agents
    const agentCols3 = this.db.prepare("PRAGMA table_info(agents)").all() as { name: string }[];
    if (!agentCols3.some((c) => c.name === "pronouns")) {
      this.db.exec("ALTER TABLE agents ADD COLUMN pronouns TEXT");
    }

    // Add kind column to agents (identity-type discriminator). Default 'agent'.
    // Other values: 'integration' (e.g. wallet-vault browser extension, future
    // first-class service integrations). Sharing the agents table keeps the
    // same Ed25519 + JWT + SSE plumbing; the column just controls which
    // list-style endpoints surface the row.
    const agentCols4 = this.db.prepare("PRAGMA table_info(agents)").all() as { name: string }[];
    if (!agentCols4.some((c) => c.name === "kind")) {
      this.db.exec("ALTER TABLE agents ADD COLUMN kind TEXT NOT NULL DEFAULT 'agent'");
    }

    // Index source_id on messages for dedup lookups
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_messages_source_id ON messages(source_id)");
  }

  // --- Messages ---

  getMessageBySourceId(sourceId: string): Message | null {
    return (this.db.prepare(
      "SELECT * FROM messages WHERE source_id = ? LIMIT 1"
    ).get(sourceId) as Message) ?? null;
  }

  writeMessage(msg: {
    source: string;
    source_id?: string;
    source_cc_session?: string;
    dest?: string;
    topic: string;
    payload: string;
    raw?: string;
  }): Message {
    const now = Date.now();
    const stmt = this.db.prepare(`
      INSERT INTO messages (created_at, source, source_id, source_cc_session, dest, topic, payload, raw)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(now, msg.source, msg.source_id ?? null, msg.source_cc_session ?? null, msg.dest ?? null, msg.topic, msg.payload, msg.raw ?? null);
    const seq = this.db.prepare("SELECT last_insert_rowid() as seq").get() as { seq: number };
    return {
      seq: seq.seq,
      created_at: now,
      source: msg.source,
      source_id: msg.source_id ?? null,
      source_cc_session: msg.source_cc_session ?? null,
      dest: msg.dest ?? null,
      topic: msg.topic,
      payload: msg.payload,
      raw: msg.raw ?? null,
    };
  }

  getMessages(sinceSeq: number, limit = 100): Message[] {
    return this.db.prepare(
      "SELECT * FROM messages WHERE seq > ? ORDER BY seq ASC LIMIT ?"
    ).all(sinceSeq, limit) as Message[];
  }

  getRecentMessagesByCount(limit = 50, topic?: string): Message[] {
    if (topic) {
      return this.db.prepare(
        "SELECT * FROM (SELECT * FROM messages WHERE topic = ? ORDER BY seq DESC LIMIT ?) ORDER BY seq ASC"
      ).all(topic, limit) as Message[];
    }
    return this.db.prepare(
      "SELECT * FROM (SELECT * FROM messages ORDER BY seq DESC LIMIT ?) ORDER BY seq ASC"
    ).all(limit) as Message[];
  }

  /**
   * Recent IPC-family messages for the dashboard log.
   *
   * The dashboard's "Message Log" is supposed to surface agent-to-agent IPC.
   * Historically the topic was `ipc`, but the wire-ipc adapter now wraps
   * payloads in a webhook envelope and routes under `webhook.ipc` (and
   * sub-topics `webhook.ipc.task` etc). The legacy `ipc` topic stopped
   * receiving writes on 2026-04-01 once everyone moved to the envelope,
   * which is why the dashboard log silently froze.
   *
   * Match: `ipc`, `ipc.*`, `webhook.ipc`, `webhook.ipc.*`.
   * Excludes: `webhook.github`, `webhook.operator-relay`, `heartbeat`, etc.
   */
  getRecentIpcLogMessages(limit = 50): Message[] {
    return this.db.prepare(
      "SELECT * FROM (SELECT * FROM messages WHERE topic = 'ipc' OR topic LIKE 'ipc.%' OR topic = 'webhook.ipc' OR topic LIKE 'webhook.ipc.%' ORDER BY seq DESC LIMIT ?) ORDER BY seq ASC"
    ).all(limit) as Message[];
  }

  getMessagesForAgent(agentId: string, sinceSeq: number, limit = 100): Message[] {
    // Include broadcasts (dest IS NULL) so replay delivers every message the
    // agent would have received live. Without this, agents that reconnect after
    // a broadcast was sent silently miss it.
    return this.db.prepare(
      "SELECT * FROM messages WHERE seq > ? AND (dest = ? OR dest IS NULL) ORDER BY seq ASC LIMIT ?"
    ).all(sinceSeq, agentId, limit) as Message[];
  }

  // --- Agents ---

  /**
   * Return an agent record. Includes soft-reaped (greyed) agents — being
   * greyed in the dashboard does not invalidate the agent's identity. JWT
   * verification still passes against a greyed agent's pubkey, and any
   * authenticated activity (heartbeat, register, send) clears the greyed
   * state via clearReap().
   */
  getAgent(id: string): Agent | null {
    return (this.db.prepare("SELECT * FROM agents WHERE id = ?").get(id) as Agent) ?? null;
  }

  /**
   * Return agents including soft-reaped (greyed) ones.
   *
   * Default: kind='agent' only (humanlike participants). Pass kind='integration'
   * for service integrations, or kind='all' for both.
   */
  getAllAgents(kind: AgentKind | "all" = "agent"): Agent[] {
    if (kind === "all") {
      return this.db.prepare("SELECT * FROM agents").all() as Agent[];
    }
    return this.db.prepare("SELECT * FROM agents WHERE kind = ?").all(kind) as Agent[];
  }

  /**
   * Clear an agent's greyed state. Called whenever an agent demonstrates
   * liveness — heartbeat success, new session connect, or register upsert.
   * No-op if reaped_at is already NULL.
   */
  clearReap(id: string): boolean {
    const res = this.db.prepare(
      "UPDATE agents SET reaped_at = NULL, last_seen_at = ? WHERE id = ? AND reaped_at IS NOT NULL",
    ).run(Date.now(), id);
    return res.changes > 0;
  }

  upsertAgent(agent: {
    id: string;
    display_name: string;
    pubkey: string;
    permanent?: boolean;
    pronouns?: string;
    kind?: AgentKind;
  }): void {
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO agents (id, display_name, pubkey, permanent, pronouns, kind, created_at, last_seen_at, reaped_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
      ON CONFLICT(id) DO UPDATE SET
        display_name = excluded.display_name,
        pubkey = excluded.pubkey,
        permanent = CASE WHEN excluded.permanent = 1 THEN 1 ELSE agents.permanent END,
        pronouns = COALESCE(excluded.pronouns, agents.pronouns),
        kind = excluded.kind,
        last_seen_at = excluded.last_seen_at,
        created_at = excluded.created_at,
        reaped_at = NULL
    `).run(
      agent.id,
      agent.display_name,
      agent.pubkey,
      agent.permanent ? 1 : 0,
      agent.pronouns ?? null,
      agent.kind ?? "agent",
      now,
      now,
    );
  }

  isPermanent(agentId: string): boolean {
    const row = this.db.prepare("SELECT permanent FROM agents WHERE id = ?").get(agentId) as { permanent: number } | null;
    return row?.permanent === 1;
  }

  touchAgent(id: string): void {
    this.db.prepare("UPDATE agents SET last_seen_at = ? WHERE id = ?").run(Date.now(), id);
  }

  getAgentPlan(id: string): string | null {
    const row = this.db.prepare("SELECT plan FROM agents WHERE id = ?").get(id) as { plan: string | null } | null;
    return row?.plan ?? null;
  }

  setAgentPlan(id: string, plan: string): void {
    this.db.prepare("UPDATE agents SET plan = ? WHERE id = ?").run(plan, id);
  }

  // --- Sessions ---

  createSession(agentId: string, runtime = "claude-code", contextId?: string): AgentSession {
    const id = crypto.randomUUID();
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO agent_sessions (id, agent_id, runtime, connected_at, last_ack_seq, updated_at, last_heartbeat, status, cc_session_id)
      VALUES (?, ?, ?, ?, (SELECT COALESCE(MAX(last_ack_seq), (SELECT MAX(seq) FROM messages)) FROM agent_sessions WHERE agent_id = ?), ?, ?, 'connected', ?)
    `).run(id, agentId, runtime, now, agentId, now, now, contextId ?? null);
    return this.getSession(id)!;
  }

  getSession(id: string): AgentSession | null {
    return (this.db.prepare("SELECT * FROM agent_sessions WHERE id = ?").get(id) as AgentSession) ?? null;
  }

  getActiveSessions(agentId: string): AgentSession[] {
    return this.db.prepare(
      "SELECT * FROM agent_sessions WHERE agent_id = ? AND status = 'connected'"
    ).all(agentId) as AgentSession[];
  }

  getStaleSessions(agentId: string): AgentSession[] {
    return this.db.prepare(
      "SELECT * FROM agent_sessions WHERE agent_id = ? AND status = 'stale'"
    ).all(agentId) as AgentSession[];
  }

  /** Explicit disconnect — intentional close by the agent. */
  disconnectSession(id: string): void {
    const now = Date.now();
    this.db.prepare(
      "UPDATE agent_sessions SET disconnected_at = ?, updated_at = ?, status = 'disconnected' WHERE id = ?"
    ).run(now, now, id);
  }

  /** Mark session as connected (SSE stream opened/reconnected). */
  markSessionConnected(id: string): void {
    const now = Date.now();
    this.db.prepare(
      "UPDATE agent_sessions SET status = 'connected', disconnected_at = NULL, updated_at = ?, last_heartbeat = ? WHERE id = ?"
    ).run(now, now, id);
  }

  /** Get all connected session IDs for a given context. */
  getSessionsByCCSession(agentId: string, contextId: string): AgentSession[] {
    return this.db.prepare(
      "SELECT * FROM agent_sessions WHERE agent_id = ? AND cc_session_id = ? AND status = 'connected'"
    ).all(agentId, contextId) as AgentSession[];
  }

  ackSession(sessionId: string, seq: number): void {
    this.db.prepare(
      "UPDATE agent_sessions SET last_ack_seq = MAX(last_ack_seq, ?), updated_at = ? WHERE id = ?"
    ).run(seq, Date.now(), sessionId);
  }

  heartbeatSession(sessionId: string): void {
    this.db.prepare(
      "UPDATE agent_sessions SET last_heartbeat = ?, updated_at = ? WHERE id = ?"
    ).run(Date.now(), Date.now(), sessionId);
  }

  /** True if agent has any connected session (SSE socket open). */
  hasConnectedSession(agentId: string): boolean {
    const row = this.db.prepare(
      "SELECT 1 FROM agent_sessions WHERE agent_id = ? AND status = 'connected' LIMIT 1"
    ).get(agentId);
    return !!row;
  }

  /**
   * Reconcile session status based on heartbeat age.
   * - connected → stale: no heartbeat for staleMs
   * - stale → disconnected: no heartbeat for disconnectMs
   * Returns transitions so the caller can clean up emitters/writers.
   */
  reconcileSessions(staleMs: number, disconnectMs: number): { sessionId: string; agentId: string; newStatus: SessionStatus }[] {
    const now = Date.now();
    const staleCutoff = now - staleMs;
    const disconnectCutoff = now - disconnectMs;
    const transitions: { sessionId: string; agentId: string; newStatus: SessionStatus }[] = [];

    // First: connected → stale (missed one heartbeat)
    const staleRows = this.db.prepare(
      "SELECT id, agent_id FROM agent_sessions WHERE status = 'connected' AND last_heartbeat < ?"
    ).all(staleCutoff) as { id: string; agent_id: string }[];
    for (const row of staleRows) {
      this.db.prepare("UPDATE agent_sessions SET status = 'stale', updated_at = ? WHERE id = ?").run(now, row.id);
      transitions.push({ sessionId: row.id, agentId: row.agent_id, newStatus: "stale" });
    }

    // Second: stale → disconnected (missed heartbeats for 60s)
    const disconnectRows = this.db.prepare(
      "SELECT id, agent_id FROM agent_sessions WHERE status = 'stale' AND last_heartbeat < ?"
    ).all(disconnectCutoff) as { id: string; agent_id: string }[];
    for (const row of disconnectRows) {
      this.db.prepare(
        "UPDATE agent_sessions SET status = 'disconnected', disconnected_at = ?, updated_at = ? WHERE id = ?"
      ).run(now, now, row.id);
      transitions.push({ sessionId: row.id, agentId: row.agent_id, newStatus: "disconnected" });
    }

    // Purge old disconnected sessions (no reason to keep them)
    this.db.prepare(
      "DELETE FROM agent_sessions WHERE status = 'disconnected' AND disconnected_at < ?"
    ).run(now - disconnectMs);

    return transitions;
  }

  // --- Webhooks ---

  getWebhook(agentId: string, plugin: string): Webhook | null {
    return (this.db.prepare(
      "SELECT * FROM webhooks WHERE agent_id = ? AND plugin = ?"
    ).get(agentId, plugin) as Webhook) ?? null;
  }

  getWebhookById(id: number): Webhook | null {
    return (this.db.prepare("SELECT * FROM webhooks WHERE id = ?").get(id) as Webhook) ?? null;
  }

  getWebhooksForAgent(agentId: string, plugin?: string): Webhook[] {
    if (plugin) {
      return this.db.prepare(
        "SELECT * FROM webhooks WHERE agent_id = ? AND plugin = ?"
      ).all(agentId, plugin) as Webhook[];
    }
    return this.db.prepare(
      "SELECT * FROM webhooks WHERE agent_id = ?"
    ).all(agentId) as Webhook[];
  }

  getAllWebhooksForPlugin(plugin: string): Webhook[] {
    return this.db.prepare(
      "SELECT * FROM webhooks WHERE plugin = ?"
    ).all(plugin) as Webhook[];
  }

  getWebhookByName(agentId: string, plugin: string, name: string): Webhook | null {
    return (this.db.prepare(
      "SELECT * FROM webhooks WHERE agent_id = ? AND plugin = ? AND name = ?"
    ).get(agentId, plugin, name) as Webhook) ?? null;
  }

  createWebhook(opts: {
    agentId: string;
    plugin: string;
    name: string;
    validator?: string;
    secretsMap?: string;
    filter?: string;
    meta?: string;
    cleanup?: string;
    dedup?: string;
  }): number {
    const now = Date.now();
    const result = this.db.prepare(`
      INSERT INTO webhooks (agent_id, plugin, name, validator, secrets_map, filter, meta, cleanup, dedup, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      opts.agentId, opts.plugin, opts.name,
      opts.validator ?? null, opts.secretsMap ?? null,
      opts.filter ?? null, opts.meta ?? null, opts.cleanup ?? null, opts.dedup ?? null, now,
    );
    return Number(result.lastInsertRowid);
  }

  deleteWebhook(id: number): void {
    this.db.prepare("DELETE FROM webhooks WHERE id = ?").run(id);
  }

  deleteWebhooksForAgent(agentId: string, plugin?: string): void {
    if (plugin) {
      this.db.prepare("DELETE FROM webhooks WHERE agent_id = ? AND plugin = ?").run(agentId, plugin);
    } else {
      this.db.prepare("DELETE FROM webhooks WHERE agent_id = ?").run(agentId);
    }
  }

  /** @deprecated Use createWebhook instead */
  upsertWebhook(agentId: string, plugin: string, validator?: string, secretsMap?: string): void {
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO webhooks (agent_id, plugin, validator, secrets_map, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(agentId, plugin, validator ?? null, secretsMap ?? null, now);
  }

  // --- Recent messages (temporal context) ---

  getRecentMessages(agentId: string, sinceTsMs: number, limit = 100): Message[] {
    return this.db.prepare(
      "SELECT * FROM messages WHERE created_at > ? AND (dest IS NULL OR dest = ?) ORDER BY created_at DESC LIMIT ?"
    ).all(sinceTsMs, agentId, limit) as Message[];
  }

  // --- Delivery log ---

  logDelivery(messageSeq: number, agentId: string, result: string, error?: string): void {
    this.db.prepare(
      "INSERT INTO delivery_log (message_seq, agent_id, attempted_at, result, error) VALUES (?, ?, ?, ?, ?)"
    ).run(messageSeq, agentId, Date.now(), result, error ?? null);
  }

  // --- Agent lifecycle: soft-reap (grey) and hard-delete ---

  /**
   * Soft-reap candidates: agents that should be greyed-out in the dashboard.
   *
   * An agent is a candidate when it has demonstrated no liveness within
   * `reapGraceMs` (default ~20s = 2 heartbeats):
   *   - no session has heartbeated within the grace window
   *   - the agent itself was registered before the cutoff (gives never-
   *     connected agents a brief window to open their first session before
   *     greying)
   *
   * Soft-reap does not delete anything. The agent record stays, sessions stay
   * (their own status is managed by the session reconciler). Only `reaped_at`
   * is set, marking the agent as greyed.
   */
  getSoftReapCandidates(reapGraceMs: number): string[] {
    const cutoff = Date.now() - reapGraceMs;
    return (this.db.prepare(`
      SELECT a.id FROM agents a
      WHERE a.reaped_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM agent_sessions s
          WHERE s.agent_id = a.id AND s.last_heartbeat > ?
        )
        AND a.created_at < ?
    `).all(cutoff, cutoff) as { id: string }[]).map((r) => r.id);
  }

  /** Mark an agent as greyed-out. Idempotent. */
  softReapAgent(id: string): void {
    this.db.prepare(
      "UPDATE agents SET reaped_at = ? WHERE id = ? AND reaped_at IS NULL",
    ).run(Date.now(), id);
  }

  /**
   * Hard-delete candidates: ephemeral agents that have been greyed-out for
   * longer than `deleteGraceMs` (default 1h). Permanent agents are never
   * hard-deleted — they stay greyed indefinitely until they re-register.
   */
  getHardDeleteCandidates(deleteGraceMs: number): string[] {
    const cutoff = Date.now() - deleteGraceMs;
    return (this.db.prepare(`
      SELECT id FROM agents
      WHERE permanent = 0
        AND reaped_at IS NOT NULL
        AND reaped_at < ?
    `).all(cutoff) as { id: string }[]).map((r) => r.id);
  }

  /** Hard-delete an agent and its dependent rows. */
  hardDeleteAgent(id: string): void {
    this.db.prepare("DELETE FROM webhooks WHERE agent_id = ?").run(id);
    this.db.prepare("DELETE FROM agent_sessions WHERE agent_id = ?").run(id);
    this.db.prepare("DELETE FROM agents WHERE id = ?").run(id);
  }

  /**
   * Returns true if the agent has any session that is currently connected,
   * stale, or recently heartbeated within `reapGraceMs`. Used by the
   * disconnect path to decide whether last-session-gone should trigger an
   * immediate grey-out (clean shutdown semantics).
   */
  agentHasLiveSession(agentId: string, reapGraceMs: number): boolean {
    const cutoff = Date.now() - reapGraceMs;
    const row = this.db.prepare(`
      SELECT 1 FROM agent_sessions
      WHERE agent_id = ?
        AND (status IN ('connected', 'stale') OR last_heartbeat > ?)
      LIMIT 1
    `).get(agentId, cutoff);
    return !!row;
  }

  // --- Operators ---

  getOperator(id: string): { id: string; display_name: string; role: string; token: string } | null {
    return this.db.prepare("SELECT * FROM operators WHERE id = ?").get(id) as any ?? null;
  }

  getOperatorByToken(token: string): { id: string; display_name: string; role: string } | null {
    return this.db.prepare("SELECT id, display_name, role FROM operators WHERE token = ?").get(token) as any ?? null;
  }

  hasOwner(): boolean {
    return !!(this.db.prepare("SELECT 1 FROM operators WHERE role = 'owner' LIMIT 1").get());
  }

  createOperator(id: string, displayName: string, role: string, token: string): void {
    this.db.prepare(
      "INSERT INTO operators (id, display_name, role, token, created_at) VALUES (?, ?, ?, ?, ?)"
    ).run(id, displayName, role, token, Date.now());
  }

  // --- Passkey Credentials ---

  getCredential(credentialId: string): { credential_id: string; operator_id: string; public_key: Buffer; counter: number } | null {
    return this.db.prepare("SELECT * FROM passkey_credentials WHERE credential_id = ?").get(credentialId) as any ?? null;
  }

  getCredentialsByOperator(operatorId: string): { credential_id: string; public_key: Buffer; counter: number }[] {
    return this.db.prepare("SELECT * FROM passkey_credentials WHERE operator_id = ?").all(operatorId) as any[];
  }

  getAllCredentials(): { credential_id: string; operator_id: string; public_key: Buffer; counter: number }[] {
    return this.db.prepare("SELECT * FROM passkey_credentials").all() as any[];
  }

  upsertCredential(credentialId: string, operatorId: string, publicKey: Buffer, counter: number, transports?: string): void {
    this.db.prepare(`
      INSERT INTO passkey_credentials (credential_id, operator_id, public_key, counter, transports, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(credential_id) DO UPDATE SET counter = excluded.counter
    `).run(credentialId, operatorId, publicKey, counter, transports ?? null, Date.now());
  }

  updateCredentialCounter(credentialId: string, counter: number): void {
    this.db.prepare("UPDATE passkey_credentials SET counter = ? WHERE credential_id = ?").run(counter, credentialId);
  }

  // --- Challenges ---

  storeChallenge(challenge: string): void {
    this.db.prepare("INSERT INTO challenges (id, challenge, created_at) VALUES (?, ?, ?)").run(
      crypto.randomUUID(), challenge, Date.now()
    );
    // Clean up old challenges (> 5 min)
    this.db.prepare("DELETE FROM challenges WHERE created_at < ?").run(Date.now() - 300_000);
  }

  consumeChallenge(challenge: string): boolean {
    const row = this.db.prepare("SELECT id FROM challenges WHERE challenge = ?").get(challenge);
    if (!row) return false;
    this.db.prepare("DELETE FROM challenges WHERE challenge = ?").run(challenge);
    return true;
  }

  // --- Invites ---

  createInvite(code: string, createdBy: string, label?: string): void {
    this.db.prepare(
      "INSERT INTO invites (code, created_by, label, created_at) VALUES (?, ?, ?, ?)"
    ).run(code, createdBy, label ?? null, Date.now());
  }

  consumeInvite(code: string, usedBy: string): boolean {
    const invite = this.db.prepare("SELECT * FROM invites WHERE code = ? AND used_by IS NULL").get(code);
    if (!invite) return false;
    this.db.prepare("UPDATE invites SET used_by = ?, used_at = ? WHERE code = ?").run(usedBy, Date.now(), code);
    return true;
  }

  // --- Operator Sessions (persistent) ---

  createOperatorSession(operatorId: string, ttlMs: number): string {
    const id = crypto.randomUUID();
    const now = Date.now();
    this.db.prepare(
      "INSERT INTO operator_sessions (id, operator_id, created_at, expires_at) VALUES (?, ?, ?, ?)"
    ).run(id, operatorId, now, now + ttlMs);
    // Clean expired
    this.db.prepare("DELETE FROM operator_sessions WHERE expires_at < ?").run(now);
    return id;
  }

  getOperatorSession(sessionId: string): { operator_id: string } | null {
    const row = this.db.prepare(
      "SELECT operator_id FROM operator_sessions WHERE id = ? AND expires_at > ?"
    ).get(sessionId, Date.now()) as { operator_id: string } | null;
    return row ?? null;
  }

  // --- Heartbeats ---

  createHeartbeat(opts: {
    id: string;
    agent_id: string;
    cron: string;
    prompt: string;
    created_by: string;
  }): Heartbeat {
    const now = Date.now();
    this.db.prepare(
      `INSERT INTO heartbeats (id, agent_id, cron, prompt, created_by, active, created_at)
       VALUES (?, ?, ?, ?, ?, 1, ?)`
    ).run(opts.id, opts.agent_id, opts.cron, opts.prompt, opts.created_by, now);
    return {
      id: opts.id, agent_id: opts.agent_id, cron: opts.cron,
      prompt: opts.prompt, created_by: opts.created_by,
      active: 1, last_fired: null, created_at: now,
    };
  }

  getHeartbeat(id: string): Heartbeat | null {
    return this.db.prepare("SELECT * FROM heartbeats WHERE id = ?").get(id) as Heartbeat | null;
  }

  listHeartbeats(agentId?: string): Heartbeat[] {
    if (agentId) {
      return this.db.prepare(
        "SELECT * FROM heartbeats WHERE agent_id = ? ORDER BY created_at"
      ).all(agentId) as Heartbeat[];
    }
    return this.db.prepare("SELECT * FROM heartbeats ORDER BY created_at").all() as Heartbeat[];
  }

  listActiveHeartbeats(): Heartbeat[] {
    return this.db.prepare(
      "SELECT * FROM heartbeats WHERE active = 1 ORDER BY created_at"
    ).all() as Heartbeat[];
  }

  updateHeartbeatFired(id: string): void {
    this.db.prepare(
      "UPDATE heartbeats SET last_fired = ? WHERE id = ?"
    ).run(Date.now(), id);
  }

  deleteHeartbeat(id: string): void {
    this.db.prepare("DELETE FROM heartbeats WHERE id = ?").run(id);
  }

  deleteHeartbeatsForAgent(agentId: string): void {
    this.db.prepare("DELETE FROM heartbeats WHERE agent_id = ?").run(agentId);
  }

  // --- Peers (v1.1.0 federation) ---

  createPeer(opts: { name: string; base_url: string; pubkey: string; notes?: string }): Peer {
    const now = Date.now();
    this.db.prepare(
      "INSERT INTO peers (name, base_url, pubkey, added_at, last_seen, notes) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(opts.name, opts.base_url, opts.pubkey, now, null, opts.notes ?? null);
    return {
      name: opts.name,
      base_url: opts.base_url,
      pubkey: opts.pubkey,
      added_at: now,
      last_seen: null,
      notes: opts.notes ?? null,
    };
  }

  getPeer(name: string): Peer | null {
    return this.db.prepare("SELECT * FROM peers WHERE name = ?").get(name) as Peer | null;
  }

  getPeerByPubkey(pubkey: string): Peer | null {
    return this.db.prepare("SELECT * FROM peers WHERE pubkey = ?").get(pubkey) as Peer | null;
  }

  listPeers(): Peer[] {
    return this.db.prepare("SELECT * FROM peers ORDER BY name").all() as Peer[];
  }

  deletePeer(name: string): void {
    this.db.prepare("DELETE FROM peers WHERE name = ?").run(name);
  }

  updatePeerUrl(name: string, base_url: string): void {
    this.db.prepare("UPDATE peers SET base_url = ? WHERE name = ?").run(base_url, name);
  }

  updatePeerLastSeen(name: string, ts: number): void {
    this.db.prepare("UPDATE peers SET last_seen = ? WHERE name = ?").run(ts, name);
  }

  close(): void {
    this.db.close();
  }
}
