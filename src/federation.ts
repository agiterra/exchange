/**
 * Wire federation — peer-to-peer message forwarding.
 *
 * When a unicast message's dest is not a locally-registered agent,
 * we ask peers whether they host the agent and forward on the first
 * positive match. The outer envelope is signed by our server
 * identity (Ed25519); the receiving Wire verifies against the pubkey
 * stored when the two Wires were paired.
 *
 * Trust model:
 *   - Each Wire's server identity (Ed25519) is generated on first boot
 *     and persisted at ~/.wire/server.key.
 *   - Admin pairs two Wires by exchanging pubkeys out-of-band
 *     (`wire peer pubkey` / `wire peer add`).
 *   - A peer-forwarded message arrives at /peers/forward wrapped in a
 *     JWT signed by the source Wire's key. Recipient looks up the
 *     pubkey by the iss claim (which is the peer's registered name),
 *     verifies, and — if the inner envelope's body_hash matches —
 *     passes the envelope into its own router for local delivery.
 *
 * The inner envelope's own agent signature is untouched — the
 * recipient agent verifies that separately (same as local delivery).
 */

import type { Logger } from "pino";
import type { Store, Peer } from "./store.js";
import type { ServerIdentity } from "./identity.js";

/** Result of an attempted peer forward. */
export type ForwardResult =
  | { ok: true; peer: string; remoteSeq?: number }
  | { ok: false; peer: string; error: string }
  | { ok: false; error: "no_peer_claims_dest" };

/** Shape of the POST /peers/forward body. */
export type ForwardedEnvelope = {
  source: string;
  source_id?: string | null;
  source_cc_session?: string | null;
  dest: string;
  dest_cc_session?: string | null;
  topic: string;
  payload: string;
  raw?: string | null;
};

// --- Crypto helpers ---

async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return Buffer.from(u8).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64Url(s: string): Uint8Array {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  return new Uint8Array(Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64"));
}

/** Import a peer's base64 Ed25519 pubkey into a CryptoKey for verify(). */
async function importPeerPubkey(b64: string): Promise<CryptoKey> {
  // Try base64 first, fall back to base64url (wire-tools' derivePublicKeyB64
  // emits base64url without padding).
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(Buffer.from(b64, "base64"));
    if (bytes.length !== 32) throw new Error("length");
  } catch {
    bytes = fromB64Url(b64);
  }
  return crypto.subtle.importKey("raw", bytes, { name: "Ed25519" }, false, ["verify"]);
}

/**
 * Sign a forwarded envelope. Produces an EdDSA JWT whose payload
 * binds the body hash + our own peer name, so the recipient verifies
 * that the envelope was sent by us and hasn't been tampered with.
 */
export async function signForwardedEnvelope(
  ourPeerName: string,
  ourIdentity: ServerIdentity,
  envelope: ForwardedEnvelope,
): Promise<{ jwt: string; body: string }> {
  const body = JSON.stringify(envelope);
  const header = { alg: "EdDSA", typ: "JWT" };
  const payload = {
    iss: `wire:${ourPeerName}`,
    body_hash: await sha256Hex(body),
    iat: Math.floor(Date.now() / 1000),
  };
  const signingInput = `${b64url(new TextEncoder().encode(JSON.stringify(header)))}.${b64url(new TextEncoder().encode(JSON.stringify(payload)))}`;
  const sig = await crypto.subtle.sign(
    "Ed25519",
    ourIdentity.privateKey,
    new TextEncoder().encode(signingInput),
  );
  return { jwt: `${signingInput}.${b64url(sig)}`, body };
}

/**
 * Verify a peer-forwarded envelope. Returns the source peer's name on
 * success. Throws with a helpful message on any failure — no ambiguity.
 */
