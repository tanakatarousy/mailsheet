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
const METHODS = new Set(["after", "between", "number", "money", "date", "email", "phone", "regex"]);

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
  return { ...user, role: access.role };
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

function sessionCookie(value, maxAge = 30 * 24 * 60 * 60) {
  return `mailsheet_session=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
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
  return new HttpError(response.status === 401 ? 401 : 502, message, "google_api_error");
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
    return decryptSecret(row.access_token_enc, env.TOKEN_ENCRYPTION_KEY);
  }
  if (!row.refresh_token_enc) {
    throw new HttpError(401, "Google接続の有効期限が切れました。再接続してください。", "google_reconnect_required");
  }
  const refreshToken = await decryptSecret(row.refresh_token_enc, env.TOKEN_ENCRYPTION_KEY);
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
      labelIds: ["INBOX"],
      labelFilterBehavior: "INCLUDE",
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
    { userId: user.id, email: user.email, expiresAt: Date.now() + 30 * 24 * 60 * 60_000 },
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

function headerValue(payload, name) {
  return payload?.headers?.find((header) => header.name?.toLowerCase() === name.toLowerCase())?.value || "";
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

function gmailQuery(sender, subject) {
  const chunks = [];
  const cleanSender = String(sender || "").normalize("NFKC").trim().replace(/["\\]/g, "");
  const cleanSubject = String(subject || "").normalize("NFKC").trim().replace(/["\\]/g, "");
  if (cleanSender) chunks.push(`from:("${cleanSender}")`);
  if (cleanSubject) chunks.push(`subject:("${cleanSubject}")`);
  return chunks.join(" ");
}

async function searchGmail(env, userId, sender, subject, limit) {
  const params = new URLSearchParams({ maxResults: String(Math.min(Math.max(limit || 8, 1), 20)) });
  const query = gmailQuery(sender, subject);
  if (query) params.set("q", query);
  const response = await googleFetch(env, userId, `${GMAIL_API}/messages?${params}`);
  const data = await response.json();
  const exact = await Promise.all((data.messages || []).map((message) => getGmailMessage(env, userId, message.id)));
  if (exact.length || (!sender && !subject)) return { messages: exact, matchMode: "exact" };

  // Gmail's search grammar can miss self-sent mail, emoji and punctuation-heavy subjects.
  // Fall back to recent messages so the user can select the sample instead of editing search syntax.
  const recentParams = new URLSearchParams({ maxResults: "50" });
  const recentResponse = await googleFetch(env, userId, `${GMAIL_API}/messages?${recentParams}`);
  const recentData = await recentResponse.json();
  const recent = await Promise.all((recentData.messages || []).map((message) => getGmailMessage(env, userId, message.id)));
  const normalize = (value) => String(value || "").normalize("NFKC").toLowerCase().replace(/\s+/g, "").trim();
  const senderNeedle = normalize(sender);
  const subjectNeedle = normalize(subject);
  const closeMatches = recent.filter((message) => {
    const senderMatch = !senderNeedle || normalize(message.from).includes(senderNeedle);
    const subjectMatch = !subjectNeedle || normalize(message.subject).includes(subjectNeedle) || subjectNeedle.includes(normalize(message.subject));
    return senderMatch && subjectMatch;
  });
  return {
    messages: (closeMatches.length ? closeMatches : recent).slice(0, Math.min(Math.max(limit || 8, 1), 20)),
    matchMode: closeMatches.length ? "close" : "recent",
  };
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

async function appendSheetRow(env, userId, inputId, sheetName, values) {
  const id = spreadsheetId(inputId);
  if (!sheetName) throw new HttpError(400, "Sheetを選択してください。", "sheet_required");
  if (!Array.isArray(values) || values.length === 0) throw new HttpError(400, "書き込む値がありません。", "values_required");
  const range = encodeURIComponent(sheetRange(sheetName, "A:ZZ"));
  const response = await googleFetch(
    env,
    userId,
    `${SHEETS_API}/${encodeURIComponent(id)}/values/${range}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ values: [values.map((value) => String(value ?? ""))] }),
    },
  );
  return response.json();
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

