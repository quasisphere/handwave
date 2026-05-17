import { PositionLike, RangeLike } from "./types";

export function positionAt(text: string, offset: number): PositionLike {
  const safeOffset = Math.max(0, Math.min(offset, text.length));
  let line = 0;
  let lineStart = 0;

  for (let i = 0; i < safeOffset; i++) {
    if (text.charCodeAt(i) === 10) {
      line++;
      lineStart = i + 1;
    }
  }

  return { line, character: safeOffset - lineStart };
}

export function rangeFromOffsets(text: string, start: number, end: number): RangeLike {
  return {
    start: positionAt(text, start),
    end: positionAt(text, end)
  };
}

export function containsPosition(range: RangeLike, position: PositionLike): boolean {
  const startsBefore =
    range.start.line < position.line ||
    (range.start.line === position.line && range.start.character <= position.character);
  const endsAfter =
    range.end.line > position.line ||
    (range.end.line === position.line && range.end.character >= position.character);
  return startsBefore && endsAfter;
}
