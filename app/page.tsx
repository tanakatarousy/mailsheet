import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import {
  ApiError,
  apiFetch,
  postJson,
  type AuthStatus,
  type AdminOverview,
  type DashboardData,
  type FeedbackItem,
  type GmailMessage,
  type HistoryRow as ApiHistoryRow,
  type SavedRule,
  type SheetInfo,
} from "@/lib/api";
import {
  extractValue,
  detectFields,
  initialRules,
  methodLabels,
  ruleFromSelection,
  sampleEmail,
  type ExtractionMethod,
  type ExtractionRule,
} from "@/lib/extraction";

type AppView = "dashboard" | "connections" | "rules" | "history" | "settings" | "guide" | "feedback" | "admin";

const errorText = (error: unknown) => error instanceof ApiError ? error.message : "処理に失敗しました。もう一度お試しください。";
const formatAdminDate = (value?: string | number) => {
  if (!value) return "—";
  const date = new Date(typeof value === "number" ? value : value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
};

const historyRows = [
  { time: "10:42", subject: "新しい応募", count: 4, destination: "採用管理", status: "成功", errorMessage: "" },
  { time: "10:31", subject: "お問い合わせ", count: 3, destination: "営業管理", status: "成功", errorMessage: "" },
  { time: "09:54", subject: "新規予約", count: 2, destination: "予約管理", status: "要確認", errorMessage: "電話番号を抽出できませんでした" },
  { time: "09:17", subject: "注文完了 #1042", count: 4, destination: "注文管理", status: "成功", errorMessage: "" },
];

const useCases = [
  {
    number: "01",
    title: "求人・採用",
    source: "Indeed / engage / type",
    pain: "応募通知メールを開き、採用管理シートへ毎回転記していませんか？",
    result: "氏名・連絡先・希望職種を抽出",
    sheet: "採用管理シート",
  },
  {
    number: "02",
    title: "問い合わせ",
    source: "ホームページのフォーム",
    pain: "問い合わせ通知を、対応表へ一件ずつコピー＆ペーストしていませんか？",
    result: "受信日時・氏名・内容を整理",
    sheet: "営業管理シート",
  },
  {
    number: "03",
    title: "予約・申込",
    source: "スクール / サロン / セミナー",
    pain: "予約確定メールを見ながら、台帳やExcelへ手入力していませんか？",
    result: "予約日時・お客様情報を抽出",
    sheet: "予約台帳",
  },
  {
    number: "04",
    title: "EC・注文",
    source: "BASE / STORES / Shopify",
    pain: "注文通知から出荷リストを、毎回手作業で作っていませんか？",
    result: "注文番号・商品・数量・金額を抽出",
    sheet: "出荷管理シート",
  },
  {
    number: "05",
    title: "イベント申込",
    source: "Peatix / こくちーず",
    pain: "申込通知から参加者リストへ、一人ずつ転記していませんか？",
    result: "申込者・券種・人数を整理",
    sheet: "参加者リスト",
  },
  {
    number: "06",
    title: "請求・領収",
    source: "各サービスの請求通知",
    pain: "請求メール本文を見ながら、経費一覧へ手入力していませんか？",
    result: "金額・支払先・日付を抽出",
    sheet: "経費管理シート",
  },
  {
    number: "07",
    title: "案件通知",
    source: "ランサーズ / クラウドワークス",
    pain: "受注・提案通知を、案件管理表へ手作業で記録していませんか？",
    result: "案件名・依頼元・期限を整理",
    sheet: "案件管理シート",
  },
  {
    number: "08",
    title: "不動産・内見",
    source: "SUUMO / HOME'S",
    pain: "問い合わせ通知から、お客様情報を顧客管理表へ転記していませんか？",
    result: "連絡先・希望条件を抽出",
    sheet: "顧客管理シート",
  },
];

const faqItems = [
  {
    question: "Gmailのパスワードを入力する必要がありますか？",
    answer:
      "必要ありません。Google OAuth 2.0の認可コード方式で接続し、GmailのパスワードはMAILSHEETへ入力しません。",
  },
  {
    question: "正規表現を知らなくても使えますか？",
    answer:
      "はい。「氏名：の後ろ」「この文字とこの文字の間」「日付として取得」など、日本語の選択肢だけで設定できます。本文を選択した場合も、取得条件を自動で作成します。",
  },
  {
    question: "どんなメールでも使えますか？",
    answer:
      "項目名や区切りがある程度決まった定型メールを主な対象としています。自由文や書式が毎回大きく変わるメールは、抽出できない場合があります。",
  },
  {
    question: "Google Sheetsは既存のものを使えますか？",
    answer:
      "既存SpreadsheetとSheetを選び、1行目の見出しに抽出項目を紐付ける設計です。新規作成に限定しません。",
  },
  {
    question: "メール形式が変わった場合はどうなりますか？",
    answer:
      "抽出に失敗した項目は「要確認」として履歴に残ります。何が取れなかったか確認し、ルールを修正できます。",
  },
  {
    question: "接続を解除できますか？",
    answer:
      "はい。ConnectionsまたはSettingsからGoogleトークンを失効させ、接続情報を削除できます。",
  },
];

function Icon({ name, size = 22 }: { name: string; size?: number }) {
  const paths: Record<string, ReactNode> = {
    mail: (
      <>
        <rect x="3" y="5" width="18" height="14" rx="2" />
        <path d="m4 7 8 6 8-6" />
      </>
    ),
    sheet: (
      <>
        <rect x="4" y="3" width="16" height="18" rx="2" />
        <path d="M8 8h8M8 12h8M8 16h8M11 8v8" />
      </>
    ),
    arrow: <path d="M4 12h15m-5-5 5 5-5 5" />,
    check: <path d="m5 12 4 4L19 6" />,
    link: (
      <>
        <path d="M10 13a5 5 0 0 0 7.5.5l2-2a5 5 0 0 0-7-7l-1.1 1" />
        <path d="M14 11a5 5 0 0 0-7.5-.5l-2 2a5 5 0 0 0 7 7l1.1-1" />
      </>
    ),
    play: <path d="m9 7 7 5-7 5V7Z" />,
    plus: <path d="M12 5v14M5 12h14" />,
    trash: (
      <>
        <path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13" />
        <path d="M10 11v5M14 11v5" />
      </>
    ),
    up: <path d="m7 14 5-5 5 5" />,
    down: <path d="m7 10 5 5 5-5" />,
    menu: <path d="M4 7h16M4 12h16M4 17h16" />,
    close: <path d="m6 6 12 12M18 6 6 18" />,
    dashboard: (
      <>
        <rect x="3" y="3" width="7" height="7" rx="1" />
        <rect x="14" y="3" width="7" height="7" rx="1" />
        <rect x="3" y="14" width="7" height="7" rx="1" />
        <rect x="14" y="14" width="7" height="7" rx="1" />
      </>
    ),
    history: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3 2" />
      </>
    ),
    guide: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M9.7 9a2.4 2.4 0 1 1 3.5 2.1c-.8.4-1.2 1-1.2 1.9" />
        <path d="M12 17h.01" />
      </>
    ),
    feedback: (
      <>
        <path d="M4 5h16v11H8l-4 3V5Z" />
        <path d="M8 9h8M8 12h5" />
      </>
    ),
    settings: (
      <>
        <circle cx="12" cy="12" r="3" />
        <path d="M19 12a7 7 0 0 0-.1-1l2-1.5-2-3.4-2.4 1A7 7 0 0 0 15 6l-.3-2.6h-4L10.4 6a7 7 0 0 0-1.5.9l-2.4-1-2 3.4 2 1.5a7 7 0 0 0 0 2.2l-2 1.5 2 3.4 2.4-1a7 7 0 0 0 1.5.9l.3 2.6h4l.3-2.6a7 7 0 0 0 1.5-.9l2.4 1 2-3.4-2-1.5a7 7 0 0 0 .1-1Z" />
      </>
    ),
  };

  return (
    <svg
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
}

function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <span className={compact ? "brand brand--compact" : "brand"}>
      <span className="brand__mark">M→S</span>
      <span className="brand__text">MAILSHEET</span>
    </span>
  );
}

function EmailDocument({
  body,
  rules = initialRules,
  subject = "新しい応募",
  from = "notice@example.com",
  onTextSelect,
}: {
  body: string;
  rules?: ExtractionRule[];
  subject?: string;
  from?: string;
  onTextSelect?: (text: string) => void;
}) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const captureSelection = () => {
    if (!onTextSelect || !bodyRef.current) return;
    const selection = window.getSelection();
    const text = selection?.toString().trim() ?? "";
    if (!text || text.length > 500 || !selection?.anchorNode || !bodyRef.current.contains(selection.anchorNode)) return;
    onTextSelect(text);
  };
  return (
    <div className="email-document" aria-label="メール本文プレビュー">
      <div className="email-document__chrome">
        <span />
        <span />
        <span />
        <small>message.eml</small>
      </div>
      <div className="email-document__meta">
        <strong>{subject}</strong>
        <span>{from}</span>
      </div>
      <div ref={bodyRef} className={onTextSelect ? "email-document__body is-selectable" : "email-document__body"} onMouseUp={captureSelection} onTouchEnd={() => window.setTimeout(captureSelection, 0)}>
        {body.split(/\r?\n/).map((line, index) => {
          const separatorIndex = line.indexOf("：");
          const marker = separatorIndex >= 0 ? line.slice(0, separatorIndex + 1) : "";
          const value = separatorIndex >= 0 ? line.slice(separatorIndex + 1) : line;
          const ruleIndex = marker ? rules.findIndex((rule) => rule.start === marker) : -1;
          return (
            <p key={`${line}-${index}`} className={ruleIndex >= 0 ? `is-target target-${ruleIndex % 4}` : undefined}>
              {marker ? <span>{marker}</span> : null}
              {value}
            </p>
          );
        })}
      </div>
    </div>
  );
}

function SheetPreview({ rules = initialRules }: { rules?: ExtractionRule[] }) {
  return (
    <div className="sheet-preview" aria-label="Googleスプレッドシート反映例">
      <div className="sheet-preview__bar">
        <span className="sheet-logo"><Icon name="sheet" size={18} /></span>
        <strong>採用管理</strong>
        <small>保存済み</small>
      </div>
      <div className="sheet-grid">
        <span className="corner" />
        {rules.slice(0, 4).map((rule, index) => <strong key={rule.id}>{String.fromCharCode(65 + index)}</strong>)}
        <b>1</b>
        {rules.slice(0, 4).map((rule) => <span key={`head-${rule.id}`} className="sheet-head">{rule.name}</span>)}
        <b>2</b>
        {rules.slice(0, 4).map((rule) => <span key={`value-${rule.id}`} className="sheet-value">{extractValue(sampleEmail, rule) || "—"}</span>)}
      </div>
    </div>
  );
}

function HeroDemo() {
  return (
    <div className="hero-demo" aria-label="GmailからGoogle Sheetsへの自動反映デモ">
      <div className="hero-demo__mail">
        <span className="service-chip"><Icon name="mail" size={17} /> Gmail</span>
        <EmailDocument body={sampleEmail} />
      </div>
      <div className="hero-demo__route" aria-hidden="true">
        <svg viewBox="0 0 360 420" preserveAspectRatio="none">
          <path d="M180 0 C310 90 22 132 184 214 S314 326 180 420" />
        </svg>
        <span>必要な4項目だけ</span>
      </div>
      <div className="hero-demo__sheet">
        <span className="service-chip service-chip--sheet"><Icon name="sheet" size={17} /> Google Sheets</span>
        <SheetPreview />
      </div>
    </div>
  );
}

function SiteHeader({ onOpenApp }: { onOpenApp: () => void }) {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);

  return (
    <header className="site-header">
      <a className="site-header__brand" href="#top" aria-label="MAILSHEET トップへ">
        <Brand />
      </a>
      <button
        type="button"
        className="mobile-menu-button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-label={open ? "メニューを閉じる" : "メニューを開く"}
      >
        <Icon name={open ? "close" : "menu"} />
      </button>
      <nav className={open ? "orbital-nav is-open" : "orbital-nav"} aria-label="ページ内ナビゲーション">
        <a href="#features" onClick={close}>機能 <span>→</span></a>
        <a href="#how" onClick={close}>使い方 <span>→</span></a>
        <a href="#cases" onClick={close}>活用例 <span>→</span></a>
        <a href="#price" onClick={close}>料金 <span>→</span></a>
        <a href="#faq" onClick={close}>FAQ <span>→</span></a>
        <button className="orbital-nav__cta" type="button" onClick={onOpenApp}>無料で試す <span>↗</span></button>
      </nav>
    </header>
  );
}

type RecentInputHistory = {
  senders: string[];
  subjects: string[];
  spreadsheets: Array<{ value: string; label: string }>;
};

type InputSuggestion = { value: string; label?: string };

const emptyRecentInputHistory = (): RecentInputHistory => ({ senders: [], subjects: [], spreadsheets: [] });
const normalizedInput = (value: string) => value.normalize("NFKC").trim().toLocaleLowerCase("ja-JP");
const recentValues = (value: string, current: string[]) => {
  const clean = value.trim();
  return clean ? [clean, ...current.filter((item) => normalizedInput(item) !== normalizedInput(clean))].slice(0, 10) : current;
};
const spreadsheetHistoryKey = (value: string) => value.match(/\/spreadsheets\/d\/([A-Za-z0-9_-]+)/)?.[1] || value.trim();

function InputSuggestions({ options, value, onSelect }: { options: InputSuggestion[]; value: string; onSelect: (value: string) => void }) {
  const query = normalizedInput(value);
  const seen = new Set<string>();
  const visible = options.filter((option) => {
    const key = normalizedInput(option.value);
    if (!key || key === query || seen.has(key)) return false;
    seen.add(key);
    return !query || key.includes(query) || normalizedInput(option.label || "").includes(query);
  }).slice(0, 4);
  if (!visible.length) return null;
  return (
    <div className="input-suggestions" aria-label={query ? "入力候補" : "以前の入力"}>
      <small>{query ? "入力候補" : "以前の入力"}</small>
      <div>{visible.map((option) => (
        <button key={option.value} type="button" title={option.value} onMouseDown={(event) => event.preventDefault()} onClick={() => onSelect(option.value)}>
          <strong>{option.label || option.value}</strong>{option.label ? <span>{option.value}</span> : null}
        </button>
      ))}</div>
    </div>
  );
}

