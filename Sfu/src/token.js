import crypto from "node:crypto";

function base64UrlDecodeToBuffer(s) {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const b64 = (s + pad).replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(b64, "base64");
}

function base64UrlEncode(buf) {
  return Buffer.from(buf)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

export function verifySfuToken(token, secret) {
  if (!token || typeof token !== "string") return { ok: false, error: "missing_token" };
  const parts = token.split(".");
  if (parts.length !== 2) return { ok: false, error: "bad_format" };
  const [payloadB64, sigB64] = parts;
  if (!payloadB64 || !sigB64) return { ok: false, error: "bad_format" };

  const expectedSig = crypto
    .createHmac("sha256", Buffer.from(secret, "utf8"))
    .update(Buffer.from(payloadB64, "utf8"))
    .digest();
  const expectedSigB64 = base64UrlEncode(expectedSig);
  if (!crypto.timingSafeEqual(Buffer.from(expectedSigB64), Buffer.from(sigB64))) {
    return { ok: false, error: "bad_signature" };
  }

  let payloadJson;
  try {
    payloadJson = base64UrlDecodeToBuffer(payloadB64).toString("utf8");
  } catch {
    return { ok: false, error: "bad_payload" };
  }

  let payload;
  try {
    payload = JSON.parse(payloadJson);
  } catch {
    return { ok: false, error: "bad_payload" };
  }

  const exp = payload?.exp ? Date.parse(payload.exp) : NaN;
  if (!Number.isFinite(exp)) return { ok: false, error: "bad_exp" };
  if (Date.now() > exp) return { ok: false, error: "expired" };

  const userId = String(payload?.userId || "");
  const roomId = String(payload?.roomId || "");
  if (!userId || !roomId) return { ok: false, error: "missing_claims" };

  return { ok: true, userId, roomId, v: payload?.v ?? 1 };
}

