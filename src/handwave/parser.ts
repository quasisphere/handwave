import {
  ArticleDocument,
  HandwaveDoc,
  LeanDeclaration,
  ParseIssue,
  ParsedTarget,
  RangeLike
} from "./types";
import { rangeFromOffsets } from "./position";

const declarationPattern =
  /\b(theorem|lemma|def|abbrev|instance|structure|class|inductive)\s+([A-Za-z_][A-Za-z0-9_'.]*|«[^»]+»)/g;

const supportedSelectors = [
  "lean.statement",
  "lean.proof",
  "proof",
  "statement"
];

export function parseLeanDocument(text: string, uri: string): LeanDeclaration[] {
  const declarations: LeanDeclaration[] = [];
  const comments = collectDocComments(text);
  const searchableText = blankLeanCommentsAndStrings(text);

  for (const comment of comments) {
    if (!comment.text.includes("%%handwave")) {
      continue;
    }

    const doc = parseHandwaveDoc(comment.text, comment.range, text);
    const afterComment = searchableText.slice(comment.end);
    declarationPattern.lastIndex = 0;
    const match = declarationPattern.exec(afterComment);
    if (!match) {
      doc.errors.push({
        message: "Handwave doc block is not followed by a Lean declaration.",
        range: comment.range
      });
      continue;
    }

    const declStart = comment.end + match.index;
    const nameStart = declStart + match[0].lastIndexOf(match[2]);
    const name = qualifyLeanName(text, declStart, stripLeanEscapes(match[2]));
    const statementEnd = findDeclarationStatementEnd(text, searchableText, declStart);
    const declarationText = text.slice(declStart, statementEnd).trim();
    const parts = splitLeanDeclaration(declarationText);
    declarations.push({
      name,
      kind: match[1],
      statement: declarationText,
      leanStatement: parts.leanStatement,
      leanProof: parts.leanProof,
      range: rangeFromOffsets(text, declStart, statementEnd),
      nameRange: rangeFromOffsets(text, nameStart, nameStart + match[2].length),
      doc,
      uri
    });
  }

  declarationPattern.lastIndex = 0;
  for (const match of searchableText.matchAll(declarationPattern)) {
    const declStart = match.index ?? 0;
    const nameStart = declStart + match[0].lastIndexOf(match[2]);
    const name = qualifyLeanName(text, declStart, stripLeanEscapes(match[2]));
    if (declarations.some((decl) => decl.name === name)) {
      continue;
    }

    const statementEnd = findDeclarationStatementEnd(text, searchableText, declStart);
    const declarationText = text.slice(declStart, statementEnd).trim();
    const parts = splitLeanDeclaration(declarationText);
    declarations.push({
      name,
      kind: match[1],
      statement: declarationText,
      leanStatement: parts.leanStatement,
      leanProof: parts.leanProof,
      range: rangeFromOffsets(text, declStart, statementEnd),
      nameRange: rangeFromOffsets(text, nameStart, nameStart + match[2].length),
      uri
    });
  }

  return declarations;
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

export function slugify(title: string): string {
  const slug = title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "section";
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
  return { fields: rest, range, errors };
}

function findDeclarationStatementEnd(text: string, searchableText: string, start: number): number {
  const nextDoc = text.indexOf("\n/--", start + 1);
  declarationPattern.lastIndex = start + 1;
  const nextDeclaration = declarationPattern.exec(searchableText)?.index ?? -1;
  const candidates = [nextDoc, nextDeclaration].filter((index) => index > start);
  if (candidates.length === 0) {
    return text.length;
  }
  return Math.min(...candidates);
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

function qualifyLeanName(text: string, declarationOffset: number, name: string): string {
  const namespace = namespaceAt(text, declarationOffset);
  if (!namespace.length) {
    return name;
  }
  return `${namespace.join(".")}.${name}`;
}

function namespaceAt(text: string, offset: number): string[] {
  const stack: string[] = [];
  const namespacePattern =
    /^\s*(?:namespace[ \t]+([A-Za-z_][A-Za-z0-9_'.]*(?:[ \t]+[A-Za-z_][A-Za-z0-9_'.]*)*)|end(?:[ \t]+([A-Za-z_][A-Za-z0-9_'.]*))?)\b/gm;
  const prefix = text.slice(0, offset);

  for (const match of prefix.matchAll(namespacePattern)) {
    const opened = match[1];
    if (opened) {
      stack.push(...opened.trim().split(/\s+/).flatMap((part) => part.split(".")).filter(Boolean));
      continue;
    }

    const closed = match[2];
    if (!closed) {
      stack.pop();
      continue;
    }

    const parts = closed.split(".").filter(Boolean);
    if (parts.length === 0) {
      stack.pop();
      continue;
    }

    const suffixStart = stack.length - parts.length;
    if (suffixStart >= 0 && parts.every((part, index) => stack[suffixStart + index] === part)) {
      stack.splice(suffixStart);
    } else {
      stack.pop();
    }
  }

  return stack;
}

function splitLeanDeclaration(declarationText: string): { leanStatement: string; leanProof?: string } {
  const proofStart = declarationText.search(/\s:=\s*(by\b)?/);
  if (proofStart < 0) {
    return { leanStatement: declarationText };
  }

  const prefix = declarationText.slice(0, proofStart).trimEnd();
  const proofMarker = declarationText.slice(proofStart).match(/^\s:=\s*/);
  const proofOffset = proofStart + (proofMarker?.[0].length ?? 0);
  const proof = declarationText.slice(proofOffset).trim();

  return {
    leanStatement: prefix,
    leanProof: proof || undefined
  };
}
