const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";
const SHEETS_API = "https://sheets.googleapis.com/v4/spreadsheets";
const OAUTH_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/spreadsheets",
];
const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
const METHODS = new Set(["after", "between", "number", "money", "date", "email", "phone", "regex", "source"]);
const SOURCE_FIELDS = new Set(["subject", "from", "date", "receivedAt", "body"]);
const SESSION_IDLE_SECONDS = 7 * 24 * 60 * 60;
const SESSION_IDLE_MS = SESSION_IDLE_SECONDS * 1000;
// Real extraction-rule IDs are positive AUTOINCREMENT values. Rule 0 is
// reserved for sheet-delivery receipts shared by test, manual and push runs.
const SHEET_DELIVERY_RECEIPT_RULE_ID = 0;

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...JSON_HEADERS, "cache-control": "no-store", ...headers },
  });
}

function publicVisitorCookie(value) {
  return `mailsheet_visitor=${encodeURIComponent(value)}; Path=/; Max-Age=31536000; HttpOnly; Secure; SameSite=Lax`;
}

function safeReferrerHost(value) {
  if (!value) return "";
  try { return new URL(value).hostname.slice(0, 180); } catch { return ""; }
}

function apiError(message, status = 400, code = "bad_request", details) {
  return json({ ok: false, error: { code, message, ...(details ? { details } : {}) } }, status);
}

async function userFromRequest(request, env) {
  if (env?.TOKEN_ENCRYPTION_KEY) {
    const session = await readSignedCookie(cookieValue(request, "mailsheet_session"), env.TOKEN_ENCRYPTION_KEY);
    if (session?.userId && session?.email && Number(session.expiresAt) > Date.now()) {
      return { id: String(session.userId), email: String(session.email) };
    }
  }
  const url = new URL(request.url);
  if (["localhost", "127.0.0.1"].includes(url.hostname)) {
    return {
      id: request.headers.get("x-mailsheet-dev-user") || "local-preview-user",
      email: "local-preview@example.com",
    };
  }
  return null;
}

async function requireUser(request, env) {
  const user = await userFromRequest(request, env);
  if (!user) throw new HttpError(401, "このページへのログインが必要です。", "unauthorized");
  return user;
}

function adminEmails(env) {
  return new Set(String(env.ADMIN_EMAILS || "").split(",").map((value) => value.trim().toLowerCase()).filter(Boolean));
}

async function appAccess(env, user, track = false) {
  const email = String(user.email || "").trim().toLowerCase();
  if (!email) return { allowed: false, role: "", status: "missing_email" };
  const db = requireDb(env);
  const now = new Date().toISOString();
  if (adminEmails(env).has(email)) {
    await db.prepare(
      `INSERT INTO app_users (email, role, status, invited_by, created_at, updated_at, last_access_at, access_count)
       VALUES (?, 'admin', 'active', 'system', ?, ?, ?, 1)
       ON CONFLICT(email) DO UPDATE SET role = 'admin', status = 'active', updated_at = excluded.updated_at,
         last_access_at = CASE WHEN ? THEN excluded.last_access_at ELSE app_users.last_access_at END,
         access_count = app_users.access_count + CASE WHEN ? THEN 1 ELSE 0 END`,
    ).bind(email, now, now, track ? now : "", track ? 1 : 0, track ? 1 : 0).run();
  }
  let row = await db.prepare("SELECT email, role, status FROM app_users WHERE email = ?").bind(email).first();
  if (!row || row.status === "suspended") return { allowed: false, role: row?.role || "", status: row?.status || "not_invited" };
  if (track && !adminEmails(env).has(email)) {
    await db.prepare("UPDATE app_users SET status = 'active', last_access_at = ?, access_count = access_count + 1, updated_at = ? WHERE email = ?")
      .bind(now, now, email).run();
    row = { ...row, status: "active" };
  }
  if (track) {
    await db.prepare("INSERT INTO access_events (user_id, email, event_type, created_at) VALUES (?, ?, 'app_open', ?)")
      .bind(user.id, email, now).run();
  }
  return { allowed: true, role: row.role, status: row.status };
}

async function requireAuthorizedUser(request, env) {
  const user = await requireUser(request, env);
  const access = await appAccess(env, user);
  if (!access.allowed) throw new HttpError(403, "この先行版は招待された方だけ利用できます。", "invite_required");
  const connection = await connectionRow(env, user.id, user.email);
  return { ...user, id: connection?.user_id || user.id, role: access.role };
}

async function requireAdmin(request, env) {
  const user = await requireAuthorizedUser(request, env);
  if (user.role !== "admin") throw new HttpError(403, "管理者権限が必要です。", "admin_required");
  return user;
}

class HttpError extends Error {
  constructor(status, message, code = "request_failed", details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function requireDb(env) {
  if (!env.DB) throw new HttpError(503, "データベースを準備中です。", "database_unavailable");
  return env.DB;
}

function oauthConfigured(env) {
  return Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.TOKEN_ENCRYPTION_KEY);
}

function gmailPushConfigured(env) {
  return Boolean(env.GOOGLE_PUBSUB_TOPIC && env.PUBSUB_WEBHOOK_SECRET);
}

function bytesToBase64Url(bytes) {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 1) binary += String.fromCharCode(bytes[index]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToBytes(value) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function randomUrlSafe(byteLength = 32) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

async function sha256(value) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

async function encryptionKey(secret) {
  return crypto.subtle.importKey("raw", await sha256(secret), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

async function encryptSecret(value, secret) {
  if (!value) return null;
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const cipher = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await encryptionKey(secret), new TextEncoder().encode(value)),
  );
  return `v1.${bytesToBase64Url(iv)}.${bytesToBase64Url(cipher)}`;
}

async function decryptSecret(value, secret) {
  if (!value) return "";
  const [version, ivValue, cipherValue] = value.split(".");
  if (version !== "v1" || !ivValue || !cipherValue) throw new Error("Encrypted value is invalid");
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64UrlToBytes(ivValue) },
    await encryptionKey(secret),
    base64UrlToBytes(cipherValue),
  );
  return new TextDecoder().decode(plain);
}

async function signValue(value, secret) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return bytesToBase64Url(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value))));
}

async function createSignedCookie(payload, secret) {
  const encoded = bytesToBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
  return `${encoded}.${await signValue(encoded, secret)}`;
}

async function readSignedCookie(value, secret) {
  if (!value) return null;
  const separator = value.lastIndexOf(".");
  if (separator < 0) return null;
  const encoded = value.slice(0, separator);
  const signature = value.slice(separator + 1);
  const expected = await signValue(encoded, secret);
  if (signature.length !== expected.length) return null;
  let mismatch = 0;
  for (let index = 0; index < signature.length; index += 1) mismatch |= signature.charCodeAt(index) ^ expected.charCodeAt(index);
  if (mismatch !== 0) return null;
  try {
    return JSON.parse(new TextDecoder().decode(base64UrlToBytes(encoded)));
  } catch {
    return null;
  }
}

function cookieValue(request, name) {
  const cookies = request.headers.get("cookie") || "";
  for (const part of cookies.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return "";
}

function oauthCookie(value, maxAge = 600) {
  return `mailsheet_google_oauth=${value}; Path=/api/oauth/google; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}

function sessionCookie(value, maxAge = SESSION_IDLE_SECONDS) {
  return `mailsheet_session=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}

async function refreshSession(request, env, response) {
  const pathname = new URL(request.url).pathname;
  if (!env.TOKEN_ENCRYPTION_KEY) return response;
  if (pathname === "/api/auth/logout" || pathname.startsWith("/api/oauth/") || pathname.startsWith("/api/public/") || pathname.startsWith("/api/webhooks/")) return response;
  const user = await userFromRequest(request, env);
  if (!user) return response;
  const session = await createSignedCookie(
    { userId: user.id, email: user.email, expiresAt: Date.now() + SESSION_IDLE_MS },
    env.TOKEN_ENCRYPTION_KEY,
  );
  const headers = new Headers(response.headers);
  headers.append("set-cookie", sessionCookie(session));
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function assertSameOrigin(request) {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) {
    throw new HttpError(403, "許可されていない送信元です。", "origin_mismatch");
  }
}

async function readJson(request, maxBytes = 150_000) {
  const length = Number(request.headers.get("content-length") || 0);
  if (length > maxBytes) throw new HttpError(413, "送信内容が大きすぎます。", "payload_too_large");
  const text = await request.text();
  if (text.length > maxBytes) throw new HttpError(413, "送信内容が大きすぎます。", "payload_too_large");
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new HttpError(400, "JSON形式が正しくありません。", "invalid_json");
  }
}

async function googleError(response, fallback) {
  let message = fallback;
  try {
    const payload = await response.json();
    message = payload?.error?.message || payload?.error_description || message;
  } catch {
    // Google can return an empty or non-JSON error response.
  }
  return new HttpError(response.status === 401 ? 401 : 502, message, "google_api_error", { googleStatus: response.status });
}

async function connectionRow(env, userId, email = "") {
  const derivedEmail = String(email || (String(userId).startsWith("google:") ? String(userId).slice(7) : "")).trim().toLowerCase();
  return requireDb(env)
    .prepare(
      `SELECT user_id, google_email, access_token_enc, refresh_token_enc, expires_at, scopes,
              gmail_history_id, gmail_watch_expires_at, last_gmail_notification_at,
              last_watch_renewed_at, created_at, updated_at
       FROM google_connections
       WHERE user_id = ? OR (? <> '' AND lower(google_email) = ?)
       ORDER BY updated_at DESC LIMIT 1`,
    )
    .bind(userId, derivedEmail, derivedEmail)
    .first();
}

async function validAccessToken(env, userId) {
  if (!oauthConfigured(env)) throw new HttpError(503, "Google OAuthの環境設定が必要です。", "oauth_not_configured");
  const row = await connectionRow(env, userId);
  if (!row) throw new HttpError(401, "Googleアカウントを接続してください。", "google_not_connected");
  if (Number(row.expires_at) > Date.now() + 60_000) {
    try {
      return await decryptSecret(row.access_token_enc, env.TOKEN_ENCRYPTION_KEY);
    } catch {
      throw new HttpError(401, "Google接続情報を読み取れません。Google連携画面から再ログインしてください。", "google_reconnect_required");
    }
  }
  if (!row.refresh_token_enc) {
    throw new HttpError(401, "Google接続の有効期限が切れました。再接続してください。", "google_reconnect_required");
  }
  let refreshToken;
  try {
    refreshToken = await decryptSecret(row.refresh_token_enc, env.TOKEN_ENCRYPTION_KEY);
  } catch {
    throw new HttpError(401, "Google接続情報を読み取れません。Google連携画面から再ログインしてください。", "google_reconnect_required");
  }
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  if (!response.ok) throw await googleError(response, "Google接続を更新できませんでした。");
  const tokens = await response.json();
  const now = new Date().toISOString();
  const expiresAt = Date.now() + Number(tokens.expires_in || 3600) * 1000;
  const encryptedAccess = await encryptSecret(tokens.access_token, env.TOKEN_ENCRYPTION_KEY);
  await requireDb(env)
    .prepare("UPDATE google_connections SET access_token_enc = ?, expires_at = ?, updated_at = ? WHERE user_id = ?")
    .bind(encryptedAccess, expiresAt, now, userId)
    .run();
  return tokens.access_token;
}

async function googleFetch(env, userId, url, init = {}) {
  const token = await validAccessToken(env, userId);
  const headers = new Headers(init.headers || {});
  headers.set("authorization", `Bearer ${token}`);
  const response = await fetch(url, { ...init, headers });
  if (!response.ok) throw await googleError(response, "Googleとの通信に失敗しました。");
  return response;
}

async function registerGmailWatch(env, userId) {
  if (!gmailPushConfigured(env)) return null;
  const response = await googleFetch(env, userId, `${GMAIL_API}/watch`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      topicName: env.GOOGLE_PUBSUB_TOPIC,
    }),
  });
  const watch = await response.json();
  await requireDb(env)
    .prepare("UPDATE google_connections SET gmail_history_id = ?, gmail_watch_expires_at = ?, last_watch_renewed_at = ?, updated_at = ? WHERE user_id = ?")
    .bind(String(watch.historyId || ""), Number(watch.expiration || 0), new Date().toISOString(), new Date().toISOString(), userId)
    .run();
  await requireDb(env).prepare("INSERT INTO system_events (user_id, event_type, detail, created_at) VALUES (?, 'watch_renewal', '', ?)")
    .bind(userId, new Date().toISOString()).run();
  return watch;
}

async function handleOAuthStart(request, env) {
  if (!oauthConfigured(env)) return apiError("Google OAuthの環境設定がまだ完了していません。", 503, "oauth_not_configured");
  const state = randomUrlSafe(24);
  const verifier = randomUrlSafe(48);
  const challenge = bytesToBase64Url(await sha256(verifier));
  const cookie = await createSignedCookie(
    { state, verifier, expiresAt: Date.now() + 10 * 60_000 },
    env.TOKEN_ENCRYPTION_KEY,
  );
  const redirectUri = new URL("/api/oauth/google/callback", request.url).toString();
  const authUrl = new URL(GOOGLE_AUTH_URL);
  authUrl.search = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: OAUTH_SCOPES.join(" "),
    access_type: "offline",
    include_granted_scopes: "true",
    prompt: "consent",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();
  return new Response(null, {
    status: 302,
    headers: { location: authUrl.toString(), "set-cookie": oauthCookie(cookie), "cache-control": "no-store" },
  });
}

function appRedirect(request, status, reason = "", session = "") {
  const url = new URL("/app", request.url);
  url.searchParams.set("google", status);
  if (reason) url.searchParams.set("reason", reason.slice(0, 120));
  const headers = new Headers({ location: url.toString(), "cache-control": "no-store" });
  headers.append("set-cookie", oauthCookie("", 0));
  if (session) headers.append("set-cookie", sessionCookie(session));
  return new Response(null, {
    status: 302,
    headers,
  });
}

async function handleOAuthCallback(request, env) {
  if (!oauthConfigured(env)) return appRedirect(request, "error", "OAuth設定がありません");
  const url = new URL(request.url);
  if (url.searchParams.get("error")) return appRedirect(request, "error", "Google接続がキャンセルされました");
  const signed = await readSignedCookie(cookieValue(request, "mailsheet_google_oauth"), env.TOKEN_ENCRYPTION_KEY);
  if (
    !signed ||
    signed.state !== url.searchParams.get("state") ||
    Number(signed.expiresAt) < Date.now()
  ) {
    return appRedirect(request, "error", "認証リクエストの有効期限が切れました");
  }
  const code = url.searchParams.get("code");
  if (!code) return appRedirect(request, "error", "認証コードを取得できませんでした");
  const redirectUri = new URL("/api/oauth/google/callback", request.url).toString();
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
      code_verifier: signed.verifier,
    }),
  });
  if (!response.ok) return appRedirect(request, "error", "Google認証情報を交換できませんでした");
  const tokens = await response.json();
  if (!tokens.access_token) return appRedirect(request, "error", "アクセストークンを取得できませんでした");
  const profileResponse = await fetch(`${GMAIL_API}/profile`, {
    headers: { authorization: `Bearer ${tokens.access_token}` },
  });
  if (!profileResponse.ok) return appRedirect(request, "error", "Gmailプロフィールを確認できませんでした");
  const profile = await profileResponse.json();
  const googleEmail = String(profile.emailAddress || "").trim().toLowerCase();
  if (!googleEmail) return appRedirect(request, "error", "Googleアカウントのメールアドレスを確認できませんでした");
  const linked = await requireDb(env)
    .prepare("SELECT user_id FROM google_connections WHERE lower(google_email) = ? ORDER BY updated_at DESC LIMIT 1")
    .bind(googleEmail)
    .first();
  const user = { id: linked?.user_id || `google:${googleEmail}`, email: googleEmail };
  const session = await createSignedCookie(
    { userId: user.id, email: user.email, expiresAt: Date.now() + SESSION_IDLE_MS },
    env.TOKEN_ENCRYPTION_KEY,
  );
  const access = await appAccess(env, user, true);
  if (!access.allowed) {
    try {
      await fetch(GOOGLE_REVOKE_URL, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: tokens.access_token }),
      });
    } catch {
      // The short-lived token is not stored and will expire even if revocation is unavailable.
    }
    return appRedirect(request, "invite", "このGoogleアカウントはまだ招待されていません", session);
  }
  const previous = await connectionRow(env, user.id);
  const now = new Date().toISOString();
  const accessTokenEnc = await encryptSecret(tokens.access_token, env.TOKEN_ENCRYPTION_KEY);
  const refreshTokenEnc = tokens.refresh_token
    ? await encryptSecret(tokens.refresh_token, env.TOKEN_ENCRYPTION_KEY)
    : previous?.refresh_token_enc || null;
  await requireDb(env)
    .prepare(
      `INSERT INTO google_connections
       (user_id, google_email, access_token_enc, refresh_token_enc, expires_at, scopes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         google_email = excluded.google_email,
         access_token_enc = excluded.access_token_enc,
         refresh_token_enc = COALESCE(excluded.refresh_token_enc, google_connections.refresh_token_enc),
         expires_at = excluded.expires_at,
         scopes = excluded.scopes,
         updated_at = excluded.updated_at`,
    )
    .bind(
      user.id,
      googleEmail,
      accessTokenEnc,
      refreshTokenEnc,
      Date.now() + Number(tokens.expires_in || 3600) * 1000,
      tokens.scope || OAUTH_SCOPES.join(" "),
      previous?.created_at || now,
      now,
    )
    .run();
  if (gmailPushConfigured(env)) {
    try {
      await registerGmailWatch(env, user.id);
    } catch (error) {
      console.error("Gmail watch registration failed", error);
    }
  }
  return appRedirect(request, "connected", "", session);
}

async function handleAuthStatus(request, env) {
  const user = await requireUser(request, env);
  const access = env.DB
    ? await appAccess(env, user, true)
    : { allowed: true, role: "tester", status: "active" };
  const configured = oauthConfigured(env);
  const row = configured && access.allowed ? await connectionRow(env, user.id, user.email) : null;
  return json({
    ok: true,
    configured,
    connected: Boolean(row),
    googleEmail: row?.google_email || "",
    expiresAt: row?.expires_at || null,
    grantedScopes: row ? String(row.scopes).split(" ").filter(Boolean) : [],
    gmailPushConfigured: gmailPushConfigured(env),
    gmailWatchActive: Boolean(row?.gmail_watch_expires_at && Number(row.gmail_watch_expires_at) > Date.now()),
    gmailWatchExpiresAt: row?.gmail_watch_expires_at || null,
    lastGmailNotificationAt: row?.last_gmail_notification_at || null,
    access,
    appUser: { email: user.email },
    callbackUrl: new URL("/api/oauth/google/callback", request.url).toString(),
  });
}

async function handleDisconnect(request, env) {
  assertSameOrigin(request);
  const user = await requireAuthorizedUser(request, env);
  const row = await connectionRow(env, user.id);
  if (row && oauthConfigured(env)) {
    try {
      const revokeToken = row.refresh_token_enc
        ? await decryptSecret(row.refresh_token_enc, env.TOKEN_ENCRYPTION_KEY)
        : await decryptSecret(row.access_token_enc, env.TOKEN_ENCRYPTION_KEY);
      await fetch(GOOGLE_REVOKE_URL, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: revokeToken }),
      });
    } catch {
      // Local removal still proceeds if Google's revocation endpoint is temporarily unavailable.
    }
  }
  await requireDb(env).prepare("DELETE FROM google_connections WHERE user_id = ?").bind(user.id).run();
  return json({ ok: true, connected: false });
}