function RuleWorkbench({ embedded = false, onDataChanged }: { embedded?: boolean; onDataChanged?: () => void }) {
  const live = !embedded;
  const starterRules = embedded ? initialRules : [];
  const starterEmail = sampleEmail;
  const [ruleId, setRuleId] = useState<number | null>(null);
  const [ruleName, setRuleName] = useState(embedded ? "求人応募メール" : "新しい転記ルール");
  const [emailBody, setEmailBody] = useState(starterEmail);
  const [emailMeta, setEmailMeta] = useState({ subject: "新しい応募", from: "notice@example.com" });
  const [rules, setRules] = useState<ExtractionRule[]>(starterRules);
  const [selectedRuleId, setSelectedRuleId] = useState(starterRules[0]?.id ?? 0);
  const [sender, setSender] = useState("");
  const [subject, setSubject] = useState("");
  const [conditionMode, setConditionMode] = useState<"sender" | "subject">("sender");
  const [testStatus, setTestStatus] = useState<"idle" | "complete">("idle");
  const [saved, setSaved] = useState(false);
  const [autoAdd, setAutoAdd] = useState(false);
  const [mappings, setMappings] = useState<Record<number, string>>(
    Object.fromEntries(starterRules.map((rule, index) => [rule.id, embedded ? `${String.fromCharCode(67 + index)}列` : ""])),
  );
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const [gmailMessages, setGmailMessages] = useState<GmailMessage[]>([]);
  const [savedRules, setSavedRules] = useState<SavedRule[]>([]);
  const [spreadsheetInput, setSpreadsheetInput] = useState("");
  const [sheetName, setSheetName] = useState("");
  const [sheetInfo, setSheetInfo] = useState<SheetInfo | null>(null);
  const [busy, setBusy] = useState<"" | "gmail" | "sheet" | "save" | "write" | "run">("");
  const [notice, setNotice] = useState<{ kind: "success" | "warning"; text: string } | null>(null);
  const [selectedText, setSelectedText] = useState("");
  const [selectionName, setSelectionName] = useState("");
  const [sheetConnection, setSheetConnection] = useState<{ state: "idle" | "checking" | "connected" | "error"; message: string }>({ state: "idle", message: "" });
  const [recentInputHistory, setRecentInputHistory] = useState<RecentInputHistory>(emptyRecentInputHistory);
  const draggedRuleId = useRef<number | null>(null);
  const savedRulesRef = useRef<HTMLElement | null>(null);
  const gmailResultsRef = useRef<HTMLDivElement | null>(null);
  const mailPreviewRef = useRef<HTMLDivElement | null>(null);
  const selectionBuilderRef = useRef<HTMLDivElement | null>(null);
  const extractionRulesRef = useRef<HTMLElement | null>(null);
  const mailConditionRef = useRef<HTMLElement | null>(null);
  const mappingSectionRef = useRef<HTMLElement | null>(null);
  const testSectionRef = useRef<HTMLElement | null>(null);
  const watchRepairAttempted = useRef(false);
  const rulesRef = useRef(rules);
  useEffect(() => { rulesRef.current = rules; }, [rules]);

  const inputHistoryStorageKey = live && auth?.appUser.email
    ? `mailsheet:input-history:v1:${auth.appUser.email.toLocaleLowerCase("ja-JP")}`
    : "";

  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (!inputHistoryStorageKey) {
        setRecentInputHistory(emptyRecentInputHistory());
        return;
      }
      try {
        const stored = JSON.parse(window.localStorage.getItem(inputHistoryStorageKey) || "null") as Partial<RecentInputHistory> | null;
        setRecentInputHistory({
          senders: Array.isArray(stored?.senders) ? stored.senders.filter((item): item is string => typeof item === "string").slice(0, 10) : [],
          subjects: Array.isArray(stored?.subjects) ? stored.subjects.filter((item): item is string => typeof item === "string").slice(0, 10) : [],
          spreadsheets: Array.isArray(stored?.spreadsheets)
            ? stored.spreadsheets.filter((item): item is { value: string; label: string } => Boolean(item && typeof item.value === "string" && typeof item.label === "string")).slice(0, 10)
            : [],
        });
      } catch {
        setRecentInputHistory(emptyRecentInputHistory());
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [inputHistoryStorageKey]);

  const rememberInput = useCallback((kind: "sender" | "subject" | "spreadsheet", rawValue: string, label = "") => {
    const value = rawValue.trim();
    if (!inputHistoryStorageKey || !value) return;
    setRecentInputHistory((current) => {
      const next: RecentInputHistory = {
        senders: kind === "sender" ? recentValues(value, current.senders) : current.senders,
        subjects: kind === "subject" ? recentValues(value, current.subjects) : current.subjects,
        spreadsheets: kind === "spreadsheet"
          ? [{ value, label: label.trim() }, ...current.spreadsheets.filter((item) => spreadsheetHistoryKey(item.value) !== spreadsheetHistoryKey(value))].slice(0, 10)
          : current.spreadsheets,
      };
      try {
        window.localStorage.setItem(inputHistoryStorageKey, JSON.stringify(next));
      } catch {
        // 保存できないブラウザ設定でも、現在の画面内では候補を利用できます。
      }
      return next;
    });
  }, [inputHistoryStorageKey]);

  const senderSuggestions = useMemo<InputSuggestion[]>(() => [
    ...recentInputHistory.senders.map((value) => ({ value })),
    ...savedRules.filter((item) => item.sender).map((item) => ({ value: item.sender, label: item.name })),
  ], [recentInputHistory.senders, savedRules]);
  const subjectSuggestions = useMemo<InputSuggestion[]>(() => [
    ...recentInputHistory.subjects.map((value) => ({ value })),
    ...savedRules.filter((item) => item.subjectContains).map((item) => ({ value: item.subjectContains, label: item.name })),
  ], [recentInputHistory.subjects, savedRules]);
  const spreadsheetSuggestions = useMemo<InputSuggestion[]>(() => [
    ...recentInputHistory.spreadsheets.map((item) => ({ value: item.value, label: item.label })),
    ...savedRules.filter((item) => item.spreadsheetId).map((item) => ({
      value: `https://docs.google.com/spreadsheets/d/${item.spreadsheetId}`,
      label: item.spreadsheetName ? `${item.spreadsheetName}${item.sheetName ? ` / ${item.sheetName}` : ""}` : item.name,
    })),
  ], [recentInputHistory.spreadsheets, savedRules]);

  const scrollToRef = (ref: { current: HTMLElement | null }, delay = 80) => {
    window.setTimeout(() => ref.current?.scrollIntoView({
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
      block: "center",
    }), delay);
  };

  const selectedRule = rules.find((rule) => rule.id === selectedRuleId) ?? rules[0];
  const results = useMemo(
    () => rules.map((rule) => ({ rule, value: extractValue(emailBody, rule) })),
    [emailBody, rules],
  );
  const hasMissingResult = results.some((item) => !item.value);
  const detectedFields = useMemo(() => detectFields(emailBody), [emailBody]);
  const ruleHealth = (item: SavedRule) => {
    const missing: string[] = [];
    if (!item.spreadsheetId) missing.push("Spreadsheet");
    if (!item.sheetName) missing.push("Sheet");
    if (!item.sheetHeaders.length) missing.push("1行目の見出し");
    if (item.fields.some((field) => !item.mappings[String(field.id)])) missing.push("出力列の割り当て");
    if (!item.active) return { tone: "stopped", label: "停止中", message: "新着メールの自動転記がOFFです。「自動転記ON」を押すと稼働します。" };
    if (!auth?.gmailPushConfigured) return { tone: "error", label: "受信通知未設定", message: "Gmail受信通知が未設定のため、自動転記は開始されません。" };
    if (!auth?.gmailWatchActive) return { tone: "error", label: "受信監視停止", message: "Gmailの新着監視が止まっています。「監視開始」を押してください。" };
    if (missing.length) return { tone: "error", label: "設定不足", message: `${missing.join("・")}が未設定のため、このルールは実行されません。` };
    if (item.lastStatus === "review" || item.lastStatus === "failed") return { tone: "error", label: "要確認", message: item.lastError || "直近の処理でエラーが発生しました。Historyを確認してください。" };
    if (item.lastStatus === "success") return { tone: "success", label: "正常", message: `直近の転記に成功しました（${new Intl.DateTimeFormat("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(item.lastProcessedAt))}）。` };
    if (!auth.lastGmailNotificationAt) return { tone: "ready", label: "通知待ち", message: "Gmail監視は開始済みです。Cloudflareへ最初の受信通知が届くのを待っています。" };
    return { tone: "ready", label: "待機中", message: `Gmail通知を受信済みです（最終 ${new Intl.DateTimeFormat("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(auth.lastGmailNotificationAt))}）。条件に一致する新着メールを待っています。` };
  };

  const applySavedRule = (item: SavedRule) => {
    setRuleId(item.id);
    setRuleName(item.name);
    setSender(item.sender || "");
    setSubject(item.sender ? "" : item.subjectContains);
    setConditionMode(item.sender ? "sender" : "subject");
    setRules(item.fields);
    setSelectedRuleId(item.fields[0]?.id ?? 1);
    setSpreadsheetInput(item.spreadsheetId);
    setSheetName(item.sheetName);
    setMappings(Object.fromEntries(Object.entries(item.mappings).map(([key, value]) => [Number(key), value])));
    setAutoAdd(item.active);
    setSheetInfo(item.spreadsheetId ? {
      spreadsheetId: item.spreadsheetId,
      spreadsheetName: item.spreadsheetName || "Spreadsheet",
      sheetName: item.sheetName,
      sheets: item.sheetName ? [item.sheetName] : [],
      headers: item.sheetHeaders || [],
    } : null);
    setSheetConnection(item.spreadsheetId && item.sheetName ? { state: "checking", message: "接続を確認中…" } : { state: "idle", message: "" });
    setNotice(null);
    setSaved(true);
  };

  useEffect(() => {
    if (!live) return;
    let active = true;
    Promise.all([
      apiFetch<AuthStatus>("/api/auth/status"),
      apiFetch<{ ok: true; rules: SavedRule[] }>("/api/rules"),
    ]).then(([status, stored]) => {
      if (!active) return;
      setAuth(status);
      setSavedRules(stored.rules);
      if (stored.rules[0]) applySavedRule(stored.rules[0]);
    }).catch((error: unknown) => {
      if (active) setNotice({ kind: "warning", text: errorText(error) });
    });
    return () => { active = false; };
  }, [live]);

  useEffect(() => {
    if (!live || watchRepairAttempted.current || !auth?.connected || !auth.gmailPushConfigured || auth.gmailWatchActive || !savedRules.some((item) => item.active)) return;
    watchRepairAttempted.current = true;
    postJson<{ ok: true; expiration: number }>("/api/gmail/watch", {})
      .then((response) => {
        setAuth((current) => current ? { ...current, gmailWatchActive: true, gmailWatchExpiresAt: response.expiration } : current);
        setNotice({ kind: "success", text: "停止していたGmail受信監視を再開しました。新着メールを待機しています。" });
        onDataChanged?.();
      })
      .catch((error: unknown) => {
        setNotice({ kind: "warning", text: errorText(error) });
        onDataChanged?.();
      });
  }, [live, auth?.connected, auth?.gmailPushConfigured, auth?.gmailWatchActive, savedRules, onDataChanged]);

  const markChanged = () => {
    setTestStatus("idle");
    setSaved(false);
    setNotice(null);
  };

  const startNewRule = () => {
    if (savedRules.length >= 10) {
      setNotice({ kind: "warning", text: "転記ルールは10件まで登録できます。不要なルールを削除してから新規作成してください。" });
      scrollToRef(savedRulesRef);
      return;
    }
    setRuleId(null);
    setRuleName("新しい転記ルール");
    setSender("");
    setSubject("");
    setConditionMode("sender");
    setRules([]);
    setSelectedRuleId(0);
    setMappings({});
    setSpreadsheetInput("");
    setSheetName("");
    setSheetInfo(null);
    setSheetConnection({ state: "idle", message: "" });
    setGmailMessages([]);
    setAutoAdd(false);
    setTestStatus("idle");
    setSaved(false);
    setNotice({ kind: "success", text: "新しい転記ルールを作成しました。メール本文から必要な値を選ぶか、「項目を追加」を押してください。" });
  };

  const applyTemplate = (template: "recruit" | "inquiry" | "order" | "reservation" | "invoice") => {
    const templates = {
      recruit: {
        name: "求人応募メール", subject: "新しい応募", body: sampleEmail,
        fields: initialRules,
      },
      inquiry: {
        name: "お問い合わせメール", subject: "お問い合わせ", body: "新しいお問い合わせです。\n\n会社名：青空商事\n氏名：佐藤 花子\nメール：hanako@example.com\nお問い合わせ内容：資料送付を希望します",
        fields: [
          { id: 1, name: "会社名", method: "after" as const, start: "会社名：", end: "", pattern: "" },
          { id: 2, name: "氏名", method: "after" as const, start: "氏名：", end: "", pattern: "" },
          { id: 3, name: "メール", method: "email" as const, start: "メール：", end: "", pattern: "" },
          { id: 4, name: "お問い合わせ内容", method: "after" as const, start: "お問い合わせ内容：", end: "", pattern: "" },
        ],
      },
      order: {
        name: "注文通知メール", subject: "注文完了", body: "新しい注文が入りました。\n\n注文番号：ORD-1042\n商品名：オリジナルマグカップ\n数量：2\n金額：5,600円",
        fields: [
          { id: 1, name: "注文番号", method: "after" as const, start: "注文番号：", end: "", pattern: "" },
          { id: 2, name: "商品名", method: "after" as const, start: "商品名：", end: "", pattern: "" },
          { id: 3, name: "数量", method: "number" as const, start: "数量：", end: "", pattern: "" },
          { id: 4, name: "金額", method: "money" as const, start: "金額：", end: "", pattern: "" },
        ],
      },
      reservation: {
        name: "予約通知メール", subject: "予約確定", body: "予約を受け付けました。\n\n氏名：鈴木 一郎\n予約日時：2026/09/10 18:30\n人数：3\nコース：ディナーコース",
        fields: [
          { id: 1, name: "氏名", method: "after" as const, start: "氏名：", end: "", pattern: "" },
          { id: 2, name: "予約日時", method: "date" as const, start: "予約日時：", end: "", pattern: "" },
          { id: 3, name: "人数", method: "number" as const, start: "人数：", end: "", pattern: "" },
          { id: 4, name: "コース", method: "after" as const, start: "コース：", end: "", pattern: "" },
        ],
      },
      invoice: {
        name: "請求通知メール", subject: "請求書", body: "請求書が発行されました。\n\n請求元：サンプル株式会社\n請求日：2026/09/02\n金額：32,800円\n支払期限：2026/09/30",
        fields: [
          { id: 1, name: "請求元", method: "after" as const, start: "請求元：", end: "", pattern: "" },
          { id: 2, name: "請求日", method: "date" as const, start: "請求日：", end: "", pattern: "" },
          { id: 3, name: "金額", method: "money" as const, start: "金額：", end: "", pattern: "" },
          { id: 4, name: "支払期限", method: "date" as const, start: "支払期限：", end: "", pattern: "" },
        ],
      },
    };
    const selected = templates[template];
    setRuleId(null);
    setRuleName(selected.name);
    setSender("");
    setSubject(selected.subject);
    setConditionMode("subject");
    setEmailMeta({ subject: selected.subject, from: "notice@example.com" });
    setEmailBody(selected.body);
    setRules(selected.fields);
    setSelectedRuleId(selected.fields[0].id);
    setMappings(Object.fromEntries(selected.fields.map((field) => [field.id, ""])));
    setSpreadsheetInput("");
    setSheetName("");
    setSheetInfo(null);
    setSheetConnection({ state: "idle", message: "" });
    setGmailMessages([]);
    setAutoAdd(false);
    setTestStatus("idle");
    setSaved(false);
    setNotice({ kind: "success", text: `${selected.name}の例を読み込みました。項目は自由に変更できます。` });
  };

  const updateRule = (patch: Partial<ExtractionRule>) => {
    markChanged();
    setRules((current) => current.map((rule) => (rule.id === selectedRuleId ? { ...rule, ...patch } : rule)));
  };

  const addRule = () => {
    const id = Math.max(0, ...rules.map((rule) => rule.id)) + 1;
    const nextRule: ExtractionRule = { id, name: `項目${id}`, method: "after", start: "項目名：", end: "", pattern: "" };
    setRules((current) => [...current, nextRule]);
    setMappings((current) => ({ ...current, [id]: sheetInfo?.headers[rules.length + 2]?.label ?? "" }));
    setSelectedRuleId(id);
    markChanged();
  };

  const addDetectedField = (detected: ReturnType<typeof detectFields>[number]) => {
    const existing = rules.find((rule) => rule.name === detected.name);
    if (existing) {
      setRules((current) => current.map((rule) => rule.id === existing.id ? { ...detected.rule, id: existing.id } : rule));
      setSelectedRuleId(existing.id);
    } else {
      const id = Math.max(0, ...rules.map((rule) => rule.id)) + 1;
      setRules((current) => [...current, { ...detected.rule, id }]);
      setMappings((current) => ({ ...current, [id]: "" }));
      setSelectedRuleId(id);
    }
    markChanged();
    scrollToRef(extractionRulesRef);
  };

  const addAllDetectedFields = () => {
    if (!detectedFields.length) return;
    const next = detectedFields.map((item, index) => ({ ...item.rule, id: index + 1 }));
    setRules(next);
    setSelectedRuleId(next[0].id);
    setMappings(Object.fromEntries(next.map((rule) => [rule.id, ""])));
    markChanged();
    setNotice({ kind: "success", text: `${next.length}項目を候補から追加しました。不要な項目は削除できます。` });
    scrollToRef(extractionRulesRef);
  };

  const captureMailText = (text: string) => {
    const id = Math.max(0, ...rules.map((rule) => rule.id)) + 1;
    const generated = ruleFromSelection(emailBody, text, id);
    if (!generated) return;
    setSelectedText(text);
    setSelectionName(generated.suggestedName);
    scrollToRef(selectionBuilderRef);
  };

  const addSelectedTextRule = () => {
    const id = Math.max(0, ...rules.map((rule) => rule.id)) + 1;
    const generated = ruleFromSelection(emailBody, selectedText, id, selectionName);
    if (!generated) {
      setNotice({ kind: "warning", text: "選択箇所からルールを作れませんでした。値だけを選び直してください。" });
      return;
    }
    setRules((current) => [...current, generated.rule]);
    setMappings((current) => ({ ...current, [id]: "" }));
    setSelectedRuleId(id);
    setSelectedText("");
    setSelectionName("");
    markChanged();
    setNotice({ kind: "success", text: `「${generated.rule.name}」を追加しました。取得条件は自動設定済みです。保存するとルールに反映されます。` });
    window.getSelection()?.removeAllRanges();
    scrollToRef(extractionRulesRef);
  };

  const removeRule = (id: number) => {
    const next = rules.filter((rule) => rule.id !== id);
    setRules(next);
    setMappings((current) => Object.fromEntries(Object.entries(current).filter(([key]) => Number(key) !== id)));
    if (selectedRuleId === id) setSelectedRuleId(next[0]?.id ?? 0);
    markChanged();
  };

  const moveRule = (id: number, direction: -1 | 1) => {
    setRules((current) => {
      const from = current.findIndex((rule) => rule.id === id);
      const to = from + direction;
      if (from < 0 || to < 0 || to >= current.length) return current;
      const copy = [...current];
      [copy[from], copy[to]] = [copy[to], copy[from]];
      return copy;
    });
    markChanged();
  };

  const dropRule = (targetId: number) => {
    const sourceId = draggedRuleId.current;
    draggedRuleId.current = null;
    if (!sourceId || sourceId === targetId) return;
    setRules((current) => {
      const sourceIndex = current.findIndex((rule) => rule.id === sourceId);
      const targetIndex = current.findIndex((rule) => rule.id === targetId);
      if (sourceIndex < 0 || targetIndex < 0) return current;
      const next = [...current];
      const [moved] = next.splice(sourceIndex, 1);
      next.splice(targetIndex, 0, moved);
      return next;
    });
    markChanged();
  };

  const selectMessage = (message: GmailMessage) => {
    setEmailBody(message.body);
    setEmailMeta({ subject: message.subject, from: message.from });
    setTestStatus("idle");
    setNotice(null);
  };

  const loadGmail = async () => {
    setBusy("gmail");
    setNotice(null);
    try {
      const params = new URLSearchParams({
        from: conditionMode === "sender" ? sender.trim() : "",
        subject: conditionMode === "subject" ? subject.trim() : "",
        limit: "8",
      });
      const response = await apiFetch<{ ok: true; messages: GmailMessage[]; matchMode?: "exact" | "close" | "recent" }>(`/api/gmail/messages?${params}`);
      setGmailMessages(response.messages);
      if (response.messages.length && response.matchMode !== "recent") {
        if (conditionMode === "sender") rememberInput("sender", sender);
        else rememberInput("subject", subject);
      }
      if (response.messages.length) scrollToRef(gmailResultsRef);
      if (response.messages[0]) {
        if (response.matchMode !== "recent") selectMessage(response.messages[0]);
        if (response.matchMode === "close") setNotice({ kind: "warning", text: "表記が近いメールを見つけました。内容を確認して選択してください。" });
        if (response.matchMode === "recent") setNotice({ kind: "warning", text: "指定した差出人を最近のメールから確認できませんでした。検索結果として最近のメールを表示しています。" });
      }
      else setNotice({ kind: "warning", text: "条件に一致するメールが見つかりませんでした。条件をゆるめて再検索してください。" });
    } catch (error) {
      setNotice({ kind: "warning", text: errorText(error) });
    } finally {
      setBusy("");
    }
  };

  const activateGmailWatch = async () => {
    setBusy("gmail");
    setNotice(null);
    try {
      const response = await postJson<{ ok: true; expiration: number }>("/api/gmail/watch", {});
      setAuth((current) => current ? { ...current, gmailWatchActive: true, gmailWatchExpiresAt: response.expiration } : current);
      setNotice({ kind: "success", text: "Gmailの受信通知を開始しました。自動転記ONの保存ルールが新着メールの受信時に動きます。" });
    } catch (error) {
      setNotice({ kind: "warning", text: errorText(error) });
    } finally {
      setBusy("");
    }
  };

  const inspectSpreadsheet = useCallback(async (preferredSheet = sheetName, quiet = false) => {
    const enteredSpreadsheet = spreadsheetInput.trim();
    setSheetConnection({ state: "checking", message: "Google Sheetsへの接続を確認中…" });
    try {
      const response = await postJson<{ ok: true } & SheetInfo>("/api/sheets/inspect", {
        spreadsheetId: spreadsheetInput,
        sheetName: preferredSheet,
      });
      const info: SheetInfo = response;
      setSheetInfo(info);
      setSpreadsheetInput(info.spreadsheetId);
      setSheetName(info.sheetName);
      rememberInput("spreadsheet", enteredSpreadsheet || info.spreadsheetId, `${info.spreadsheetName} / ${info.sheetName}`);
      setMappings((current) => Object.fromEntries(rulesRef.current.map((rule, index) => {
        const exact = info.headers.find((header) => header.label === rule.name)?.label;
        return [rule.id, exact || current[rule.id] || info.headers[index + 2]?.label || ""];
      })));
      setSheetConnection({ state: "connected", message: `接続済み：${info.spreadsheetName} / ${info.sheetName}` });
      if (!quiet) setNotice({ kind: "success", text: `「${info.spreadsheetName} / ${info.sheetName}」へ接続できました。` });
    } catch (error) {
      const message = errorText(error);
      setSheetInfo(null);
      setSheetConnection({ state: "error", message: `接続できません：${message}` });
      if (!quiet) setNotice({ kind: "warning", text: message });
    }
  }, [sheetName, spreadsheetInput, rememberInput]);

  useEffect(() => {
    if (!live || !auth?.connected || !spreadsheetInput.trim()) {
      return;
    }
    const timer = window.setTimeout(() => { void inspectSpreadsheet(sheetName, true); }, 700);
    return () => window.clearTimeout(timer);
  }, [live, auth?.connected, spreadsheetInput, sheetName, inspectSpreadsheet]);

  const writeSheetHeaders = async () => {
    const response = await postJson<{ ok: true } & SheetInfo>("/api/sheets/headers", {
      spreadsheetId: sheetInfo?.spreadsheetId || spreadsheetInput,
      sheetName,
      fieldNames: rules.map((rule) => rule.name),
    });
    const info: SheetInfo = response;
    const nextMappings = Object.fromEntries(rules.map((rule, index) => [rule.id, info.headers[index + 2]?.label || ""]));
    setSheetInfo(info);
    setMappings(nextMappings);
    setSheetConnection({ state: "connected", message: `接続済み：${info.spreadsheetName} / ${info.sheetName}` });
    return { info, mappings: nextMappings };
  };

  const autoConfigureSheet = async () => {
    setBusy("sheet");
    setNotice(null);
    try {
      await writeSheetHeaders();
      setNotice({ kind: "success", text: "1行目へ見出しを設定し、すべての取得項目を出力列へ割り当てました。" });
    } catch (error) {
      setNotice({ kind: "warning", text: errorText(error) });
    } finally {
      setBusy("");
    }
  };

  const sheetMappingsAreReady = (info: SheetInfo | null, currentMappings: Record<number, string>) => {
    if (!info || info.headers[0]?.label !== "転記日時" || info.headers[1]?.label !== "転記ルール") return false;
    const outputHeaders = new Set(info.headers.slice(2).map((header) => header.label).filter(Boolean));
    return rules.length > 0 && rules.every((rule) => outputHeaders.has(String(currentMappings[rule.id] || "").trim()));
  };

  const saveRule = async (activeOverride = autoAdd) => {
    if (!live) {
      setSaved(true);
      window.setTimeout(() => setSaved(false), 1800);
      return;
    }
    if (!rules.length) {
      setNotice({ kind: "warning", text: "取得項目を1つ以上追加してから保存してください。" });
      scrollToRef(extractionRulesRef);
      return;
    }
    setBusy("save");
    setNotice(null);
    try {
      let effectiveSheetInfo = sheetInfo;
      let effectiveMappings = mappings;
      const needsMappingSetup = activeOverride && sheetConnection.state === "connected"
        && !sheetMappingsAreReady(sheetInfo, mappings);
      if (needsMappingSetup) {
        const configured = await writeSheetHeaders();
        effectiveSheetInfo = configured.info;
        effectiveMappings = configured.mappings;
      }
      const response = await postJson<{ ok: true; rule: SavedRule; gmailWatchExpiresAt?: number | null }>("/api/rules", {
        id: ruleId,
        name: ruleName,
        sender,
        subjectContains: subject,
        fields: rules,
        spreadsheetId: effectiveSheetInfo?.spreadsheetId || spreadsheetInput,
        spreadsheetName: effectiveSheetInfo?.spreadsheetName || "",
        sheetName,
        sheetHeaders: effectiveSheetInfo?.headers || [],
        mappings: effectiveMappings,
        active: activeOverride,
      });
      setRuleId(response.rule.id);
      setAutoAdd(response.rule.active);
      if (response.rule.active && response.gmailWatchExpiresAt) {
        setAuth((current) => current ? { ...current, gmailWatchActive: true, gmailWatchExpiresAt: response.gmailWatchExpiresAt || null } : current);
      }
      setSaved(true);
      setSavedRules((current) => [response.rule, ...current.filter((item) => item.id !== response.rule.id)]);
      if (sender.trim()) rememberInput("sender", sender);
      if (subject.trim()) rememberInput("subject", subject);
      if (spreadsheetInput.trim()) rememberInput("spreadsheet", spreadsheetInput, `${response.rule.spreadsheetName || "Spreadsheet"}${response.rule.sheetName ? ` / ${response.rule.sheetName}` : ""}`);
      setNotice({ kind: "success", text: "抽出条件と列の紐付けを保存しました。" });
      onDataChanged?.();
      scrollToRef(savedRulesRef);
    } catch (error) {
      setNotice({ kind: "warning", text: errorText(error) });
    } finally {
      setBusy("");
    }
  };

  const setStoredRuleActive = async (item: SavedRule, active: boolean) => {
    if (active && ruleId === item.id) {
      await saveRule(true);
      return;
    }
    setBusy("save");
    setNotice(null);
    try {
      const response = await postJson<{ ok: true; rule: SavedRule; gmailWatchExpiresAt?: number | null }>("/api/rules", { ...item, active });
      setSavedRules((current) => current.map((rule) => rule.id === item.id ? response.rule : rule));
      if (ruleId === item.id) {
        setAutoAdd(response.rule.active);
        setSaved(true);
      }
      if (active && response.gmailWatchExpiresAt) {
        setAuth((current) => current ? { ...current, gmailWatchActive: true, gmailWatchExpiresAt: response.gmailWatchExpiresAt || null } : current);
      }
      setNotice({ kind: "success", text: `「${item.name}」の新着メール自動転記を${active ? "ON" : "OFF"}にしました。` });
      onDataChanged?.();
    } catch (error) {
      setNotice({ kind: "warning", text: errorText(error) });
    } finally {
      setBusy("");
    }
  };

  const deleteStoredRule = async (item: SavedRule) => {
    if (!window.confirm(`「${item.name}」を削除しますか？\nスプレッドシートへ転記済みの行は削除されません。`)) return;
    setBusy("save");
    setNotice(null);
    try {
      await apiFetch<{ ok: true }>(`/api/rules/${item.id}`, { method: "DELETE" });
      const remaining = savedRules.filter((rule) => rule.id !== item.id);
      setSavedRules(remaining);
      if (ruleId === item.id) {
        if (remaining[0]) applySavedRule(remaining[0]);
        else startNewRule();
      }
      setNotice({ kind: "success", text: `「${item.name}」を削除しました。転記済みの行はそのまま残ります。` });
      onDataChanged?.();
    } catch (error) {
      setNotice({ kind: "warning", text: errorText(error) });
    } finally {
      setBusy("");
    }
  };

  const testWrite = async () => {
    if (hasMissingResult) {
      setNotice({ kind: "warning", text: "抽出できていない項目があります。先にルールを調整してください。" });
      return;
    }
    setBusy("write");
    setNotice(null);
    try {
      const values = sheetInfo?.headers.length
        ? sheetInfo.headers.slice(2).map((header) => results.find(({ rule }) => mappings[rule.id] === header.label)?.value || "")
        : results.map((item) => item.value);
      const response = await postJson<{ ok: true; updatedRange: string }>("/api/sheets/test", {
        ruleId,
        spreadsheetId: sheetInfo?.spreadsheetId || spreadsheetInput,
        sheetName,
        ruleName,
        values,
        subject: emailMeta.subject,
        destination: `${sheetInfo?.spreadsheetName || "Spreadsheet"} / ${sheetName}`,
      });
      setNotice({ kind: "success", text: `テスト行を書き込みました${response.updatedRange ? `（${response.updatedRange}）` : ""}。` });
      onDataChanged?.();
    } catch (error) {
      setNotice({ kind: "warning", text: errorText(error) });
    } finally {
      setBusy("");
    }
  };

  const runRule = async () => {
    if (!ruleId) {
      setNotice({ kind: "warning", text: "先にルールを保存してください。" });
      return;
    }
    setBusy("run");
    setNotice(null);
    try {
      const response = await postJson<{ ok: true; result: { success: number; review: number; skipped: number } }>(`/api/rules/${ruleId}/run`, {});
      setNotice({
        kind: response.result.review ? "warning" : "success",
        text: `同期完了：成功 ${response.result.success}件 / 要確認 ${response.result.review}件 / 処理済み ${response.result.skipped}件`,
      });
      onDataChanged?.();
    } catch (error) {
      setNotice({ kind: "warning", text: errorText(error) });
    } finally {
      setBusy("");
    }
  };

  const mappingOptions = sheetInfo?.headers.length
    ? sheetInfo.headers.slice(2).map((header) => ({ value: header.label, label: `${header.column}列：${header.label}` }))
    : embedded
      ? ["C", "D", "E", "F", "G", "H"].map((column) => ({ value: `${column}列`, label: `${column}列` }))
      : [{ value: "", label: "見出し取得後に選択" }];

  const hasSearchCondition = conditionMode === "sender" ? Boolean(sender.trim()) : Boolean(subject.trim());
  const mappingsComplete = sheetMappingsAreReady(sheetInfo, mappings);
  const nextGuide = !auth?.connected
    ? { step: "01", title: "Googleアカウントを接続", detail: "Gmailの読取とGoogle Sheetsへの書込を許可します。", target: "connection" }
    : !hasSearchCondition
      ? { step: "01", title: "対象メールの条件を入力", detail: "差出人または件名の、どちらか分かりやすい方を入力します。", target: "condition" }
      : !gmailMessages.length
        ? { step: "01", title: "一致する実メールを検索", detail: "入力した条件でGmailを検索し、サンプルにするメールを選びます。", target: "condition" }
        : selectedText
          ? { step: "02", title: "選択した文字に項目名を付ける", detail: "シートで使う項目名を確認して、取得項目へ追加します。", target: "selection" }
          : !rules.length
            ? { step: "03", title: "取得項目を追加", detail: "本文から値を選択するか、「項目を追加」を押して最初の取得項目を作ります。", target: "rules" }
          : !spreadsheetInput.trim()
            ? { step: "04", title: "転記先のSpreadsheetを指定", detail: "URLを貼ると、接続とシート名を自動確認します。", target: "mapping" }
            : sheetConnection.state !== "connected"
              ? { step: "04", title: "Spreadsheetの接続を確認", detail: "接続結果が表示されるまで待つか、URLとシート名を確認します。", target: "mapping" }
              : !mappingsComplete
                ? { step: "04", title: "1行目と出力列を自動設定", detail: "A列を転記日時、B列を転記ルール、C列以降を取得項目としてまとめて設定します。", target: "mapping" }
                : !saved
                  ? { step: "05", title: "ルールを保存", detail: "抽出条件と出力列の設定を保存します。", target: "test" }
                  : !autoAdd
                    ? { step: "06", title: "新着メールの自動転記をONにする", detail: "保存済みルールの「自動転記ON」を押すと、その後に届くメールの自動転記が始まります。", target: "saved" }
                    : { step: "完了", title: "設定は完了しています", detail: "条件に一致する新着メールを受信すると、自動で転記します。", target: "saved" };

  const goToNextGuide = () => {
    if (nextGuide.target === "connection") window.location.assign("/api/oauth/google/start");
    else if (nextGuide.target === "condition") scrollToRef(mailConditionRef);
    else if (nextGuide.target === "selection") scrollToRef(selectionBuilderRef);
    else if (nextGuide.target === "rules") scrollToRef(extractionRulesRef);
    else if (nextGuide.target === "mapping") scrollToRef(mappingSectionRef);
    else if (nextGuide.target === "test") scrollToRef(testSectionRef);
    else scrollToRef(savedRulesRef);
  };

  return (
    <div className={embedded ? "rule-workbench rule-workbench--embedded" : "rule-workbench"}>
      <div className="workbench-topbar">
        <div>
          <span className="workbench-kicker">{ruleId ? `RULE ${String(ruleId).padStart(2, "0")}` : "NEW RULE"}</span>
          {live ? <><input className="rule-name-input" value={ruleName} onChange={(event) => { setRuleName(event.target.value); markChanged(); }} aria-label="転記ルール名" /><small className="rule-name-note">この名前をSpreadsheetのB列へ出力します</small></> : <strong>{ruleName}</strong>}
        </div>
        <div className="workbench-topbar__actions">
          {live ? <button type="button" className="button button--small button--outline" onClick={startNewRule} disabled={savedRules.length >= 10}><Icon name="plus" size={16} /> 新規作成</button> : null}
          <span className={autoAdd ? "switch-control is-on" : "switch-control"} title={live ? "ONで保存すると、これから届く条件一致メールを自動で転記します。" : undefined}>
            <span>新着メールを自動転記<small>{autoAdd ? "ON：受信後に自動で処理" : "OFF：手動操作のみ"}</small></span>
            <button type="button" onClick={() => { setAutoAdd((value) => !value); markChanged(); }} aria-label="新着メールの自動転記を切り替える" aria-pressed={autoAdd}><i /></button>
          </span>
          <button type="button" className="button button--small button--outline" onClick={() => saveRule()} disabled={Boolean(busy)}>
            {busy === "save" ? "保存中…" : saved ? "保存済み ✓" : "下書き保存"}
          </button>
        </div>
      </div>

      {live ? (
        <div className="live-mode-strip">
          <span className={auth?.connected ? "status-dot is-success" : "status-dot"}>{auth?.connected ? "✓" : "!"}</span>
          <p>{auth?.connected ? `${auth.googleEmail} のGmail / Sheetsを使用` : auth?.configured === false ? "Google CloudのOAuth設定が必要です" : "Googleアカウントを接続すると実メールを選べます"}</p>
          {!auth?.connected ? <a href="/api/oauth/google/start">Googleで接続 →</a> : null}
        </div>
      ) : null}

      {live ? (
        <aside className={autoAdd && saved ? "next-action-guide is-complete" : "next-action-guide"} aria-live="polite">
          <span>NEXT {nextGuide.step}</span>
          <div><strong>{nextGuide.title}</strong><p>{nextGuide.detail}</p></div>
          <button type="button" onClick={goToNextGuide}>{autoAdd && saved ? "設定を見る" : "次へ進む"} →</button>
        </aside>
      ) : null}

      {live && savedRules.length ? (
        <section ref={savedRulesRef} className="saved-rules-manager" aria-label="保存済みルール管理">
          <div className="saved-rules-manager__heading">
            <div><span>SAVED RULES</span><strong>保存済みルール {savedRules.length}/10件</strong><small>自動転記ON {savedRules.filter((item) => item.active).length}/3件</small></div>
          </div>
          <div className="saved-rules-list">
            {savedRules.map((item) => {
              const health = ruleHealth(item);
              return (
                <article className={ruleId === item.id ? "saved-rule-card is-selected" : "saved-rule-card"} key={item.id}>
                  <div className="saved-rule-card__main">
                    <div className="saved-rule-card__title">
                      <strong>{item.name}</strong>
                      <span className={item.active ? "rule-status is-on" : "rule-status"}>{item.active ? "自動転記 ON" : "停止中"}</span>
                      <span className={`rule-health is-${health.tone}`}>{health.label}</span>
                    </div>
                    <p>{item.sender || "送信元指定なし"} ／ {item.subjectContains ? `件名「${item.subjectContains}」` : "件名指定なし"}</p>
                    <small>{item.spreadsheetName || "Spreadsheet未設定"}{item.sheetName ? ` / ${item.sheetName}` : ""} ・ 取得項目 {item.fields.length}件</small>
                    <div className={`rule-diagnostic is-${health.tone}`}><strong>{health.message}</strong>{!item.sender && !item.subjectContains ? <span>対象条件が空欄のため、すべての受信メールが検索対象です。</span> : null}</div>
                  </div>
                  <div className="saved-rule-card__actions">
                    <button type="button" onClick={() => applySavedRule(item)}>開く</button>
                    {item.active && auth?.gmailPushConfigured && !auth.gmailWatchActive ? <button type="button" onClick={() => void activateGmailWatch()}>監視開始</button> : null}
                    <button type="button" onClick={() => void setStoredRuleActive(item, !item.active)}>{item.active ? "自動転記を停止" : "自動転記ON"}</button>
                    <button type="button" className="is-danger" onClick={() => void deleteStoredRule(item)}>削除</button>
                  </div>
                </article>
              );
            })}
          </div>
        </section>
      ) : null}

      {live ? (
        <aside className="rule-ownership-note">
          <span>ANY MAIL TYPE</span>
          <div><strong>用途別の例から始めて、取得項目を自由に変更できます。</strong><p>求人応募の「氏名・求人・応募日時」も残しながら、問い合わせ・注文・予約・請求などへ切り替えられます。</p></div>
          <div className="rule-template-picker" aria-label="用途別テンプレート">
            <button type="button" onClick={() => applyTemplate("recruit")}>求人応募</button>
            <button type="button" onClick={() => applyTemplate("inquiry")}>問い合わせ</button>
            <button type="button" onClick={() => applyTemplate("order")}>注文</button>
            <button type="button" onClick={() => applyTemplate("reservation")}>予約</button>
            <button type="button" onClick={() => applyTemplate("invoice")}>請求</button>
          </div>
        </aside>
      ) : null}

      {notice ? <div className={`workbench-notice is-${notice.kind}`} role="status">{notice.text}</div> : null}

      <section ref={mailConditionRef} className="mail-condition" aria-labelledby="condition-title">
        <div className="section-mini-heading">
          <span>01</span>
          <div><small>TARGET MAIL</small><h3 id="condition-title">対象メールを決める</h3></div>
        </div>
        <div className="condition-mode-tabs" role="tablist" aria-label="メールの探し方">
          <button type="button" role="tab" aria-selected={conditionMode === "sender"} className={conditionMode === "sender" ? "is-active" : ""} onClick={() => { setConditionMode("sender"); setSubject(""); markChanged(); }}>差出人（From）で探す</button>
          <button type="button" role="tab" aria-selected={conditionMode === "subject"} className={conditionMode === "subject" ? "is-active" : ""} onClick={() => { setConditionMode("subject"); setSender(""); markChanged(); }}>件名で探す</button>
        </div>
        <div className="condition-fields">
          {conditionMode === "sender" ? (
            <div className="suggestion-field">
              <label><span>差出人のメールアドレス、または表示名</span><input value={sender} onChange={(event) => { setSender(event.target.value); markChanged(); }} placeholder="notice@example.com" autoComplete="off" /></label>
              {live ? <InputSuggestions options={senderSuggestions} value={sender} onSelect={(value) => { setSender(value); markChanged(); }} /> : null}
            </div>
          ) : (
            <div className="suggestion-field">
              <label><span>件名に含まれる文字</span><input value={subject} onChange={(event) => { setSubject(event.target.value); markChanged(); }} placeholder="例：新しい応募" autoComplete="off" /></label>
              {live ? <InputSuggestions options={subjectSuggestions} value={subject} onSelect={(value) => { setSubject(value); markChanged(); }} /> : null}
            </div>
          )}
          {live ? <button type="button" className="condition-search-button" onClick={loadGmail} disabled={!auth?.connected || Boolean(busy)}>{busy === "gmail" ? "検索中…" : "一致する実メールを探す"}</button> : null}
        </div>
        {live && gmailMessages.length ? (
          <div ref={gmailResultsRef} className="gmail-sample-list" aria-label="一致したGmail">
            {gmailMessages.map((message) => (
              <button key={message.id} type="button" onClick={() => { selectMessage(message); scrollToRef(mailPreviewRef); }} className={emailMeta.subject === message.subject && emailBody === message.body ? "is-selected" : undefined}>
                <strong>{message.subject}</strong><span>{message.from}</span><small>{message.snippet}</small>
              </button>
            ))}
          </div>
        ) : null}
      </section>

      <section className="rule-editor-grid" aria-labelledby="rules-title">
        <div ref={mailPreviewRef} className="mail-preview-pane">
          <div className="section-mini-heading"><span>02</span><div><small>SAMPLE MAIL</small><h3>メールを確認</h3></div></div>
          <p className="selection-guide"><strong>本文中の値をドラッグして選択</strong><span>スマホは長押しで選べます。周囲の見出しから取得ルールを自動作成します。</span></p>
          <EmailDocument body={emailBody} rules={rules} subject={emailMeta.subject} from={emailMeta.from} onTextSelect={captureMailText} />
          {selectedText ? (
            <div ref={selectionBuilderRef} className="selection-rule-builder" role="status">
              <span>選択した文字</span>
              <strong>{selectedText}</strong>
              <label><span>シートの項目名</span><input value={selectionName} onChange={(event) => setSelectionName(event.target.value)} placeholder="例：氏名、注文番号" /></label>
              <div><button type="button" onClick={addSelectedTextRule} disabled={!selectionName.trim()}>この文字を取得項目にする</button><button type="button" className="is-cancel" onClick={() => { setSelectedText(""); setSelectionName(""); }}>キャンセル</button></div>
              <small>値そのものではなく、前後の見出し・区切りから再利用できる取得条件を作ります。</small>
            </div>
          ) : null}
          <div className="detected-fields">
            <div className="detected-fields__heading"><div><strong>本文から見つかった項目</strong><small>クリックすると取得項目へ追加されます</small></div><button type="button" onClick={addAllDetectedFields} disabled={!detectedFields.length}>すべて追加</button></div>
            {detectedFields.length ? <div className="detected-fields__list">{detectedFields.slice(0, 12).map((item, index) => <button type="button" key={`${item.name}-${index}`} onClick={() => addDetectedField(item)}><span>{item.name}</span><strong>{item.value}</strong><i>＋</i></button>)}</div> : <p className="detected-fields__empty">自動判定できる項目がありません。右側の「項目を追加」から指定できます。</p>}
          </div>
          <details className="email-edit-details">
            <summary>{live ? "サンプル本文を手動で調整" : "サンプルメールを編集"}</summary>
            <textarea value={emailBody} onChange={(event) => { setEmailBody(event.target.value); setTestStatus("idle"); }} />
          </details>
          {live ? <p className="privacy-inline">この本文はプレビューとテストにだけ使用し、抽出ルール保存時には保存しません。</p> : null}
        </div>

        <div className="rule-pane">
          <div className="section-mini-heading"><span>03</span><div><small>EXTRACT RULES</small><h3 id="rules-title">取得項目を自由に指定</h3></div></div>
          <p className="rule-reorder-hint">↕ 左のハンドルをつかんで、項目を上下に並び替えられます。</p>
          <section ref={extractionRulesRef} className="rule-list" role="list" aria-label="抽出項目一覧">
            {!rules.length ? <p className="rule-list-empty">取得項目はまだありません。本文から値を選択するか、下の「項目を追加」を押してください。</p> : null}
            {rules.map((rule, index) => {
              const value = extractValue(emailBody, rule);
              return (
                <div key={rule.id} data-rule-id={rule.id} className={selectedRuleId === rule.id ? "rule-list-item is-selected" : "rule-list-item"} role="listitem" onDragOver={(event) => event.preventDefault()} onDrop={() => dropRule(rule.id)}>
                  <span className="rule-drag-handle" draggable onDragStart={() => { draggedRuleId.current = rule.id; }} onDragEnd={() => { draggedRuleId.current = null; }} title="つかんで並び替え" aria-label={`${rule.name}をドラッグして並び替え`}>↕</span>
                  <button type="button" className="rule-list-item__main" onClick={() => setSelectedRuleId(rule.id)}>
                    <i>{String(index + 1).padStart(2, "0")}</i><span><strong>{rule.name}</strong><small>{value || "未抽出"}</small></span><em className={value ? "status-dot is-success" : "status-dot"}>{value ? "✓" : "!"}</em>
                  </button>
                  <span className="rule-order-actions">
                    <button type="button" onClick={() => moveRule(rule.id, -1)} disabled={index === 0} aria-label={`${rule.name}を上へ`}><Icon name="up" size={15} /></button>
                    <button type="button" onClick={() => moveRule(rule.id, 1)} disabled={index === rules.length - 1} aria-label={`${rule.name}を下へ`}><Icon name="down" size={15} /></button>
                    <button type="button" onClick={() => removeRule(rule.id)} aria-label={`${rule.name}を削除`}><Icon name="trash" size={15} /></button>
                  </span>
                </div>
              );
            })}
          </section>
          <button type="button" className="add-rule-button" onClick={addRule}><Icon name="plus" size={17} /> 項目を追加</button>

          {selectedRule ? (
            <div className="rule-form">
              <label><span>抽出項目名（自由入力）</span><input value={selectedRule.name} onChange={(event) => updateRule({ name: event.target.value })} placeholder="例：注文番号、予約日時、会社名、金額" /></label>
              <label><span>取り出し方法</span><select value={selectedRule.method} onChange={(event) => updateRule({ method: event.target.value as ExtractionMethod })}>{Object.entries(methodLabels).map(([value, label]) => <option key={value} value={value} disabled={value === "regex"}>{label}</option>)}</select></label>
              {selectedRule.method !== "regex" ? (
                <div className="marker-fields">
                  <label><span>{selectedRule.method === "between" ? "最初の文字" : "この文字の後ろ"}</span><input value={selectedRule.start} onChange={(event) => updateRule({ start: event.target.value })} /></label>
                  {selectedRule.method === "between" ? <label><span>終わりの文字</span><input value={selectedRule.end} onChange={(event) => updateRule({ end: event.target.value })} /></label> : null}
                </div>
              ) : null}
              <div className="live-result"><span>プレビュー</span><strong>{extractValue(emailBody, selectedRule) || "抽出できませんでした"}</strong><i className={extractValue(emailBody, selectedRule) ? "is-success" : "is-warning"}>{extractValue(emailBody, selectedRule) ? "✓" : "!"}</i></div>
              {selectedRule.method === "regex" ? <p className="automatic-rule-note">本文で選択した位置から、取得条件を自動設定しています。</p> : null}
            </div>
          ) : null}
        </div>
      </section>

      <section ref={mappingSectionRef} className="mapping-section" aria-labelledby="mapping-title">
        <div className="section-mini-heading"><span>04</span><div><small>GOOGLE SHEETS</small><h3 id="mapping-title">出力先をつなぐ</h3></div></div>
        <div className="mapping-layout">
          <div className="sheet-selector">
            {live ? (
              <>
                <div className="suggestion-field">
                  <label><span>Spreadsheet URL</span><input value={spreadsheetInput} onChange={(event) => { setSpreadsheetInput(event.target.value); setSheetInfo(null); setSheetConnection({ state: event.target.value ? "checking" : "idle", message: event.target.value ? "入力が終わると自動確認します…" : "" }); markChanged(); }} placeholder="https://docs.google.com/spreadsheets/d/…" autoComplete="off" /></label>
                  <InputSuggestions options={spreadsheetSuggestions} value={spreadsheetInput} onSelect={(value) => { setSpreadsheetInput(value); setSheetInfo(null); setSheetConnection({ state: "checking", message: "保存した入力から接続を確認中…" }); markChanged(); }} />
                </div>
                <label><span>シート名</span>{sheetInfo?.sheets.length ? <select value={sheetName} onChange={(event) => { setSheetName(event.target.value); setSheetConnection({ state: "checking", message: "接続を確認中…" }); markChanged(); }}>{sheetInfo.sheets.map((name) => <option key={name}>{name}</option>)}</select> : <input value={sheetName} onChange={(event) => { setSheetName(event.target.value); setSheetConnection({ state: "checking", message: "入力が終わると自動確認します…" }); markChanged(); }} placeholder="例：応募一覧" />}</label>
                {sheetConnection.state !== "idle" ? <div className={`sheet-connection-status is-${sheetConnection.state}`} role="status"><i>{sheetConnection.state === "connected" ? "✓" : sheetConnection.state === "error" ? "!" : "…"}</i><span>{sheetConnection.message}</span></div> : null}
              </>
            ) : (
              <><label><span>Spreadsheet</span><select defaultValue="採用管理"><option>採用管理</option><option>営業管理</option></select></label><label><span>Sheet</span><select defaultValue="応募一覧"><option>応募一覧</option><option>要確認</option></select></label><label className="checkbox-label"><input type="checkbox" defaultChecked /> 1行目を見出しとして取得</label></>
            )}
          </div>
          <div className="mapping-list">
            <div className="mapping-list__fixed">
              <span>転記日時</span><Icon name="arrow" size={18} />
              <strong>A列へ自動入力</strong>
            </div>
            <div className="mapping-list__fixed">
              <span>転記ルール</span><Icon name="arrow" size={18} />
              <strong>B列へ「{ruleName || "ルール名"}」を自動入力</strong>
            </div>
            {rules.map((rule) => (
              <div key={rule.id}>
                <span>{rule.name}</span><Icon name="arrow" size={18} />
                <select value={mappings[rule.id] ?? ""} onChange={(event) => { setMappings((current) => ({ ...current, [rule.id]: event.target.value })); markChanged(); }} aria-label={`${rule.name}の出力列`}>
                  <option value="">出力列を選択</option>
                  {mappingOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
              </div>
            ))}
          </div>
        </div>
        {live && sheetConnection.state === "connected" && !mappingsComplete ? <div className="mapping-auto-setup"><div><strong>列が足りない、または未割当の項目があります。</strong><span>既存の1行目を「転記日時＋転記ルール＋取得項目」に整え、列を自動で割り当てます。</span></div><button type="button" onClick={autoConfigureSheet} disabled={Boolean(busy)}>{busy === "sheet" ? "設定中…" : "1行目と列を自動設定"}</button></div> : null}
        <p className="mapping-timestamp-note">A列は「転記日時」、B列は編集可能な「転記ルール名」専用です。取得項目はC列以降へ出力します。</p>
        {live ? <div className="sheet-actions"><button type="button" className="button button--blue" onClick={testWrite} disabled={Boolean(busy) || sheetConnection.state !== "connected"}>{busy === "write" ? "書き込み中…" : "この内容をテスト書き込み"}</button><button type="button" className="button button--outline" onClick={runRule} disabled={Boolean(busy) || !ruleId || sheetConnection.state !== "connected"}>{busy === "run" ? "転記中…" : "一致メールを手動で転記"}</button></div> : null}
      </section>

      <section ref={testSectionRef} className="test-section" aria-labelledby="test-title">
        <div><small>FINAL CHECK</small><h3 id="test-title">抽出結果を確認</h3><p>保存前に、必要な値が正しく取り出せるか確認します。</p></div>
        <button type="button" className="button button--red" onClick={() => { setTestStatus("complete"); scrollToRef(testSectionRef); }}><Icon name="play" size={18} /> このメールでテストする</button>
        {testStatus === "complete" ? (
          <div className="test-results" aria-live="polite">
            {results.map(({ rule, value }) => <div key={rule.id} className={value ? "test-result is-success" : "test-result is-warning"}><span>{rule.name}</span><strong>{value || "抽出できませんでした"}</strong><i>{value ? "✓" : "⚠"}</i></div>)}
            <div className="test-action-row">
              <button type="button" className="button button--outline" onClick={() => saveRule()} disabled={Boolean(busy)}>{busy === "save" ? "保存中…" : "ルールを保存"}</button>
              {!live ? <button type="button" className="button button--blue" onClick={() => setSaved(true)}>テスト結果を保存</button> : null}
            </div>
            {live ? <div className={auth?.gmailWatchActive && !autoAdd ? "automation-note is-warning" : "automation-note"}><p>{auth?.gmailWatchActive && autoAdd ? "受信通知と新着メールの自動転記は有効です。条件に一致する新着メールだけを転記します。" : auth?.gmailWatchActive ? "受信通知は有効です。自動転記する場合は、画面上部の「新着メールを自動転記」をONにしてルールを保存してください。" : auth?.gmailPushConfigured ? "自動転記を使う場合は、Google接続で受信通知を開始してください。" : "Google CloudでPub/Subを設定すると、新着メールを自動転記できます。"}</p>{auth?.gmailPushConfigured && !auth.gmailWatchActive ? <button type="button" onClick={activateGmailWatch} disabled={Boolean(busy)}>受信通知を開始</button> : null}</div> : null}
          </div>
        ) : null}
      </section>
    </div>
  );
}

function HistoryTable({ rows }: { rows?: ApiHistoryRow[] }) {
  const data = rows === undefined
    ? historyRows
    : rows.map((row) => ({
      time: new Intl.DateTimeFormat("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(row.receivedAt)),
      subject: row.subject,
      count: row.extractedCount,
      destination: row.destination || "—",
      status: row.status === "success" ? "成功" : row.status === "review" ? "要確認" : row.status === "failed" ? "失敗" : row.status === "received" ? "通知受信" : "転記なし",
      errorMessage: row.errorMessage,
    }));
  return (
    <div className="history-table-wrap">
      <table className="history-table">
        <thead><tr><th>受信日時</th><th>対象メール</th><th>抽出件数</th><th>出力先</th><th>状態</th></tr></thead>
        <tbody>
          {data.map((row) => (
            <tr key={`${row.time}-${row.subject}`}>
              <td data-label="受信日時">{row.time}</td>
              <td data-label="対象メール">{row.subject}{row.errorMessage ? <small className="history-error">{row.errorMessage}</small> : null}</td>
              <td data-label="抽出件数">{row.count}件</td>
              <td data-label="出力先">{row.destination}</td>
              <td data-label="状態"><span className={row.status === "成功" ? "history-status is-success" : row.status === "失敗" ? "history-status is-failed" : row.status === "通知受信" ? "history-status is-info" : row.status === "転記なし" ? "history-status is-skipped" : "history-status is-warning"}>{row.status}</span></td>
            </tr>
          ))}
          {data.length === 0 ? <tr><td colSpan={5} className="history-empty">まだ処理履歴はありません。Gmailの受信通知、テスト書き込み、手動転記の結果がここに表示されます。</td></tr> : null}
        </tbody>
      </table>
    </div>
  );
}

function LandingPage({ onOpenApp }: { onOpenApp: () => void }) {
  const [requestForm, setRequestForm] = useState({ category: "業務ツール", pain: "", currentProcess: "", desiredOutcome: "", contactEmail: "", website: "" });
  const [requestState, setRequestState] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [requestMessage, setRequestMessage] = useState("");

  useEffect(() => {
    const elements = Array.from(document.querySelectorAll<HTMLElement>("[data-reveal]"));
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      elements.forEach((element) => element.classList.add("is-visible"));
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => entries.forEach((entry) => entry.isIntersecting && entry.target.classList.add("is-visible")),
      { threshold: 0.13 },
    );
    elements.forEach((element) => observer.observe(element));
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    void postJson("/api/public/visit", {
      path: window.location.pathname,
      referrer: document.referrer,
      device: window.matchMedia("(max-width: 700px)").matches ? "mobile" : "desktop",
    }).catch(() => undefined);
  }, []);

  const submitRequest = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setRequestState("sending");
    setRequestMessage("");
    try {
      await postJson<{ ok: true }>("/api/public/feedback", requestForm);
      setRequestState("sent");
      setRequestMessage("送信しました。内容を確認し、連絡先がある場合は必要に応じてご連絡します。");
      setRequestForm((current) => ({ ...current, pain: "", currentProcess: "", desiredOutcome: "", website: "" }));
    } catch (error) {
      setRequestState("error");
      setRequestMessage(errorText(error));
    }
  };

  return (
    <div className="landing-page" id="top">
      <SiteHeader onOpenApp={onOpenApp} />

      <main>
        <section className="hero-section" aria-labelledby="hero-title">
          <div className="hero-outline-text" aria-hidden="true">MAIL<br />SHEET</div>
          <div className="hero-copy">
            <span className="eyebrow">GMAIL → GOOGLE SHEETS</span>
            <h1 id="hero-title">Gmailに届いたら、<br /><em>必要な情報だけ</em><br />シートに入る。</h1>
            <p>求人サイト・予約サイト・ECなどからGmailへ届く定型通知を読み取り、必要な項目だけGoogleスプレッドシートへ。毎日のコピー＆ペーストをなくします。</p>
            <div className="hero-actions">
              <button className="button button--red" type="button" onClick={onOpenApp}>無料で試す <Icon name="arrow" size={18} /></button>
              <a className="text-link" href="#demo"><span><Icon name="play" size={16} /></span> 操作イメージはこちら</a>
            </div>
            <small>Early Access / 現在は登録テスター向けに無料で公開中</small>
          </div>
          <HeroDemo />
          <span className="floating-note note-1">#コピペをなくす</span>
          <span className="floating-note note-2">#正規表現なしで設定</span>
          <span className="floating-note note-3">#失敗も履歴に残す</span>
          <span className="floating-note note-4">#メールは必要なものだけ</span>
          <div className="scroll-cue"><span>SCROLL</span><i>↓</i></div>
        </section>

        <section className="problem-section" id="features">
          <svg className="story-ribbon" viewBox="0 0 500 1500" preserveAspectRatio="none" aria-hidden="true">
            <path d="M250 0 C470 180 30 320 252 500 S456 850 245 1020 S45 1260 250 1500" />
          </svg>
          <div className="section-bubble section-bubble--yellow" data-reveal>
            <small>BEFORE / AFTER</small>
            <h2>まだメールを開いて、<br />シートへコピーしていますか？</h2>
          </div>
          <div className="before-after before-after--before" data-reveal>
            <span>BEFORE</span>
            <strong>6</strong><em>STEPS</em>
            <ol>
              <li>メールを開く</li><li>名前をコピー</li><li>日時をコピー</li><li>電話番号をコピー</li><li>シートを開く</li><li>貼り付ける</li>
            </ol>
          </div>
          <div className="before-after before-after--after" data-reveal>
            <span>AFTER</span>
            <strong>1</strong><em>STEP</em>
            <p><Icon name="mail" /> Gmailで受信</p>
            <i className="after-arrow">↓</i>
            <p><Icon name="sheet" /> 必要項目をシートへ</p>
          </div>
          <span className="floating-note note-5">#毎朝の転記をゼロへ</span>
        </section>

        <section className="how-section" id="how" aria-labelledby="how-title">
          <div className="how-heading" data-reveal>
            <span>HOW IT WORKS</span>
            <h2 id="how-title">むずかしい設定は、<br />表に出さない。</h2>
            <p>内部は文字列処理と正規表現。使う人には、自然な日本語だけを見せます。</p>
          </div>

          <article className="step-scene step-scene--one" data-reveal>
            <span className="step-number">01</span>
            <div className="step-copy"><small>CONNECT</small><h3>Googleを1回だけ接続</h3><p>Googleの画面で許可します。GmailのパスワードをMAILSHEETへ入力する必要はありません。</p></div>
            <div className="connect-orb">
              <span><Icon name="mail" size={30} /></span>
              <strong>Gmail</strong>
              <button type="button" onClick={onOpenApp}>Googleで接続 <Icon name="arrow" size={17} /></button>
              <small>OAuth 2.0</small>
            </div>
          </article>

          <article className="step-scene step-scene--two" data-reveal>
            <span className="step-number">02</span>
            <div className="step-copy"><small>EXTRACT</small><h3>届いたメールを1通選ぶ</h3><p>初回だけ代表メールを選び、「氏名：の後ろ」のように取り出す場所を確認します。</p></div>
            <div className="mini-rule-demo">
              <EmailDocument body={sampleEmail} />
              <div className="mini-rule-panel">
                <label><span>抽出項目</span><strong>氏名</strong></label>
                <label><span>取り出し方法</span><strong>「氏名：」の後ろ</strong></label>
                <div><span>プレビュー</span><strong>山田 太郎</strong><i>✓</i></div>
              </div>
            </div>
          </article>

          <article className="step-scene step-scene--three" data-reveal>
            <span className="step-number">03</span>
            <div className="step-copy"><small>MAP</small><h3>いつものシートへつなぐ</h3><p>既存SpreadsheetのURLを貼り、抽出した項目を出力列へ対応させます。</p></div>
            <div className="mini-map-demo">
              {["氏名", "応募求人", "応募日時", "電話番号"].map((field, index) => (
                <div key={field}><span>{field}</span><Icon name="arrow" /><strong>{String.fromCharCode(65 + index)}列</strong></div>
              ))}
              <span className="mini-map-demo__done"><Icon name="check" /> 4項目を接続</span>
            </div>
          </article>
        </section>

        <section className="demo-section" id="demo" aria-labelledby="demo-title">
          <div className="demo-section__heading" data-reveal>
            <span>TRY THE RULE EDITOR</span>
            <h2 id="demo-title">実際に、<br /><em>取ってみる。</em></h2>
            <p>項目を選び、メールを書き換え、テストまで操作できます。</p>
          </div>
          <div data-reveal><RuleWorkbench embedded /></div>
        </section>

        <section className="history-section" aria-labelledby="history-title">
          <div className="history-outline" aria-hidden="true">CHECK<br />EVERY RUN</div>
          <div className="history-heading" data-reveal>
            <span>PROCESS HISTORY</span>
            <h2 id="history-title">動いたかどうかを、<br />ちゃんと確認できる。</h2>
            <p>成功だけでなく「要確認」と失敗も残します。業務で使うものだから、処理を隠しません。</p>
          </div>
          <div className="dashboard-preview" data-reveal>
            <div className="metric-strip">
              <div><span>今日</span><strong>24</strong><small>成功</small></div>
              <div><span>今日</span><strong>1</strong><small>要確認</small></div>
              <div><span>今月</span><strong>482</strong><small>成功</small></div>
              <div><span>今月</span><strong>2</strong><small>失敗</small></div>
            </div>
            <HistoryTable />
          </div>
        </section>

        <section className="cases-section" id="cases" aria-labelledby="cases-title">
          <div className="cases-heading" data-reveal>
            <span>GMAIL RECEIVED → SHEET UPDATED</span>
            <h2 id="cases-title">Gmailの受信が、<br />転記の合図。</h2>
            <p>新しい管理画面へ入力し直す必要はありません。いま使っているサービスからGmailへ届く、書式の決まった通知メールがスタート地点です。</p>
          </div>
          <div className="case-orbits">
            {useCases.map((item, index) => (
              <article key={item.title} className={`case-orbit case-orbit-${index + 1}`} data-reveal>
                <small>{item.number}</small>
                <span className="case-source"><Icon name="mail" size={15} /> {item.source} → Gmail</span>
                <h3>{item.title}</h3>
                <p className="case-pain">{item.pain}</p>
                <div className="case-result"><b>受信したら</b><p>{item.result}</p><span><Icon name="arrow" size={15} /> {item.sheet}</span></div>
              </article>
            ))}
          </div>
        </section>

        <section className="security-section" aria-labelledby="security-title">
          <div className="security-bubble" data-reveal>
            <small>SECURITY DESIGN</small>
            <h2 id="security-title">Gmailを扱うから、<br />先に考えておくこと。</h2>
          </div>
          <div className="security-list">
            <article data-reveal><span>01</span><h3>Google OAuth 2.0</h3><p>Gmailのパスワードを預からず、Googleの認可画面から接続します。</p></article>
            <article data-reveal><span>02</span><h3>必要なメールだけ</h3><p>送信元と件名など、ユーザーが設定した条件に一致するメールだけを処理する設計です。</p></article>
            <article data-reveal><span>03</span><h3>いつでも接続解除</h3><p>自身の画面からGoogleトークンを失効させ、接続情報を削除できます。</p></article>
          </div>
          <p className="security-note">※ Gmailは読取専用、Sheetsは書込を含む権限を使用します。公開運用前にGoogleのOAuth審査とデータ保持方針の確定が必要です。</p>
        </section>

        <section className="price-section" id="price" aria-labelledby="price-title">
          <div className="price-orb" data-reveal>
            <span>FREE / EARLY ACCESS</span>
            <h2 id="price-title">まずは、<br />無料で試す。</h2>
            <p>正式料金を決める前の先行版です。抽出ルールの使いやすさを検証しています。</p>
            <strong>¥0<small> / prototype</small></strong>
            <button className="button button--blue" type="button" onClick={onOpenApp}>無料で試す <Icon name="arrow" size={18} /></button>
          </div>
          <span className="floating-note note-6">#まず1つのメールから</span>
        </section>

        <section className="faq-section" id="faq" aria-labelledby="faq-title">
          <div className="faq-heading" data-reveal><span>FAQ</span><h2 id="faq-title">よくある質問</h2></div>
          <div className="faq-list">
            {faqItems.map((item, index) => (
              <details key={item.question} data-reveal>
                <summary><i>{String(index + 1).padStart(2, "0")}</i>{item.question}<span>＋</span></summary>
                <p>{item.answer}</p>
              </details>
            ))}
          </div>
        </section>

        <section className="request-section" id="request" aria-labelledby="request-title">
          <div className="request-section__copy" data-reveal>
            <span>YOUR WORK, YOUR REQUEST</span>
            <h2 id="request-title">作ってほしいもの、<br />いま困っていること。</h2>
            <p>MAILSHEETに限らず、Webサービス・アプリ・業務ツールのご要望を募集しています。まとまっていなくても、今のやり方と困りごとだけで大丈夫です。</p>
            <ul><li>同じ入力や転記を繰り返している</li><li>既存ツールが業務に合わない</li><li>こういうWebサービスがほしい</li></ul>
          </div>
          <form className="request-form" onSubmit={submitRequest} data-reveal>
            <label><span>相談したいもの</span><select value={requestForm.category} onChange={(event) => setRequestForm((current) => ({ ...current, category: event.target.value }))}><option>Webサービス</option><option>アプリ</option><option>業務ツール</option><option>自動化</option><option>MAILSHEETへの要望</option><option>その他</option></select></label>
            <label className="request-form__wide"><span>現在、何に困っていますか？ <b>必須</b></span><textarea required minLength={5} value={requestForm.pain} onChange={(event) => setRequestForm((current) => ({ ...current, pain: event.target.value }))} placeholder="例：予約メールを毎日Excelへ手入力していて、対応漏れが起きています。" /></label>
            <label><span>いまはどう対応していますか？</span><textarea value={requestForm.currentProcess} onChange={(event) => setRequestForm((current) => ({ ...current, currentProcess: event.target.value }))} placeholder="例：担当者がメールを開いて転記" /></label>
            <label><span>どうなったら助かりますか？</span><textarea value={requestForm.desiredOutcome} onChange={(event) => setRequestForm((current) => ({ ...current, desiredOutcome: event.target.value }))} placeholder="例：受信時に自動で一覧化したい" /></label>
            <label className="request-form__wide"><span>返信先メール（任意）</span><input type="email" value={requestForm.contactEmail} onChange={(event) => setRequestForm((current) => ({ ...current, contactEmail: event.target.value }))} placeholder="you@example.com" /></label>
            <label className="request-form__trap" aria-hidden="true"><span>Website</span><input tabIndex={-1} autoComplete="off" value={requestForm.website} onChange={(event) => setRequestForm((current) => ({ ...current, website: event.target.value }))} /></label>
            <div className="request-form__submit"><button className="button button--blue" type="submit" disabled={requestState === "sending"}>{requestState === "sending" ? "送信中…" : "要望を送る"} <Icon name="arrow" size={17} /></button><small>送信内容はサービス改善とご相談への回答に使用します。</small></div>
            {requestMessage ? <p className={`request-form__message is-${requestState}`} role="status">{requestMessage}</p> : null}
          </form>
        </section>

        <section className="final-cta">
          <div className="final-cta__path" aria-hidden="true" />
          <div className="final-cta__orb" data-reveal>
            <small>MAIL → SHEET</small>
            <h2>コピペを、<br />一つ減らそう。</h2>
            <button type="button" onClick={onOpenApp}>無料で試す <Icon name="arrow" size={20} /></button>
          </div>
          <Brand />
        </section>
      </main>

      <footer className="landing-footer">
        <span>MAILSHEET / PROTOTYPE 2026</span>
        <nav aria-label="法的情報">
          <a href="/privacy">プライバシーポリシー</a>
          <a href="/terms">利用規約</a>
        </nav>
        <span>Google、Gmail、Google SheetsはGoogle LLCの商標です。</span>
      </footer>
    </div>
  );
}

