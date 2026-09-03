import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({
  appType: "custom",
  configFile: false,
  root,
  resolve: { alias: { "@": root } },
  server: { middlewareMode: true },
});

after(async () => {
  await vite.close();
});

test("extracts values with the default natural-language rules", async () => {
  const { extractValue, initialRules, sampleEmail } = await vite.ssrLoadModule("/lib/extraction.ts");
  assert.deepEqual(
    initialRules.map((rule) => extractValue(sampleEmail, rule)),
    ["山田 太郎", "営業スタッフ", "2026/09/02 10:42", "090-1234-5678"],
  );
});

test("supports every MVP extraction method", async () => {
  const { extractValue } = await vite.ssrLoadModule("/lib/extraction.ts");
  const body = "注文番号：1042\n金額：¥12,800\n期間：[開始]9月2日 10:42[終了]\nメール：hello@example.com\n電話：03-1234-5678";
  const base = { id: 1, name: "test", start: "", end: "", pattern: "" };

  assert.equal(extractValue(body, { ...base, method: "after", start: "注文番号：" }), "1042");
  assert.equal(extractValue(body, { ...base, method: "between", start: "[開始]", end: "[終了]" }), "9月2日 10:42");
  assert.equal(extractValue(body, { ...base, method: "number", start: "注文番号：" }), "1042");
  assert.equal(extractValue(body, { ...base, method: "money", start: "金額：" }), "¥12,800");
  assert.equal(extractValue(body, { ...base, method: "date", start: "期間：[開始]" }), "9月2日 10:42");
  assert.equal(extractValue(body, { ...base, method: "email", start: "メール：" }), "hello@example.com");
  assert.equal(extractValue(body, { ...base, method: "phone", start: "電話：" }), "03-1234-5678");
  assert.equal(extractValue(body, { ...base, method: "regex", pattern: "注文番号：(\\d+)" }), "1042");
});

test("returns a visible failure state for missing or invalid rules", async () => {
  const { extractValue } = await vite.ssrLoadModule("/lib/extraction.ts");
  const base = { id: 1, name: "test", end: "", pattern: "" };
  assert.equal(extractValue("氏名：山田", { ...base, method: "after", start: "電話：" }), "");
  assert.equal(extractValue("氏名：山田", { ...base, method: "regex", start: "", pattern: "[" }), "");
});

test("detects fields in varied mail layouts without user-written regex", async () => {
  const { detectFields, extractValue } = await vite.ssrLoadModule("/lib/extraction.ts");
  const samples = [
    ["◇氏名：鈴木 一郎\n◇電話番号：080-9876-5432", "氏名", "鈴木 一郎"],
    ["[氏名] 伊藤 結衣\n[電話番号] 03-1234-5678", "氏名", "伊藤 結衣"],
    ['{\n  "applicant_name": "中村 裕太",\n  "applicant_email": "nakamura@example.com"\n}', "applicant_name", "中村 裕太"],
    ["応募日,氏名,年齢\n2026/09/02,佐藤健一,34歳", "氏名", "佐藤健一"],
    ["氏　名：山田　太郎\n電 話 番 号：090-1111-2222", "氏 名", "山田　太郎"],
    ["* **名前**: 高橋 営業\n* **年齢**: 29", "名前", "高橋 営業"],
    ["■氏名 ＝＞ 加藤 恵\n■年齢 ＝＞ 24歳", "氏名", "加藤 恵"],
    ["<div>【お名前】</div><div>鈴木 さくら</div>", "お名前", "鈴木 さくら"],
  ];
  for (const [body, name, expected] of samples) {
    const field = detectFields(body).find((item) => item.name === name);
    assert.ok(field, `${name} should be detected`);
    assert.equal(extractValue(body, field.rule), expected);
  }

  const qa = "Q1. 希望する雇用形態を教えてください。\n回答：[ 正社員 ]\n\nQ2. 夜勤は可能ですか？\n回答：[ 土日のみ可能 ]";
  const qaFields = detectFields(qa).filter((item) => item.name.startsWith("Q"));
  assert.equal(qaFields.length, 2);
  assert.equal(extractValue(qa, qaFields[1].rule), "土日のみ可能");

  const longText = "【志望理由】\n1行目です。\n2行目です。\n\n━━━━━━━━━━\n※自動送信です";
  const motivation = detectFields(longText).find((item) => item.name === "志望理由");
  assert.ok(motivation);
  assert.equal(extractValue(longText, motivation.rule).trim(), "1行目です。\n2行目です。");
});

