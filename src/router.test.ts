import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import pino from "pino";
import { Store } from "./store";
import { Router } from "./router";
import { MessageEmitter } from "./emitter";

const log = pino({ level: "silent" });
let tmpDir: string; let store: Store; let emitter: MessageEmitter; let router: Router;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "wire-router-"));
  store = new Store(join(tmpDir, "wire.db"));
  store.upsertAgent({ id: "ag", display_name: "ag", pubkey: "pk", permanent: true });
  emitter = new MessageEmitter();
  router = new Router(store, emitter, log);
});
afterEach(() => { try { rmSync(tmpDir, { recursive: true, force: true }); } catch {} });

function mockWriter() {
  const frames: string[] = [];
  return {
    frames,
    writer: { write: (d: string) => { frames.push(d); }, close: () => {} },
    seqs: () =>
      frames
        .map((f) => { const m = f.match(/^id: (\d+)/); return m ? Number(m[1]) : null; })
        .filter((s): s is number => s != null),
  };
}

describe("Router.replay — chunked async backlog", () => {
  test("delivers all backlog for the session, in seq order, across chunk boundaries", async () => {
    // 120 backlog messages (> CHUNK=50 → multiple chunks) before any session.
    for (let i = 0; i < 120; i++) {
      router.route({ source: "x", dest: "ag", topic: "t", payload: JSON.stringify({ n: i }) });
    }
    const sess = store.createSession("ag");
    const w = mockWriter();
    emitter.register("ag", sess.id, w.writer);

    await router.replay("ag", sess.id);

    expect(w.seqs()).toEqual(Array.from({ length: 120 }, (_, i) => i + 1));
  });

  test("a live message arriving mid-replay is delivered AFTER the full backlog", async () => {
    for (let i = 0; i < 60; i++) {
      router.route({ source: "x", dest: "ag", topic: "t", payload: JSON.stringify({ n: i }) });
    }
    const sess = store.createSession("ag");
    const w = mockWriter();
    emitter.register("ag", sess.id, w.writer);

    const p = router.replay("ag", sess.id);            // sync prefix runs first chunk, then yields
    emitter.emit("ag", JSON.stringify({ live: true }), 9999); // replaying → buffered
    await p;                                            // drains remaining chunks, then flushes buffer

    const seqs = w.seqs();
    expect(seqs.length).toBe(61);
    expect(seqs.slice(0, 60)).toEqual(Array.from({ length: 60 }, (_, i) => i + 1));
    expect(seqs[60]).toBe(9999); // live delivered last, never ahead of backlog
  });

  test("replay with no backlog completes and resumes live delivery", async () => {
    const sess = store.createSession("ag");
    const w = mockWriter();
    emitter.register("ag", sess.id, w.writer);
    await router.replay("ag", sess.id);
    emitter.emit("ag", "x", 5);
    expect(w.seqs()).toEqual([5]);
  });
});
