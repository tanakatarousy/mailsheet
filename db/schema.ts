import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const googleConnections = sqliteTable("google_connections", {
  userId: text("user_id").primaryKey(),
  googleEmail: text("google_email").notNull(),
  accessTokenEnc: text("access_token_enc").notNull(),
  refreshTokenEnc: text("refresh_token_enc"),
  expiresAt: integer("expires_at").notNull(),
  scopes: text("scopes").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  lastGmailNotificationAt: text("last_gmail_notification_at").notNull().default(""),
  lastWatchRenewedAt: text("last_watch_renewed_at").notNull().default(""),
});

export const appUsers = sqliteTable("app_users", {
  email: text("email").primaryKey(),
  role: text("role", { enum: ["admin", "tester"] }).notNull().default("tester"),
  status: text("status", { enum: ["invited", "active", "suspended"] }).notNull().default("invited"),
  invitedBy: text("invited_by").notNull().default(""),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  lastAccessAt: text("last_access_at").notNull().default(""),
  accessCount: integer("access_count").notNull().default(0),
}, (table) => [index("idx_app_users_status").on(table.status, table.updatedAt)]);

export const accessEvents = sqliteTable("access_events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: text("user_id").notNull(),
  email: text("email").notNull(),
  eventType: text("event_type").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [index("idx_access_events_created").on(table.createdAt)]);

export const systemEvents = sqliteTable("system_events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: text("user_id").notNull().default(""),
  eventType: text("event_type").notNull(),
  detail: text("detail").notNull().default(""),
  createdAt: text("created_at").notNull(),
}, (table) => [index("idx_system_events_type_created").on(table.eventType, table.createdAt)]);

export const extractionRules = sqliteTable(
  "extraction_rules",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: text("user_id").notNull(),
    name: text("name").notNull(),
    sender: text("sender").notNull(),
    subjectContains: text("subject_contains").notNull(),
    fieldsJson: text("fields_json").notNull(),
    spreadsheetId: text("spreadsheet_id").notNull().default(""),
    spreadsheetName: text("spreadsheet_name").notNull().default(""),
    sheetName: text("sheet_name").notNull().default(""),
    sheetHeadersJson: text("sheet_headers_json").notNull().default("[]"),
    mappingsJson: text("mappings_json").notNull().default("{}"),
    active: integer("active", { mode: "boolean" }).notNull().default(false),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [index("idx_extraction_rules_user_updated").on(table.userId, table.updatedAt)],
);

export const processingHistory = sqliteTable(
  "processing_history",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: text("user_id").notNull(),
    ruleId: integer("rule_id"),
    receivedAt: text("received_at").notNull(),
    subject: text("subject").notNull(),
    extractedCount: integer("extracted_count").notNull().default(0),
    destination: text("destination").notNull().default(""),
    status: text("status", { enum: ["success", "review", "failed"] }).notNull(),
    errorMessage: text("error_message").notNull().default(""),
    createdAt: text("created_at").notNull(),
  },
  (table) => [index("idx_processing_history_user_created").on(table.userId, table.createdAt)],
);

export const processedMessages = sqliteTable(
  "processed_messages",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: text("user_id").notNull(),
    ruleId: integer("rule_id").notNull(),
    gmailMessageId: text("gmail_message_id").notNull(),
    processedAt: text("processed_at").notNull(),
  },
  (table) => [
    uniqueIndex("uidx_processed_messages_owner_rule_message").on(
      table.userId,
      table.ruleId,
      table.gmailMessageId,
    ),
  ],
);