type LegalKind = "privacy" | "terms";

const SUPPORT_EMAIL = import.meta.env.VITE_SUPPORT_EMAIL || "support@example.com";

const privacySections = [
  { title: "1. 取得する情報", body: <>本サービスは、Google OAuth 2.0による認証に伴い、Googleアカウントのメールアドレス、認証に必要なアクセストークンおよびリフレッシュトークンを取得します。また、利用者が設定した対象メール条件、抽出ルール、Google Sheetsの列対応、処理日時・成否などの履歴を取り扱います。公開ページでは、アクセス解析のため匿名の閲覧者ID、閲覧ページ、参照元ドメイン、端末種別、閲覧日時を取得します。IPアドレスはアクセス履歴として保存しません。要望フォームを送信した場合は、入力内容と任意の連絡先を取得します。</> },
  { title: "2. Gmailデータの取り扱い", body: <>利用者が指定した条件に合うメールの検索、抽出ルールの作成および実行に必要な範囲で、Gmailのメール本文・送信元・件名等を読み取ります。Gmailは読取専用権限を使用します。現在の仕様では、メール本文および抽出した値を継続保存せず、プレビューと処理のために一時的に利用します。</> },
  { title: "3. Google Sheetsデータの取り扱い", body: <>利用者が指定したSpreadsheetとSheetの見出しを読み取り、利用者が設定・確認した列へ抽出結果を書き込むために使用します。本サービスが利用者の操作と無関係なSpreadsheetへ書き込むことはありません。</> },
  { title: "4. 利用目的", body: <>取得した情報は、Googleアカウントとの接続、対象メールの検索、情報の抽出、Google Sheetsへの転記、処理履歴の表示、不具合調査および本サービスの提供・改善のために利用します。広告配信や取得データの販売には利用しません。</> },
  { title: "5. 第三者提供・外部サービス", body: <>法令に基づく場合を除き、利用者の同意なく個人情報を第三者へ販売または提供しません。本サービスの提供に必要な範囲でGoogle APIおよびホスティング等の事業者を利用する場合があります。Google APIから受領した情報の利用および他のアプリへの転送は、Google API Services User Data Policy（Limited Use要件を含みます）に従います。</> },
  { title: "6. 保存期間と削除", body: <>認証情報はGoogle接続の解除または本サービスの利用終了まで保持し、不要となった情報は合理的な期間内に削除します。利用者はアプリ内の設定からGoogle接続を解除できます。また、Googleアカウント側からもアクセス権を取り消せます。</> },
  { title: "7. 安全管理", body: <>認証トークンの暗号化、アクセス制限その他の合理的な安全管理措置を講じます。ただし、インターネット上の通信または保存について完全な安全性を保証するものではありません。</> },
  { title: "8. お問い合わせ", body: <>本ポリシー、データの確認・削除その他のお問い合わせは、<a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a> までご連絡ください。</> },
  { title: "9. 改定", body: <>サービス内容や法令の変更等に応じて本ポリシーを改定することがあります。重要な変更がある場合は、本サイト上でお知らせします。</> },
];

