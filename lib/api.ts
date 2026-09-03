import type { ExtractionRule } from "@/lib/extraction";

export class ApiError extends Error {
  status: number;
  code: string;

  constructor(message: string, status: number, code = "request_failed") {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

export type AuthStatus = {
  ok: true;
  configured: boolean;
  connected: boolean;
  googleEmail: string;
  expiresAt: number | null;
  grantedScopes: string[];
  appUser: { email: string };
  callbackUrl: string;
  gmailPushConfigured: boolean;
  gmailWatchActive: boolean;
  gmailWatchExpiresAt: number | null;
  lastGmailNotificationAt: string | null;
  access: { allowed: boolean; role: "admin" | "tester" | ""; status: string };
};

export type AdminUser = {
  email: string;
  role: "admin" | "tester";
  status: "invited" | "active" | "suspended";
  invited_by: string;
  created_at: string;
  last_access_at: string;
  access_count: number;
  user_id?: string;
  google_email?: string;
  gmail_watch_expires_at?: number;
  last_gmail_notification_at?: string;
  last_watch_renewed_at?: string;
  last_processed_at?: string;
  last_process_status?: string;
};

export type FeedbackItem = {
  id: number;
  visitor_id: string;
  category: string;
  pain: string;
  current_process: string;
  desired_outcome: string;
  contact_email: string;
  status: "new" | "in_progress" | "resolved";
  created_at: string;
};

export type FeedbackAttachment = {
  key: string;
  name: string;
  contentType: string;
  size: number;
  uploadedAt: string;
  url: string;
};

export type AdminOverview = {
  ok: true;
  users: AdminUser[];
  accessHistory: Array<{ email: string; event_type: string; created_at: string }>;
  publicTraffic: {
    todayViews: number;
    sevenDayViews: number;
    sevenDayVisitors: number;
    recent: Array<{ visitor_id: string; path: string; referrer_host: string; device: string; created_at: string }>;
  };
  feedback: FeedbackItem[];
  metrics: {
    users: number;
    activeUsers: number;
    connectedGoogle: number;
    processing: { success: number; review: number; failed: number };
    gmailNotifications: number;
    watchRenewals: number;
  };
  system: { oauthConfigured: boolean; gmailPushConfigured: boolean; databaseConfigured: boolean; cloudProjectId: string };
  costs: { measured: boolean; pubsubFreeGiB: number; schedulerFreeJobs: number; expectedSchedulerJobs: number; notificationCount: number; note: string };
};

export type GmailMessage = {
  id: string;
  threadId: string;
  from: string;
  subject: string;
  date: string;
  receivedAt: string;
  snippet: string;
  body: string;
};

export type SheetHeader = { column: string; label: string };

export type SheetInfo = {
  spreadsheetId: string;
  spreadsheetName: string;
  sheetName: string;
  sheets: string[];
  headers: SheetHeader[];
};

export type SavedRule = {
  id: number;
  name: string;
  sender: string;
  subjectContains: string;
  fields: ExtractionRule[];
  spreadsheetId: string;
  spreadsheetName: string;
  sheetName: string;
  sheetHeaders: SheetHeader[];
  mappings: Record<string, string>;
  active: boolean;
  createdAt: string;
  updatedAt: string;
  lastStatus: "success" | "review" | "failed" | "received" | "skipped" | "";
  lastError: string;
  lastProcessedAt: string;
};

export type HistoryRow = {
  id: number;
  ruleId: number | null;
  receivedAt: string;
  subject: string;
  extractedCount: number;
  destination: string;
  status: "success" | "review" | "failed" | "received" | "skipped";
  errorMessage: string;
  createdAt: string;
};

export type DashboardData = {
  metrics: {
    today: { total: number; success: number; review: number; failed: number };
    month: { total: number; success: number; review: number; failed: number };
  };
  recent: HistoryRow[];
};

type ApiFailure = { error?: { message?: string; code?: string } };

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body && !(init.body instanceof FormData) && !headers.has("content-type")) headers.set("content-type", "application/json");
  const response = await fetch(path, { ...init, headers, credentials: "same-origin" });
  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    // A useful typed error is raised below for empty/non-JSON responses.
  }
  if (!response.ok) {
    const failure = (payload || {}) as ApiFailure;
    throw new ApiError(
      failure.error?.message || "通信に失敗しました。もう一度お試しください。",
      response.status,
      failure.error?.code,
    );
  }
  return payload as T;
}

export function postJson<T>(path: string, body: unknown) {
  return apiFetch<T>(path, { method: "POST", body: JSON.stringify(body) });
}
