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
  aliases?: string[];
  anchorConfirmed?: boolean;
  locator?: SafeExtractionLocator;
};

export type SafeExtractionLocator = {
  version: 2;
  kind: "label" | "block" | "json" | "qa";
  label?: string;
  bracketed?: boolean;
  inline?: boolean;
  innerLabel?: string;
  nextLabel?: string;
  nextLabelBracketed?: boolean;
  suffix?: string;
  lineEnd?: boolean;
  balancedEnd?: "()" | "（）" | "【】" | "[]" | "「」" | "『』" | "〈〉" | "“”" | "‘’";
  includeLabel?: boolean;
  sampleBracketCount?: number;
  samplePlainLabelCount?: number;
  sampleBracketLabels?: string[];
  samplePlainLabels?: string[];
  sampleDelimiterShape?: string[];
  sampleValueType?: "text" | "number" | "money" | "date" | "email" | "phone";
  sampleContextLabels?: string[];
  heading?: string;
  endHeading?: string;
  path?: string[];
  jsonType?: "string" | "number" | "boolean";
  question?: string;
  qaBracketed?: boolean;
};

export type ExtractionResult = {
  value: string;
  status: "ok" | "missing" | "ambiguous" | "invalid";
  reason: string;
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

const cleanAnchorLabel = (value: string) => value
  .normalize("NFKC")
  .trim()
  .replace(/^[\s*#・■□◇◆【\u005b「『]+/, "")
  .replace(/\s*(?:：|:|＞|＝＞|=>|->|=|＝)\s*$/, "")
  .replace(/[】\]」』\s*]+$/, "")
  .replace(/[\s\u3000]+/g, "")
  .trim();

const semanticLabel = (value: string) => cleanAnchorLabel(value).toLowerCase();
const safeAliases = (rule: ExtractionRule) => Array.isArray(rule.aliases)
  ? rule.aliases.filter((value): value is string => typeof value === "string" && Boolean(value.trim()) && value.trim().length <= 100 && !/[\r\n]/.test(value)).map((value) => value.trim()).slice(0, 10)
  : [];
const extractionAliasesAreValid = (rule: ExtractionRule) => rule.aliases === undefined
  || (Array.isArray(rule.aliases)
    && rule.aliases.length <= 10
    && rule.aliases.every((value) => typeof value === "string" && Boolean(value.trim()) && value.trim().length <= 100 && !/[\r\n]/.test(value)));

export function extractionAnchorMatchesName(rule: ExtractionRule) {
  if (rule.method === "regex") return true;
  const name = semanticLabel(rule.name);
  if (!name) return false;
  return [rule.start, ...safeAliases(rule)].some((value) => {
    const rawMarker = String(value || "").trim();
    const pairedOpeners: Record<string, string> = { "【": "】", "[": "]", "（": "）", "(": ")", "「": "」", "『": "』" };
    const trailingOpener = rule.method === "between" ? rawMarker.at(-1) || "" : "";
    const markerSource = trailingOpener && pairedOpeners[trailingOpener] === String(rule.end || "").trim()
      ? rawMarker.slice(0, -1)
      : rawMarker;
    const marker = semanticLabel(markerSource);
    if (!marker) return false;
    return marker === name;
  });
}

function extractionAnchorIsAccepted(rule: ExtractionRule) {
  return rule.method === "regex"
    || rule.anchorConfirmed === true
    || extractionAnchorMatchesName(rule);
}

type AnchorMatch = { index: number; end: number };

function standardQuoteDepth(body: string, index: number) {
  const lineStart = body.lastIndexOf("\n", Math.max(0, index - 1)) + 1;
  const prefix = body.slice(lineStart, index);
  if (!/^[ \t]*(?:>[ \t]*)+$/.test(prefix)) return 0;
  return Array.from(prefix).filter((character) => character === ">").length;
}

function exactMatches(body: string, marker: string) {
  const matches: AnchorMatch[] = [];
  let from = 0;
  while (marker && from <= body.length) {
    const index = body.indexOf(marker, from);
    if (index < 0) break;
    matches.push({ index, end: index + marker.length });
    from = index + Math.max(1, marker.length);
  }
  return matches;
}

function hasLabelBoundary(body: string, index: number) {
  if (index === 0) return true;
  const previous = body[index - 1] || "";
  return /[\n\r｜|\t\u3000■□◇◆#*・]/u.test(previous)
    || (previous === " " && body[index - 2] === " ")
    || standardQuoteDepth(body, index) > 0;
}

function hasStructuredMarker(marker: string) {
  return /^[【\u005b]/.test(marker.trim()) || /(?:：|:|＞|＝＞|=>|->|=|＝)/.test(marker);
}

const LABEL_SEPARATOR_PATTERN = /＝＞|=>|->|：|:|＞|=|＝/gmu;
const LABEL_SEPARATORS = ["＝＞", "=>", "->", "：", ":", "＞", "=", "＝"] as const;

/**
 * Finds structural labels with a constant regular expression and compares the
 * normalized token afterwards.  The user-controlled label is never compiled
 * as regular-expression source.
 */
type LabelMatch = AnchorMatch & { label: string };
type ReverseLabelTrie = { next: Map<string, ReverseLabelTrie>; label?: string };

function markerLookup(markers: string[]) {
  const lookup = new Map<string, string>();
  for (const marker of markers) {
    const semantic = semanticLabel(marker);
    if (semantic && !lookup.has(semantic)) lookup.set(semantic, marker);
  }
  return lookup;
}

function reverseLabelTrie(markers: string[]) {
  const root: ReverseLabelTrie = { next: new Map() };
  for (const [semantic, label] of markerLookup(markers)) {
    let node = root;
    for (const character of Array.from(semantic).reverse()) {
      const child = node.next.get(character) || { next: new Map<string, ReverseLabelTrie>() };
      node.next.set(character, child);
      node = child;
    }
    node.label = label;
  }
  return root;
}

function formattedLabelsMatch(body: string, markers: string[]) {
  const matches: LabelMatch[] = bracketLabelsMatchAnywhere(body, markers).filter((match) => hasLabelBoundary(body, match.index));
  matches.push(...plainStructuralLabelsMatch(body, markers, 0, body.length, "formatted"));
  return uniqueLabelMatches(matches);
}

function formattedLabelMatches(body: string, marker: string) {
  return formattedLabelsMatch(body, [marker]);
}

function bracketLabelsMatchAnywhere(body: string, markers: string[]) {
  const lookup = markerLookup(markers);
  if (!lookup.size) return [];
  const matches: LabelMatch[] = [];
  for (let index = 0; index < body.length; index += 1) {
    const opener = body[index];
    const closer = opener === "【" ? "】" : opener === "[" ? "]" : "";
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

function bracketLabelMatchesAnywhere(body: string, marker: string) {
  return bracketLabelsMatchAnywhere(body, [marker]);
}

function labelStartBeforeSeparator(body: string, trie: ReverseLabelTrie, from: number, separatorIndex: number, mode: "formatted" | "inline") {
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
      const formattedBoundary = /[\n\r｜|\t\u3000■□◇◆#*・]/u.test(previous)
        || (previous === " " && body[start - 2] === " ")
        || standardQuoteDepth(body, start) > 0;
      if (mode === "inline" ? inlineBoundary : formattedBoundary) return { start, label: node.label };
    }
  }
  return null;
}

function uniqueLabelMatches(matches: LabelMatch[]) {
  const unique = new Map<number, LabelMatch>();
  for (const match of matches) {
    const current = unique.get(match.index);
    if (!current || match.end > current.end) unique.set(match.index, match);
  }
  return [...unique.values()].sort((left, right) => left.index - right.index);
}

function plainStructuralLabelsMatch(body: string, markers: string[], from: number, to: number, mode: "formatted" | "inline") {
  const trie = reverseLabelTrie(markers);
  if (!trie.next.size || from >= to) return [];
  const matches: LabelMatch[] = [];
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

function plainStructuralMatches(body: string, marker: string, from: number, to: number, mode: "formatted" | "inline") {
  return plainStructuralLabelsMatch(body, [marker], from, to, mode);
}

function plainLabelMatchesAfter(body: string, marker: string, from: number, to: number) {
  return plainStructuralMatches(body, marker, from, to, "inline");
}

function findRuleAnchors(body: string, rule: ExtractionRule) {
  const markers = [rule.start, ...safeAliases(rule)].map((value) => String(value || "").trim()).filter(Boolean);
  const formatted = formattedLabelsMatch(body, markers);
  const candidates = formatted.length
    ? formatted
    : markers.flatMap((marker) => hasStructuredMarker(marker)
      ? exactMatches(body, marker).filter((match) => hasLabelBoundary(body, match.index))
      : []);
  const unique = new Map<number, AnchorMatch>();
  for (const match of candidates) {
    const current = unique.get(match.index);
    if (!current || match.end > current.end) unique.set(match.index, match);
  }
  return [...unique.values()].sort((left, right) => left.index - right.index);
}

function fieldValueAfter(body: string, end: number, rule: ExtractionRule, allRules: ExtractionRule[]) {
  let valueStart = end;
  while (/[ \t]/.test(body[valueStart] || "")) valueStart += 1;
  while (body[valueStart] === "\n") {
    valueStart += 1;
    while (/[ \t]/.test(body[valueStart] || "")) valueStart += 1;
  }
  const lineEnd = body.indexOf("\n", valueStart) < 0 ? body.length : body.indexOf("\n", valueStart);
  let boundary = lineEnd;
  for (const token of ["｜", "|"]) {
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
      ...plainStructuralLabelsMatch(candidateWindow, markers, 0, candidateWindow.length, "inline"),
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

function candidateLengthIssue(value: string) {
  if (value.length > 500) return "取得範囲が長すぎます。値の直前の見出しと、終わりの位置を確認してください。";
  return "";
}

function unboundedCandidateIssue(value: string) {
  const lengthIssue = candidateLengthIssue(value);
  if (lengthIssue) return lengthIssue;
  const structuralLabels = [...value.matchAll(/(?:【[^】\n]{1,80}】|\[[^\]\n]{1,80}\])/g)];
  if (structuralLabels.length) {
    return "次の項目との境界を判定できません。本文から値だけを選び直すか、2つの文字で範囲を指定してください。";
  }
  const possiblePlainLabel = /(?:^|[\n \t\u3000]+|[／/;；,，、])(?:[*#・■□◇◆]+\s*)?([\p{L}][\p{L}\p{N}_・\- \t\u3000]{0,30}?)\s*(?:：|:|＞|＝＞|=>|->)/gmu;
  for (const match of value.matchAll(possiblePlainLabel)) {
    const label = String(match[1] || "").replace(/[\s\u3000]+/g, "").toLowerCase();
    if (!/^(?:https?|mailto)$/.test(label)) {
      return "次の項目との境界を判定できません。続く項目も追加するか、本文から値だけを選び直してください。";
    }
  }
  return "";
}

function boundedCandidateIssue(value: string) {
  const lengthIssue = candidateLengthIssue(value);
  if (lengthIssue) return lengthIssue;
  if (/(?:^|\n)[ \t\u3000]*(?:【[^】\n]{1,80}】|\[[^\]\n]{1,80}\]|[■◆]|#{1,6}[ \t]|━{4,}|-{5,})/.test(value)) {
    return "指定した範囲に別の項目が含まれています。開始文字と終わりの文字を確認してください。";
  }
  return "";
}

type SampleValueType = NonNullable<SafeExtractionLocator["sampleValueType"]>;
type BalancedEnd = NonNullable<SafeExtractionLocator["balancedEnd"]>;

const DELIMITER_PAIRS: Record<string, { close: string; token: BalancedEnd }> = {
  "(": { close: ")", token: "()" },
  "（": { close: "）", token: "（）" },
  "【": { close: "】", token: "【】" },
  "[": { close: "]", token: "[]" },
  "「": { close: "」", token: "「」" },
  "『": { close: "』", token: "『』" },
  "〈": { close: "〉", token: "〈〉" },
  "“": { close: "”", token: "“”" },
  "‘": { close: "’", token: "‘’" },
};
const DELIMITER_CLOSERS = new Map(Object.entries(DELIMITER_PAIRS).map(([open, pair]) => [pair.close, { open, token: pair.token }]));
const BALANCED_ENDS = new Set<BalancedEnd>(Object.values(DELIMITER_PAIRS).map(({ token }) => token));

function delimiterShape(value: string) {
  const stack: Array<{ close: string; token: BalancedEnd }> = [];
  const shape: string[] = [];
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

function exactMoneyValue(value: string) {
  return /^(?:(?:¥|￥)\s?[+-]?\d[\d,]*(?:\.\d+)?|[+-]?\d[\d,]*(?:\.\d+)?\s*円)(?:\s*[（(][^()（）\r\n]{0,40}[）)])?$/.test(value.normalize("NFKC").trim());
}

function inferSampleValueType(value: string): SampleValueType {
  const candidate = value.normalize("NFKC").trim();
  if (typedValue(candidate, "email")) return "email";
  if (typedValue(candidate, "phone")) return "phone";
  if (typedValue(candidate, "date")) return "date";
  if (/[¥￥]|円/u.test(candidate) && exactMoneyValue(candidate)) return "money";
  if (typedValue(candidate, "number")) return "number";
  return "text";
}

function valueMatchesSampleType(value: string, type: SampleValueType) {
  if (type === "text") return true;
  if (type === "money") return exactMoneyValue(value);
  return Boolean(typedValue(value, type));
}

function signatureFor(value: string) {
  const shape = delimiterShape(value);
  if (!shape) return null;
  return {
    sampleBracketCount: structuralBracketCount(value),
    samplePlainLabelCount: structuralPlainLabelCount(value),
    sampleBracketLabels: structuralBracketLabels(value),
    samplePlainLabels: structuralPlainLabels(value),
    sampleDelimiterShape: shape,
    sampleValueType: inferSampleValueType(value),
  };
}

function safeLocatorIsValid(locator: SafeExtractionLocator | undefined) {
  if (!locator || typeof locator !== "object" || Array.isArray(locator) || locator.version !== 2) return false;
  const raw = locator as unknown as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(raw, "genericEnd")) return false;
  const textIsSafe = (value: unknown, required = false, maxLength = 500) => {
    if (value === undefined || value === null) return !required;
    if (typeof value !== "string") return false;
    return (!required || Boolean(value.trim())) && value.length <= maxLength && !/[\r\n]/.test(value);
  };
  const booleanFlagsAreSafe = ["bracketed", "inline", "includeLabel", "nextLabelBracketed", "lineEnd", "qaBracketed"]
    .every((key) => {
      const value = (locator as unknown as Record<string, unknown>)[key];
      return value === undefined || typeof value === "boolean";
    });
  if (!booleanFlagsAreSafe) return false;
  const bracketCountIsSafe = Number.isInteger(locator.sampleBracketCount)
    && Number(locator.sampleBracketCount) >= 0 && Number(locator.sampleBracketCount) <= 50;
  const plainLabelCountIsSafe = Number.isInteger(locator.samplePlainLabelCount)
    && Number(locator.samplePlainLabelCount) >= 0 && Number(locator.samplePlainLabelCount) <= 50;
  const signatureIsSafe = (value: unknown) => Array.isArray(value)
    && value.length <= 50 && value.every((part) => textIsSafe(part, true, 100));
  const shapeIsSafe = Array.isArray(locator.sampleDelimiterShape)
    && locator.sampleDelimiterShape.length <= 100
    && locator.sampleDelimiterShape.every((part) => typeof part === "string" && /^(?:\/?(?:\(\)|（）|【】|\[\]|「」|『』|〈〉|“”|‘’))$/.test(part));
  const valueTypeIsSafe = ["text", "number", "money", "date", "email", "phone"].includes(String(locator.sampleValueType || ""));
  const contextLabelsAreSafe = Array.isArray(locator.sampleContextLabels)
    && locator.sampleContextLabels.length >= 1
    && locator.sampleContextLabels.length <= 4
    && locator.sampleContextLabels[0] === "@anchor"
    && locator.sampleContextLabels.slice(1).every((part) => typeof part === "string"
      && /^(?:b|p):[^\r\n]{1,100}$/.test(part));
  const commonSignatureIsSafe = bracketCountIsSafe
    && plainLabelCountIsSafe
    && signatureIsSafe(locator.sampleBracketLabels)
    && signatureIsSafe(locator.samplePlainLabels)
    && locator.sampleBracketLabels!.length === locator.sampleBracketCount
    && locator.samplePlainLabels!.length === locator.samplePlainLabelCount
    && shapeIsSafe
    && valueTypeIsSafe;
  if (locator.kind === "label") {
    const boundaries = [locator.lineEnd === true, Boolean(locator.nextLabel), Boolean(locator.suffix), Boolean(locator.balancedEnd)].filter(Boolean).length;
    return textIsSafe(locator.label, true, 100)
      && textIsSafe(locator.innerLabel, false, 100)
      && textIsSafe(locator.nextLabel, false, 100)
      && textIsSafe(locator.suffix, false, 100)
      && commonSignatureIsSafe
      && contextLabelsAreSafe
      && (locator.balancedEnd === undefined || BALANCED_ENDS.has(locator.balancedEnd))
      && (!locator.includeLabel || locator.bracketed === true)
      && !(locator.sampleValueType === "text" && (locator.lineEnd === true || Boolean(locator.suffix)))
      && boundaries === 1;
  }
  if (locator.kind === "block") return textIsSafe(locator.heading, true) && textIsSafe(locator.endHeading, true) && commonSignatureIsSafe;
  if (locator.kind === "json") return Array.isArray(locator.path)
    && locator.path.length > 0
    && locator.path.length <= 20
    && locator.path.every((part) => textIsSafe(part, true, 100) && !/^(?:0|[1-9]\d*)$/.test(part))
    && ["string", "number", "boolean"].includes(String(locator.jsonType || ""));
  return locator.kind === "qa"
    && textIsSafe(locator.question, true)
    && typeof locator.qaBracketed === "boolean"
    && commonSignatureIsSafe;
}

export function extractionLocatorIsSafe(locator: SafeExtractionLocator | undefined) {
  return safeLocatorIsValid(locator);
}

function proseCandidateIssue(value: string) {
  const candidate = String(value || "").normalize("NFKC").trim();
  const proseSurface = candidate
    .replace(/“[^”\r\n]*”|‘[^’\r\n]*’|〈[^〉\r\n]*〉|「[^」\r\n]*」|『[^』\r\n]*』/gu, " ")
    .trim();
  const instruction = /^(?:とは|には|について|の(?:意味|説明)|は(?:必須|任意|必要|不要|入力|記入|選択|確認|設定|保存|送信|表示|使用|利用)|が(?:必須|必要|不要)|を(?:指す|ご?(?:入力|記入|選択|確認|設定|保存|送信|参照|使用|利用))|欄(?:には|へ|に|を)|(?:へ|に)(?:ご?(?:入力|記入|選択|設定))|なら(?:省略|入力|記入|選択|不要|任意)|という(?:表記|意味|項目|名称|説明)|と(?:表示|記載)|や$|または$)/u;
  const explanatorySentence = /^は.+(?:です|ます|必要|任意)(?:[。.!！]|$)/u;
  const requestSentence = /(?:入力|記入|選択|設定|保存|送信|確認|参照)(?:を)?(?:して)?(?:ください|下さい)(?:[。.!！]|$)/u;
  const genericExplanation = /^(?:(?:応募者|申込者|注文者|予約者|利用者|顧客|お客様)の)?(?:氏名|名前|メール(?:アドレス)?|電話番号|住所)(?:です|となります|を表します)(?:[。.!！]|$)/u;
  const missingMarker = /^(?:未入力|未記入|未設定|不明|なし|無し|該当なし|N\/?A|[-ー―—])(?:[。.!！]|$)/iu;
  return instruction.test(proseSurface) || explanatorySentence.test(proseSurface) || requestSentence.test(proseSurface) || genericExplanation.test(proseSurface) || missingMarker.test(candidate)
    ? "説明文中の見出しに見えるため、自動転記しません。"
    : "";
}

function skipHorizontalSpace(body: string, from: number) {
  let index = from;
  while (/[ \t\u3000]/.test(body[index] || "")) index += 1;
  return index;
}

function positionAfterInnerLabel(body: string, from: number, label: string) {
  let index = skipHorizontalSpace(body, from);
  const opener = body[index];
  const closer = opener === "【" ? "】" : opener === "[" ? "]" : "";
  if (!closer) return -1;
  const close = body.indexOf(closer, index + 1);
  if (close < 0 || semanticLabel(body.slice(index + 1, close)) !== semanticLabel(label)) return -1;
  index = skipHorizontalSpace(body, close + 1);
  for (const separator of ["＝＞", "=>", "->", "：", ":", "＞", "=", "＝"]) {
    if (!body.startsWith(separator, index)) continue;
    index = skipHorizontalSpace(body, index + separator.length);
    break;
  }
  return index;
}

function structuralBracketCount(value: string) {
  return Array.from(value.matchAll(/【[^】\r\n]{1,80}】|\[[^\]\r\n]{1,80}\]/g)).length;
}

function structuralBracketLabels(value: string) {
  return Array.from(value.matchAll(/【([^】\r\n]{1,80})】|\[([^\]\r\n]{1,80})\]/g), (match) => semanticLabel(match[1] || match[2] || ""));
}

type StructuralLabelToken = { index: number; end: number; signature: string };

function structuralLabelTokens(value: string) {
  const bracketTokens: StructuralLabelToken[] = Array.from(
    value.matchAll(/【([^】\r\n]{1,80})】|\[([^\]\r\n]{1,80})\]/g),
    (match) => ({
      index: match.index ?? 0,
      end: (match.index ?? 0) + match[0].length,
      signature: `b:${semanticLabel(match[1] || match[2] || "")}`,
    }),
  ).filter((token) => token.signature.length > 2 && token.signature.length <= 102);
  const possible = /(?:^|[\n \t\u3000]+|[｜|／/;；,，、])(?:[*#・■□◇◆]+[ \t\u3000]*)*([\p{L}][\p{L}\p{N}_・\- \t\u3000]{0,30}?)\s*(?:\*{1,2}\s*)?(?:：|:|＞|＝＞|=>|->|=|＝)/gmu;
  const plainTokens: StructuralLabelToken[] = [];
  for (const match of value.matchAll(possible)) {
    const label = String(match[1] || "").replace(/[\s\u3000]+/g, "").toLowerCase();
    if (!label || label.length > 100 || /^(?:https?|mailto)$/.test(label)) continue;
    const offset = match[0].lastIndexOf(String(match[1] || ""));
    const index = (match.index ?? 0) + Math.max(0, offset);
    const end = index + String(match[1] || "").length;
    if (bracketTokens.some((token) => index >= token.index && index < token.end)) continue;
    plainTokens.push({ index, end, signature: `p:${label}` });
  }
  return [...bracketTokens, ...plainTokens]
    .sort((left, right) => left.index - right.index || right.end - left.end)
    .filter((token, index, tokens) => index === 0 || token.index !== tokens[index - 1].index);
}

function structuralPlainLabels(value: string) {
  return structuralLabelTokens(value)
    .filter((token) => token.signature.startsWith("p:"))
    .map((token) => token.signature.slice(2));
}

function structuralPlainLabelCount(value: string) {
  return structuralPlainLabels(value).length;
}

function structuralContextLabels(body: string, anchorEnd: number) {
  const window = body.slice(anchorEnd, Math.min(body.length, anchorEnd + 2_000));
  return ["@anchor", ...structuralLabelTokens(window).slice(0, 3).map((token) => token.signature)];
}

function stripQuotedCandidate(value: string, quoteDepth: number) {
  const trimmed = value.trim();
  if (quoteDepth <= 0 || !trimmed.includes("\n")) return { value: trimmed, issue: "" };
  const lines = trimmed.split("\n");
  for (let lineIndex = 1; lineIndex < lines.length; lineIndex += 1) {
    let index = 0;
    while (/[ \t]/.test(lines[lineIndex][index] || "")) index += 1;
    for (let depth = 0; depth < quoteDepth; depth += 1) {
      if (lines[lineIndex][index] !== ">") {
        return { value: "", issue: "引用行の形式が途中で変わったため、自動転記しません。" };
      }
      index += 1;
      if (lines[lineIndex][index] === " ") index += 1;
    }
    lines[lineIndex] = lines[lineIndex].slice(index);
  }
  return { value: lines.join("\n").trim(), issue: "" };
}

function unbalancedDelimiterIssue(value: string) {
  return delimiterShape(value) ? "" : "値の括弧が対応していないため、自動転記しません。";
}

function structuredLeadingLine(line: string) {
  const value = String(line || "").trim();
  if (!value) return false;
  if (/^(?:━{4,}|-{5,}|[■◆]|#{1,6}(?:\s|$))/.test(value)) return true;
  if (/^(?:【[^】\r\n]{1,120}】|\[[^\]\r\n]{1,120}\])(?:\s*(?:：|:|＞|＝＞|=>|->|=|＝))?/.test(value)) return true;
  return /^(?:[-*・]\s*)?[^\r\n：:＞=]{1,120}?\s*(?:：|:|＞|＝＞|=>|->|=|＝)/u.test(value);
}

function extractedSignatureIssue(value: string, locator: SafeExtractionLocator) {
  if (structuralBracketCount(value) !== locator.sampleBracketCount) {
    return "サンプルと括弧項目の構造が変わったため、自動転記しません。";
  }
  if (structuralPlainLabelCount(value) !== locator.samplePlainLabelCount) {
    return "サンプルと項目の区切り構造が変わったため、自動転記しません。";
  }
  if (JSON.stringify(structuralBracketLabels(value)) !== JSON.stringify(locator.sampleBracketLabels)) {
    return "サンプルと括弧内の見出しが変わったため、自動転記しません。";
  }
  if (JSON.stringify(structuralPlainLabels(value)) !== JSON.stringify(locator.samplePlainLabels)) {
    return "サンプルと項目名の構造が変わったため、自動転記しません。";
  }
  const shape = delimiterShape(value);
  if (!shape) return "値の括弧が対応していないため、自動転記しません。";
  if (JSON.stringify(shape) !== JSON.stringify(locator.sampleDelimiterShape)) {
    return "サンプルと括弧・引用符の構造が変わったため、自動転記しません。";
  }
  if (!valueMatchesSampleType(value, locator.sampleValueType!)) {
    return "サンプルと値の種類が変わったため、自動転記しません。";
  }
  return "";
}

function balancedEndBoundary(body: string, from: number, token: BalancedEnd): ExtractionResult & { end?: number } {
  const pair = Object.entries(DELIMITER_PAIRS).find(([, value]) => value.token === token);
  if (!pair) return { value: "", status: "invalid", reason: "値の終わりを安全に確認できません。" };
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
      if (depth === 0) return { value: "", status: "invalid", reason: "値の括弧が対応していないため、自動転記しません。" };
      depth -= 1;
      if (depth === 0) end = from + index + 1;
    }
  }
  if (depth !== 0) return { value: "", status: "invalid", reason: "値の括弧が対応していないため、自動転記しません。" };
  if (end < 0) return { value: "", status: "missing", reason: "値の終わりにあった括弧が見つかりません。" };
  if (body.slice(end, lineEnd).trim()) return { value: "", status: "invalid", reason: "値の終わりより後ろに文字があるため、自動転記しません。" };
  if (end - from > 500) return { value: "", status: "invalid", reason: candidateLengthIssue(body.slice(from, end)) };
  return { value: "", status: "ok", reason: "", end };
}

function topLevelSuffixIndexes(body: string, from: number, to: number, suffix: string) {
  const stack: string[] = [];
  const indexes: number[] = [];
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

function locatorResult(values: string[], missingReason: string): ExtractionResult {
  if (!values.length) return { value: "", status: "missing", reason: missingReason };
  if (values.length > 1) return { value: "", status: "ambiguous", reason: "同じ取得位置が複数あるため、自動転記しません。" };
  const value = values[0].trim();
  if (!value) return { value: "", status: "invalid", reason: "見出しの後ろに値がありません。" };
  const issue = candidateLengthIssue(value);
  return issue ? { value: "", status: "invalid", reason: issue } : { value, status: "ok", reason: "" };
}

type LabelLocatorLocation = {
  anchor: AnchorMatch;
  valueStart: number;
  contentStart: number;
  quoteDepth: number;
};

function labelLocatorLocations(body: string, locator: SafeExtractionLocator, aliases: string[] = []): LabelLocatorLocation[] {
  const anchorRule: ExtractionRule = {
    id: 0,
    name: locator.label || "",
    method: "after",
    start: locator.label || "",
    end: "",
    pattern: "",
    anchorConfirmed: true,
    aliases,
  };
  const labels = [locator.label || "", ...aliases].filter(Boolean);
  const anchorCandidates = locator.bracketed
    ? bracketLabelsMatchAnywhere(body, labels)
    : locator.inline
      ? plainStructuralLabelsMatch(body, labels, 0, body.length, "inline")
      : findRuleAnchors(body, anchorRule);
  const anchorMap = new Map<number, AnchorMatch>();
  for (const anchor of anchorCandidates) {
    const current = anchorMap.get(anchor.index);
    if (!current || anchor.end > current.end) anchorMap.set(anchor.index, anchor);
  }
  return [...anchorMap.values()]
    .sort((left, right) => left.index - right.index)
    .map((anchor) => {
      const contentStart = locator.innerLabel
        ? positionAfterInnerLabel(body, anchor.end, locator.innerLabel)
        : skipHorizontalSpace(body, anchor.end);
      return {
        anchor,
        valueStart: locator.includeLabel && locator.bracketed ? anchor.index : contentStart,
        contentStart,
        quoteDepth: standardQuoteDepth(body, anchor.index),
      };
    })
    .filter((location) => location.contentStart >= 0);
}

function extractWithSafeLocator(body: string, rule: ExtractionRule): ExtractionResult {
  const locator = rule.locator;
  if (!locator || !safeLocatorIsValid(locator)) {
    return { value: "", status: "invalid", reason: "旧形式の自動取得条件です。本文から値を選び直してください。" };
  }

  if (locator.kind === "label") {
    const locations = labelLocatorLocations(body, locator, safeAliases(rule));
    if (!locations.length) return { value: "", status: "missing", reason: locator.innerLabel ? `見出し「${locator.innerLabel}」が続く取得位置を確認できません。` : `見出し「${locator.label}」が見つかりません。` };
    if (locations.length > 1) return { value: "", status: "ambiguous", reason: `見出し「${locator.label}」が複数あるため、自動転記しません。` };
    const { anchor, valueStart, contentStart, quoteDepth } = locations[0];
    if (!locator.nextLabel && JSON.stringify(structuralContextLabels(body, anchor.end)) !== JSON.stringify(locator.sampleContextLabels)) {
      return { value: "", status: "invalid", reason: "サンプルと周囲の項目構造が変わったため、自動転記しません。" };
    }
    const lineEnd = body.indexOf("\n", contentStart) < 0 ? body.length : body.indexOf("\n", contentStart);
    let end = lineEnd;
    if (locator.nextLabel) {
      const searchEnd = Math.min(body.length, contentStart + 501);
      const nextMatches = locator.nextLabelBracketed
        ? bracketLabelMatchesAnywhere(body.slice(contentStart, searchEnd), locator.nextLabel).map((match) => ({ index: contentStart + match.index, end: contentStart + match.end }))
        : plainLabelMatchesAfter(body, locator.nextLabel, contentStart, searchEnd);
      if (!nextMatches.length) return { value: "", status: "missing", reason: `次の見出し「${locator.nextLabel}」が見つかりません。` };
      if (nextMatches.length > 1) return { value: "", status: "ambiguous", reason: `次の見出し「${locator.nextLabel}」が複数あるため、自動転記しません。` };
      const interveningLabels = structuralLabelTokens(body.slice(contentStart, nextMatches[0].index));
      if (interveningLabels.length) {
        return { value: "", status: "invalid", reason: `見出し「${locator.label}」と次の見出し「${locator.nextLabel}」の間に別の項目があるため、自動転記しません。` };
      }
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
      if (suffixIndexes === null) return { value: "", status: "invalid", reason: "値の括弧が対応していないため、自動転記しません。" };
      if (!suffixIndexes.length) return { value: "", status: "missing", reason: "値の直後にあった目印が見つかりません。" };
      if (suffixIndexes.length > 1) return { value: "", status: "ambiguous", reason: "値の終わり候補が複数あるため、自動転記しません。" };
      end = suffixIndexes[0];
    } else if (locator.balancedEnd) {
      const balanced = balancedEndBoundary(body, contentStart, locator.balancedEnd);
      if (balanced.status !== "ok" || balanced.end === undefined) return balanced;
      end = balanced.end;
    } else if (lineEnd < body.length) {
      const nextLineEnd = body.indexOf("\n", lineEnd + 1);
      const nextLine = body.slice(lineEnd + 1, nextLineEnd < 0 ? body.length : nextLineEnd);
      if (nextLine.trim() && !structuredLeadingLine(nextLine)) {
        return { value: "", status: "invalid", reason: "次の行が値の続きか判定できないため、自動転記しません。次の見出しまで含めて選び直してください。" };
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
    return locatorResult([value], `見出し「${locator.label}」の後ろに値が見つかりません。`);
  }

  if (locator.kind === "block") {
    const lines = body.split("\n");
    const starts = lines.map((line, index) => ({ line, index })).filter(({ line }) => semanticLabel(line) === semanticLabel(locator.heading || ""));
    if (starts.length !== 1) return starts.length ? { value: "", status: "ambiguous", reason: "同じ見出しが複数あるため、自動転記しません。" } : { value: "", status: "missing", reason: `見出し「${locator.heading}」が見つかりません。` };
    let from = starts[0].index + 1;
    while (from < lines.length && !lines[from].trim()) from += 1;
    let to = lines.length;
    if (locator.endHeading) {
      const ends = lines.map((line, index) => ({ line, index })).filter(({ line, index }) => index >= from && semanticLabel(line) === semanticLabel(locator.endHeading || ""));
      if (ends.length !== 1) return ends.length ? { value: "", status: "ambiguous", reason: "値の終わり候補が複数あるため、自動転記しません。" } : { value: "", status: "missing", reason: "値の直後にあった見出しが見つかりません。" };
      to = ends[0].index;
    }
    const value = lines.slice(from, to).join("\n").trim();
    const issue = boundedCandidateIssue(value)
      || (structuralPlainLabelCount(value) > 0 ? "取得範囲に別の項目が含まれているため、自動転記しません。" : "")
      || proseCandidateIssue(value)
      || unbalancedDelimiterIssue(value)
      || extractedSignatureIssue(value, locator);
    return issue ? { value: "", status: "invalid", reason: issue } : locatorResult([value], "見出しの後ろに値が見つかりません。");
  }

  if (locator.kind === "json") {
    try {
      let value: unknown = JSON.parse(body);
      for (const part of locator.path || []) {
        if (value === null || typeof value !== "object" || Array.isArray(value) || !Object.prototype.hasOwnProperty.call(value, part)) {
          return { value: "", status: "missing", reason: "保存したJSON項目の位置が見つかりません。" };
        }
        value = (value as Record<string, unknown>)[part];
      }
      return typeof value === locator.jsonType
        ? locatorResult([String(value)], "保存したJSON項目の値が見つかりません。")
        : { value: "", status: "invalid", reason: "保存したJSON項目の形式が変わったため、自動転記しません。" };
    } catch {
      return { value: "", status: "invalid", reason: "JSON形式が変わったため、自動転記しません。" };
    }
  }

  if (locator.kind === "qa") {
    const lines = body.split("\n");
    const questions = lines.map((line, index) => ({ line: line.trim(), index })).filter(({ line }) => line === String(locator.question || "").trim());
    if (questions.length !== 1) return questions.length ? { value: "", status: "ambiguous", reason: "同じ質問が複数あるため、自動転記しません。" } : { value: "", status: "missing", reason: "設定した質問が見つかりません。" };
    const blockStart = questions[0].index + 1;
    let blockEnd = blockStart;
    while (blockEnd < lines.length && !/^Q\s*\d+[.．]?/i.test(lines[blockEnd].trim())) blockEnd += 1;
    const answers = lines.slice(blockStart, blockEnd)
      .map((line, offset) => ({ index: blockStart + offset, match: line.trim().match(/^回答\s*(?:：|:|=|＝)\s*(.*?)\s*$/) }))
      .filter((item): item is { index: number; match: RegExpMatchArray } => Boolean(item.match));
    if (answers.length > 1) return { value: "", status: "ambiguous", reason: "同じ質問に回答が複数あるため、自動転記しません。" };
    if (!answers.length) return { value: "", status: "missing", reason: "この質問の回答が見つかりません。" };
    let firstContent = blockStart;
    while (firstContent < blockEnd && !lines[firstContent].trim()) firstContent += 1;
    if (answers[0].index !== firstContent) return { value: "", status: "missing", reason: "この質問の直後に回答が見つかりません。" };
    const answerMatch = answers[0].match;
    if (!answerMatch) return { value: "", status: "missing", reason: "この質問の回答が見つかりません。" };
    const answerLine = answerMatch[1] || "";
    const runtimeBracketed = answerLine.startsWith("[") && answerLine.endsWith("]");
    if (runtimeBracketed !== locator.qaBracketed) {
      return { value: "", status: "invalid", reason: "回答欄の括弧形式がサンプルから変わったため、自動転記しません。" };
    }
    const answer = runtimeBracketed ? answerLine.slice(1, -1).trim() : answerLine.trim();
    if (!answer) return locatorResult([], "この質問の回答が見つかりません。");
    const issue = unboundedCandidateIssue(answer)
      || proseCandidateIssue(answer)
      || unbalancedDelimiterIssue(answer)
      || extractedSignatureIssue(answer, locator);
    return issue ? { value: "", status: "invalid", reason: issue } : locatorResult([answer], "この質問の回答が見つかりません。");
  }

  return { value: "", status: "invalid", reason: "安全に確認できない取得条件です。本文から値を選び直してください。" };
}

function typedValue(scope: string, method: ExtractionMethod) {
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
      const year = Number(parts[1] || 2000);
      const month = Number(parts[2]);
      const day = Number(parts[3]);
      const hour = Number(parts[4] || 0);
      const minute = Number(parts[5] || 0);
      const date = new Date(Date.UTC(year, month - 1, day));
      return month >= 1 && month <= 12 && day >= 1
        && date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
        && hour <= 23 && minute <= 59;
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

export function extractValueResult(body: string, rule: ExtractionRule, allRules: ExtractionRule[] = [rule]): ExtractionResult {
  const rawBody = String(body || "");
  if (rawBody.length > 400_000) return { value: "", status: "invalid", reason: "本文が長すぎるため、安全に自動抽出できません。処理履歴から内容を確認してください。" };
  const sourceBody = rawBody.replace(/\r\n?/g, "\n");
  if (sourceBody.length > 200_000) return { value: "", status: "invalid", reason: "本文が長すぎるため、安全に自動抽出できません。処理履歴から内容を確認してください。" };
  if (!Array.isArray(allRules) || allRules.length > 50) return { value: "", status: "invalid", reason: "取得項目が多すぎるため、安全に自動抽出できません。" };
  if (!extractionAliasesAreValid(rule) || allRules.some((candidate) => !extractionAliasesAreValid(candidate))) {
    return { value: "", status: "invalid", reason: "別の見出しは100文字以内・10件までで入力してください。" };
  }
  const labelBudget = allRules.reduce((total, candidate) => total + [candidate.start, candidate.locator?.label || "", ...safeAliases(candidate)]
    .reduce((sum, marker) => sum + semanticLabel(String(marker || "")).length, 0), 0);
  if (labelBudget > 4_096) return { value: "", status: "invalid", reason: "見出しと別の見出しの合計が長すぎるため、安全に自動抽出できません。" };
  if (rule.method === "between") {
    return { value: "", status: "invalid", reason: "旧形式の範囲指定です。本文から取得したい値を選び直してください。" };
  }
  if (rule.method !== "regex" && !extractionAnchorIsAccepted(rule)) {
    return { value: "", status: "invalid", reason: `抽出項目「${rule.name}」と見出し「${cleanAnchorLabel(rule.start)}」が一致していません。` };
  }
  if (rule.method === "regex") {
    return extractWithSafeLocator(sourceBody, rule);
  }
  const markers = [rule.start, ...safeAliases(rule)].filter((value) => String(value || "").trim());
  if (!markers.length) return { value: "", status: "invalid", reason: "項目を見分ける見出しを入力してください。" };
  const anchors = findRuleAnchors(sourceBody, rule);
  const label = cleanAnchorLabel(rule.start) || rule.name;
  if (!anchors.length) return { value: "", status: "missing", reason: `見出し「${label}」が見つかりません。` };
  if (anchors.length > 1) return { value: "", status: "ambiguous", reason: `見出し「${label}」が複数あるため、自動転記しません。` };
  const scope = fieldValueAfter(sourceBody, anchors[0].end, rule, allRules);
  if (!scope) return { value: "", status: "invalid", reason: `見出し「${label}」の後ろに値がありません。` };
  const issue = unboundedCandidateIssue(scope) || proseCandidateIssue(scope);
  if (issue) return { value: "", status: "invalid", reason: issue };
  const value = typedValue(scope, rule.method).trim();
  if (!value) return { value: "", status: "invalid", reason: `${methodLabels[rule.method]}として確認できません。` };
  return { value, status: "ok", reason: "" };
}

export function extractValue(body: string, rule: ExtractionRule, allRules: ExtractionRule[] = [rule]) {
  return extractValueResult(body, rule, allRules).value;
}

export const methodLabels: Record<ExtractionMethod, string> = {
  after: "文字（見出しの後ろ）",
  number: "数字（見出しの後ろ）",
  money: "金額（見出しの後ろ）",
  date: "日付（見出しの後ろ）",
  email: "メールアドレス（見出しの後ろ）",
  phone: "電話番号（見出しの後ろ）",
  between: "2つの文字の間（旧形式・自動転記不可）",
  regex: "本文から設定した取得条件",
};

const cleanLabel = (value: string) => value
  .replace(/<[^<>]*>/g, "")
  .replace(/^[\s>■□◇◆*#・\d.]+/, "")
  .replace(/[【】[\]*\s]+/g, " ")
  .trim()
  .slice(0, 60);

const cleanDetectedValue = (value: string) => value
  .replace(/<br\s*\/?>/gi, "\n")
  .replace(/<[^<>]*>/g, "")
  .replace(/^\s*(?:\[|「|『)/, "")
  .replace(/(?:\]|」|』)\s*$/, "")
  .trim();

function trailingPlainLabel(prefix: string) {
  const match = prefix.match(/(?:^|[｜|,，、／/;；\t\u3000>]|[■□◇◆#*・])[ \t\u3000]*([^>｜|,，、／/;；。！？!?]{1,60}?)[ \t\u3000]*(?:：|:|＞|＝＞|=>|->|=|＝)[ \t\u3000]*$/u);
  return cleanLabel(match?.[1] || "");
}

function nextLabelFromTail(tail: string) {
  const bracketed = tail.match(/^[ \t\u3000\r\n]*(?:[｜|,，、／/;；][ \t\u3000\r\n]*)?(?:【([^】\r\n]{1,80})】|\[([^\]\r\n]{1,80})\])/u);
  if (bracketed) return { label: cleanLabel(bracketed[1] || bracketed[2]), bracketed: true };
  const plain = tail.match(/^[ \t\u3000\r\n]*(?:>[ \t\u3000]*)*(?:[｜|,，、／/;；][ \t\u3000\r\n]*)?(?:[*#・■□◇◆]+[ \t\u3000]*)*([\p{L}\p{N}_・ー\- \t\u3000]{1,50}?)[ \t\u3000]*(?:\*{1,2}[ \t\u3000]*)?(?:：|:|＞|＝＞|=>|->|=|＝)/u);
  return plain ? { label: cleanLabel(plain[1]), bracketed: false } : null;
}

function inferBalancedEnd(selected: string): BalancedEnd | null {
  const pair = Object.entries(DELIMITER_PAIRS).find(([, value]) => selected.endsWith(value.close));
  if (!pair) return null;
  const [open, { close, token }] = pair;
  const opens = Array.from(selected).filter((character) => character === open).length;
  const closes = Array.from(selected).filter((character) => character === close).length;
  const openIndex = selected.lastIndexOf(open);
  if (opens !== 1 || closes !== 1 || openIndex <= 0 || !delimiterShape(selected)) return null;
  return token;
}

/** Builds a reusable capture rule from a value selected in the sample mail. */
export function ruleFromSelection(body: string, selectedText: string, id: number, name = "", selectedStart?: number): SelectionRule | null {
  if (body.length > 200_000) return null;
  const selected = selectedText.trim();
  if (!selected || selected.length > 500) return null;
  const suppliedStart = Number.isInteger(selectedStart) && Number(selectedStart) >= 0 ? Number(selectedStart) : -1;
  const startIndex = suppliedStart >= 0 && body.slice(suppliedStart, suppliedStart + selected.length) === selected
    ? suppliedStart
    : body.indexOf(selected);
  if (startIndex < 0) return null;

  const before = body.slice(0, startIndex);
  const currentPrefix = before.slice(before.lastIndexOf("\n") + 1);
  const plainLabel = trailingPlainLabel(currentPrefix);
  const bracketLabel = currentPrefix.match(/(?:【([^】\r\n]{1,80})】|\[([^\]\r\n]{1,80})\])[ \t\u3000]*$/u);
  const leadingSelectedLabel = selected.match(/^(?:【([^】\r\n]{1,80})】|\[([^\]\r\n]{1,80})\])/u);
  let suggestedName = "選択項目";
  let locator: SafeExtractionLocator | null = null;
  let expectedSelected = selected;
  let needsBoundary = false;
  const signature = signatureFor(selected);
  if (!signature) return null;

  if (leadingSelectedLabel) {
    const rawLabel = leadingSelectedLabel[1] || leadingSelectedLabel[2];
    suggestedName = cleanLabel(plainLabel || rawLabel) || suggestedName;
    locator = {
      version: 2,
      kind: "label",
      label: cleanLabel(rawLabel),
      bracketed: true,
      includeLabel: true,
      ...signature,
    };
    needsBoundary = true;
  } else if (bracketLabel) {
    const rawLabel = bracketLabel[1] || bracketLabel[2];
    const outerPrefix = currentPrefix.slice(0, bracketLabel.index ?? currentPrefix.length);
    const outerLabel = trailingPlainLabel(outerPrefix);
    suggestedName = cleanLabel(outerLabel || rawLabel) || suggestedName;
    locator = {
      version: 2,
      kind: "label",
      label: cleanLabel(outerLabel || rawLabel),
      bracketed: !outerLabel,
      inline: Boolean(outerLabel) && formattedLabelMatches(outerPrefix, outerLabel).length === 0,
      innerLabel: outerLabel ? cleanLabel(rawLabel) : undefined,
      ...signature,
    };
    needsBoundary = true;
  } else if (plainLabel) {
    suggestedName = plainLabel || suggestedName;
    locator = {
      version: 2,
      kind: "label",
      label: suggestedName,
      inline: formattedLabelMatches(currentPrefix, suggestedName).length === 0,
      ...signature,
    };
    needsBoundary = true;
  } else {
    const previousLines = before.slice(0, before.lastIndexOf("\n")).split(/\r?\n/).filter((line) => line.trim());
    const heading = previousLines.at(-1)?.trim() ?? "";
    if (heading && /^(?:■|◆|【|\[|#)/.test(heading)) {
      suggestedName = cleanLabel(heading) || suggestedName;
      const afterSelection = body.slice(startIndex + selected.length);
      const nextHeading = afterSelection.split(/\r?\n/).map((line) => line.trim()).find((line) => /^(?:■|◆|【|\[|#)/.test(line));
      if (!nextHeading) return null;
      locator = { version: 2, kind: "block", heading, endHeading: nextHeading, ...signature };
    } else {
      // A sample value by itself is not reusable when the next mail contains a different value.
      return null;
    }
  }

  if (needsBoundary && locator?.kind === "label") {
    const afterSelection = body.slice(startIndex + selected.length);
    const nextLabel = nextLabelFromTail(afterSelection.slice(0, 700));
    if (nextLabel?.label) {
      locator = { ...locator, nextLabel: nextLabel.label, nextLabelBracketed: nextLabel.bracketed };
    } else {
      const balancedEnd = inferBalancedEnd(selected);
      const sameLineTail = afterSelection.split(/\r?\n/, 1)[0] || "";
      if (sameLineTail.trim()) {
        const structuralIndex = sameLineTail.search(/[【\u005b]/);
        const sentenceIndex = sameLineTail.search(/[。！？!?]/);
        const markerEnd = Math.min(40, structuralIndex > 0 ? structuralIndex : 40, sentenceIndex >= 3 ? sentenceIndex + 1 : 40);
        const suffix = Array.from(sameLineTail).slice(0, markerEnd).join("").trim();
        const letters = suffix.match(/[\p{L}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu)?.length || 0;
        if (suffix.length >= 4 && letters >= 3 && !/@|\d{3}/.test(suffix)) locator = { ...locator, suffix };
      } else if (balancedEnd) {
        locator = { ...locator, balancedEnd };
      } else {
        const nextLine = afterSelection.replace(/^[^\n]*(?:\n|$)/, "").split(/\r?\n/, 1)[0] || "";
        if (!nextLine.trim() || structuredLeadingLine(nextLine)) locator = { ...locator, lineEnd: true };
      }
    }
  }

  if (locator?.kind === "label") {
    const selectedLocations = labelLocatorLocations(body, locator)
      .filter((location) => location.valueStart === startIndex || location.contentStart === startIndex);
    if (selectedLocations.length !== 1) return null;
    const selectedLocation = selectedLocations[0];
    const cleanedSelection = stripQuotedCandidate(selected, selectedLocation.quoteDepth);
    if (cleanedSelection.issue || !cleanedSelection.value) return null;
    expectedSelected = cleanedSelection.value;
    const normalizedSignature = signatureFor(expectedSelected);
    if (!normalizedSignature) return null;
    if (normalizedSignature.sampleValueType === "text" && (locator.lineEnd === true || Boolean(locator.suffix))) return null;
    locator = {
      ...locator,
      ...normalizedSignature,
      sampleContextLabels: structuralContextLabels(body, selectedLocation.anchor.end),
    };
  }

  const rule: ExtractionRule = { id, name: name.trim() || suggestedName, method: "regex", start: "", end: "", pattern: "", locator: locator || undefined };
  const verified = extractValueResult(body, rule);
  const comparable = (value: string) => value.normalize("NFKC").replace(/\s+/g, " ").trim();
  if (verified.status !== "ok" || comparable(verified.value) !== comparable(expectedSelected)) return null;

  return {
    suggestedName: name.trim() || suggestedName,
    rule,
  };
}

/** Detects common label/value layouts so users do not have to write regexes. */
export function detectFields(body: string): DetectedField[] {
  if (body.length > 200_000) return [];
  const normalized = body.replace(/\r/g, "");
  const found: Array<{ name: string; value: string; locator: SafeExtractionLocator }> = [];
  const seen = new Set<string>();
  const push = (name: string, value: string, locator: SafeExtractionLocator) => {
    if (found.length >= 30) return;
    const cleanName = cleanLabel(name);
    const cleanValue = cleanDetectedValue(value);
    if (!cleanName || !cleanValue || cleanValue.length > 500) return;
    if (proseCandidateIssue(cleanValue)) return;
    const key = `${cleanName}\u0000${cleanValue}`;
    if (seen.has(key)) return;
    const signature = signatureFor(cleanValue);
    if (locator.kind !== "json" && !signature) return;
    let signedLocator = locator.kind === "json" ? locator : { ...locator, ...signature };
    if (signedLocator.kind === "label") {
      const locations = labelLocatorLocations(normalized, signedLocator);
      if (locations.length !== 1) return;
      signedLocator = {
        ...signedLocator,
        sampleContextLabels: structuralContextLabels(normalized, locations[0].anchor.end),
      };
      if (!safeLocatorIsValid(signedLocator)) return;
    }
    seen.add(key);
    found.push({
      name: cleanName,
      value: cleanValue,
      locator: signedLocator,
    });
  };

  // Valid JSON is parsed instead of treating arbitrary quoted prose as data.
  try {
    const parsed = JSON.parse(normalized) as unknown;
    const visit = (value: unknown, depth: number, path: string[]) => {
      if (depth > 20 || value === null || typeof value !== "object" || Array.isArray(value)) return;
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        if (/^(?:0|[1-9]\d*)$/.test(key)) continue;
        const childPath = [...path, key];
        if (["string", "number", "boolean"].includes(typeof child)) {
          push(key, String(child), { version: 2, kind: "json", path: childPath, jsonType: typeof child as "string" | "number" | "boolean" });
        }
        visit(child, depth + 1, childPath);
      }
    };
    visit(parsed, 0, []);
  } catch {
    // The remaining detectors handle ordinary mail bodies.
  }

  const knownFieldLabels = [
    "メールアドレス", "応募者メール", "担当者メール", "電話番号", "携帯電話", "生年月日", "応募日時", "予約日時",
    "注文番号", "予約番号", "受付番号", "応募者氏名", "担当者氏名", "お名前", "フリガナ", "郵便番号", "最終学歴",
    "現在の状況", "直近の勤め先", "経験年数", "保有資格", "応募メッセージ", "志望動機", "求人名", "求人ID",
    "会社名", "担当者", "タイトル", "件名", "氏名", "名前", "性別", "住所", "電話", "メール", "学歴", "金額", "日時", "日付", "年齢",
  ];
  const knownPlainTokens = (line: string) => {
    const tokens = plainStructuralLabelsMatch(line, knownFieldLabels, 0, line.length, "inline")
      .map((match) => ({ ...match, name: match.label, bracketed: false }));
    const unique = new Map<number, (typeof tokens)[number]>();
    for (const token of tokens) {
      const current = unique.get(token.index);
      if (!current || token.end > current.end) unique.set(token.index, token);
    }
    return [...unique.values()].sort((left, right) => left.index - right.index);
  };
  const likelyFieldLabel = (value: string) => knownFieldLabels.some((label) => semanticLabel(value).includes(semanticLabel(label)));

  const lines = normalized.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) continue;

    // Flattened notification mails often put several 【label】value pairs on
    // one visual line. Only well-known field-like labels are treated as
    // boundaries; brackets inside a company name or free text stay in value.
    const allBracketTokens = Array.from(line.matchAll(/【([^】\n]{1,80})】|\[([^\]\n]{1,80})\]/g))
      .map((match) => ({
        index: match.index ?? 0,
        end: (match.index ?? 0) + match[0].length,
        name: match[1] || match[2] || "",
        bracketed: true,
        known: likelyFieldLabel(match[1] || match[2] || ""),
      }));
    const bracketTokens = allBracketTokens.filter((item) => item.known);
    const plainTokens = knownPlainTokens(line);
    const allTokens = [...allBracketTokens, ...plainTokens].sort((left, right) => left.index - right.index);
    const followingLabel = nextLabelFromTail(lines.slice(index + 1).join("\n").slice(0, 700));
    for (let tokenIndex = 0; tokenIndex < bracketTokens.length; tokenIndex += 1) {
      const current = bracketTokens[tokenIndex];
      const next = allTokens.find((token) => token.index >= current.end);
      if (next && "known" in next && !next.known) continue;
      const valueStart = current.end;
      const valueEnd = next?.index ?? line.length;
      const value = line.slice(valueStart, valueEnd).replace(/^\s*(?:：|:|＞|＝＞|=>|->|=|＝)?\s*/, "").trim();
      if (!value) continue;
      const label = current.name;
      push(label, value, {
        version: 2,
        kind: "label",
        label: cleanLabel(label),
        bracketed: true,
        nextLabel: next ? cleanLabel(next.name) : followingLabel?.label,
        nextLabelBracketed: next ? Boolean(next.bracketed) : Boolean(followingLabel?.bracketed),
        lineEnd: !next && !followingLabel,
      });
    }

    for (const current of plainTokens) {
      const next = allTokens.find((token) => token.index >= current.end);
      if (next && "known" in next && !next.known) continue;
      const value = line.slice(current.end, next?.index ?? line.length).trim();
      if (!value) continue;
      push(current.name, value, {
        version: 2,
        kind: "label",
        label: current.name,
        inline: true,
        nextLabel: next ? cleanLabel(next.name) : followingLabel?.label,
        nextLabelBracketed: next ? Boolean(next.bracketed) : Boolean(followingLabel?.bracketed),
        lineEnd: !next && !followingLabel,
      });
    }

    // Question/answer forms need the preceding question to distinguish repeated "回答" labels.
    const question = line.match(/^Q\s*(\d+)[.．]?\s*(.+)$/i);
    if (question) {
      let answerIndex = index + 1;
      while (answerIndex < lines.length && !lines[answerIndex].trim()) answerIndex += 1;
      const rawAnswer = lines[answerIndex]?.trim().match(/^回答\s*(?:：|:|=|＝)\s*(.*?)\s*$/)?.[1] || "";
      const qaBracketed = rawAnswer.startsWith("[") && rawAnswer.endsWith("]");
      const answer = qaBracketed ? rawAnswer.slice(1, -1).trim() : rawAnswer.trim();
      if (answer) {
        const name = `Q${question[1]} ${question[2]}`;
        push(name, answer, { version: 2, kind: "qa", question: line, qaBracketed });
      }
    }

    // [label] value, label: value, label ＞ value, label => value and decorated variants.
    const inline = /^\s*["{}]/.test(line) || /^回答\s*(?:：|:|=|＝)/.test(line) || plainTokens.length > 0
      ? null
      : line.match(/^(?:[-*・]\s*)?(?:\[([^\]]+)\]|【([^】]+)】|(.{1,60}?))\s*(?:：|:|＞|＝＞|=>|->|=|＝)\s*(.+)$/);
    if (inline) {
      const label = inline[1] || inline[2] || inline[3] || "項目";
      const value = inline[4];
      const parts = /[｜|]/.test(value) ? value.split(/[｜|]/).map((part) => part.trim()) : [value];
      const cleanInlineLabel = cleanLabel(label);
      if (parts.length === 1) {
        push(label, parts[0], {
          version: 2,
          kind: "label",
          label: cleanInlineLabel,
          bracketed: Boolean(inline[1] || inline[2]),
          inline: !inline[1] && !inline[2] && formattedLabelMatches(line, cleanInlineLabel).length === 0,
          nextLabel: followingLabel?.label,
          nextLabelBracketed: Boolean(followingLabel?.bracketed),
          lineEnd: !followingLabel,
        });
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
        const endHeading = lines[end]?.trim();
        if (endHeading) {
          const blockValue = lines.slice(next, end).join("\n").trim();
          push(heading[1], blockValue, { version: 2, kind: "block", heading: line, endHeading });
        }
      }
    }

    // Label-less bullets are not auto-detected: inserting a new bullet would
    // move an ordinal locator and could silently select another value.
  }

  return found.map((item, index) => {
    const rule: ExtractionRule = { id: index + 1, name: item.name, method: "regex", start: "", end: "", pattern: "", locator: item.locator };
    return { name: item.name, value: item.value, rule };
  }).filter((item) => {
    const result = extractValueResult(normalized, item.rule);
    return result.status === "ok" && result.value.normalize("NFKC").trim() === item.value.normalize("NFKC").trim();
  }).slice(0, 30).map((item, index) => ({ ...item, rule: { ...item.rule, id: index + 1 } }));
}
