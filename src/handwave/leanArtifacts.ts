import { LeanDeclaration } from "./types";

export const leanArtifactExtractorSchemaVersion = 1;
export const leanArtifactExtractorPrefix = "HANDWAVE_ARTIFACT ";

interface LeanIleanFile {
  version: number;
  module: string;
  references: Record<string, LeanIleanReferenceInfo>;
  decls: Record<string, number[]>;
}

interface LeanIleanReferenceInfo {
  definition?: unknown[] | null;
  usages: unknown[][];
}

export interface LeanIleanArtifact {
  uri: string;
  contents: string;
}

export interface LeanArtifactMetadata {
  declarations: LeanDeclaration[];
  dependencyGraph: Map<string, string[]>;
}

export interface LeanArtifactExtraction {
  name: string;
  axioms: string[];
  typeConstants: string[];
  valueConstants: string[];
}

export interface LeanArtifactCacheEntry extends LeanArtifactExtraction {
  module: string;
  traceFingerprint: string;
}

export interface LeanArtifactCacheFile {
  schemaVersion: number;
  entries: Record<string, LeanArtifactCacheEntry>;
}

export function applyLeanIleanArtifacts(
  declarations: readonly LeanDeclaration[],
  artifacts: readonly LeanIleanArtifact[]
): LeanArtifactMetadata {
  const updated = declarations.map((declaration) => ({ ...declaration }));
  const declarationsByUri = groupBy(updated, (declaration) => declaration.uri);
  const parsedArtifacts: Array<{ uri: string; ilean: LeanIleanFile }> = [];

  for (const artifact of artifacts) {
    const ilean = parseLeanIlean(artifact.contents);
    if (!ilean) {
      continue;
    }
    parsedArtifacts.push({ uri: artifact.uri, ilean });
    const candidates = declarationsByUri.get(artifact.uri) ?? [];
    const unmatched = new Set(candidates);

    for (const [artifactName, positions] of Object.entries(ilean.decls)) {
      if (!Array.isArray(positions) || !positions.every((position) => typeof position === "number")) {
        continue;
      }
      const matched = matchIleanDeclaration(artifactName, positions, candidates, unmatched);
      if (!matched) {
        continue;
      }
      matched.artifactName = artifactName;
      matched.artifactModule = ilean.module;
      unmatched.delete(matched);
    }
  }

  const byArtifactName = new Map<string, LeanDeclaration>();
  for (const declaration of updated) {
    if (declaration.artifactName) {
      byArtifactName.set(declaration.artifactName, declaration);
    }
  }

  const positionedDependencies = new Map<string, Array<{ name: string; line: number; character: number }>>();
  const dependencyGraph = new Map<string, string[]>();
  for (const declaration of updated) {
    if (declaration.artifactName && isTheoremLikeDeclaration(declaration)) {
      // An empty entry is significant: this `.ilean` declaration has no
      // source-level references to another indexed theorem.
      dependencyGraph.set(declaration.name, []);
    }
  }

  for (const { ilean } of parsedArtifacts) {
    for (const [encodedIdent, info] of Object.entries(ilean.references)) {
      if (!info || !Array.isArray(info.usages)) {
        continue;
      }
      const referencedArtifactName = constantNameFromIleanReference(encodedIdent);
      const referenced = referencedArtifactName
        ? byArtifactName.get(referencedArtifactName)
        : undefined;
      if (!referenced || !isTheoremLikeDeclaration(referenced)) {
        continue;
      }

      for (const usage of info.usages ?? []) {
        const parentArtifactName = typeof usage[4] === "string" ? usage[4] : undefined;
        const parent = parentArtifactName ? byArtifactName.get(parentArtifactName) : undefined;
        if (!parent || !isTheoremLikeDeclaration(parent) || parent.name === referenced.name) {
          continue;
        }
        const dependencies = positionedDependencies.get(parent.name) ?? [];
        dependencies.push({
          name: referenced.name,
          line: numericPosition(usage[0]),
          character: numericPosition(usage[1])
        });
        positionedDependencies.set(parent.name, dependencies);
      }
    }
  }

  for (const [parent, dependencies] of positionedDependencies) {
    dependencies.sort((first, second) =>
      first.line - second.line ||
      first.character - second.character ||
      first.name.localeCompare(second.name)
    );
    dependencyGraph.set(parent, unique(dependencies.map((dependency) => dependency.name)));
  }

  return { declarations: updated, dependencyGraph };
}

