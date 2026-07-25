import {
  DefinitionExplorerItem,
  TheoremExplorerItem,
  TheoremExplorerLink,
  TheoremExplorerPayload,
  TheoremExplorerStatusCategory
} from "../handwave/explorer";
import { TheoremExplorerArticleItem } from "../web/explorer";

const privateFlag = 1;
const milestoneFlag = 2;
const displayNameHasMathFlag = 4;
const statusCategories: readonly TheoremExplorerStatusCategory[] = [
  "green",
  "yellow",
  "red",
  "unknown"
];

type CompactDependency = number | string;
type CompactLeanLink = number | [target: string, label: string, detail: string, proofOnly: 0 | 1];
type CompactExternalLink = [target: string, label: string, detail: string, proofOnly: 0 | 1];

type CompactTheorem = [
  sourceName: string,
  displayName: string,
  relativePath: string,
  flags: number,
  tags: string[] | 0,
  statusCategory: number,
  statusHtml: number,
  dependencies: CompactDependency[],
  definitions: CompactLeanLink[],
  dependents: CompactLeanLink[],
  referencingDefinitions: CompactLeanLink[],
  references: CompactExternalLink[]
];

type CompactDefinition = [
  sourceName: string,
  displayName: string,
  relativePath: string,
  flags: number,
  definitions: CompactLeanLink[],
  theorems: CompactLeanLink[],
  referencingDefinitions: CompactLeanLink[],
  referencingTheorems: CompactLeanLink[],
  references: CompactExternalLink[]
];

export interface CompactTheoremExplorerPayload {
  schemaVersion: 1;
  generatedAt: number;
  counts: [theorems: number, definitions: number, milestones: number];
  names: string[];
  statusHtml: string[];
  theoremItems: CompactTheorem[];
  definitionItems: CompactDefinition[];
}

export interface HandwaveStaticData {
  schemaVersion: 1;
  graph: CompactTheoremExplorerPayload;
  previews: Array<[name: string, html: string]>;
  articles: Array<[target: string, html: string]>;
  articleItems: TheoremExplorerArticleItem[];
}

export function encodeStaticExplorerPayload(
  payload: TheoremExplorerPayload
): CompactTheoremExplorerPayload {
  const declarations = [...payload.theorems, ...payload.definitions];
  const names = declarations.map((declaration) => declaration.name);
  const ids = new Map(names.map((name, index) => [name, index + 1]));
  const statusHtml = [...new Set(payload.theorems.map((theorem) => theorem.statusHtml))];
  const statusIds = new Map(statusHtml.map((html, index) => [html, index]));

  return {
    schemaVersion: 1,
    generatedAt: payload.generatedAt,
    counts: [payload.theoremCount, payload.definitionCount, payload.milestoneCount],
    names,
    statusHtml,
    theoremItems: payload.theorems.map((theorem) => [
      theorem.sourceName === theorem.name ? "" : theorem.sourceName,
      theorem.displayName,
      theorem.relativePath,
      declarationFlags(theorem),
      theorem.tags.length > 0 ? theorem.tags : 0,
      statusCategories.indexOf(theorem.statusCategory),
      statusIds.get(theorem.statusHtml) ?? 0,
      theorem.dependencies.map((dependency) => ids.get(dependency) ?? dependency),
      theorem.definitions.map((link) => encodeLeanLink(link, ids)),
      theorem.dependents.map((link) => encodeLeanLink(link, ids)),
      theorem.referencingDefinitions.map((link) => encodeLeanLink(link, ids)),
      theorem.references.map(encodeExternalLink)
    ]),
    definitionItems: payload.definitions.map((definition) => [
      definition.sourceName === definition.name ? "" : definition.sourceName,
      definition.displayName,
      definition.relativePath,
      declarationFlags(definition),
      definition.definitions.map((link) => encodeLeanLink(link, ids)),
      definition.theorems.map((link) => encodeLeanLink(link, ids)),
      definition.referencingDefinitions.map((link) => encodeLeanLink(link, ids)),
      definition.referencingTheorems.map((link) => encodeLeanLink(link, ids)),
      definition.references.map(encodeExternalLink)
    ])
  };
}

