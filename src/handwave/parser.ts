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
  "proof.sketch",
  "prose.short",
  "prose.long",
  "statement"
];

export function parseLeanDocument(text: string, uri: string): LeanDeclaration[] {
  const declarations: LeanDeclaration[] = [];
  const comments = collectDocComments(text);

  for (const comment of comments) {
    if (!comment.text.includes("%%handwave")) {
      continue;
    }

    const doc = parseHandwaveDoc(comment.text, comment.range, text);
    const afterComment = text.slice(comment.end);
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
    const statementEnd = findDeclarationStatementEnd(text, declStart);
    declarations.push({
      name: stripLeanEscapes(match[2]),
      kind: match[1],
      statement: text.slice(declStart, statementEnd).trim(),
      range: rangeFromOffsets(text, declStart, statementEnd),
      nameRange: rangeFromOffsets(text, nameStart, nameStart + match[2].length),
      doc,
      uri
    });
  }

  declarationPattern.lastIndex = 0;
  for (const match of text.matchAll(declarationPattern)) {
    const name = stripLeanEscapes(match[2]);
    if (declarations.some((decl) => decl.name === name)) {
      continue;
    }

    const declStart = match.index ?? 0;
    const nameStart = declStart + match[0].lastIndexOf(match[2]);
    const statementEnd = findDeclarationStatementEnd(text, declStart);
    declarations.push({
      name,
      kind: match[1],
      statement: text.slice(declStart, statementEnd).trim(),
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
    case "doc": {
      const { base, selector } = splitSelector(body);
      return { raw, kind: "doc", body, base, selector };
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

  if (!fields.id) {
    errors.push({
      message: "Handwave doc block is missing required id field.",
      range
    });
  }

  const { id, ...rest } = fields;
  return { id, fields: rest, range, errors };
}

function findDeclarationStatementEnd(text: string, start: number): number {
  const nextBlank = text.indexOf("\n\n", start);
  const nextDoc = text.indexOf("\n/--", start + 1);
  const candidates = [nextBlank, nextDoc].filter((index) => index > start);
  if (candidates.length === 0) {
    return text.length;
  }
  return Math.min(...candidates);
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