export function leanArtifactExtractorInput(
  modules: readonly string[],
  artifactNames: readonly string[]
): string | undefined {
  const uniqueModules = unique(modules).sort();
  const uniqueNames = unique(artifactNames).sort();
  if (
    uniqueModules.length === 0 ||
    uniqueNames.length === 0 ||
    uniqueModules.some((moduleName) => !isLeanModuleName(moduleName))
  ) {
    return undefined;
  }

  const names = uniqueNames.map((name) => `${leanStringLiteral(name)}.toName`).join(",\n    ");
  return [
    ...uniqueModules.map((moduleName) => `import ${moduleName}`),
    "import Lean.Util.CollectAxioms",
    "import Lean.Util.FoldConsts",
    "import Lean.Data.Json.FromToJson",
    "",
    "open Lean Lean.Elab Lean.Elab.Command",
    "",
    "private def handwaveNamesJson (names : Array Name) : Json :=",
    "  toJson (names.map (fun name => name.toString))",
    "",
    "private def handwaveEmit (json : Json) : CommandElabM Unit :=",
    `  liftIO <| IO.println (${leanStringLiteral(leanArtifactExtractorPrefix)} ++ json.compress)`,
    "",
    "run_cmd do",
    "  let env ← getEnv",
    "  let names : Array Name := #[",
    `    ${names}`,
    "  ]",
    "  let requestedNames : NameSet := names.foldl (init := {}) fun names name => names.insert name",
    "  let relevantConstants (constants : Array Name) : Array Name :=",
    "    constants.filter fun name => name == ``sorryAx || requestedNames.contains name",
    "  for name in names do",
    "    match env.find? name with",
    "    | none =>",
    "      handwaveEmit <| Json.mkObj [",
    `        ("schemaVersion", toJson ${leanArtifactExtractorSchemaVersion}),`,
    "        (\"name\", toJson name.toString),",
    "        (\"error\", toJson (\"declaration not found\" : String))",
    "      ]",
    "    | some info =>",
    "      let axioms ← Lean.collectAxioms name",
    "      let typeConstants := relevantConstants info.type.getUsedConstants",
    "      let valueConstants := info.value? (allowOpaque := true)",
    "        |>.map (relevantConstants ∘ Expr.getUsedConstants) |>.getD #[]",
    "      handwaveEmit <| Json.mkObj [",
    `        ("schemaVersion", toJson ${leanArtifactExtractorSchemaVersion}),`,
    "        (\"name\", toJson name.toString),",
    "        (\"axioms\", handwaveNamesJson axioms),",
    "        (\"typeConstants\", handwaveNamesJson typeConstants),",
    "        (\"valueConstants\", handwaveNamesJson valueConstants)",
    "      ]",
    "",
    ""
  ].join("\n");
}

export function parseLeanArtifactExtractorOutput(output: string): Map<string, LeanArtifactExtraction> {
  const result = new Map<string, LeanArtifactExtraction>();
  for (const line of output.split(/\r?\n/)) {
    const marker = line.indexOf(leanArtifactExtractorPrefix);
    if (marker < 0) {
      continue;
    }
    try {
      const value: unknown = JSON.parse(line.slice(marker + leanArtifactExtractorPrefix.length));
      if (!isRecord(value) || value.schemaVersion !== leanArtifactExtractorSchemaVersion) {
        continue;
      }
      const name = typeof value.name === "string" ? value.name : undefined;
      const axioms = stringArray(value.axioms);
      const typeConstants = stringArray(value.typeConstants);
      const valueConstants = stringArray(value.valueConstants);
      if (!name || !axioms || !typeConstants || !valueConstants) {
        continue;
      }
      result.set(name, { name, axioms, typeConstants, valueConstants });
    } catch {
      // Ignore ordinary Lean output and malformed extractor records.
    }
  }
  return result;
}

