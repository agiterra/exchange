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

  server = createServer({ port: 0, store, router, emitter, log, heartbeats, serverPluginIds: new Set(["plugin-svc"]) });
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

describe("WebAuthn auth — assertion is actually verified (no credential-id bypass)", () => {
  function loginVerify(body: Record<string, unknown>) {
    return fetch(`${baseUrl}/auth/login/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  test("login with a malformed (incomplete) assertion is rejected 400", async () => {
    const res = await loginVerify({ id: "anything", response: { clientDataJSON: "x" } });
    expect(res.status).toBe(400);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  test("login with an unknown credential id is rejected 401", async () => {
    const res = await loginVerify({
      id: "no-such-cred",
      rawId: "no-such-cred",
      response: { clientDataJSON: "e30", authenticatorData: "AA", signature: "AA" },
      type: "public-key",
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  test("CRITICAL: a credential that EXISTS but presents a bogus assertion gets NO session", async () => {
    // This is the exact bypass that existed before: the old handler issued a
    // session whenever getCredential(id) returned a row, with no signature
    // check. Insert a real credential row, then present garbage — must fail.
    store.createOperator("op-1", "Owner", "owner", "tok-1");
    store.upsertCredential("cred-1", "op-1", Buffer.from([1, 2, 3, 4]), 0);

    const res = await loginVerify({
      id: "cred-1",
      rawId: "cred-1",
      response: {
        clientDataJSON: Buffer.from(JSON.stringify({ type: "webauthn.get", challenge: "fake", origin: "https://evil.example" })).toString("base64url"),
        authenticatorData: Buffer.from([0, 0, 0]).toString("base64url"),
        signature: Buffer.from([9, 9, 9]).toString("base64url"),
      },
      type: "public-key",
    });

    expect([400, 401]).toContain(res.status); // rejected, not authenticated
    expect(res.headers.get("set-cookie")).toBeNull();
    const json = await res.json() as { authenticated?: boolean };
    expect(json.authenticated).toBeUndefined();
  });

  test("registration is closed once an owner exists (403)", async () => {
    store.createOperator("op-owner", "Owner", "owner", "tok-owner");
    store.upsertCredential("owner-cred", "op-owner", Buffer.from([1]), 0);
    const res = await fetch(`${baseUrl}/auth/register/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "x", rawId: "x", response: { attestationObject: "AA", clientDataJSON: "e30" }, type: "public-key" }),
    });
    expect(res.status).toBe(403);
  });
});

describe("GET /peers/agents/:id — claims DELIVERABILITY (live session), not mere registration", () => {
  // Regression: a peer that holds only an agent row (registered here but
  // connected on another broker, or a stale row) must NOT claim the agent,
  // or the sender's findPeerForAgent forwards to a broker where it's offline
  // and the message is silently stored, never delivered (2026-06-30 fournil
  // hijack of brioche/fondant/herald).
  test("registered agent with NO live session → 404", async () => {
    // "fondant" is upserted in beforeEach (agent row) but has no session.
    const res = await fetch(`${baseUrl}/peers/agents/fondant`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ ok: false, id: "fondant" });
  });

  test("agent with a connected session → 200", async () => {
    store.createSession("fondant");
    const res = await fetch(`${baseUrl}/peers/agents/fondant`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, id: "fondant" });
  });

  test("unknown agent → 404", async () => {
    const res = await fetch(`${baseUrl}/peers/agents/nobody`);
    expect(res.status).toBe(404);
  });
});

