import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
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

async function encryptedTestToken(value, secret) {
  const secretDigest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  const key = await crypto.subtle.importKey("raw", secretDigest, { name: "AES-GCM" }, false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(value));
  return `v1.${Buffer.from(iv).toString("base64url")}.${Buffer.from(cipher).toString("base64url")}`;
}

async function createWorkerTestEnvironment({ failHistoryWrites = 0 } = {}) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE app_users (email TEXT PRIMARY KEY, role TEXT NOT NULL, status TEXT NOT NULL);
    CREATE TABLE google_connections (
      user_id TEXT PRIMARY KEY, google_email TEXT NOT NULL, access_token_enc TEXT NOT NULL,
      refresh_token_enc TEXT, expires_at INTEGER NOT NULL, scopes TEXT NOT NULL,
      gmail_history_id TEXT, gmail_watch_expires_at INTEGER, last_gmail_notification_at TEXT,
      last_watch_renewed_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE processed_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, rule_id INTEGER NOT NULL,
      gmail_message_id TEXT NOT NULL, processed_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX uidx_processed_messages_owner_rule_message
      ON processed_messages (user_id, rule_id, gmail_message_id);
    CREATE TABLE extraction_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, name TEXT NOT NULL,
      sender TEXT NOT NULL, subject_contains TEXT NOT NULL, fields_json TEXT NOT NULL,
      spreadsheet_id TEXT NOT NULL DEFAULT '', spreadsheet_name TEXT NOT NULL DEFAULT '',
      sheet_name TEXT NOT NULL DEFAULT '', sheet_headers_json TEXT NOT NULL DEFAULT '[]',
      mappings_json TEXT NOT NULL DEFAULT '{}', active INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE processing_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, rule_id INTEGER,
      received_at TEXT NOT NULL, subject TEXT NOT NULL, extracted_count INTEGER NOT NULL DEFAULT 0,
      destination TEXT NOT NULL DEFAULT '', status TEXT NOT NULL, error_message TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );
  `);
  const tokenSecret = "test-secret-with-enough-entropy";
  const now = new Date().toISOString();
  sqlite.prepare("INSERT INTO app_users (email, role, status) VALUES (?, 'tester', 'active')")
    .run("local-preview@example.com");
  sqlite.prepare(
    `INSERT INTO google_connections
     (user_id, google_email, access_token_enc, refresh_token_enc, expires_at, scopes, created_at, updated_at)
     VALUES (?, ?, ?, NULL, ?, ?, ?, ?)`,
  ).run(
    "test-user",
    "local-preview@example.com",
    await encryptedTestToken("access-token", tokenSecret),
    Date.now() + 60 * 60_000,
    "gmail.readonly spreadsheets",
    now,
    now,
  );
  let remainingHistoryFailures = failHistoryWrites;
  const DB = {
    prepare(sql) {
      const statement = sqlite.prepare(sql);
      let bound = [];
      const prepared = {
        bind(...values) {
          bound = values;
          return prepared;
        },
        async first() {
          return statement.get(...bound) || null;
        },
        async all() {
          return { results: statement.all(...bound) };
        },
        async run() {
          if (remainingHistoryFailures > 0 && /INSERT INTO processing_history/.test(sql)) {
            remainingHistoryFailures -= 1;
            throw new Error("simulated history failure");
          }
          const result = statement.run(...bound);
          return { meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
        },
      };
      return prepared;
    },
  };
  return {
    sqlite,
    env: {
      DB,
      GOOGLE_CLIENT_ID: "client-id",
      GOOGLE_CLIENT_SECRET: "client-secret",
      TOKEN_ENCRYPTION_KEY: tokenSecret,
    },
  };
}

function safeJsonRule(id = 1) {
  return {
    id,
    name: `転記ルール${id}`,
    sender: "notice@example.com",
    subjectContains: "",
    fields: [{
      id: 1,
      name: "氏名",
      method: "regex",
      start: "",
      end: "",
      pattern: "",
      anchorConfirmed: true,
      locator: { version: 2, kind: "json", path: ["氏名"], jsonType: "string" },
    }],
    spreadsheetId: "sheet_id_1234567890",
    spreadsheetName: "採用管理",
    sheetName: "応募一覧",
    sheetHeaders: [
      { column: "A", label: "転記日時" },
      { column: "B", label: "転記ルール" },
      { column: "C", label: "氏名" },
    ],
    mappings: { 1: "C" },
    active: true,
  };
}

function gmailTestMessage() {
  return {
    id: "gmail_message_123",
    threadId: "thread_123",
    from: "notice@example.com",
    subject: "新しい応募",
    date: "2026-09-04",
    receivedAt: "2026-09-04T00:00:00.000Z",
    snippet: "応募通知",
    body: JSON.stringify({ 氏名: "池田 隼人" }),
  };
}

function installSheetsFetchMock({ failAppend = false, rejectAppendTimes = 0 } = {}) {
  const originalFetch = globalThis.fetch;
  let appendCalls = 0;
  let remainingAppendRejections = rejectAppendTimes;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes(":append")) {
      appendCalls += 1;
      if (failAppend) throw new TypeError("simulated uncertain network response");
      if (remainingAppendRejections > 0) {
        remainingAppendRejections -= 1;
        return new Response(JSON.stringify({ error: { message: "invalid target range" } }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ updates: { updatedRange: "'応募一覧'!A2:C2", updatedRows: 1 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("?fields=properties.title")) {
      return new Response(JSON.stringify({
        properties: { title: "採用管理" },
        sheets: [{ properties: { sheetId: 0, title: "応募一覧", index: 0 } }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.includes("/values/")) {
      return new Response(JSON.stringify({ values: [["転記日時", "転記ルール", "氏名"]] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
  return {
    get appendCalls() { return appendCalls; },
    restore() { globalThis.fetch = originalFetch; },
  };
}

test("extracts values with the default natural-language rules", async () => {
  const { extractValue, initialRules, sampleEmail } = await vite.ssrLoadModule("/lib/extraction.ts");
  assert.deepEqual(
    initialRules.map((rule) => extractValue(sampleEmail, rule)),
    ["山田 太郎", "営業スタッフ", "2026/09/02 10:42", "090-1234-5678"],
  );
});

test("supports bounded extraction methods and stops legacy free-form ranges", async () => {
  const { extractValue, extractValueResult, ruleFromSelection } = await vite.ssrLoadModule("/lib/extraction.ts");
  const body = "注文番号：1042\n金額：¥12,800\n期間：[開始]9月2日 10:42[終了]\n日付：9月2日 10:42\nメール：hello@example.com\n電話：03-1234-5678";
  const base = { id: 1, name: "test", start: "", end: "", pattern: "", anchorConfirmed: true };

  assert.equal(extractValue(body, { ...base, method: "after", start: "注文番号：" }), "1042");
  const legacyRange = extractValueResult(body, { ...base, method: "between", start: "[開始]", end: "[終了]" });
  assert.equal(legacyRange.status, "invalid");
  assert.match(legacyRange.reason, /旧形式|選び直してください/);
  assert.equal(extractValue(body, { ...base, method: "number", start: "注文番号：" }), "1042");
  assert.equal(extractValue(body, { ...base, method: "money", start: "金額：" }), "¥12,800");
  assert.equal(extractValue(body, { ...base, method: "date", start: "日付：" }), "9月2日 10:42");
  assert.equal(extractValue(body, { ...base, method: "email", start: "メール：" }), "hello@example.com");
  assert.equal(extractValue(body, { ...base, method: "phone", start: "電話：" }), "03-1234-5678");
  const automatic = ruleFromSelection(body, "1042", 9, "注文番号", body.indexOf("1042"));
  assert.ok(automatic);
  assert.equal(extractValue(body, automatic.rule), "1042");
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
    ["氏　名：山田　太郎\n電 話 番 号：090-1111-2222", "氏名", "山田　太郎"],
    ["* **名前**: 高橋 営業\n* **年齢**: 29", "名前", "高橋 営業"],
    ["■氏名 ＝＞ 加藤 恵\n■年齢 ＝＞ 24歳", "氏名", "加藤 恵"],
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

test("does not invent reusable fields from unsupported or position-only layouts", async () => {
  const { detectFields, ruleFromSelection } = await vite.ssrLoadModule("/lib/extraction.ts");
  const unsupported = [
    "応募日,氏名,年齢\n2026/09/02,佐藤健一,34歳",
    "<div>【お名前】</div><div>鈴木 さくら</div>",
    "- 池田 隼人\n- 090-1111-2222",
    "池田 隼人\t090-1111-2222",
  ];
  for (const body of unsupported) {
    assert.deepEqual(detectFields(body), [], `unsupported layout must not be guessed: ${body}`);
  }

  const originalBullets = "- 営業部\n- 池田 隼人\n- 東京都";
  const shiftedBullets = "- 新規項目\n- 営業部\n- 池田 隼人\n- 東京都";
  assert.equal(ruleFromSelection(originalBullets, "池田 隼人", 90, "氏名", originalBullets.indexOf("池田 隼人")), null);
  assert.equal(ruleFromSelection(shiftedBullets, "池田 隼人", 91, "氏名", shiftedBullets.indexOf("池田 隼人")), null);
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

  const repeatedValue = "差出人：佐藤\n本文です。\n氏名：佐藤\n電話番号：090-1111-2222";
  const intendedStart = repeatedValue.lastIndexOf("佐藤");
  const intended = ruleFromSelection(repeatedValue, "佐藤", 12, "", intendedStart);
  assert.ok(intended);
  assert.equal(intended.suggestedName, "氏名");
  assert.equal(extractValue("差出人：鈴木\n氏名：高橋\n電話番号：080-2222-3333", intended.rule), "高橋");

  const embeddedBracket = "応募者プロフィールです。 【氏名】 池田 隼人【電話番号】090-1111-2222";
  const embeddedStart = embeddedBracket.indexOf("池田 隼人");
  const embedded = ruleFromSelection(embeddedBracket, "池田 隼人", 13, "", embeddedStart);
  assert.ok(embedded);
  assert.equal(extractValue("案内文が変わりました。 【氏名】 佐藤 花子【電話番号】080-2222-3333", embedded.rule), "佐藤 花子");
});

test("extracts only a uniquely labelled nearby value across harmless mail variations", async () => {
  const { extractValue, extractValueResult } = await vite.ssrLoadModule("/lib/extraction.ts");
  const base = { id: 1, name: "氏名", method: "after", start: "氏名：", end: "", pattern: "" };
  const varied = [
    "氏名: 池田 隼人",
    "[ 氏 名 ]\u3000池田 隼人",
    "**氏名**：池田 隼人",
  ];
  for (const body of varied) assert.match(extractValue(body, base), /^池田(?: |\u3000)隼人$/);
  const kana = { id: 2, name: "フリガナ", method: "after", start: "フリガナ", end: "", pattern: "" };
  assert.equal(
    extractValue("【氏　名】 池田　隼人【フリガナ】 イケダ ハヤト", base, [base, kana]),
    "池田　隼人",
  );

  assert.equal(
    extractValue("応募者名：佐藤 花子", { ...base, aliases: ["お名前", "応募者名"] }),
    "佐藤 花子",
  );
  assert.equal(
    extractValue("差出人：sender@example.com\n応募者メール：applicant@example.com", {
      ...base,
      name: "メールアドレス",
      method: "email",
      start: "メールアドレス",
      aliases: ["応募者メール"],
    }),
    "applicant@example.com",
  );
  assert.equal(
    extractValue("送信日時：2026/09/03 12:00\n【生年月日】1996年04月15日（30歳）", {
      ...base,
      name: "生年月日",
      method: "date",
      start: "生年月日",
    }),
    "1996年04月15日",
  );

  const ambiguous = extractValueResult("氏名：池田 隼人\n氏名：佐藤 花子", base);
  assert.equal(ambiguous.status, "ambiguous");
  assert.equal(ambiguous.value, "");
  assert.match(ambiguous.reason, /複数/);

  const missing = extractValueResult("差出人：sender@example.com", {
    ...base,
    name: "応募者メール",
    method: "email",
    start: "応募者メール",
  });
  assert.equal(missing.status, "missing");
  assert.equal(missing.value, "");

  const unanchored = extractValueResult("sender@example.com", { ...base, method: "email", start: "" });
  assert.equal(unanchored.status, "invalid");
  assert.equal(unanchored.value, "");
});

test("rejects misleading anchors and prevents adjacent fields from being swallowed", async () => {
  const { extractValue, extractValueResult, extractionAnchorMatchesName } = await vite.ssrLoadModule("/lib/extraction.ts");
  const name = { id: 1, name: "氏名", method: "after", start: "氏名", end: "", pattern: "" };
  const phone = { id: 2, name: "電話番号", method: "phone", start: "電話番号", end: "", pattern: "" };

  assert.equal(extractValue("【氏名】：池田 隼人", name), "池田 隼人");
  assert.equal(extractValue("担当者氏名：田中 一郎", name), "");
  assert.equal(extractValue("氏名：\n電話番号：090-1111-2222", name, [name, phone]), "");
  assert.equal(
    extractValue("氏名：池田 隼人\u3000電話番号：090-1111-2222", name, [name, phone]),
    "池田 隼人",
  );
  const unknownInlineBoundary = extractValueResult("氏名：池田 隼人 電話番号：090-1111-2222", name);
  assert.equal(unknownInlineBoundary.status, "invalid");
  assert.match(unknownInlineBoundary.reason, /境界/);
  assert.equal(extractValue("氏名：池田 隼人／電話 番号：090-1111-2222", name, [name, phone]), "池田 隼人");
  assert.equal(extractValueResult("氏名：池田 隼人／電話 番号：090-1111-2222", name).status, "invalid");
  assert.equal(extractValueResult("件名：求人応募 東京：営業職", { ...name, name: "件名", start: "件名" }).status, "invalid");
  assert.equal(extractValueResult("氏名：株式会社【東京】営業部", name).status, "invalid");
  assert.equal(extractValue("氏名は履歴書に記載されています。", name), "");
  assert.equal(extractValueResult("【氏名】\n【電話番号】090-1111-2222", name).status, "invalid");
  assert.equal(extractValueResult("【氏名】池田【氏名】佐藤", name).status, "invalid");
  assert.equal(extractValue("説明：必要項目は【氏名】 と【住所】です", name), "");
  assert.equal(extractValue("説明：必要項目は 【氏名】 と 【住所】です", name), "");
  assert.equal(extractionAnchorMatchesName({ ...name, start: "担当者氏名" }), false);
  assert.equal(extractValue("会社名：㈱ＡＢＣ ①号", { ...name, id: 3, name: "会社名", start: "会社名" }), "㈱ＡＢＣ ①号");
  assert.equal(extractValue("電話番号：09012345678901234567", phone), "");

  const legacyBetween = extractValueResult("説明：求人通知\n終了", {
    ...name,
    name: "説明",
    method: "between",
    start: "説明：",
    end: "終了",
  });
  assert.equal(legacyBetween.status, "invalid");
  assert.equal(legacyBetween.value, "");
  assert.match(legacyBetween.reason, /旧形式|選び直してください/);

  const mismatchedLegacyPaired = extractValueResult("受付番号【A-123】", {
    ...name,
    name: "応募者ID",
    method: "between",
    start: "受付番号【",
    end: "】",
  });
  assert.equal(mismatchedLegacyPaired.status, "invalid");
  assert.equal(mismatchedLegacyPaired.value, "");
  assert.match(mismatchedLegacyPaired.reason, /旧形式|選び直してください/);

  const matchingLegacyPaired = extractValueResult("受付番号【A-123】", {
    ...name,
    name: "受付番号",
    method: "between",
    start: "受付番号【",
    end: "】",
  });
  assert.equal(matchingLegacyPaired.status, "invalid");
  assert.equal(matchingLegacyPaired.value, "");
  assert.equal(extractionAnchorMatchesName({ ...name, name: "受付番号", method: "between", start: "受付番号【", end: "】" }), true);
  assert.equal(extractionAnchorMatchesName({ ...name, name: "応募者ID", method: "between", start: "受付番号【", end: "】" }), false);
  assert.equal(extractValueResult("受付番号【A-123】", {
    ...name,
    name: "応募者ID",
    method: "between",
    start: "受付番号【",
    end: "】",
    anchorConfirmed: false,
  }).status, "invalid");

  const wrongAnchor = extractValueResult("件名：【Indeed】求人通知\n【氏名】池田 隼人", {
    ...name,
    name: "氏名",
    method: "between",
    start: "【Indeed】",
    end: "【氏名】",
  });
  assert.equal(wrongAnchor.status, "invalid");
  assert.match(wrongAnchor.reason, /旧形式|選び直してください/);

  const overwide = extractValueResult("【Indeed】求人通知\n【氏名】池田 隼人\n【電話番号】090-1111-2222\n終了", {
    ...name,
    name: "件名",
    method: "between",
    start: "【Indeed】",
    end: "終了",
    anchorConfirmed: true,
  });
  assert.equal(overwide.status, "invalid");
  assert.match(overwide.reason, /旧形式|選び直してください/);
});

test("verifies selection-generated rules and refuses unsafe regular expressions", async () => {
  const { ruleFromSelection, extractValueResult } = await vite.ssrLoadModule("/lib/extraction.ts");
  const { extractWorkerValueResult } = await import(path.join(root, "worker", "index.js"));
  const ambiguousBody = "氏名：池田\n---\n氏名：佐藤";
  assert.equal(ruleFromSelection(ambiguousBody, "佐藤", 20, "", ambiguousBody.lastIndexOf("佐藤")), null);

  const missingBoundary = "件名：【Indeed】求人への応募（99823）\nIndeed経由で通知します。【氏名】池田 隼人";
  const selected = "求人への応募（99823）";
  const bounded = ruleFromSelection(missingBoundary, selected, 21, "", missingBoundary.indexOf(selected));
  assert.ok(bounded);
  assert.equal(bounded.suggestedName, "件名");
  const nestedSubject = "件名：【Indeed】求人（急募）への応募（77777）\nIndeed経由で通知します。【氏名】佐藤 花子";
  const changedShape = extractValueResult(nestedSubject, bounded.rule);
  assert.equal(changedShape.status, "invalid");
  assert.equal(changedShape.value, "");
  assert.match(changedShape.reason, /括弧・引用符の構造/);
  assert.deepEqual(extractWorkerValueResult(nestedSubject, bounded.rule), changedShape);
  assert.equal(
    extractValueResult("件名：【Indeed】求人への応募（77777）\n前回とは異なる案内文です。【氏名】佐藤 花子", bounded.rule).value,
    "求人への応募（77777）",
  );

  const indeedBody = "件名：【Indeed】求人への応募がありました（営業職 / 求人ID: 99823）\nIndeed経由で以下の応募者情報をご確認ください。";
  const indeedValue = "求人への応募がありました（営業職 / 求人ID: 99823）";
  const indeed = ruleFromSelection(indeedBody, indeedValue, 29, "件名", indeedBody.indexOf(indeedValue));
  assert.ok(indeed);
  const changedIndeed = "件名：【Indeed】求人への応募がありました（開発職 / 求人ID: 77101）\nIndeed経由で以下の応募者情報をご確認ください。";
  assert.equal(extractValueResult(changedIndeed, indeed.rule).value, "求人への応募がありました（開発職 / 求人ID: 77101）");
  assert.equal(extractWorkerValueResult(changedIndeed, indeed.rule).value, "求人への応募がありました（開発職 / 求人ID: 77101）");
  const wrappedExplanation = "件名：【Indeed】これは説明です「求人への応募がありました（開発職 / 求人ID: 77101）」\nIndeed経由で以下の応募者情報をご確認ください。";
  const rejectedExplanation = extractValueResult(wrappedExplanation, indeed.rule);
  assert.equal(rejectedExplanation.status, "invalid");
  assert.equal(rejectedExplanation.value, "");
  assert.match(rejectedExplanation.reason, /括弧・引用符の構造|終わりより後ろ/);
  assert.deepEqual(extractWorkerValueResult(wrappedExplanation, indeed.rule), rejectedExplanation);
  const selectedWithBrand = "【Indeed】求人への応募がありました（営業職 / 求人ID: 99823）";
  const branded = ruleFromSelection(indeedBody, selectedWithBrand, 33, "件名", indeedBody.indexOf(selectedWithBrand));
  assert.ok(branded);
  assert.equal(
    extractValueResult(changedIndeed, branded.rule).value,
    "【Indeed】求人への応募がありました（開発職 / 求人ID: 77101）",
  );

  const forwardedIndeed = `Fw: ｗｗ