const termsSections = [
  { title: "1. 適用", body: <>本規約は、MAILSHEET（以下「本サービス」）の利用条件を定めるものです。利用者は、本規約およびプライバシーポリシーに同意したうえで本サービスを利用します。</> },
  { title: "2. サービス内容", body: <>本サービスは、利用者が指定したGmailの定型メールから情報を抽出し、指定されたGoogle Sheetsへ転記する機能を提供します。現在は検証段階の先行版であり、提供する機能、利用上限、料金および仕様を変更する場合があります。</> },
  { title: "3. Googleアカウントとの接続", body: <>利用者は自身が正当に利用するGoogleアカウントを接続し、Googleの同意画面で必要な権限を確認して許可するものとします。接続はいつでも解除できます。Googleのパスワードを本サービスへ入力する必要はありません。</> },
  { title: "4. 利用者の責任", body: <>利用者は、対象メール、抽出結果および転記先を自ら確認し、必要な権限を持つデータのみを処理するものとします。重要な業務で利用する場合は、処理履歴と転記結果を確認し、必要に応じて元データを保管してください。</> },
  { title: "5. 禁止事項", body: <>法令または第三者の権利を侵害する行為、不正アクセス、他人のアカウントの利用、サービスへ過度な負荷をかける行為、サービスの運営を妨害する行為、その他運営者が不適切と判断する行為を禁止します。</> },
  { title: "6. 利用停止・変更", body: <>保守、障害、外部サービスの仕様変更、セキュリティ上の必要その他やむを得ない事情により、本サービスの全部または一部を停止・変更することがあります。禁止事項への違反がある場合は、利用を停止できるものとします。</> },
  { title: "7. 保証および免責", body: <>本サービスは抽出結果または転記結果の完全性・正確性、特定目的への適合性、継続的な稼働を保証しません。運営者の故意または重過失がある場合を除き、本サービスの利用により生じた間接損害、逸失利益またはデータ損失について責任を負いません。</> },
  { title: "8. 知的財産権", body: <>本サービスに関するプログラム、デザイン、文章その他の権利は、運営者または正当な権利者に帰属します。利用者が入力するデータの権利は利用者または従前の権利者に留保されます。</> },
  { title: "9. 規約の変更", body: <>必要に応じて本規約を変更することがあります。重要な変更がある場合は、本サイト上でお知らせします。</> },
  { title: "10. 準拠法・お問い合わせ", body: <>本規約は日本法に準拠します。本規約または本サービスに関するお問い合わせは、<a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a> までご連絡ください。</> },
];

