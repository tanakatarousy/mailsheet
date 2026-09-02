export type ExtractionMethod =
  | "after"
  | "between"
  | "number"
  | "money"
  | "date"
  | "email"
  | "phone"
  | "regex";

export type ExtractionRule = {
  id: number;
  name: string;
  method: ExtractionMethod;
  start: string;
  end: string;
  pattern: string;
};

export type DetectedField = {
  name: string;
  value: string;
  rule: ExtractionRule;
};

export type SelectionRule = {
  suggestedName: string;
  rule: ExtractionRule;
};

export const sampleEmail = `新しい応募がありました。

氏名：山田 太郎
応募求人：営業スタッフ
応募日時：2026/09/02 10:42
電話番号：090-1234-5678
メール：taro.yamada@example.com`;

export const initialRules: ExtractionRule[] = [
  { id: 1, name: "氏名", method: "after", start: "氏名：", end: "", pattern: "" },
  { id: 2, name: "応募求人", method: "after", start: "応募求人：", end: "", pattern: "" },
  { id: 3, name: "応募日時", method: "date", start: "応募日時：", end: "", pattern: "" },
  { id: 4, name: "電話番号", method: "phone", start: "電話番号：", end: "", pattern: "" },
];

const firstLine = (value: string) => value.split(/\r?\n/)[0]?.trim() ?? "";

function valueAfter(body: string, marker: string) {
  if (!marker) return "";
  const index = body.indexOf(marker);
  if (index < 0) return "";
  return firstLine(body.slice(index + marker.length));
}

function scopedText(body: string, rule: ExtractionRule) {
  return rule.start ? valueAfter(body, rule.start) : body;
}

export function extractValue(body: string, rule: ExtractionRule) {
  const scope = scopedText(body, rule);

  switch (rule.method) {
    case "after":
      return valueAfter(body, rule.start);
    case "between": {
      if (!rule.start || !rule.end) return "";
      const startIndex = body.indexOf(rule.start);
      if (startIndex < 0) return "";
      const rest = body.slice(startIndex + rule.start.length);
      const endIndex = rest.indexOf(rule.end);
      return endIndex < 0 ? "" : rest.slice(0, endIndex).trim();
    }
    case "number":
      return scope.match(/[+-]?(?:\d[\d,]*)(?:\.\d+)?/)?.[0] ?? "";
    case "money":
      return scope.match(/(?:¥|￥)?\s?\d[\d,]*(?:円)?/)?.[0]?.trim() ?? "";
    case "date":
      return (
        scope.match(/\d{4}[/-]\d{1,2}[/-]\d{1,2}(?:\s+\d{1,2}:\d{2})?/)?.[0] ??
        scope.match(/\d{1,2}月\d{1,2}日(?:\s+\d{1,2}:\d{2})?/)?.[0] ??
        ""
      );
    case "email":
      return scope.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] ?? "";
    case "phone":
      return scope.match(/(?:0\d{1,4}[-ー－]?\d{1,4}[-ー－]?\d{3,4})/)?.[0] ?? "";
    case "regex":
      if (!rule.pattern) return "";
      try {
        const match = new RegExp(rule.pattern, "m").exec(body);
        return (match?.[1] ?? match?.[0] ?? "").trim();
      } catch {
        return "";
      }
    default:
      return "";
  }
}

export const methodLabels: Record<ExtractionMethod, string> = {
  after: "「○○」の後ろ",
  between: "「○○」と「○○」の間",
  number: "数字として取得",
  money: "金額として取得",
  date: "日付として取得",
  email: "メールアドレス",
  phone: "電話番号",
  regex: "本文から自動設定",
};