async function handleSheetTest(request, env) {
  assertSameOrigin(request);
  const user = await requireAuthorizedUser(request, env);
  const body = await readJson(request);
  const suppliedValues = Array.isArray(body.values) ? body.values.slice(0, 99) : [];
  const values = [sheetTimestamp(), ...suppliedValues];
  const result = await appendSheetRow(env, user.id, body.spreadsheetId, String(body.sheetName || ""), values);
  await addHistory(requireDb(env), {
    userId: user.id,
    ruleId: Number(body.ruleId) || null,
    subject: String(body.subject || "テスト書き込み").slice(0, 300),
    extractedCount: values.filter((value) => String(value ?? "").length > 0).length,
    destination: String(body.destination || body.sheetName || "Google Sheets").slice(0, 300),
    status: "success",
  });
  return json({ ok: true, updatedRange: result.updates?.updatedRange || "", updatedRows: result.updates?.updatedRows || 1 });
}

function normalizeField(field, index) {
  const method = METHODS.has(field?.method) ? field.method : "after";
  return {
    id: Number(field?.id) || index + 1,
    name: String(field?.name || `項目${index + 1}`).slice(0, 100),
    method,
    start: String(field?.start || "").slice(0, 500),
    end: String(field?.end || "").slice(0, 500),
    pattern: String(field?.pattern || "").slice(0, 2_000),
  };
}

function normalizeRuleBody(body) {
  const fields = Array.isArray(body.fields) ? body.fields.slice(0, 50).map(normalizeField) : [];
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
    active: Boolean(body.active),
  };
}