function LegalPage({ kind, onBack }: { kind: LegalKind; onBack: () => void }) {
  const isPrivacy = kind === "privacy";
  const title = isPrivacy ? "プライバシーポリシー" : "利用規約";
  const sections = isPrivacy ? privacySections : termsSections;

  useEffect(() => {
    const previous = document.title;
    document.title = `${title} | MAILSHEET`;
    return () => { document.title = previous; };
  }, [title]);

  return (
    <div className="legal-page">
      <header className="legal-header">
        <button type="button" onClick={onBack} aria-label="MAILSHEETトップへ戻る"><Brand /></button>
        <button className="legal-back" type="button" onClick={onBack}>トップへ戻る <span>→</span></button>
      </header>
      <main className="legal-main">
        <div className="legal-heading">
          <span>{isPrivacy ? "PRIVACY POLICY" : "TERMS OF SERVICE"}</span>
          <h1>{title}</h1>
          <p>制定日：2026年9月2日</p>
        </div>
        <div className="legal-intro">
          <p>{isPrivacy ? "MAILSHEETは、GmailおよびGoogle Sheetsと連携するサービスとして、利用者の情報を以下の方針に基づき取り扱います。" : "MAILSHEETをご利用になる前に、以下の内容をご確認ください。"}</p>
        </div>
        <div className="legal-sections">
          {sections.map((section) => <section key={section.title}><h2>{section.title}</h2><p>{section.body}</p></section>)}
        </div>
      </main>
      <footer className="legal-footer"><span>MAILSHEET / PROTOTYPE 2026</span><a href={`/${isPrivacy ? "terms" : "privacy"}`}>{isPrivacy ? "利用規約" : "プライバシーポリシー"}</a></footer>
    </div>
  );
}