export function decodeStaticExplorerPayload(
  compact: CompactTheoremExplorerPayload
): TheoremExplorerPayload {
  if (compact.schemaVersion !== 1) {
    throw new Error(`Unsupported Handwave graph schema: ${String(compact.schemaVersion)}`);
  }

  const theoremCount = compact.theoremItems.length;
  const declarations: Array<TheoremExplorerItem | DefinitionExplorerItem> = [];
  const theorems = compact.theoremItems.map((item, index): TheoremExplorerItem => {
    const name = compact.names[index] ?? "";
    const sourceName = item[0] || name;
    const relativePath = item[2];
    const theorem: TheoremExplorerItem = {
      name,
      sourceName,
      shortName: shortLeanName(sourceName),
      displayName: item[1],
      displayNameHasMath: Boolean(item[3] & displayNameHasMathFlag),
      moduleName: leanModuleName(sourceName),
      uri: relativePath,
      relativePath,
      target: `lean:${name}`,
      tags: item[4] === 0 ? [] : item[4],
      milestone: Boolean(item[3] & milestoneFlag),
      isPrivate: Boolean(item[3] & privateFlag),
      dependencies: [],
      definitions: [],
      dependents: [],
      referencingDefinitions: [],
      references: [],
      statusCategory: statusCategories[item[5]] ?? "unknown",
      statusHtml: compact.statusHtml[item[6]] ?? ""
    };
    declarations.push(theorem);
    return theorem;
  });
  const definitions = compact.definitionItems.map((item, index): DefinitionExplorerItem => {
    const name = compact.names[theoremCount + index] ?? "";
    const sourceName = item[0] || name;
    const relativePath = item[2];
    const definition: DefinitionExplorerItem = {
      name,
      sourceName,
      shortName: shortLeanName(sourceName),
      displayName: item[1],
      displayNameHasMath: Boolean(item[3] & displayNameHasMathFlag),
      moduleName: leanModuleName(sourceName),
      uri: relativePath,
      relativePath,
      target: `lean:${name}`,
      isPrivate: Boolean(item[3] & privateFlag),
      definitions: [],
      theorems: [],
      referencingDefinitions: [],
      referencingTheorems: [],
      references: []
    };
    declarations.push(definition);
    return definition;
  });

  for (const [index, item] of compact.theoremItems.entries()) {
    const theorem = theorems[index];
    if (!theorem) {
      continue;
    }
    theorem.dependencies = item[7].map((dependency) =>
      typeof dependency === "number"
        ? declarations[dependency - 1]?.name ?? ""
        : dependency
    ).filter(Boolean);
    theorem.definitions = item[8].map((link) => decodeLeanLink(link, declarations, "source"));
    theorem.dependents = item[9].map((link) => decodeLeanLink(link, declarations, "module"));
    theorem.referencingDefinitions =
      item[10].map((link) => decodeLeanLink(link, declarations, "module"));
    theorem.references = item[11].map(decodeExternalLink);
  }
  for (const [index, item] of compact.definitionItems.entries()) {
    const definition = definitions[index];
    if (!definition) {
      continue;
    }
    definition.definitions = item[4].map((link) => decodeLeanLink(link, declarations, "source"));
    definition.theorems = item[5].map((link) => decodeLeanLink(link, declarations, "source"));
    definition.referencingDefinitions =
      item[6].map((link) => decodeLeanLink(link, declarations, "module"));
    definition.referencingTheorems =
      item[7].map((link) => decodeLeanLink(link, declarations, "module"));
    definition.references = item[8].map(decodeExternalLink);
  }

  return {
    generatedAt: compact.generatedAt,
    theoremCount: compact.counts[0],
    definitionCount: compact.counts[1],
    milestoneCount: compact.counts[2],
    theorems,
    definitions
  };
}

function declarationFlags(declaration: TheoremExplorerItem | DefinitionExplorerItem): number {
  return (declaration.isPrivate ? privateFlag : 0) |
    ("milestone" in declaration && declaration.milestone ? milestoneFlag : 0) |
    (declaration.displayNameHasMath ? displayNameHasMathFlag : 0);
}

function encodeLeanLink(
  link: TheoremExplorerLink,
  ids: ReadonlyMap<string, number>
): CompactLeanLink {
  const name = link.target.startsWith("lean:") ? link.target.slice("lean:".length) : "";
  const id = ids.get(name);
  if (id !== undefined) {
    return link.proofOnly ? -id : id;
  }
  return [link.target, link.label, link.detail ?? "", link.proofOnly ? 1 : 0];
}

function decodeLeanLink(
  compact: CompactLeanLink,
  declarations: readonly (TheoremExplorerItem | DefinitionExplorerItem)[],
  detailKind: "source" | "module"
): TheoremExplorerLink {
  if (typeof compact !== "number") {
    return decodeExternalLink(compact);
  }
  const declaration = declarations[Math.abs(compact) - 1];
  if (!declaration) {
    return { target: "", label: "", proofOnly: compact < 0 };
  }
  return {
    target: declaration.target,
    label: declaration.displayName,
    detail: detailKind === "source"
      ? declaration.sourceName
      : declaration.moduleName || declaration.relativePath,
    ...(compact < 0 ? { proofOnly: true } : {})
  };
}

function encodeExternalLink(link: TheoremExplorerLink): CompactExternalLink {
  return [link.target, link.label, link.detail ?? "", link.proofOnly ? 1 : 0];
}

function decodeExternalLink(compact: CompactExternalLink): TheoremExplorerLink {
  return {
    target: compact[0],
    label: compact[1],
    ...(compact[2] ? { detail: compact[2] } : {}),
    ...(compact[3] ? { proofOnly: true } : {})
  };
}

function leanModuleName(name: string): string {
  const parts = name.split(".").filter(Boolean);
  return parts.length > 1 ? parts.slice(0, -1).join(".") : "";
}

function shortLeanName(name: string): string {
  return name.split(".").filter(Boolean).pop() ?? name;
}
