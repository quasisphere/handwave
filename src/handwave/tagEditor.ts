import { normalizeHandwaveTag, parseLeanDocument } from "./parser";
import { LeanDeclaration, PositionLike } from "./types";

export interface SourceTextEdit {
  start: number;
  end: number;
  text: string;
}

export interface LeanDeclarationMetadataUpdate {
  name?: string;
  statement?: string;
  proof?: string;
  tags?: readonly string[];
}

export function leanDeclarationTagToggleEdit(
  source: string,
  uri: string,
  declarationName: string,
  rawTag: string
): SourceTextEdit | undefined {
  const tag = normalizeHandwaveTag(rawTag);
  if (!tag) {
    return undefined;
  }

  const declaration = parseLeanDocument(source, uri)
    .find((item) => item.name === declarationName);
  if (!declaration) {
    return undefined;
  }

  const currentTags = declaration.doc?.tags ?? [];
  const nextTags = currentTags.includes(tag)
    ? currentTags.filter((item) => item !== tag)
    : [...currentTags, tag];

  return declaration.doc
    ? handwaveDocTagEdit(source, declaration, nextTags)
    : handwaveDocInsertion(source, declaration, { tags: nextTags });
}

export function leanDeclarationTagSetEdit(
  source: string,
  uri: string,
  declarationName: string,
  rawTag: string,
  active: boolean
): SourceTextEdit | undefined {
  const tag = normalizeHandwaveTag(rawTag);
  if (!tag) {
    return undefined;
  }

  const declaration = parseLeanDocument(source, uri)
    .find((item) => item.name === declarationName);
  if (!declaration) {
    return undefined;
  }

  const currentTags = declaration.doc?.tags ?? [];
  const currentlyActive = currentTags.includes(tag);
  if (currentlyActive === active) {
    return { start: 0, end: 0, text: "" };
  }
  const nextTags = active
    ? [...currentTags, tag]
    : currentTags.filter((item) => item !== tag);

  return declaration.doc
    ? handwaveDocTagEdit(source, declaration, nextTags)
    : handwaveDocInsertion(source, declaration, { tags: nextTags });
}

export function applyLeanDeclarationMetadataUpdate(
  source: string,
  uri: string,
  declarationName: string,
  update: LeanDeclarationMetadataUpdate
): string | undefined {
  const declaration = parseLeanDocument(source, uri)
    .find((item) => item.name === declarationName);
  if (!declaration) {
    return undefined;
  }

  const normalizedUpdate: Record<string, string | undefined> = {};
  for (const key of ["name", "statement", "proof"] as const) {
    if (update[key] !== undefined) {
      normalizedUpdate[key] = update[key]?.trim();
    }
  }
  if (update.tags !== undefined) {
    normalizedUpdate.tags = normalizedTags(update.tags).join(", ");
  }

  if (!declaration.doc) {
    const fields = Object.fromEntries(
      Object.entries(normalizedUpdate).filter((entry): entry is [string, string] => Boolean(entry[1]))
    );
    if (Object.keys(fields).length === 0) {
      return source;
    }
    return applySourceTextEdit(source, handwaveDocInsertion(source, declaration, fields));
  }

  let updatedSource = source;
  for (const [key, value] of Object.entries(normalizedUpdate)) {
    const currentDeclaration = parseLeanDocument(updatedSource, uri).find((item) =>
      item.name === declarationName ||
      (declaration.isPrivate && item.isPrivate && item.sourceName === declaration.sourceName)
    );
    if (!currentDeclaration?.doc) {
      return undefined;
    }
    const edit = handwaveDocFieldEdit(updatedSource, currentDeclaration, key, value ?? "");
    if (edit) {
      updatedSource = applySourceTextEdit(updatedSource, edit);
    }
  }
  return updatedSource;
}

export function applySourceTextEdit(source: string, edit: SourceTextEdit): string {
  return source.slice(0, edit.start) + edit.text + source.slice(edit.end);
}

function handwaveDocTagEdit(
  source: string,
  declaration: LeanDeclaration,
  tags: readonly string[]
): SourceTextEdit | undefined {
  return handwaveDocFieldEdit(source, declaration, "tags", tags.join(", "));
}

function handwaveDocFieldEdit(
  source: string,
  declaration: LeanDeclaration,
  key: string,
  value: string
): SourceTextEdit | undefined {
  const doc = declaration.doc;
  if (!doc) {
    return undefined;
  }

  const docStart = offsetAtPosition(source, doc.range.start);
  const docEnd = offsetAtPosition(source, doc.range.end);
  const closeStart = handwaveDocCloseStart(source, docStart, docEnd);
  const closeLineStart = lineStartOffset(source, closeStart);
  const fieldRange = findHandwaveFieldRange(source, docStart, closeStart, key);

  if (!value) {
    return fieldRange
      ? { start: fieldRange.start, end: fieldRange.end, text: "" }
      : undefined;
  }

  const fieldText = handwaveFieldBlock(
    fieldRange?.prefix ?? defaultHandwaveFieldPrefix(source, docStart, closeStart),
    key,
    value,
    sourceNewline(source)
  );
  return fieldRange
    ? { start: fieldRange.start, end: fieldRange.end, text: fieldText }
    : { start: closeLineStart, end: closeLineStart, text: fieldText };
}

