import {
  ArticleDocument,
  HandwaveDoc,
  LeanDeclaration,
  ParseIssue,
  ParsedTarget,
  RangeLike
} from "./types";
import { rangeFromOffsets } from "./position";

const leanIdentifierSource = String.raw`[\p{L}_][\p{L}\p{N}\p{M}_']*`;
const leanQualifiedIdentifierSource =
  `${leanIdentifierSource}(?:\\.${leanIdentifierSource})*`;
const declarationPattern = new RegExp(
  `\\b(theorem|lemma|def|abbrev|instance|structure|class|inductive)\\s+(${leanQualifiedIdentifierSource}|«[^»]+»)`,
  "gu"
);

const supportedSelectors = [
  "lean.statement",
  "lean.proof",
  "proof",
  "statement"
];

export function parseLeanDocument(text: string, uri: string): LeanDeclaration[] {
  const comments = collectDocComments(text);
  const searchableText = blankLeanCommentsAndStrings(text);
  declarationPattern.lastIndex = 0;
  const matches = [...searchableText.matchAll(declarationPattern)];
  const declarationOffsets = matches.map((match) => match.index ?? 0);
  const contexts = leanContextsAtOffsets(searchableText, declarationOffsets);
  const scopeEndOffsets = collectScopeEndOffsets(searchableText);
  const topLevelDocOffsets = [...text.matchAll(/^\/--/gm)].map((match) => {
    const offset = match.index ?? 0;
    return offset > 0 && text[offset - 1] === "\n" ? offset - 1 : offset;
  });
  const docsByDeclarationOffset = new Map<number, HandwaveDoc>();
  let declarationIndex = 0;

  for (const comment of comments) {
    if (!comment.text.includes("%%handwave")) {
      continue;
    }
    while (
      declarationIndex < declarationOffsets.length &&
      declarationOffsets[declarationIndex] < comment.end
    ) {
      declarationIndex++;
    }
    const declStart = declarationOffsets[declarationIndex];
    const doc = parseHandwaveDoc(comment.text, comment.range, text);
    if (declStart === undefined) {
      doc.errors.push({
        message: "Handwave doc block is not followed by a Lean declaration.",
        range: comment.range
      });
      continue;
    }
    if (!docsByDeclarationOffset.has(declStart)) {
      docsByDeclarationOffset.set(declStart, doc);
    }
  }

  const documented: LeanDeclaration[] = [];
  const undocumented: LeanDeclaration[] = [];
  for (let index = 0; index < matches.length; index++) {
    const match = matches[index];
    const declStart = declarationOffsets[index];
    const isPrivate = isPrivateLeanDeclarationAt(text, declStart);
    const nameStart = declStart + match[0].lastIndexOf(match[2]);
    const context = contexts.get(declStart);
    const namespace = context?.namespace ?? [];
    const localName = stripLeanEscapes(match[2]);
    const sourceName = namespace.length > 0 ? `${namespace.join(".")}.${localName}` : localName;
    const name = declarationIndexName(uri, sourceName, isPrivate, declStart);
    const statementEnd = nextBoundaryOffset(
      text.length,
      declStart,
      declarationOffsets[index + 1],
      firstOffsetAfter(topLevelDocOffsets, declStart),
      firstOffsetAfter(scopeEndOffsets, declStart)
    );
    const declarationText = text.slice(declStart, statementEnd).trim();
    const parts = splitLeanDeclaration(declarationText);
    const doc = docsByDeclarationOffset.get(declStart);
    const declaration: LeanDeclaration = {
      name,
      sourceName,
      kind: match[1],
      isPrivate,
      statement: declarationText,
      leanStatement: parts.leanStatement,
      leanProof: parts.leanProof,
      contextNames: context?.localNames ?? [],
      range: rangeFromOffsets(text, declStart, statementEnd),
      nameRange: rangeFromOffsets(text, nameStart, nameStart + match[2].length),
      doc,
      uri
    };
    (doc ? documented : undocumented).push(declaration);
  }

  const documentedNames = new Set(documented.map((declaration) => declaration.name));
  return [
    ...documented,
    ...undocumented.filter((declaration) => !documentedNames.has(declaration.name))
  ];
}