test("turns selected sample text into a reusable extraction rule", async () => {
  const { ruleFromSelection, extractValue } = await vite.ssrLoadModule("/lib/extraction.ts");
  const inline = ruleFromSelection("氏名：山田 太郎\n電話：090-1111-2222", "山田 太郎", 8);
  assert.ok(inline);
  assert.equal(inline.suggestedName, "氏名");
  assert.equal(extractValue("氏名：佐藤 花子\n電話：080-2222-3333", inline.rule), "佐藤 花子");

  const block = ruleFromSelection("【お名前】\n吉田 健太\n\n【志望理由】\n応募します", "吉田 健太", 9);
  assert.ok(block);
  assert.equal(block.suggestedName, "お名前");
  assert.equal(extractValue("【お名前】\n鈴木 一郎\n\n【志望理由】\n経験があります", block.rule), "鈴木 一郎");

  const flattened = ruleFromSelection(
    "【氏名】 山田 太郎【フリガナ】 ヤマダ タロウ【生年月日】 1996年04月15日",
    "山田 太郎",
    10,
  );
  assert.ok(flattened);
  assert.equal(flattened.suggestedName, "氏名");
  assert.equal(
    extractValue("【氏名】 佐藤 花子【フリガナ】 サトウ ハナコ【生年月日】 1999年12月01日", flattened.rule),
    "佐藤 花子",
  );

  const decorated = ruleFromSelection("◇氏　名：山田 太郎｜電話：090-1111-2222", "山田 太郎", 11);
  assert.ok(decorated);
  assert.equal(extractValue("◇氏 名：高橋 美咲｜電話：080-9999-8888", decorated.rule), "高橋 美咲");
});

test("ships the complete LP and interactive app prototype", async () => {
  const page = await readFile(path.join(root, "app", "page.tsx"), "utf8");
  for (const copy of [
    "Gmailに届いたら",
    "対象メールを決める",
    "取得項目を自由に指定",
    "抽出項目名（自由入力）",
    "新規作成",
    "用途別の例から始めて",
    "問い合わせ",
    "注文",
    "予約",
    "請求",
    "出力先をつなぐ",
    "このメールでテストする",
    "処理履歴",
    "Google OAuth 2.0",
    "Gmail・Google Sheetsを利用できます",
    "Googleでログイン",
    "操作イメージはこちら",
    "ログイン後は、あと2ステップ",
    "公開LPの閲覧",
    "現在、何に困っていますか？",
    "GOOGLE_CLIENT_SECRET",
    "Gmailの受信が",
    "Indeed / engage / type",
    "BASE / STORES / Shopify",
    "本文中の値をドラッグして選択",
    "この文字を取得項目にする",
  ]) {
    assert.match(page, new RegExp(copy));
  }
  assert.match(page, /path\.startsWith\("\/app"\)/);
  assert.doesNotMatch(page, />ログイン <span>→<\/span>/);
  assert.doesNotMatch(page, /signin-with-chatgpt/);
  assert.match(page, /Dashboard/);
  assert.match(page, /Connections/);
  assert.match(page, /Settings/);
});