"山形 将太" <sender@example.com>
差出人: 山形 将太 <sender@example.com>
送信日時: 2026年9月3日 1:16
宛先: 採用担当 <recruit@example.com>
件名: ｗｗ

件名：【Indeed】求人への応募がありました（営業職 / 求人ID: 99823）
Indeed経由で以下の通り求人への応募がありましたので通知いたします。
【氏名】池田 隼人
【電話番号】090-1111-2222`;
  const fullIndeedSubject = "【Indeed】求人への応募がありました（営業職 / 求人ID: 99823）";
  const forwardedRule = ruleFromSelection(
    forwardedIndeed,
    fullIndeedSubject,
    34,
    "件名",
    forwardedIndeed.lastIndexOf(fullIndeedSubject),
  );
  assert.ok(forwardedRule);
  const changedForwardedIndeed = forwardedIndeed
    .replace("Fw: ｗｗ", "Fw: 採用通知")
    .replace("件名: ｗｗ", "件名: 採用通知")
    .replace(fullIndeedSubject, "【Indeed】求人への応募がありました（商品企画職 / 求人ID: 77101）")
    .replace("池田 隼人", "佐藤 花子");
  const expectedForwardedSubject = "【Indeed】求人への応募がありました（商品企画職 / 求人ID: 77101）";
  assert.equal(extractValueResult(changedForwardedIndeed, forwardedRule.rule).value, expectedForwardedSubject);
  assert.deepEqual(
    extractWorkerValueResult(changedForwardedIndeed, forwardedRule.rule),
    extractValueResult(changedForwardedIndeed, forwardedRule.rule),
  );

  const oneLineSample = "件名：注文A 本文をご確認ください。";
  const oneLine = ruleFromSelection(oneLineSample, "注文A", 30, "件名", oneLineSample.indexOf("注文A"));
  assert.equal(oneLine, null);

  const direct = ruleFromSelection("氏名：池田 隼人", "池田 隼人", 24, "", 3);
  assert.equal(direct, null);

  const rejectedPatterns = [
    "(a+)+$",
    "(?<value>a*a*a*a*a*b)",
    "(?<value>(?:[a]*){1,500})!",
    "(?<value>(?:[a]*)(?:[a]*))!",
    "(?<value>[a]{0,500}[a]{0,500})!",
    "(?<value>[a]*(?:b)?[a]*)!",
    "(?<value>[a]{0,50}[a]{0,50}[a]{0,50}[a]{0,50})b",
    "(?<value>[a]{0,100}\\B[a]{0,100}\\B[a]{0,100}\\B[a]{0,100})b",
    `(?<value>${"a?".repeat(50)}${"a".repeat(50)})!`,
    `(?<value>${"(?:a|aa)".repeat(35)})!`,
    `(?<value>${"[ab]*a".repeat(35)})!`,
    `(?<value>${"\\x61{0,8}".repeat(35)})!`,
  ];
  for (const [index, pattern] of rejectedPatterns.entries()) {
    const client = extractValueResult(`${"a".repeat(2_000)}!`, {
      id: 100 + index,
      name: "旧形式",
      method: "regex",
      start: "",
      end: "",
      pattern,
    });
    const server = extractWorkerValueResult(`${"a".repeat(2_000)}!`, {
      id: 100 + index,
      name: "旧形式",
      method: "regex",
      start: "",
      end: "",
      pattern,
    });
    assert.equal(client.status, "invalid");
    assert.match(client.reason, /選び直してください/);
    assert.deepEqual(server, client);
  }
});

test("detects flattened bracket fields without inventing JSON fields", async () => {
  const { detectFields, extractValueResult } = await vite.ssrLoadModule("/lib/extraction.ts");
  const body = "【氏名】 池田 隼人【フリガナ】 イケダ ハヤト【生年月日】1996年04月15日";
  const fields = detectFields(body);
  assert.deepEqual(fields.map((field) => field.name), ["氏名", "フリガナ", "生年月日"]);
  assert.deepEqual(fields.map((field) => extractValueResult(body, field.rule).value), ["池田 隼人", "イケダ ハヤト", "1996年04月15日"]);

  const json = '{"氏名":"池田 隼人","メール":"ikeda@example.com"}';
  const jsonFields = detectFields(json);
  assert.deepEqual(jsonFields.map((field) => field.name), ["氏名", "メール"]);
  assert.deepEqual(jsonFields.map((field) => field.value), ["池田 隼人", "ikeda@example.com"]);
});

test("uses structured locations across mail variations and fails closed when boundaries change", async () => {
  const { detectFields, extractValueResult, ruleFromSelection } = await vite.ssrLoadModule("/lib/extraction.ts");
  const { extractWorkerValueResult } = await import(path.join(root, "worker", "index.js"));

  const sample = "【氏名】池田 隼人【電話番号】090-1111-2222";
  const automatic = ruleFromSelection(sample, "池田 隼人", 41, "氏名", sample.indexOf("池田 隼人"));
  assert.ok(automatic);
  assert.equal(automatic.rule.locator?.nextLabel, "電話番号");
  assert.equal(automatic.rule.locator?.nextLabelBracketed, true);
  const variations = [
    ["【 氏 名 】 佐藤 花子【 電話 番号 】080-2222-3333", "ok", "佐藤 花子"],
    ["【氏名】【電話番号】080-2222-3333", "invalid", ""],
    ["【氏名】佐藤 花子【住所】東京", "missing", ""],
    ["【氏名】佐藤 花子【部署】開発【電話番号】080-2222-3333", "invalid", ""],
    ["【氏名】佐藤 花子 部署：開発【電話番号】080-2222-3333", "invalid", ""],
    ["【氏名】佐藤【電話番号】080-1111-2222【氏名】鈴木【電話番号】080-2222-3333", "ambiguous", ""],
  ];
  for (const [body, status, value] of variations) {
    const client = extractValueResult(body, automatic.rule);
    assert.equal(client.status, status);
    assert.equal(client.value, value);
    assert.deepEqual(extractWorkerValueResult(body, automatic.rule), client);
  }

  const flat = "氏名：池田 隼人 電話番号：090-1111-2222 メール：ikeda@example.com";
  const flatFields = detectFields(flat);
  assert.deepEqual(flatFields.map((field) => field.name), ["氏名", "電話番号", "メール"]);
  assert.deepEqual(flatFields.map((field) => field.value), ["池田 隼人", "090-1111-2222", "ikeda@example.com"]);

  const unknownBoundary = detectFields("【氏名】池田 隼人【部署コード】TOKYO-1【電話番号】090-1111-2222");
  assert.equal(unknownBoundary.some((field) => field.name === "氏名"), false);
  assert.equal(unknownBoundary.some((field) => field.value.includes("部署コード")), false);

  const proseSample = "【氏名】池田 隼人【電話番号】090-1111-2222";
  const proseSelection = ruleFromSelection(proseSample, "池田 隼人", 42, "氏名", proseSample.indexOf("池田 隼人"));
  assert.ok(proseSelection);
  const proseRule = proseSelection.rule;
  for (const proseTail of [
    "とは応募者の名前です。",
    "は必須です。",
    "を確認してください。",
    "欄には本名を入力してください。",
    "なら省略できます。",
    "という表記を使います。",
  ]) {
    const proseBody = `説明です。【氏名】${proseTail}【電話番号】090-1111-2222`;
    const prose = extractValueResult(proseBody, proseRule);
    assert.equal(prose.status, "invalid", proseBody);
    assert.equal(prose.value, "");
    assert.deepEqual(extractWorkerValueResult(proseBody, proseRule), prose);
    assert.equal(detectFields(proseBody).some((field) => field.name === "氏名"), false);
  }

  const aliasRule = { ...automatic.rule, aliases: ["お名前", "応募者名"] };
  assert.equal(extractValueResult("【お名前】高橋 美咲【電話番号】080-3333-4444", aliasRule).value, "高橋 美咲");
  assert.deepEqual(extractWorkerValueResult("【お名前】高橋 美咲【電話番号】080-3333-4444", aliasRule), extractValueResult("【お名前】高橋 美咲【電話番号】080-3333-4444", aliasRule));

  const qaSample = "Q1. 氏名を入力\n回答：[ 池田 隼人 ]\n\nQ2. 希望色\n回答：[ 青 ]";
  const qaRule = detectFields(qaSample).find((field) => field.name.startsWith("Q1"))?.rule;
  assert.ok(qaRule);
  const qaChanged = "Q1. 氏名を入力\n未回答\n\nQ2. 希望色\n回答：[ 赤 ]";
  assert.equal(extractValueResult(qaChanged, qaRule).status, "missing");
  assert.deepEqual(extractWorkerValueResult(qaChanged, qaRule), extractValueResult(qaChanged, qaRule));
});

test("keeps a typed sent date stable when only labels after its immediate boundary change", async () => {
  const { detectFields, extractValueResult } = await vite.ssrLoadModule("/lib/extraction.ts");
  const { extractWorkerValueResult } = await import(path.join(root, "worker", "index.js"));
  const sample = "送信日時：2026年9月3日 1:16\n宛先：採用担当\n件名：応募通知\n氏名：池田 隼人";
  const field = detectFields(sample).find((item) => item.name === "送信日時");
  assert.ok(field);
  assert.equal(field.rule.locator?.sampleValueType, "date");
  assert.equal(field.rule.locator?.nextLabel, "宛先");
  assert.deepEqual(field.rule.locator?.sampleContextLabels, ["@anchor", "p:宛先", "p:件名", "p:氏名"]);

  const cases = [
    {
      body: "送信日時：2026年9月4日 9:05\n宛先：採用担当\nCc：責任者\n受付番号：A-1\n件名：別の通知",
      status: "ok",
      value: "2026年9月4日 9:05",
      reason: /^$/,
    },
    {
      body: "送信日時：2026年9月4日 9:05\nCc：責任者\n宛先：採用担当\n件名：別の通知",
      status: "invalid",
      value: "",
      reason: /間に別の項目/,
    },
    {
      body: "送信日時：2026年9月4日 9:05\nCc：責任者\n件名：別の通知",
      status: "missing",
      value: "",
      reason: /次の見出し「宛先」が見つかりません/,
    },
    {
      body: "送信日時：2026年9月4日 9:05\n宛先：A\n送信日時：2026年9月5日 10:15\n宛先：B",
      status: "ambiguous",
      value: "",
      reason: /見出し「送信日時」が複数/,
    },
    {
      body: "送信日時：2026年2月30日 25:61\n宛先：採用担当\n件名：通知",
      status: "invalid",
      value: "",
      reason: /値の種類/,
    },
  ];
  for (const { body, status, value, reason } of cases) {
    const client = extractValueResult(body, field.rule);
    assert.equal(client.status, status, body);
    assert.equal(client.value, value, body);
    assert.match(client.reason, reason, body);
    assert.deepEqual(extractWorkerValueResult(body, field.rule), client, body);
  }
});

test("typed extraction never steals a later field value", async () => {
  const { extractValueResult } = await vite.ssrLoadModule("/lib/extraction.ts");
  const { extractWorkerValueResult } = await import(path.join(root, "worker", "index.js"));
  const cases = [
    ["電話番号：未入力／緊急連絡先：090-1234-5678", { name: "電話番号", method: "phone", start: "電話番号" }],
    ["メール：未入力／担当者：admin@example.com", { name: "メール", method: "email", start: "メール" }],
    ["生年月日：未入力／受付日時：2026/09/03", { name: "生年月日", method: "date", start: "生年月日" }],
    ["金額：未入力／参考価格：12,800円", { name: "金額", method: "money", start: "金額" }],
    ["注文番号：未入力／商品数：3", { name: "注文番号", method: "number", start: "注文番号" }],
  ];
  for (const [body, partial] of cases) {
    const rule = { id: 1, end: "", pattern: "", ...partial };
    const client = extractValueResult(body, rule);
    assert.equal(client.status, "invalid");
    assert.equal(client.value, "");
    assert.deepEqual(extractWorkerValueResult(body, rule), client);
  }
});

test("keeps a wrapped multiline address bounded by the next labelled field", async () => {
  const { extractValueResult, extractionLocatorIsSafe, ruleFromSelection } = await vite.ssrLoadModule("/lib/extraction.ts");
  const { extractWorkerValueResult } = await import(path.join(root, "worker", "index.js"));
  const sample = "住所：東京都品川区北品川1-2-3\n電話番号：090-1111-2222";
  const sampleAddress = "東京都品川区北品川1-2-3";
  const selected = ruleFromSelection(sample, sampleAddress, 59, "住所", sample.indexOf(sampleAddress));
  assert.ok(selected);
  assert.equal(selected.rule.locator?.version, 2);
  assert.equal(extractionLocatorIsSafe(selected.rule.locator), true);
  assert.equal(selected.rule.locator?.nextLabel, "電話番号");
  assert.equal(selected.rule.locator?.nextLabelBracketed, false);
  assert.equal(selected.rule.locator?.lineEnd, undefined);

  const wrappedBody = "住所：大阪府大阪市北区梅田\n1-2-3 サンプルマンション504号室\n電話番号：080-2222-3333";
  const client = extractValueResult(wrappedBody, selected.rule);
  assert.equal(client.status, "ok");
  assert.equal(client.value, "大阪府大阪市北区梅田\n1-2-3 サンプルマンション504号室");
  assert.deepEqual(extractWorkerValueResult(wrappedBody, selected.rule), client);
});

test("keeps client and Worker fail-closed behavior in parity for long mail bodies", async () => {
  const { extractValueResult, ruleFromSelection } = await vite.ssrLoadModule("/lib/extraction.ts");
  const { extractWorkerValueResult } = await import(path.join(root, "worker", "index.js"));
  const sample = "【氏名】池田 隼人【電話番号】090-1111-2222";
  const selected = ruleFromSelection(sample, "池田 隼人", 60, "氏名", sample.indexOf("池田 隼人"));
  assert.ok(selected);

  const longBody = `${"これは通常の案内文です。\n".repeat(12_000)}【氏名】佐藤 花子【電話番号】080-2222-3333`;
  assert.ok(longBody.length < 200_000);
  const client = extractValueResult(longBody, selected.rule);
  assert.equal(client.status, "ok");
  assert.equal(client.value, "佐藤 花子");
  assert.deepEqual(extractWorkerValueResult(longBody, selected.rule), client);

  const overLimit = "案".repeat(200_001);
  const oversizedClient = extractValueResult(overLimit, selected.rule);
  assert.equal(oversizedClient.status, "invalid");
  assert.match(oversizedClient.reason, /本文が長すぎる/);
  assert.deepEqual(extractWorkerValueResult(overLimit, selected.rule), oversizedClient);
});

test("requires safe v2 locators and rejects legacy or malformed locator payloads", async () => {
  const { extractValueResult, extractionLocatorIsSafe, ruleFromSelection } = await vite.ssrLoadModule("/lib/extraction.ts");
  const { extractWorkerValueResult } = await import(path.join(root, "worker", "index.js"));
  const body = "【氏名】池田 隼人【電話番号】090-1111-2222";
  const generated = ruleFromSelection(body, "池田 隼人", 70, "氏名", body.indexOf("池田 隼人"));
  assert.ok(generated);
  assert.equal(generated.rule.locator?.version, 2);
  assert.equal(extractionLocatorIsSafe(generated.rule.locator), true);
  const validLocator = generated.rule.locator;
  assert.ok(validLocator);

  const legacyLocator = {
    version: 1,
    kind: "label",
    label: "氏名",
    bracketed: true,
    lineEnd: true,
    sampleBracketCount: 0,
    samplePlainLabelCount: 0,
  };
  assert.equal(extractionLocatorIsSafe(legacyLocator), false);
  const legacyRule = { id: 71, name: "氏名", method: "regex", start: "", end: "", pattern: "", locator: legacyLocator };
  const legacyClient = extractValueResult(body, legacyRule);
  assert.equal(legacyClient.status, "invalid");
  assert.match(legacyClient.reason, /旧形式|選び直してください/);
  assert.deepEqual(extractWorkerValueResult(body, legacyRule), legacyClient);

  const malformedLocators = [
    [],
    { ...validLocator, version: "1" },
    { version: 1, kind: "bullet", bulletIndex: 0 },
    { ...validLocator, label: 123 },
    { ...validLocator, lineEnd: "true" },
    { ...validLocator, bracketed: false, includeLabel: true },
    { ...validLocator, label: "氏名\n電話番号" },
    { ...validLocator, sampleBracketCount: -1 },
    { ...validLocator, samplePlainLabelCount: "0" },
    { ...validLocator, sampleContextLabels: undefined },
    { ...validLocator, sampleContextLabels: ["@anchor", "x:電話番号"] },
    { ...validLocator, sampleContextLabels: ["@anchor", `b:${"長".repeat(101)}`] },
    { version: 1, kind: "block", heading: "■氏名" },
    { version: 1, kind: "json", key: "氏名\n電話番号" },
    { version: 1, kind: "qa", question: ["Q1. 氏名"] },
  ];
  for (const locator of malformedLocators) {
    const rule = { id: 72, name: "氏名", method: "regex", start: "", end: "", pattern: "", locator };
    const client = extractValueResult(body, rule);
    assert.equal(client.status, "invalid", JSON.stringify(locator));
    assert.deepEqual(extractWorkerValueResult(body, rule), client);
  }

  const malformedAliases = [
    "応募者名",
    [123],
    [""],
    ["応募者名\n氏名"],
    Array.from({ length: 11 }, (_, index) => `別名${index}`),
  ];
  for (const aliases of malformedAliases) {
    const rule = { id: 73, name: "氏名", method: "regex", start: "", end: "", pattern: "", locator: validLocator, aliases };
    const client = extractValueResult(body, rule);
    assert.equal(client.status, "invalid", JSON.stringify(aliases));
    assert.match(client.reason, /別の見出し/);
    assert.deepEqual(extractWorkerValueResult(body, rule), client);
  }
});

test("validates phone digit counts and real calendar dates", async () => {
  const { extractValueResult } = await vite.ssrLoadModule("/lib/extraction.ts");
  const { extractWorkerValueResult } = await import(path.join(root, "worker", "index.js"));
  const phone = { id: 1, name: "電話番号", method: "phone", start: "電話番号", end: "", pattern: "" };
  const date = { id: 2, name: "日付", method: "date", start: "日付", end: "", pattern: "" };
  assert.equal(extractValueResult("電話番号：09-03-2026", phone).status, "invalid");
  assert.equal(extractValueResult("電話番号：01-2-345", phone).status, "invalid");
  assert.equal(extractValueResult("電話番号：090-1234-5678", phone).value, "090-1234-5678");
  assert.equal(extractValueResult("日付：2026/99/99", date).status, "invalid");
  assert.equal(extractValueResult("日付：2024/02/29", date).value, "2024/02/29");
  for (const [body, rule] of [["電話番号：09-03-2026", phone], ["電話番号：090-1234-5678", phone], ["日付：2026/99/99", date], ["日付：2024/02/29", date]]) {
    assert.deepEqual(extractWorkerValueResult(body, rule), extractValueResult(body, rule));
  }
});

test("refuses ambiguous generated regex matches and keeps Worker extraction in parity", async () => {
  const { extractValueResult, ruleFromSelection } = await vite.ssrLoadModule("/lib/extraction.ts");
  const { extractWorkerValueResult } = await import(path.join(root, "worker", "index.js"));
  const selectedSample = "氏名：池田 隼人\n電話番号：090-1111-2222";
  const selectedName = ruleFromSelection(selectedSample, "池田 隼人", 3, "氏名", selectedSample.indexOf("池田 隼人"));
  assert.ok(selectedName);
  assert.equal(selectedName.rule.locator?.version, 2);
  const cases = [
    {
      body: "【氏　名】 池田　隼人【フリガナ】 イケダ ハヤト",
      rule: { id: 1, name: "氏名", method: "after", start: "氏名：", end: "", pattern: "" },
    },
    {
      body: "応募者名：佐藤 花子",
      rule: { id: 2, name: "氏名", method: "after", start: "氏名", aliases: ["応募者名"], end: "", pattern: "" },
    },
    {
      body: "氏名：池田 隼人\n氏名：佐藤 花子",
      rule: selectedName.rule,
    },
    {
      body: "メールアドレス：未入力",
      rule: { id: 4, name: "メールアドレス", method: "email", start: "メールアドレス", end: "", pattern: "" },
    },
  ];
  for (const item of cases) {
    assert.deepEqual(extractWorkerValueResult(item.body, item.rule), extractValueResult(item.body, item.rule));
  }
  const ambiguous = extractValueResult(cases[2].body, cases[2].rule);
  assert.equal(ambiguous.status, "ambiguous");
  assert.equal(ambiguous.value, "");
});

test("requires a currency marker when other numbers share a money field", async () => {
  const { extractValue, extractValueResult } = await vite.ssrLoadModule("/lib/extraction.ts");
  const rule = { id: 1, name: "金額", method: "money", start: "金額", end: "", pattern: "" };
  assert.equal(extractValue("金額：商品2点 合計 ¥12,800", rule), "¥12,800");
  assert.equal(extractValue("金額：12,800円", rule), "12,800円");
  assert.equal(extractValue("金額：12,800", rule), "12,800");
  assert.equal(extractValueResult("金額：商品2点 合計 12800", rule).status, "invalid");
});

test("does not create unbounded line-end or suffix rules for free text", async () => {
  const { extractionLocatorIsSafe, ruleFromSelection } = await vite.ssrLoadModule("/lib/extraction.ts");
  const lineSample = "件名：求人への応募";
  assert.equal(ruleFromSelection(lineSample, "求人への応募", 120, "件名", lineSample.indexOf("求人への応募")), null);

  const suffixSample = "件名：注文A 本文をご確認ください。";
  assert.equal(ruleFromSelection(suffixSample, "注文A", 121, "件名", suffixSample.indexOf("注文A")), null);

  const unsafeTextLine = {
    version: 2,
    kind: "label",
    label: "件名",
    lineEnd: true,
    sampleBracketCount: 0,
    samplePlainLabelCount: 0,
    sampleBracketLabels: [],
    samplePlainLabels: [],
    sampleDelimiterShape: [],
    sampleValueType: "text",
    sampleContextLabels: ["@anchor"],
  };
  assert.equal(extractionLocatorIsSafe(unsafeTextLine), false);
  assert.equal(extractionLocatorIsSafe({ ...unsafeTextLine, lineEnd: undefined, suffix: "本文をご確認ください。" }), false);
});

test("preserves the shape of a selected phone value", async () => {
  const { extractValueResult, ruleFromSelection } = await vite.ssrLoadModule("/lib/extraction.ts");
  const { extractWorkerValueResult } = await import(path.join(root, "worker", "index.js"));
  const sample = "電話番号：090-1111-2222";
  const selected = ruleFromSelection(sample, "090-1111-2222", 121, "電話番号", sample.indexOf("090-1111-2222"));
  assert.ok(selected);

  const changedPhone = extractValueResult("電話番号：080-2222-3333", selected.rule);
  assert.equal(changedPhone.status, "ok");
  assert.equal(changedPhone.value, "080-2222-3333");

  const unavailable = extractValueResult("電話番号：連絡不可", selected.rule);
  assert.equal(unavailable.status, "invalid");
  assert.equal(unavailable.value, "");
  assert.deepEqual(extractWorkerValueResult("電話番号：連絡不可", selected.rule), unavailable);
});

test("does not learn positional fields from reorderable JSON arrays", async () => {
  const { detectFields, extractValueResult } = await vite.ssrLoadModule("/lib/extraction.ts");
  const { extractWorkerValueResult } = await import(path.join(root, "worker", "index.js"));
  const sample = JSON.stringify({
    applicants: [
      { id: "A-1", name: "池田 隼人" },
      { id: "B-2", name: "佐藤 花子" },
    ],
  });
  assert.deepEqual(detectFields(sample), []);

  const legacyPositionRule = {
    id: 122,
    name: "name",
    method: "regex",
    start: "",
    end: "",
    pattern: "",
    locator: { version: 1, kind: "json", path: ["applicants", "0", "name"] },
  };
  const reordered = JSON.stringify({
    applicants: [
      { id: "B-2", name: "佐藤 花子" },
      { id: "A-1", name: "池田 隼人" },
    ],
  });
  const client = extractValueResult(reordered, legacyPositionRule);
  assert.equal(client.status, "invalid");
  assert.equal(client.value, "");
  assert.deepEqual(extractWorkerValueResult(reordered, legacyPositionRule), client);
});

test("rejects newly inserted fields that use a single equals separator", async () => {
  const { extractValueResult, ruleFromSelection } = await vite.ssrLoadModule("/lib/extraction.ts");
  const { extractWorkerValueResult } = await import(path.join(root, "worker", "index.js"));
  const sample = "氏名：池田 隼人／電話番号：090-1111-2222";
  const selected = ruleFromSelection(sample, "池田 隼人", 123, "氏名", sample.indexOf("池田 隼人"));
  assert.ok(selected);

  for (const separator of ["=", "＝"]) {
    const body = `氏名：佐藤 花子／部署${separator}営業／電話番号：080-2222-3333`;
    const client = extractValueResult(body, selected.rule);
    assert.equal(client.status, "invalid", separator);
    assert.equal(client.value, "", separator);
    assert.deepEqual(extractWorkerValueResult(body, selected.rule), client, separator);
  }
});

test("fails closed for missing, unbalanced, and prose-like QA answers", async () => {
  const { detectFields, extractValueResult } = await vite.ssrLoadModule("/lib/extraction.ts");
  const { extractWorkerValueResult } = await import(path.join(root, "worker", "index.js"));
  const sample = "Q1. 氏名を入力\n回答：[ 池田 隼人 ]";
  const rule = detectFields(sample).find((field) => field.rule.locator?.kind === "qa")?.rule;
  assert.ok(rule);

  const cases = [
    ["Q1. 氏名を入力\n回答：[ ]", "missing"],
    ["Q1. 氏名を入力\n回答：[ 未入力 ]", "invalid"],
    ["Q1. 氏名を入力\n回答：[ 佐藤 花子", "invalid"],
    ["Q1. 氏名を入力\n回答：佐藤 花子 ]", "invalid"],
    ["Q1. 氏名を入力\n回答：[ 氏名を入力してください。 ]", "invalid"],
    ["Q1. 氏名を入力\n回答：[ 古い回答 ]\n回答：[ 正しい回答 ]", "ambiguous"],
    ["Q1. 氏名を入力\n注記\n回答：[ 佐藤 花子 ]", "missing"],
  ];
  for (const [body, expectedStatus] of cases) {
    const client = extractValueResult(body, rule);
    assert.equal(client.status, expectedStatus, body);
    assert.equal(client.value, "", body);
    assert.deepEqual(extractWorkerValueResult(body, rule), client, body);
    assert.equal(detectFields(body).some((field) => field.rule.locator?.kind === "qa"), false, body);
  }
});

test("uses only the immediate boundary and never returns an empty include-label value", async () => {
  const { extractValueResult, ruleFromSelection } = await vite.ssrLoadModule("/lib/extraction.ts");
  const { extractWorkerValueResult } = await import(path.join(root, "worker", "index.js"));
  const sample = "【氏名】池田 隼人【電話番号】090-1111-2222";
  const selected = ruleFromSelection(sample, "池田 隼人", 124, "氏名", sample.indexOf("池田 隼人"));
  assert.ok(selected);
  assert.deepEqual(selected.rule.locator?.sampleContextLabels, ["@anchor", "b:電話番号"]);
  const changedStructure = "【氏名】佐藤 花子【電話番号】080-2222-3333【携帯番号】090-1111-2222";
  const client = extractValueResult(changedStructure, selected.rule);
  assert.equal(client.status, "ok");
  assert.equal(client.value, "佐藤 花子");
  assert.deepEqual(extractWorkerValueResult(changedStructure, selected.rule), client);

  const brandedSample = "【Indeed】求人通知【氏名】池田 隼人";
  const branded = ruleFromSelection(brandedSample, "【Indeed】求人通知", 125, "件名", 0);
  assert.ok(branded);
  const empty = extractValueResult("【Indeed】【氏名】佐藤 花子", branded.rule);
  assert.equal(empty.status, "invalid");
  assert.equal(empty.value, "");
  assert.deepEqual(extractWorkerValueResult("【Indeed】【氏名】佐藤 花子", branded.rule), empty);
});

test("strips standard quote prefixes from wrapped values in sample and runtime mail", async () => {
  const { extractValueResult, ruleFromSelection } = await vite.ssrLoadModule("/lib/extraction.ts");
  const { extractWorkerValueResult } = await import(path.join(root, "worker", "index.js"));
  const quotedSample = "> 住所：東京都品川区\n> 1-2-3\n> 電話番号：090-1111-2222";
  const selectedText = "東京都品川区\n> 1-2-3";
  const selected = ruleFromSelection(quotedSample, selectedText, 126, "住所", quotedSample.indexOf("東京都"));
  assert.ok(selected);
  assert.equal(extractValueResult(quotedSample, selected.rule).value, "東京都品川区\n1-2-3");

  const runtime = "> 住所：大阪府大阪市\n> 4-5-6 サンプル504号室\n> 電話番号：080-2222-3333";
  const client = extractValueResult(runtime, selected.rule);
  assert.equal(client.status, "ok");
  assert.equal(client.value, "大阪府大阪市\n4-5-6 サンプル504号室");
  assert.deepEqual(extractWorkerValueResult(runtime, selected.rule), client);
});

test("ships the complete LP and interactive app prototype", async () => {
  const page = await readFile(path.join(root, "app", "page.tsx"), "utf8");
  for (const copy of [
    "Gmailに届いたら",
    "対象メールを決める",
    "取得項目を自由に指定",
    "取得項目名",
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
    "項目を見分ける見出し",
    "基準となるテキスト",
    "自動プレビュー",
    "入力するたびに",
    "候補が複数ある場合は、推測せず",
    "取得できる状態になるまで自動転記は開始しません",
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
  const worker = await readFile(path.join(root, "dist", "server", "index.js"), "utf8");
  const hosting = JSON.parse(await readFile(path.join(root, "dist", ".openai", "hosting.json"), "utf8"));
  assert.match(html, /<html lang="ja">/);
  assert.match(html, /<title>MAILSHEET \| メールからGoogle Sheetsへ自動反映<\/title>/);
  assert.match(html, /<div id="root"><\/div>/);
  assert.match(html, /type="module"/);
  await assert.rejects(readFile(path.join(root, "dist", "client", "_redirects"), "utf8"), (error) => error?.code === "ENOENT");
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

test("builds stable, destination-specific Sheets delivery receipts", async () => {
  const { sheetDeliveryReceiptKey, sheetTestRequestKey } = await import(path.join(root, "worker", "index.js"));
  const spreadsheetId = "sheet_id_1234567890";
  const url = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`;
  const first = await sheetDeliveryReceiptKey("gmail_message_123", spreadsheetId, "応募一覧");
  assert.equal(first, await sheetDeliveryReceiptKey("gmail_message_123", url, "応募一覧"));
  assert.notEqual(first, await sheetDeliveryReceiptKey("gmail_message_123", spreadsheetId, "別Sheet"));
  assert.notEqual(first, await sheetDeliveryReceiptKey("gmail_message_456", spreadsheetId, "応募一覧"));
  assert.match(first, /^sheet-delivery:v1:[A-Za-z0-9_-]+$/);
  assert.equal(sheetTestRequestKey("request_id_1234567890"), "sheet-test:v1:request_id_1234567890");
  assert.throws(() => sheetTestRequestKey("short"), /テスト書き込み操作を確認できません/);
});

