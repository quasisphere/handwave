import {
  ArticleDocument,
  Backlink,
  LeanDeclarationCheckStatus,
  LeanDeclaration,
  ParsedTarget,
  ResolvedTarget
} from "./types";
import { blankLeanCommentsAndStrings, hasHandwaveTag, isSupportedSelector, parseTarget } from "./parser";

export class HandwaveIndex {
  readonly leanDeclarations = new Map<string, LeanDeclaration>();
  readonly articles = new Map<string, ArticleDocument>();
  readonly articleKeys = new Map<string, string>();
  readonly backlinks = new Map<string, Backlink[]>();
  readonly workspaceRoots: string[];
  private readonly leanDependencyGraph: ReadonlyMap<string, string[]>;
  private readonly leanDefinitionReferenceGraph: ReadonlyMap<string, string[]>;
  private readonly leanDefinitionTheoremReferenceGraph: ReadonlyMap<string, string[]>;
  private readonly leanTheoremDefinitionReferenceGraph: ReadonlyMap<string, string[]>;
  private readonly checkStatuses: ReadonlyMap<string, LeanDeclarationCheckStatus>;

  constructor(
    workspaceRoots: string | string[],
    declarations: LeanDeclaration[],
    articles: ArticleDocument[],
    checkStatuses: ReadonlyMap<string, LeanDeclarationCheckStatus> = new Map(),
    artifactDependencyGraph: ReadonlyMap<string, string[]> = new Map(),
    artifactDefinitionTheoremReferenceGraph: ReadonlyMap<string, string[]> = new Map(),
    artifactTheoremDefinitionReferenceGraph: ReadonlyMap<string, string[]> = new Map()
  ) {
    this.workspaceRoots = (Array.isArray(workspaceRoots) ? workspaceRoots : [workspaceRoots]).filter(Boolean);
    const indexedDeclarations = declarations.filter(isIndexedLeanDeclaration);
    this.checkStatuses = checkStatuses;

    for (const declaration of indexedDeclarations) {
      this.leanDeclarations.set(declaration.name, declaration);
    }
    const sourceTheoremReferenceGraph = collectLeanTheoremReferenceGraph(indexedDeclarations);
    const indexedTheoremNames = new Set(
      indexedDeclarations.filter(isTheoremLikeDeclaration).map((declaration) => declaration.name)
    );
    const indexedDefinitionNames = new Set(
      indexedDeclarations.filter((declaration) => !isTheoremLikeDeclaration(declaration))
        .map((declaration) => declaration.name)
    );
    const sourceDependencyGraph = new Map(
      [...sourceTheoremReferenceGraph].filter(([name]) => indexedTheoremNames.has(name))
    );
    const sourceDefinitionTheoremReferenceGraph = new Map(
      [...sourceTheoremReferenceGraph].filter(([name]) => indexedDefinitionNames.has(name))
    );
    const sourceTheoremDefinitionReferenceGraph =
      collectLeanTheoremProofDefinitionReferenceGraph(indexedDeclarations);
    for (const [name, dependencies] of artifactDependencyGraph) {
      if (indexedTheoremNames.has(name)) {
        sourceDependencyGraph.set(name, dependencies.filter((dependency) => indexedTheoremNames.has(dependency)));
      }
    }
    for (const [name, references] of artifactDefinitionTheoremReferenceGraph) {
      if (indexedDefinitionNames.has(name)) {
        sourceDefinitionTheoremReferenceGraph.set(
          name,
          references.filter((reference) => indexedTheoremNames.has(reference))
        );
      }
    }
    for (const [name, references] of artifactTheoremDefinitionReferenceGraph) {
      if (indexedTheoremNames.has(name)) {
        sourceTheoremDefinitionReferenceGraph.set(
          name,
          references.filter((reference) => indexedDefinitionNames.has(reference))
        );
      }
    }
    this.leanDependencyGraph = sourceDependencyGraph;
    this.leanDefinitionTheoremReferenceGraph = sourceDefinitionTheoremReferenceGraph;
    this.leanTheoremDefinitionReferenceGraph = sourceTheoremDefinitionReferenceGraph;
    this.leanDefinitionReferenceGraph = collectLeanDefinitionReferenceGraph(indexedDeclarations);

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
    return this.leanDeclarations.has(name) ? this.checkStatuses.get(name) : undefined;
  }