const feedbackStatusLabel = (status: FeedbackItem["status"]) => status === "resolved" ? "解決済み" : status === "in_progress" ? "対応中" : "未対応";

function TesterFeedback({ auth }: { auth: AuthStatus | null }) {
  const [form, setForm] = useState({ category: "不明点", page: "転記ルール", details: "", operation: "", expected: "" });
  const [items, setItems] = useState<FeedbackItem[]>([]);
  const [state, setState] = useState<"loading" | "idle" | "sending" | "sent" | "error">("loading");
  const [message, setMessage] = useState("");

  const loadFeedback = useCallback(async () => {
    try {
      const response = await apiFetch<{ ok: true; feedback: FeedbackItem[] }>("/api/feedback");
      setItems(response.feedback);
      setState("idle");
    } catch (error) {
      setMessage(errorText(error));
      setState("error");
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => { void loadFeedback(); }, 0);
    return () => window.clearTimeout(timer);
  }, [loadFeedback]);

  const submitFeedback = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setState("sending");
    setMessage("");
    try {
      await postJson<{ ok: true }>("/api/feedback", form);
      setForm((current) => ({ ...current, details: "", operation: "", expected: "" }));
      setMessage("投稿しました。管理者が内容を確認すると、下の履歴で対応状況を確認できます。");
      setState("sent");
      const response = await apiFetch<{ ok: true; feedback: FeedbackItem[] }>("/api/feedback");
      setItems(response.feedback);
    } catch (error) {
      setMessage(errorText(error));
      setState("error");
    }
  };

  return (
    <section className="app-view tester-feedback-view">
      <div className="app-view-heading"><div><span>TESTER FEEDBACK</span><h1>不明点・問題を投稿</h1><p>操作方法の質問、分かりにくかった点、不具合、改善要望を管理者へ送れます。</p></div></div>
      <div className="tester-feedback-layout">
        <form className="tester-feedback-form" onSubmit={submitFeedback}>
          <div className="tester-feedback-form__heading"><small>NEW POST</small><h2>気づいたことを教えてください</h2><p>詳しい原因が分からなくても大丈夫です。どの画面で何をしたかだけでも、調査の手掛かりになります。</p></div>
          <div className="tester-feedback-row">
            <label><span>投稿の種類 <b>必須</b></span><select value={form.category} onChange={(event) => setForm((current) => ({ ...current, category: event.target.value }))}><option>不明点</option><option>不具合</option><option>質問・相談</option><option>改善要望</option></select></label>
            <label><span>対象の画面</span><select value={form.page} onChange={(event) => setForm((current) => ({ ...current, page: event.target.value }))}><option>Google接続</option><option>転記ルール</option><option>処理履歴</option><option>設定</option><option>使い方ガイド</option><option>ログイン</option><option>その他</option></select></label>
          </div>
          <label><span>内容 <b>必須</b></span><textarea value={form.details} onChange={(event) => setForm((current) => ({ ...current, details: event.target.value }))} placeholder="例：自動転記ONにしましたが、新しいメールを受信してもシートに追加されません。" required minLength={5} rows={5} /></label>
          <label><span>直前に行った操作 <small>任意</small></span><textarea value={form.operation} onChange={(event) => setForm((current) => ({ ...current, operation: event.target.value }))} placeholder="例：転記ルールを保存 → 自動転記ON → テストメールを受信" rows={3} /></label>
          <label><span>期待していた結果 <small>任意</small></span><textarea value={form.expected} onChange={(event) => setForm((current) => ({ ...current, expected: event.target.value }))} placeholder="例：受信したメールがシートの最終行に1件追加される" rows={3} /></label>
          <div className="tester-feedback-submit"><div><strong>{auth?.appUser.email || auth?.googleEmail || "ログイン中の利用者"}</strong><small>このメールアドレスと投稿内容を管理者が確認します。</small></div><button className="button button--blue" type="submit" disabled={state === "sending" || form.details.trim().length < 5}>{state === "sending" ? "送信中…" : "管理者へ投稿"} <Icon name="arrow" size={16} /></button></div>
          {message ? <p className={state === "sent" ? "tester-feedback-message is-success" : "tester-feedback-message is-error"} role="status">{message}</p> : null}
        </form>

        <aside className="tester-feedback-tips">
          <small>WRITING TIPS</small><h2>この3点があると確認が早くなります</h2>
          <ol><li><span>1</span><p><strong>どの画面か</strong>Google接続、転記ルールなど。</p></li><li><span>2</span><p><strong>何をしたか</strong>押したボタンや入力した条件。</p></li><li><span>3</span><p><strong>何が起きたか</strong>表示された文章や実際の結果。</p></li></ol>
          <p>メール本文やSpreadsheetに個人情報が含まれる場合は、氏名・電話番号などを伏せて投稿してください。</p>
        </aside>
      </div>

      <section className="tester-feedback-history">
        <div className="tester-feedback-history__heading"><div><small>MY POSTS</small><h2>自分の投稿履歴</h2><p>管理者側で変更された対応状況が表示されます。</p></div><button type="button" onClick={() => void loadFeedback()}>再読み込み</button></div>
        {state === "loading" ? <p className="tester-feedback-empty">読み込み中…</p> : items.length ? <div className="tester-feedback-list">{items.map((item) => <article key={item.id}><header><div><span>{item.category}</span><strong className={`feedback-status is-${item.status}`}>{feedbackStatusLabel(item.status)}</strong></div><time>{formatAdminDate(item.created_at)}</time></header><p>{item.pain}</p>{item.current_process ? <small>{item.current_process}</small> : null}{item.desired_outcome ? <small><b>期待：</b>{item.desired_outcome}</small> : null}</article>)}</div> : <p className="tester-feedback-empty">投稿はまだありません。不明点があれば、上のフォームからそのまま送ってください。</p>}
      </section>
    </section>
  );
}

function GettingStartedGuide({ auth, onNavigate }: { auth: AuthStatus | null; onNavigate: (view: AppView) => void }) {
  const gmailReady = Boolean(auth?.connected && auth.grantedScopes.some((scope) => scope.includes("gmail.readonly")));
  const sheetsReady = Boolean(auth?.connected && auth.grantedScopes.some((scope) => scope.includes("spreadsheets")));

  return (
    <section className="app-view guide-view">
      <div className="app-view-heading">
        <div><span>GETTING STARTED</span><h1>はじめての使い方</h1><p>何も設定していない状態から、新着メールの自動転記を始めるまでを順番に説明します。</p></div>
      </div>

      <section className="guide-intro">
        <div><small>FIRST, READ THIS</small><h2>MAILSHEETは、メールの決まった場所から値を取り出して、表の1行にします。</h2><p>最初に1通だけ見本のメールを選び、「氏名」「電話番号」などの取り出し方と転記先を登録します。プログラムや数式の知識は必要ありません。</p></div>
        <div className="guide-intro__flow" aria-label="基本の流れ"><span>Gmail</span><Icon name="arrow" size={19} /><span>必要な値</span><Icon name="arrow" size={19} /><span>Google Sheets</span></div>
      </section>

      <nav className="guide-index" aria-label="使い方ガイドの目次">
        {[
          ["01", "Googleでログイン"], ["02", "権限を確認"], ["03", "実メールを選ぶ"],
          ["04", "取得項目を作る"], ["05", "Sheetsへ接続"], ["06", "転記を開始"],
        ].map(([number, label]) => <a key={number} href={`#guide-step-${number}`}><span>{number}</span>{label}</a>)}
      </nav>

      <div className="guide-steps">
        <article id="guide-step-01" className="guide-step">
          <header><span>01</span><div><small>GOOGLE SIGN IN</small><h2>招待されたGmailでログインする</h2></div></header>
          <div className="guide-step__body guide-two-column">
            <div>
              <ol className="guide-instructions">
                <li><strong>「Googleでログイン」を押す</strong><p>MAILSHEETにGmailのパスワードを入力することはありません。Googleの画面でログインします。</p></li>
                <li><strong>管理者へ伝えたGmailを選ぶ</strong><p>例：<code>tester@example.com</code>。招待リストとGoogle Cloudのテストユーザーに登録された、同じアカウントを使います。</p></li>
                <li><strong>警告が出たら内容を確認して「続行」</strong><p>テスト公開中は「このアプリはGoogleで確認されていません」と表示される場合があります。管理者から招待されたテスターだけが続行してください。</p></li>
              </ol>
            </div>
            <div className="guide-screen-stack" aria-label="Googleログイン画面の見本">
              <div className="guide-google-card"><img src="/google-g.svg" alt="" /><small>Googleでログイン</small><strong>MAILSHEETへ進む</strong><span>tester@example.com</span></div>
              <div className="guide-warning-card"><span>Google</span><strong>このアプリはGoogleで確認されていません</strong><p>現在テスト中のアプリへのアクセスが許可されています。</p><button type="button" tabIndex={-1}>続行</button></div>
              <p className="guide-caption">説明図の名前・メールアドレスは見本です。実際はご自身のアカウントが表示されます。</p>
            </div>
          </div>
        </article>

        <article id="guide-step-02" className="guide-step">
          <header><span>02</span><div><small>GOOGLE PERMISSIONS</small><h2>Gmailの読取とSheetsへの書込を許可する</h2></div></header>
          <div className="guide-step__body guide-two-column">
            <div>
              <p className="guide-lead">Googleの確認画面で、MAILSHEETが使用する2つの権限を確認します。表示された選択欄にチェックを入れ、「続行」を押してください。</p>
              <ul className="guide-permission-list">
                <li><span><Icon name="mail" size={22} /></span><div><strong>Gmail：メールの読取</strong><p>差出人・件名・本文を検索し、必要な値を取り出すために使います。送信や削除は行いません。</p></div></li>
                <li><span><Icon name="sheet" size={22} /></span><div><strong>Google Sheets：表の読取・書込</strong><p>1行目の見出しを確認し、抽出した値を指定したSpreadsheetへ追加するために使います。</p></div></li>
              </ul>
              <button type="button" className="button button--outline button--small" onClick={() => onNavigate("connections")}>Google接続を確認 <Icon name="arrow" size={16} /></button>
            </div>
            <div className="guide-connection-check">
              <small>CURRENT STATUS</small><h3>現在の連携状態</h3>
              <div className={gmailReady ? "is-ready" : ""}><span>{gmailReady ? "✓" : "!"}</span><p><strong>Gmail 読取</strong>{gmailReady ? "許可済み" : "未確認"}</p></div>
              <div className={sheetsReady ? "is-ready" : ""}><span>{sheetsReady ? "✓" : "!"}</span><p><strong>Google Sheets 書込</strong>{sheetsReady ? "許可済み" : "未確認"}</p></div>
              <p>{auth?.connected ? `${auth.googleEmail || "Googleアカウント"} で接続しています。` : "Google接続を完了すると、ここが2つとも「許可済み」になります。"}</p>
            </div>
          </div>
        </article>

        <article id="guide-step-03" className="guide-step">
          <header><span>03</span><div><small>TARGET MAIL</small><h2>転記したいメールを1通選ぶ</h2></div></header>
          <div className="guide-step__body guide-two-column">
            <ol className="guide-instructions">
              <li><strong>左メニューの「転記ルール」を開く</strong><p>「差出人（From）で探す」または「件名で探す」を選びます。</p></li>
              <li><strong>検索条件を入力する</strong><p>差出人は表示名でもメールアドレスでも検索できます。迷った場合は、実メールに表示されるメールアドレスを入力すると確実です。</p></li>
              <li><strong>「一致する実メールを探す」を押す</strong><p>候補一覧から、今後も同じ形式で届く代表的なメールを1通選びます。</p></li>
            </ol>
            <div className="guide-ui-sample"><small>検索例</small><label>差出人のメールアドレス、または表示名</label><div><span>notice@example.com</span><strong>一致する実メールを探す</strong></div><p>検索結果が出ない場合は、差出人のメールアドレスか件名の一部で試します。</p></div>
          </div>
        </article>

        <article id="guide-step-04" className="guide-step">
          <header><span>04</span><div><small>EXTRACTION FIELDS</small><h2>メールから取り出す項目を作る</h2></div></header>
          <div className="guide-step__body guide-two-column">
            <ol className="guide-instructions">
              <li><strong>本文中の欲しい値をドラッグして選ぶ</strong><p>例：「池田 隼人」の部分だけを選びます。選んだ文字の前後から、取り出し方が自動で作られます。</p></li>
              <li><strong>シートで使う項目名を付ける</strong><p>「氏名」「電話番号」「住所」など、列名として分かりやすい名前にします。</p></li>
              <li><strong>必要な項目を同じ手順で追加する</strong><p>項目は左のハンドルまたは上下ボタンで並び替えられます。抽出結果で値が取れていることを確認します。</p></li>
            </ol>
            <div className="guide-selection-sample"><small>本文中の値を選択</small><p>【氏名】 <mark>池田 隼人</mark><br />【電話番号】 090-0000-0000</p><div><span>選択した文字</span><strong>池田 隼人</strong><button type="button" tabIndex={-1}>この文字を取得項目にする</button></div></div>
          </div>
        </article>

        <article id="guide-step-05" className="guide-step">
          <header><span>05</span><div><small>GOOGLE SHEETS</small><h2>転記先を指定して、テスト書き込みする</h2></div></header>
          <div className="guide-step__body guide-two-column">
            <ol className="guide-instructions">
              <li><strong>Spreadsheet URLを貼り付ける</strong><p>ブラウザで転記先のGoogle Sheetsを開き、アドレス欄のURLをコピーして貼り付けます。</p></li>
              <li><strong>シート名を選ぶ</strong><p>「接続済み」と表示されたら、「1行目と列を自動設定」で見出しと出力列をまとめて設定できます。</p></li>
              <li><strong>「この内容をテスト書き込み」を押す</strong><p>実際のシートにテストの1行が追加されることを確認してから、ルールを保存します。</p></li>
            </ol>
            <div className="guide-sheet-map"><small>出力される列</small><div><span>A列</span><strong>転記日時</strong></div><div><span>B列</span><strong>転記ルール名</strong></div><div><span>C列以降</span><strong>氏名・電話番号など</strong></div><p>ルール名は編集でき、どのルールから追加された行かをB列で確認できます。</p></div>
          </div>
        </article>

        <article id="guide-step-06" className="guide-step">
          <header><span>06</span><div><small>START TRANSFER</small><h2>手動転記か、新着メールの自動転記を選ぶ</h2></div></header>
          <div className="guide-step__body">
            <div className="guide-mode-grid">
              <section><span>必要なときだけ</span><h3>一致メールを手動で転記</h3><p>ボタンを押した時点で、最近届いた未処理の一致メールを探して転記します。すでに届いているメールを転記したいときに使います。</p><strong>操作するまで転記しません</strong></section>
              <section className="is-auto"><span>今後の受信を自動化</span><h3>新着メールを自動転記 ON</h3><p>ONでルールを保存した後、新しく届いた条件一致メールを受信のたびに転記します。ONにする前の過去メールは自動転記しません。</p><strong>保存できるルールは10件／ONは3件まで</strong></section>
            </div>
            <div className="guide-important"><Icon name="check" size={22} /><div><strong>「自動追加ON」の意味は、これです。</strong><p>名称を「新着メールを自動転記 ON」に変更しました。入力候補を自動追加する機能ではありません。新しいメールを受信したときに、保存ルールを自動実行する設定です。</p></div></div>
            <div className="guide-finish-actions"><button type="button" className="button button--blue" onClick={() => onNavigate("rules")}>転記ルールを作る <Icon name="arrow" size={16} /></button><button type="button" className="button button--outline" onClick={() => onNavigate("history")}>処理履歴を見る</button></div>
          </div>
        </article>
      </div>

      <section className="guide-troubleshooting">
        <div><small>WHEN SOMETHING GOES WRONG</small><h2>転記されないときは</h2></div>
        <ol><li><strong>処理履歴を開く</strong><span>「成功」「転記なし」「要確認」「失敗」と理由を確認します。</span></li><li><strong>過去メールか確認</strong><span>ONより前に届いたメールは「一致メールを手動で転記」を使います。</span></li><li><strong>ルールを開く</strong><span>差出人・件名、抽出結果、Spreadsheetの接続、出力列を順番に確認します。</span></li></ol>
        <button type="button" className="button button--outline button--small" onClick={() => onNavigate("history")}>処理履歴へ <Icon name="arrow" size={16} /></button>
      </section>
    </section>
  );
}