test("atomically rejects duplicate rule creates and updates", async () => {
  const { default: worker } = await import(path.join(root, "worker", "index.js"));
  const { env, sqlite } = await createWorkerTestEnvironment();
  const base = safeJsonRule();
  const ruleBody = (sender, id = null) => ({
    id,
    name: sender,
    sender,
    subjectContains: "",
    fields: base.fields,
    spreadsheetId: base.spreadsheetId,
    spreadsheetName: base.spreadsheetName,
    sheetName: base.sheetName,
    sheetHeaders: base.sheetHeaders,
    mappings: base.mappings,
    active: false,
  });
  const request = (body) => new Request("http://localhost/api/rules", {
    method: "POST",
    headers: { "content-type": "application/json", "x-mailsheet-dev-user": "test-user" },
    body: JSON.stringify(body),
  });
  try {
    const duplicateCreates = await Promise.all([
      worker.fetch(request(ruleBody("first@example.com")), env),
      worker.fetch(request(ruleBody("first@example.com")), env),
    ]);
    assert.deepEqual(duplicateCreates.map((response) => response.status).sort(), [200, 409]);

    const secondResponse = await worker.fetch(request(ruleBody("second@example.com")), env);
    assert.equal(secondResponse.status, 200);
    const second = await secondResponse.json();
    const duplicateUpdate = await worker.fetch(request(ruleBody("first@example.com", second.rule.id)), env);
    assert.equal(duplicateUpdate.status, 409);
    assert.equal((await duplicateUpdate.json()).error.code, "duplicate_rule");
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM extraction_rules").get().count, 2);
  } finally {
    sqlite.close();
  }
});