describe("POST /agents/register — click-to-attach self-report fields", () => {
  function registerAgent(body: Record<string, unknown>) {
    return fetch(`${baseUrl}/agents/register?token=${TOKEN}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  test("threads ssh_host / run_as_uid / screen_name through to the store", async () => {
    const res = await registerAgent({
      id: "atty",
      display_name: "atty",
      pubkey: "pk-atty",
      ssh_host: "mini.local",
      run_as_uid: "agent-9",
      screen_name: "atty-screen",
    });
    expect(res.status).toBe(201);
    const a = store.getAgent("atty")!;
    expect(a.ssh_host).toBe("mini.local");
    expect(a.run_as_uid).toBe("agent-9");
    expect(a.screen_name).toBe("atty-screen");
  });

  test("omitting the fields still registers (backward-compat) and leaves them NULL", async () => {
    const res = await registerAgent({ id: "plain", display_name: "plain", pubkey: "pk-plain" });
    expect(res.status).toBe(201);
    const a = store.getAgent("plain")!;
    expect(a.ssh_host).toBeNull();
    expect(a.run_as_uid).toBeNull();
    expect(a.screen_name).toBeNull();
  });

  test("re-register without the fields does NOT null out previously-reported values", async () => {
    await registerAgent({
      id: "keep",
      display_name: "keep",
      pubkey: "pk-keep",
      ssh_host: "host-x",
      run_as_uid: "uid-x",
      screen_name: "screen-x",
    });
    // Sponsor re-registers omitting the self-report fields.
    const res = await registerAgent({ id: "keep", display_name: "keep", pubkey: "pk-keep" });
    expect(res.status).toBe(201);
    const a = store.getAgent("keep")!;
    expect(a.ssh_host).toBe("host-x");
    expect(a.run_as_uid).toBe("uid-x");
    expect(a.screen_name).toBe("screen-x");
  });
});

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

describe("inbound webhook — ack_early (immediate-ACK + race-safe dedup)", () => {
  // A trivial always-pass validator returning {source, topic} exercises the
  // post-validator flow (responder → filter → dedup → route) without forging
  // Slack's HMAC or a JWT. Mirrors how slack-tools registers (validator +
  // dedup="payload.event_id" + ack_early), minus the real signature check.
  const passValidator = `return { source: "testws", topic: "webhook.slack" };`;

  function postEvent(name: string, eventId: string) {
    return fetch(`${baseUrl}/webhooks/fondant/slack/${name}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ event_id: eventId, type: "event_callback", event: { type: "message" } }),
    });
  }

  test("ACKs 200 {queued} and persists the message synchronously BEFORE the ACK", async () => {
    await register({ plugin: "slack", name: "early", validator: passValidator, dedup: "payload.event_id", ack_early: true });

    const res = await postEvent("early", "EV1");
    expect(res.status).toBe(200);
    const json = await res.json() as { seq: number; queued?: boolean; delivered_to?: unknown };
    expect(json.queued).toBe(true);
    expect(typeof json.seq).toBe("number");
    expect(json.delivered_to).toBeUndefined();

    // Race-safety: the row (with source_id) is committed before the ACK
    // returns, so a retry landing mid-fan-out is still caught by dedup.
    expect(store.getMessageBySourceId("EV1")).not.toBeNull();
  });

  test("a retry of the same event_id is dropped at the broker (duplicate), never re-fanned", async () => {
    await register({ plugin: "slack", name: "early", validator: passValidator, dedup: "payload.event_id", ack_early: true });

    const first = await postEvent("early", "EV2");
    expect((await first.json() as { queued?: boolean }).queued).toBe(true);

    const retry = await postEvent("early", "EV2");
    expect(retry.status).toBe(200);
    const json = await retry.json() as { duplicate?: boolean; delivered?: boolean };
    expect(json.duplicate).toBe(true);
    expect(json.delivered).toBe(false);

    // Exactly one row was ever stored for this event_id.
    const rows = store.getMessages(0, 1000).filter((m) => m.source_id === "EV2");
    expect(rows.length).toBe(1);
  });

  test("without ack_early, delivery stays synchronous (caller still gets delivered_to)", async () => {
    await register({ plugin: "slack", name: "sync", validator: passValidator, dedup: "payload.event_id" });

    const res = await postEvent("sync", "EV3");
    expect(res.status).toBe(200);
    const json = await res.json() as { seq: number; queued?: boolean; delivered_to?: unknown[] };
    expect(json.queued).toBeUndefined();
    expect(Array.isArray(json.delivered_to)).toBe(true);
  });
});