async function handleLogout(request) {
  assertSameOrigin(request);
  return json({ ok: true }, 200, { "set-cookie": sessionCookie("", 0) });
}

function decodeBody(data) {
  if (!data) return "";
  try {
    return new TextDecoder().decode(base64UrlToBytes(data));
  } catch {
    return "";
  }
}

function htmlToText(html) {
  const entities = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (_, entity) => {
      if (entity[0] === "#") {
        const hex = entity[1]?.toLowerCase() === "x";
        const code = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : " ";
      }
      return entities[entity.toLowerCase()] || " ";
    })
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function bodyFromPayload(payload) {
  if (!payload) return "";
  if (payload.mimeType === "text/plain" && payload.body?.data) return decodeBody(payload.body.data);
  const parts = payload.parts || [];
  for (const part of parts) {
    const plain = bodyFromPayload(part);
    if (plain && (part.mimeType === "text/plain" || !part.mimeType?.startsWith("text/html"))) return plain;
  }
  if (payload.mimeType === "text/html" && payload.body?.data) return htmlToText(decodeBody(payload.body.data));
  for (const part of parts) {
    if (part.mimeType === "text/html" && part.body?.data) return htmlToText(decodeBody(part.body.data));
  }
  return decodeBody(payload.body?.data);
}

function decodeMimeHeader(value) {
  return String(value || "").replace(/=\?([^?]+)\?([bq])\?([^?]*)\?=/gi, (match, charset, encoding, encoded) => {
    try {
      let binary = "";
      if (String(encoding).toLowerCase() === "b") {
        binary = atob(encoded);
      } else {
        const quoted = String(encoded).replace(/_/g, " ");
        for (let index = 0; index < quoted.length; index += 1) {
          if (quoted[index] === "=" && /^[0-9a-f]{2}$/i.test(quoted.slice(index + 1, index + 3))) {
            binary += String.fromCharCode(Number.parseInt(quoted.slice(index + 1, index + 3), 16));
            index += 2;
          } else binary += quoted[index];
        }
      }
      const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
      return new TextDecoder(String(charset || "utf-8")).decode(bytes);
    } catch {
      return match;
    }
  });
}

function headerValue(payload, name) {
  const raw = payload?.headers?.find((header) => header.name?.toLowerCase() === name.toLowerCase())?.value || "";
  return decodeMimeHeader(raw);
}

async function getGmailMessage(env, userId, messageId) {
  const response = await googleFetch(env, userId, `${GMAIL_API}/messages/${encodeURIComponent(messageId)}?format=full`);
  const message = await response.json();
  return {
    id: message.id,
    threadId: message.threadId,
    from: headerValue(message.payload, "From"),
    subject: headerValue(message.payload, "Subject") || "（件名なし）",
    date: headerValue(message.payload, "Date"),
    receivedAt: message.internalDate ? new Date(Number(message.internalDate)).toISOString() : new Date().toISOString(),
    snippet: message.snippet || "",
    body: bodyFromPayload(message.payload) || message.snippet || "",
  };
}

function gmailQuery(sender, subject, accountEmail = "") {
  const chunks = [];
  const cleanSender = String(sender || "").normalize("NFKC").trim().replace(/["\\]/g, "");
  const cleanSubject = String(subject || "").normalize("NFKC").trim().replace(/["\\]/g, "");
  const normalizeAddress = (value) => String(value || "").normalize("NFKC").toLowerCase().replace(/\s+/g, "").trim();
  if (cleanSender || cleanSubject) chunks.push("in:anywhere");
  if (cleanSender) {
    const isOwnAddress = cleanSender.includes("@") && normalizeAddress(cleanSender) === normalizeAddress(accountEmail);
    chunks.push(isOwnAddress ? `{from:me from:${cleanSender}}` : cleanSender.includes("@") ? `from:${cleanSender}` : `"${cleanSender}"`);
  }
  if (cleanSubject) chunks.push(`subject:"${cleanSubject}"`);
  return chunks.join(" ");
}

function normalizeMailSearch(value) {
  return decodeMimeHeader(String(value || ""))
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\u200b-\u200d\ufeff]/g, "")
    .replace(/[\s\u3000]+/g, "")
    .replace(/[<>"'「」『』【】（）()]/g, "")
    .trim();
}

function senderMatches(fromHeader, sender) {
  const needle = normalizeMailSearch(sender);
  if (!needle) return true;
  const haystack = normalizeMailSearch(fromHeader);
  if (haystack.includes(needle)) return true;
  const requestedEmail = String(sender || "").match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0]?.toLowerCase();
  const headerEmail = String(fromHeader || "").match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0]?.toLowerCase();
  return Boolean(requestedEmail && headerEmail && requestedEmail === headerEmail);
}

async function searchGmail(env, userId, sender, subject, limit, includeRecentFallback = true) {
  const params = new URLSearchParams({ maxResults: String(Math.min(Math.max(limit || 8, 1), 20)) });
  const connection = await connectionRow(env, userId);
  const accountEmail = String(connection?.google_email || "").trim().toLowerCase();
  const query = gmailQuery(sender, subject, accountEmail);
  if (query) params.set("q", query);
  const response = await googleFetch(env, userId, `${GMAIL_API}/messages?${params}`);
  const data = await response.json();
  const candidates = await Promise.all((data.messages || []).map((message) => getGmailMessage(env, userId, message.id)));
  const subjectNeedle = normalizeMailSearch(subject);
  const exact = candidates.filter((message) => {
    const senderMatch = !sender || senderMatches(message.from, sender);
    const normalizedSubject = normalizeMailSearch(message.subject);
    const subjectMatch = !subjectNeedle || normalizedSubject.includes(subjectNeedle);
    return senderMatch && subjectMatch;
  });
  if (exact.length || (!sender && !subject)) return { messages: exact, matchMode: "exact" };
  if (!includeRecentFallback) return { messages: [], matchMode: "recent" };

  // Gmail's search grammar can miss self-sent mail, emoji and punctuation-heavy subjects.
  // Fall back to recent messages so the user can select the sample instead of editing search syntax.
  // Keep total Google API subrequests comfortably below the Workers request limit.
  // The list request is followed by one full-message request per result.
  const recentParams = new URLSearchParams({ maxResults: "40", q: "in:anywhere" });
  const recentResponse = await googleFetch(env, userId, `${GMAIL_API}/messages?${recentParams}`);
  const recentData = await recentResponse.json();
  const recent = await Promise.all((recentData.messages || []).map((message) => getGmailMessage(env, userId, message.id)));
  const closeMatches = recent.filter((message) => {
    const senderMatch = senderMatches(message.from, sender);
    const normalizedSubject = normalizeMailSearch(message.subject);
    const subjectMatch = !subjectNeedle || normalizedSubject.includes(subjectNeedle) || subjectNeedle.includes(normalizedSubject);
    return senderMatch && subjectMatch;
  });
  return {
    messages: (closeMatches.length ? closeMatches : recent).slice(0, Math.min(Math.max(limit || 8, 1), 20)),
    matchMode: closeMatches.length ? "exact" : "recent",
  };
}

function messageMatchesRule(message, rule) {
  const subjectNeedle = normalizeMailSearch(rule.subjectContains);
  return (!rule.sender || senderMatches(message.from, rule.sender))
    && (!subjectNeedle || normalizeMailSearch(message.subject).includes(subjectNeedle));
}

function newerHistoryId(candidate, current) {
  if (!candidate) return false;
  if (!current) return true;
  try {
    return BigInt(candidate) > BigInt(current);
  } catch {
    return candidate !== current;
  }
}

async function gmailMessagesAddedSince(env, userId, startHistoryId) {
  if (!startHistoryId) return { messages: [], historyId: "" };
  const messageIds = [];
  const seen = new Set();
  let historyId = String(startHistoryId);
  let pageToken = "";
  // 通常は1通知につき1通。大量受信時もWorkerの外部通信上限を超えない範囲で追跡する。
  for (let page = 0; page < 3 && messageIds.length < 20; page += 1) {
    const params = new URLSearchParams({
      startHistoryId: String(startHistoryId),
      historyTypes: "messageAdded",
      maxResults: "100",
    });
    if (pageToken) params.set("pageToken", pageToken);
    const response = await googleFetch(env, userId, `${GMAIL_API}/history?${params}`);
    const data = await response.json();
    historyId = String(data.historyId || historyId);
    for (const history of data.history || []) {
      for (const added of history.messagesAdded || []) {
        const id = String(added?.message?.id || "");
        if (id && !seen.has(id)) {
          seen.add(id);
          messageIds.push(id);
        }
      }
    }
    pageToken = String(data.nextPageToken || "");
    if (!pageToken) break;
  }
  const messages = await Promise.all(messageIds.slice(0, 20).map((id) => getGmailMessage(env, userId, id)));
  return { messages, historyId };
}

async function handleGmailMessages(request, env) {
  const user = await requireAuthorizedUser(request, env);
  const url = new URL(request.url);
  const result = await searchGmail(
    env,
    user.id,
    url.searchParams.get("from") || "",
    url.searchParams.get("subject") || "",
    Number(url.searchParams.get("limit") || 8),
  );
  return json({ ok: true, messages: result.messages, matchMode: result.matchMode });
}

function spreadsheetId(value) {
  const input = String(value || "").trim();
  const fromUrl = input.match(/\/spreadsheets\/d\/([A-Za-z0-9_-]+)/)?.[1];
  const id = fromUrl || input;
  if (!/^[A-Za-z0-9_-]{10,}$/.test(id)) {
    throw new HttpError(400, "SpreadsheetのURLまたはIDを確認してください。", "invalid_spreadsheet_id");
  }
  return id;
}

function sheetRange(sheetName, range) {
  const escaped = String(sheetName).replace(/'/g, "''");
  return `'${escaped}'!${range}`;
}

function columnName(index) {
  let value = index + 1;
  let name = "";
  while (value > 0) {
    value -= 1;
    name = String.fromCharCode(65 + (value % 26)) + name;
    value = Math.floor(value / 26);
  }
  return name;
}

function resolveMappedSheetColumn(headers, mappedValue) {
  const value = String(mappedValue || "").trim();
  if (!value) return "";
  const columnToken = value.match(/^([A-Z]{1,5})列?$/i)?.[1]?.toUpperCase() || "";
  if (columnToken && headers.some((header) => header.column === columnToken)) return columnToken;
  // 旧ルールは見出し名を保存していたため、同名見出しが複数ある場合は最初の1列だけへ移行する。
  return headers.find((header) => header.label === value)?.column || "";
}

async function inspectSheet(env, userId, inputId, requestedSheetName) {
  const id = spreadsheetId(inputId);
  const metadataResponse = await googleFetch(
    env,
    userId,
    `${SHEETS_API}/${encodeURIComponent(id)}?fields=properties.title%2Csheets.properties(sheetId%2Ctitle%2Cindex)`,
  );
  const metadata = await metadataResponse.json();
  const sheetTitles = (metadata.sheets || []).map((sheet) => sheet.properties?.title).filter(Boolean);
  const selectedSheet = sheetTitles.includes(requestedSheetName) ? requestedSheetName : sheetTitles[0];
  if (!selectedSheet) throw new HttpError(400, "利用できるSheetが見つかりません。", "sheet_not_found");
  const range = encodeURIComponent(sheetRange(selectedSheet, "1:1"));
  const valuesResponse = await googleFetch(env, userId, `${SHEETS_API}/${encodeURIComponent(id)}/values/${range}`);
  const values = await valuesResponse.json();
  const firstRow = Array.isArray(values.values?.[0]) ? values.values[0].map((value) => String(value)) : [];
  const headers = firstRow.map((label, index) => ({ column: columnName(index), label: label || `${columnName(index)}列` }));
  return { spreadsheetId: id, spreadsheetName: metadata.properties?.title || "Spreadsheet", sheetName: selectedSheet, sheets: sheetTitles, headers };
}

async function handleSheetInspect(request, env) {
  assertSameOrigin(request);
  const user = await requireAuthorizedUser(request, env);
  const body = await readJson(request);
  return json({ ok: true, ...(await inspectSheet(env, user.id, body.spreadsheetId, String(body.sheetName || ""))) });
}

async function handleSheetHeaders(request, env) {
  assertSameOrigin(request);
  const user = await requireAuthorizedUser(request, env);
  const body = await readJson(request);
  const id = spreadsheetId(body.spreadsheetId);
  const targetSheet = String(body.sheetName || "").trim();
  const fieldNames = Array.isArray(body.fieldNames)
    ? body.fieldNames.slice(0, 50).map((name, index) => String(name || `項目${index + 1}`).trim().slice(0, 300))
    : [];
  if (!targetSheet) throw new HttpError(400, "Sheetを選択してください。", "sheet_required");
  if (!fieldNames.length) throw new HttpError(400, "取得項目を1つ以上追加してください。", "fields_required");
  const headings = ["転記日時", "転記ルール", ...fieldNames];
  const endColumn = columnName(headings.length - 1);
  const range = encodeURIComponent(sheetRange(targetSheet, `A1:${endColumn}1`));
  await googleFetch(env, user.id, `${SHEETS_API}/${encodeURIComponent(id)}/values/${range}?valueInputOption=RAW`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ values: [headings] }),
  });
  return json({ ok: true, ...(await inspectSheet(env, user.id, id, targetSheet)) });
}

