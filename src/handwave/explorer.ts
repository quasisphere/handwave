import * as path from "node:path";
import { HandwaveIndex, isIndexedLeanDeclaration } from "./index";
import { renderCheckStatus } from "./renderer";
import { LeanDeclaration, LeanDeclarationCheckStatus } from "./types";

export type TheoremExplorerStatusCategory = "green" | "yellow" | "red" | "unknown";

export interface TheoremExplorerPayload {
  generatedAt: number;
  theoremCount: number;
  definitionCount: number;
  milestoneCount: number;
  theorems: TheoremExplorerItem[];
  definitions: DefinitionExplorerItem[];
}

export interface TheoremExplorerItem {
  name: string;
  sourceName: string;
  shortName: string;
  displayName: string;
  displayNameHasMath: boolean;
  moduleName: string;
  uri: string;
  relativePath: string;
  target: string;
  tags: string[];
  milestone: boolean;
  isPrivate: boolean;
  dependencies: string[];
  definitions: TheoremExplorerLink[];
  dependents: TheoremExplorerLink[];
  referencingDefinitions: TheoremExplorerLink[];
  references: TheoremExplorerLink[];
  statusCategory: TheoremExplorerStatusCategory;
  statusHtml: string;
}

export interface DefinitionExplorerItem {
  name: string;
  sourceName: string;
  shortName: string;
  displayName: string;
  displayNameHasMath: boolean;
  moduleName: string;
  uri: string;
  relativePath: string;
  target: string;
  isPrivate: boolean;
  definitions: TheoremExplorerLink[];
  theorems: TheoremExplorerLink[];
  referencingDefinitions: TheoremExplorerLink[];
  referencingTheorems: TheoremExplorerLink[];
  references: TheoremExplorerLink[];
}

export interface TheoremExplorerStatusUpdate {
  name: string;
  statusCategory: TheoremExplorerStatusCategory;
  statusHtml: string;
}

export interface TheoremExplorerLink {
  target: string;
  label: string;
  detail?: string;
  proofOnly?: boolean;
}

export function buildTheoremExplorerPayload(
  index: HandwaveIndex,
  declarations: readonly LeanDeclaration[],
  workspaceRoots: readonly string[]
): TheoremExplorerPayload {
  const theorems = declarations
    .filter(isIndexedLeanDeclaration)
    .filter(isTheoremLikeDeclaration)
    .map((declaration) => theoremExplorerItem(index, declaration, workspaceRoots))
    .sort(compareTheoremExplorerItems);
  const definitions = declarations
    .filter(isIndexedLeanDeclaration)
    .filter((declaration) => !isTheoremLikeDeclaration(declaration))
    .map((declaration) => definitionExplorerItem(index, declaration, workspaceRoots))
    .sort(compareDefinitionExplorerItems);
  addDependentLinks(theorems);
  addDefinitionReferenceLinks(theorems, definitions);
  const publicTheorems = theorems.filter((item) => !item.isPrivate);
  const publicDefinitions = definitions.filter((item) => !item.isPrivate);

  return {
    generatedAt: Date.now(),
    theoremCount: publicTheorems.length,
    definitionCount: publicDefinitions.length,
    milestoneCount: publicTheorems.filter((item) => item.milestone).length,
    theorems,
    definitions
  };
}

function theoremExplorerItem(
  index: HandwaveIndex,
  declaration: LeanDeclaration,
  workspaceRoots: readonly string[]
): TheoremExplorerItem {
  const displayName = declaration.doc?.fields.name?.trim() || shortLeanName(declaration.sourceName);
  const moduleName = leanModuleName(declaration.sourceName);
  const status = index.checkStatusForLean(declaration.name);
  const statementDefinitions = index.statementDefinitionsForLean(declaration.name)
    .map((name) => declarationExplorerLink(index.leanDeclarations.get(name)))
    .filter((link): link is TheoremExplorerLink => Boolean(link));
  const proofDefinitions = index.proofDefinitionsForLean(declaration.name)
    .map((name) => declarationExplorerLink(index.leanDeclarations.get(name)))
    .filter((link): link is TheoremExplorerLink => Boolean(link))
    .map((link) => ({ ...link, proofOnly: true }));
  return {
    name: declaration.name,
    sourceName: declaration.sourceName,
    shortName: shortLeanName(declaration.sourceName),
    displayName,
    displayNameHasMath: containsMathDelimiter(displayName),
    moduleName,
    uri: declaration.uri,
    relativePath: relativeWorkspacePath(declaration.uri, workspaceRoots),
    target: `lean:${declaration.name}`,
    tags: declaration.doc?.tags ?? [],
    milestone: Boolean(declaration.doc?.tags.includes("milestone")),
    isPrivate: declaration.isPrivate,
    dependencies: index.dependenciesForLean(declaration.name),
    definitions: [...statementDefinitions, ...proofDefinitions],
    dependents: [],
    referencingDefinitions: [],
    references: articleReferencesForLean(index, declaration.name, workspaceRoots),
    statusCategory: theoremExplorerStatusCategory(status),
    statusHtml: renderCheckStatus(status)
  };
}

