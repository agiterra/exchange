/**
 * transplant-agent.ts — copy a permanent agent's identity row from one broker DB
 * to another, stamping its replay cursor to the TARGET broker's current MAX(seq).
 *
 *   bun run scripts/transplant-agent.ts <agent-id> <source-wire.db> <target-wire.db> \
 *     [--ssh-host <host>] [--run-as-uid <uid>] [--screen-name <name>]
 *
 * WHY THIS EXISTS (2026-07-10 incident): moving a persona to a new machine means
 * its identity must exist on the new machine's broker. Registering by hand with a
 * raw `INSERT INTO agents (...)` omits `last_seen_seq`, which then DEFAULTs to 0.
 * On first connect the broker replays EVERY message ever queued for that agent on
 * the target broker (via federation, that can be the entire fleet history) as a
 * firehose that shreds the fresh session's context before it can boot.
 *
 * The broker's own `upsertAgent` stamps `last_seen_seq = MAX(seq)` for exactly this
 * reason (store.ts) — but a hand SQL transplant bypasses it. This tool replicates
 * that stamp so the transplanted identity starts at "now" and only receives NEW
 * messages. Same pubkey ⇒ the agent's existing key keeps working on the new broker.
 *
 * Idempotent: re-running re-stamps the cursor to the current MAX(seq) (safe — the
 * live session's write-through cursor only ever moves forward from there).
 */
import { Database } from "bun:sqlite";

// Split argv into positionals and --flag <value> pairs.
const argv = process.argv.slice(2);
const positionals: string[] = [];
const flags: Record<string, string> = {};
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith("--")) {
    flags[argv[i].slice(2)] = argv[++i] ?? "";
  } else {
    positionals.push(argv[i]);
  }
}
const flag = (name: string): string | undefined => flags[name];
const [agentId, sourcePath, targetPath] = positionals;

if (!agentId || !sourcePath || !targetPath) {
  console.error("usage: transplant-agent.ts <agent-id> <source-wire.db> <target-wire.db> [--ssh-host H] [--run-as-uid U] [--screen-name N]");
  process.exit(2);
}

const src = new Database(sourcePath, { readonly: true });
const row = src.prepare(
  "SELECT id, display_name, pubkey, created_at, permanent, kind, pronouns FROM agents WHERE id = ?",
).get(agentId) as
  | { id: string; display_name: string; pubkey: string; created_at: number; permanent: number; kind: string | null; pronouns: string | null }
  | null;
src.close();

if (!row) {
  throw new Error(`agent '${agentId}' not found in source ${sourcePath}`);
}

const target = new Database(targetPath);
const maxSeq = (target.prepare("SELECT COALESCE(MAX(seq), 0) AS m FROM messages").get() as { m: number }).m;
const now = Date.now();

// Cursor stamped to the target broker's MAX(seq) — the whole point of this tool.
target.prepare(`
  INSERT INTO agents (id, display_name, pubkey, created_at, last_seen_at, reaped_at,
                      permanent, kind, pronouns, ssh_host, run_as_uid, screen_name, last_seen_seq)
  VALUES (?, ?, ?, ?, ?, NULL, ?, COALESCE(?, 'agent'), ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    pubkey = excluded.pubkey,
    display_name = excluded.display_name,
    permanent = CASE WHEN excluded.permanent = 1 THEN 1 ELSE agents.permanent END,
    kind = COALESCE(excluded.kind, agents.kind),
    pronouns = COALESCE(excluded.pronouns, agents.pronouns),
    ssh_host = COALESCE(excluded.ssh_host, agents.ssh_host),
    run_as_uid = COALESCE(excluded.run_as_uid, agents.run_as_uid),
    screen_name = COALESCE(excluded.screen_name, agents.screen_name),
    last_seen_at = excluded.last_seen_at,
    reaped_at = NULL,
    -- Re-stamp forward only; never rewind a live cursor.
    last_seen_seq = MAX(agents.last_seen_seq, excluded.last_seen_seq)
`).run(
  row.id, row.display_name, row.pubkey, row.created_at, now,
  row.permanent, row.kind, row.pronouns,
  flag("ssh-host") ?? null, flag("run-as-uid") ?? null, flag("screen-name") ?? null,
  maxSeq,
);
target.close();

console.log(`transplanted '${agentId}' → ${targetPath}: cursor stamped to MAX(seq)=${maxSeq} (starts at "now", no backlog replay).`);
