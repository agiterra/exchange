/**
 * WebAuthn / Passkey authentication for the Wire dashboard.
 *
 * First-claim ownership: first operator to register owns the instance.
 * Invite links for additional operators.
 * Sessions persisted in SQLite — survive restarts.
 */

import type { Store } from "./store.js";

const SESSION_COOKIE = "wire_session";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export function getOperatorFromSession(cookie: string | undefined, store: Store): string | null {
  if (!cookie) return null;
  const token = cookie.split(";").find((c) => c.trim().startsWith(SESSION_COOKIE + "="));
  if (!token) return null;
  const sessionId = token.split("=")[1]?.trim();
  if (!sessionId) return null;
  const session = store.getOperatorSession(sessionId);
  return session?.operator_id ?? null;
}

export function createSession(operatorId: string, store: Store): { sessionId: string; cookie: string } {
  const sessionId = store.createOperatorSession(operatorId, SESSION_TTL_MS);
  return {
    sessionId,
    cookie: `${SESSION_COOKIE}=${sessionId}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL_MS / 1000}`,
  };
}

// --- WebAuthn helpers ---

export function getRpId(): string {
  // Primary RP ID sent to the browser in registration/auth options. A passkey
  // is bound to exactly one RP ID (domain), so this must match the domain the
  // dashboard is served from (e.g. the-wire.ngrok.io for the public tunnel).
  return getRpIds()[0];
}

/** All RP IDs accepted during verification (comma-separated WIRE_RP_ID). */
export function getRpIds(): string[] {
  const raw = process.env.WIRE_RP_ID ?? "localhost";
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

/**
 * Origins accepted during verification. WIRE_ORIGIN (comma-separated) wins;
 * otherwise derived from the RP IDs — https://<rpid> for real domains, plus
 * localhost dev origins so local access keeps working.
 */
export function getExpectedOrigins(): string[] {
  if (process.env.WIRE_ORIGIN) {
    return process.env.WIRE_ORIGIN.split(",").map((s) => s.trim()).filter(Boolean);
  }
  const origins = new Set<string>();
  for (const rpId of getRpIds()) {
    if (rpId === "localhost") {
      const port = process.env.WIRE_PORT ?? "9800";
      origins.add(`http://localhost:${port}`);
      origins.add("http://localhost");
    } else {
      origins.add(`https://${rpId}`);
    }
  }
  return [...origins];
}

export function getRpName(): string {
  return process.env.WIRE_INSTANCE_NAME ?? "The Wire";
}

export function generateRegistrationOptions(store: Store, operatorId: string, displayName: string) {
  const challenge = crypto.randomUUID() + crypto.randomUUID();
  const challengeB64 = Buffer.from(challenge).toString("base64url");
  store.storeChallenge(challengeB64);

  return {
    challenge: challengeB64,
    rp: { id: getRpId(), name: getRpName() },
    user: {
      id: Buffer.from(operatorId).toString("base64url"),
      name: displayName,
      displayName,
    },
    pubKeyCredParams: [
      { type: "public-key", alg: -7 },
      { type: "public-key", alg: -257 },
    ],
    authenticatorSelection: {
      authenticatorAttachment: "platform",
      residentKey: "preferred",
      userVerification: "preferred",
    },
    timeout: 60000,
  };
}

export function generateAuthenticationOptions(store: Store) {
  const challenge = crypto.randomUUID() + crypto.randomUUID();
  const challengeB64 = Buffer.from(challenge).toString("base64url");
  store.storeChallenge(challengeB64);

  return {
    challenge: challengeB64,
    rpId: getRpId(),
    timeout: 60000,
    userVerification: "preferred",
  };
}
