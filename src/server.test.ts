import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import pino from "pino";
import { Store } from "./store";
import { Router } from "./router";
import { MessageEmitter } from "./emitter";
import { HeartbeatScheduler } from "./heartbeat";
import { createServer } from "./server";

const TOKEN = "test-dashboard-token";
const log = pino({ level: "silent" });

let tmpDir: string;
let store: Store;
let server: ReturnType<typeof createServer>;
let baseUrl: string;
let prevToken: string | undefined;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "wire-server-"));
  store = new Store(join(tmpDir, "wire.db"));
  store.upsertAgent({ id: "fondant", display_name: "fondant", pubkey: "pk-fondant", permanent: true });

  const emitter = new MessageEmitter();
  const router = new Router(store, emitter, log);
  const heartbeats = new HeartbeatScheduler(store, router, log);

  // Operator auth via dashboard token lets the test bypass JWT signing.
  prevToken = process.env.WIRE_DASHBOARD_TOKEN;
  process.env.WIRE_DASHBOARD_TOKEN = TOKEN;

  server = createServer({ port: 0, store, router, emitter, log, heartbeats });
  baseUrl = `http://localhost:${server.port}`;
});

afterEach(() => {
  server.stop(true);
  if (prevToken === undefined) delete process.env.WIRE_DASHBOARD_TOKEN;
  else process.env.WIRE_DASHBOARD_TOKEN = prevToken;
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

function register(body: Record<string, unknown>) {
  return fetch(`${baseUrl}/agents/fondant/webhooks?token=${TOKEN}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /agents/:id/webhooks — idempotent registration", () => {
  test("first registration creates the webhook (registered:true)", async () => {
    const res = await register({ plugin: "slack", name: "mivid-studios", secrets: { signing_secret: "s1" } });
    expect(res.status).toBe(200);
    const json = await res.json() as { webhook_id: number; url: string; registered: boolean };
    expect(json.registered).toBe(true);
    expect(typeof json.webhook_id).toBe("number");
    expect(json.url).toBe("/webhooks/fondant/slack/mivid-studios");
  });

  test("re-registering same (agent,plugin,name) returns existing id, registered:false", async () => {
    const first = await register({ plugin: "slack", name: "mivid-studios", secrets: { signing_secret: "s1" } });
    const firstJson = await first.json() as { webhook_id: number; registered: boolean };

    const second = await register({ plugin: "slack", name: "mivid-studios", secrets: { signing_secret: "DIFFERENT" } });
    expect(second.status).toBe(200);
    const secondJson = await second.json() as { webhook_id: number; url: string; registered: boolean };

    expect(secondJson.registered).toBe(false);
    expect(secondJson.webhook_id).toBe(firstJson.webhook_id);

    // Idempotent: the row is left untouched — the differing secret is NOT applied.
    const stored = store.getWebhookByName("fondant", "slack", "mivid-studios");
    expect(stored).not.toBeNull();
    expect(stored!.secrets_map).toContain("s1");
    expect(stored!.secrets_map).not.toContain("DIFFERENT");

    // And only one row exists.
    expect(store.getWebhooksForAgent("fondant", "slack").length).toBe(1);
  });

  test("different name registers a distinct webhook (registered:true)", async () => {
    await register({ plugin: "slack", name: "mivid-studios", secrets: { signing_secret: "s1" } });
    const res = await register({ plugin: "slack", name: "fabricaland", secrets: { signing_secret: "s2" } });
    const json = await res.json() as { registered: boolean };
    expect(json.registered).toBe(true);
    expect(store.getWebhooksForAgent("fondant", "slack").length).toBe(2);
  });
});
