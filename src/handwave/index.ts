import {
  ArticleDocument,
  Backlink,
  LeanDeclarationCheckStatus,
  LeanDeclaration,
  ParsedTarget,
  ResolvedTarget
} from "./types";
import { blankLeanCommentsAndStrings, isSupportedSelector, parseTarget } from "./parser";

export class HandwaveIndex {
  readonly leanDeclarations = new Map<string, LeanDeclaration>();
  readonly articles = new Map<string, ArticleDocument>();
  readonly articleKeys = new Map<string, string>();
  readonly backlinks = new Map<string, Backlink[]>();
  readonly workspaceRoots: string[];
  private readonly leanDependencyGraph: ReadonlyMap<string, string[]>;
  private readonly checkStatuses: ReadonlyMap<string, LeanDeclarationCheckStatus>;

  constructor(
    workspaceRoots: string | string[],
    declarations: LeanDeclaration[],
    articles: ArticleDocument[],
    checkStatuses: ReadonlyMap<string, LeanDeclarationCheckStatus> = new Map()
  ) {
    this.workspaceRoots = (Array.isArray(workspaceRoots) ? workspaceRoots : [workspaceRoots]).filter(Boolean);
    this.checkStatuses = checkStatuses;

    for (const declaration of declarations) {
      this.leanDeclarations.set(declaration.name, declaration);
    }
    this.leanDependencyGraph = collectLeanDependencyGraph(declarations);

    for (const article of articles) {
      this.articles.set(article.uri, article);
      for (const key of articleKeys(article.uri, this.workspaceRoots)) {
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

  checkStatusForLean(name: string): LeanDeclarationCheckStatus | undefined {
    return this.checkStatuses.get(name);
  }

  dependenciesForLean(name: string): string[] {
    const dependencies = [...(this.leanDependencyGraph.get(name) ?? [])];
    const seen = new Set(dependencies);
    const status = this.checkStatuses.get(name);
    if (!status) {
      return dependencies;
    }

    for (const dependency of [...status.dependencies, ...status.failedDependencies]) {
      const declaration = this.leanDeclarations.get(dependency);
      if (
        !declaration ||
        !isTheoremLikeDeclaration(declaration) ||
        dependency === name ||
        seen.has(dependency)
      ) {
        continue;
      }
      dependencies.push(dependency);
      seen.add(dependency);
    }
    return dependencies;
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
  handwaveDoc: LeanDeclaration["doc"]
): string | undefined {
  if (!selector || selector === "lean.statement") {
    return declaration.leanStatement;
  }

  if (selector === "statement") {
    return handwaveDoc?.fields.statement ?? declaration.leanStatement;
  }

  if (selector === "lean.proof") {
    return declaration.leanProof;
  }

  return handwaveDoc?.fields[selector];
}

function articleKeys(uri: string, workspaceRoots: string[]): string[] {
  const normalizedUri = uri.replace(/\\/g, "/");
  const roots = workspaceRoots.map((root) => root.replace(/\\/g, "/").replace(/\/$/, ""));
  const relatives = roots
    .filter((root) => normalizedUri.startsWith(root))
    .map((root) => stripLeadingSlash(normalizedUri.slice(root.length)));
  if (relatives.length === 0) {
    relatives.push(normalizedUri.split("/").slice(-1)[0]);
  }

  const basename = normalizedUri.split("/").slice(-1)[0];
  const basenameWithoutExtension = basename.replace(/\.hw\.md$|\.hw$/i, "");
  const keys = [normalizedUri, basename, basenameWithoutExtension];

  for (const relative of relatives) {
    keys.push(relative, relative.replace(/\.hw\.md$|\.hw$/i, ""));
  }

  return Array.from(new Set(keys));
}

function collectLeanDependencyGraph(declarations: readonly LeanDeclaration[]): Map<string, string[]> {
  const theoremDeclarations = declarations.filter(isTheoremLikeDeclaration);
  const aliases = leanDependencyAliases(theoremDeclarations);
  const graph = new Map<string, string[]>();
  const identifierPattern = /[A-Za-z_][A-Za-z0-9_'.]*/g;

  for (const declaration of theoremDeclarations) {
    const dependencies: string[] = [];
    const seen = new Set<string>();
    const source = blankLeanCommentsAndStrings(declaration.statement);
    for (const match of source.matchAll(identifierPattern)) {
      const dependency = aliases.get(match[0]);
      if (!dependency || dependency === declaration.name || seen.has(dependency)) {
        continue;
      }
      dependencies.push(dependency);
      seen.add(dependency);
    }
    graph.set(declaration.name, dependencies);
  }

  return graph;
}

function leanDependencyAliases(declarations: readonly LeanDeclaration[]): Map<string, string> {
  const aliasNames = new Map<string, Set<string>>();
  for (const declaration of declarations) {
    for (const alias of leanNameSuffixes(declaration.name)) {
      let names = aliasNames.get(alias);
      if (!names) {
        names = new Set<string>();
        aliasNames.set(alias, names);
      }
      names.add(declaration.name);
    }
  }

  const aliases = new Map<string, string>();
  for (const [alias, names] of aliasNames) {
    if (names.size === 1) {
      aliases.set(alias, [...names][0]!);
    }
  }
  return aliases;
}

function leanNameSuffixes(name: string): string[] {
  const parts = name.split(".").filter(Boolean);
  if (parts.length === 0) {
    return [name];
  }

  return parts.map((_part, index) => parts.slice(index).join("."));
}

function isTheoremLikeDeclaration(declaration: LeanDeclaration): boolean {
  return declaration.kind === "theorem" || declaration.kind === "lemma";
}

function stripLeadingSlash(value: string): string {
  return value.replace(/^\/+/, "");
}