test("accepts one test write and blocks the same Gmail delivery in later rule runs", async () => {
  const { default: worker, processSavedRuleForTest } = await import(path.join(root, "worker", "index.js"));
  const { env, sqlite } = await createWorkerTestEnvironment();
  const sheets = installSheetsFetchMock();
  const payload = {
    ruleId: null,
    spreadsheetId: "sheet_id_1234567890",
    sheetName: "応募一覧",
    ruleName: "新しい転記ルール",
    values: ["池田 隼人"],
    gmailMessageId: "gmail_message_123",
    idempotencyKey: "request_id_1234567890",
    subject: "新しい応募",
    destination: "採用管理 / 応募一覧",
  };
  const request = (overrides = {}) => new Request("http://localhost/api/sheets/test", {
    method: "POST",
    headers: { "content-type": "application/json", "x-mailsheet-dev-user": "test-user" },
    body: JSON.stringify({ ...payload, ...overrides }),
  });
  try {
    const gmailResponses = await Promise.all([
      worker.fetch(request(), env),
      worker.fetch(request({ idempotencyKey: "request_id_abcdefghij" }), env),
    ]);
    const gmailResults = await Promise.all(gmailResponses.map((response) => response.json()));
    assert.equal(gmailResults.filter((result) => result.skipped === false).length, 1);
    assert.equal(gmailResults.filter((result) => result.skipped === true).length, 1);
    assert.equal(gmailResults.find((result) => result.skipped)?.duplicateReason, "gmail_message_already_accepted");
    assert.equal(sheets.appendCalls, 1);

    const laterRun = await processSavedRuleForTest(env, "test-user", safeJsonRule(), { messages: [gmailTestMessage()] });
    assert.deepEqual(laterRun, { success: 0, review: 0, skipped: 1, searched: 1 });
    assert.equal(sheets.appendCalls, 1);

    const sampleOnly = { gmailMessageId: "", idempotencyKey: "sample_request_123456", values: ["サンプル値"] };
    const sampleResponses = await Promise.all([
      worker.fetch(request(sampleOnly), env),
      worker.fetch(request(sampleOnly), env),
    ]);
    const sampleResults = await Promise.all(sampleResponses.map((response) => response.json()));
    assert.equal(sampleResults.filter((result) => result.skipped === false).length, 1);
    assert.equal(sampleResults.filter((result) => result.skipped === true).length, 1);
    assert.equal(sampleResults.find((result) => result.skipped)?.duplicateReason, "request_already_accepted");
    assert.equal(sheets.appendCalls, 2);
  } finally {
    sheets.restore();
    sqlite.close();
  }
});