function parseRuleRow(row) {
  return {
    id: row.id,
    name: row.name,
    sender: row.sender,
    subjectContains: row.subject_contains,
    fields: JSON.parse(row.fields_json || "[]"),
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
  if (body.active && (!body.spreadsheetId || !body.sheetName)) {
    throw new HttpError(400, "自動追加をONにするには、SpreadsheetとSheetを設定してください。", "sheet_not_configured");
  }
  if (body.active && (!body.sheetHeaders.length || Object.values(body.mappings).filter(Boolean).length < body.fields.length)) {
    throw new HttpError(400, "自動追加をONにするには、1行目の見出しを取得し、すべての取得項目に出力列を割り当ててください。", "mapping_incomplete");
  }
  const db = requireDb(env);
  const now = new Date().toISOString();
  let id = body.id;
  if (id) {
    const existing = await db.prepare("SELECT id FROM extraction_rules WHERE id = ? AND user_id = ?").bind(id, user.id).first();
    if (!existing) throw new HttpError(404, "保存対象のルールが見つかりません。", "rule_not_found");
    await db
      .prepare(
        `UPDATE extraction_rules SET
           name = ?, sender = ?, subject_contains = ?, fields_json = ?, spreadsheet_id = ?,
           spreadsheet_name = ?, sheet_name = ?, sheet_headers_json = ?, mappings_json = ?, active = ?, updated_at = ?
         WHERE id = ? AND user_id = ?`,
      )
      .bind(
        body.name,
        body.sender,
        body.subjectContains,
        JSON.stringify(body.fields),
        body.spreadsheetId,
        body.spreadsheetName,
        body.sheetName,
        JSON.stringify(body.sheetHeaders),
        JSON.stringify(body.mappings),
        body.active ? 1 : 0,
        now,
        id,
        user.id,
      )
      .run();
  } else {
    const candidates = await db
      .prepare(
        `SELECT id, sender, subject_contains, fields_json, spreadsheet_id, sheet_name, mappings_json
         FROM extraction_rules WHERE user_id = ?`,
      )
      .bind(user.id)
      .all();
    const duplicate = (candidates.results || []).find((row) =>
      row.sender === body.sender
      && row.subject_contains === body.subjectContains
      && row.fields_json === JSON.stringify(body.fields)
      && row.spreadsheet_id === body.spreadsheetId
      && row.sheet_name === body.sheetName
      && row.mappings_json === JSON.stringify(body.mappings));
    if (duplicate) {
      throw new HttpError(409, "同じ条件・抽出項目・出力先のルールが既にあります。保存済みルールを開いて編集してください。", "duplicate_rule");
    }
    const result = await db
      .prepare(
        `INSERT INTO extraction_rules
         (user_id, name, sender, subject_contains, fields_json, spreadsheet_id, spreadsheet_name,
          sheet_name, sheet_headers_json, mappings_json, active, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        user.id,
        body.name,
        body.sender,
        body.subjectContains,
        JSON.stringify(body.fields),
        body.spreadsheetId,
        body.spreadsheetName,
        body.sheetName,
        JSON.stringify(body.sheetHeaders),
        JSON.stringify(body.mappings),
        body.active ? 1 : 0,
        now,
        now,
      )
      .run();
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
  return json({ ok: true, rule: parseRuleRow(saved) });
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

function firstLine(value) {
  return String(value || "").split(/\r?\n/)[0]?.trim() || "";
}

function valueAfter(body, marker) {
  if (!marker) return "";
  const index = body.indexOf(marker);
  return index < 0 ? "" : firstLine(body.slice(index + marker.length));
}

function extractValue(body, rule) {
  const scope = rule.start ? valueAfter(body, rule.start) : body;
  if (rule.method === "after") return valueAfter(body, rule.start);
  if (rule.method === "between") {
    if (!rule.start || !rule.end) return "";
    const index = body.indexOf(rule.start);
    if (index < 0) return "";
    const rest = body.slice(index + rule.start.length);
    const end = rest.indexOf(rule.end);
    return end < 0 ? "" : rest.slice(0, end).trim();
  }
  if (rule.method === "number") return scope.match(/[+-]?(?:\d[\d,]*)(?:\.\d+)?/)?.[0] || "";
  if (rule.method === "money") return scope.match(/(?:¥|￥)?\s?\d[\d,]*(?:円)?/)?.[0]?.trim() || "";
  if (rule.method === "date") {
    return scope.match(/\d{4}[/-]\d{1,2}[/-]\d{1,2}(?:\s+\d{1,2}:\d{2})?/)?.[0]
      || scope.match(/\d{1,2}月\d{1,2}日(?:\s+\d{1,2}:\d{2})?/)?.[0]
      || "";
  }
  if (rule.method === "email") return scope.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] || "";
  if (rule.method === "phone") return scope.match(/(?:0\d{1,4}[-ー－]?\d{1,4}[-ー－]?\d{3,4})/)?.[0] || "";
  if (rule.method === "regex" && rule.pattern) {
    try {
      const match = new RegExp(rule.pattern, "m").exec(body);
      return match?.[1] || match?.[0] || "";
    } catch {
      return "";
    }
  }
  return "";
}

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

async function processSavedRule(env, userId, rule) {
  const db = requireDb(env);
  if (!rule.spreadsheetId || !rule.sheetName) {
    return { success: 0, review: 1, skipped: 0, searched: 0 };
  }
  const sheet = await inspectSheet(env, userId, rule.spreadsheetId, rule.sheetName);
  const searchResult = await searchGmail(env, userId, rule.sender, rule.subjectContains, 10);
  const messages = Array.isArray(searchResult?.messages) ? searchResult.messages : [];
  let success = 0;
  let review = 0;
  let skipped = 0;
  for (const message of [...messages].reverse()) {
    const reservation = await db
      .prepare(
        `INSERT INTO processed_messages (user_id, rule_id, gmail_message_id, processed_at)
         VALUES (?, ?, ?, ?) ON CONFLICT(user_id, rule_id, gmail_message_id) DO NOTHING`,
      )
      .bind(userId, rule.id, message.id, new Date().toISOString())
      .run();
    if (!Number(reservation.meta?.changes || 0)) {
      skipped += 1;
      continue;
    }
    try {
      const extracted = rule.fields.map((field) => ({ field, value: extractValue(message.body, field) }));
      const missing = extracted.filter((item) => !item.value);
      let status = "review";
      let errorMessage = missing.length ? `${missing.map((item) => item.field.name).join("、")}を抽出できませんでした` : "";
      if (!missing.length) {
        const row = [sheetTimestamp(), ...sheet.headers.slice(1).map((header) => {
          const match = extracted.find((item) => rule.mappings[String(item.field.id)] === header.label);
          return match?.value || "";
        })];
        if (!row.slice(1).some(Boolean)) {
          errorMessage = "見出しと抽出項目の紐付けを確認してください";
        } else {
          await appendSheetRow(env, userId, rule.spreadsheetId, rule.sheetName, row);
          status = "success";
        }
      }
      await addHistory(db, {
        userId,
        ruleId: rule.id,
        receivedAt: message.receivedAt,
        subject: message.subject,
        extractedCount: extracted.filter((item) => item.value).length,
        destination: `${sheet.spreadsheetName} / ${sheet.sheetName}`,
        status,
        errorMessage,
      });
      if (status === "success") success += 1;
      else review += 1;
    } catch (error) {
      await db
        .prepare("DELETE FROM processed_messages WHERE user_id = ? AND rule_id = ? AND gmail_message_id = ?")
        .bind(userId, rule.id, message.id)
        .run();
      throw error;
    }
  }
  return { success, review, skipped, searched: messages.length };
}

async function activeRulesForUser(env, userId) {
  const result = await requireDb(env)
    .prepare(
      `SELECT id, name, sender, subject_contains, fields_json, spreadsheet_id, spreadsheet_name,
              sheet_name, sheet_headers_json, mappings_json, active, created_at, updated_at
       FROM extraction_rules WHERE user_id = ? AND active = 1 ORDER BY updated_at DESC LIMIT 100`,
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
    .prepare("SELECT user_id, gmail_watch_expires_at FROM google_connections WHERE lower(google_email) = ?")
    .bind(email)
    .first();
  if (!connection) return new Response(null, { status: 204 });
  const notificationAt = new Date().toISOString();
  await requireDb(env).prepare("UPDATE google_connections SET last_gmail_notification_at = ?, updated_at = ? WHERE user_id = ?")
    .bind(notificationAt, notificationAt, connection.user_id).run();
  await requireDb(env).prepare("INSERT INTO system_events (user_id, event_type, detail, created_at) VALUES (?, 'gmail_push', ?, ?)")
    .bind(connection.user_id, email, notificationAt).run();
  const rules = await activeRulesForUser(env, connection.user_id);
  for (const rule of rules) await processSavedRule(env, connection.user_id, rule);
  if (Number(connection.gmail_watch_expires_at || 0) < Date.now() + 24 * 60 * 60 * 1000) {
    await registerGmailWatch(env, connection.user_id);
  }
  return new Response(null, { status: 204 });
}

async function handleWatchStart(request, env) {
  assertSameOrigin(request);
  const user = await requireAuthorizedUser(request, env);
  if (!gmailPushConfigured(env)) throw new HttpError(503, "先にPub/Subの接続設定が必要です。", "gmail_push_not_configured");
  const watch = await registerGmailWatch(env, user.id);
  return json({ ok: true, expiration: Number(watch?.expiration || 0) });
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
  const todays = rows.filter((row) => row.createdAt.startsWith(today));
  const months = rows.filter((row) => row.createdAt.startsWith(month));
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
  ).bind(visitorId, category, pain, currentProcess, desiredOutcome, contactEmail, new Date().toISOString()).run();
  return json({ ok: true });
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
    db.prepare("SELECT id, category, pain, current_process, desired_outcome, contact_email, status, created_at FROM feedback_requests ORDER BY created_at DESC LIMIT 100").all(),
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
  if (method === "GET" && url.pathname === "/api/gmail/messages") return handleGmailMessages(request, env);
  if (method === "GET" && url.pathname === "/api/gmail/push/config") return handlePushConfig(request, env);
  if (method === "POST" && url.pathname === "/api/gmail/watch") return handleWatchStart(request, env);
  if (method === "POST" && url.pathname === "/api/webhooks/gmail") return handleGmailWebhook(request, env);
  if (method === "POST" && url.pathname === "/api/webhooks/gmail/renew") return handleWatchRenewAll(request, env);
  if (method === "POST" && url.pathname === "/api/sheets/inspect") return handleSheetInspect(request, env);
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

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      if (url.pathname.startsWith("/api/")) return await routeApi(request, env);
      return await serveApp(request, env);
    } catch (error) {
      if (error instanceof HttpError) return apiError(error.message, error.status, error.code, error.details);
      console.error("Unhandled worker error", error);
      return apiError("処理中に問題が発生しました。時間を置いて再度お試しください。", 500, "internal_error");
    }
  },
};
