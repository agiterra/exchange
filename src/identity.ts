/**
 * Wire server identity — Ed25519 keypair at ${WIRE_HOME}/server.key.
 *
 * Used for peer-to-peer federation: each Wire signs outgoing
 * peer-forwarded messages with this key, and peers verify against
 * the pubkey they registered for that peer.
 *
 * Storage format: a JSON file containing base64-encoded PKCS8 private
 * key + base64 raw pubkey. Auto-generated on first boot; persisted
 * across restarts.
 */

import { join } from "path";
import { homedir } from "os";
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "fs";

export type ServerIdentity = {
  privateKey: CryptoKey;
  privateKeyB64: string;  // base64 PKCS8, for persisting to disk
  pubkeyB64: string;      // base64 raw, published to peers
};

type OnDisk = {
  privateKeyB64: string;
  pubkeyB64: string;
  createdAt: number;
};

function defaultKeyPath(): string {
  const home = process.env.WIRE_HOME ?? join(process.env.HOME ?? homedir(), ".wire");
  return join(home, "server.key");
}

async function derivePubkeyB64(privateKey: CryptoKey): Promise<string> {
  const jwk = await crypto.subtle.exportKey("jwk", privateKey);
  // Ed25519 jwk has `x` as the raw pubkey (base64url). Convert to std base64.
  const base64url = jwk.x ?? "";
  return base64url.replace(/-/g, "+").replace(/_/g, "/") + "==".slice(0, (4 - base64url.length % 4) % 4);
}

async function exportPrivateKeyB64(privateKey: CryptoKey): Promise<string> {
  const pkcs8 = await crypto.subtle.exportKey("pkcs8", privateKey);
  return Buffer.from(pkcs8).toString("base64");
}

async function importPrivateKeyB64(b64: string): Promise<CryptoKey> {
  const pkcs8 = Buffer.from(b64, "base64");
  return crypto.subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, true, ["sign"]);
}

/**
 * Load the server identity from disk, generating one on first boot.
 * File permissions are set to 0600 — the private key never leaves
 * the local machine.
 */
export async function loadOrCreateServerIdentity(keyPath: string = defaultKeyPath()): Promise<ServerIdentity> {
  if (existsSync(keyPath)) {
    const raw = JSON.parse(readFileSync(keyPath, "utf8")) as OnDisk;
    const privateKey = await importPrivateKeyB64(raw.privateKeyB64);
    return { privateKey, privateKeyB64: raw.privateKeyB64, pubkeyB64: raw.pubkeyB64 };
  }
  // First-boot generation.
  mkdirSync(keyPath.replace(/\/[^/]+$/, ""), { recursive: true });
  const keyPair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair;
  const privateKeyB64 = await exportPrivateKeyB64(keyPair.privateKey);
  const pubkeyB64 = await derivePubkeyB64(keyPair.privateKey);
  const payload: OnDisk = { privateKeyB64, pubkeyB64, createdAt: Date.now() };
  writeFileSync(keyPath, JSON.stringify(payload, null, 2), { mode: 0o600 });
  try { chmodSync(keyPath, 0o600); } catch { /* best-effort */ }
  return { privateKey: keyPair.privateKey, privateKeyB64, pubkeyB64 };
}

/** Read just the pubkey, generating a fresh identity if none exists. */
export async function getServerPubkey(keyPath?: string): Promise<string> {
  const id = await loadOrCreateServerIdentity(keyPath);
  return id.pubkeyB64;
}
