/**
 * HMAC-SHA256 webhook validation.
 *
 * Used by GitHub (X-Hub-Signature-256) and Slack (X-Slack-Signature)
 * webhook validators. Each has slightly different header/format conventions
 * but the core HMAC operation is the same.
 */

/**
 * Compute HMAC-SHA256 of a body with a secret key.
 */
export async function hmacSha256(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Validate GitHub webhook signature.
 * Header format: sha256=<hex>
 */
export async function validateGitHub(
  secret: string,
  body: string,
  signatureHeader: string,
): Promise<boolean> {
  if (!signatureHeader.startsWith("sha256=")) return false;
  const expected = signatureHeader.slice(7);
  const actual = await hmacSha256(secret, body);
  return timingSafeEqual(expected, actual);
}

/**
 * Validate Slack webhook signature.
 * Basestring: v0:{timestamp}:{body}
 * Header format: v0=<hex>
 */
export async function validateSlack(
  signingSecret: string,
  body: string,
  signatureHeader: string,
  timestampHeader: string,
): Promise<boolean> {
  // Replay protection: reject timestamps older than 5 minutes
  const ts = parseInt(timestampHeader, 10);
  if (isNaN(ts) || Math.abs(Date.now() / 1000 - ts) > 300) return false;

  if (!signatureHeader.startsWith("v0=")) return false;
  const expected = signatureHeader.slice(3);
  const basestring = `v0:${timestampHeader}:${body}`;
  const actual = await hmacSha256(signingSecret, basestring);
  return timingSafeEqual(expected, actual);
}

/**
 * Constant-time string comparison to prevent timing attacks.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}