const APP_VIEWS: AppView[] = ["dashboard", "connections", "rules", "history", "settings", "guide", "feedback", "admin"];

function AppShell({ onBack }: { onBack: () => void }) {
  const oauthResult = new URLSearchParams(window.location.search).get("google");
  const oauthReason = new URLSearchParams(window.location.search).get("reason");
  const pathView = window.location.pathname.split("/")[2] as AppView | undefined;
  const [view, setViewState] = useState<AppView>(oauthResult ? "connections" : pathView && APP_VIEWS.includes(pathView) ? pathView : "dashboard");
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const [dashboard, setDashboard] = useState<DashboardData | null>(null);
  const [history, setHistory] = useState<ApiHistoryRow[]>([]);
  const [reloadKey, setReloadKey] = useState(0);
  const [appNotice, setAppNotice] = useState<{ kind: "success" | "warning"; text: string } | null>(
    oauthResult === "connected"
      ? { kind: "success", text: "Googleログインと連携が完了しました。Gmailの読取とGoogle Sheetsへの書込を利用できます。" }
      : oauthResult === "error"
        ? { kind: "warning", text: oauthReason || "Google接続を完了できませんでした。" }
        : null,
  );
  const [notifications, setNotifications] = useState(true);
  const [pushSetup, setPushSetup] = useState<{ topic: string; webhookUrl: string; renewalUrl: string } | null>(null);
  const [needsSignIn, setNeedsSignIn] = useState(false);
  const [adminData, setAdminData] = useState<AdminOverview | null>(null);
  const [inviteEmail, setInviteEmail] = useState("");
  const [adminBusy, setAdminBusy] = useState(false);
  const [adminFeedbackFilter, setAdminFeedbackFilter] = useState<"all" | FeedbackItem["status"]>("all");

  const setView = (nextView: AppView) => {
    setViewState(nextView);
    const nextPath = nextView === "dashboard" ? "/app" : `/app/${nextView}`;
    window.history.pushState({}, "", nextPath);
  };

  useEffect(() => {
    if (oauthResult) {
      window.history.replaceState({}, "", "/app/connections");
    }
    const handleAppPopState = () => {
      const next = window.location.pathname.split("/")[2] as AppView | undefined;
      setViewState(next && APP_VIEWS.includes(next) ? next : "dashboard");
    };
    window.addEventListener("popstate", handleAppPopState);
    return () => window.removeEventListener("popstate", handleAppPopState);
  }, [oauthResult]);

  useEffect(() => {
    let active = true;
    (async () => {
      const status = await apiFetch<AuthStatus>("/api/auth/status");
      if (!active) return;
      setAuth(status);
      if (!status.access.allowed) return;
      const [dashboardResponse, historyResponse] = await Promise.all([
        apiFetch<{ ok: true } & DashboardData>("/api/dashboard"),
        apiFetch<{ ok: true; history: ApiHistoryRow[] }>("/api/history?limit=100"),
      ]);
        if (!active) return;
        setDashboard({ metrics: dashboardResponse.metrics, recent: dashboardResponse.recent });
        setHistory(historyResponse.history);
    })()
      .catch((error: unknown) => {
        if (!active) return;
        if (error instanceof ApiError && error.code === "unauthorized") {
          setNeedsSignIn(true);
          setAppNotice(null);
          return;
        }
        setAppNotice({ kind: "warning", text: error instanceof ApiError ? error.message : "アプリ情報を読み込めませんでした。" });
      });
    return () => { active = false; };
  }, [reloadKey]);

  const refreshData = () => setReloadKey((value) => value + 1);

  const loadAdmin = useCallback(async () => {
    try {
      setAdminData(await apiFetch<AdminOverview>("/api/admin/overview"));
    } catch (error) {
      setAppNotice({ kind: "warning", text: errorText(error) });
    }
  }, []);

  useEffect(() => {
    if (view === "admin" && auth?.access.role === "admin") {
      const timer = window.setTimeout(() => { void loadAdmin(); }, 0);
      return () => window.clearTimeout(timer);
    }
  }, [view, auth?.access.role, loadAdmin, reloadKey]);

  const inviteTester = async () => {
    if (!inviteEmail.trim()) return;
    setAdminBusy(true);
    try {
      await postJson("/api/admin/invite", { email: inviteEmail });
      setInviteEmail("");
      setAppNotice({ kind: "success", text: "テスターを招待リストへ追加しました。Google OAuthのテストユーザーにも同じGmailを追加してください。" });
      await loadAdmin();
    } catch (error) {
      setAppNotice({ kind: "warning", text: errorText(error) });
    } finally { setAdminBusy(false); }
  };

  const changeTesterStatus = async (email: string, status: "invited" | "active" | "suspended") => {
    try {
      await postJson("/api/admin/users/status", { email, status });
      await loadAdmin();
    } catch (error) { setAppNotice({ kind: "warning", text: errorText(error) }); }
  };

  const renamePendingInvite = async (email: string) => {
    const newEmail = window.prompt("変更後のGoogleアカウントのメールアドレス", email)?.trim();
    if (!newEmail || newEmail.toLowerCase() === email.toLowerCase()) return;
    try {
      await postJson("/api/admin/invite/manage", { action: "rename", email, newEmail });
      setAppNotice({ kind: "success", text: `招待メールを ${newEmail} へ変更しました。Google Cloudのテストユーザーも同じメールへ変更してください。` });
      await loadAdmin();
    } catch (error) { setAppNotice({ kind: "warning", text: errorText(error) }); }
  };

  const deletePendingInvite = async (email: string) => {
    if (!window.confirm(`${email} を招待リストから削除しますか？`)) return;
    try {
      await postJson("/api/admin/invite/manage", { action: "delete", email });
      setAppNotice({ kind: "success", text: `${email} を招待リストから削除しました。` });
      await loadAdmin();
    } catch (error) { setAppNotice({ kind: "warning", text: errorText(error) }); }
  };

  const changeFeedbackStatus = async (id: number, status: FeedbackItem["status"]) => {
    try {
      await postJson("/api/admin/feedback/status", { id, status });
      setAppNotice({ kind: "success", text: `投稿 #${id} を「${feedbackStatusLabel(status)}」に変更しました。` });
      await loadAdmin();
    } catch (error) { setAppNotice({ kind: "warning", text: errorText(error) }); }
  };

  const startGoogleConnection = () => {
    if (!auth?.configured) {
      setAppNotice({ kind: "warning", text: "Google Cloud側のOAuthクライアント設定が必要です。下のCallback URLを登録してください。" });
      return;
    }
    window.location.assign("/api/oauth/google/start");
  };

  const disconnectGoogle = async () => {
    try {
      await postJson<{ ok: true }>("/api/auth/disconnect", {});
      setAppNotice({ kind: "success", text: "Google接続を解除しました。保存済みルールと履歴は残っています。" });
      refreshData();
    } catch (error) {
      setAppNotice({ kind: "warning", text: error instanceof ApiError ? error.message : "接続を解除できませんでした。" });
    }
  };

  const logout = async () => {
    try {
      await postJson<{ ok: true }>("/api/auth/logout", {});
      window.history.replaceState({}, "", "/app");
      window.location.reload();
    } catch (error) {
      setAppNotice({ kind: "warning", text: errorText(error) });
    }
  };

  const showPushSetup = async () => {
    try {
      const setup = await apiFetch<{ ok: true; topic: string; webhookUrl: string; renewalUrl: string }>("/api/gmail/push/config");
      setPushSetup(setup);
    } catch (error) {
      setAppNotice({ kind: "warning", text: error instanceof ApiError ? error.message : "Pub/Sub設定を取得できませんでした。" });
    }
  };

  const copySetupValue = async (value: string) => {
    await navigator.clipboard.writeText(value);
    setAppNotice({ kind: "success", text: "設定値をコピーしました。" });
  };

  const navItems: { id: AppView; label: string; icon: string }[] = [
    { id: "dashboard", label: "ホーム", icon: "dashboard" },
    { id: "connections", label: "Google接続", icon: "link" },
    { id: "rules", label: "転記ルール", icon: "sheet" },
    { id: "history", label: "処理履歴", icon: "history" },
    { id: "settings", label: "設定", icon: "settings" },
    { id: "guide", label: "使い方ガイド", icon: "guide" },
    { id: "feedback", label: "フィードバック", icon: "feedback" },
    ...(auth?.access.role === "admin" ? [{ id: "admin" as AppView, label: "管理", icon: "settings" }] : []),
  ];

  return (
    <div className="app-shell">
      <aside className="app-sidebar">
        <button className="app-sidebar__brand" type="button" onClick={onBack}><Brand compact /></button>
        <nav aria-label="アプリメニュー">
          {navItems.map((item) => (
            <button key={item.id} type="button" className={view === item.id ? "is-active" : undefined} onClick={() => setView(item.id)}>
              <Icon name={item.icon} size={19} /><span>{item.label}</span>
            </button>
          ))}
        </nav>
        <div className="app-sidebar__foot">
          <span>PRIVATE BETA</span>
          <strong>{auth?.connected ? "Google連携済み" : "MAILSHEET workspace"}</strong>
          <small>{auth?.googleEmail || auth?.appUser.email || "読み込み中…"}</small>
          {auth?.appUser.email ? <button type="button" onClick={logout}>ログアウト →</button> : null}
        </div>
      </aside>

      <div className="app-main">
        <header className="app-topbar">
          <div><small>MAILSHEET</small><strong>{navItems.find((item) => item.id === view)?.label}</strong></div>
          <div><span className={auth?.connected ? "demo-badge is-live" : "demo-badge"}>{auth?.connected ? "LIVE" : "BETA"}</span><button type="button" onClick={onBack}>LPへ戻る ↗</button></div>
        </header>

        <nav className="app-mobile-nav" aria-label="モバイルアプリメニュー">
          {navItems.map((item) => <button key={item.id} type="button" className={view === item.id ? "is-active" : undefined} onClick={() => setView(item.id)}><Icon name={item.icon} size={18} /><span>{item.label}</span></button>)}
        </nav>

        <main className="app-content">
          {needsSignIn && view !== "guide" ? (
            <section className="sign-in-gate" aria-labelledby="sign-in-title">
              <span>EARLY ACCESS</span>
              <h1 id="sign-in-title">無料で試す</h1>
              <p>Googleアカウントでログインすると、招待確認とGmail・Google Sheetsの接続をまとめて行います。</p>
              <a className="button button--google" href="/api/oauth/google/start"><img src="/google-g.svg" alt="" />Googleでログイン</a>
              <small>現在は、招待されたGoogleアカウントのみ利用できます。</small>
              <details className="sign-in-help">
                <summary>初めての方・Googleの警告が表示された方</summary>
                <ol><li>管理者へ伝えたGmailを選びます。</li><li>「このアプリはGoogleで確認されていません」と表示されたら、招待されたアカウントであることを確認して「続行」を押します。</li><li>Gmailの読取とGoogle Sheetsへの書込を確認し、続行します。</li></ol>
                <p>MAILSHEETへGmailのパスワードを入力することはありません。ログイン後は、左メニューの「使い方ガイド」で全手順を確認できます。</p>
              </details>
            </section>
          ) : null}
          {!needsSignIn && auth?.access.allowed === false && view !== "guide" ? (
            <section className="sign-in-gate invite-gate" aria-labelledby="invite-title">
              <span>INVITATION ONLY</span><h1 id="invite-title">現在は招待制です</h1>
              <p><strong>{auth.appUser.email}</strong> は、まだテスターとして登録されていません。管理者へこのメールアドレスを伝えてください。</p>
              <button className="button button--outline" type="button" onClick={onBack}>トップへ戻る</button>
            </section>
          ) : null}
          {view === "guide" || (!needsSignIn && auth?.access.allowed !== false) ? <>
          {appNotice ? <div className={`app-notice is-${appNotice.kind}`} role="status"><span>{appNotice.text}</span><button type="button" onClick={() => setAppNotice(null)} aria-label="通知を閉じる">×</button></div> : null}
          {view === "dashboard" ? (
            <section className="app-view dashboard-view">
              <div className="app-view-heading"><div><span>OVERVIEW</span><h1>処理状況</h1><p>{auth?.connected ? "Google接続と保存済み履歴を表示しています。" : "Googleを接続すると、実メールで処理を始められます。"}</p></div><button className="button button--blue" type="button" onClick={() => setView("rules")}><Icon name="plus" size={17} /> 抽出ルールを設定</button></div>
              <div className="app-metrics">
                <article><span>今日の処理</span><strong>{dashboard?.metrics.today.total ?? 0}</strong><small>今月 {dashboard?.metrics.month.total ?? 0}件</small></article>
                <article><span>成功</span><strong>{dashboard?.metrics.today.success ?? 0}</strong><small className="success-text">Sheetsへ追加済み</small></article>
                <article><span>要確認</span><strong>{dashboard?.metrics.today.review ?? 0}</strong><small className="warning-text">抽出ルールを確認</small></article>
                <article><span>失敗</span><strong>{dashboard?.metrics.today.failed ?? 0}</strong><small>{dashboard?.metrics.today.failed ? "接続を確認" : "問題なし"}</small></article>
              </div>
              <div className="app-panel"><div className="app-panel__heading"><div><small>RECENT RUNS</small><h2>最近の処理</h2></div><button type="button" onClick={() => setView("history")}>すべて見る →</button></div><HistoryTable rows={dashboard?.recent ?? []} /></div>
            </section>
          ) : null}

          {view === "connections" ? (
            <section className="app-view connections-view">
              <div className="app-view-heading"><div><span>GOOGLE ACCESS</span><h1>Google連携</h1><p>{auth?.connected ? "ログイン時にGmailの読取とGoogle Sheetsへの書込を許可済みです。ここから利用設定へ進めます。" : "Googleログインと同時に、Gmailの読取とGoogle Sheetsへの書込をまとめて許可します。"}</p></div></div>
              <section className="connection-onboarding" aria-labelledby="connection-guide-title">
                <div className="connection-onboarding__heading"><small>FOR FIRST-TIME USERS</small><h2 id="connection-guide-title">ログイン後は、あと2ステップ。</h2><p>GoogleログインでGmailとSheetsの権限確認まで完了します。</p></div>
                <ol>
                  <li><span>✓</span><div><strong>Googleログイン・権限確認</strong><p>{auth?.connected ? `${auth.googleEmail} で完了しています。` : "使うGoogleアカウントを選び、GmailとSheetsの権限を確認します。"}</p></div></li>
                  <li><span>01</span><div><strong>Gmailの代表メールを選ぶ</strong><p>送信元や件名で検索し、書式の決まったメールを1通選びます。</p></div></li>
                  <li><span>02</span><div><strong>取り出す項目と列を決める</strong><p>必要な項目を追加し、Spreadsheetの出力列へ対応させます。</p></div></li>
                </ol>
                <p className="connection-onboarding__note"><Icon name="check" size={15} /> 設定するのは初回だけ。転記を使う担当者が、実際のメールを見ながら確認する方式です。</p>
              </section>
              {auth?.configured === false ? (
                <div className="oauth-setup-panel">
                  <div className="oauth-setup-panel__heading"><small>GOOGLE CLOUD SETUP / 管理者向け</small><h2>OAuthクライアント設定待ち</h2><p>ここはサービス管理者が最初に1回だけ設定します。利用者ごとの操作ではありません。</p></div>
                  <ol className="oauth-admin-steps">
                    <li><span>1</span><p><strong>APIを有効化</strong>Google Cloudで Gmail API と Google Sheets API を有効にします。</p></li>
                    <li><span>2</span><p><strong>同意画面を設定</strong>Google Auth Platformの「ブランディング」「対象」「データアクセス」を設定。検証中はテストユーザーに利用アカウントを追加します。</p></li>
                    <li><span>3</span><p><strong>必要な権限を追加</strong>Gmailは読取専用、Sheetsは既存Spreadsheetへの読取・書込を使います。</p></li>
                    <li><span>4</span><p><strong>OAuthクライアントを作成</strong>アプリケーションの種類は「ウェブ アプリケーション」。下のURIを承認済みリダイレクトURIへ完全一致で登録します。</p></li>
                  </ol>
                  <div className="oauth-redirect-block"><span>承認済みリダイレクトURI</span><code>{auth.callbackUrl}</code></div>
                  <div className="oauth-env-block"><span>暗号化された環境変数</span><div><code>GOOGLE_CLIENT_ID</code><code>GOOGLE_CLIENT_SECRET</code><code>TOKEN_ENCRYPTION_KEY</code></div><p>Client Secretと暗号化キーはチャットやソースコードへ貼らず、Siteの暗号化された環境変数に保存します。</p></div>
                  <a className="oauth-console-link" href="https://console.cloud.google.com/" target="_blank" rel="noreferrer">Google Cloud Consoleを開く ↗</a>
                </div>
              ) : null}
              <section className={auth?.connected ? "google-connection-panel is-connected" : "google-connection-panel"}>
                <div className="google-connection-panel__head">
                  <div><small>ONE GOOGLE LOGIN</small><h2>{auth?.connected ? "Gmail・Google Sheetsを利用できます" : "Googleログインでまとめて許可"}</h2><p>{auth?.connected ? "同じGoogleアカウントで、メール検索と指定シートへの書込を行います。" : "ログイン時の確認画面で、メールの読取とシートへの書込を許可します。"}</p></div>
                  <span className="google-connection-status"><i />{auth?.connected ? `${auth.googleEmail} 接続済み` : auth ? "未接続" : "接続状態を確認中"}</span>
                </div>
                <div className="google-connection-services">
                  <article><span className="connection-card__icon"><Icon name="mail" size={29} /></span><div><small>INPUT</small><h3>Gmail</h3><p>条件に一致する定型メールを読み取り、抽出ルールのサンプルにします。</p><ul><li><Icon name="check" size={15} /> 読取専用</li><li><Icon name="check" size={15} /> パスワードは預からない</li></ul></div></article>
                  <span className="google-connection-plus">＋</span>
                  <article><span className="connection-card__icon connection-card__icon--sheet"><Icon name="sheet" size={29} /></span><div><small>OUTPUT</small><h3>Google Sheets</h3><p>指定したSpreadsheetの見出しを読み、抽出した値を書き込みます。</p><ul><li><Icon name="check" size={15} /> 既存シートを使用</li><li><Icon name="check" size={15} /> テスト書込で確認</li></ul></div></article>
                </div>
                <div className="google-connection-actions">
                  <button className="button button--blue" type="button" onClick={auth?.connected ? () => setView("rules") : startGoogleConnection}>{auth?.connected ? "転記ルールを設定" : "Googleでログイン"} <Icon name="arrow" size={17} /></button>
                  {auth?.connected ? <button className="connection-disconnect" type="button" onClick={disconnectGoogle}>Google接続を解除</button> : <small>Googleの確認画面へ移動します</small>}
                </div>
              </section>
              {auth?.gmailPushConfigured ? (
                <section className="push-setup-panel">
                  <div><small>GMAIL PUSH / 管理者向け</small><h2>受信時の自動転記を接続</h2><p>設定URLには秘密キーが含まれます。公開したり、第三者へ共有しないでください。</p></div>
                  {!pushSetup ? <button type="button" className="button button--outline" onClick={showPushSetup}>Pub/Sub設定URLを表示</button> : (
                    <div className="push-setup-values">
                      <label><span>Topic</span><code>{pushSetup.topic}</code><button type="button" onClick={() => copySetupValue(pushSetup.topic)}>コピー</button></label>
                      <label><span>Pushエンドポイント</span><code>{pushSetup.webhookUrl}</code><button type="button" onClick={() => copySetupValue(pushSetup.webhookUrl)}>コピー</button></label>
                      <label><span>毎日のwatch更新URL</span><code>{pushSetup.renewalUrl}</code><button type="button" onClick={() => copySetupValue(pushSetup.renewalUrl)}>コピー</button></label>
                    </div>
                  )}
                </section>
              ) : (
                <section className="push-setup-panel is-warning">
                  <div><small>GMAIL PUSH / 管理者向け</small><h2>受信通知の設定が未完了です</h2><p>CloudflareのRuntime variablesへ次の2項目を登録し、再デプロイしてください。設定後、この画面にTopicとPushエンドポイントを表示できます。</p></div>
                  <div className="push-setup-values">
                    <label><span>Text</span><code>GOOGLE_PUBSUB_TOPIC</code></label>
                    <label><span>Secret</span><code>PUBSUB_WEBHOOK_SECRET</code></label>
                  </div>
                </section>
              )}
            </section>
          ) : null}

          {view === "rules" ? (
            <section className="app-view rules-view"><div className="app-view-heading"><div><span>RULE EDITOR</span><h1>転記内容を自由に設定</h1><p>応募、問い合わせ、注文、予約、請求などを問わず、実メールから必要な項目だけを自由に指定できます。</p></div></div><RuleWorkbench onDataChanged={refreshData} /></section>
          ) : null}

          {view === "history" ? (
            <section className="app-view history-view"><div className="app-view-heading"><div><span>HISTORY</span><h1>処理履歴</h1><p>実際のテスト書込・同期結果をメール単位で確認できます。</p></div><button type="button" className="button button--outline button--small" onClick={refreshData}>再読み込み</button></div><div className="app-panel"><HistoryTable rows={history} /></div></section>
          ) : null}

          {view === "settings" ? (
            <section className="app-view settings-view"><div className="app-view-heading"><div><span>SETTINGS</span><h1>設定</h1><p>ログイン、通知とGoogle接続を管理します。</p></div></div><div className="settings-stack"><section><div><small>SESSION</small><h2>ログインの継続</h2><p>最後の操作から7日間アクセスがない場合は、自動的にログアウトします。利用中は期限が自動更新されます。</p></div><span className="settings-value">7日間</span></section><section><div><small>NOTIFICATION</small><h2>要確認メールを画面で知らせる</h2><p>抽出できない項目を履歴の「要確認」として表示します。外部通知は未実装です。</p></div><button type="button" className={notifications ? "large-switch is-on" : "large-switch"} aria-pressed={notifications} onClick={() => setNotifications((value) => !value)}><i /></button></section><section><div><small>DATA</small><h2>保存するデータ</h2><p>抽出ルール・列マッピング・処理結果を保存します。メール本文と抽出値は保存しません。</p></div><span className="settings-value">最小保存</span></section><section className="danger-setting"><div><small>GOOGLE CONNECTION</small><h2>Google接続を解除</h2><p>Google側のトークンを失効させ、保存した接続情報を削除します。</p></div><button type="button" onClick={disconnectGoogle} disabled={!auth?.connected}>接続を解除</button></section></div></section>
          ) : null}

          {view === "guide" ? <GettingStartedGuide auth={auth} onNavigate={setView} /> : null}

          {view === "feedback" ? <TesterFeedback auth={auth} /> : null}

          {view === "admin" && auth?.access.role === "admin" ? (
            <section className="app-view admin-view">
              <div className="app-view-heading"><div><span>ADMIN CONSOLE</span><h1>運用管理</h1><p>招待、アクセス、Google接続、受信通知、処理状況と料金リスクを確認します。</p></div><button className="button button--outline button--small" type="button" onClick={loadAdmin}>再読み込み</button></div>
              <div className="admin-metrics">
                <article><span>登録利用者</span><strong>{adminData?.metrics.users ?? 0}</strong><small>利用中 {adminData?.metrics.activeUsers ?? 0}</small></article>
                <article><span>Google接続</span><strong>{adminData?.metrics.connectedGoogle ?? 0}</strong><small>Gmail / Sheets</small></article>
                <article><span>今月の受信通知</span><strong>{adminData?.metrics.gmailNotifications ?? 0}</strong><small>Pub/Sub通知</small></article>
                <article><span>今月の失敗</span><strong>{adminData?.metrics.processing.failed ?? 0}</strong><small>要確認 {adminData?.metrics.processing.review ?? 0}</small></article>
              </div>
              <section className="admin-panel admin-invite-panel"><div><small>INVITE TESTER</small><h2>テスターを招待</h2><p>ここへ登録したChatGPTアカウントのメールだけ、アプリへ入れます。</p></div><div className="admin-invite-form"><input type="email" value={inviteEmail} onChange={(event) => setInviteEmail(event.target.value)} placeholder="tester@example.com" aria-label="招待するメールアドレス" /><button type="button" disabled={adminBusy || !inviteEmail.trim()} onClick={inviteTester}>招待リストへ追加</button></div><p className="admin-callout">Google OAuthもテストモードのため、Google Cloudの「テストユーザー」へ同じGmailを追加してください。</p></section>
              <section className="admin-panel"><div className="admin-panel__heading"><div><small>USERS</small><h2>招待・登録ユーザー一覧</h2><p>招待済みメールの修正・削除と、利用者の停止・再開を管理できます。</p></div></div><div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>利用者</th><th>状態</th><th>接続Gmail</th><th>最終アクセス</th><th>最終受信</th><th>最終処理</th><th>操作</th></tr></thead><tbody>{adminData?.users.map((user) => <tr key={user.email}><td><strong>{user.email}</strong><small>{user.role === "admin" ? "管理者" : `アクセス ${user.access_count || 0}回`}</small></td><td><span className={`admin-status is-${user.status}`}>{user.status === "active" ? "利用中" : user.status === "invited" ? "招待済み" : "停止中"}</span></td><td>{user.google_email || "未接続"}<small>{user.gmail_watch_expires_at ? `watch期限 ${formatAdminDate(user.gmail_watch_expires_at)}` : ""}</small></td><td>{formatAdminDate(user.last_access_at)}</td><td>{formatAdminDate(user.last_gmail_notification_at)}</td><td>{formatAdminDate(user.last_processed_at)}<small>{user.last_process_status || ""}</small></td><td>{user.role !== "admin" ? <div className="admin-user-actions"><button type="button" onClick={() => changeTesterStatus(user.email, user.status === "suspended" ? "invited" : "suspended")}>{user.status === "suspended" ? "再開" : "停止"}</button>{user.status === "invited" && !user.access_count && !user.google_email ? <><button type="button" className="is-secondary" onClick={() => renamePendingInvite(user.email)}>メール変更</button><button type="button" className="is-danger" onClick={() => deletePendingInvite(user.email)}>招待削除</button></> : null}</div> : "—"}</td></tr>)}</tbody></table></div></section>
              <div className="admin-two-column">
                <section className="admin-panel cost-panel"><small>COST WATCH</small><h2>料金・無料枠</h2><div className="cost-row"><span>Pub/Sub</span><strong>月10 GiBまで無料</strong><small>今月の通知 {adminData?.costs.notificationCount ?? 0}件</small></div><div className="cost-row"><span>Cloud Scheduler</span><strong>月3ジョブまで無料</strong><small>想定 {adminData?.costs.expectedSchedulerJobs ?? 0}ジョブ</small></div><p>{adminData?.costs.note || "実請求額は取得していません。"}</p>{adminData?.system.cloudProjectId ? <a href={`https://console.cloud.google.com/billing?project=${encodeURIComponent(adminData.system.cloudProjectId)}`} target="_blank" rel="noreferrer">Google Cloudの請求を確認 ↗</a> : null}</section>
                <section className="admin-panel system-panel"><small>SYSTEM STATUS</small><h2>連携状態</h2><ul><li><span>OAuth設定</span><strong>{adminData?.system.oauthConfigured ? "正常" : "未設定"}</strong></li><li><span>Gmail受信通知</span><strong>{adminData?.system.gmailPushConfigured ? "有効" : "未設定"}</strong></li><li><span>データベース</span><strong>{adminData?.system.databaseConfigured ? "正常" : "未設定"}</strong></li><li><span>今月のwatch更新</span><strong>{adminData?.metrics.watchRenewals ?? 0}回</strong></li></ul></section>
              </div>
              <section className="admin-panel"><div className="admin-panel__heading"><div><small>ACCESS LOG</small><h2>最近のアクセス</h2></div></div><div className="access-log">{adminData?.accessHistory.length ? adminData.accessHistory.slice(0, 30).map((event, index) => <div key={`${event.email}-${event.created_at}-${index}`}><strong>{event.email}</strong><span>{formatAdminDate(event.created_at)}</span></div>) : <p>アクセス履歴はまだありません。</p>}</div></section>
              <section className="admin-panel"><div className="admin-panel__heading"><div><small>PUBLIC TRAFFIC</small><h2>公開LPの閲覧</h2><p>IPアドレスを保存せず、匿名IDで集計しています。</p></div><div className="traffic-summary"><span>今日 <strong>{adminData?.publicTraffic.todayViews ?? 0}</strong></span><span>7日間 <strong>{adminData?.publicTraffic.sevenDayViews ?? 0}</strong></span><span>閲覧者 <strong>{adminData?.publicTraffic.sevenDayVisitors ?? 0}</strong></span></div></div><div className="access-log">{adminData?.publicTraffic.recent.length ? adminData.publicTraffic.recent.slice(0, 40).map((event, index) => <div key={`${event.visitor_id}-${event.created_at}-${index}`}><strong>{event.path} <small>{event.device === "mobile" ? "スマホ" : "PC"}{event.referrer_host ? ` / ${event.referrer_host}` : " / 直接アクセス"}</small></strong><span>{formatAdminDate(event.created_at)}</span></div>) : <p>公開ページのアクセス履歴はまだありません。</p>}</div></section>
              <section className="admin-panel admin-feedback-panel">
                <div className="admin-panel__heading"><div><small>TESTER FEEDBACK</small><h2>不明点・不具合・質問</h2><p>テスターと公開ページから届いた投稿を確認し、対応状況を更新できます。</p></div><div className="admin-feedback-summary"><span>未対応 <strong>{adminData?.feedback.filter((item) => item.status === "new").length ?? 0}</strong></span><span>全件 <strong>{adminData?.feedback.length ?? 0}</strong></span></div></div>
                <div className="admin-feedback-filters" aria-label="投稿の絞り込み">{(["all", "new", "in_progress", "resolved"] as const).map((status) => <button type="button" key={status} className={adminFeedbackFilter === status ? "is-active" : ""} onClick={() => setAdminFeedbackFilter(status)}>{status === "all" ? "すべて" : feedbackStatusLabel(status)}</button>)}</div>
                <div className="feedback-admin-list">{adminData?.feedback.length ? adminData.feedback.filter((item) => adminFeedbackFilter === "all" || item.status === adminFeedbackFilter).map((item) => <article className={item.visitor_id.startsWith("app:") ? "is-tester-post" : ""} key={item.id}><header><div><span>{item.category}</span><strong className={`feedback-status is-${item.status}`}>{feedbackStatusLabel(item.status)}</strong>{item.visitor_id.startsWith("app:") ? <em>テスター</em> : <em>公開ページ</em>}</div><time>#{item.id}・{formatAdminDate(item.created_at)}</time></header><strong>{item.pain}</strong>{item.current_process ? <p className="feedback-context">{item.current_process}</p> : null}{item.desired_outcome ? <p><b>期待・希望：</b>{item.desired_outcome}</p> : null}<footer>{item.contact_email ? <a href={`mailto:${item.contact_email}`}>{item.contact_email}</a> : <small>返信先なし</small>}<div>{(["new", "in_progress", "resolved"] as const).map((status) => <button type="button" key={status} className={item.status === status ? "is-active" : ""} onClick={() => void changeFeedbackStatus(item.id, status)}>{feedbackStatusLabel(status)}</button>)}</div></footer></article>) : <p>投稿はまだ届いていません。</p>}</div>
              </section>
            </section>
          ) : null}
          </> : null}
        </main>
      </div>
    </div>
  );
}

export default function MailSheetSite() {
  const [path, setPath] = useState(() => window.location.pathname);

  useEffect(() => {
    const onPopState = () => setPath(window.location.pathname);
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const navigate = (nextPath: string) => {
    window.history.pushState({}, "", nextPath);
    setPath(nextPath);
    window.scrollTo({ top: 0, behavior: "auto" });
  };

  if (path === "/privacy" || path === "/terms") {
    return <LegalPage kind={path === "/privacy" ? "privacy" : "terms"} onBack={() => navigate("/")} />;
  }

  return path.startsWith("/app") ? (
    <AppShell onBack={() => navigate("/")} />
  ) : (
    <LandingPage onOpenApp={() => navigate("/app")} />
  );
}