test("keeps delivery receipts when history storage fails after a successful append", async () => {
  const { processSavedRuleForTest } = await import(path.join(root, "worker", "index.js"));
  const { env, sqlite } = await createWorkerTestEnvironment({ failHistoryWrites: 1 });
  const sheets = installSheetsFetchMock();
  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    const first = await processSavedRuleForTest(env, "test-user", safeJsonRule(), { messages: [gmailTestMessage()] });
    const repeated = await processSavedRuleForTest(env, "test-user", safeJsonRule(), { messages: [gmailTestMessage()] });
    assert.deepEqual(first, { success: 1, review: 0, skipped: 0, searched: 1 });
    assert.deepEqual(repeated, { success: 0, review: 0, skipped: 1, searched: 1 });
    assert.equal(sheets.appendCalls, 1);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM processed_messages").get().count, 2);
  } finally {
    console.error = originalConsoleError;
    sheets.restore();
    sqlite.close();
  }
});

test("does not automatically retry an append with an uncertain Google response", async () => {
  const { processSavedRuleForTest } = await import(path.join(root, "worker", "index.js"));
  const { env, sqlite } = await createWorkerTestEnvironment();
  const sheets = installSheetsFetchMock({ failAppend: true });
  try {
    const first = await processSavedRuleForTest(env, "test-user", safeJsonRule(), { messages: [gmailTestMessage()] });
    const repeated = await processSavedRuleForTest(env, "test-user", safeJsonRule(), { messages: [gmailTestMessage()] });
    assert.deepEqual(first, { success: 0, review: 1, skipped: 0, searched: 1 });
    assert.deepEqual(repeated, { success: 0, review: 0, skipped: 1, searched: 1 });
    assert.equal(sheets.appendCalls, 1);
    assert.match(sqlite.prepare("SELECT error_message FROM processing_history ORDER BY id LIMIT 1").get().error_message, /自動再送していません/);
  } finally {
    sheets.restore();
    sqlite.close();
  }
});