export function parseArticleDocument(text: string, uri: string): ArticleDocument {
  const anchors = [];
  const links = [];
  const includes = [];
  const errors: ParseIssue[] = [];

  const headingPattern = /^(#{1,6})\s+(.+)$/gm;
  for (const match of text.matchAll(headingPattern)) {
    const start = match.index ?? 0;
    const title = match[2].trim();
    anchors.push({
      id: slugify(title),
      title,
      range: rangeFromOffsets(text, start, start + match[0].length)
    });
  }

  const explicitAnchorPattern = /\{#([A-Za-z0-9_.:-]+)\}/g;
  for (const match of text.matchAll(explicitAnchorPattern)) {
    const start = match.index ?? 0;
    anchors.push({
      id: match[1],
      title: match[1],
      range: rangeFromOffsets(text, start, start + match[0].length)
    });
  }

  const linkPattern = /\[([^\]\n]+)\]\(([^)\s]+)\)/g;
  for (const match of text.matchAll(linkPattern)) {
    const start = match.index ?? 0;
    const targetStart = start + match[0].lastIndexOf(match[2]);
    links.push({
      label: match[1],
      target: match[2],
      range: rangeFromOffsets(text, start, start + match[0].length),
      targetRange: rangeFromOffsets(text, targetStart, targetStart + match[2].length)
    });
  }

  const includePattern = /@include\{([^}\s]+)\}/g;
  for (const match of text.matchAll(includePattern)) {
    const start = match.index ?? 0;
    const targetStart = start + match[0].lastIndexOf(match[1]);
    includes.push({
      target: match[1],
      range: rangeFromOffsets(text, start, start + match[0].length),
      targetRange: rangeFromOffsets(text, targetStart, targetStart + match[1].length)
    });
  }

  return { uri, anchors, links, includes, errors };
}

export function parseTarget(raw: string): ParsedTarget {
  const schemeMatch = /^([A-Za-z][A-Za-z0-9+.-]*):(.*)$/.exec(raw);
  if (!schemeMatch) {
    return { raw, kind: "unknown", body: raw, base: raw };
  }

  const scheme = schemeMatch[1];
  const body = schemeMatch[2];

  switch (scheme) {
    case "lean": {
      const { base, selector } = splitSelector(body);
      return { raw, kind: "lean", body, base, selector };
    }
    case "article": {
      const hashIndex = body.indexOf("#");
      return {
        raw,
        kind: "article",
        body,
        base: hashIndex >= 0 ? body.slice(0, hashIndex) : body,
        anchor: hashIndex >= 0 ? body.slice(hashIndex + 1) : undefined
      };
    }
    case "local":
      return {
        raw,
        kind: "local",
        body,
        base: body,
        anchor: body.startsWith("#") ? body.slice(1) : undefined
      };
    case "term":
      return { raw, kind: "term", body, base: body };
    default:
      return { raw, kind: "unknown", body, base: body };
  }
}

export function isSupportedSelector(selector: string | undefined): boolean {
  return selector === undefined || supportedSelectors.includes(selector);
}

export function isHandwaveNavigationTarget(raw: string): boolean {
  const kind = parseTarget(raw).kind;
  return kind === "lean" || kind === "article" || kind === "local";
}

export function slugify(title: string): string {
  const slug = title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "section";
}

export function parseHandwaveTags(value: string | undefined): string[] {
  const tags: string[] = [];
  const seen = new Set<string>();

  for (const rawTag of (value ?? "").split(/[\s,]+/)) {
    const tag = normalizeHandwaveTag(rawTag);
    if (!tag || seen.has(tag)) {
      continue;
    }
    tags.push(tag);
    seen.add(tag);
  }

  return tags;
}