const cleanLabel = (value: string) => value
  .replace(/<[^>]+>/g, "")
  .replace(/^[\s■□◇◆*#・\d.]+/, "")
  .replace(/[【】[\]*\s]+/g, " ")
  .trim()
  .slice(0, 60);

const cleanDetectedValue = (value: string) => value
  .replace(/<br\s*\/?>/gi, "\n")
  .replace(/<[^>]+>/g, "")
  .replace(/^\s*(?:\[|「|『)/, "")
  .replace(/(?:\]|」|』)\s*$/, "")
  .trim();

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const flexibleLabelPattern = (value: string) => Array.from(value.replace(/[\s\u3000]+/g, ""))
  .map(escapeRegex)
  .join("\\s*");

/** Builds a reusable capture rule from a value selected in the sample mail. */
export function ruleFromSelection(body: string, selectedText: string, id: number, name = ""): SelectionRule | null {
  const selected = selectedText.trim();
  if (!selected || selected.length > 500) return null;
  const startIndex = body.indexOf(selected);
  if (startIndex < 0) return null;

  const before = body.slice(0, startIndex);
  const currentPrefix = before.slice(before.lastIndexOf("\n") + 1);
  const separator = currentPrefix.match(/(?:^|[｜|,]\s*)([^｜|,]{1,80}?)(?:：|:|＞|＝＞|=>|->)\s*$/);
  const bracketLabel = currentPrefix.match(/(?:【([^】\r\n]{1,80})】|\[([^\]\r\n]{1,80})\])\s*$/);
  let suggestedName = "選択項目";
  let pattern = "";
  const genericEnd = "(?=\\s*(?:【[^】\\r\\n]{1,80}】|\\[[^\\]\\r\\n]{1,80}\\])|\\r?\\n|[｜|,]|$)";

  if (bracketLabel) {
    const rawLabel = bracketLabel[1] || bracketLabel[2];
    const open = bracketLabel[1] ? "【" : "[";
    const close = bracketLabel[1] ? "】" : "]";
    suggestedName = cleanLabel(rawLabel) || suggestedName;
    pattern = `${escapeRegex(open)}\\s*${flexibleLabelPattern(rawLabel)}\\s*${escapeRegex(close)}\\s*([\\s\\S]*?)${genericEnd}`;
  } else if (separator?.[1]) {
    const rawLabel = separator[1];
    suggestedName = cleanLabel(rawLabel) || suggestedName;
    pattern = `${flexibleLabelPattern(rawLabel)}\\s*(?:：|:|＞|＝＞|=>|->)\\s*([\\s\\S]*?)${genericEnd}`;
  } else {
    const previousLines = before.slice(0, before.lastIndexOf("\n")).split(/\r?\n/).filter((line) => line.trim());
    const heading = previousLines.at(-1)?.trim() ?? "";
    if (heading && /^(?:■|◆|【|\[|#)/.test(heading)) {
      suggestedName = cleanLabel(heading) || suggestedName;
      pattern = `${escapeRegex(heading)}\\s*\\r?\\n\\s*([\\s\\S]*?)(?=\\r?\\n\\s*(?:■|◆|【|\\[|#|━{4,}|-{5,})|(?![\\s\\S]))`;
    } else {
      // There is no reusable label around the selection. Keep the selection usable,
      // but never bind the rule to neighboring sample values.
      pattern = `(${escapeRegex(selected)})`;
    }
  }

  return {
    suggestedName: name.trim() || suggestedName,
    rule: { id, name: name.trim() || suggestedName, method: "regex", start: "", end: "", pattern },
  };
}

/** Detects common label/value layouts so users do not have to write regexes. */
export function detectFields(body: string): DetectedField[] {
  const normalized = body.replace(/\r/g, "");
  const found: Array<{ name: string; value: string; pattern: string }> = [];
  const seen = new Set<string>();
  const push = (name: string, value: string, pattern: string) => {
    const cleanName = cleanLabel(name);
    const cleanValue = cleanDetectedValue(value);
    if (!cleanName || !cleanValue || cleanValue.length > 500) return;
    const key = `${cleanName}\u0000${cleanValue}`;
    if (seen.has(key)) return;
    seen.add(key);
    found.push({ name: cleanName, value: cleanValue, pattern });
  };

  // JSON-like data.
  for (const match of normalized.matchAll(/"([^"\n]+)"\s*:\s*"([^"\n]*)"/g)) {
    push(match[1], match[2], `"${escapeRegex(match[1])}"\\s*:\\s*"([^"\\n]*)"`);
  }

  // HTML blocks where the label and value are in neighboring elements.
  for (const match of normalized.matchAll(/<div>\s*(?:【|\[)?([^<【】]+?)(?:】|\])?\s*<\/div>\s*<div>([\s\S]*?)<\/div>/gi)) {
    push(match[1], match[2], `<div>\\s*[【\\[]?${escapeRegex(match[1].trim())}[】\\]]?\\s*<\\/div>\\s*<div>([\\s\\S]*?)<\\/div>`);
  }

  const lines = normalized.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) continue;

    // Question/answer forms need the preceding question to distinguish repeated "回答" labels.
    const question = line.match(/^Q\s*(\d+)[.．]?\s*(.+)$/i);
    if (question) {
      let answerIndex = index + 1;
      while (answerIndex < lines.length && !lines[answerIndex].trim()) answerIndex += 1;
      const answer = lines[answerIndex]?.trim().match(/^回答\s*(?:：|:)\s*\[?\s*(.*?)\s*\]?$/);
      if (answer?.[1]) {
        const name = `Q${question[1]} ${question[2]}`;
        push(name, answer[1], `${escapeRegex(line)}[\\s\\S]*?回答\\s*(?:：|:)\\s*\\[?\\s*([^\\]\\n]+)`);
      }
    }

    const bracketed = line.match(/^\[([^\]]+)\]\s+(.+)$/);
    if (bracketed) {
      push(bracketed[1], bracketed[2], `\\[${escapeRegex(bracketed[1])}\\]\\s*([^\\n]+)`);
      continue;
    }

    // CSV header followed by a CSV value row.
    if (line.includes(",") && lines[index + 1]?.includes(",")) {
      const headers = line.split(",").map((item) => item.trim());
      const values = lines[index + 1].split(",").map((item) => item.trim());
      if (headers.length === values.length && headers.length > 1) {
        headers.forEach((header, column) => push(
          header,
          values[column],
          `${escapeRegex(line)}\\s*\\n(?:[^,]*,){${column}}([^,\\n]*)`,
        ));
      }
    }

    // [label] value, label: value, label ＞ value, label => value and decorated variants.
    const inline = line.match(/^(?:[-*・]\s*)?(?:\[([^\]]+)\]|【([^】]+)】|(.{1,60}?))\s*(?:：|:|＞|＝＞|=>|->)\s*(.+)$/);
    if (inline) {
      const label = inline[1] || inline[2] || inline[3] || "項目";
      const value = inline[4];
      const separatorPattern = "(?:：|:|＞|＝＞|=>|->)";
      push(label, value.split(/\s*[｜|]\s*/)[0], `${flexibleLabelPattern(label)}\\s*${separatorPattern}\\s*([^\\n｜|]+)`);
      for (const part of value.split(/\s*[｜|]\s*/).slice(1)) {
        const nested = part.match(/^(.{1,40}?)(?:：|:)\s*(.+)$/);
        if (nested) push(nested[1], nested[2], `${escapeRegex(nested[1].trim())}\\s*(?:：|:)\\s*([^\\n｜|]+)`);
      }
      continue;
    }

    // A heading on one line followed by its value on the next non-empty line.
    const heading = line.match(/^(?:■|◆|【)(?:\s*)([^】\n]+?)(?:】)?$/);
    if (heading) {
      let next = index + 1;
      while (next < lines.length && !lines[next].trim()) next += 1;
      if (next < lines.length && !/^(?:■|◆|【)/.test(lines[next].trim())) {
        let end = next + 1;
        while (end < lines.length && !/^(?:■|◆|【|━{4,}|-{5,})/.test(lines[end].trim())) end += 1;
        const blockValue = lines.slice(next, end).join("\n").trim();
        push(heading[1], blockValue, `${escapeRegex(line)}\\s*\\n\\s*([\\s\\S]*?)(?=\\n\\s*(?:■|◆|【|━{4,}|-{5,})|(?![\\s\\S]))`);
      }
    }

    // Bullet-only forms: infer useful names from the value type; otherwise keep its position.
    const bullet = line.match(/^・\s*(.+)$/);
    if (bullet) {
      const value = bullet[1];
      const name = /@/.test(value) ? "メール" : /0\d[-\d]{8,}/.test(value) ? "電話番号" : /^\d+歳/.test(value) ? "年齢" : `上から${index + 1}番目`;
      push(name, value, `^(?:・[^\\n]*\\n){${Math.max(0, lines.slice(0, index).filter((item) => /^・/.test(item.trim())).length)}}・\\s*([^\\n]+)`);
    }
  }

  return found.slice(0, 30).map((item, index) => ({
    name: item.name,
    value: item.value,
    rule: { id: index + 1, name: item.name, method: "regex", start: "", end: "", pattern: item.pattern },
  }));
}