function handwaveDocInsertion(
  source: string,
  declaration: LeanDeclaration,
  fields: Readonly<Record<string, string | readonly string[]>>
): SourceTextEdit {
  const declarationStart = offsetAtPosition(source, declaration.range.start);
  const declarationLineStart = lineStartOffset(source, declarationStart);
  const indent = source.slice(declarationLineStart, declarationStart).match(/^[ \t]*/)?.[0] ?? "";
  return {
    start: declarationLineStart,
    end: declarationLineStart,
    text: handwaveDocBlock(fields, indent, sourceNewline(source))
  };
}

function handwaveDocBlock(
  fields: Readonly<Record<string, string | readonly string[]>>,
  indent: string,
  newline: string
): string {
  const fieldLines = Object.entries(fields).flatMap(([key, rawValue]) => {
    const value = Array.isArray(rawValue) ? rawValue.join(", ") : String(rawValue);
    if (!value) {
      return [];
    }
    return [
      `${indent}${key}:`,
      ...value.split(/\r?\n/).map((line) => `${indent}  ${line}`)
    ];
  });
  return [
    `${indent}/--`,
    `${indent}%%handwave`,
    ...fieldLines,
    `${indent}-/`,
    ""
  ].join(newline);
}

function normalizedTags(rawTags: readonly string[]): string[] {
  const tags: string[] = [];
  const seen = new Set<string>();
  for (const rawTag of rawTags) {
    const tag = normalizeHandwaveTag(rawTag);
    if (tag && !seen.has(tag)) {
      seen.add(tag);
      tags.push(tag);
    }
  }
  return tags;
}

interface HandwaveFieldRange {
  start: number;
  end: number;
  prefix: string;
}

function findHandwaveFieldRange(
  source: string,
  docStart: number,
  docCloseStart: number,
  key: string
): HandwaveFieldRange | undefined {
  let offset = docStart;
  let fieldStart: number | undefined;
  let fieldPrefix = "";

  while (offset < docCloseStart) {
    const { line, nextOffset } = sourceLineAt(source, offset);
    const prefix = handwaveLinePrefix(line);
    const cleaned = line.slice(prefix.length);
    const keyValue = /^([A-Za-z0-9_.-]+):(?:\s*(.*))?$/.exec(cleaned);

    if (keyValue) {
      if (fieldStart !== undefined) {
        return { start: fieldStart, end: offset, prefix: fieldPrefix };
      }

      if (keyValue[1] === key) {
        fieldStart = offset;
        fieldPrefix = prefix;
      }
    }

    offset = nextOffset;
  }

  if (fieldStart === undefined) {
    return undefined;
  }

  return { start: fieldStart, end: lineStartOffset(source, docCloseStart), prefix: fieldPrefix };
}

function defaultHandwaveFieldPrefix(source: string, docStart: number, docCloseStart: number): string {
  let offset = docStart;
  while (offset < docCloseStart) {
    const { line, nextOffset } = sourceLineAt(source, offset);
    const prefix = handwaveLinePrefix(line);
    const cleaned = line.slice(prefix.length).trim();
    if (/^[A-Za-z0-9_.-]+:/.test(cleaned)) {
      return prefix;
    }
    offset = nextOffset;
  }
  return "";
}

function handwaveFieldBlock(prefix: string, key: string, value: string, newline: string): string {
  const valueLines = value.split(/\r?\n/).map((line) => `${prefix}  ${line}`);
  return [`${prefix}${key}:`, ...valueLines, ""].join(newline);
}

function handwaveDocCloseStart(source: string, docStart: number, docEnd: number): number {
  const closeRelative = source.slice(docStart, docEnd).lastIndexOf("-/");
  return closeRelative >= 0 ? docStart + closeRelative : docEnd;
}

function sourceLineAt(source: string, offset: number): { line: string; nextOffset: number } {
  const newline = source.indexOf("\n", offset);
  const end = newline >= 0 ? newline : source.length;
  const line = source.slice(offset, end).replace(/\r$/, "");
  return { line, nextOffset: newline >= 0 ? newline + 1 : source.length };
}

function lineStartOffset(source: string, offset: number): number {
  return source.lastIndexOf("\n", Math.max(0, offset - 1)) + 1;
}

function handwaveLinePrefix(line: string): string {
  return /^(\s*[-*]?\s?)/.exec(line)?.[1] ?? "";
}

function sourceNewline(source: string): "\n" | "\r\n" {
  return source.includes("\r\n") ? "\r\n" : "\n";
}

function offsetAtPosition(source: string, position: PositionLike): number {
  let line = 0;
  let lineStart = 0;
  for (let offset = 0; offset < source.length && line < position.line; offset++) {
    if (source.charCodeAt(offset) === 10) {
      line++;
      lineStart = offset + 1;
    }
  }
  return Math.max(0, Math.min(source.length, lineStart + position.character));
}