  dependenciesForLean(name: string): string[] {
    if (!this.leanDeclarations.has(name)) {
      return [];
    }
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

  statementDefinitionsForLean(name: string): string[] {
    const declaration = this.leanDeclarations.get(name);
    if (!declaration || !isTheoremLikeDeclaration(declaration)) {
      return [];
    }
    return [...(this.leanDefinitionReferenceGraph.get(name) ?? [])];
  }

  proofDefinitionsForLean(name: string): string[] {
    const declaration = this.leanDeclarations.get(name);
    if (!declaration || !isTheoremLikeDeclaration(declaration)) {
      return [];
    }
    const statementDefinitions = new Set(this.statementDefinitionsForLean(name));
    return [...(this.leanTheoremDefinitionReferenceGraph.get(name) ?? [])]
      .filter((definition) => !statementDefinitions.has(definition));
  }

  definitionReferencesForLean(name: string): string[] {
    const declaration = this.leanDeclarations.get(name);
    if (!declaration || isTheoremLikeDeclaration(declaration)) {
      return [];
    }
    return [...(this.leanDefinitionReferenceGraph.get(name) ?? [])];
  }

  theoremReferencesForDefinition(name: string): string[] {
    const declaration = this.leanDeclarations.get(name);
    if (!declaration || isTheoremLikeDeclaration(declaration)) {
      return [];
    }
    return [...(this.leanDefinitionTheoremReferenceGraph.get(name) ?? [])];
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

export function isIndexedLeanDeclaration(declaration: LeanDeclaration): boolean {
  return !hasHandwaveTag(declaration.doc, "shadow");
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

function collectLeanTheoremReferenceGraph(
  declarations: readonly LeanDeclaration[]
): Map<string, string[]> {
  const theoremDeclarations = declarations.filter(isTheoremLikeDeclaration);
  const publicAliases = leanDependencyAliases(theoremDeclarations.filter((declaration) => !declaration.isPrivate));
  const privateAliasesByUri = leanPrivateDependencyAliasesByUri(theoremDeclarations);
  const graph = new Map<string, string[]>();
  const identifierPattern = /[A-Za-z_][A-Za-z0-9_'.]*/g;

  for (const declaration of declarations) {
    const privateAliases = privateAliasesByUri.get(declaration.uri) ?? new Map();
    const dependencies: string[] = [];
    const seen = new Set<string>();
    const source = blankLeanCommentsAndStrings(declaration.statement);
    const localNames = collectLeanDeclarationLocalNames(declaration, source);
    for (const match of source.matchAll(identifierPattern)) {
      const dependency = resolveLeanDependencyIdentifier(match[0], privateAliases, publicAliases, localNames);
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

function collectLeanDefinitionReferenceGraph(
  declarations: readonly LeanDeclaration[]
): Map<string, string[]> {
  return collectLeanDefinitionReferences(
    declarations,
    () => true,
    (declaration) =>
      isTheoremLikeDeclaration(declaration) ? declaration.leanStatement : declaration.statement
  );
}

function collectLeanTheoremProofDefinitionReferenceGraph(
  declarations: readonly LeanDeclaration[]
): Map<string, string[]> {
  return collectLeanDefinitionReferences(
    declarations,
    isTheoremLikeDeclaration,
    (declaration) => declaration.leanProof ?? "",
    (declaration) => `${declaration.leanStatement}\n${declaration.leanProof ?? ""}`
  );
}

function collectLeanDefinitionReferences(
  declarations: readonly LeanDeclaration[],
  includeDeclaration: (declaration: LeanDeclaration) => boolean,
  referenceSource: (declaration: LeanDeclaration) => string,
  localNameSource: (declaration: LeanDeclaration) => string = referenceSource
): Map<string, string[]> {
  const definitionDeclarations = declarations.filter((declaration) => !isTheoremLikeDeclaration(declaration));
  const publicAliases = leanDependencyAliases(
    definitionDeclarations.filter((declaration) => !declaration.isPrivate)
  );
  const privateAliasesByUri = leanPrivateDependencyAliasesByUri(definitionDeclarations);
  const graph = new Map<string, string[]>();
  const identifierPattern = /[\p{L}_][\p{L}\p{N}\p{M}_']*(?:\.[\p{L}_][\p{L}\p{N}\p{M}_']*)*/gu;

  for (const declaration of declarations) {
    if (!includeDeclaration(declaration)) {
      continue;
    }
    const privateAliases = privateAliasesByUri.get(declaration.uri) ?? new Map();
    const references: string[] = [];
    const seen = new Set<string>();
    const source = blankLeanCommentsAndStrings(referenceSource(declaration));
    const localNames = collectLeanDeclarationLocalNames(
      declaration,
      blankLeanCommentsAndStrings(localNameSource(declaration))
    );
    for (const match of source.matchAll(identifierPattern)) {
      const definition = resolveLeanStatementDefinitionIdentifier(
        match[0],
        declaration,
        privateAliases,
        publicAliases,
        localNames
      );
      if (!definition || definition === declaration.name || seen.has(definition)) {
        continue;
      }
      references.push(definition);
      seen.add(definition);
    }
    graph.set(declaration.name, references);
  }

  return graph;
}

function resolveLeanStatementDefinitionIdentifier(
  identifier: string,
  declaration: LeanDeclaration,
  privateAliases: ReadonlyMap<string, string>,
  publicAliases: ReadonlyMap<string, string>,
  localNames: ReadonlySet<string>
): string | undefined {
  const parts = identifier.split(".").filter(Boolean);
  if (parts.length === 0 || (parts.length === 1 && localNames.has(parts[0]!))) {
    return undefined;
  }

  if (parts.length >= 2 && localNames.has(parts[0]!)) {
    for (let index = 1; index < parts.length; index++) {
      const suffix = parts.slice(index).join(".");
      const definition = resolveLeanIdentifierInNamespace(
        suffix,
        declaration.sourceName,
        privateAliases,
        publicAliases
      );
      if (definition) {
        return definition;
      }
    }
    return undefined;
  }

  const direct = resolveLeanIdentifierInNamespace(
    identifier,
    declaration.sourceName,
    privateAliases,
    publicAliases
  );
  if (direct) {
    return direct;
  }

  return direct;
}

function resolveLeanIdentifierInNamespace(
  identifier: string,
  declarationSourceName: string,
  privateAliases: ReadonlyMap<string, string>,
  publicAliases: ReadonlyMap<string, string>
): string | undefined {
  const namespace = declarationSourceName.split(".").filter(Boolean).slice(0, -1);
  for (let length = namespace.length; length > 0; length--) {
    const candidate = [...namespace.slice(0, length), identifier].join(".");
    const resolved = privateAliases.get(candidate) ?? publicAliases.get(candidate);
    if (resolved) {
      return resolved;
    }
  }
  return privateAliases.get(identifier) ?? publicAliases.get(identifier);
}

function resolveLeanDependencyIdentifier(
  identifier: string,
  privateAliases: ReadonlyMap<string, string>,
  publicAliases: ReadonlyMap<string, string>,
  localNames: ReadonlySet<string>
): string | undefined {
  const exact = privateAliases.get(identifier) ?? publicAliases.get(identifier);
  if (exact) {
    return exact;
  }

  const parts = identifier.split(".").filter(Boolean);
  if (parts.length < 2 || !localNames.has(parts[0]!)) {
    return undefined;
  }

  for (let index = 1; index < parts.length; index++) {
    const suffix = parts.slice(index).join(".");
    const dependency = privateAliases.get(suffix) ?? publicAliases.get(suffix);
    if (dependency) {
      return dependency;
    }
  }

  return undefined;
}

function collectLeanLocalNames(source: string): Set<string> {
  const names = new Set<string>();
  const identifierPattern = /[\p{L}_][\p{L}\p{N}\p{M}_']*/gu;
  const binderPattern = /(?:\(|\{|\[)\s*([\p{L}_][\p{L}\p{N}\p{M}_']*(?:\s+[\p{L}_][\p{L}\p{N}\p{M}_']*)*)\s*:/gu;
  const namedLocalPattern = /\b(?:have|let)\s+([\p{L}_][\p{L}\p{N}\p{M}_']*)\b/gu;
  const introPattern = /\bintro\s+([^\n;]*)/g;
  const rcasesPattern = /\brcases\b[^\n]*\bwith\b([^\n]*)/g;

  for (const match of source.matchAll(binderPattern)) {
    addIdentifiers(names, match[1], identifierPattern);
  }

  for (const match of source.matchAll(namedLocalPattern)) {
    names.add(match[1]);
  }

  for (const match of source.matchAll(introPattern)) {
    addIdentifiers(names, match[1], identifierPattern);
  }

  for (const match of source.matchAll(rcasesPattern)) {
    addIdentifiers(names, match[1], identifierPattern);
  }

  return names;
}

function collectLeanDeclarationLocalNames(
  declaration: LeanDeclaration,
  source: string
): Set<string> {
  const names = collectLeanLocalNames(source);
  for (const name of declaration.contextNames ?? []) {
    names.add(name);
  }
  return names;
}

function addIdentifiers(target: Set<string>, source: string, pattern: RegExp): void {
  pattern.lastIndex = 0;
  for (const match of source.matchAll(pattern)) {
    target.add(match[0]);
  }
}

function leanPrivateDependencyAliasesByUri(declarations: readonly LeanDeclaration[]): Map<string, Map<string, string>> {
  const byUri = new Map<string, LeanDeclaration[]>();
  for (const declaration of declarations) {
    if (!declaration.isPrivate) {
      continue;
    }
    byUri.set(declaration.uri, [...(byUri.get(declaration.uri) ?? []), declaration]);
  }

  const aliases = new Map<string, Map<string, string>>();
  for (const [uri, uriDeclarations] of byUri) {
    aliases.set(uri, leanDependencyAliases(uriDeclarations));
  }
  return aliases;
}

function leanDependencyAliases(declarations: readonly LeanDeclaration[]): Map<string, string> {
  const aliasNames = new Map<string, Set<string>>();
  for (const declaration of declarations) {
    for (const alias of leanNameSuffixes(declaration.sourceName)) {
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
