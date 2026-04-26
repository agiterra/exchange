import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { Store } from "./store";
import { loadOrCreateServerIdentity } from "./identity";
import {
  signForwardedEnvelope,
  verifyForwardedJwt,
  signRefreshJwt,
  verifyRefreshJwt,
  DiscoveryCache,
  type ForwardedEnvelope,
} from "./federation";

let tmpDir: string;
let dbPath: string;
let store: Store;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "wire-fed-"));
  dbPath = join(tmpDir, "wire.db");
  store = new Store(dbPath);
});

afterAll(() => {
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

const SAMPLE_ENVELOPE: ForwardedEnvelope = {
  source: "brioche",
  dest: "danish",
  topic: "ipc",
  payload: JSON.stringify({ from: "brioche", kind: "ack", text: "hi" }),
};

describe("federation sign + verify", () => {
  test("sign + verify round-trip succeeds with the correct pubkey", async () => {
    const identity = await loadOrCreateServerIdentity(join(tmpDir, "server.key"));
    // The recipient's store has us registered as peer "laptop".
    store.createPeer({ name: "laptop", base_url: "https://laptop.local", pubkey: identity.pubkeyB64 });

    const { jwt, body } = await signForwardedEnvelope("laptop", identity, SAMPLE_ENVELOPE);
    const { peer, envelope } = await verifyForwardedJwt(jwt, body, store);
    expect(peer.name).toBe("laptop");
    expect(envelope.source).toBe("brioche");
    expect(envelope.dest).toBe("danish");
  });

  test("tampered body fails body_hash check", async () => {
    const identity = await loadOrCreateServerIdentity(join(tmpDir, "server.key"));
    store.createPeer({ name: "laptop", base_url: "https://laptop.local", pubkey: identity.pubkeyB64 });

    const { jwt } = await signForwardedEnvelope("laptop", identity, SAMPLE_ENVELOPE);
    const tamperedBody = JSON.stringify({ ...SAMPLE_ENVELOPE, payload: "evil" });
    await expect(verifyForwardedJwt(jwt, tamperedBody, store)).rejects.toThrow(/body_hash/);
  });

  test("unknown peer rejected", async () => {
    const identity = await loadOrCreateServerIdentity(join(tmpDir, "server.key"));
    // Do NOT register the peer.
    const { jwt, body } = await signForwardedEnvelope("unregistered", identity, SAMPLE_ENVELOPE);
    await expect(verifyForwardedJwt(jwt, body, store)).rejects.toThrow(/unknown peer/);
  });

  test("wrong-pubkey registration rejected", async () => {
    const identityA = await loadOrCreateServerIdentity(join(tmpDir, "server-a.key"));
    const identityB = await loadOrCreateServerIdentity(join(tmpDir, "server-b.key"));
    // Recipient has us as peer=laptop but with B's pubkey; we sign with A.
    store.createPeer({ name: "laptop", base_url: "https://laptop.local", pubkey: identityB.pubkeyB64 });
    const { jwt, body } = await signForwardedEnvelope("laptop", identityA, SAMPLE_ENVELOPE);
    await expect(verifyForwardedJwt(jwt, body, store)).rejects.toThrow(/signature verification failed/);
  });

  test("malformed JWT rejected", async () => {
    await expect(verifyForwardedJwt("not.a.jwt.maybe", "{}", store)).rejects.toThrow(/malformed JWT/);
    await expect(verifyForwardedJwt("only.two", "{}", store)).rejects.toThrow(/malformed JWT/);
  });
});

describe("federation URL refresh", () => {
  test("sign + verify round-trip works for refresh announcement", async () => {
    const identity = await loadOrCreateServerIdentity(join(tmpDir, "server.key"));
    store.createPeer({ name: "laptop", base_url: "https://old.ngrok.app", pubkey: identity.pubkeyB64 });

    const body = JSON.stringify({ name: "laptop", base_url: "https://new.ngrok.app", ts: Date.now() });
    const { jwt } = await signRefreshJwt("laptop", identity, body);
    const { peer, announced } = await verifyRefreshJwt(jwt, body, store);
    expect(peer.name).toBe("laptop");
    expect(announced.base_url).toBe("https://new.ngrok.app");
  });

  test("body name mismatch with iss is rejected", async () => {
    const identity = await loadOrCreateServerIdentity(join(tmpDir, "server.key"));
    store.createPeer({ name: "laptop", base_url: "https://x", pubkey: identity.pubkeyB64 });

    const body = JSON.stringify({ name: "imposter", base_url: "https://evil", ts: Date.now() });
    const { jwt } = await signRefreshJwt("laptop", identity, body);
    await expect(verifyRefreshJwt(jwt, body, store)).rejects.toThrow(/does not match jwt iss/);
  });
});

describe("DiscoveryCache", () => {
  test("get returns null on miss, peer name on hit, null after TTL", async () => {
    const c = new DiscoveryCache(50);
    expect(c.get("danish")).toBeNull();
    c.set("danish", "home-mini");
    expect(c.get("danish")).toBe("home-mini");
    await new Promise((r) => setTimeout(r, 60));
    expect(c.get("danish")).toBeNull();
  });

  test("invalidate drops a single entry", () => {
    const c = new DiscoveryCache();
    c.set("a", "p1");
    c.set("b", "p2");
    c.invalidate("a");
    expect(c.get("a")).toBeNull();
    expect(c.get("b")).toBe("p2");
  });

  test("clear drops everything", () => {
    const c = new DiscoveryCache();
    c.set("a", "p1");
    c.set("b", "p2");
    c.clear();
    expect(c.size()).toBe(0);
  });
});
