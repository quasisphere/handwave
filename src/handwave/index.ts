import {
  ArticleDocument,
  Backlink,
  HandwaveDoc,
  LeanDeclaration,
  ParsedTarget,
  ResolvedTarget
} from "./types";
import { isSupportedSelector, parseTarget } from "./parser";

export class HandwaveIndex {
  readonly leanDeclarations = new Map<string, LeanDeclaration>();
  readonly docs = new Map<string, { doc: HandwaveDoc; declaration: LeanDeclaration }>();
  readonly articles = new Map<string, ArticleDocument>();
  readonly articleKeys = new Map<string, string>();
  readonly backlinks = new Map<string, Backlink[]>();

  constructor(
    readonly workspaceRoot: string,
    declarations: LeanDeclaration[],
    articles: ArticleDocument[]
  ) {
    for (const declaration of declarations) {
      this.leanDeclarations.set(declaration.name, declaration);
      if (declaration.doc?.id) {
        this.docs.set(declaration.doc.id, { doc: declaration.doc, declaration });
      }
    }

    for (const article of articles) {
      this.articles.set(article.uri, article);
      for (const key of articleKeys(article.uri, workspaceRoot)) {
        this.articleKeys.set(key, article.uri);
      }
      this.collectBacklinks(article);
    }
  }

  resolve(rawTarget: string, fromUri?: string): ResolvedTarget | undefined {
    return this.resolveParsed(parseTarget(rawTarget), fromUri);
  }

  resolveParsed(target: ParsedTarget, fromUri?: string): ResolvedTarget | undefined {
    if (!isSupportedSelector(target.selector)) {
      return undefined;
    }

    switch (target.kind) {
      case "lean":
        return this.resolveLean(target);
      case "doc":
        return this.resolveDoc(target);
      case "article":
        return this.resolveArticle(target);
      case "local":
        return fromUri ? this.resolveLocal(target, fromUri) : undefined;
      case "term":
      case "unknown":
        return undefined;
    }
  }

  backlinkCountForLean(name: string): number {
    return this.backlinksFor(`lean:${name}`).length;
  }

  backlinksFor(rawTarget: string): Backlink[] {
    const target = parseTarget(rawTarget);
    return this.backlinks.get(canonicalTargetKey(target)) ?? [];
  }

  targetKey(rawTarget: string): string {
    return canonicalTargetKey(parseTarget(rawTarget));
  }

  private resolveLean(target: ParsedTarget): ResolvedTarget | undefined {
    const declaration = this.leanDeclarations.get(target.base);
    if (!declaration) {
      return undefined;
    }

    const preview = resolveSelectorText(target.selector, declaration, declaration.doc);
    if (preview === undefined) {
      return undefined;
    }

    return {
      target,
      uri: declaration.uri,
      range: declaration.nameRange,
      title: declaration.name,
      preview,
      key: canonicalTargetKey(target)
    };
  }

  private resolveDoc(target: ParsedTarget): ResolvedTarget | undefined {
    const entry = this.docs.get(target.base);
    if (!entry) {
      return undefined;
    }

    const preview = resolveSelectorText(target.selector, entry.declaration, entry.doc);
    if (preview === undefined) {
      return undefined;
    }

    return {
      target,
      uri: entry.declaration.uri,
      range: entry.doc.range,
      title: target.base,
      preview,
      key: canonicalTargetKey(target)
    };
  }

  private resolveArticle(target: ParsedTarget): ResolvedTarget | undefined {
    const uri = this.articleKeys.get(target.base) ?? this.articleKeys.get(stripLeadingSlash(target.base));
    if (!uri) {
      return undefined;
    }

    const article = this.articles.get(uri);
    if (!article) {
      return undefined;
    }

    const anchor = target.anchor ? article.anchors.find((item) => item.id === target.anchor) : article.anchors[0];
    if (!anchor) {
      return undefined;
    }

    return {
      target,
      uri,
      range: anchor.range,
      title: anchor.title,
      preview: anchor.title,
      key: canonicalTargetKey(target)
    };
  }

  private resolveLocal(target: ParsedTarget, fromUri: string): ResolvedTarget | undefined {
    const article = this.articles.get(fromUri);
    const anchor = article?.anchors.find((item) => item.id === target.anchor);
    if (!article || !anchor) {
      return undefined;
    }

    return {
      target,
      uri: fromUri,
      range: anchor.range,
      title: anchor.title,
      preview: anchor.title,
      key: canonicalTargetKey(target)
    };
  }

  private collectBacklinks(article: ArticleDocument): void {
    const refs = [
      ...article.links.map((link) => ({ target: link.target, range: link.range, label: link.label })),
      ...article.includes.map((include) => ({
        target: include.target,
        range: include.range,
        label: include.target
      }))
    ];

    for (const ref of refs) {
      const parsed = parseTarget(ref.target);
      if (parsed.kind === "unknown" || parsed.kind === "term") {
        continue;
      }

      const key = canonicalTargetKey(parsed);
      const existing = this.backlinks.get(key) ?? [];
      existing.push({
        fromUri: article.uri,
        range: ref.range,
        label: ref.label,
        target: ref.target
      });
      this.backlinks.set(key, existing);
    }
  }
}

export function canonicalTargetKey(target: ParsedTarget): string {
  switch (target.kind) {
    case "lean":
    case "doc":
      return `${target.kind}:${target.base}`;
    case "article":
      return `article:${target.base}${target.anchor ? `#${target.anchor}` : ""}`;
    case "local":
      return `local:#${target.anchor ?? target.body}`;
    case "term":
      return `term:${target.base}`;
    case "unknown":
      return `unknown:${target.raw}`;
  }
}

function resolveSelectorText(
  selector: string | undefined,
  declaration: LeanDeclaration,
  doc: HandwaveDoc | undefined
): string | undefined {
  if (!selector || selector === "statement") {
    return declaration.statement;
  }

  return doc?.fields[selector];
}

function articleKeys(uri: string, workspaceRoot: string): string[] {
  const normalizedUri = uri.replace(/\\/g, "/");
  const normalizedRoot = workspaceRoot.replace(/\\/g, "/").replace(/\/$/, "");
  const relative = normalizedUri.startsWith(normalizedRoot)
    ? stripLeadingSlash(normalizedUri.slice(normalizedRoot.length))
    : normalizedUri.split("/").slice(-1)[0];
  const withoutExtension = relative.replace(/\.hw\.md$|\.hw$/i, "");
  const basename = relative.split("/").slice(-1)[0];
  const basenameWithoutExtension = basename.replace(/\.hw\.md$|\.hw$/i, "");

  return Array.from(new Set([
    relative,
    withoutExtension,
    basename,
    basenameWithoutExtension
  ]));
}

function stripLeadingSlash(value: string): string {
  return value.replace(/^\/+/, "");
}