test("releases receipts after Google explicitly rejects an append", async () => {
  const { processSavedRuleForTest } = await import(path.join(root, "worker", "index.js"));
  const { env, sqlite } = await createWorkerTestEnvironment();
  const sheets = installSheetsFetchMock({ rejectAppendTimes: 1 });
  try {
    const rejected = await processSavedRuleForTest(env, "test-user", safeJsonRule(), { messages: [gmailTestMessage()] });
    const repairedRetry = await processSavedRuleForTest(env, "test-user", safeJsonRule(), { messages: [gmailTestMessage()] });
    assert.deepEqual(rejected, { success: 0, review: 1, skipped: 0, searched: 1 });
    assert.deepEqual(repairedRetry, { success: 1, review: 0, skipped: 0, searched: 1 });
    assert.equal(sheets.appendCalls, 2);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM processed_messages").get().count, 2);
  } finally {
    sheets.restore();
    sqlite.close();
  }
});

test("blocks two different rules from writing the same Gmail message to the same tab", async () => {
  const { processSavedRuleForTest } = await import(path.join(root, "worker", "index.js"));
  const { env, sqlite } = await createWorkerTestEnvironment();
  const sheets = installSheetsFetchMock();
  try {
    const first = await processSavedRuleForTest(env, "test-user", safeJsonRule(1), { messages: [gmailTestMessage()] });
    const second = await processSavedRuleForTest(env, "test-user", safeJsonRule(2), { messages: [gmailTestMessage()] });
    assert.equal(first.success, 1);
    assert.equal(second.skipped, 1);
    assert.equal(sheets.appendCalls, 1);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM processed_messages WHERE rule_id = 2").get().count, 0);
  } finally {
    sheets.restore();
    sqlite.close();
  }
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
  assert.match(worker, /GMAIL_API}\/history/);
  assert.match(worker, /historyTypes: "messageAdded"/);
  assert.match(worker, /gmailMessagesAddedSince/);
  assert.match(worker, /length\(gmail_history_id\) < length\(\?\)/);
  assert.match(worker, /messageMatchesRule/);
  assert.match(worker, /processSavedRule\(env, connection\.user_id, rule, \{ messages: addedMessages \}\)/);
  assert.match(worker, /今回追加されたメール/);
  assert.match(worker, /processSavedRule/);
  assert.match(worker, /Array\.isArray\(searchResult\?\.messages\)/);
  assert.match(worker, /duplicate_rule/);
  assert.match(worker, /handleRuleDelete/);
  assert.match(worker, /function sheetTimestamp/);
  assert.match(worker, /sheet\.headers\.slice\(2\)/);
  assert.match(worker, /ON CONFLICT\(user_id, rule_id, gmail_message_id\) DO NOTHING/);
  assert.match(worker, /result\.meta\?\.changes/);
  assert.match(worker, /mapping_incomplete/);
  assert.match(worker, /item\.result\.reason/);
  assert.match(worker, /SHEET_DELIVERY_RECEIPT_RULE_ID/);
  assert.match(worker, /sheetDeliveryKey/);
  assert.match(worker, /sheet-test:v1:/);
  assert.match(worker, /sheet-delivery:v1:/);
  assert.match(worker, /addHistorySafely/);
  assert.match(worker, /二重転記を防ぐため自動再送していません/);
  assert.match(worker, /INSERT INTO extraction_rules[\s\S]*WHERE NOT EXISTS/);
  assert.match(worker, /unsafe_extraction_pattern/);
  assert.match(worker, /body\.fields\.find\(\(field\) => field\.method !== "regex" \|\| !safeLocatorIsValid\(field\.locator\)\)/);
  assert.match(worker, /rule\.fields\.find\(\(field\) => field\.method !== "regex" \|\| !safeLocatorIsValid\(field\.locator\)\)/);
  assert.match(worker, /旧形式の取得条件です。本文から正しい値を選び直してください/);
  assert.doesNotMatch(worker, /\[\.\.\.sourceBody\.matchAll/);
  assert.doesNotMatch(worker, /new RegExp\s*\(\s*rule(?:\?\.)?\.pattern/);
  assert.doesNotMatch(worker, /matchAll\s*\(\s*new RegExp\s*\(\s*rule(?:\?\.)?\.pattern/);
  assert.match(worker, /sourceBody\.length > 200_000/);
  assert.doesNotMatch(worker, /legacyBetweenUsesPairedDelimiters/);
  assert.match(worker, /field\?\.method === "between"/);
  assert.match(worker, /method: "regex", pattern: "", locator: undefined/);
  assert.match(worker, /last_processed_at/);
  const page = await readFile(path.join(root, "app", "page.tsx"), "utf8");
  assert.match(page, /Pub\/Sub設定URLを表示/);
  assert.match(page, /毎日のwatch更新URL/);
  assert.match(page, /保存済みルール管理/);
  assert.match(page, /差出人（From）で探す/);
  assert.match(page, /件名で探す/);
  assert.match(page, /一致メールを手動で転記/);
  assert.match(page, /writeInFlightRef/);
  assert.match(page, /runInFlightRef/);
  assert.match(page, /saveInFlightRef/);
  assert.match(page, /gmailMessageId: emailMeta\.messageId/);
  assert.match(page, /idempotencyKey: testRequestRef\.current\.idempotencyKey/);
  assert.match(page, /重複行は追加しませんでした/);
  assert.match(page, /入力が終わると自動確認します/);
  assert.doesNotMatch(page, /正規表現を直接入力/);
  assert.doesNotMatch(page, /自動追加をONにして保存/);
  assert.match(page, /A列へ自動入力/);
  assert.match(page, /A列は「転記日時」、B列は編集可能な「転記ルール名」専用です/);
  assert.match(page, /設定不足/);
  assert.match(page, /このルールは実行されません/);
});

test("keeps Gmail fallback search within the Worker subrequest budget", async () => {
  const worker = await readFile(path.join(root, "worker", "index.js"), "utf8");
  assert.match(worker, /recentParams = new URLSearchParams\(\{ maxResults: "40", q: "in:anywhere" \}\)/);
  assert.doesNotMatch(worker, /recentParams = new URLSearchParams\(\{ maxResults: "50" \}\)/);
  assert.match(worker, /google_reconnect_required/);
  assert.match(worker, /function decodeMimeHeader/);
  assert.match(worker, /cleanSender\.includes\("@"\)/);
  assert.match(worker, /\{from:me from:\$\{cleanSender\}\}/);
  assert.match(worker, /function senderMatches/);
  assert.match(worker, /const exact = candidates\.filter/);
  assert.match(worker, /matchMode: closeMatches\.length \? "exact" : "recent"/);
});

test("expires login after seven idle days and refreshes active sessions", async () => {
  const worker = await readFile(path.join(root, "worker", "index.js"), "utf8");
  const page = await readFile(path.join(root, "app", "page.tsx"), "utf8");
  assert.match(worker, /SESSION_IDLE_SECONDS = 7 \* 24 \* 60 \* 60/);
  assert.match(worker, /refreshSession/);
  assert.match(page, /最後の操作から7日間アクセスがない場合/);
});

test("preserves the selected app tab across refreshes", async () => {
  const page = await readFile(path.join(root, "app", "page.tsx"), "utf8");
  assert.match(page, /`\/app\/\$\{nextView\}`/);
  assert.match(page, /window\.history\.replaceState\(\{\}, "", "\/app\/connections"\)/);
  assert.match(page, /handleAppPopState/);
  assert.match(page, /"guide"/);
});

test("provides a beginner guide without exposing tester personal data", async () => {
  const page = await readFile(path.join(root, "app", "page.tsx"), "utf8");
  const styles = await readFile(path.join(root, "app", "globals.css"), "utf8");
  assert.match(page, /使い方ガイド/);
  assert.match(page, /はじめての使い方/);
  assert.match(page, /このアプリはGoogleで確認されていません/);
  assert.match(page, /Gmail：メールの読取/);
  assert.match(page, /Google Sheets：表の読取・書込/);
  assert.match(page, /新着メールを自動転記 ON/);
  assert.match(page, /ONにする前の過去メールは自動転記しません/);
  assert.match(page, /tester@example\.com/);
  assert.doesNotMatch(page, /jtpgjmdaj587456325@gmail\.com/);
  assert.match(page, /needsSignIn && view !== "guide"/);
  assert.match(page, /view === "guide" \|\| \(!needsSignIn/);
  assert.match(styles, /\.guide-step/);
  assert.match(styles, /\.guide-connection-check/);
});

test("lets testers submit questions and admins manage their status", async () => {
  const page = await readFile(path.join(root, "app", "page.tsx"), "utf8");
  const worker = await readFile(path.join(root, "worker", "index.js"), "utf8");
  const styles = await readFile(path.join(root, "app", "globals.css"), "utf8");
  const feedbackMigration = await readFile(path.join(root, "drizzle", "0004_public_analytics_feedback.sql"), "utf8");
  assert.match(page, /フィードバック/);
  assert.match(page, /質問・不明点/);
  assert.match(page, /不具合報告・修正依頼/);
  assert.match(page, /使用感アンケート/);
  assert.doesNotMatch(page, /スクリーンショット・動画を選択/);
  assert.doesNotMatch(page, /自分の投稿履歴/);
  assert.doesNotMatch(page, /このメールアドレスと投稿内容を管理者が確認します/);
  assert.doesNotMatch(page, /AdminFeedbackAttachments/);
  assert.match(page, /changeFeedbackStatus/);
  assert.match(page, /未対応/);
  assert.match(page, /対応中/);
  assert.match(page, /解決済み/);
  assert.match(worker, /handleUserFeedbackSubmit/);
  assert.doesNotMatch(worker, /handleAdminFeedbackAttachments/);
  assert.doesNotMatch(worker, /FEEDBACK_FILES/);
  assert.doesNotMatch(worker, /handleUserFeedbackList/);
  assert.match(worker, /handleAdminFeedbackStatus/);
  assert.match(worker, /\/api\/feedback/);
  assert.doesNotMatch(worker, /\/api\/admin\/feedback\/attachment/);
  assert.match(worker, /\/api\/admin\/feedback\/status/);
  assert.match(worker, /`app:\$\{user\.id\}`/);
  assert.match(feedbackMigration, /`status` text DEFAULT 'new' NOT NULL/);
  assert.match(styles, /\.tester-feedback-form/);
  assert.match(styles, /\.tester-feedback-tabs/);
  assert.doesNotMatch(styles, /\.tester-feedback-attachments/);
  assert.doesNotMatch(styles, /\.admin-feedback-attachments/);
  assert.match(styles, /\.feedback-status\.is-resolved/);
});

test("searches Gmail with only the condition selected by the user", async () => {
  const page = await readFile(path.join(root, "app", "page.tsx"), "utf8");
  assert.match(page, /const \[sender, setSender\] = useState\(""\)/);
  assert.match(page, /from: conditionMode === "sender" \? sender\.trim\(\) : ""/);
  assert.match(page, /subject: conditionMode === "subject" \? subject\.trim\(\) : ""/);
  assert.match(page, /placeholder="notice@example\.com"/);
});

test("remembers successful inputs and offers reusable suggestions", async () => {
  const page = await readFile(path.join(root, "app", "page.tsx"), "utf8");
  const styles = await readFile(path.join(root, "app", "globals.css"), "utf8");
  assert.match(page, /mailsheet:input-history:v1:/);
  assert.match(page, /function InputSuggestions/);
  assert.match(page, /rememberInput\("sender", sender\)/);
  assert.match(page, /rememberInput\("subject", subject\)/);
  assert.match(page, /rememberInput\("spreadsheet", enteredSpreadsheet/);
  assert.match(page, /savedRules\.filter\(\(item\) => item\.spreadsheetId\)/);
  assert.match(page, /\.slice\(0, 10\)/);
  assert.match(styles, /\.input-suggestions/);
});

test("saves current sheet mappings when enabling a rule and guides the next action", async () => {
  const page = await readFile(path.join(root, "app", "page.tsx"), "utf8");
  const worker = await readFile(path.join(root, "worker", "index.js"), "utf8");
  assert.match(page, /active && ruleId === item\.id/);
  assert.match(page, /await saveRule\(true\)/);
  assert.match(page, /scrollToRef\(savedRulesRef\)/);
  assert.match(page, /scrollToRef\(gmailResultsRef\)/);
  assert.match(page, /scrollToRef\(selectionBuilderRef\)/);
  assert.match(page, /scrollToRef\(extractionRulesRef\)/);
  assert.doesNotMatch(page, /左のハンドル|rule-drag-handle|draggable/);
  assert.match(page, /aria-label=\{`\$\{rule\.name\}の並び順と削除`\}/);
  assert.match(page, /NEXT \{nextGuide\.step\}/);
  assert.match(page, /1行目と列を自動設定/);
  assert.match(page, /<option value="">出力列を選択<\/option>/);
  assert.match(page, /const writeSheetHeaders = async/);
  assert.match(page, /const sheetMappingsAreReady =/);
  assert.match(page, /info\.headers\[0\]\?\.label !== "転記日時"/);
  assert.match(page, /info\.headers\[1\]\?\.label !== "転記ルール"/);
  assert.match(page, /!sheetMappingsAreReady\(sheetInfo, mappings\)/);
  assert.match(worker, /\/api\/sheets\/headers/);
  assert.match(worker, /const headings = \["転記日時", "転記ルール", \.\.\.fieldNames\]/);
  assert.match(page, /value: header\.column, label: `\$\{header\.column\}列：\$\{header\.label\}`/);
  assert.match(page, /resolveMappedSheetColumn\(sheetInfo\.headers, mappings\[rule\.id\]\) === header\.column/);
  assert.match(worker, /function resolveMappedSheetColumn\(headers, mappedValue\)/);
  assert.match(worker, /return headers\.find\(\(header\) => header\.label === value\)\?\.column \|\| ""/);
  assert.match(worker, /resolveMappedSheetColumn\(outputHeaders, mappedHeader\)/);
  assert.match(worker, /resolveMappedSheetColumn\(outputHeaders, rule\.mappings\[String\(item\.field\.id\)\]\) === header\.column/);
  assert.doesNotMatch(worker, /rule\.mappings\[String\(item\.field\.id\)\] === header\.label/);
});

test("selects detected fields in a batch and assigns output columns from C", async () => {
  const page = await readFile(path.join(root, "app", "page.tsx"), "utf8");
  const styles = await readFile(path.join(root, "app", "globals.css"), "utf8");
  assert.match(page, /const \[selectedDetectedIndexes, setSelectedDetectedIndexes\] = useState<number\[]>\(\[]\)/);
  assert.match(page, /必要な項目を2件以上でも選べます/);
  assert.match(page, /aria-pressed=\{selected\}/);
  assert.match(page, /const addSelectedDetectedFields = \(\) =>/);
  assert.match(page, /const toggleAllDetectedFields = \(\) =>/);
  assert.match(page, /選択した\$\{selectedDetectedIndexes\.length\}件を追加/);
  assert.doesNotMatch(page, />すべて追加</);
  assert.match(page, /setSelectedDetectedIndexes\(\[]\)/);
  assert.match(page, /const outputColumnForRuleIndex = \(ruleIndex: number\) => spreadsheetColumnAt\(ruleIndex \+ 2\)/);
  assert.match(page, /nextMappings\[nextId\] = sheetInfo\?\.headers\[ruleIndex \+ 2\]\?\.column \?\? outputColumnForRuleIndex\(ruleIndex\)/);
  assert.match(page, /C列以降へ順番に割り当てました/);
  assert.match(styles, /\.detected-fields__list button\.is-selected/);
  assert.match(styles, /\.detected-fields__selection-bar/);
});

test("shows the safe extraction decision and fails closed on changed mail structures", async () => {
  const {
    detectFields,
    extractValueResult,
    extractionEditorHeading,
    extractionEditorMethod,
    updateExtractionRuleFromEditor,
  } = await vite.ssrLoadModule("/lib/extraction.ts");
  const { extractWorkerValueResult } = await import(path.join(root, "worker", "index.js"));
  const page = await readFile(path.join(root, "app", "page.tsx"), "utf8");
  const sample = "氏名：池田 隼人\n性別：男性\n郵便番号：140-0001\n住所：東京都品川区";
  const gender = detectFields(sample).find((item) => item.name === "性別");
  assert.ok(gender);

  const changed = "氏名：山田 花子\n性別：女性\n郵便番号：150-0001\n住所：東京都渋谷区";
  assert.equal(extractValueResult(changed, gender.rule).status, "ok");
  assert.equal(extractValueResult(changed, gender.rule).value, "女性");
  assert.equal(extractValueResult("氏名：山田 花子\nジェンダー：女性\n郵便番号：150-0001\n住所：東京都渋谷区", { ...gender.rule, aliases: ["ジェンダー"] }).value, "女性");
  assert.equal(extractValueResult("性別：男性\n郵便番号：140-0001\n性別：女性\n郵便番号：150-0001", gender.rule).status, "ambiguous");
  assert.equal(extractValueResult("氏名：山田 花子\n性別：入力してください\n郵便番号：150-0001\n住所：東京都渋谷区", gender.rule).status, "invalid");

  assert.equal(extractionEditorHeading(gender.rule), "性別");
  assert.equal(extractionEditorMethod(gender.rule), "after");
  const renamed = { ...gender.rule, name: "応募者の性別" };
  assert.equal(extractValueResult(sample, renamed).value, "男性");
  assert.equal(extractionEditorHeading(renamed), "性別");

  const configuredDraft = updateExtractionRuleFromEditor(sample, {
    id: 99,
    name: "任意のシート列名",
    method: "after",
    start: "項目名：",
    end: "",
    pattern: "",
  }, { heading: "性別", method: "after" });
  assert.equal(configuredDraft.method, "regex");
  assert.equal(configuredDraft.name, "任意のシート列名");
  assert.equal(extractValueResult(sample, configuredDraft).value, "男性");

  const birthdaySample = "氏名：池田 隼人\n生年月日：1996年04月15日（30歳）\n性別：男性\n郵便番号：140-0001";
  const name = detectFields(birthdaySample).find((item) => item.name === "氏名");
  assert.ok(name);
  const birthday = updateExtractionRuleFromEditor(birthdaySample, { ...name.rule, aliases: ["お名前"] }, { heading: "生年月日", method: "date" });
  assert.equal(birthday.method, "regex");
  assert.deepEqual(birthday.aliases, []);
  assert.equal(extractionEditorHeading(birthday), "生年月日");
  assert.equal(extractionEditorMethod(birthday), "date");
  assert.equal(birthday.locator?.kind, "label");
  assert.equal(birthday.locator?.nextLabel, "性別");
  assert.equal(extractValueResult(birthdaySample, birthday).value, "1996年04月15日（30歳）");
  assert.deepEqual(extractWorkerValueResult(birthdaySample, birthday), extractValueResult(birthdaySample, birthday));

  const wrongType = updateExtractionRuleFromEditor(birthdaySample, birthday, { method: "phone" });
  assert.equal(extractValueResult(birthdaySample, wrongType).status, "invalid");
  assert.match(extractValueResult(birthdaySample, wrongType).reason, /値の種類/);
  assert.deepEqual(extractWorkerValueResult(birthdaySample, wrongType), extractValueResult(birthdaySample, wrongType));
  const missingHeading = updateExtractionRuleFromEditor(birthdaySample, birthday, { heading: "存在しない見出し" });
  assert.equal(extractValueResult(birthdaySample, missingHeading).status, "missing");
  assert.match(extractValueResult(birthdaySample, missingHeading).reason, /存在しない見出し/);

  assert.match(page, /取得項目名 <small>シートで使う名前<\/small>/);
  assert.match(page, /値の種類 \/ 範囲の決め方 <small>抽出条件<\/small>/);
  assert.match(page, /項目を見分ける見出し <small>基準となるテキスト<\/small>/);
  assert.doesNotMatch(page, /別のメール表記にも対応（任意）|追加で探す見出し|通常は空欄で問題ありません|複数ある場合は読点/);
  assert.match(page, /自動プレビュー/);
  assert.match(page, /入力するたびに、現在表示中のメール本文で再判定/);
  assert.match(page, /role="status" aria-live="polite" aria-atomic="true"/);
  assert.match(page, /正常に取得できます/);
  assert.match(page, /この設定では取得できません/);
  assert.match(page, /selectedPreviewReady = selectedPreviewVerified && selectedRuleIsSafe/);
  assert.match(page, /previewRuleId === \(ruleId \?\? "draft"\)/);
  assert.match(page, /gmailRequestGenerationRef/);
  assert.match(page, /requestGeneration !== gmailRequestGenerationRef\.current/);
  assert.match(page, /saveRevision !== editorRevisionRef\.current/);
  assert.match(page, /saveSession === editorSessionRef\.current/);
  assert.match(page, /initialEditorRevision === editorRevisionRef\.current/);
  assert.match(page, /initialEditorSession === editorSessionRef\.current/);
  assert.match(page, /active && ruleId !== item\.id/);
  assert.match(page, /確認用メールで自動プレビューを確認し/);
  assert.match(page, /genericTextWouldLoseSafety/);
  assert.match(page, /真偽値（JSON項目）/);
  assert.match(page, /判定理由：/);
  assert.match(page, /入力文字を正規表現として実行していません/);
  assert.match(page, /取得条件と誤取得防止を確認/);
  assert.match(page, /onClick=\{\(\) => void editSavedRule\(item\)\}[^>]*>設定を編集/);
  assert.match(page, /ruleId \? "このルールに上書き保存" : "新しいルールとして保存"/);
  assert.match(page, /activeOverride && !selectedPreviewVerified/);
});

test("keeps duplicate JSON leaf values bound to their original object paths", async () => {
  const {
    detectFields,
    extractValueResult,
    extractionEditorHeading,
    updateExtractionRuleFromEditor,
  } = await vite.ssrLoadModule("/lib/extraction.ts");
  const body = JSON.stringify({
    primary: { name: "共通の宛名" },
    billing: { name: "共通の宛名" },
  });
  const nameFields = detectFields(body).filter((field) => field.name === "name");

  assert.equal(nameFields.length, 2);
  assert.deepEqual(
    nameFields.map((field) => field.rule.locator?.path?.join(".")).sort(),
    ["billing.name", "primary.name"],
  );
  const billing = nameFields.find((field) => field.rule.locator?.path?.[0] === "billing");
  assert.ok(billing);
  assert.equal(extractionEditorHeading(billing.rule), "billing → name");

  const edited = updateExtractionRuleFromEditor(
    body,
    billing.rule,
    { heading: "name" },
    nameFields,
  );
  assert.deepEqual(edited.locator?.path, ["billing", "name"]);
  assert.deepEqual(extractValueResult(body, edited), {
    value: "共通の宛名",
    status: "ok",
    reason: "",
  });
});

test("keeps a JSON boolean type when only its heading is edited", async () => {
  const {
    detectFields,
    extractValueResult,
    extractionEditorMethod,
    updateExtractionRuleFromEditor,
  } = await vite.ssrLoadModule("/lib/extraction.ts");
  const body = JSON.stringify({
    profile: { active: true },
    billing: { enabled: false },
  });
  const fields = detectFields(body);
  const active = fields.find((field) => field.rule.locator?.path?.join(".") === "profile.active");
  assert.ok(active);
  assert.equal(extractionEditorMethod(active.rule), "boolean");

  const edited = updateExtractionRuleFromEditor(body, active.rule, { heading: "enabled" }, fields);
  assert.equal(edited.method, "regex");
  assert.equal(edited.locator?.kind, "json");
  assert.deepEqual(edited.locator?.path, ["billing", "enabled"]);
  assert.equal(edited.locator?.jsonType, "boolean");
  assert.equal(extractionEditorMethod(edited), "boolean");
  assert.deepEqual(extractValueResult(body, edited), {
    value: "false",
    status: "ok",
    reason: "",
  });
});

test("changes only the value type of a compound-label locator for a method-only edit", async () => {
  const {
    detectFields,
    extractValueResult,
    ruleFromSelection,
    updateExtractionRuleFromEditor,
  } = await vite.ssrLoadModule("/lib/extraction.ts");
  const body = "応募者：【氏名】池田 隼人【電話番号】090-1111-2222";
  const selected = ruleFromSelection(body, "池田 隼人", 201, "氏名", body.indexOf("池田 隼人"));
  assert.ok(selected);
  assert.equal(selected.rule.locator?.kind, "label");
  assert.equal(selected.rule.locator?.label, "応募者");
  assert.equal(selected.rule.locator?.innerLabel, "氏名");
  const detected = detectFields(body);
  assert.equal(detected.filter((field) => field.name === "氏名").length, 1);

  const edited = updateExtractionRuleFromEditor(body, selected.rule, { method: "phone" }, detected);
  assert.equal(edited.method, "regex");
  assert.equal(edited.name, selected.rule.name);
  const { sampleValueType: previousType, ...previousLocator } = selected.rule.locator;
  const { sampleValueType: editedType, ...editedLocator } = edited.locator;
  assert.equal(previousType, "text");
  assert.equal(editedType, "phone");
  assert.deepEqual(editedLocator, previousLocator);
  assert.equal(extractValueResult(body, edited).status, "invalid");
  assert.match(extractValueResult(body, edited).reason, /値の種類/);
});

test("promotes a matching legacy heading when only its value type changes", async () => {
  const {
    extractValueResult,
    extractionLocatorIsSafe,
    updateExtractionRuleFromEditor,
  } = await vite.ssrLoadModule("/lib/extraction.ts");
  const body = "応募日時：2026/09/04";
  const legacy = {
    id: 301,
    name: "応募日",
    method: "after",
    start: "応募日時：",
    end: "",
    pattern: "",
    anchorConfirmed: true,
  };

  const edited = updateExtractionRuleFromEditor(body, legacy, { method: "date" });
  assert.equal(edited.method, "regex");
  assert.equal(extractionLocatorIsSafe(edited.locator), true);
  assert.deepEqual(extractValueResult(body, edited), {
    value: "2026/09/04",
    status: "ok",
    reason: "",
  });
});

test("rebuilds a stale locator when the same heading moves to a new structure", async () => {
  const {
    detectFields,
    extractValueResult,
    updateExtractionRuleFromEditor,
  } = await vite.ssrLoadModule("/lib/extraction.ts");
  const oldBody = "氏名：山田 太郎\n性別：男性";
  const currentBody = "【氏名】山田 太郎\n【性別】男性";
  const oldRule = detectFields(oldBody).find((field) => field.name === "氏名")?.rule;
  assert.ok(oldRule);
  assert.equal(extractValueResult(currentBody, oldRule).status, "missing");

  const rebuilt = updateExtractionRuleFromEditor(currentBody, oldRule, { heading: "【氏名】" });
  assert.equal(rebuilt.locator?.kind, "label");
  assert.equal(rebuilt.locator?.bracketed, true);
  assert.equal(rebuilt.locator?.inline, undefined);
  assert.equal(rebuilt.locator?.nextLabel, "性別");
  assert.deepEqual(extractValueResult(currentBody, rebuilt), {
    value: "山田 太郎",
    status: "ok",
    reason: "",
  });
});

test("keeps decorated duplicate block headings bound after character-by-character edits", async () => {
  const {
    detectFields,
    extractValueResult,
    extractionEditorHeading,
    updateExtractionRuleFromEditor,
  } = await vite.ssrLoadModule("/lib/extraction.ts");
  const body = "■ 1. Profile\nAlice\n■ 2. Profile\nAlice\n-----";
  const profiles = detectFields(body).filter((field) => field.name === "Profile");
  assert.equal(profiles.length, 2);
  const second = profiles.find((field) => field.rule.locator?.heading === "■ 2. Profile");
  assert.ok(second);
  assert.equal(extractionEditorHeading(second.rule), "■ 2. Profile");

  const partial = updateExtractionRuleFromEditor(body, second.rule, { heading: "■ 2. Profil" }, profiles);
  const restored = updateExtractionRuleFromEditor(body, partial, { heading: "■ 2. Profile" }, profiles);
  assert.equal(restored.locator?.heading, "■ 2. Profile");
  const changed = "■ 1. Profile\nWrong\n■ 2. Profile\nRight\n-----";
  assert.deepEqual(extractValueResult(changed, restored), {
    value: "Right",
    status: "ok",
    reason: "",
  });
});

test("shows the exact canonical question used by a QA locator", async () => {
  const { detectFields, extractionEditorHeading } = await vite.ssrLoadModule("/lib/extraction.ts");
  const body = "Q1. お名前は？\n回答：山田 太郎";
  const field = detectFields(body).find((item) => item.rule.locator?.kind === "qa");
  assert.ok(field);
  assert.equal(extractionEditorHeading(field.rule), "Q1. お名前は？");
});

test("supports ten saved rules, three active rules, and traceable automatic processing", async () => {
  const page = await readFile(path.join(root, "app", "page.tsx"), "utf8");
  const worker = await readFile(path.join(root, "worker", "index.js"), "utf8");
  assert.match(page, /const starterRules = embedded \? initialRules : \[\]/);
  assert.doesNotMatch(page, /name: "取得項目1"/);
  assert.match(page, /保存済みルール \{savedRules\.length\}\/10件/);
  assert.match(page, /自動転記ON \{savedRules\.filter\(\(item\) => item\.active && !savedRuleNeedsAnchorReview\(item\)\)\.length\}\/3件/);
  assert.match(page, /このルールに上書き保存/);
  assert.match(page, /新しいルールとして保存/);
  assert.match(page, /設定を残して別ルールにする/);
  assert.match(page, /setRuleId\(null\)[\s\S]*setPreviewRuleId\("draft"\)/);
  assert.match(page, /この名前をSpreadsheetのB列へ出力します/);
  assert.match(worker, /rule_limit_reached/);
  assert.match(worker, /active_rule_limit_reached/);
  assert.match(worker, /ORDER BY updated_at DESC LIMIT 3/);
  assert.match(worker, /searchGmail\(env, userId, rule\.sender, rule\.subjectContains, 10, false\)/);
  assert.match(worker, /status: "received"/);
  assert.match(worker, /status: "skipped"/);
  assert.match(worker, /gmail_watch_failed/);
  assert.match(worker, /Gmail受信監視を開始できませんでした/);
  assert.match(worker, /lastGmailNotificationAt/);
  assert.doesNotMatch(worker, /labelFilterBehavior: "INCLUDE"/);
  assert.match(page, /watchRepairAttempted/);
  assert.match(page, /受信監視停止/);
  assert.match(page, /Cloudflareへ最初の受信通知が届くのを待っています/);
  assert.match(page, /受信通知の設定が未完了です/);
  assert.match(page, /確認が終わるまで誤転記を防ぐため処理を停止します/);
  assert.match(page, /招待・登録ユーザー一覧/);
  assert.match(page, /メール変更/);
  assert.match(page, /招待削除/);
  assert.match(worker, /handleAdminPendingInvite/);
  assert.match(worker, /\/api\/admin\/invite\/manage/);
  assert.match(page, />監視開始<\/button>/);
  assert.match(worker, /row = \[sheetTimestamp\(\), rule\.name, \.\.\.outputHeaders\.map/);
});

test("serves client routes without redirecting them to the landing page", async () => {
  const worker = await readFile(path.join(root, "worker", "index.js"), "utf8");
  assert.match(worker, /const isClientRoute/);
  assert.match(worker, /isClientRoute\s*\?\s*await env\.ASSETS\.fetch/);
  assert.match(worker, /new URL\("\/", request\.url\)/);
});
