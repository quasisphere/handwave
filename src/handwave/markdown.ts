import {
  parser as commonMarkParser,
  type InlineContext,
  type MarkdownConfig
} from "@lezer/markdown";

const blockIncludePattern = /^@include\{([^}\s]+)\}[ \t]*$/;
const inlineIncludePattern = /^@include\{([^}\s]+)\}/;
const inlineAnchorPattern = /^\{#([A-Za-z0-9_.:-]+)\}/;

const handwaveMarkdownExtension: MarkdownConfig = {
  defineNodes: [
    { name: "HandwaveIncludeBlock", block: true },
    "HandwaveIncludeInline",
    "HandwaveAnchor",
    "HandwaveMath"
  ],
  parseBlock: [{
    name: "HandwaveInclude",
    parse(context, line) {
      const source = line.text.slice(line.pos);
      const match = blockIncludePattern.exec(source);
      if (!match) {
        return false;
      }

      const from = context.lineStart + line.pos;
      const to = from + match[0].trimEnd().length;
      context.addElement(context.elt("HandwaveIncludeBlock", from, to));
      context.nextLine();
      return true;
    },
    endLeaf(_context, line) {
      return blockIncludePattern.test(line.text.slice(line.pos));
    }
  }],
  parseInline: [{
    name: "HandwaveMath",
    before: "Escape",
    parse(context, _next, position) {
      const end = handwaveMathEnd(context, position);
      return end < 0
        ? -1
        : context.addElement(context.elt("HandwaveMath", position, end));
    }
  }, {
    name: "HandwaveInclude",
    parse(context, next, position) {
      if (next !== 64 /* @ */) {
        return -1;
      }
      const match = inlineIncludePattern.exec(context.slice(position, context.end));
      return match
        ? context.addElement(context.elt("HandwaveIncludeInline", position, position + match[0].length))
        : -1;
    }
  }, {
    name: "HandwaveAnchor",
    parse(context, next, position) {
      if (next !== 123 /* { */) {
        return -1;
      }
      const match = inlineAnchorPattern.exec(context.slice(position, context.end));
      return match
        ? context.addElement(context.elt("HandwaveAnchor", position, position + match[0].length))
        : -1;
    }
  }]
};

export const handwaveMarkdownParser = commonMarkParser.configure(handwaveMarkdownExtension);

export type HandwaveMarkdownTree = ReturnType<typeof handwaveMarkdownParser.parse>;
export type HandwaveMarkdownNode = HandwaveMarkdownTree["topNode"];

export interface HandwaveMarkdownHeading {
  level: number;
  title: string;
  titleFrom: number;
  titleTo: number;
  explicitId?: string;
}

export interface HandwaveMarkdownLink {
  label: string;
  labelFrom: number;
  labelTo: number;
  target: string;
  targetFrom: number;
  targetTo: number;
}

export interface HandwaveMarkdownInclude {
  target: string;
  targetFrom: number;
  targetTo: number;
}

export interface HandwaveMarkdownAnchor {
  id: string;
}

export type HandwaveMarkdownReferences = ReadonlyMap<string, HandwaveMarkdownReference>;

interface HandwaveMarkdownReference {
  target: string;
  targetFrom: number;
  targetTo: number;
}

export function parseHandwaveMarkdown(text: string): HandwaveMarkdownTree {
  return handwaveMarkdownParser.parse(text);
}

export function markdownChildren(node: HandwaveMarkdownNode): HandwaveMarkdownNode[] {
  const children: HandwaveMarkdownNode[] = [];
  for (let child = node.firstChild; child; child = child.nextSibling) {
    children.push(child);
  }
  return children;
}

export function handwaveMarkdownHeading(
  text: string,
  node: HandwaveMarkdownNode
): HandwaveMarkdownHeading | undefined {
  const atx = /^ATXHeading([1-6])$/.exec(node.name);
  const setext = /^SetextHeading([12])$/.exec(node.name);
  if (!atx && !setext) {
    return undefined;
  }

  const marks = markdownChildren(node).filter((child) => child.name === "HeaderMark");
  let titleFrom = node.from;
  let titleTo = node.to;
  if (atx) {
    const openingMark = marks[0];
    if (openingMark) {
      titleFrom = openingMark.to;
    }
    const closingMark = marks.length > 1 ? marks[marks.length - 1] : undefined;
    if (closingMark) {
      titleTo = closingMark.from;
    }
  } else if (marks[0]) {
    titleTo = marks[0].from;
  }

  while (titleFrom < titleTo && /\s/.test(text[titleFrom])) {
    titleFrom++;
  }
  while (titleTo > titleFrom && /\s/.test(text[titleTo - 1])) {
    titleTo--;
  }

  const sourceTitle = text.slice(titleFrom, titleTo);
  const explicitAnchor = /\s+\{#([A-Za-z0-9_.:-]+)\}\s*$/.exec(sourceTitle);
  if (explicitAnchor?.index !== undefined) {
    titleTo = titleFrom + explicitAnchor.index;
    while (titleTo > titleFrom && /\s/.test(text[titleTo - 1])) {
      titleTo--;
    }
  }

  return {
    level: Number(atx?.[1] ?? setext?.[1]),
    title: text.slice(titleFrom, titleTo),
    titleFrom,
    titleTo,
    explicitId: explicitAnchor?.[1]
  };
}

export function handwaveMarkdownLink(
  text: string,
  node: HandwaveMarkdownNode,
  references: HandwaveMarkdownReferences = new Map()
): HandwaveMarkdownLink | undefined {
  if (node.name !== "Link") {
    return undefined;
  }

  let labelFrom = node.from + 1;
  let labelTo: number | undefined;
  let targetNode: HandwaveMarkdownNode | undefined;
  let referenceLabel: string | undefined;
  for (const child of markdownChildren(node)) {
    const source = text.slice(child.from, child.to);
    if (child.name === "LinkMark" && source === "]" && labelTo === undefined) {
      labelTo = child.from;
    } else if (child.name === "URL") {
      targetNode = child;
    } else if (child.name === "LinkLabel") {
      referenceLabel = source.slice(1, -1);
    }
  }

  if (labelTo === undefined) {
    return undefined;
  }
  while (labelFrom < labelTo && text[labelFrom] === "[") {
    labelFrom++;
  }

  const directTarget = targetNode ? markdownUrl(text, targetNode) : undefined;
  const reference = directTarget
    ? undefined
    : references.get(normalizeMarkdownReference(referenceLabel || text.slice(labelFrom, labelTo)));
  if (!directTarget && !reference) {
    return undefined;
  }

  return {
    label: text.slice(labelFrom, labelTo),
    labelFrom,
    labelTo,
    target: directTarget?.target ?? reference!.target,
    targetFrom: directTarget?.targetFrom ?? reference!.targetFrom,
    targetTo: directTarget?.targetTo ?? reference!.targetTo
  };
}

export function handwaveMarkdownReferences(
  text: string,
  tree: HandwaveMarkdownTree
): HandwaveMarkdownReferences {
  const references = new Map<string, HandwaveMarkdownReference>();
  const visit = (node: HandwaveMarkdownNode) => {
    if (node.name === "LinkReference") {
      const children = markdownChildren(node);
      const labelNode = children.find((child) => child.name === "LinkLabel");
      const targetNode = children.find((child) => child.name === "URL");
      if (labelNode && targetNode) {
        const key = normalizeMarkdownReference(text.slice(labelNode.from + 1, labelNode.to - 1));
        if (!references.has(key)) {
          references.set(key, markdownUrl(text, targetNode));
        }
      }
    }
    for (const child of markdownChildren(node)) {
      visit(child);
    }
  };
  visit(tree.topNode);
  return references;
}

export function handwaveMarkdownInclude(
  text: string,
  node: HandwaveMarkdownNode
): HandwaveMarkdownInclude | undefined {
  if (node.name !== "HandwaveIncludeBlock" && node.name !== "HandwaveIncludeInline") {
    return undefined;
  }
  const source = text.slice(node.from, node.to);
  const match = /^@include\{([^}\s]+)\}$/.exec(source);
  if (!match) {
    return undefined;
  }
  const targetFrom = node.from + "@include{".length;
  return {
    target: match[1],
    targetFrom,
    targetTo: targetFrom + match[1].length
  };
}

export function handwaveMarkdownAnchor(
  text: string,
  node: HandwaveMarkdownNode
): HandwaveMarkdownAnchor | undefined {
  if (node.name !== "HandwaveAnchor") {
    return undefined;
  }
  const match = inlineAnchorPattern.exec(text.slice(node.from, node.to));
  return match ? { id: match[1] } : undefined;
}

function handwaveMathEnd(context: InlineContext, position: number): number {
  let opening: string;
  let closing: string;
  let singleLine = false;
  let requireContent = false;

  if (context.char(position) === 36 /* $ */) {
    if (context.char(position + 1) === 36) {
      opening = closing = "$$";
    } else {
      opening = closing = "$";
      singleLine = true;
      requireContent = true;
    }
  } else if (context.char(position) === 92 /* \\ */ && context.char(position + 1) === 40 /* ( */) {
    opening = "\\(";
    closing = "\\)";
  } else if (context.char(position) === 92 /* \\ */ && context.char(position + 1) === 91 /* [ */) {
    opening = "\\[";
    closing = "\\]";
  } else {
    return -1;
  }

  const contentFrom = position + opening.length;
  for (let cursor = contentFrom; cursor < context.end; cursor++) {
    const next = context.char(cursor);
    if (singleLine && (next === 10 || next === 13)) {
      return -1;
    }
    if (
      context.slice(cursor, cursor + closing.length) === closing &&
      (!requireContent || cursor > contentFrom)
    ) {
      return cursor + closing.length;
    }
    if (opening[0] === "$" && next === 92 /* \\ */) {
      cursor++;
    }
  }
  return -1;
}

function markdownUrl(
  text: string,
  node: HandwaveMarkdownNode
): HandwaveMarkdownReference {
  const source = text.slice(node.from, node.to);
  const bracketed = source.startsWith("<") && source.endsWith(">");
  return {
    target: bracketed ? source.slice(1, -1) : source,
    targetFrom: node.from + (bracketed ? 1 : 0),
    targetTo: node.to - (bracketed ? 1 : 0)
  };
}

function normalizeMarkdownReference(label: string): string {
  return label.trim().replace(/\s+/g, " ").toLowerCase();
}