export function hasHandwaveTag(doc: HandwaveDoc | undefined, tag: string): boolean {
  const normalized = normalizeHandwaveTag(tag);
  return Boolean(normalized && doc?.tags.includes(normalized));
}

export function normalizeHandwaveTag(value: string): string | undefined {
  const tag = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_.-]*$/.test(tag)) {
    return undefined;
  }
  return tag;
}

type LeanScopeEntry =
  | { kind: "namespace"; name: string; localNames: Set<string> }
  | { kind: "section"; name?: string; localNames: Set<string> };

function leanContextsAtOffsets(
  searchableText: string,
  offsets: readonly number[]
): Map<number, { namespace: string[]; localNames: string[] }> {
  const result = new Map<number, { namespace: string[]; localNames: string[] }>();
  const stack: LeanScopeEntry[] = [];
  const rootLocalNames = new Set<string>();
  const namespacePattern = new RegExp(
    `^\\s*(?:(namespace)[ \\t]+(${leanQualifiedIdentifierSource}(?:[ \\t]+${leanQualifiedIdentifierSource})*)|` +
      `(section)(?:[ \\t]+(${leanQualifiedIdentifierSource}))?|` +
      `end(?:[ \\t]+(${leanQualifiedIdentifierSource}))?)(?=\\s|$)`,
    "gmu"
  );
  const variablePattern = /^[ \t]*variable\b[^\r\n]*(?:\r?\n[ \t]+[^\r\n]*)*/gmu;
  const events = [
    ...[...searchableText.matchAll(namespacePattern)].map((match) => ({
      kind: "scope" as const,
      index: match.index ?? 0,
      match
    })),
    ...[...searchableText.matchAll(variablePattern)].map((match) => ({
      kind: "variable" as const,
      index: match.index ?? 0,
      match
    }))
  ].sort((first, second) => first.index - second.index);
  let eventIndex = 0;

  for (const offset of offsets) {
    while (eventIndex < events.length && events[eventIndex].index < offset) {
      const event = events[eventIndex];
      if (event.kind === "scope") {
        updateLeanScope(stack, event.match);
      } else {
        const target = stack.at(-1)?.localNames ?? rootLocalNames;
        for (const name of collectLeanVariableNames(event.match[0])) {
          target.add(name);
        }
      }
      eventIndex++;
    }
    result.set(
      offset,
      {
        namespace: stack.flatMap((entry) => entry.kind === "namespace" ? [entry.name] : []),
        localNames: [
          ...rootLocalNames,
          ...stack.flatMap((entry) => [...entry.localNames])
        ]
      }
    );
  }
  return result;
}

function collectLeanVariableNames(source: string): string[] {
  const names: string[] = [];
  const binderPattern = new RegExp(
    `(?:\\(|\\{|\\[)\\s*(${leanIdentifierSource}(?:\\s+${leanIdentifierSource})*)\\s*:`,
    "gu"
  );
  for (const match of source.matchAll(binderPattern)) {
    names.push(...match[1].trim().split(/\s+/).filter(Boolean));
  }
  return names;
}

function updateLeanScope(
  stack: LeanScopeEntry[],
  match: RegExpMatchArray
): void {
  if (match[1]) {
    stack.push(
      ...match[2]
        .trim()
        .split(/\s+/)
        .flatMap((part) => part.split("."))
        .filter(Boolean)
        .map((name) => ({ kind: "namespace" as const, name, localNames: new Set<string>() }))
    );
    return;
  }
  if (match[3]) {
    stack.push(match[4]
      ? { kind: "section", name: match[4], localNames: new Set<string>() }
      : { kind: "section", localNames: new Set<string>() });
    return;
  }

  const closed = match[5];
  if (!closed) {
    stack.pop();
    return;
  }
  const top = stack[stack.length - 1];
  if (top?.kind === "section" && top.name === closed) {
    stack.pop();
    return;
  }
  const parts = closed.split(".").filter(Boolean);
  const namespaceEntries = stack
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => entry.kind === "namespace") as Array<{
      entry: { kind: "namespace"; name: string; localNames: Set<string> };
      index: number;
    }>;
  const suffixStart = namespaceEntries.length - parts.length;
  if (
    suffixStart >= 0 &&
    parts.every((part, index) => namespaceEntries[suffixStart + index].entry.name === part)
  ) {
    stack.splice(namespaceEntries[suffixStart].index);
  } else {
    stack.pop();
  }
}