function definitionExplorerItem(
  index: HandwaveIndex,
  declaration: LeanDeclaration,
  workspaceRoots: readonly string[]
): DefinitionExplorerItem {
  const displayName = declaration.doc?.fields.name?.trim() || shortLeanName(declaration.sourceName);
  return {
    name: declaration.name,
    sourceName: declaration.sourceName,
    shortName: shortLeanName(declaration.sourceName),
    displayName,
    displayNameHasMath: containsMathDelimiter(displayName),
    moduleName: leanModuleName(declaration.sourceName),
    uri: declaration.uri,
    relativePath: relativeWorkspacePath(declaration.uri, workspaceRoots),
    target: `lean:${declaration.name}`,
    isPrivate: declaration.isPrivate,
    definitions: index.definitionReferencesForLean(declaration.name)
      .map((name) => declarationExplorerLink(index.leanDeclarations.get(name)))
      .filter((link): link is TheoremExplorerLink => Boolean(link)),
    theorems: index.theoremReferencesForDefinition(declaration.name)
      .map((name) => declarationExplorerLink(index.leanDeclarations.get(name)))
      .filter((link): link is TheoremExplorerLink => Boolean(link)),
    referencingDefinitions: [],
    referencingTheorems: [],
    references: articleReferencesForLean(index, declaration.name, workspaceRoots)
  };
}

export function theoremExplorerStatusCategory(
  status: LeanDeclarationCheckStatus | undefined
): TheoremExplorerStatusCategory {
  if (!status || status.inconclusive || status.blocked) {
    return "unknown";
  }
  if (!status.checked && status.ownChecked) {
    return "yellow";
  }
  return status.checked ? "green" : "red";
}

function addDependentLinks(theorems: TheoremExplorerItem[]): void {
  const byName = new Map(theorems.map((theorem) => [theorem.name, theorem]));
  const seenByDependency = new Map<string, Set<string>>();
  for (const theorem of theorems) {
    for (const dependencyName of theorem.dependencies) {
      const dependency = byName.get(dependencyName);
      if (!dependency || dependency.name === theorem.name) {
        continue;
      }

      let seen = seenByDependency.get(dependency.name);
      if (!seen) {
        seen = new Set();
        seenByDependency.set(dependency.name, seen);
      }
      if (seen.has(theorem.name)) {
        continue;
      }

      seen.add(theorem.name);
      dependency.dependents.push(theoremExplorerLink(theorem));
    }
  }

  for (const theorem of theorems) {
    theorem.dependents.sort(compareTheoremExplorerLinks);
  }
}

function theoremExplorerLink(theorem: TheoremExplorerItem): TheoremExplorerLink {
  return {
    target: theorem.target,
    label: theorem.displayName,
    detail: theorem.moduleName || theorem.relativePath
  };
}

function definitionExplorerLink(definition: DefinitionExplorerItem): TheoremExplorerLink {
  return {
    target: definition.target,
    label: definition.displayName,
    detail: definition.moduleName || definition.relativePath
  };
}

function declarationExplorerLink(
  declaration: LeanDeclaration | undefined
): TheoremExplorerLink | undefined {
  if (!declaration) {
    return undefined;
  }
  const displayName = declaration.doc?.fields.name?.trim() || shortLeanName(declaration.sourceName);
  return {
    target: `lean:${declaration.name}`,
    label: displayName,
    detail: declaration.sourceName
  };
}