async function appendSheetRow(env, userId, inputId, sheetName, values) {
  const id = spreadsheetId(inputId);
  if (!sheetName) throw new HttpError(400, "Sheetを選択してください。", "sheet_required");
  if (!Array.isArray(values) || values.length === 0) throw new HttpError(400, "書き込む値がありません。", "values_required");
  const range = encodeURIComponent(sheetRange(sheetName, "A:ZZ"));
  const response = await googleFetch(
    env,
    userId,
    `${SHEETS_API}/${encodeURIComponent(id)}/values/${range}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ values: [values.map((value) => String(value ?? ""))] }),
    },
  );
  // A successful append must stay successful even if Google returns an empty
  // or otherwise unreadable response body. Retrying here could duplicate it.
  try {
    return await response.json();
  } catch {
    return {};
  }
}

function sheetTimestamp(date = new Date()) {
  const parts = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const part = (type) => parts.find((item) => item.type === type)?.value || "";
  return `${part("year")}/${part("month")}/${part("day")} ${part("hour")}:${part("minute")}:${part("second")}`;
}

async function addHistory(db, values) {
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO processing_history
       (user_id, rule_id, received_at, subject, extracted_count, destination, status, error_message, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      values.userId,
      values.ruleId || null,
      values.receivedAt || now,
      values.subject || "テスト書き込み",
      values.extractedCount || 0,
      values.destination || "",
      values.status,
      values.errorMessage || "",
      now,
    )
    .run();
}

async function addHistorySafely(db, values) {
  try {
    await addHistory(db, values);
  } catch (error) {
    // Processing history is diagnostic. It must never turn an already-sent
    // Sheets row into a retryable failure.
    console.error("Processing history write failed", error);
  }
}

function normalizeGmailMessageId(value, required = false) {
  const messageId = String(value || "").trim();
  if (!messageId && !required) return "";
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(messageId)) {
    throw new HttpError(400, "Gmailメッセージを確認できません。メールを選び直してください。", "invalid_gmail_message_id");
  }
  return messageId;
}

function sheetTestRequestKey(value) {
  const requestId = String(value || "").trim();
  if (!/^[A-Za-z0-9_-]{16,100}$/.test(requestId)) {
    throw new HttpError(400, "テスト書き込み操作を確認できません。画面を再読み込みしてください。", "invalid_idempotency_key");
  }
  return `sheet-test:v1:${requestId}`;
}

async function sheetDeliveryKey(gmailMessageId, inputId, sheetName) {
  const messageId = normalizeGmailMessageId(gmailMessageId, true);
  const id = spreadsheetId(inputId);
  const targetSheet = String(sheetName || "");
  if (!targetSheet.trim()) throw new HttpError(400, "Sheetを選択してください。", "sheet_required");
  const digest = bytesToBase64Url(await sha256(JSON.stringify([messageId, id, targetSheet])));
  return `sheet-delivery:v1:${digest}`;
}

async function reserveProcessedMessage(db, userId, ruleId, messageKey) {
  const result = await db
    .prepare(
      `INSERT INTO processed_messages (user_id, rule_id, gmail_message_id, processed_at)
       VALUES (?, ?, ?, ?) ON CONFLICT(user_id, rule_id, gmail_message_id) DO NOTHING`,
    )
    .bind(userId, ruleId, messageKey, new Date().toISOString())
    .run();
  return Number(result.meta?.changes || 0) > 0;
}

async function releaseProcessedMessage(db, userId, ruleId, messageKey) {
  await db
    .prepare("DELETE FROM processed_messages WHERE user_id = ? AND rule_id = ? AND gmail_message_id = ?")
    .bind(userId, ruleId, messageKey)
    .run();
}

function sheetAppendWasDefinitelyRejected(error) {
  if (!(error instanceof HttpError)) return false;
  if ([
    "oauth_not_configured",
    "google_not_connected",
    "google_reconnect_required",
    "invalid_spreadsheet_id",
    "sheet_required",
    "values_required",
  ].includes(error.code)) return true;
  const googleStatus = Number(error.details?.googleStatus || 0);
  return error.code === "google_api_error" && googleStatus >= 400 && googleStatus < 500;
}

async function handleSheetTest(request, env) {
  assertSameOrigin(request);
  const user = await requireAuthorizedUser(request, env);
  const body = await readJson(request);
  const suppliedValues = Array.isArray(body.values) ? body.values.slice(0, 99) : [];
  const targetSpreadsheetId = spreadsheetId(body.spreadsheetId);
  const targetSheet = String(body.sheetName || "");
  if (!targetSheet.trim()) throw new HttpError(400, "Sheetを選択してください。", "sheet_required");
  const gmailMessageId = normalizeGmailMessageId(body.gmailMessageId);
  const requestKey = sheetTestRequestKey(body.idempotencyKey);
  const receiptKey = gmailMessageId
    ? await sheetDeliveryKey(gmailMessageId, targetSpreadsheetId, targetSheet)
    : requestKey;
  // Resolve connection/refresh-token errors before claiming the at-most-once
  // receipt. Only an explicit Google rejection releases it after dispatch.
  await validAccessToken(env, user.id);
  const db = requireDb(env);
  const reserved = await reserveProcessedMessage(db, user.id, SHEET_DELIVERY_RECEIPT_RULE_ID, receiptKey);
  if (!reserved) {
    return json({
      ok: true,
      skipped: true,
      duplicateReason: gmailMessageId ? "gmail_message_already_accepted" : "request_already_accepted",
      updatedRange: "",
      updatedRows: 0,
    });
  }
  const values = [sheetTimestamp(), String(body.ruleName || "テスト書き込み").slice(0, 120), ...suppliedValues];
  let result;
  try {
    result = await appendSheetRow(env, user.id, targetSpreadsheetId, targetSheet, values);
  } catch (error) {
    if (sheetAppendWasDefinitelyRejected(error)) {
      await releaseProcessedMessage(db, user.id, SHEET_DELIVERY_RECEIPT_RULE_ID, receiptKey);
      await addHistorySafely(db, {
        userId: user.id,
        ruleId: Number(body.ruleId) || null,
        subject: String(body.subject || "テスト書き込み").slice(0, 300),
        extractedCount: suppliedValues.filter((value) => String(value ?? "").length > 0).length,
        destination: String(body.destination || targetSheet || "Google Sheets").slice(0, 300),
        status: "failed",
        errorMessage: `Google Sheetsが書き込みを受け付けませんでした：${error.message}`,
      });
      throw error;
    }
    await addHistorySafely(db, {
      userId: user.id,
      ruleId: Number(body.ruleId) || null,
      subject: String(body.subject || "テスト書き込み").slice(0, 300),
      extractedCount: suppliedValues.filter((value) => String(value ?? "").length > 0).length,
      destination: String(body.destination || targetSheet || "Google Sheets").slice(0, 300),
      status: "review",
      errorMessage: "Google Sheetsへの送信結果を確認できませんでした。二重転記を防ぐため自動再送していません。シートを確認してください。",
    });
    throw new HttpError(
      502,
      "書き込み結果を確認できませんでした。二重転記を防ぐため再送していません。Google Sheetsを確認してください。",
      "sheet_write_uncertain",
    );
  }
  await addHistorySafely(db, {
    userId: user.id,
    ruleId: Number(body.ruleId) || null,
    subject: String(body.subject || "テスト書き込み").slice(0, 300),
    extractedCount: suppliedValues.filter((value) => String(value ?? "").length > 0).length,
    destination: String(body.destination || body.sheetName || "Google Sheets").slice(0, 300),
    status: "success",
  });
  return json({ ok: true, skipped: false, updatedRange: result.updates?.updatedRange || "", updatedRows: result.updates?.updatedRows || 1 });
}

function normalizeSafeExtractionLocator(locator) {
  if (!safeLocatorIsValid(locator)) return null;
  if (locator.kind === "json") {
    return { version: 2, kind: "json", path: [...locator.path], jsonType: locator.jsonType };
  }
  const signature = {
    sampleBracketCount: locator.sampleBracketCount,
    samplePlainLabelCount: locator.samplePlainLabelCount,
    sampleBracketLabels: [...locator.sampleBracketLabels],
    samplePlainLabels: [...locator.samplePlainLabels],
    sampleDelimiterShape: [...locator.sampleDelimiterShape],
    sampleValueType: locator.sampleValueType,
  };
  if (locator.kind === "label") {
    return {
      version: 2,
      kind: "label",
      label: locator.label,
      ...(locator.innerLabel !== undefined ? { innerLabel: locator.innerLabel } : {}),
      ...(locator.nextLabel !== undefined ? { nextLabel: locator.nextLabel } : {}),
      ...(locator.suffix !== undefined ? { suffix: locator.suffix } : {}),
      ...(locator.balancedEnd !== undefined ? { balancedEnd: locator.balancedEnd } : {}),
      ...(locator.bracketed !== undefined ? { bracketed: locator.bracketed } : {}),
      ...(locator.inline !== undefined ? { inline: locator.inline } : {}),
      ...(locator.includeLabel !== undefined ? { includeLabel: locator.includeLabel } : {}),
      ...(locator.nextLabelBracketed !== undefined ? { nextLabelBracketed: locator.nextLabelBracketed } : {}),
      ...(locator.lineEnd !== undefined ? { lineEnd: locator.lineEnd } : {}),
      sampleContextLabels: [...locator.sampleContextLabels],
      ...signature,
    };
  }
  if (locator.kind === "block") {
    return {
      version: 2,
      kind: "block",
      heading: locator.heading,
      endHeading: locator.endHeading,
      ...signature,
    };
  }
  if (locator.kind === "qa") {
    return {
      version: 2,
      kind: "qa",
      question: locator.question,
      qaBracketed: locator.qaBracketed,
      ...signature,
    };
  }
  return null;
}

function normalizeField(field, index, allowLegacyRegex = false) {
  const method = METHODS.has(field?.method) ? field.method : "after";
  const sourceField = method === "source" && SOURCE_FIELDS.has(field?.sourceField) ? field.sourceField : "";
  if (method === "source" && !sourceField) {
    throw new HttpError(400, "取得するメール情報を選択してください。", "invalid_source_field");
  }
  if (method === "between" && !allowLegacyRegex) {
    throw new HttpError(400, "旧形式の範囲指定です。本文から取得したい値を選び直してください。", "unsafe_extraction_pattern");
  }
  const locatorWasProvided = field?.locator !== undefined && field?.locator !== null;
  const locator = method === "regex" ? normalizeSafeExtractionLocator(field?.locator) : null;
  if (method === "regex" && !locator && !(allowLegacyRegex && !locatorWasProvided)) {
    throw new HttpError(400, "自動取得条件を安全に確認できません。本文から値を選び直してください。", "unsafe_extraction_pattern");
  }
  let aliases = [];
  if (field?.aliases !== undefined) {
    if (!Array.isArray(field.aliases) || field.aliases.length > 10
      || field.aliases.some((value) => typeof value !== "string" || !value.trim() || value.trim().length > 100 || /[\r\n]/.test(value))) {
      throw new HttpError(400, "同じ意味の見出しを安全に確認できません。入力内容を確認してください。", "invalid_extraction_aliases");
    }
    aliases = field.aliases.map((value) => value.trim());
  }
  return {
    id: Number(field?.id) || index + 1,
    name: String(field?.name || `項目${index + 1}`).slice(0, 100),
    method,
    start: String(field?.start || "").slice(0, 500),
    end: String(field?.end || "").slice(0, 500),
    pattern: "",
    ...(locator ? { locator } : {}),
    anchorConfirmed: Boolean(field?.anchorConfirmed),
    aliases,
    ...(sourceField ? { sourceField } : {}),
  };
}

function sourceFieldIsValid(field) {
  return field?.method === "source" && SOURCE_FIELDS.has(field?.sourceField);
}

function extractMessageFieldResult(message, field, allFields) {
  if (field.method !== "source") return extractValueResult(message.body, field, allFields);
  if (!sourceFieldIsValid(field)) return { value: "", status: "invalid", reason: "取得するメール情報が未設定です。" };
  const rawValue = field.sourceField === "body" ? message.body : message[field.sourceField];
  const value = String(rawValue || "").trim();
  if (!value) return { value: "", status: "missing", reason: "指定したメール情報がありません。" };
  if (value.length > 50000) return { value: "", status: "invalid", reason: "本文が長すぎるため、1セルへそのまま出力できません。" };
  return { value, status: "ok", reason: "" };
}

function normalizeRuleBody(body) {
  const active = Boolean(body.active);
  const fields = Array.isArray(body.fields)
    ? body.fields.slice(0, 50).map((field, index) => normalizeField(field, index, body.active === false))
    : [];
  if (!fields.length) throw new HttpError(400, "抽出項目を1つ以上追加してください。", "fields_required");
  return {
    id: Number(body.id) || null,
    name: String(body.name || "新しい抽出ルール").trim().slice(0, 120),
    sender: String(body.sender || "").trim().slice(0, 320),
    subjectContains: String(body.subjectContains || "").trim().slice(0, 500),
    fields,
    spreadsheetId: body.spreadsheetId ? spreadsheetId(body.spreadsheetId) : "",
    spreadsheetName: String(body.spreadsheetName || "").slice(0, 300),
    sheetName: String(body.sheetName || "").slice(0, 300),
    sheetHeaders: Array.isArray(body.sheetHeaders)
      ? body.sheetHeaders.slice(0, 200).map((header) => ({
          column: String(header?.column || "").slice(0, 5),
          label: String(header?.label || "").slice(0, 300),
        }))
      : [],
    mappings: body.mappings && typeof body.mappings === "object" ? body.mappings : {},
    active,
  };
}

function parseRuleRow(row) {
  const storedFields = JSON.parse(row.fields_json || "[]");
  return {
    id: row.id,
    name: row.name,
    sender: row.sender,
    subjectContains: row.subject_contains,
    // A free-form start/end range cannot prove which repeated end marker is
    // the real boundary. Return it as an unsafe automatic rule so the editor
    // leads the user back to selecting the exact value in a sample mail.
    fields: Array.isArray(storedFields) ? storedFields.map((field) => (
      field?.method === "between"
        ? { ...field, method: "regex", pattern: "", locator: undefined, anchorConfirmed: false }
        : field
    )) : [],
    spreadsheetId: row.spreadsheet_id,
    spreadsheetName: row.spreadsheet_name,
    sheetName: row.sheet_name,
    sheetHeaders: JSON.parse(row.sheet_headers_json || "[]"),
    mappings: JSON.parse(row.mappings_json || "{}"),
    active: Boolean(row.active),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastStatus: row.last_status || "",
    lastError: row.last_error || "",
    lastProcessedAt: row.last_processed_at || "",
  };
}

async function handleRulesList(request, env) {
  const user = await requireAuthorizedUser(request, env);
  const result = await requireDb(env)
    .prepare(
      `SELECT er.id, er.name, er.sender, er.subject_contains, er.fields_json, er.spreadsheet_id, er.spreadsheet_name,
              er.sheet_name, er.sheet_headers_json, er.mappings_json, er.active, er.created_at, er.updated_at,
              ph.status AS last_status, ph.error_message AS last_error, ph.created_at AS last_processed_at
       FROM extraction_rules er
       LEFT JOIN processing_history ph ON ph.id = (
         SELECT latest.id FROM processing_history latest
         WHERE latest.user_id = er.user_id AND latest.rule_id = er.id
         ORDER BY latest.created_at DESC LIMIT 1
       )
       WHERE er.user_id = ? ORDER BY er.updated_at DESC LIMIT 100`,
    )
    .bind(user.id)
    .all();
  return json({ ok: true, rules: (result.results || []).map(parseRuleRow) });
}

async function handleRuleSave(request, env) {
  assertSameOrigin(request);
  const user = await requireAuthorizedUser(request, env);
  const body = normalizeRuleBody(await readJson(request));
  const db = requireDb(env);
  let gmailWatch = null;
  if (body.active) {
    const unsafeField = body.fields.find((field) => field.method === "source" ? !sourceFieldIsValid(field) : field.method !== "regex" || !safeLocatorIsValid(field.locator));
    if (unsafeField) {
      throw new HttpError(400, `「${unsafeField.name}」は旧形式の取得条件です。本文から取得したい値を選び直してください。`, "unsafe_extraction_pattern");
    }
    if (!gmailPushConfigured(env)) {
      throw new HttpError(503, "Gmail受信通知が未設定のため、新着メールの自動転記をONにできません。管理画面でPub/Sub設定を確認してください。", "gmail_push_not_configured");
    }
    try {
      gmailWatch = await registerGmailWatch(env, user.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : "不明なエラー";
      await addHistory(db, {
        userId: user.id,
        ruleId: body.id,
        subject: `受信監視：${body.name}`,
        destination: "Gmail",
        status: "failed",
        errorMessage: `Gmail受信監視を開始できませんでした：${message}`,
      });
      throw new HttpError(502, `ルールは保存されていません。Gmail受信監視を開始できませんでした：${message}`, "gmail_watch_failed");
    }
  }
  if (body.active && (!body.spreadsheetId || !body.sheetName)) {
    throw new HttpError(400, "新着メールの自動転記をONにするには、SpreadsheetとSheetを設定してください。", "sheet_not_configured");
  }
  const outputHeaders = body.sheetHeaders.slice(2);
  const hasMissingMapping = body.fields.some((field) => {
    const mappedHeader = String(body.mappings[String(field.id)] || "").trim();
    return !resolveMappedSheetColumn(outputHeaders, mappedHeader);
  });
  if (body.active && (!body.sheetHeaders.length || hasMissingMapping)) {
    throw new HttpError(400, "新着メールの自動転記をONにするには、1行目の見出しを取得し、すべての取得項目に出力列を割り当ててください。", "mapping_incomplete");
  }
  const now = new Date().toISOString();
  const fieldsJson = JSON.stringify(body.fields);
  const mappingsJson = JSON.stringify(body.mappings);
  let id = body.id;
  if (!id) {
    const savedCount = await db.prepare("SELECT COUNT(*) AS count FROM extraction_rules WHERE user_id = ?").bind(user.id).first();
    if (Number(savedCount?.count || 0) >= 10) {
      throw new HttpError(409, "転記ルールは10件まで登録できます。不要なルールを削除してから追加してください。", "rule_limit_reached");
    }
  }
  if (body.active) {
    const activeCount = id
      ? await db.prepare("SELECT COUNT(*) AS count FROM extraction_rules WHERE user_id = ? AND active = 1 AND id <> ?").bind(user.id, id).first()
      : await db.prepare("SELECT COUNT(*) AS count FROM extraction_rules WHERE user_id = ? AND active = 1").bind(user.id).first();
    if (Number(activeCount?.count || 0) >= 3) {
      throw new HttpError(409, "新着メールの自動転記をONにできるルールは3件までです。いずれかを停止してからONにしてください。", "active_rule_limit_reached");
    }
  }
  if (id) {
    const existing = await db.prepare("SELECT id FROM extraction_rules WHERE id = ? AND user_id = ?").bind(id, user.id).first();
    if (!existing) throw new HttpError(404, "保存対象のルールが見つかりません。", "rule_not_found");
    const result = await db
      .prepare(
        `UPDATE extraction_rules SET
           name = ?, sender = ?, subject_contains = ?, fields_json = ?, spreadsheet_id = ?,
           spreadsheet_name = ?, sheet_name = ?, sheet_headers_json = ?, mappings_json = ?, active = ?, updated_at = ?
         WHERE id = ? AND user_id = ?
           AND NOT EXISTS (
             SELECT 1 FROM extraction_rules AS duplicate
             WHERE duplicate.user_id = ? AND duplicate.id <> ? AND duplicate.sender = ?
               AND duplicate.subject_contains = ? AND duplicate.fields_json = ?
               AND duplicate.spreadsheet_id = ? AND duplicate.sheet_name = ? AND duplicate.mappings_json = ?
           )`,
      )
      .bind(
        body.name,
        body.sender,
        body.subjectContains,
        fieldsJson,
        body.spreadsheetId,
        body.spreadsheetName,
        body.sheetName,
        JSON.stringify(body.sheetHeaders),
        mappingsJson,
        body.active ? 1 : 0,
        now,
        id,
        user.id,
        user.id,
        id,
        body.sender,
        body.subjectContains,
        fieldsJson,
        body.spreadsheetId,
        body.sheetName,
        mappingsJson,
      )
      .run();
    if (!Number(result.meta?.changes || 0)) {
      throw new HttpError(409, "同じ条件・抽出項目・出力先のルールが既にあります。保存済みルールを開いて編集してください。", "duplicate_rule");
    }
  } else {
    const result = await db
      .prepare(
        `INSERT INTO extraction_rules
         (user_id, name, sender, subject_contains, fields_json, spreadsheet_id, spreadsheet_name,
          sheet_name, sheet_headers_json, mappings_json, active, created_at, updated_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
         WHERE NOT EXISTS (
           SELECT 1 FROM extraction_rules
           WHERE user_id = ? AND sender = ? AND subject_contains = ? AND fields_json = ?
             AND spreadsheet_id = ? AND sheet_name = ? AND mappings_json = ?
         )`,
      )
      .bind(
        user.id,
        body.name,
        body.sender,
        body.subjectContains,
        fieldsJson,
        body.spreadsheetId,
        body.spreadsheetName,
        body.sheetName,
        JSON.stringify(body.sheetHeaders),
        mappingsJson,
        body.active ? 1 : 0,
        now,
        now,
        user.id,
        body.sender,
        body.subjectContains,
        fieldsJson,
        body.spreadsheetId,
        body.sheetName,
        mappingsJson,
      )
      .run();
    if (!Number(result.meta?.changes || 0)) {
      throw new HttpError(409, "同じ条件・抽出項目・出力先のルールが既にあります。保存済みルールを開いて編集してください。", "duplicate_rule");
    }
    id = result.meta?.last_row_id;
  }
  const saved = await db
    .prepare(
      `SELECT id, name, sender, subject_contains, fields_json, spreadsheet_id, spreadsheet_name,
              sheet_name, sheet_headers_json, mappings_json, active, created_at, updated_at
       FROM extraction_rules WHERE id = ? AND user_id = ?`,
    )
    .bind(id, user.id)
    .first();
  if (gmailWatch) {
    await addHistory(db, {
      userId: user.id,
      ruleId: id,
      subject: `受信監視：${body.name}`,
      destination: "Gmail",
      status: "received",
      errorMessage: "Gmailの受信監視を開始しました。Cloudflareへの新着通知を待っています。",
    });
  }
  return json({ ok: true, rule: parseRuleRow(saved), gmailWatchExpiresAt: Number(gmailWatch?.expiration || 0) || null });
}

async function handleRuleDelete(request, env, ruleId) {
  assertSameOrigin(request);
  const user = await requireAuthorizedUser(request, env);
  const db = requireDb(env);
  const existing = await db.prepare("SELECT id FROM extraction_rules WHERE id = ? AND user_id = ?").bind(ruleId, user.id).first();
  if (!existing) throw new HttpError(404, "削除するルールが見つかりません。", "rule_not_found");
  await db.prepare("DELETE FROM processed_messages WHERE user_id = ? AND rule_id = ?").bind(user.id, ruleId).run();
  await db.prepare("UPDATE processing_history SET rule_id = NULL WHERE user_id = ? AND rule_id = ?").bind(user.id, ruleId).run();
  await db.prepare("DELETE FROM extraction_rules WHERE id = ? AND user_id = ?").bind(ruleId, user.id).run();
  return json({ ok: true });
}

const cleanAnchorLabel = (value) => value.normalize("NFKC").trim().replace(/^[\s*#・■□◇◆【\u005b「『]+/, "").replace(/\s*(?:：|:|＞|＝＞|=>|->|=|＝)\s*$/, "").replace(/[】\]」』\s*]+$/, "").replace(/[\s\u3000]+/g, "").trim();
const semanticLabel = (value) => cleanAnchorLabel(value).toLowerCase();
const safeAliases = (rule) => Array.isArray(rule.aliases) ? rule.aliases.filter((value) => typeof value === "string" && Boolean(value.trim()) && value.trim().length <= 100 && !/[\r\n]/.test(value)).map((value) => value.trim()).slice(0, 10) : [];
const extractionAliasesAreValid = (rule) => rule.aliases === void 0 || Array.isArray(rule.aliases) && rule.aliases.length <= 10 && rule.aliases.every((value) => typeof value === "string" && Boolean(value.trim()) && value.trim().length <= 100 && !/[\r\n]/.test(value));
function extractionAnchorMatchesName(rule) {
  if (rule.method === "regex") return true;
  const name = semanticLabel(rule.name);
  if (!name) return false;
  return [rule.start, ...safeAliases(rule)].some((value) => {
    const rawMarker = String(value || "").trim();
    const pairedOpeners = { "\u3010": "\u3011", "[": "]", "\uFF08": "\uFF09", "(": ")", "\u300C": "\u300D", "\u300E": "\u300F" };
    const trailingOpener = rule.method === "between" ? rawMarker.at(-1) || "" : "";
    const markerSource = trailingOpener && pairedOpeners[trailingOpener] === String(rule.end || "").trim() ? rawMarker.slice(0, -1) : rawMarker;
    const marker = semanticLabel(markerSource);
    if (!marker) return false;
    return marker === name;
  });
}
function extractionAnchorIsAccepted(rule) {
  return rule.method === "regex" || rule.anchorConfirmed === true || extractionAnchorMatchesName(rule);
}
function standardQuoteDepth(body, index) {
  const lineStart = body.lastIndexOf("\n", Math.max(0, index - 1)) + 1;
  const prefix = body.slice(lineStart, index);
  if (!/^[ \t]*(?:>[ \t]*)+$/.test(prefix)) return 0;
  return Array.from(prefix).filter((character) => character === ">").length;
}
function exactMatches(body, marker) {
  const matches = [];
  let from = 0;
  while (marker && from <= body.length) {
    const index = body.indexOf(marker, from);
    if (index < 0) break;
    matches.push({ index, end: index + marker.length });
    from = index + Math.max(1, marker.length);
  }
  return matches;
}
function hasLabelBoundary(body, index) {
  if (index === 0) return true;
  const previous = body[index - 1] || "";
  return /[\n\r｜|\t\u3000■□◇◆#*・]/u.test(previous) || previous === " " && body[index - 2] === " " || standardQuoteDepth(body, index) > 0;
}
function hasStructuredMarker(marker) {
  return /^[【\u005b]/.test(marker.trim()) || /(?:：|:|＞|＝＞|=>|->|=|＝)/.test(marker);
}
const LABEL_SEPARATOR_PATTERN = /＝＞|=>|->|：|:|＞|=|＝/gmu;
const LABEL_SEPARATORS = ["\uFF1D\uFF1E", "=>", "->", "\uFF1A", ":", "\uFF1E", "=", "\uFF1D"];
function markerLookup(markers) {
  const lookup = /* @__PURE__ */ new Map();
  for (const marker of markers) {
    const semantic = semanticLabel(marker);
    if (semantic && !lookup.has(semantic)) lookup.set(semantic, marker);
  }
  return lookup;
}
function reverseLabelTrie(markers) {
  const root = { next: /* @__PURE__ */ new Map() };
  for (const [semantic, label] of markerLookup(markers)) {
    let node = root;
    for (const character of Array.from(semantic).reverse()) {
      const child = node.next.get(character) || { next: /* @__PURE__ */ new Map() };
      node.next.set(character, child);
      node = child;
    }
    node.label = label;
  }
  return root;
}
function formattedLabelsMatch(body, markers) {
  const matches = bracketLabelsMatchAnywhere(body, markers).filter((match) => hasLabelBoundary(body, match.index));
  matches.push(...plainStructuralLabelsMatch(body, markers, 0, body.length, "formatted"));
  return uniqueLabelMatches(matches);
}
function formattedLabelMatches(body, marker) {
  return formattedLabelsMatch(body, [marker]);
}
function bracketLabelsMatchAnywhere(body, markers) {
  const lookup = markerLookup(markers);
  if (!lookup.size) return [];
  const matches = [];
  for (let index = 0; index < body.length; index += 1) {
    const opener = body[index];
    const closer = opener === "\u3010" ? "\u3011" : opener === "[" ? "]" : "";
    if (!closer) continue;
    const limit = Math.min(body.length, index + 122);
    let close = index + 1;
    while (close < limit && body[close] !== closer && !/[\r\n【[]/.test(body[close] || "")) close += 1;
    if (close >= limit || body[close] !== closer || close === index + 1) continue;
    const label = lookup.get(semanticLabel(body.slice(index + 1, close)));
    if (!label) {
      index = close;
      continue;
    }
    let end = close + 1;
    while (/[ \t\u3000]/.test(body[end] || "")) end += 1;
    const separator = LABEL_SEPARATORS.find((part) => body.startsWith(part, end));
    if (separator) {
      end += separator.length;
      while (/[ \t\u3000]/.test(body[end] || "")) end += 1;
    }
    matches.push({ index, end, label });
    index = close;
  }
  return matches;
}
function bracketLabelMatchesAnywhere(body, marker) {
  return bracketLabelsMatchAnywhere(body, [marker]);
}
function labelStartBeforeSeparator(body, trie, from, separatorIndex, mode) {
  let node = trie;
  let index = separatorIndex - 1;
  while (index >= from && /[ \t\u3000]/.test(body[index] || "")) index -= 1;
  let trailingStars = 0;
  while (index >= from && body[index] === "*" && trailingStars < 2) {
    trailingStars += 1;
    index -= 1;
  }
  let significant = 0;
  while (index >= from && significant < 100) {
    const character = body[index];
    if (/[ \t\u3000]/.test(character || "")) {
      index -= 1;
      continue;
    }
    const normalized = character.normalize("NFKC").toLowerCase();
    if (normalized.length !== 1) return null;
    const child = node.next.get(normalized);
    if (!child) return null;
    node = child;
    significant += 1;
    index -= 1;
    if (node.label) {
      let start = index + 1;
      let prefix = index;
      let leadingStars = 0;
      while (prefix >= from && body[prefix] === "*" && leadingStars < 2) {
        leadingStars += 1;
        start = prefix;
        prefix -= 1;
      }
      if (start === from) return { start, label: node.label };
      const previous = body[start - 1] || "";
      const inlineBoundary = /[\n\r \t\u3000｜|／/;；,，、■□◇◆#*・]/u.test(previous);
      const formattedBoundary = /[\n\r｜|\t\u3000■□◇◆#*・]/u.test(previous) || previous === " " && body[start - 2] === " " || standardQuoteDepth(body, start) > 0;
      if (mode === "inline" ? inlineBoundary : formattedBoundary) return { start, label: node.label };
    }
  }
  return null;
}
function uniqueLabelMatches(matches) {
  const unique = /* @__PURE__ */ new Map();
  for (const match of matches) {
    const current = unique.get(match.index);
    if (!current || match.end > current.end) unique.set(match.index, match);
  }
  return [...unique.values()].sort((left, right) => left.index - right.index);
}
function plainStructuralLabelsMatch(body, markers, from, to, mode) {
  const trie = reverseLabelTrie(markers);
  if (!trie.next.size || from >= to) return [];
  const matches = [];
  const scope = body.slice(from, to);
  LABEL_SEPARATOR_PATTERN.lastIndex = 0;
  for (const separator of scope.matchAll(LABEL_SEPARATOR_PATTERN)) {
    const separatorIndex = from + (separator.index ?? 0);
    const matched = labelStartBeforeSeparator(body, trie, from, separatorIndex, mode);
    if (!matched) continue;
    let end = separatorIndex + separator[0].length;
    while (end < to && /[ \t\u3000]/.test(body[end] || "")) end += 1;
    matches.push({ index: matched.start, end, label: matched.label });
  }
  return uniqueLabelMatches(matches);
}
function plainStructuralMatches(body, marker, from, to, mode) {
  return plainStructuralLabelsMatch(body, [marker], from, to, mode);
}
function plainLabelMatchesAfter(body, marker, from, to) {
  return plainStructuralMatches(body, marker, from, to, "inline");
}
function findRuleAnchors(body, rule) {
  const markers = [rule.start, ...safeAliases(rule)].map((value) => String(value || "").trim()).filter(Boolean);
  const formatted = formattedLabelsMatch(body, markers);
  const candidates = formatted.length ? formatted : markers.flatMap((marker) => hasStructuredMarker(marker) ? exactMatches(body, marker).filter((match) => hasLabelBoundary(body, match.index)) : []);
  const unique = /* @__PURE__ */ new Map();
  for (const match of candidates) {
    const current = unique.get(match.index);
    if (!current || match.end > current.end) unique.set(match.index, match);
  }
  return [...unique.values()].sort((left, right) => left.index - right.index);
}
function fieldValueAfter(body, end, rule, allRules) {
  let valueStart = end;
  while (/[ \t]/.test(body[valueStart] || "")) valueStart += 1;
  while (body[valueStart] === "\n") {
    valueStart += 1;
    while (/[ \t]/.test(body[valueStart] || "")) valueStart += 1;
  }
  const lineEnd = body.indexOf("\n", valueStart) < 0 ? body.length : body.indexOf("\n", valueStart);
  let boundary = lineEnd;
  for (const token of ["\uFF5C", "|"]) {
    const index = body.indexOf(token, valueStart);
    if (index >= valueStart && index < lineEnd) boundary = Math.min(boundary, index);
  }
  const searchEnd = Math.min(lineEnd, valueStart + 501);
  const candidateWindow = body.slice(valueStart, searchEnd);
  for (const otherRule of allRules) {
    if (otherRule === rule || otherRule.id === rule.id || otherRule.method === "regex" || otherRule.method === "between") continue;
    const markers = [otherRule.start, ...safeAliases(otherRule)].map((marker) => String(marker || "").trim()).filter(Boolean);
    const configuredAnchors = [
      ...bracketLabelsMatchAnywhere(candidateWindow, markers),
      ...plainStructuralLabelsMatch(candidateWindow, markers, 0, candidateWindow.length, "inline")
    ].map((anchor) => ({ ...anchor, index: valueStart + anchor.index, end: valueStart + anchor.end }));
    for (const anchor of configuredAnchors) {
      if (anchor.index >= valueStart && anchor.index < boundary) {
        let adjusted = anchor.index;
        while (adjusted > valueStart && /[ \t\u3000]/.test(body[adjusted - 1])) adjusted -= 1;
        if (adjusted > valueStart && /[｜|／/;；,，、]/.test(body[adjusted - 1])) adjusted -= 1;
        boundary = adjusted;
      }
    }
  }
  return body.slice(valueStart, boundary).trim();
}
function candidateLengthIssue(value) {
  if (value.length > 500) return "\u53D6\u5F97\u7BC4\u56F2\u304C\u9577\u3059\u304E\u307E\u3059\u3002\u5024\u306E\u76F4\u524D\u306E\u898B\u51FA\u3057\u3068\u3001\u7D42\u308F\u308A\u306E\u4F4D\u7F6E\u3092\u78BA\u8A8D\u3057\u3066\u304F\u3060\u3055\u3044\u3002";
  return "";
}
function unboundedCandidateIssue(value) {
  const lengthIssue = candidateLengthIssue(value);
  if (lengthIssue) return lengthIssue;
  const structuralLabels = [...value.matchAll(/(?:【[^】\n]{1,80}】|\[[^\]\n]{1,80}\])/g)];
  if (structuralLabels.length) {
    return "\u6B21\u306E\u9805\u76EE\u3068\u306E\u5883\u754C\u3092\u5224\u5B9A\u3067\u304D\u307E\u305B\u3093\u3002\u672C\u6587\u304B\u3089\u5024\u3060\u3051\u3092\u9078\u3073\u76F4\u3059\u304B\u30012\u3064\u306E\u6587\u5B57\u3067\u7BC4\u56F2\u3092\u6307\u5B9A\u3057\u3066\u304F\u3060\u3055\u3044\u3002";
  }
  const possiblePlainLabel = /(?:^|[\n \t\u3000]+|[／/;；,，、])(?:[*#・■□◇◆]+\s*)?([\p{L}][\p{L}\p{N}_・\- \t\u3000]{0,30}?)\s*(?:：|:|＞|＝＞|=>|->)/gmu;
  for (const match of value.matchAll(possiblePlainLabel)) {
    const label = String(match[1] || "").replace(/[\s\u3000]+/g, "").toLowerCase();
    if (!/^(?:https?|mailto)$/.test(label)) {
      return "\u6B21\u306E\u9805\u76EE\u3068\u306E\u5883\u754C\u3092\u5224\u5B9A\u3067\u304D\u307E\u305B\u3093\u3002\u7D9A\u304F\u9805\u76EE\u3082\u8FFD\u52A0\u3059\u308B\u304B\u3001\u672C\u6587\u304B\u3089\u5024\u3060\u3051\u3092\u9078\u3073\u76F4\u3057\u3066\u304F\u3060\u3055\u3044\u3002";
    }
  }
  return "";
}
function boundedCandidateIssue(value) {
  const lengthIssue = candidateLengthIssue(value);
  if (lengthIssue) return lengthIssue;
  if (/(?:^|\n)[ \t\u3000]*(?:【[^】\n]{1,80}】|\[[^\]\n]{1,80}\]|[■◆]|#{1,6}[ \t]|━{4,}|-{5,})/.test(value)) {
    return "\u6307\u5B9A\u3057\u305F\u7BC4\u56F2\u306B\u5225\u306E\u9805\u76EE\u304C\u542B\u307E\u308C\u3066\u3044\u307E\u3059\u3002\u958B\u59CB\u6587\u5B57\u3068\u7D42\u308F\u308A\u306E\u6587\u5B57\u3092\u78BA\u8A8D\u3057\u3066\u304F\u3060\u3055\u3044\u3002";
  }
  return "";
}
const DELIMITER_PAIRS = {
  "(": { close: ")", token: "()" },
  "\uFF08": { close: "\uFF09", token: "\uFF08\uFF09" },
  "\u3010": { close: "\u3011", token: "\u3010\u3011" },
  "[": { close: "]", token: "[]" },
  "\u300C": { close: "\u300D", token: "\u300C\u300D" },
  "\u300E": { close: "\u300F", token: "\u300E\u300F" },
  "\u3008": { close: "\u3009", token: "\u3008\u3009" },
  "\u201C": { close: "\u201D", token: "\u201C\u201D" },
  "\u2018": { close: "\u2019", token: "\u2018\u2019" }
};
const DELIMITER_CLOSERS = new Map(Object.entries(DELIMITER_PAIRS).map(([open, pair]) => [pair.close, { open, token: pair.token }]));
const BALANCED_ENDS = new Set(Object.values(DELIMITER_PAIRS).map(({ token }) => token));
function delimiterShape(value) {
  const stack = [];
  const shape = [];
  for (const character of value) {
    const opener = DELIMITER_PAIRS[character];
    if (opener) {
      stack.push(opener);
      shape.push(opener.token);
      continue;
    }
    const closer = DELIMITER_CLOSERS.get(character);
    if (!closer) continue;
    const expected = stack.pop();
    if (!expected || expected.close !== character) return null;
    shape.push(`/${expected.token}`);
  }
  return stack.length ? null : shape;
}
function exactMoneyValue(value) {
  return /^(?:(?:¥|￥)\s?[+-]?\d[\d,]*(?:\.\d+)?|[+-]?\d[\d,]*(?:\.\d+)?\s*円)(?:\s*[（(][^()（）\r\n]{0,40}[）)])?$/.test(value.normalize("NFKC").trim());
}
function inferSampleValueType(value) {
  const candidate = value.normalize("NFKC").trim();
  if (typedValue(candidate, "email")) return "email";
  if (typedValue(candidate, "phone")) return "phone";
  if (typedValue(candidate, "date")) return "date";
  if (/[¥￥]|円/u.test(candidate) && exactMoneyValue(candidate)) return "money";
  if (typedValue(candidate, "number")) return "number";
  return "text";
}
function valueMatchesSampleType(value, type) {
  if (type === "text") return true;
  if (type === "money") return exactMoneyValue(value);
  return Boolean(typedValue(value, type));
}
function signatureFor(value) {
  const shape = delimiterShape(value);
  if (!shape) return null;
  return {
    sampleBracketCount: structuralBracketCount(value),
    samplePlainLabelCount: structuralPlainLabelCount(value),
    sampleBracketLabels: structuralBracketLabels(value),
    samplePlainLabels: structuralPlainLabels(value),
    sampleDelimiterShape: shape,
    sampleValueType: inferSampleValueType(value)
  };
}
function safeLocatorIsValid(locator) {
  if (!locator || typeof locator !== "object" || Array.isArray(locator) || locator.version !== 2) return false;
  const raw = locator;
  if (Object.prototype.hasOwnProperty.call(raw, "genericEnd")) return false;
  const textIsSafe = (value, required = false, maxLength = 500) => {
    if (value === void 0 || value === null) return !required;
    if (typeof value !== "string") return false;
    return (!required || Boolean(value.trim())) && value.length <= maxLength && !/[\r\n]/.test(value);
  };
  const booleanFlagsAreSafe = ["bracketed", "inline", "includeLabel", "nextLabelBracketed", "lineEnd", "qaBracketed"].every((key) => {
    const value = locator[key];
    return value === void 0 || typeof value === "boolean";
  });
  if (!booleanFlagsAreSafe) return false;
  const bracketCountIsSafe = Number.isInteger(locator.sampleBracketCount) && Number(locator.sampleBracketCount) >= 0 && Number(locator.sampleBracketCount) <= 50;
  const plainLabelCountIsSafe = Number.isInteger(locator.samplePlainLabelCount) && Number(locator.samplePlainLabelCount) >= 0 && Number(locator.samplePlainLabelCount) <= 50;
  const signatureIsSafe = (value) => Array.isArray(value) && value.length <= 50 && value.every((part) => textIsSafe(part, true, 100));
  const shapeIsSafe = Array.isArray(locator.sampleDelimiterShape) && locator.sampleDelimiterShape.length <= 100 && locator.sampleDelimiterShape.every((part) => typeof part === "string" && /^(?:\/?(?:\(\)|（）|【】|\[\]|「」|『』|〈〉|“”|‘’))$/.test(part));
  const valueTypeIsSafe = ["text", "number", "money", "date", "email", "phone"].includes(String(locator.sampleValueType || ""));
  const contextLabelsAreSafe = Array.isArray(locator.sampleContextLabels) && locator.sampleContextLabels.length >= 1 && locator.sampleContextLabels.length <= 4 && locator.sampleContextLabels[0] === "@anchor" && locator.sampleContextLabels.slice(1).every((part) => typeof part === "string" && /^(?:b|p):[^\r\n]{1,100}$/.test(part));
  const textSuffixIsSafe = locator.sampleValueType !== "text" || !locator.suffix || Object.entries(DELIMITER_PAIRS).some(([open, { close }]) => locator.suffix.startsWith(open) && locator.suffix.endsWith(close) && Boolean(delimiterShape(locator.suffix)));
  const commonSignatureIsSafe = bracketCountIsSafe && plainLabelCountIsSafe && signatureIsSafe(locator.sampleBracketLabels) && signatureIsSafe(locator.samplePlainLabels) && locator.sampleBracketLabels.length === locator.sampleBracketCount && locator.samplePlainLabels.length === locator.samplePlainLabelCount && shapeIsSafe && valueTypeIsSafe;
  if (locator.kind === "label") {
    const boundaries = [locator.lineEnd === true, Boolean(locator.nextLabel), Boolean(locator.suffix), Boolean(locator.balancedEnd)].filter(Boolean).length;
    return textIsSafe(locator.label, true, 100) && textIsSafe(locator.innerLabel, false, 100) && textIsSafe(locator.nextLabel, false, 100) && textIsSafe(locator.suffix, false, 100) && commonSignatureIsSafe && contextLabelsAreSafe && textSuffixIsSafe && (locator.balancedEnd === void 0 || BALANCED_ENDS.has(locator.balancedEnd)) && (!locator.includeLabel || locator.bracketed === true) && !(locator.sampleValueType === "text" && locator.lineEnd === true) && boundaries === 1;
  }
  if (locator.kind === "block") return textIsSafe(locator.heading, true) && textIsSafe(locator.endHeading, true) && commonSignatureIsSafe;
  if (locator.kind === "json") return Array.isArray(locator.path) && locator.path.length > 0 && locator.path.length <= 20 && locator.path.every((part) => textIsSafe(part, true, 100) && !/^(?:0|[1-9]\d*)$/.test(part)) && ["string", "number", "boolean"].includes(String(locator.jsonType || ""));
  return locator.kind === "qa" && textIsSafe(locator.question, true) && typeof locator.qaBracketed === "boolean" && commonSignatureIsSafe;
}
function extractionLocatorIsSafe(locator) {
  return safeLocatorIsValid(locator);
}
function proseCandidateIssue(value) {
  const candidate = String(value || "").normalize("NFKC").trim();
  const proseSurface = candidate.replace(/“[^”\r\n]*”|‘[^’\r\n]*’|〈[^〉\r\n]*〉|「[^」\r\n]*」|『[^』\r\n]*』/gu, " ").trim();
  const instruction = /^(?:とは|には|について|の(?:意味|説明)|は(?:必須|任意|必要|不要|入力|記入|選択|確認|設定|保存|送信|表示|使用|利用)|が(?:必須|必要|不要)|を(?:指す|ご?(?:入力|記入|選択|確認|設定|保存|送信|参照|使用|利用))|欄(?:には|へ|に|を)|(?:へ|に)(?:ご?(?:入力|記入|選択|設定))|なら(?:省略|入力|記入|選択|不要|任意)|という(?:表記|意味|項目|名称|説明)|と(?:表示|記載)|や$|または$)/u;
  const explanatorySentence = /^は.+(?:です|ます|必要|任意)(?:[。.!！]|$)/u;
  const requestSentence = /(?:入力|記入|選択|設定|保存|送信|確認|参照)(?:を)?(?:して)?(?:ください|下さい)(?:[。.!！]|$)/u;
  const genericExplanation = /^(?:(?:応募者|申込者|注文者|予約者|利用者|顧客|お客様)の)?(?:氏名|名前|メール(?:アドレス)?|電話番号|住所)(?:です|となります|を表します)(?:[。.!！]|$)/u;
  const missingMarker = /^(?:未入力|未記入|未設定|不明|なし|無し|該当なし|N\/?A|[-ー―—])(?:[。.!！]|$)/iu;
  return instruction.test(proseSurface) || explanatorySentence.test(proseSurface) || requestSentence.test(proseSurface) || genericExplanation.test(proseSurface) || missingMarker.test(candidate) ? "\u8AAC\u660E\u6587\u4E2D\u306E\u898B\u51FA\u3057\u306B\u898B\u3048\u308B\u305F\u3081\u3001\u81EA\u52D5\u8EE2\u8A18\u3057\u307E\u305B\u3093\u3002" : "";
}
function skipHorizontalSpace(body, from) {
  let index = from;
  while (/[ \t\u3000]/.test(body[index] || "")) index += 1;
  return index;
}
function positionAfterInnerLabel(body, from, label) {
  let index = skipHorizontalSpace(body, from);
  const opener = body[index];
  const closer = opener === "\u3010" ? "\u3011" : opener === "[" ? "]" : "";
  if (!closer) return -1;
  const close = body.indexOf(closer, index + 1);
  if (close < 0 || semanticLabel(body.slice(index + 1, close)) !== semanticLabel(label)) return -1;
  index = skipHorizontalSpace(body, close + 1);
  for (const separator of ["\uFF1D\uFF1E", "=>", "->", "\uFF1A", ":", "\uFF1E", "=", "\uFF1D"]) {
    if (!body.startsWith(separator, index)) continue;
    index = skipHorizontalSpace(body, index + separator.length);
    break;
  }
  return index;
}
function structuralBracketCount(value) {
  return Array.from(value.matchAll(/【[^】\r\n]{1,80}】|\[[^\]\r\n]{1,80}\]/g)).length;
}
function structuralBracketLabels(value) {
  return Array.from(value.matchAll(/【([^】\r\n]{1,80})】|\[([^\]\r\n]{1,80})\]/g), (match) => semanticLabel(match[1] || match[2] || ""));
}
function structuralLabelTokens(value) {
  const bracketTokens = Array.from(value.matchAll(/【([^】\r\n]{1,80})】|\[([^\]\r\n]{1,80})\]/g), (match) => ({
    index: match.index ?? 0,
    end: (match.index ?? 0) + match[0].length,
    signature: `b:${semanticLabel(match[1] || match[2] || "")}`
  })).filter((token) => token.signature.length > 2 && token.signature.length <= 102);
  const possible = /(?:^|[\n \t\u3000]+|[｜|／/;；,，、])(?:[*#・■□◇◆]+[ \t\u3000]*)*([\p{L}][\p{L}\p{N}_・\- \t\u3000]{0,30}?)\s*(?:\*{1,2}\s*)?(?:：|:|＞|＝＞|=>|->|=|＝)/gmu;
  const plainTokens = [];
  for (const match of value.matchAll(possible)) {
    const label = String(match[1] || "").replace(/[\s\u3000]+/g, "").toLowerCase();
    if (!label || label.length > 100 || /^(?:https?|mailto)$/.test(label)) continue;
    const offset = match[0].lastIndexOf(String(match[1] || ""));
    const index = (match.index ?? 0) + Math.max(0, offset);
    const end = index + String(match[1] || "").length;
    if (bracketTokens.some((token) => index >= token.index && index < token.end)) continue;
    plainTokens.push({ index, end, signature: `p:${label}` });
  }
  return [...bracketTokens, ...plainTokens].sort((left, right) => left.index - right.index || right.end - left.end).filter((token, index, tokens) => index === 0 || token.index !== tokens[index - 1].index);
}
function structuralPlainLabels(value) {
  return structuralLabelTokens(value).filter((token) => token.signature.startsWith("p:")).map((token) => token.signature.slice(2));
}
function structuralPlainLabelCount(value) {
  return structuralPlainLabels(value).length;
}
function structuralContextLabels(body, anchorEnd) {
  const window = body.slice(anchorEnd, Math.min(body.length, anchorEnd + 2e3));
  return ["@anchor", ...structuralLabelTokens(window).slice(0, 3).map((token) => token.signature)];
}
function stripQuotedCandidate(value, quoteDepth) {
  const trimmed = value.trim();
  if (quoteDepth <= 0 || !trimmed.includes("\n")) return { value: trimmed, issue: "" };
  const lines = trimmed.split("\n");
  for (let lineIndex = 1; lineIndex < lines.length; lineIndex += 1) {
    let index = 0;
    while (/[ \t]/.test(lines[lineIndex][index] || "")) index += 1;
    for (let depth = 0; depth < quoteDepth; depth += 1) {
      if (lines[lineIndex][index] !== ">") return { value: "", issue: "引用行の形式が途中で変わったため、自動転記しません。" };
      index += 1;
      if (lines[lineIndex][index] === " ") index += 1;
    }
    lines[lineIndex] = lines[lineIndex].slice(index);
  }
  return { value: lines.join("\n").trim(), issue: "" };
}
function unbalancedDelimiterIssue(value) {
  return delimiterShape(value) ? "" : "\u5024\u306E\u62EC\u5F27\u304C\u5BFE\u5FDC\u3057\u3066\u3044\u306A\u3044\u305F\u3081\u3001\u81EA\u52D5\u8EE2\u8A18\u3057\u307E\u305B\u3093\u3002";
}
function structuredLeadingLine(line) {
  const value = String(line || "").trim();
  if (!value) return false;
  if (/^(?:━{4,}|-{5,}|[■◆]|#{1,6}(?:\s|$))/.test(value)) return true;
  if (/^(?:【[^】\r\n]{1,120}】|\[[^\]\r\n]{1,120}\])(?:\s*(?:：|:|＞|＝＞|=>|->|=|＝))?/.test(value)) return true;
  return /^(?:[-*・]\s*)?[^\r\n：:＞=]{1,120}?\s*(?:：|:|＞|＝＞|=>|->|=|＝)/u.test(value);
}
function extractedSignatureIssue(value, locator) {
  if (structuralBracketCount(value) !== locator.sampleBracketCount) {
    return "\u30B5\u30F3\u30D7\u30EB\u3068\u62EC\u5F27\u9805\u76EE\u306E\u69CB\u9020\u304C\u5909\u308F\u3063\u305F\u305F\u3081\u3001\u81EA\u52D5\u8EE2\u8A18\u3057\u307E\u305B\u3093\u3002";
  }
  if (structuralPlainLabelCount(value) !== locator.samplePlainLabelCount) {
    return "\u30B5\u30F3\u30D7\u30EB\u3068\u9805\u76EE\u306E\u533A\u5207\u308A\u69CB\u9020\u304C\u5909\u308F\u3063\u305F\u305F\u3081\u3001\u81EA\u52D5\u8EE2\u8A18\u3057\u307E\u305B\u3093\u3002";
  }
  if (JSON.stringify(structuralBracketLabels(value)) !== JSON.stringify(locator.sampleBracketLabels)) {
    return "\u30B5\u30F3\u30D7\u30EB\u3068\u62EC\u5F27\u5185\u306E\u898B\u51FA\u3057\u304C\u5909\u308F\u3063\u305F\u305F\u3081\u3001\u81EA\u52D5\u8EE2\u8A18\u3057\u307E\u305B\u3093\u3002";
  }
  if (JSON.stringify(structuralPlainLabels(value)) !== JSON.stringify(locator.samplePlainLabels)) {
    return "\u30B5\u30F3\u30D7\u30EB\u3068\u9805\u76EE\u540D\u306E\u69CB\u9020\u304C\u5909\u308F\u3063\u305F\u305F\u3081\u3001\u81EA\u52D5\u8EE2\u8A18\u3057\u307E\u305B\u3093\u3002";
  }
  const shape = delimiterShape(value);
  if (!shape) return "\u5024\u306E\u62EC\u5F27\u304C\u5BFE\u5FDC\u3057\u3066\u3044\u306A\u3044\u305F\u3081\u3001\u81EA\u52D5\u8EE2\u8A18\u3057\u307E\u305B\u3093\u3002";
  if (JSON.stringify(shape) !== JSON.stringify(locator.sampleDelimiterShape)) return "\u30B5\u30F3\u30D7\u30EB\u3068\u62EC\u5F27\u30FB\u5F15\u7528\u7B26\u306E\u69CB\u9020\u304C\u5909\u308F\u3063\u305F\u305F\u3081\u3001\u81EA\u52D5\u8EE2\u8A18\u3057\u307E\u305B\u3093\u3002";
  if (!valueMatchesSampleType(value, locator.sampleValueType)) {
    return "\u30B5\u30F3\u30D7\u30EB\u3068\u5024\u306E\u7A2E\u985E\u304C\u5909\u308F\u3063\u305F\u305F\u3081\u3001\u81EA\u52D5\u8EE2\u8A18\u3057\u307E\u305B\u3093\u3002";
  }
  return "";
}
function balancedEndBoundary(body, from, token) {
  const pair = Object.entries(DELIMITER_PAIRS).find(([, value]) => value.token === token);
  if (!pair) return { value: "", status: "invalid", reason: "\u5024\u306E\u7D42\u308F\u308A\u3092\u5B89\u5168\u306B\u78BA\u8A8D\u3067\u304D\u307E\u305B\u3093\u3002" };
  const [open, { close }] = pair;
  const lineEnd = body.indexOf("\n", from) < 0 ? body.length : body.indexOf("\n", from);
  const segment = body.slice(from, lineEnd);
  let depth = 0;
  let end = -1;
  for (let index = 0; index < segment.length; index += 1) {
    const character = segment[index];
    if (character === open) {
      depth += 1;
    } else if (character === close) {
      if (depth === 0) return { value: "", status: "invalid", reason: "\u5024\u306E\u62EC\u5F27\u304C\u5BFE\u5FDC\u3057\u3066\u3044\u306A\u3044\u305F\u3081\u3001\u81EA\u52D5\u8EE2\u8A18\u3057\u307E\u305B\u3093\u3002" };
      depth -= 1;
      if (depth === 0) end = from + index + 1;
    }
  }
  if (depth !== 0) return { value: "", status: "invalid", reason: "\u5024\u306E\u62EC\u5F27\u304C\u5BFE\u5FDC\u3057\u3066\u3044\u306A\u3044\u305F\u3081\u3001\u81EA\u52D5\u8EE2\u8A18\u3057\u307E\u305B\u3093\u3002" };
  if (end < 0) return { value: "", status: "missing", reason: "\u5024\u306E\u7D42\u308F\u308A\u306B\u3042\u3063\u305F\u62EC\u5F27\u304C\u898B\u3064\u304B\u308A\u307E\u305B\u3093\u3002" };
  if (body.slice(end, lineEnd).trim()) return { value: "", status: "invalid", reason: "\u5024\u306E\u7D42\u308F\u308A\u3088\u308A\u5F8C\u308D\u306B\u6587\u5B57\u304C\u3042\u308B\u305F\u3081\u3001\u81EA\u52D5\u8EE2\u8A18\u3057\u307E\u305B\u3093\u3002" };
  if (end - from > 500) return { value: "", status: "invalid", reason: candidateLengthIssue(body.slice(from, end)) };
  return { value: "", status: "ok", reason: "", end };
}
function topLevelSuffixIndexes(body, from, to, suffix) {
  const stack = [];
  const indexes = [];
  for (let index = from; index < to; index += 1) {
    if (!stack.length && body.startsWith(suffix, index)) {
      indexes.push(index);
      index += Math.max(0, suffix.length - 1);
      continue;
    }
    const opener = DELIMITER_PAIRS[body[index]];
    if (opener) {
      stack.push(opener.close);
      continue;
    }
    if (!DELIMITER_CLOSERS.has(body[index])) continue;
    if (stack.pop() !== body[index]) return null;
  }
  return stack.length ? null : indexes;
}
function locatorResult(values, missingReason) {
  if (!values.length) return { value: "", status: "missing", reason: missingReason };
  if (values.length > 1) return { value: "", status: "ambiguous", reason: "\u540C\u3058\u53D6\u5F97\u4F4D\u7F6E\u304C\u8907\u6570\u3042\u308B\u305F\u3081\u3001\u81EA\u52D5\u8EE2\u8A18\u3057\u307E\u305B\u3093\u3002" };
  const value = values[0].trim();
  if (!value) return { value: "", status: "invalid", reason: "\u898B\u51FA\u3057\u306E\u5F8C\u308D\u306B\u5024\u304C\u3042\u308A\u307E\u305B\u3093\u3002" };
  const issue = candidateLengthIssue(value);
  return issue ? { value: "", status: "invalid", reason: issue } : { value, status: "ok", reason: "" };
}
function labelLocatorLocations(body, locator, aliases = []) {
  const anchorRule = { id: 0, name: locator.label || "", method: "after", start: locator.label || "", end: "", pattern: "", anchorConfirmed: true, aliases };
  const labels = [locator.label || "", ...aliases].filter(Boolean);
  const anchorCandidates = locator.bracketed ? bracketLabelsMatchAnywhere(body, labels) : locator.inline ? plainStructuralLabelsMatch(body, labels, 0, body.length, "inline") : findRuleAnchors(body, anchorRule);
  const anchorMap = /* @__PURE__ */ new Map();
  for (const anchor of anchorCandidates) {
    const current = anchorMap.get(anchor.index);
    if (!current || anchor.end > current.end) anchorMap.set(anchor.index, anchor);
  }
  return [...anchorMap.values()].sort((left, right) => left.index - right.index).map((anchor) => {
    const contentStart = locator.innerLabel ? positionAfterInnerLabel(body, anchor.end, locator.innerLabel) : skipHorizontalSpace(body, anchor.end);
    return { anchor, valueStart: locator.includeLabel && locator.bracketed ? anchor.index : contentStart, contentStart, quoteDepth: standardQuoteDepth(body, anchor.index) };
  }).filter((location) => location.contentStart >= 0);
}
function extractWithSafeLocator(body, rule) {
  const locator = rule.locator;
  if (!locator || !safeLocatorIsValid(locator)) {
    return { value: "", status: "invalid", reason: "\u65E7\u5F62\u5F0F\u306E\u81EA\u52D5\u53D6\u5F97\u6761\u4EF6\u3067\u3059\u3002\u672C\u6587\u304B\u3089\u5024\u3092\u9078\u3073\u76F4\u3057\u3066\u304F\u3060\u3055\u3044\u3002" };
  }
  if (locator.kind === "label") {
    const locations = labelLocatorLocations(body, locator, safeAliases(rule));
    if (!locations.length) return { value: "", status: "missing", reason: locator.innerLabel ? `\u898B\u51FA\u3057\u300C${locator.innerLabel}\u300D\u304C\u7D9A\u304F\u53D6\u5F97\u4F4D\u7F6E\u3092\u78BA\u8A8D\u3067\u304D\u307E\u305B\u3093\u3002` : `\u898B\u51FA\u3057\u300C${locator.label}\u300D\u304C\u898B\u3064\u304B\u308A\u307E\u305B\u3093\u3002` };
    if (locations.length > 1) return { value: "", status: "ambiguous", reason: `\u898B\u51FA\u3057\u300C${locator.label}\u300D\u304C\u8907\u6570\u3042\u308B\u305F\u3081\u3001\u81EA\u52D5\u8EE2\u8A18\u3057\u307E\u305B\u3093\u3002` };
    const { anchor, valueStart, contentStart, quoteDepth } = locations[0];
    if (!locator.nextLabel && JSON.stringify(structuralContextLabels(body, anchor.end)) !== JSON.stringify(locator.sampleContextLabels)) return { value: "", status: "invalid", reason: "サンプルと周囲の項目構造が変わったため、自動転記しません。" };
    const lineEnd = body.indexOf("\n", contentStart) < 0 ? body.length : body.indexOf("\n", contentStart);
    let end = lineEnd;
    if (locator.nextLabel) {
      const searchEnd = Math.min(body.length, contentStart + 501);
      const nextMatches = locator.nextLabelBracketed ? bracketLabelMatchesAnywhere(body.slice(contentStart, searchEnd), locator.nextLabel).map((match) => ({ index: contentStart + match.index, end: contentStart + match.end })) : plainLabelMatchesAfter(body, locator.nextLabel, contentStart, searchEnd);
      if (!nextMatches.length) return { value: "", status: "missing", reason: `\u6B21\u306E\u898B\u51FA\u3057\u300C${locator.nextLabel}\u300D\u304C\u898B\u3064\u304B\u308A\u307E\u305B\u3093\u3002` };
      if (nextMatches.length > 1) return { value: "", status: "ambiguous", reason: `\u6B21\u306E\u898B\u51FA\u3057\u300C${locator.nextLabel}\u300D\u304C\u8907\u6570\u3042\u308B\u305F\u3081\u3001\u81EA\u52D5\u8EE2\u8A18\u3057\u307E\u305B\u3093\u3002` };
      const interveningLabels = structuralLabelTokens(body.slice(contentStart, nextMatches[0].index));
      if (interveningLabels.length) return { value: "", status: "invalid", reason: `\u898B\u51FA\u3057\u300C${locator.label}\u300D\u3068\u6B21\u306E\u898B\u51FA\u3057\u300C${locator.nextLabel}\u300D\u306E\u9593\u306B\u5225\u306E\u9805\u76EE\u304C\u3042\u308B\u305F\u3081\u3001\u81EA\u52D5\u8EE2\u8A18\u3057\u307E\u305B\u3093\u3002` };
      end = nextMatches[0].index;
      const boundaryLineStart = body.lastIndexOf("\n", Math.max(contentStart, end - 1)) + 1;
      const boundaryPrefix = body.slice(boundaryLineStart, end);
      if (boundaryLineStart > contentStart && /^[ \t\u3000]*(?:>[ \t\u3000]*)*(?:[*#・■□◇◆]+[ \t\u3000]*)?$/.test(boundaryPrefix)) {
        end = boundaryLineStart;
      } else {
        while (end > contentStart && /[ \t\u3000]/.test(body[end - 1])) end -= 1;
        if (end > contentStart && /[｜|／/;；,，、]/.test(body[end - 1])) end -= 1;
      }
    } else if (locator.suffix) {
      const searchEnd = Math.min(lineEnd, contentStart + 601);
      const suffixIndexes = topLevelSuffixIndexes(body, contentStart, searchEnd, locator.suffix);
      if (suffixIndexes === null) return { value: "", status: "invalid", reason: "\u5024\u306E\u62EC\u5F27\u304C\u5BFE\u5FDC\u3057\u3066\u3044\u306A\u3044\u305F\u3081\u3001\u81EA\u52D5\u8EE2\u8A18\u3057\u307E\u305B\u3093\u3002" };
      if (!suffixIndexes.length) return { value: "", status: "missing", reason: "\u5024\u306E\u76F4\u5F8C\u306B\u3042\u3063\u305F\u76EE\u5370\u304C\u898B\u3064\u304B\u308A\u307E\u305B\u3093\u3002" };
      if (suffixIndexes.length > 1) return { value: "", status: "ambiguous", reason: "\u5024\u306E\u7D42\u308F\u308A\u5019\u88DC\u304C\u8907\u6570\u3042\u308B\u305F\u3081\u3001\u81EA\u52D5\u8EE2\u8A18\u3057\u307E\u305B\u3093\u3002" };
      end = suffixIndexes[0];
    } else if (locator.balancedEnd) {
      const balanced = balancedEndBoundary(body, contentStart, locator.balancedEnd);
      if (balanced.status !== "ok" || balanced.end === void 0) return balanced;
      end = balanced.end;
    } else if (lineEnd < body.length) {
      const nextLineEnd = body.indexOf("\n", lineEnd + 1);
      const nextLine = body.slice(lineEnd + 1, nextLineEnd < 0 ? body.length : nextLineEnd);
      if (nextLine.trim() && !structuredLeadingLine(nextLine)) {
        return { value: "", status: "invalid", reason: "\u6B21\u306E\u884C\u304C\u5024\u306E\u7D9A\u304D\u304B\u5224\u5B9A\u3067\u304D\u306A\u3044\u305F\u3081\u3001\u81EA\u52D5\u8EE2\u8A18\u3057\u307E\u305B\u3093\u3002\u6B21\u306E\u898B\u51FA\u3057\u307E\u3067\u542B\u3081\u3066\u9078\u3073\u76F4\u3057\u3066\u304F\u3060\u3055\u3044\u3002" };
      }
    }
    const content = stripQuotedCandidate(body.slice(contentStart, end), quoteDepth);
    if (content.issue) return { value: "", status: "invalid", reason: content.issue };
    if (!content.value) return { value: "", status: "invalid", reason: "見出しの後ろに値がありません。" };
    const extracted = stripQuotedCandidate(body.slice(valueStart, end), quoteDepth);
    if (extracted.issue) return { value: "", status: "invalid", reason: extracted.issue };
    const value = extracted.value;
    const candidateIssue = proseCandidateIssue(content.value);
    if (candidateIssue) return { value: "", status: "invalid", reason: candidateIssue };
    const signatureIssue = extractedSignatureIssue(value, locator);
    if (signatureIssue) return { value: "", status: "invalid", reason: signatureIssue };
    return locatorResult([value], `\u898B\u51FA\u3057\u300C${locator.label}\u300D\u306E\u5F8C\u308D\u306B\u5024\u304C\u898B\u3064\u304B\u308A\u307E\u305B\u3093\u3002`);
  }
  if (locator.kind === "block") {
    const lines = body.split("\n");
    const starts = lines.map((line, index) => ({ line, index })).filter(({ line }) => semanticLabel(line) === semanticLabel(locator.heading || ""));
    if (starts.length !== 1) return starts.length ? { value: "", status: "ambiguous", reason: "\u540C\u3058\u898B\u51FA\u3057\u304C\u8907\u6570\u3042\u308B\u305F\u3081\u3001\u81EA\u52D5\u8EE2\u8A18\u3057\u307E\u305B\u3093\u3002" } : { value: "", status: "missing", reason: `\u898B\u51FA\u3057\u300C${locator.heading}\u300D\u304C\u898B\u3064\u304B\u308A\u307E\u305B\u3093\u3002` };
    let from = starts[0].index + 1;
    while (from < lines.length && !lines[from].trim()) from += 1;
    let to = lines.length;
    if (locator.endHeading) {
      const ends = lines.map((line, index) => ({ line, index })).filter(({ line, index }) => index >= from && semanticLabel(line) === semanticLabel(locator.endHeading || ""));
      if (ends.length !== 1) return ends.length ? { value: "", status: "ambiguous", reason: "\u5024\u306E\u7D42\u308F\u308A\u5019\u88DC\u304C\u8907\u6570\u3042\u308B\u305F\u3081\u3001\u81EA\u52D5\u8EE2\u8A18\u3057\u307E\u305B\u3093\u3002" } : { value: "", status: "missing", reason: "\u5024\u306E\u76F4\u5F8C\u306B\u3042\u3063\u305F\u898B\u51FA\u3057\u304C\u898B\u3064\u304B\u308A\u307E\u305B\u3093\u3002" };
      to = ends[0].index;
    }
    const value = lines.slice(from, to).join("\n").trim();
    const issue = boundedCandidateIssue(value) || (structuralPlainLabelCount(value) > 0 ? "\u53D6\u5F97\u7BC4\u56F2\u306B\u5225\u306E\u9805\u76EE\u304C\u542B\u307E\u308C\u3066\u3044\u308B\u305F\u3081\u3001\u81EA\u52D5\u8EE2\u8A18\u3057\u307E\u305B\u3093\u3002" : "") || proseCandidateIssue(value) || unbalancedDelimiterIssue(value) || extractedSignatureIssue(value, locator);
    return issue ? { value: "", status: "invalid", reason: issue } : locatorResult([value], "\u898B\u51FA\u3057\u306E\u5F8C\u308D\u306B\u5024\u304C\u898B\u3064\u304B\u308A\u307E\u305B\u3093\u3002");
  }
  if (locator.kind === "json") {
    try {
      let value = JSON.parse(body);
      for (const part of locator.path || []) {
        if (value === null || typeof value !== "object" || Array.isArray(value) || !Object.prototype.hasOwnProperty.call(value, part)) {
          return { value: "", status: "missing", reason: "\u4FDD\u5B58\u3057\u305FJSON\u9805\u76EE\u306E\u4F4D\u7F6E\u304C\u898B\u3064\u304B\u308A\u307E\u305B\u3093\u3002" };
        }
        value = value[part];
      }
      return typeof value === locator.jsonType ? locatorResult([String(value)], "\u4FDD\u5B58\u3057\u305FJSON\u9805\u76EE\u306E\u5024\u304C\u898B\u3064\u304B\u308A\u307E\u305B\u3093\u3002") : { value: "", status: "invalid", reason: "\u4FDD\u5B58\u3057\u305FJSON\u9805\u76EE\u306E\u5F62\u5F0F\u304C\u5909\u308F\u3063\u305F\u305F\u3081\u3001\u81EA\u52D5\u8EE2\u8A18\u3057\u307E\u305B\u3093\u3002" };
    } catch {
      return { value: "", status: "invalid", reason: "JSON\u5F62\u5F0F\u304C\u5909\u308F\u3063\u305F\u305F\u3081\u3001\u81EA\u52D5\u8EE2\u8A18\u3057\u307E\u305B\u3093\u3002" };
    }
  }
  if (locator.kind === "qa") {
    const lines = body.split("\n");
    const questions = lines.map((line, index) => ({ line: line.trim(), index })).filter(({ line }) => line === String(locator.question || "").trim());
    if (questions.length !== 1) return questions.length ? { value: "", status: "ambiguous", reason: "\u540C\u3058\u8CEA\u554F\u304C\u8907\u6570\u3042\u308B\u305F\u3081\u3001\u81EA\u52D5\u8EE2\u8A18\u3057\u307E\u305B\u3093\u3002" } : { value: "", status: "missing", reason: "\u8A2D\u5B9A\u3057\u305F\u8CEA\u554F\u304C\u898B\u3064\u304B\u308A\u307E\u305B\u3093\u3002" };
    const blockStart = questions[0].index + 1;
    let blockEnd = blockStart;
    while (blockEnd < lines.length && !/^Q\s*\d+[.．]?/i.test(lines[blockEnd].trim())) blockEnd += 1;
    const answers = lines.slice(blockStart, blockEnd).map((line, offset) => ({ index: blockStart + offset, match: line.trim().match(/^回答\s*(?:：|:|=|＝)\s*(.*?)\s*$/) })).filter((item) => Boolean(item.match));
    if (answers.length > 1) return { value: "", status: "ambiguous", reason: "同じ質問に回答が複数あるため、自動転記しません。" };
    if (!answers.length) return { value: "", status: "missing", reason: "この質問の回答が見つかりません。" };
    let firstContent = blockStart;
    while (firstContent < blockEnd && !lines[firstContent].trim()) firstContent += 1;
    if (answers[0].index !== firstContent) return { value: "", status: "missing", reason: "この質問の直後に回答が見つかりません。" };
    const answerMatch = answers[0].match;
    const answerLine = answerMatch[1] || "";
    const runtimeBracketed = answerLine.startsWith("[") && answerLine.endsWith("]");
    if (runtimeBracketed !== locator.qaBracketed) {
      return { value: "", status: "invalid", reason: "\u56DE\u7B54\u6B04\u306E\u62EC\u5F27\u5F62\u5F0F\u304C\u30B5\u30F3\u30D7\u30EB\u304B\u3089\u5909\u308F\u3063\u305F\u305F\u3081\u3001\u81EA\u52D5\u8EE2\u8A18\u3057\u307E\u305B\u3093\u3002" };
    }
    const answer = runtimeBracketed ? answerLine.slice(1, -1).trim() : answerLine.trim();
    if (!answer) return locatorResult([], "\u3053\u306E\u8CEA\u554F\u306E\u56DE\u7B54\u304C\u898B\u3064\u304B\u308A\u307E\u305B\u3093\u3002");
    const issue = unboundedCandidateIssue(answer) || proseCandidateIssue(answer) || unbalancedDelimiterIssue(answer) || extractedSignatureIssue(answer, locator);
    return issue ? { value: "", status: "invalid", reason: issue } : locatorResult([answer], "\u3053\u306E\u8CEA\u554F\u306E\u56DE\u7B54\u304C\u898B\u3064\u304B\u308A\u307E\u305B\u3093\u3002");
  }
  return { value: "", status: "invalid", reason: "\u5B89\u5168\u306B\u78BA\u8A8D\u3067\u304D\u306A\u3044\u53D6\u5F97\u6761\u4EF6\u3067\u3059\u3002\u672C\u6587\u304B\u3089\u5024\u3092\u9078\u3073\u76F4\u3057\u3066\u304F\u3060\u3055\u3044\u3002" };
}
function typedValue(scope, method) {
  if (method === "after") return scope;
  const searchable = scope.normalize("NFKC").trim();
  if (method === "number") {
    return searchable.match(/^([+-]?(?:\d[\d,]*)(?:\.\d+)?)(?:\s*(?:件|個|名|歳|台|本|枚|回|%|％))?$/)?.[1] || "";
  }
  if (method === "money") {
    if (/(?:未定|不明|上限|下限|最大|最小|目安|参考|予定|予算)/u.test(searchable)) return "";
    const exact = searchable.match(/^((?:¥|￥)\s?[+-]?\d[\d,]*(?:\.\d+)?|[+-]?\d[\d,]*(?:\.\d+)?\s*円|[+-]?\d[\d,]*(?:\.\d+)?)(?:\s*[（(][^()（）\r\n]{0,40}[）)])?$/)?.[1]?.trim();
    if (exact) return exact;
    const marked = Array.from(searchable.matchAll(/(?:¥|￥)\s?[+-]?\d[\d,]*(?:\.\d+)?|[+-]?\d[\d,]*(?:\.\d+)?\s*円/g), (match) => match[0].trim());
    return marked.length === 1 ? marked[0] : "";
  }
  if (method === "date") {
    const match = searchable.match(/^(\d{4}[/-]\d{1,2}[/-]\d{1,2}(?:\s+\d{1,2}:\d{2})?|\d{4}年\d{1,2}月\d{1,2}日(?:\s+\d{1,2}:\d{2})?|\d{1,2}月\d{1,2}日(?:\s+\d{1,2}:\d{2})?)(?:\s*[（(][^()（）\r\n]{0,40}[）)])?$/);
    const candidates = match ? [match[1]] : [];
    const valid = candidates.filter((candidate) => {
      const parts = candidate.match(/^(?:(\d{4})(?:[/-]|年))?(\d{1,2})(?:[/-]|月)(\d{1,2})(?:日)?(?:\s+(\d{1,2}):(\d{2}))?$/);
      if (!parts) return false;
      const year = Number(parts[1] || 2e3);
      const month = Number(parts[2]);
      const day = Number(parts[3]);
      const hour = Number(parts[4] || 0);
      const minute = Number(parts[5] || 0);
      const date = new Date(Date.UTC(year, month - 1, day));
      return month >= 1 && month <= 12 && day >= 1 && date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day && hour <= 23 && minute <= 59;
    });
    return valid.length === 1 ? valid[0] : "";
  }
  if (method === "email") {
    return searchable.match(/^<?([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})>?$/i)?.[1] || "";
  }
  if (method === "phone") {
    const candidate = searchable.match(/^((?:0\d{1,4}[-ー－\s]\d{1,4}[-ー－\s]\d{3,4}|0\d{9,10}))(?:\s*[（(][^()（）\r\n]{0,40}[）)])?$/)?.[1] || "";
    const digits = candidate.replace(/\D/g, "");
    return digits.length === 10 || digits.length === 11 ? candidate : "";
  }
  return searchable;
}
function extractValueResult(body, rule, allRules = [rule]) {
  const rawBody = String(body || "");
  if (rawBody.length > 400_000) return { value: "", status: "invalid", reason: "\u672C\u6587\u304C\u9577\u3059\u304E\u308B\u305F\u3081\u3001\u5B89\u5168\u306B\u81EA\u52D5\u62BD\u51FA\u3067\u304D\u307E\u305B\u3093\u3002\u51E6\u7406\u5C65\u6B74\u304B\u3089\u5185\u5BB9\u3092\u78BA\u8A8D\u3057\u3066\u304F\u3060\u3055\u3044\u3002" };
  const sourceBody = rawBody.replace(/\r\n?/g, "\n");
  if (sourceBody.length > 200_000) return { value: "", status: "invalid", reason: "\u672C\u6587\u304C\u9577\u3059\u304E\u308B\u305F\u3081\u3001\u5B89\u5168\u306B\u81EA\u52D5\u62BD\u51FA\u3067\u304D\u307E\u305B\u3093\u3002\u51E6\u7406\u5C65\u6B74\u304B\u3089\u5185\u5BB9\u3092\u78BA\u8A8D\u3057\u3066\u304F\u3060\u3055\u3044\u3002" };
  if (!Array.isArray(allRules) || allRules.length > 50) return { value: "", status: "invalid", reason: "\u53D6\u5F97\u9805\u76EE\u304C\u591A\u3059\u304E\u308B\u305F\u3081\u3001\u5B89\u5168\u306B\u81EA\u52D5\u62BD\u51FA\u3067\u304D\u307E\u305B\u3093\u3002" };
  if (!extractionAliasesAreValid(rule) || allRules.some((candidate) => !extractionAliasesAreValid(candidate))) {
    return { value: "", status: "invalid", reason: "\u5225\u306E\u898B\u51FA\u3057\u306F100\u6587\u5B57\u4EE5\u5185\u30FB10\u4EF6\u307E\u3067\u3067\u5165\u529B\u3057\u3066\u304F\u3060\u3055\u3044\u3002" };
  }
  const labelBudget = allRules.reduce((total, candidate) => total + [candidate.start, candidate.locator?.label || "", ...safeAliases(candidate)].reduce((sum, marker) => sum + semanticLabel(String(marker || "")).length, 0), 0);
  if (labelBudget > 4096) return { value: "", status: "invalid", reason: "\u898B\u51FA\u3057\u3068\u5225\u306E\u898B\u51FA\u3057\u306E\u5408\u8A08\u304C\u9577\u3059\u304E\u308B\u305F\u3081\u3001\u5B89\u5168\u306B\u81EA\u52D5\u62BD\u51FA\u3067\u304D\u307E\u305B\u3093\u3002" };
  if (rule.method === "between") return { value: "", status: "invalid", reason: "旧形式の範囲指定です。本文から取得したい値を選び直してください。" };
  if (rule.method !== "regex" && !extractionAnchorIsAccepted(rule)) {
    return { value: "", status: "invalid", reason: `\u62BD\u51FA\u9805\u76EE\u300C${rule.name}\u300D\u3068\u898B\u51FA\u3057\u300C${cleanAnchorLabel(rule.start)}\u300D\u304C\u4E00\u81F4\u3057\u3066\u3044\u307E\u305B\u3093\u3002` };
  }
  if (rule.method === "regex") {
    return extractWithSafeLocator(sourceBody, rule);
  }
  const markers = [rule.start, ...safeAliases(rule)].filter((value2) => String(value2 || "").trim());
  if (!markers.length) return { value: "", status: "invalid", reason: "\u9805\u76EE\u3092\u898B\u5206\u3051\u308B\u898B\u51FA\u3057\u3092\u5165\u529B\u3057\u3066\u304F\u3060\u3055\u3044\u3002" };
  const anchors = findRuleAnchors(sourceBody, rule);
  const label = cleanAnchorLabel(rule.start) || rule.name;
  if (!anchors.length) return { value: "", status: "missing", reason: `\u898B\u51FA\u3057\u300C${label}\u300D\u304C\u898B\u3064\u304B\u308A\u307E\u305B\u3093\u3002` };
  if (anchors.length > 1) return { value: "", status: "ambiguous", reason: `\u898B\u51FA\u3057\u300C${label}\u300D\u304C\u8907\u6570\u3042\u308B\u305F\u3081\u3001\u81EA\u52D5\u8EE2\u8A18\u3057\u307E\u305B\u3093\u3002` };
  const scope = fieldValueAfter(sourceBody, anchors[0].end, rule, allRules);
  if (!scope) return { value: "", status: "invalid", reason: `\u898B\u51FA\u3057\u300C${label}\u300D\u306E\u5F8C\u308D\u306B\u5024\u304C\u3042\u308A\u307E\u305B\u3093\u3002` };
  const issue = unboundedCandidateIssue(scope) || proseCandidateIssue(scope);
  if (issue) return { value: "", status: "invalid", reason: issue };
  const value = typedValue(scope, rule.method).trim();
  if (!value) return { value: "", status: "invalid", reason: `${methodLabels[rule.method]}\u3068\u3057\u3066\u78BA\u8A8D\u3067\u304D\u307E\u305B\u3093\u3002` };
  return { value, status: "ok", reason: "" };
}
function extractValue(body, rule, allRules = [rule]) {
  return extractValueResult(body, rule, allRules).value;
}
const methodLabels = {
  after: "\u6587\u5B57",
  number: "\u6570\u5B57",
  money: "\u91D1\u984D",
  date: "\u65E5\u4ED8\u30FB\u65E5\u6642",
  email: "\u30E1\u30FC\u30EB\u30A2\u30C9\u30EC\u30B9",
  phone: "\u96FB\u8A71\u756A\u53F7",
  between: "2\u3064\u306E\u6587\u5B57\u306E\u9593\uFF08\u8A73\u7D30\u8A2D\u5B9A\uFF09",
  regex: "\u30B5\u30F3\u30D7\u30EB\u304B\u3089\u81EA\u52D5\u8A2D\u5B9A"
};

async function loadOwnedRule(db, userId, id) {
  const row = await db
    .prepare(
      `SELECT id, name, sender, subject_contains, fields_json, spreadsheet_id, spreadsheet_name,
              sheet_name, sheet_headers_json, mappings_json, active, created_at, updated_at
       FROM extraction_rules WHERE id = ? AND user_id = ?`,
    )
    .bind(id, userId)
    .first();
  if (!row) throw new HttpError(404, "ルールが見つかりません。", "rule_not_found");
  return parseRuleRow(row);
}

async function handleRuleRun(request, env, ruleId) {
  assertSameOrigin(request);
  const user = await requireAuthorizedUser(request, env);
  const db = requireDb(env);
  const rule = await loadOwnedRule(db, user.id, ruleId);
  if (!rule.spreadsheetId || !rule.sheetName) {
    throw new HttpError(400, "先にGoogle Sheetsの出力先を設定してください。", "sheet_not_configured");
  }
  const result = await processSavedRule(env, user.id, rule);
  return json({ ok: true, result });
}

async function processSavedRule(env, userId, rule, options = {}) {
  const db = requireDb(env);
  const unsafeField = rule.fields.find((field) => field.method === "source" ? !sourceFieldIsValid(field) : field.method !== "regex" || !safeLocatorIsValid(field.locator));
  if (unsafeField) {
    await addHistory(db, {
      userId,
      ruleId: rule.id,
      subject: `ルール「${rule.name}」`,
      destination: rule.sheetName || "Google Sheets",
      status: "review",
      errorMessage: `${unsafeField.name}：旧形式の取得条件です。本文から正しい値を選び直してください。`,
    });
    return { success: 0, review: 1, skipped: 0, searched: 0 };
  }
  if (!rule.spreadsheetId || !rule.sheetName) {
    await addHistory(db, {
      userId,
      ruleId: rule.id,
      subject: `ルール「${rule.name}」`,
      destination: rule.sheetName || "Google Sheets未設定",
      status: "failed",
      errorMessage: "Spreadsheetまたはシート名が未設定のため実行できませんでした。",
    });
    return { success: 0, review: 1, skipped: 0, searched: 0 };
  }
  let sheet;
  try {
    sheet = await inspectSheet(env, userId, rule.spreadsheetId, rule.sheetName);
  } catch (error) {
    await addHistory(db, {
      userId,
      ruleId: rule.id,
      subject: `ルール「${rule.name}」`,
      destination: rule.sheetName,
      status: "failed",
      errorMessage: `Google Sheetsを確認できませんでした：${error instanceof Error ? error.message : "不明なエラー"}`,
    });
    return { success: 0, review: 1, skipped: 0, searched: 0 };
  }
  let messages = [];
  if (Array.isArray(options.messages)) {
    messages = options.messages.filter((message) => messageMatchesRule(message, rule));
  } else {
    try {
      // 手動実行では、条件に一致する最近の未処理メールを対象にする。
      const searchResult = await searchGmail(env, userId, rule.sender, rule.subjectContains, 10, false);
      messages = Array.isArray(searchResult?.messages) ? searchResult.messages : [];
    } catch (error) {
      await addHistory(db, {
        userId,
        ruleId: rule.id,
        subject: `ルール「${rule.name}」`,
        destination: `${sheet.spreadsheetName} / ${sheet.sheetName}`,
        status: "failed",
        errorMessage: `Gmailを検索できませんでした：${error instanceof Error ? error.message : "不明なエラー"}`,
      });
      return { success: 0, review: 1, skipped: 0, searched: 0 };
    }
  }
  if (!messages.length) {
    const condition = rule.sender ? `差出人「${rule.sender}」` : rule.subjectContains ? `件名「${rule.subjectContains}」` : "指定条件";
    await addHistory(db, {
      userId,
      ruleId: rule.id,
      subject: `ルール「${rule.name}」を確認`,
      destination: `${sheet.spreadsheetName} / ${sheet.sheetName}`,
      status: "skipped",
      errorMessage: Array.isArray(options.messages)
        ? `今回受信したメールは${condition}に一致しなかったため、転記しませんでした。`
        : `${condition}に完全一致する未処理メールが見つからなかったため、転記しませんでした。`,
    });
    return { success: 0, review: 0, skipped: 1, searched: 0 };
  }
  let success = 0;
  let review = 0;
  let skipped = 0;
  for (const message of [...messages].reverse()) {
    let messageId;
    try {
      messageId = normalizeGmailMessageId(message.id, true);
    } catch (error) {
      await addHistorySafely(db, {
        userId,
        ruleId: rule.id,
        receivedAt: message.receivedAt,
        subject: message.subject,
        destination: `${sheet.spreadsheetName} / ${sheet.sheetName}`,
        status: "review",
        errorMessage: error instanceof Error ? error.message : "Gmailメッセージを確認できませんでした。",
      });
      review += 1;
      continue;
    }
    const ruleReserved = await reserveProcessedMessage(db, userId, rule.id, messageId);
    if (!ruleReserved) {
      skipped += 1;
      continue;
    }
    let extracted = [];
    let row = null;
    let errorMessage = "";
    try {
      extracted = rule.fields.map((field) => {
        const result = extractMessageFieldResult(message, field, rule.fields);
        return { field, result, value: result.value };
      });
      const missing = extracted.filter((item) => item.result.status !== "ok");
      errorMessage = missing.length
        ? missing.map((item) => `${item.field.name}：${item.result.reason}`).join("／")
        : "";
      if (!missing.length) {
        const outputHeaders = sheet.headers.slice(2);
        row = [sheetTimestamp(), rule.name, ...outputHeaders.map((header) => {
          const match = extracted.find((item) => resolveMappedSheetColumn(outputHeaders, rule.mappings[String(item.field.id)]) === header.column);
          return match?.value || "";
        })];
        if (!row.slice(2).some(Boolean)) {
          errorMessage = "見出しと抽出項目の紐付けを確認してください";
          row = null;
        }
      }
    } catch (error) {
      await releaseProcessedMessage(db, userId, rule.id, messageId);
      await addHistorySafely(db, {
        userId,
        ruleId: rule.id,
        receivedAt: message.receivedAt,
        subject: message.subject,
        destination: `${sheet.spreadsheetName} / ${sheet.sheetName}`,
        status: "failed",
        errorMessage: `転記内容を準備できませんでした：${error instanceof Error ? error.message : "不明なエラー"}`,
      });
      review += 1;
      continue;
    }
    if (!row) {
      await addHistorySafely(db, {
        userId,
        ruleId: rule.id,
        receivedAt: message.receivedAt,
        subject: message.subject,
        extractedCount: extracted.filter((item) => item.value).length,
        destination: `${sheet.spreadsheetName} / ${sheet.sheetName}`,
        status: "review",
        errorMessage,
      });
      // Pre-append review failures stay retryable after the rule is repaired.
      await releaseProcessedMessage(db, userId, rule.id, messageId);
      review += 1;
      continue;
    }
    let deliveryKey = "";
    try {
      deliveryKey = await sheetDeliveryKey(messageId, sheet.spreadsheetId, sheet.sheetName);
      const deliveryReserved = await reserveProcessedMessage(
        db,
        userId,
        SHEET_DELIVERY_RECEIPT_RULE_ID,
        deliveryKey,
      );
      if (!deliveryReserved) {
        // Another test or rule owns the destination receipt. Release this
        // rule-local claim so it can recover if that owner is explicitly
        // rejected by Google and releases the shared receipt.
        await releaseProcessedMessage(db, userId, rule.id, messageId);
        skipped += 1;
        continue;
      }
    } catch (error) {
      await releaseProcessedMessage(db, userId, rule.id, messageId);
      await addHistorySafely(db, {
        userId,
        ruleId: rule.id,
        receivedAt: message.receivedAt,
        subject: message.subject,
        destination: `${sheet.spreadsheetName} / ${sheet.sheetName}`,
        status: "failed",
        errorMessage: `重複転記の確認を準備できませんでした：${error instanceof Error ? error.message : "不明なエラー"}`,
      });
      review += 1;
      continue;
    }
    try {
      await appendSheetRow(env, userId, sheet.spreadsheetId, sheet.sheetName, row);
    } catch (error) {
      if (sheetAppendWasDefinitelyRejected(error)) {
        // Google explicitly rejected the write, so no row was appended and a
        // repaired configuration must be allowed to try again.
        await releaseProcessedMessage(db, userId, SHEET_DELIVERY_RECEIPT_RULE_ID, deliveryKey);
        await releaseProcessedMessage(db, userId, rule.id, messageId);
        await addHistorySafely(db, {
          userId,
          ruleId: rule.id,
          receivedAt: message.receivedAt,
          subject: message.subject,
          extractedCount: extracted.filter((item) => item.value).length,
          destination: `${sheet.spreadsheetName} / ${sheet.sheetName}`,
          status: "failed",
          errorMessage: `Google Sheetsが書き込みを受け付けませんでした：${error.message}`,
        });
        review += 1;
        continue;
      }
      // The request may already have reached Google. Keep both receipts so a
      // webhook or manual retry cannot create a second row.
      await addHistorySafely(db, {
        userId,
        ruleId: rule.id,
        receivedAt: message.receivedAt,
        subject: message.subject,
        extractedCount: extracted.filter((item) => item.value).length,
        destination: `${sheet.spreadsheetName} / ${sheet.sheetName}`,
        status: "review",
        errorMessage: "Google Sheetsへの送信結果を確認できませんでした。二重転記を防ぐため自動再送していません。シートを確認してください。",
      });
      review += 1;
      continue;
    }
    success += 1;
    await addHistorySafely(db, {
      userId,
      ruleId: rule.id,
      receivedAt: message.receivedAt,
      subject: message.subject,
      extractedCount: extracted.filter((item) => item.value).length,
      destination: `${sheet.spreadsheetName} / ${sheet.sheetName}`,
      status: "success",
      errorMessage: "",
    });
  }
  if (skipped > 0 && success === 0 && review === 0) {
    await addHistorySafely(db, {
      userId,
      ruleId: rule.id,
      subject: `ルール「${rule.name}」を確認`,
      destination: `${sheet.spreadsheetName} / ${sheet.sheetName}`,
      status: "skipped",
      errorMessage: `一致した${skipped}件は書き込み受付済みのため、重複転記を防止しました。Google Sheetsで結果を確認してください。`,
    });
  }
  return { success, review, skipped, searched: messages.length };
}

async function activeRulesForUser(env, userId) {
  const result = await requireDb(env)
    .prepare(
      `SELECT id, name, sender, subject_contains, fields_json, spreadsheet_id, spreadsheet_name,
              sheet_name, sheet_headers_json, mappings_json, active, created_at, updated_at
       FROM extraction_rules WHERE user_id = ? AND active = 1 ORDER BY updated_at DESC LIMIT 3`,
    )
    .bind(userId)
    .all();
  return (result.results || []).map(parseRuleRow);
}

function webhookAuthorized(request, env) {
  const supplied = new URL(request.url).searchParams.get("key") || "";
  const expected = String(env.PUBSUB_WEBHOOK_SECRET || "");
  if (!supplied || supplied.length !== expected.length) return false;
  let mismatch = 0;
  for (let index = 0; index < expected.length; index += 1) mismatch |= supplied.charCodeAt(index) ^ expected.charCodeAt(index);
  return mismatch === 0;
}

async function handleGmailWebhook(request, env) {
  if (!gmailPushConfigured(env)) throw new HttpError(503, "Gmail自動受信は設定準備中です。", "gmail_push_not_configured");
  if (!webhookAuthorized(request, env)) throw new HttpError(401, "通知を確認できません。", "invalid_webhook");
  const envelope = await readJson(request, 50_000);
  let notification;
  try {
    notification = JSON.parse(decodeBody(envelope?.message?.data));
  } catch {
    throw new HttpError(400, "通知形式が正しくありません。", "invalid_notification");
  }
  const email = String(notification?.emailAddress || "").trim().toLowerCase();
  if (!email) throw new HttpError(400, "通知先メールがありません。", "missing_email");
  const connection = await requireDb(env)
    .prepare("SELECT user_id, gmail_history_id, gmail_watch_expires_at FROM google_connections WHERE lower(google_email) = ?")
    .bind(email)
    .first();
  if (!connection) return new Response(null, { status: 204 });
  const notificationAt = new Date().toISOString();
  await requireDb(env).prepare("UPDATE google_connections SET last_gmail_notification_at = ?, updated_at = ? WHERE user_id = ?")
    .bind(notificationAt, notificationAt, connection.user_id).run();
  await requireDb(env).prepare("INSERT INTO system_events (user_id, event_type, detail, created_at) VALUES (?, 'gmail_push', ?, ?)")
    .bind(connection.user_id, email, notificationAt).run();
  const notifiedHistoryId = String(notification?.historyId || "");
  let addedMessages = [];
  let nextHistoryId = String(connection.gmail_history_id || "");
  if (newerHistoryId(notifiedHistoryId, nextHistoryId)) {
    const changes = await gmailMessagesAddedSince(env, connection.user_id, nextHistoryId);
    addedMessages = changes.messages;
    nextHistoryId = changes.historyId || notifiedHistoryId;
  }
  const rules = await activeRulesForUser(env, connection.user_id);
  await addHistory(requireDb(env), {
    userId: connection.user_id,
    ruleId: null,
    receivedAt: notificationAt,
    subject: "Gmail受信通知",
    destination: "Gmail",
    status: "received",
    errorMessage: rules.length
      ? `今回追加されたメール ${addedMessages.length}件を、自動転記ONのルール ${rules.length}件で確認します。`
      : "新着メールの自動転記がONのルールがないため、転記処理は行いませんでした。",
  });
  if (addedMessages.length) {
    for (const rule of rules) await processSavedRule(env, connection.user_id, rule, { messages: addedMessages });
  }
  if (nextHistoryId && newerHistoryId(nextHistoryId, String(connection.gmail_history_id || ""))) {
    await requireDb(env)
      .prepare(
        `UPDATE google_connections SET gmail_history_id = ?, updated_at = ?
         WHERE user_id = ? AND (
           COALESCE(gmail_history_id, '') = '' OR length(gmail_history_id) < length(?)
           OR (length(gmail_history_id) = length(?) AND gmail_history_id < ?)
         )`,
      )
      .bind(nextHistoryId, new Date().toISOString(), connection.user_id, nextHistoryId, nextHistoryId, nextHistoryId)
      .run();
  }
  if (Number(connection.gmail_watch_expires_at || 0) < Date.now() + 24 * 60 * 60 * 1000) {
    await registerGmailWatch(env, connection.user_id);
  }
  return new Response(null, { status: 204 });
}

async function handleWatchStart(request, env) {
  assertSameOrigin(request);
  const user = await requireAuthorizedUser(request, env);
  if (!gmailPushConfigured(env)) throw new HttpError(503, "先にPub/Subの接続設定が必要です。", "gmail_push_not_configured");
  try {
    const watch = await registerGmailWatch(env, user.id);
    await addHistory(requireDb(env), {
      userId: user.id,
      ruleId: null,
      subject: "Gmail受信監視を開始",
      destination: "Gmail",
      status: "received",
      errorMessage: "Gmailから新着通知を受け取る準備が完了しました。",
    });
    return json({ ok: true, expiration: Number(watch?.expiration || 0) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "不明なエラー";
    await addHistory(requireDb(env), {
      userId: user.id,
      ruleId: null,
      subject: "Gmail受信監視の開始に失敗",
      destination: "Gmail",
      status: "failed",
      errorMessage: message,
    });
    throw new HttpError(502, `Gmail受信監視を開始できませんでした：${message}`, "gmail_watch_failed");
  }
}

async function handlePushConfig(request, env) {
  await requireAdmin(request, env);
  if (!gmailPushConfigured(env)) throw new HttpError(503, "Pub/Sub設定を準備中です。", "gmail_push_not_configured");
  const origin = new URL(request.url).origin;
  const key = encodeURIComponent(env.PUBSUB_WEBHOOK_SECRET);
  return json({
    ok: true,
    topic: env.GOOGLE_PUBSUB_TOPIC,
    webhookUrl: `${origin}/api/webhooks/gmail?key=${key}`,
    renewalUrl: `${origin}/api/webhooks/gmail/renew?key=${key}`,
  });
}

async function handleWatchRenewAll(request, env) {
  if (!gmailPushConfigured(env) || !webhookAuthorized(request, env)) {
    throw new HttpError(401, "更新リクエストを確認できません。", "invalid_renewal");
  }
  const rows = await requireDb(env).prepare("SELECT user_id FROM google_connections LIMIT 100").all();
  let renewed = 0;
  for (const row of rows.results || []) {
    try {
      await registerGmailWatch(env, row.user_id);
      renewed += 1;
    } catch (error) {
      console.error("Gmail watch renewal failed", row.user_id, error);
    }
  }
  return json({ ok: true, renewed });
}

async function historyRows(env, userId, limit = 100) {
  const result = await requireDb(env)
    .prepare(
      `SELECT id, rule_id, received_at, subject, extracted_count, destination, status, error_message, created_at
       FROM processing_history WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`,
    )
    .bind(userId, Math.min(Math.max(limit, 1), 500))
    .all();
  return (result.results || []).map((row) => ({
    id: row.id,
    ruleId: row.rule_id,
    receivedAt: row.received_at,
    subject: row.subject,
    extractedCount: row.extracted_count,
    destination: row.destination,
    status: row.status,
    errorMessage: row.error_message,
    createdAt: row.created_at,
  }));
}

async function handleHistory(request, env) {
  const user = await requireAuthorizedUser(request, env);
  const url = new URL(request.url);
  return json({ ok: true, history: await historyRows(env, user.id, Number(url.searchParams.get("limit") || 100)) });
}

async function handleDashboard(request, env) {
  const user = await requireAuthorizedUser(request, env);
  const rows = await historyRows(env, user.id, 500);
  const today = new Date().toISOString().slice(0, 10);
  const month = today.slice(0, 7);
  const terminalStatuses = new Set(["success", "review", "failed"]);
  const todays = rows.filter((row) => row.createdAt.startsWith(today) && terminalStatuses.has(row.status));
  const months = rows.filter((row) => row.createdAt.startsWith(month) && terminalStatuses.has(row.status));
  const count = (items, status) => items.filter((item) => item.status === status).length;
  return json({
    ok: true,
    metrics: {
      today: { total: todays.length, success: count(todays, "success"), review: count(todays, "review"), failed: count(todays, "failed") },
      month: { total: months.length, success: count(months, "success"), review: count(months, "review"), failed: count(months, "failed") },
    },
    recent: rows.slice(0, 8),
  });
}

async function handlePublicVisit(request, env) {
  assertSameOrigin(request);
  const body = await readJson(request, 8_000);
  const requestedPath = String(body.path || "/");
  const path = requestedPath.startsWith("/") && !requestedPath.startsWith("//") ? requestedPath.slice(0, 160) : "/";
  const referrerHost = safeReferrerHost(String(body.referrer || ""));
  const device = String(body.device || "") === "mobile" ? "mobile" : "desktop";
  let visitorId = cookieValue(request, "mailsheet_visitor");
  let createdCookie = false;
  if (!/^[A-Za-z0-9_-]{20,80}$/.test(visitorId)) {
    visitorId = randomUrlSafe(18);
    createdCookie = true;
  }
  const db = requireDb(env);
  const latest = await db.prepare("SELECT created_at FROM public_visits WHERE visitor_id = ? AND path = ? ORDER BY created_at DESC LIMIT 1")
    .bind(visitorId, path).first();
  const latestAt = latest?.created_at ? new Date(latest.created_at).getTime() : 0;
  if (!latestAt || Date.now() - latestAt > 30 * 60_000) {
    await db.prepare("INSERT INTO public_visits (visitor_id, path, referrer_host, device, created_at) VALUES (?, ?, ?, ?, ?)")
      .bind(visitorId, path, referrerHost, device, new Date().toISOString()).run();
  }
  return json({ ok: true }, 200, createdCookie ? { "set-cookie": publicVisitorCookie(visitorId) } : {});
}

async function handleFeedbackSubmit(request, env) {
  assertSameOrigin(request);
  const body = await readJson(request, 20_000);
  if (String(body.website || "")) return json({ ok: true });
  const category = String(body.category || "").trim().slice(0, 60);
  const pain = String(body.pain || "").trim().slice(0, 2_000);
  const currentProcess = String(body.currentProcess || "").trim().slice(0, 2_000);
  const desiredOutcome = String(body.desiredOutcome || "").trim().slice(0, 2_000);
  const contactEmail = String(body.contactEmail || "").trim().toLowerCase().slice(0, 240);
  if (!category || pain.length < 5) throw new HttpError(400, "種類と、現在のお困りごとを入力してください。", "invalid_feedback");
  if (contactEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail)) throw new HttpError(400, "連絡先メールアドレスを確認してください。", "invalid_email");
  const visitorId = /^[A-Za-z0-9_-]{20,80}$/.test(cookieValue(request, "mailsheet_visitor")) ? cookieValue(request, "mailsheet_visitor") : "";
  const recent = await requireDb(env).prepare("SELECT COUNT(*) AS count FROM feedback_requests WHERE visitor_id = ? AND created_at >= ?")
    .bind(visitorId || "anonymous", new Date(Date.now() - 60 * 60_000).toISOString()).first();
  if (Number(recent?.count || 0) >= 5) throw new HttpError(429, "短時間の送信上限に達しました。時間を置いてお試しください。", "rate_limited");
  await requireDb(env).prepare(
    "INSERT INTO feedback_requests (visitor_id, category, pain, current_process, desired_outcome, contact_email, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'new', ?)",
  ).bind(visitorId || "anonymous", category, pain, currentProcess, desiredOutcome, contactEmail, new Date().toISOString()).run();
  return json({ ok: true });
}

const TESTER_FEEDBACK_TEMPLATES = {
  question: { category: "質問・不明点", operationLabel: "迷った画面・操作", expectedLabel: "試したこと・補足" },
  bug: { category: "不具合報告・修正依頼", operationLabel: "問題が起きるまでの操作", expectedLabel: "期待していた動作" },
  survey: { category: "使用感アンケート", operationLabel: "良かった・使いやすかった点", expectedLabel: "改善してほしい点" },
};

async function handleUserFeedbackSubmit(request, env) {
  const user = await requireAuthorizedUser(request, env);
  assertSameOrigin(request);
  const body = await readJson(request, 20_000);
  const templateId = String(body.template || "question").trim();
  const template = TESTER_FEEDBACK_TEMPLATES[templateId];
  const page = String(body.page || "").trim().slice(0, 100);
  const operation = String(body.operation || "").trim().slice(0, 1_500);
  const details = String(body.details || "").trim().slice(0, 3_000);
  const expected = String(body.expected || "").trim().slice(0, 1_500);
  const rating = String(body.rating || "").trim();
  if (!template) {
    throw new HttpError(400, "投稿の種類を選択してください。", "invalid_feedback_category");
  }
  if (details.length < 5) {
    throw new HttpError(400, "内容を5文字以上で入力してください。", "invalid_feedback_details");
  }
  if (rating && (templateId !== "survey" || !["1", "2", "3", "4", "5"].includes(rating))) {
    throw new HttpError(400, "使いやすさの評価を確認してください。", "invalid_feedback_rating");
  }
  const ownerId = `app:${user.id}`;
  const db = requireDb(env);
  const recent = await db.prepare("SELECT COUNT(*) AS count FROM feedback_requests WHERE visitor_id = ? AND created_at >= ?")
    .bind(ownerId, new Date(Date.now() - 60 * 60_000).toISOString()).first();
  if (Number(recent?.count || 0) >= 10) {
    throw new HttpError(429, "短時間の投稿上限に達しました。時間を置いてお試しください。", "rate_limited");
  }
  const context = [page ? `対象画面：${page}` : "", rating ? `使いやすさ：${rating}/5` : "", operation ? `${template.operationLabel}：${operation}` : ""].filter(Boolean).join("\n");
  const createdAt = new Date().toISOString();
  const insert = await db.prepare(
    "INSERT INTO feedback_requests (visitor_id, category, pain, current_process, desired_outcome, contact_email, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'new', ?)",
  ).bind(ownerId, template.category, details, context, expected ? `${template.expectedLabel}：${expected}` : "", String(user.email || "").toLowerCase(), createdAt).run();
  const feedbackId = Number(insert.meta?.last_row_id || 0);
  return json({ ok: true, id: feedbackId });
}

async function handleAdminOverview(request, env) {
  await requireAdmin(request, env);
  const db = requireDb(env);
  const month = new Date().toISOString().slice(0, 7);
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60_000).toISOString();
  const today = new Date().toISOString().slice(0, 10);
  const [usersResult, accessResult, processingResult, eventsResult, trafficResult, trafficSummary, feedbackResult] = await Promise.all([
    db.prepare(
      `SELECT au.email, au.role, au.status, au.invited_by, au.created_at, au.last_access_at, au.access_count,
              ae.user_id, gc.google_email, gc.gmail_watch_expires_at, gc.last_gmail_notification_at,
              gc.last_watch_renewed_at,
              (SELECT ph.created_at FROM processing_history ph WHERE ph.user_id = ae.user_id ORDER BY ph.created_at DESC LIMIT 1) AS last_processed_at,
              (SELECT ph.status FROM processing_history ph WHERE ph.user_id = ae.user_id ORDER BY ph.created_at DESC LIMIT 1) AS last_process_status
       FROM app_users au
       LEFT JOIN access_events ae ON ae.id = (SELECT latest.id FROM access_events latest WHERE lower(latest.email) = lower(au.email) ORDER BY latest.created_at DESC LIMIT 1)
       LEFT JOIN google_connections gc ON gc.rowid = (
         SELECT latest_gc.rowid FROM google_connections latest_gc
         WHERE latest_gc.user_id = ae.user_id OR lower(latest_gc.google_email) = lower(au.email)
         ORDER BY latest_gc.updated_at DESC LIMIT 1
       )
       ORDER BY CASE au.role WHEN 'admin' THEN 0 ELSE 1 END, au.created_at DESC LIMIT 200`,
    ).all(),
    db.prepare("SELECT email, event_type, created_at FROM access_events ORDER BY created_at DESC LIMIT 100").all(),
    db.prepare("SELECT status, COUNT(*) AS count FROM processing_history WHERE substr(created_at, 1, 7) = ? GROUP BY status").bind(month).all(),
    db.prepare("SELECT event_type, COUNT(*) AS count FROM system_events WHERE substr(created_at, 1, 7) = ? GROUP BY event_type").bind(month).all(),
    db.prepare("SELECT visitor_id, path, referrer_host, device, created_at FROM public_visits ORDER BY created_at DESC LIMIT 100").all(),
    db.prepare("SELECT COUNT(*) AS seven_day_views, COUNT(DISTINCT visitor_id) AS seven_day_visitors, SUM(CASE WHEN substr(created_at, 1, 10) = ? THEN 1 ELSE 0 END) AS today_views FROM public_visits WHERE created_at >= ?").bind(today, sevenDaysAgo).first(),
    db.prepare("SELECT id, visitor_id, category, pain, current_process, desired_outcome, contact_email, status, created_at FROM feedback_requests ORDER BY created_at DESC LIMIT 100").all(),
  ]);
  const processing = Object.fromEntries((processingResult.results || []).map((row) => [row.status, Number(row.count)]));
  const events = Object.fromEntries((eventsResult.results || []).map((row) => [row.event_type, Number(row.count)]));
  return json({
    ok: true,
    users: usersResult.results || [],
    accessHistory: accessResult.results || [],
    publicTraffic: {
      todayViews: Number(trafficSummary?.today_views || 0),
      sevenDayViews: Number(trafficSummary?.seven_day_views || 0),
      sevenDayVisitors: Number(trafficSummary?.seven_day_visitors || 0),
      recent: trafficResult.results || [],
    },
    feedback: feedbackResult.results || [],
    metrics: {
      users: (usersResult.results || []).length,
      activeUsers: (usersResult.results || []).filter((row) => row.status === "active").length,
      connectedGoogle: (usersResult.results || []).filter((row) => row.google_email).length,
      processing: { success: processing.success || 0, review: processing.review || 0, failed: processing.failed || 0 },
      gmailNotifications: events.gmail_push || 0,
      watchRenewals: events.watch_renewal || 0,
    },
    system: {
      oauthConfigured: oauthConfigured(env),
      gmailPushConfigured: gmailPushConfigured(env),
      databaseConfigured: Boolean(env.DB),
      cloudProjectId: String(env.GOOGLE_CLOUD_PROJECT_ID || ""),
    },
    costs: {
      measured: false,
      pubsubFreeGiB: 10,
      schedulerFreeJobs: 3,
      expectedSchedulerJobs: gmailPushConfigured(env) ? 1 : 0,
      notificationCount: events.gmail_push || 0,
      note: "実請求額はCloud Billing API未接続のため取得していません。",
    },
  });
}

async function handleAdminInvite(request, env) {
  const admin = await requireAdmin(request, env);
  assertSameOrigin(request);
  const body = await readJson(request);
  const email = String(body.email || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, "メールアドレスを確認してください。", "invalid_email");
  const now = new Date().toISOString();
  await requireDb(env).prepare(
    `INSERT INTO app_users (email, role, status, invited_by, created_at, updated_at, last_access_at, access_count)
     VALUES (?, 'tester', 'invited', ?, ?, ?, '', 0)
     ON CONFLICT(email) DO UPDATE SET status = 'invited', updated_at = excluded.updated_at, invited_by = excluded.invited_by`,
  ).bind(email, admin.email, now, now).run();
  return json({ ok: true, email, status: "invited" });
}

async function handleAdminUserStatus(request, env) {
  const admin = await requireAdmin(request, env);
  assertSameOrigin(request);
  const body = await readJson(request);
  const email = String(body.email || "").trim().toLowerCase();
  const status = String(body.status || "");
  if (!email || !["invited", "active", "suspended"].includes(status)) throw new HttpError(400, "利用状態を確認してください。", "invalid_status");
  if (adminEmails(env).has(email) && status === "suspended") throw new HttpError(400, "初期管理者は停止できません。", "admin_cannot_suspend");
  const result = await requireDb(env).prepare("UPDATE app_users SET status = ?, updated_at = ? WHERE email = ?")
    .bind(status, new Date().toISOString(), email).run();
  if (!Number(result.meta?.changes || 0)) throw new HttpError(404, "利用者が見つかりません。", "user_not_found");
  return json({ ok: true, email, status });
}

async function handleAdminPendingInvite(request, env) {
  await requireAdmin(request, env);
  assertSameOrigin(request);
  const body = await readJson(request);
  const email = String(body.email || "").trim().toLowerCase();
  const action = String(body.action || "");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, "対象メールアドレスを確認してください。", "invalid_email");
  if (adminEmails(env).has(email)) throw new HttpError(400, "初期管理者は変更・削除できません。", "admin_cannot_edit");
  const db = requireDb(env);
  const user = await db.prepare("SELECT email, role, status, access_count FROM app_users WHERE email = ?").bind(email).first();
  if (!user) throw new HttpError(404, "招待済みユーザーが見つかりません。", "user_not_found");
  const connection = await db.prepare("SELECT user_id FROM google_connections WHERE lower(google_email) = ? LIMIT 1").bind(email).first();
  if (user.role !== "tester" || user.status !== "invited" || Number(user.access_count || 0) > 0 || connection) {
    throw new HttpError(409, "ログイン・接続済みの利用者はメール変更や削除ではなく、利用停止で管理してください。", "invite_already_used");
  }
  if (action === "delete") {
    await db.prepare("DELETE FROM app_users WHERE email = ?").bind(email).run();
    return json({ ok: true, action, email });
  }
  if (action === "rename") {
    const newEmail = String(body.newEmail || "").trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail)) throw new HttpError(400, "変更後のメールアドレスを確認してください。", "invalid_email");
    if (newEmail === email) return json({ ok: true, action, email: newEmail });
    const duplicate = await db.prepare("SELECT email FROM app_users WHERE email = ?").bind(newEmail).first();
    if (duplicate) throw new HttpError(409, "変更後のメールアドレスは既に登録されています。", "email_already_registered");
    const now = new Date().toISOString();
    await db.batch([
      db.prepare(
        `INSERT INTO app_users (email, role, status, invited_by, created_at, updated_at, last_access_at, access_count)
         SELECT ?, role, status, invited_by, created_at, ?, last_access_at, access_count FROM app_users WHERE email = ?`,
      ).bind(newEmail, now, email),
      db.prepare("DELETE FROM app_users WHERE email = ?").bind(email),
    ]);
    return json({ ok: true, action, email: newEmail });
  }
  throw new HttpError(400, "招待リストの操作を確認してください。", "invalid_action");
}

async function handleAdminFeedbackStatus(request, env) {
  await requireAdmin(request, env);
  assertSameOrigin(request);
  const body = await readJson(request, 8_000);
  const id = Number(body.id);
  const status = String(body.status || "");
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, "投稿IDを確認してください。", "invalid_feedback_id");
  if (!["new", "in_progress", "resolved"].includes(status)) {
    throw new HttpError(400, "対応状況を確認してください。", "invalid_feedback_status");
  }
  const existing = await requireDb(env).prepare("SELECT id FROM feedback_requests WHERE id = ?").bind(id).first();
  if (!existing) throw new HttpError(404, "投稿が見つかりません。", "feedback_not_found");
  await requireDb(env).prepare("UPDATE feedback_requests SET status = ? WHERE id = ?").bind(status, id).run();
  return json({ ok: true, id, status });
}

async function routeApi(request, env) {
  const url = new URL(request.url);
  const method = request.method.toUpperCase();
  if (method === "GET" && url.pathname === "/api/health") {
    return json({ ok: true, service: "mailsheet", oauthConfigured: oauthConfigured(env), databaseConfigured: Boolean(env.DB) });
  }
  if (method === "GET" && url.pathname === "/api/oauth/google/start") return handleOAuthStart(request, env);
  if (method === "POST" && url.pathname === "/api/public/visit") return handlePublicVisit(request, env);
  if (method === "POST" && url.pathname === "/api/public/feedback") return handleFeedbackSubmit(request, env);
  if (method === "GET" && url.pathname === "/api/oauth/google/callback") return handleOAuthCallback(request, env);
  if (method === "GET" && url.pathname === "/api/auth/status") return handleAuthStatus(request, env);
  if (method === "POST" && url.pathname === "/api/auth/disconnect") return handleDisconnect(request, env);
  if (method === "POST" && url.pathname === "/api/auth/logout") return handleLogout(request);
  if (method === "POST" && url.pathname === "/api/feedback") return handleUserFeedbackSubmit(request, env);
  if (method === "GET" && url.pathname === "/api/gmail/messages") return handleGmailMessages(request, env);
  if (method === "GET" && url.pathname === "/api/gmail/push/config") return handlePushConfig(request, env);
  if (method === "POST" && url.pathname === "/api/gmail/watch") return handleWatchStart(request, env);
  if (method === "POST" && url.pathname === "/api/webhooks/gmail") return handleGmailWebhook(request, env);
  if (method === "POST" && url.pathname === "/api/webhooks/gmail/renew") return handleWatchRenewAll(request, env);
  if (method === "POST" && url.pathname === "/api/sheets/inspect") return handleSheetInspect(request, env);
  if (method === "POST" && url.pathname === "/api/sheets/headers") return handleSheetHeaders(request, env);
  if (method === "POST" && url.pathname === "/api/sheets/test") return handleSheetTest(request, env);
  if (method === "GET" && url.pathname === "/api/rules") return handleRulesList(request, env);
  if (method === "POST" && url.pathname === "/api/rules") return handleRuleSave(request, env);
  const deleteRuleMatch = url.pathname.match(/^\/api\/rules\/(\d+)$/);
  if (method === "DELETE" && deleteRuleMatch) return handleRuleDelete(request, env, Number(deleteRuleMatch[1]));
  const runMatch = url.pathname.match(/^\/api\/rules\/(\d+)\/run$/);
  if (method === "POST" && runMatch) return handleRuleRun(request, env, Number(runMatch[1]));
  if (method === "GET" && url.pathname === "/api/history") return handleHistory(request, env);
  if (method === "GET" && url.pathname === "/api/dashboard") return handleDashboard(request, env);
  if (method === "GET" && url.pathname === "/api/admin/overview") return handleAdminOverview(request, env);
  if (method === "POST" && url.pathname === "/api/admin/invite") return handleAdminInvite(request, env);
  if (method === "POST" && url.pathname === "/api/admin/users/status") return handleAdminUserStatus(request, env);
  if (method === "POST" && url.pathname === "/api/admin/invite/manage") return handleAdminPendingInvite(request, env);
  if (method === "POST" && url.pathname === "/api/admin/feedback/status") return handleAdminFeedbackStatus(request, env);
  return apiError("APIが見つかりません。", 404, "not_found");
}

async function serveApp(request, env) {
  if (!env.ASSETS) return new Response("Assets binding unavailable", { status: 503 });
  const url = new URL(request.url);
  const acceptsHtml = (request.headers.get("accept") || "").includes("text/html");
  const isClientRoute = request.method === "GET" && acceptsHtml && !url.pathname.split("/").at(-1)?.includes(".");
  // The asset service redirects extensionless paths such as /app to `/` before
  // the SPA can read location.pathname. Serve the shell directly for client routes.
  let response = isClientRoute
    ? await env.ASSETS.fetch(new Request(new URL("/", request.url), request))
    : await env.ASSETS.fetch(request);
  if (response.status === 404 && request.method === "GET" && acceptsHtml) {
    response = await env.ASSETS.fetch(new Request(new URL("/", request.url), request));
  }
  const headers = new Headers(response.headers);
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "strict-origin-when-cross-origin");
  headers.set("permissions-policy", "camera=(), microphone=(), geolocation=()");
  headers.set("content-security-policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'self'");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export {
  extractValue as extractWorkerValue,
  extractValueResult as extractWorkerValueResult,
  processSavedRule as processSavedRuleForTest,
  sheetDeliveryKey as sheetDeliveryReceiptKey,
  sheetTestRequestKey,
};

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      if (url.pathname.startsWith("/api/")) {
        const response = await routeApi(request, env);
        return await refreshSession(request, env, response);
      }
      return await serveApp(request, env);
    } catch (error) {
      if (error instanceof HttpError) return apiError(error.message, error.status, error.code, error.details);
      console.error("Unhandled worker error", error);
      return apiError("処理中に問題が発生しました。時間を置いて再度お試しください。", 500, "internal_error");
    }
  },
};
