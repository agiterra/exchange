import { describe, test, expect } from "bun:test";
import { MessageEmitter } from "./emitter";

function mockWriter() {
  const frames: string[] = [];
  return {
    frames,
    writer: { write: (d: string) => { frames.push(d); }, close: () => {} },
    /** seqs of `id:`-tagged frames, in delivery order */
    seqs: () =>
      frames
        .map((f) => { const m = f.match(/^id: (\d+)/); return m ? Number(m[1]) : null; })
        .filter((s): s is number => s != null),
  };
}

describe("MessageEmitter — basic delivery", () => {
  test("emit delivers to a registered session", () => {
    const em = new MessageEmitter();
    const w = mockWriter();
    em.register("a", "s1", w.writer);
    expect(em.emit("a", "hello", 5)).toBe(true);
    expect(w.frames).toEqual(["id: 5\ndata: hello\n\n"]);
  });

  test("emit to an agent with no sessions returns false", () => {
    const em = new MessageEmitter();
    expect(em.emit("ghost", "x", 1)).toBe(false);
  });

  test("emitToSession targets exactly one session", () => {
    const em = new MessageEmitter();
    const w1 = mockWriter(); const w2 = mockWriter();
    em.register("a", "s1", w1.writer);
    em.register("a", "s2", w2.writer);
    em.emitToSession("a", "s2", "only2", 7);
    expect(w1.frames).toEqual([]);
    expect(w2.seqs()).toEqual([7]);
  });
});

describe("MessageEmitter — replay buffering preserves global seq order", () => {
  test("live emits during replay buffer, then flush AFTER backlog, in order", () => {
    const em = new MessageEmitter();
    const w = mockWriter();
    em.register("a", "s1", w.writer);

    em.beginReplay("a", "s1");
    em.replayWrite("a", "s1", "b1", 1);
    em.replayWrite("a", "s1", "b2", 2);

    // A higher-seq live message arrives mid-replay → must buffer, not deliver.
    em.emit("a", "live4", 4);
    expect(w.seqs()).toEqual([1, 2]);

    em.replayWrite("a", "s1", "b3", 3);
    em.emitToSession("a", "s1", "live5", 5);
    expect(w.seqs()).toEqual([1, 2, 3]); // live 4,5 still buffered

    em.endReplay("a", "s1");
    expect(w.seqs()).toEqual([1, 2, 3, 4, 5]); // backlog, then buffered live — in order
  });

  test("emit returns true while buffering (connected, not offline)", () => {
    const em = new MessageEmitter();
    const w = mockWriter();
    em.register("a", "s1", w.writer);
    em.beginReplay("a", "s1");
    expect(em.emit("a", "x", 9)).toBe(true);
    expect(w.frames).toEqual([]);
    em.endReplay("a", "s1");
    expect(w.seqs()).toEqual([9]);
  });

  test("endReplay with an empty buffer just resumes direct delivery", () => {
    const em = new MessageEmitter();
    const w = mockWriter();
    em.register("a", "s1", w.writer);
    em.beginReplay("a", "s1");
    em.replayWrite("a", "s1", "b1", 1);
    em.endReplay("a", "s1");
    em.emit("a", "live2", 2);
    expect(w.seqs()).toEqual([1, 2]);
  });

  test("only the replaying session buffers; a sibling session delivers live immediately", () => {
    const em = new MessageEmitter();
    const wReplay = mockWriter(); const wLive = mockWriter();
    em.register("ag", "replaying", wReplay.writer);
    em.register("ag", "live", wLive.writer);

    em.beginReplay("ag", "replaying");
    em.emit("ag", "msg", 3); // agent-level: buffer for 'replaying', direct for 'live'
    expect(wReplay.frames).toEqual([]);
    expect(wLive.seqs()).toEqual([3]);

    em.endReplay("ag", "replaying");
    expect(wReplay.seqs()).toEqual([3]);
  });
});

describe("MessageEmitter — cleanup on mid-replay disconnect", () => {
  test("unregister mid-replay: replayWrite returns false, endReplay no-ops, no throw", () => {
    const em = new MessageEmitter();
    const w = mockWriter();
    em.register("a", "s1", w.writer);
    em.beginReplay("a", "s1");
    expect(em.replayWrite("a", "s1", "b1", 1)).toBe(true);
    em.unregister("a", "s1");
    expect(em.replayWrite("a", "s1", "b2", 2)).toBe(false);
    expect(() => em.endReplay("a", "s1")).not.toThrow();
    expect(em.isConnected("a")).toBe(false);
  });

  test("a writer that throws on write is dropped from the registry", () => {
    const em = new MessageEmitter();
    let n = 0;
    const writer = { write: () => { if (++n === 2) throw new Error("closed"); }, close: () => {} };
    em.register("a", "s1", writer);
    em.emit("a", "ok", 1);
    em.emit("a", "boom", 2);
    expect(em.isConnected("a")).toBe(false);
  });
});
