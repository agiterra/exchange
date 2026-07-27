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

function throwingWriter(failAfterWrites: number) {
  const frames: string[] = [];
  let writes = 0;
  return {
    frames,
    writer: {
      write: (d: string) => {
        if (writes >= failAfterWrites) throw new Error("Controller closed");
        writes++;
        frames.push(d);
      },
      close: () => {},
    },
    seqs: () =>
      frames
        .map((f) => { const m = f.match(/^id: (\d+)/); return m ? Number(m[1]) : null; })
        .filter((s): s is number => s != null),
  };
}

function controlledSleep() {
  const delays: number[] = [];
  const resolvers: Array<() => void> = [];
  return {
    delays,
    sleep: (ms: number) => {
      delays.push(ms);
      if (ms === 0) return Promise.resolve();
      return new Promise<void>((resolve) => resolvers.push(resolve));
    },
    resolveNext: () => {
      const resolve = resolvers.shift();
      if (resolve) resolve();
    },
  };
}

describe("Router.replay — paged async backlog", () => {
  test("delivers all backlog for the session, in seq order, across chunk boundaries", async () => {
    // 120 backlog messages (> default page size 100) before any session.
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

  test("resumes from Last-Event-ID after mid-replay disconnect without advancing durable ack", async () => {
    for (let i = 0; i < 10; i++) {
      router.route({ source: "x", dest: "ag", topic: "t", payload: JSON.stringify({ n: i }) });
    }
    const sess = store.createSession("ag");
    const first = throwingWriter(4);
    emitter.register("ag", sess.id, first.writer);

    await router.replay("ag", sess.id);
    expect(first.seqs()).toEqual([1, 2, 3, 4]);
    expect(store.getSession(sess.id)?.last_ack_seq).toBe(0);

    const second = mockWriter();
    emitter.register("ag", sess.id, second.writer);
    await router.replay("ag", sess.id, { lastEventId: 4 });

    expect(second.seqs()).toEqual([5, 6, 7, 8, 9, 10]);
    expect(store.getSession(sess.id)?.last_ack_seq).toBe(0);
  });

  test("non-advancing ack reconnect storms back off, quarantine, and do not block other live delivery", async () => {
    for (let i = 0; i < 20; i++) {
      router.route({ source: "x", dest: "ag", topic: "t", payload: JSON.stringify({ n: i }) });
    }
    store.upsertAgent({ id: "peer", display_name: "peer", pubkey: "pk-peer", permanent: true });
    const sleeper = controlledSleep();
    router = new Router(store, emitter, log, undefined, {
      pageSize: 5,
      backoffBaseMs: 1_000,
      backoffMaxMs: 8_000,
      quarantineFailures: 2,
      sleep: sleeper.sleep,
    });

    const sess = store.createSession("ag");
    const first = throwingWriter(3);
    emitter.register("ag", sess.id, first.writer);
    await router.replay("ag", sess.id);
    expect(first.seqs()).toEqual([1, 2, 3]);
    expect(router.getReplayStatus(sess.id)?.failures).toBe(1);

    const second = throwingWriter(3);
    emitter.register("ag", sess.id, second.writer);
    const replayP = router.replay("ag", sess.id);
    expect(sleeper.delays.some((delay) => delay > 0)).toBe(true);

    const peerSess = store.createSession("peer");
    const peerWriter = mockWriter();
    emitter.register("peer", peerSess.id, peerWriter.writer);
    router.route({ source: "x", dest: "peer", topic: "t", payload: "{}" });
    expect(peerWriter.seqs()).toEqual([21]);

    sleeper.resolveNext();
    await replayP;
    expect(router.getReplayStatus(sess.id)).toMatchObject({ failures: 2, quarantined: true });
    expect(store.getSession(sess.id)?.last_ack_seq).toBe(0);
  });
});

describe("Router federation single-hop forwarding", () => {
  // Minimal federation hook. `identity` is only dereferenced inside
  // forwardToPeer, which is never reached here (no peers registered), so a
  // stub is safe — these tests assert on the deliver() branch, not the network.
  const fedHook = { ourPeerName: "test-self", identity: {} as any };

  test("a NON-forwarded offline unicast enters federation forwarding", () => {
    router.setFederation(fedHook);
    const { deliveries } = router.route({ source: "x", dest: "ghost", topic: "ipc", payload: "{}" });
    expect(deliveries[0]).toMatchObject({ agentId: "ghost", status: "forwarded" });
  });

  test("a FORWARDED offline unicast is TERMINAL — never re-forwarded (single hop)", () => {
    router.setFederation(fedHook);
    const { message, deliveries } = router.route({
      source: "x", dest: "ghost", topic: "ipc", payload: "{}", forwarded: true,
    });
    // 'offline' (stored for replay), NOT 'forwarded' — re-forwarding would loop
    // it back to the peer that sent it.
    expect(deliveries[0]).toMatchObject({ agentId: "ghost", status: "offline" });
    // still persisted locally so the agent gets it on replay if it connects here
    expect(message.seq).toBeGreaterThan(0);
  });

  test("a FORWARDED message to a LOCALLY-connected agent still delivers", () => {
    router.setFederation(fedHook);
    const sess = store.createSession("ag");
    const w = mockWriter();
    emitter.register("ag", sess.id, w.writer);
    const { deliveries } = router.route({
      source: "x", dest: "ag", topic: "ipc", payload: "{}", forwarded: true,
    });
    expect(deliveries[0]).toMatchObject({ agentId: "ag", status: "delivered" });
    expect(w.seqs().length).toBe(1);
  });
});

describe("Change A — source_pubkey surfaced ONLY to server-plugin recipients", () => {
  // Frames are SSE-formatted ("id: N\ndata: {...}"); pull the JSON meta out.
  function frameMeta(frame: string): Record<string, unknown> {
    const m = frame.match(/data: (.*)/);
    return JSON.parse(m![1]);
  }

  beforeEach(() => {
    store.upsertAgent({ id: "plugin-svc", display_name: "plugin-svc", pubkey: "pk-plugin", permanent: true, kind: "integration" });
    router.setServerPluginIds(["plugin-svc"]);
  });

  test("unicast to a server plugin carries the verified source_pubkey", () => {
    const sess = store.createSession("plugin-svc");
    const w = mockWriter();
    emitter.register("plugin-svc", sess.id, w.writer);
    router.route({ source: "ag", source_pubkey: "PK-VERIFIED", dest: "plugin-svc", topic: "ipc", payload: "{}" });
    expect(frameMeta(w.frames[0]).source_pubkey).toBe("PK-VERIFIED");
  });

  test("unicast to a NORMAL agent never carries source_pubkey (no broad leak)", () => {
    const sess = store.createSession("ag");
    const w = mockWriter();
    emitter.register("ag", sess.id, w.writer);
    router.route({ source: "x", source_pubkey: "PK-VERIFIED", dest: "ag", topic: "ipc", payload: "{}" });
    expect(frameMeta(w.frames[0]).source_pubkey).toBeUndefined();
  });

  test("broadcast: plugin recipient sees the pubkey, normal agent does not", () => {
    const sessAg = store.createSession("ag");
    const sessPl = store.createSession("plugin-svc");
    const wAg = mockWriter();
    const wPl = mockWriter();
    emitter.register("ag", sessAg.id, wAg.writer);
    emitter.register("plugin-svc", sessPl.id, wPl.writer);
    router.route({ source: "x", source_pubkey: "PK-VERIFIED", topic: "ipc", payload: "{}" });
    expect(frameMeta(wPl.frames[0]).source_pubkey).toBe("PK-VERIFIED");
    expect(frameMeta(wAg.frames[0]).source_pubkey).toBeUndefined();
  });

  test("REPLAYED backlog to a plugin carries the persisted source_pubkey", async () => {
    // Route while the plugin is offline → message persists with the pubkey.
    router.route({ source: "ag", source_pubkey: "PK-VERIFIED", dest: "plugin-svc", topic: "ipc", payload: "{}" });
    const sess = store.createSession("plugin-svc");
    const w = mockWriter();
    emitter.register("plugin-svc", sess.id, w.writer);
    await router.replay("plugin-svc", sess.id);
    expect(frameMeta(w.frames[0]).source_pubkey).toBe("PK-VERIFIED");
  });

  test("message routed WITHOUT source_pubkey has no field even for a plugin", () => {
    const sess = store.createSession("plugin-svc");
    const w = mockWriter();
    emitter.register("plugin-svc", sess.id, w.writer);
    router.route({ source: "wire", dest: "plugin-svc", topic: "server-plugin.lifecycle.agent_reaped", payload: "{}" });
    expect(frameMeta(w.frames[0]).source_pubkey).toBeUndefined();
  });
});