function addDefinitionReferenceLinks(
  theorems: readonly TheoremExplorerItem[],
  definitions: readonly DefinitionExplorerItem[]
): void {
  const definitionsByName = new Map(definitions.map((definition) => [definition.name, definition]));
  const theoremsByName = new Map(theorems.map((theorem) => [theorem.name, theorem]));
  for (const theorem of theorems) {
    for (const reference of theorem.definitions) {
      const definitionName = leanNameFromTarget(reference.target);
      const definition = definitionName ? definitionsByName.get(definitionName) : undefined;
      if (definition) {
        const link = theoremExplorerLink(theorem);
        addExplorerLink(
          definition.referencingTheorems,
          reference.proofOnly ? { ...link, proofOnly: true } : link
        );
      }
    }
  }
  for (const referencingDefinition of definitions) {
    for (const reference of referencingDefinition.definitions) {
      const definitionName = leanNameFromTarget(reference.target);
      const definition = definitionName ? definitionsByName.get(definitionName) : undefined;
      if (definition && definition.name !== referencingDefinition.name) {
        addExplorerLink(
          definition.referencingDefinitions,
          definitionExplorerLink(referencingDefinition)
        );
      }
    }
    for (const reference of referencingDefinition.theorems) {
      const theoremName = leanNameFromTarget(reference.target);
      const theorem = theoremName ? theoremsByName.get(theoremName) : undefined;
      if (theorem) {
        addExplorerLink(
          theorem.referencingDefinitions,
          definitionExplorerLink(referencingDefinition)
        );
      }
    }
  }
  for (const theorem of theorems) {
    theorem.referencingDefinitions.sort(compareTheoremExplorerLinks);
  }
  for (const definition of definitions) {
    definition.referencingDefinitions.sort(compareTheoremExplorerLinks);
    definition.referencingTheorems.sort(compareTheoremExplorerLinks);
  }
}

function addExplorerLink(
  links: TheoremExplorerLink[],
  link: TheoremExplorerLink
): void {
  const existingIndex = links.findIndex((candidate) => candidate.target === link.target);
  if (existingIndex < 0) {
    links.push(link);
  } else if (links[existingIndex]?.proofOnly && !link.proofOnly) {
    links[existingIndex] = link;
  }
}

function leanNameFromTarget(target: string): string | undefined {
  return target.startsWith("lean:") ? target.slice("lean:".length) || undefined : undefined;
}

function articleReferencesForLean(
  index: HandwaveIndex,
  name: string,
  workspaceRoots: readonly string[]
): TheoremExplorerLink[] {
  const references = new Map<string, TheoremExplorerLink>();
  for (const backlink of index.backlinksFor(`lean:${name}`)) {
    const relativePath = relativeWorkspacePath(backlink.fromUri, workspaceRoots);
    const article = index.articles.get(backlink.fromUri);
    references.set(backlink.fromUri, {
      target: `article:${relativePath}`,
      label: relativePath,
      detail: article?.anchors[0]?.title
    });
  }
  return [...references.values()].sort(compareTheoremExplorerLinks);
}

function compareTheoremExplorerLinks(first: TheoremExplorerLink, second: TheoremExplorerLink): number {
  return Number(Boolean(first.proofOnly)) - Number(Boolean(second.proofOnly)) ||
    first.label.localeCompare(second.label) ||
    (first.detail ?? "").localeCompare(second.detail ?? "") ||
    first.target.localeCompare(second.target);
}

function compareTheoremExplorerItems(first: TheoremExplorerItem, second: TheoremExplorerItem): number {
  return first.moduleName.localeCompare(second.moduleName) ||
    first.shortName.localeCompare(second.shortName) ||
    first.sourceName.localeCompare(second.sourceName);
}

function compareDefinitionExplorerItems(
  first: DefinitionExplorerItem,
  second: DefinitionExplorerItem
): number {
  return first.moduleName.localeCompare(second.moduleName) ||
    first.shortName.localeCompare(second.shortName) ||
    first.sourceName.localeCompare(second.sourceName);
}

function containsMathDelimiter(text: string): boolean {
  if (
    (text.includes("\\(") && text.includes("\\)")) ||
    (text.includes("\\[") && text.includes("\\]"))
  ) {
    return true;
  }

  let dollarCount = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "$" && (index === 0 || text[index - 1] !== "\\")) {
      dollarCount += 1;
      if (dollarCount >= 2) {
        return true;
      }
    }
  }
  return false;
}

function isTheoremLikeDeclaration(declaration: LeanDeclaration): boolean {
  return declaration.kind === "theorem" || declaration.kind === "lemma";
}

function leanModuleName(name: string): string {
  const parts = name.split(".").filter(Boolean);
  return parts.length > 1 ? parts.slice(0, -1).join(".") : "";
}

function shortLeanName(name: string): string {
  return name.split(".").filter(Boolean).pop() ?? name;
}

function relativeWorkspacePath(uri: string, workspaceRoots: readonly string[]): string {
  const normalizedUri = path.resolve(uri);
  const root = workspaceRoots
    .map((item) => path.resolve(item))
    .filter((item) => normalizedUri === item || normalizedUri.startsWith(item + path.sep))
    .sort((first, second) => second.length - first.length)[0];
  return root ? path.relative(root, normalizedUri) : uri;
}
