import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { Store } from "./store";

let tmpDir: string;
let dbPath: string;
let store: Store;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "wire-janitor-"));
  dbPath = join(tmpDir, "wire.db");
  store = new Store(dbPath);
});

afterAll(() => {
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

function makeAgent(id: string, opts: { permanent?: boolean } = {}): void {
  store.upsertAgent({
    id,
    display_name: id,
    pubkey: "test-pubkey-" + id,
    permanent: opts.permanent ?? false,
  });
}

function makeWebhook(agentId: string, name: string, cleanup?: string, sessionId?: string): number {
  return store.createWebhook({
    agentId,
    plugin: "github",
    name,
    cleanup,
    sessionId,
  });
}

function ageWebhook(webhookId: number, ageMs: number): void {
  // @ts-expect-error — test reaches into the Store's db handle to fake age
  store.db.prepare("UPDATE webhooks SET created_at = ? WHERE id = ?")
    .run(Date.now() - ageMs, webhookId);
}

function insertSession(agentId: string, lastHeartbeatAgeMs: number): string {
  // createSession's last_ack_seq subquery requires a messages row to exist
  // in real use; in tests we just write the agent_sessions row directly.
  const id = "sess-" + agentId + "-" + Math.random().toString(36).slice(2, 8);
  const now = Date.now();
  // @ts-expect-error — test reaches into the Store's db handle
  store.db.prepare(`
    INSERT INTO agent_sessions (id, agent_id, runtime, connected_at, last_ack_seq, updated_at, last_heartbeat, status)
    VALUES (?, ?, 'claude-code', ?, 0, ?, ?, 'connected')
  `).run(id, agentId, now, now, now - lastHeartbeatAgeMs);
  return id;
}

function freshSession(agentId: string): string {
  return insertSession(agentId, 0);
}

function staleSession(agentId: string, lastHeartbeatAgeMs: number): string {
  return insertSession(agentId, lastHeartbeatAgeMs);
}

describe("getStaleWebhooks — janitor query", () => {
  test("returns webhook when owner has no session at all and webhook is older than cutoff", () => {
    makeAgent("orphan");
    const wid = makeWebhook("orphan", "pr-1");
    ageWebhook(wid, 2_000_000);
    const stale = store.getStaleWebhooks(60_000);
    expect(stale.map((w) => w.id)).toContain(wid);
  });

  test("excludes webhook when owner has a fresh-heartbeating session", () => {
    makeAgent("alive");
    const wid = makeWebhook("alive", "pr-2");
    ageWebhook(wid, 2_000_000);
    freshSession("alive");
    const stale = store.getStaleWebhooks(60_000);
    expect(stale.map((w) => w.id)).not.toContain(wid);
  });

  test("includes webhook when owner's only session is stale beyond cutoff", () => {
    makeAgent("dozing");
    const wid = makeWebhook("dozing", "pr-3");
    ageWebhook(wid, 2_000_000);
    staleSession("dozing", 5 * 60_000);
    const stale = store.getStaleWebhooks(60_000);
    expect(stale.map((w) => w.id)).toContain(wid);
  });

  test("excludes a webhook that was just created (created_at within cutoff window)", () => {
    makeAgent("just-registered");
    const wid = makeWebhook("just-registered", "pr-4");
    // No session yet, but webhook was created just now — leave it alone.
    const stale = store.getStaleWebhooks(60_000);
    expect(stale.map((w) => w.id)).not.toContain(wid);
  });

  test("sweeps permanent agents' webhooks too (they re-register on reconnect)", () => {
    makeAgent("perma", { permanent: true });
    const wid = makeWebhook("perma", "pr-5");
    ageWebhook(wid, 2_000_000);
    staleSession("perma", 5 * 60_000);
    const stale = store.getStaleWebhooks(60_000);
    expect(stale.map((w) => w.id)).toContain(wid);
  });

  test("session-scoped: getWebhooksBySession returns only matching session_id", () => {
    makeAgent("scoped");
    const sid = freshSession("scoped");
    const wid = makeWebhook("scoped", "pr-7", undefined, sid);
    const widAgentScoped = makeWebhook("scoped", "pr-8"); // no sessionId

    const bySession = store.getWebhooksBySession(sid);
    expect(bySession.map((w) => w.id)).toEqual([wid]);

    // Webhook table round-trips session_id
    const got = store.getWebhookById(wid);
    expect(got?.session_id).toBe(sid);
    const gotAgentScoped = store.getWebhookById(widAgentScoped);
    expect(gotAgentScoped?.session_id).toBeNull();
  });

  test("re-runnable: dependents_purged_at being set does NOT exempt orphans (Madeleine/Tiramisu bug)", () => {
    makeAgent("returning-ephemeral");
    // Simulate the post-purge state: agent was purged once, then registered a
    // new webhook later, then went offline again. Old reaper would skip
    // because dependents_purged_at IS NOT NULL. New janitor must not skip.
    // @ts-expect-error — test reaches into the Store's db handle
    store.db.prepare("UPDATE agents SET dependents_purged_at = ?, reaped_at = ? WHERE id = ?")
      .run(Date.now() - 86_400_000, Date.now() - 86_400_000, "returning-ephemeral");
    const wid = makeWebhook("returning-ephemeral", "pr-6");
    ageWebhook(wid, 2_000_000);
    const stale = store.getStaleWebhooks(60_000);
    expect(stale.map((w) => w.id)).toContain(wid);
  });
});