export async function verifyForwardedJwt(
  jwt: string,
  body: string,
  store: Store,
): Promise<{ peer: Peer; envelope: ForwardedEnvelope }> {
  const parts = jwt.split(".");
  if (parts.length !== 3) throw new Error("malformed JWT");
  const [h, p, s] = parts;
  const header = JSON.parse(new TextDecoder().decode(fromB64Url(h!)));
  if (header.alg !== "EdDSA") throw new Error(`unexpected alg: ${header.alg}`);
  const payload = JSON.parse(new TextDecoder().decode(fromB64Url(p!)));
  const iss: string = payload.iss ?? "";
  if (!iss.startsWith("wire:")) throw new Error(`unexpected iss: ${iss}`);
  const peerName = iss.slice("wire:".length);
  const peer = store.getPeer(peerName);
  if (!peer) throw new Error(`unknown peer: ${peerName}`);

  // Recompute body hash.
  const expected = await sha256Hex(body);
  if (payload.body_hash !== expected) throw new Error("body_hash mismatch");

  const pubkey = await importPeerPubkey(peer.pubkey);
  const signingInput = new TextEncoder().encode(`${h}.${p}`);
  const ok = await crypto.subtle.verify("Ed25519", pubkey, fromB64Url(s!), signingInput);
  if (!ok) throw new Error("signature verification failed");

  const envelope = JSON.parse(body) as ForwardedEnvelope;
  return { peer, envelope };
}

// --- HTTP helpers ---

/**
 * Ask a peer whether they host `agentId`. Returns true on 200, false
 * on 404, throws on anything else (auth / network / unexpected).
 */
export async function peerHasAgent(peer: Peer, agentId: string): Promise<boolean> {
  const res = await fetch(`${peer.base_url}/peers/agents/${encodeURIComponent(agentId)}`, {
    method: "GET",
    headers: { Accept: "application/json" },
  });
  if (res.status === 200) return true;
  if (res.status === 404) return false;
  throw new Error(`peer probe ${peer.name} returned ${res.status}: ${await res.text().catch(() => "")}`);
}

/** Forward a signed envelope to a peer Wire. */
export async function forwardToPeer(
  peer: Peer,
  ourPeerName: string,
  ourIdentity: ServerIdentity,
  envelope: ForwardedEnvelope,
  log?: Logger,
): Promise<ForwardResult> {
  try {
    const { jwt, body } = await signForwardedEnvelope(ourPeerName, ourIdentity, envelope);
    const res = await fetch(`${peer.base_url}/peers/forward`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${jwt}`,
      },
      body,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      log?.warn({ event: "forward_fail", peer: peer.name, status: res.status, body: text }, "peer forward failed");
      return { ok: false, peer: peer.name, error: `peer responded ${res.status}: ${text.slice(0, 200)}` };
    }
    let remoteSeq: number | undefined;
    try {
      const json = await res.json();
      if (typeof (json as { seq?: number }).seq === "number") remoteSeq = (json as { seq: number }).seq;
    } catch { /* body might not be JSON */ }
    log?.info({ event: "forward_ok", peer: peer.name, dest: envelope.dest, remoteSeq }, "peer forward ok");
    return { ok: true, peer: peer.name, remoteSeq };
  } catch (e) {
    return { ok: false, peer: peer.name, error: (e as Error).message };
  }
}

/**
 * Find the peer that claims `agentId`. Iterates peers in parallel
 * and returns the first positive match. Probe failures are treated
 * as negative (not fatal) so one dead peer doesn't block discovery.
 */
export async function findPeerForAgent(
  store: Store,
  agentId: string,
  log?: Logger,
): Promise<Peer | null> {
  const peers = store.listPeers();
  if (peers.length === 0) return null;
  // Parallel probes. First positive wins.
  const probes = peers.map(async (p) => {
    try {
      const has = await peerHasAgent(p, agentId);
      return has ? p : null;
    } catch (e) {
      log?.debug({ event: "peer_probe_fail", peer: p.name, err: (e as Error).message }, "peer probe failed");
      return null;
    }
  });
  const results = await Promise.all(probes);
  return results.find((r) => r !== null) ?? null;
}