test("keeps the high-fidelity editorial design system and mobile layouts", async () => {
  const css = await readFile(path.join(root, "app", "globals.css"), "utf8");
  assert.match(css, /--paper:\s*#f3f0e7/);
  assert.match(css, /--blue:\s*#101fa6/);
  assert.match(css, /--red:\s*#ff3345/);
  assert.match(css, /\.orbital-nav\s*\{/);
  assert.match(css, /\.story-ribbon/);
  assert.match(css, /border-radius:\s*50%/);
  assert.match(css, /@media \(max-width: 700px\)/);
  assert.match(css, /\.app-mobile-nav/);
  assert.match(css, /prefers-reduced-motion/);
  assert.doesNotMatch(css, /#7c3aed|#8b5cf6|neon/i);
});

test("build output has Japanese metadata and direct app routing", async () => {
  const html = await readFile(path.join(root, "dist", "client", "index.html"), "utf8");
  const redirects = await readFile(path.join(root, "dist", "client", "_redirects"), "utf8");
  const worker = await readFile(path.join(root, "dist", "server", "index.js"), "utf8");
  const hosting = JSON.parse(await readFile(path.join(root, "dist", ".openai", "hosting.json"), "utf8"));
  assert.match(html, /<html lang="ja">/);
  assert.match(html, /<title>MAILSHEET \| メールからGoogle Sheetsへ自動反映<\/title>/);
  assert.match(html, /<div id="root"><\/div>/);
  assert.match(html, /type="module"/);
  assert.equal(redirects.trim(), "/* /index.html 200");
  assert.doesNotMatch(html, /0\.1秒イントロ|YouTube/);
  assert.match(worker, /\/api\/oauth\/google\/callback/);
  assert.match(worker, /\/api\/gmail\/messages/);
  assert.match(worker, /\/api\/sheets\/test/);
  assert.equal(hosting.d1, "DB");
  assert.equal(hosting.static, undefined);
});

test("server API reports OAuth readiness without exposing secrets", async () => {
  const { default: worker } = await import(path.join(root, "worker", "index.js"));
  const request = new Request("http://localhost/api/auth/status");
  const response = await worker.fetch(request, {});
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.configured, false);
  assert.equal(payload.connected, false);
  assert.equal(payload.callbackUrl, "http://localhost/api/oauth/google/callback");
  assert.equal(payload.gmailPushConfigured, false);
  assert.equal(payload.gmailWatchActive, false);
  assert.equal(payload.access.allowed, true);
  assert.equal(JSON.stringify(payload).includes("CLIENT_SECRET"), false);
});

test("ships inspected D1 migrations for connections, rules and history", async () => {
  const migration = await readFile(path.join(root, "drizzle", "0000_kind_whizzer.sql"), "utf8");
  const headerMigration = await readFile(path.join(root, "drizzle", "0001_condemned_wild_child.sql"), "utf8");
  for (const table of ["google_connections", "extraction_rules", "processing_history", "processed_messages"]) {
    assert.match(migration, new RegExp("CREATE TABLE `" + table + "`"));
  }
  assert.match(headerMigration, /ADD `sheet_headers_json` text DEFAULT '\[\]' NOT NULL/);
  const watchMigration = await readFile(path.join(root, "drizzle", "0002_gmail_watch.sql"), "utf8");
  assert.match(watchMigration, /gmail_watch_expires_at/);
  const adminMigration = await readFile(path.join(root, "drizzle", "0003_admin_console.sql"), "utf8");
  assert.match(adminMigration, /CREATE TABLE `app_users`/);
  assert.match(adminMigration, /CREATE TABLE `access_events`/);
  assert.match(adminMigration, /last_gmail_notification_at/);
});

test("ships Gmail push webhook, watch registration and renewal routes", async () => {
  const worker = await readFile(path.join(root, "worker", "index.js"), "utf8");
  assert.match(worker, /\/api\/webhooks\/gmail/);
  assert.match(worker, /\/api\/webhooks\/gmail\/renew/);
  assert.match(worker, /\/api\/gmail\/watch/);
  assert.match(worker, /\/api\/gmail\/push\/config/);
  assert.match(worker, /GMAIL_API}\/watch/);
  assert.match(worker, /processSavedRule/);
  assert.match(worker, /Array\.isArray\(searchResult\?\.messages\)/);
  assert.match(worker, /duplicate_rule/);
  assert.match(worker, /handleRuleDelete/);
  assert.match(worker, /function sheetTimestamp/);
  assert.match(worker, /sheet\.headers\.slice\(1\)/);
  assert.match(worker, /ON CONFLICT\(user_id, rule_id, gmail_message_id\) DO NOTHING/);
  assert.match(worker, /reservation\.meta\?\.changes/);
  assert.match(worker, /mapping_incomplete/);
  assert.match(worker, /last_processed_at/);
  const page = await readFile(path.join(root, "app", "page.tsx"), "utf8");
  assert.match(page, /Pub\/Sub設定URLを表示/);
  assert.match(page, /毎日のwatch更新URL/);
  assert.match(page, /保存済みルール管理/);
  assert.match(page, /差出人（From）で探す/);
  assert.match(page, /件名で探す/);
  assert.match(page, /一致メールを手動で転記/);
  assert.match(page, /入力が終わると自動確認します/);
  assert.doesNotMatch(page, /正規表現を直接入力/);
  assert.doesNotMatch(page, /自動追加をONにして保存/);
  assert.match(page, /A列へ自動入力/);
  assert.match(page, /A列は「転記日時」専用です/);
  assert.match(page, /設定不足/);
  assert.match(page, /このルールは実行されません/);
});

test("keeps Gmail fallback search within the Worker subrequest budget", async () => {
  const worker = await readFile(path.join(root, "worker", "index.js"), "utf8");
  assert.match(worker, /recentParams = new URLSearchParams\(\{ maxResults: "20" \}\)/);
  assert.doesNotMatch(worker, /recentParams = new URLSearchParams\(\{ maxResults: "50" \}\)/);
  assert.match(worker, /google_reconnect_required/);
  assert.match(worker, /function decodeMimeHeader/);
  assert.match(worker, /cleanSender\.includes\("@"\)/);
});

test("expires login after seven idle days and refreshes active sessions", async () => {
  const worker = await readFile(path.join(root, "worker", "index.js"), "utf8");
  const page = await readFile(path.join(root, "app", "page.tsx"), "utf8");
  assert.match(worker, /SESSION_IDLE_SECONDS = 7 \* 24 \* 60 \* 60/);
  assert.match(worker, /refreshSession/);
  assert.match(page, /最後の操作から7日間アクセスがない場合/);
});

test("serves client routes without redirecting them to the landing page", async () => {
  const worker = await readFile(path.join(root, "worker", "index.js"), "utf8");
  assert.match(worker, /const isClientRoute/);
  assert.match(worker, /isClientRoute\s*\?\s*await env\.ASSETS\.fetch/);
  assert.match(worker, /new URL\("\/", request\.url\)/);
});
