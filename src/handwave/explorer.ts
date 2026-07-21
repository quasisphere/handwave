import * as path from "node:path";
import { HandwaveIndex, isIndexedLeanDeclaration } from "./index";
import { renderCheckStatus } from "./renderer";
import { LeanDeclaration, LeanDeclarationCheckStatus } from "./types";

export type TheoremExplorerStatusCategory = "green" | "yellow" | "red" | "unknown";

export interface TheoremExplorerPayload {
  generatedAt: number;
  theoremCount: number;
  milestoneCount: number;
  theorems: TheoremExplorerItem[];
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
  dependents: TheoremExplorerLink[];
  references: TheoremExplorerLink[];
  statusCategory: TheoremExplorerStatusCategory;
  statusHtml: string;
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
  addDependentLinks(theorems);
  const publicTheorems = theorems.filter((item) => !item.isPrivate);

  return {
    generatedAt: Date.now(),
    theoremCount: publicTheorems.length,
    milestoneCount: publicTheorems.filter((item) => item.milestone).length,
    theorems
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
    dependents: [],
    references: articleReferencesForLean(index, declaration.name, workspaceRoots),
    statusCategory: theoremExplorerStatusCategory(status),
    statusHtml: renderCheckStatus(status)
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
  return first.label.localeCompare(second.label) ||
    (first.detail ?? "").localeCompare(second.detail ?? "") ||
    first.target.localeCompare(second.target);
}

function compareTheoremExplorerItems(first: TheoremExplorerItem, second: TheoremExplorerItem): number {
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