describe("plugin_settings mutation events — scoped to the namespace owner, not broadcast", () => {
  function rawDb() {
    return (store as unknown as {
      db: { prepare: (q: string) => { get: (...a: unknown[]) => unknown } };
    }).db;
  }

  function putSetting(namespace: string, key: string, value: unknown) {
    return fetch(`${baseUrl}/plugin_settings/${namespace}/${encodeURIComponent(key)}?token=${TOKEN}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value }),
    });
  }

  test("PUT routes the updated event dest=namespace; bystanders get no delivery", async () => {
    store.upsertAgent({ id: "vaultns", display_name: "vaultns", pubkey: "pk-v" });
    // beforeEach registered "fondant" — the bystander a broadcast would have reached.

    const res = await putSetting("vaultns", "wallet:0xabc", { name: "w" });
    expect(res.status).toBe(200);

    const msg = store.getMessages(0, 1000).filter((m) => m.topic === "plugin_settings.updated").pop();
    expect(msg?.dest).toBe("vaultns");

    const bystander = rawDb().prepare(
      "SELECT count(*) AS n FROM delivery_log dl JOIN messages m ON m.seq = dl.message_seq WHERE m.topic = 'plugin_settings.updated' AND dl.agent_id = 'fondant'",
    ).get() as { n: number };
    expect(bystander.n).toBe(0);
  });

  test("DELETE routes the deleted event dest=namespace", async () => {
    store.upsertAgent({ id: "vaultns", display_name: "vaultns", pubkey: "pk-v" });
    await putSetting("vaultns", "k", 1);

    const res = await fetch(`${baseUrl}/plugin_settings/vaultns/k?token=${TOKEN}`, { method: "DELETE" });
    expect(res.status).toBe(200);

    const msg = store.getMessages(0, 1000).filter((m) => m.topic === "plugin_settings.deleted").pop();
    expect(msg?.dest).toBe("vaultns");
  });

  test("ownerless namespace (operator-only) routes without error and floods nobody", async () => {
    // No agent registered with this id — delivery is a logged no-op, never a throw.
    const res = await putSetting("fv-throwaway", "k", { x: 1 });
    expect(res.status).toBe(200);

    const msg = store.getMessages(0, 1000).filter((m) => m.topic === "plugin_settings.updated").pop();
    expect(msg?.dest).toBe("fv-throwaway");

    const anyDelivery = rawDb().prepare(
      "SELECT count(*) AS n FROM delivery_log dl JOIN messages m ON m.seq = dl.message_seq WHERE m.topic = 'plugin_settings.updated' AND dl.result = 'ok'",
    ).get() as { n: number };
    expect(anyDelivery.n).toBe(0);
  });
});

describe("POST /agents/register — only PERMANENT agents (personai) may sponsor a new ephemeral", () => {
  function b64url(bytes: Uint8Array): string {
    return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  async function sha256hex(s: string): Promise<string> {
    const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
    return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  // Register `id` with a real Ed25519 pubkey; return its private key for signing.
  async function makeSponsor(id: string, permanent: boolean): Promise<CryptoKey> {
    const kp = (await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])) as CryptoKeyPair;
    const jwk = await crypto.subtle.exportKey("jwk", kp.publicKey);
    const xUrl = jwk.x as string;
    const pubB64 = xUrl.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (xUrl.length % 4)) % 4);
    store.upsertAgent({ id, display_name: id, pubkey: pubB64, permanent });
    return kp.privateKey;
  }
  async function signedRegister(privateKey: CryptoKey, iss: string, body: object) {
    const raw = JSON.stringify(body);
    const header = b64url(new TextEncoder().encode(JSON.stringify({ alg: "EdDSA", typ: "JWT" })));
    const payload = b64url(new TextEncoder().encode(JSON.stringify({ iss, iat: Math.floor(Date.now() / 1000), body_hash: await sha256hex(raw) })));
    const signingInput = `${header}.${payload}`;
    const sig = new Uint8Array(await crypto.subtle.sign("Ed25519", privateKey, new TextEncoder().encode(signingInput)));
    return fetch(`${baseUrl}/agents/register`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${signingInput}.${b64url(sig)}` },
      body: raw,
    });
  }

  test("an EPHEMERAL sponsor is rejected (403 sponsor_not_permanent)", async () => {
    const priv = await makeSponsor("eng-ephemeral", false);
    const res = await signedRegister(priv, "eng-ephemeral", { id: "spawnee", display_name: "spawnee", pubkey: "pk-spawnee" });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code?: string }).code).toBe("sponsor_not_permanent");
  });

  test("a PERMANENT sponsor (personai) is accepted", async () => {
    const priv = await makeSponsor("director", true);
    const res = await signedRegister(priv, "director", { id: "spawnee2", display_name: "spawnee2", pubkey: "pk-spawnee2" });
    expect(res.ok).toBe(true);
  });
});

