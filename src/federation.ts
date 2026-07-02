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
  // Hard probe timeout: a dark peer behind a live tunnel edge (fournil via
  // ngrok, 2026-07-02) HANGS the fetch indefinitely — without this, every
  // federated delivery on the broker stalls behind the slowest dead peer.
  const res = await fetch(`${peer.base_url}/peers/agents/${encodeURIComponent(agentId)}`, {
    method: "GET",
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(3_000),
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
 *
 * Optional cache short-circuits subsequent lookups for the same agent
 * within the TTL window — a hot agent (Brioche talking to a planner
 * many times in a minute) avoids re-probing every peer for each
 * message.
 */
export async function findPeerForAgent(
  store: Store,
  agentId: string,
  log?: Logger,
  cache?: DiscoveryCache,
): Promise<Peer | null> {
  if (cache) {
    const hit = cache.get(agentId);
    if (hit) {
      // Re-resolve in case the peer's base_url changed since cached.
      const peer = store.getPeer(hit);
      if (peer) return peer;
      cache.invalidate(agentId);
    }
  }
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
  // TRUE first-positive-wins: resolve the moment ANY probe answers yes —
  // do not wait for the losers (Promise.all made every delivery wait for
  // the slowest/hung peer; the 2026-07-02 fournil hang stalled ALL
  // cross-broker traffic on both brokers).
  const winner = await new Promise<Peer | null>((resolve) => {
    let pending = probes.length;
    let done = false;
    for (const probe of probes) {
      void probe.then((p) => {
        if (p !== null && !done) {
          done = true;
          resolve(p);
        }
        pending -= 1;
        if (pending === 0 && !done) {
          done = true;
          resolve(null);
        }
      });
    }
  });
  if (winner && cache) cache.set(agentId, winner.name);
  return winner;
}

/**
 * Positive-discovery cache. Maps agent IDs to the peer name that
 * claimed them; entries TTL out so a moved agent doesn't get
 * forwarded to its old host indefinitely.
 *
 * Negative results are intentionally NOT cached — a peer that comes
 * online or registers a new agent should be discoverable on the next
 * forward attempt without waiting for a TTL.
 */
export class DiscoveryCache {
  private entries = new Map<string, { peer: string; expiresAt: number }>();
  constructor(private ttlMs: number = 60_000) {}

  get(agentId: string): string | null {
    const hit = this.entries.get(agentId);
    if (!hit) return null;
    if (hit.expiresAt < Date.now()) {
      this.entries.delete(agentId);
      return null;
    }
    return hit.peer;
  }

  set(agentId: string, peer: string): void {
    this.entries.set(agentId, { peer, expiresAt: Date.now() + this.ttlMs });
  }

  invalidate(agentId: string): void {
    this.entries.delete(agentId);
  }

  clear(): void {
    this.entries.clear();
  }

  size(): number {
    return this.entries.size;
  }
}

/**
 * URL refresh — signed announcement of our current public base_url
 * to a peer. Used at boot when ngrok hands us a fresh hostname; the
 * peer updates its peers.base_url for our entry so subsequent
 * forwards reach us.
 *
 * Same JWT shape as forwardToPeer, with a body of
 *   {name: ourPeerName, base_url: ourPublicUrl, ts: now}
 * so the recipient knows which peer is announcing AND can
 * resist rollback (later announcements supersede earlier ones).
 */
export async function announceUrlToPeer(
  peer: Peer,
  ourPeerName: string,
  ourIdentity: ServerIdentity,
  ourPublicUrl: string,
  log?: Logger,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const body = JSON.stringify({ name: ourPeerName, base_url: ourPublicUrl, ts: Date.now() });
    const { jwt } = await signRefreshJwt(ourPeerName, ourIdentity, body);
    const res = await fetch(`${peer.base_url}/peers/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
      body,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      log?.warn({ event: "refresh_fail", peer: peer.name, status: res.status, body: text }, "peer URL refresh failed");
      return { ok: false, error: `peer responded ${res.status}` };
    }
    log?.info({ event: "refresh_ok", peer: peer.name, our_url: ourPublicUrl }, "URL announced to peer");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** Sign-side helper for URL refresh — same shape as forwarded envelope. */
export async function signRefreshJwt(
  ourPeerName: string,
  ourIdentity: ServerIdentity,
  body: string,
): Promise<{ jwt: string }> {
  const header = { alg: "EdDSA", typ: "JWT" };
  const payload = {
    iss: `wire:${ourPeerName}`,
    body_hash: await sha256Hex(body),
    iat: Math.floor(Date.now() / 1000),
  };
  const signingInput = `${b64url(new TextEncoder().encode(JSON.stringify(header)))}.${b64url(new TextEncoder().encode(JSON.stringify(payload)))}`;
  const sig = await crypto.subtle.sign("Ed25519", ourIdentity.privateKey, new TextEncoder().encode(signingInput));
  return { jwt: `${signingInput}.${b64url(sig)}` };
}

/** Verify a refresh JWT and return the announcing peer + parsed body. */
export async function verifyRefreshJwt(
  jwt: string,
  body: string,
  store: Store,
): Promise<{ peer: Peer; announced: { name: string; base_url: string; ts: number } }> {
  // Reuse the forward verification — the JWT shape is identical.
  // We just don't need the inner ForwardedEnvelope.
  const { peer } = await verifyForwardedJwt(jwt, body, store);
  const announced = JSON.parse(body) as { name: string; base_url: string; ts: number };
  if (announced.name !== peer.name) {
    throw new Error(`refresh body name '${announced.name}' does not match jwt iss peer '${peer.name}'`);
  }
  return { peer, announced };
}