export function parseLeanArtifactCache(contents: string): LeanArtifactCacheFile | undefined {
  try {
    const value: unknown = JSON.parse(contents);
    if (!isRecord(value) || value.schemaVersion !== leanArtifactExtractorSchemaVersion || !isRecord(value.entries)) {
      return undefined;
    }
    const entries: Record<string, LeanArtifactCacheEntry> = {};
    for (const [name, rawEntry] of Object.entries(value.entries)) {
      if (!isRecord(rawEntry)) {
        continue;
      }
      const axioms = stringArray(rawEntry.axioms);
      const typeConstants = stringArray(rawEntry.typeConstants);
      const valueConstants = stringArray(rawEntry.valueConstants);
      if (
        typeof rawEntry.name !== "string" ||
        typeof rawEntry.module !== "string" ||
        typeof rawEntry.traceFingerprint !== "string" ||
        !axioms || !typeConstants || !valueConstants
      ) {
        continue;
      }
      entries[name] = {
        name: rawEntry.name,
        module: rawEntry.module,
        traceFingerprint: rawEntry.traceFingerprint,
        axioms,
        typeConstants,
        valueConstants
      };
    }
    return { schemaVersion: leanArtifactExtractorSchemaVersion, entries };
  } catch {
    return undefined;
  }
}

function parseLeanIlean(contents: string): LeanIleanFile | undefined {
  try {
    const value: unknown = JSON.parse(contents);
    if (
      !isRecord(value) ||
      typeof value.version !== "number" ||
      typeof value.module !== "string" ||
      !isRecord(value.references) ||
      !isRecord(value.decls)
    ) {
      return undefined;
    }
    return value as unknown as LeanIleanFile;
  } catch {
    return undefined;
  }
}

function matchIleanDeclaration(
  artifactName: string,
  positions: number[],
  candidates: readonly LeanDeclaration[],
  unmatched: ReadonlySet<LeanDeclaration>
): LeanDeclaration | undefined {
  const selection = positions.length >= 8 ? positions.slice(4, 8) : undefined;
  if (selection) {
    const exact = candidates.filter((candidate) =>
      unmatched.has(candidate) && rangeMatches(candidate.nameRange, selection)
    );
    if (exact.length === 1) {
      return exact[0];
    }
  }

  const byName = candidates.filter((candidate) =>
    unmatched.has(candidate) &&
    (candidate.sourceName === artifactName || artifactName.endsWith(`.${candidate.sourceName}`))
  );
  return byName.length === 1 ? byName[0] : undefined;
}

function rangeMatches(range: LeanDeclaration["nameRange"], positions: readonly number[]): boolean {
  return positions.length >= 4 &&
    range.start.line === positions[0] &&
    range.start.character === positions[1] &&
    range.end.line === positions[2] &&
    range.end.character === positions[3];
}

function constantNameFromIleanReference(encodedIdent: string): string | undefined {
  try {
    const ident: unknown = JSON.parse(encodedIdent);
    if (!isRecord(ident) || !isRecord(ident.c) || typeof ident.c.n !== "string") {
      return undefined;
    }
    return ident.c.n;
  } catch {
    return undefined;
  }
}

function leanStringLiteral(value: string): string {
  return `"${value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t")}"`;
}

function isLeanModuleName(value: string): boolean {
  return /^[\p{L}_][\p{L}\p{N}\p{M}_']*(?:\.[\p{L}_][\p{L}\p{N}\p{M}_']*)*$/u.test(value);
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numericPosition(value: unknown): number {
  return typeof value === "number" ? value : Number.MAX_SAFE_INTEGER;
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function groupBy<T>(values: readonly T[], key: (value: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const value of values) {
    const groupKey = key(value);
    const group = groups.get(groupKey) ?? [];
    group.push(value);
    groups.set(groupKey, group);
  }
  return groups;
}

function isTheoremLikeDeclaration(declaration: LeanDeclaration): boolean {
  return declaration.kind === "theorem" || declaration.kind === "lemma";
}
