import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { Store } from "./store";
import { loadOrCreateServerIdentity } from "./identity";
import { signForwardedEnvelope, verifyForwardedJwt, type ForwardedEnvelope } from "./federation";

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
