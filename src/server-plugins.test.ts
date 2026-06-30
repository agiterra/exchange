import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import pino from "pino";
import { Store } from "./store";
import { Router } from "./router";
import { MessageEmitter } from "./emitter";
import { ServerPluginBus, loadServerPlugins } from "./server-plugins";

const log = pino({ level: "silent" });
let tmpDir: string;
let store: Store;
let router: Router;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "wire-sp-"));
  store = new Store(join(tmpDir, "wire.db"));
  router = new Router(store, new MessageEmitter(), log);
});
afterEach(() => {
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

function reapMsgs() {
  return store.getMessages(0, 100).filter((m) => m.topic.startsWith("server-plugin.lifecycle"));
}

describe("ServerPluginBus + store reap lifecycle (design §3.1/§3.3)", () => {
  test("softReap of an agent emits a unicast agent_reaped to a subscribed plugin", () => {
    const bus = new ServerPluginBus([{ name: "wallet", agentId: "wallet", events: ["agent_reaped"] }], router, log);
    store.setLifecycleSink((ev) => bus.emit(ev));
    store.upsertAgent({ id: "wallet", display_name: "wallet", pubkey: "pk-wallet", permanent: true, kind: "integration" });
    store.upsertAgent({ id: "galette", display_name: "galette", pubkey: "pk-galette" });

    store.softReapAgent("galette", "clean_disconnect");

    const msgs = reapMsgs();
    expect(msgs.length).toBe(1);
    expect(msgs[0].dest).toBe("wallet");
    expect(msgs[0].source).toBe("wire");
    expect(msgs[0].topic).toBe("server-plugin.lifecycle.agent_reaped");
    const ev = JSON.parse(msgs[0].payload);
    expect(ev).toMatchObject({ type: "agent_reaped", agent_id: "galette", pubkey: "pk-galette", reason: "clean_disconnect" });
    expect(typeof ev.at).toBe("number");
  });

  test("a second (idempotent) softReap does NOT re-emit", () => {
    const bus = new ServerPluginBus([{ name: "wallet", agentId: "wallet", events: ["agent_reaped"] }], router, log);
    store.setLifecycleSink((ev) => bus.emit(ev));
    store.upsertAgent({ id: "wallet", display_name: "wallet", pubkey: "pk-w", permanent: true, kind: "integration" });
    store.upsertAgent({ id: "x", display_name: "x", pubkey: "pk-x" });

    store.softReapAgent("x");          // transitions → emits
    store.softReapAgent("x");          // already greyed → no transition → no emit

    expect(reapMsgs().length).toBe(1);
  });

  test("no serverPlugins wired → no emission, but reap still greys the agent", () => {
    store.upsertAgent({ id: "y", display_name: "y", pubkey: "pk-y" });
    store.softReapAgent("y");
    expect(reapMsgs().length).toBe(0);
    expect(store.getAgent("y")?.reaped_at).not.toBeNull();
  });

  test("a plugin not subscribed to agent_reaped receives nothing", () => {
    const bus = new ServerPluginBus([{ name: "wallet", agentId: "wallet", events: ["some_other_event"] }], router, log);
    store.setLifecycleSink((ev) => bus.emit(ev));
    store.upsertAgent({ id: "wallet", display_name: "wallet", pubkey: "pk-w", permanent: true, kind: "integration" });
    store.upsertAgent({ id: "z", display_name: "z", pubkey: "pk-z" });
    store.softReapAgent("z");
    expect(reapMsgs().length).toBe(0);
  });

  test("loadServerPlugins parses WIRE_SERVER_PLUGINS env JSON array", () => {
    const prev = process.env.WIRE_SERVER_PLUGINS;
    process.env.WIRE_SERVER_PLUGINS = JSON.stringify([{ name: "wallet", agentId: "wallet", events: ["agent_reaped"] }]);
    expect(loadServerPlugins()).toEqual([{ name: "wallet", agentId: "wallet", events: ["agent_reaped"] }]);
    if (prev === undefined) delete process.env.WIRE_SERVER_PLUGINS; else process.env.WIRE_SERVER_PLUGINS = prev;
  });

  test("loadServerPlugins fails safe to [] on malformed config", () => {
    const prev = process.env.WIRE_SERVER_PLUGINS;
    process.env.WIRE_SERVER_PLUGINS = "{not valid json";
    expect(loadServerPlugins()).toEqual([]);
    if (prev === undefined) delete process.env.WIRE_SERVER_PLUGINS; else process.env.WIRE_SERVER_PLUGINS = prev;
  });
});