function collectScopeEndOffsets(searchableText: string): number[] {
  const pattern = new RegExp(
    `^[ \\t]*end(?:[ \\t]+${leanQualifiedIdentifierSource})?[ \\t]*(?=\\r?$)`,
    "gmu"
  );
  return [...searchableText.matchAll(pattern)].map((match) => match.index ?? 0);
}

function firstOffsetAfter(offsets: readonly number[], target: number): number | undefined {
  let low = 0;
  let high = offsets.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (offsets[middle] <= target) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return offsets[low];
}

function nextBoundaryOffset(
  fallback: number,
  start: number,
  ...offsets: Array<number | undefined>
): number {
  const candidates = offsets.filter((offset): offset is number => offset !== undefined && offset > start);
  return candidates.length > 0 ? Math.min(...candidates) : fallback;
}

function collectDocComments(text: string): Array<{ text: string; start: number; end: number; range: RangeLike }> {
  const comments = [];
  const commentPattern = /\/--[\s\S]*?-\/\s*/g;

  for (const match of text.matchAll(commentPattern)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    comments.push({
      text: match[0],
      start,
      end,
      range: rangeFromOffsets(text, start, end)
    });
  }

  return comments;
}

function isPrivateLeanDeclarationAt(text: string, declarationOffset: number): boolean {
  const lineStart = text.lastIndexOf("\n", Math.max(0, declarationOffset - 1)) + 1;
  return /\bprivate\b/.test(text.slice(lineStart, declarationOffset));
}

function declarationIndexName(
  uri: string,
  sourceName: string,
  isPrivate: boolean,
  declarationOffset: number
): string {
  if (!isPrivate) {
    return sourceName;
  }

  return `${sourceName}._handwavePrivate_${hashString(`${uri}:${declarationOffset}`)}`;
}