describe("Change A — POST /peers/forward fails CLOSED for server-plugin dests (§3.4 v1)", () => {
  async function forward(envelope: Record<string, unknown>) {
    const { loadOrCreateServerIdentity } = await import("./identity");
    const { signForwardedEnvelope } = await import("./federation");
    const identity = await loadOrCreateServerIdentity(join(tmpDir, "peer.key"));
    store.createPeer({ name: "laptop", base_url: "https://laptop.local", pubkey: identity.pubkeyB64 });
    const { jwt, body } = await signForwardedEnvelope("laptop", identity, envelope as any);
    return fetch(`${baseUrl}/peers/forward`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${jwt}` },
      body,
    });
  }

  test("forwarded message to a server-plugin identity is rejected 403 with a clear code", async () => {
    store.upsertAgent({ id: "plugin-svc", display_name: "plugin-svc", pubkey: "pk-plugin", permanent: true, kind: "integration" });
    const res = await forward({ source: "brioche", dest: "plugin-svc", topic: "ipc", payload: "{}" });
    expect(res.status).toBe(403);
    const json = await res.json() as { error: string };
    expect(json.error).toBe("cross-broker-server-plugin-not-enabled");
    // Nothing persisted — the message must not exist for later replay either.
    expect(store.getMessages(0).filter((m) => m.dest === "plugin-svc").length).toBe(0);
  });

  test("forwarded message to a NORMAL agent still routes (fail-closed gate is plugin-only)", async () => {
    const res = await forward({ source: "brioche", dest: "fondant", topic: "ipc", payload: "{}" });
    expect(res.status).toBe(200);
    const json = await res.json() as { seq: number };
    expect(json.seq).toBeGreaterThan(0);
  });
});

describe("Change A — JWT webhook ingress persists the VERIFIED sender pubkey", () => {
  function b64url(buf: ArrayBuffer | Uint8Array): string {
    const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    let s = "";
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  test("POST /webhooks/:agent/:plugin with a real signed JWT → stored message carries source_pubkey", async () => {
    // Real Ed25519 keypair; register the sender with its RAW pubkey (base64,
    // same encoding verifyJwt feeds to atob()).
    const kp = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]) as CryptoKeyPair;
    const rawPub = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
    const pubkeyB64 = btoa(String.fromCharCode(...rawPub));
    store.upsertAgent({ id: "brioche", display_name: "brioche", pubkey: pubkeyB64, permanent: true });

    const body = JSON.stringify({ from: "brioche", text: "hi" });
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
    const bodyHash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    const header = b64url(new TextEncoder().encode(JSON.stringify({ alg: "EdDSA", typ: "JWT" })));
    const payload = b64url(new TextEncoder().encode(JSON.stringify({ iss: "brioche", iat: Math.floor(Date.now() / 1000), body_hash: bodyHash })));
    const sig = await crypto.subtle.sign("Ed25519", kp.privateKey, new TextEncoder().encode(`${header}.${payload}`));
    const jwt = `${header}.${payload}.${b64url(sig)}`;

    const res = await fetch(`${baseUrl}/webhooks/fondant/ipc`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${jwt}` },
      body,
    });
    expect(res.status).toBe(200);

    const stored = store.getMessages(0).find((m) => m.dest === "fondant" && m.source === "brioche");
    expect(stored).toBeDefined();
    expect(stored!.source_pubkey).toBe(pubkeyB64);
  });

  test("operator send (no agent JWT) stores NO source_pubkey", async () => {
    const res = await fetch(`${baseUrl}/agents/fondant/message?token=${TOKEN}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "hello" }),
    });
    expect(res.status).toBe(200);
    const stored = store.getMessages(0).find((m) => m.dest === "fondant" && m.topic === "ipc");
    expect(stored).toBeDefined();
    expect(stored!.source_pubkey).toBeNull();
  });
});