function hashString(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function parseHandwaveDoc(comment: string, range: RangeLike, sourceText: string): HandwaveDoc {
  const fields: Record<string, string> = {};
  const errors: ParseIssue[] = [];
  const marker = comment.indexOf("%%handwave");
  const body = comment
    .slice(marker + "%%handwave".length)
    .replace(/\*\/$/, "")
    .replace(/-\/\s*$/, "");

  const lines = body.split(/\r?\n/);
  let currentKey: string | undefined;
  let currentValue: string[] = [];

  const flush = () => {
    if (currentKey) {
      fields[currentKey] = currentValue.join("\n").trim();
    }
    currentKey = undefined;
    currentValue = [];
  };

  for (const line of lines) {
    const cleaned = line.replace(/^\s*[-*]?\s?/, "");
    if (!cleaned.trim()) {
      if (currentKey) {
        currentValue.push("");
      }
      continue;
    }

    const keyValue = /^([A-Za-z0-9_.-]+):(?:\s*(.*))?$/.exec(cleaned);
    if (keyValue) {
      flush();
      currentKey = keyValue[1];
      currentValue = keyValue[2] ? [keyValue[2]] : [];
      continue;
    }

    if (!currentKey) {
      const offset = sourceText.indexOf(line);
      errors.push({
        message: "Malformed Handwave doc line; expected key: value.",
        range: offset >= 0 ? rangeFromOffsets(sourceText, offset, offset + line.length) : range
      });
      continue;
    }

    currentValue.push(cleaned.replace(/^\s{2}/, ""));
  }

  flush();

  const { id: _unusedId, ...rest } = fields;
  return { fields: rest, tags: parseHandwaveTags(rest.tags), range, errors };
}

export function blankLeanCommentsAndStrings(source: string): string {
  let result = "";
  let index = 0;
  while (index < source.length) {
    if (source.startsWith("--", index)) {
      const nextNewline = source.indexOf("\n", index + 2);
      const end = nextNewline >= 0 ? nextNewline : source.length;
      result += " ".repeat(end - index);
      index = end;
      continue;
    }

    if (source.startsWith("/-", index)) {
      const end = findBlockCommentEnd(source, index + 2);
      result += " ".repeat(end - index);
      index = end;
      continue;
    }

    if (source[index] === "\"") {
      const end = findStringEnd(source, index + 1);
      result += " ".repeat(end - index);
      index = end;
      continue;
    }

    result += source[index];
    index += 1;
  }
  return result;
}

function findBlockCommentEnd(source: string, start: number): number {
  let depth = 1;
  let index = start;
  while (index < source.length && depth > 0) {
    if (source.startsWith("/-", index)) {
      depth += 1;
      index += 2;
      continue;
    }
    if (source.startsWith("-/", index)) {
      depth -= 1;
      index += 2;
      continue;
    }
    index += 1;
  }
  return index;
}

function findStringEnd(source: string, start: number): number {
  let index = start;
  while (index < source.length) {
    if (source[index] === "\\") {
      index += 2;
      continue;
    }
    if (source[index] === "\"") {
      return index + 1;
    }
    index += 1;
  }
  return source.length;
}

function splitSelector(body: string): { base: string; selector?: string } {
  for (const selector of supportedSelectors) {
    const suffix = `.${selector}`;
    if (body.endsWith(suffix)) {
      return {
        base: body.slice(0, -suffix.length),
        selector
      };
    }
  }
  return { base: body };
}

function stripLeanEscapes(name: string): string {
  if (name.startsWith("«") && name.endsWith("»")) {
    return name.slice(1, -1);
  }
  return name;
}

function splitLeanDeclaration(declarationText: string): { leanStatement: string; leanProof?: string } {
  const proofStart = findLeanProofDelimiter(declarationText);
  if (proofStart < 0) {
    return { leanStatement: declarationText };
  }

  const prefix = declarationText.slice(0, proofStart).trimEnd();
  const proofMarker = declarationText.slice(proofStart).match(/^\s*:=\s*/);
  const proofOffset = proofStart + (proofMarker?.[0].length ?? 0);
  const proof = declarationText.slice(proofOffset).trim();

  return {
    leanStatement: prefix,
    leanProof: proof || undefined
  };
}

function findLeanProofDelimiter(declarationText: string): number {
  const searchableText = blankLeanCommentsAndStrings(declarationText);
  let depth = 0;
  let firstTermProof = -1;

  for (let index = 0; index < searchableText.length; index++) {
    const char = searchableText[index];
    if (isLeanOpeningDelimiter(char)) {
      depth++;
      continue;
    }
    if (isLeanClosingDelimiter(char)) {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth !== 0 || !searchableText.startsWith(":=", index)) {
      continue;
    }
    if (
      index > 0 &&
      !/\s/.test(searchableText[index - 1])
    ) {
      continue;
    }

    const afterAssignment = searchableText.slice(index + 2).match(/^\s*(by\b)?/);
    if (!afterAssignment) {
      continue;
    }
    if (firstTermProof < 0) {
      firstTermProof = index;
    }
    if (afterAssignment[1]) {
      return index;
    }
  }

  return firstTermProof;
}

function isLeanOpeningDelimiter(char: string): boolean {
  return (
    char === "(" ||
    char === "[" ||
    char === "{" ||
    char === "⟨" ||
    char === "⦃" ||
    char === "⟦" ||
    char === "⟪"
  );
}

function isLeanClosingDelimiter(char: string): boolean {
  return (
    char === ")" ||
    char === "]" ||
    char === "}" ||
    char === "⟩" ||
    char === "⦄" ||
    char === "⟧" ||
    char === "⟫"
  );
}
