import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import {
  applyLeanIleanArtifacts,
  LeanArtifactExtraction,
  LeanIleanArtifact,
  parseLeanArtifactCache
} from "../handwave/leanArtifacts";
import { HandwaveIndex } from "../handwave/index";
import { collectLeanSourceCheckStatuses } from "../handwave/status";
import { LeanDeclaration, LeanDeclarationCheckStatus } from "../handwave/types";

const leanArtifactCacheRelativePath = path.join(".lake", "handwave", "artifact-index-v1.json");

export interface StaticLeanArtifactMetadata {
  declarations: LeanDeclaration[];
  dependencyGraph: Map<string, string[]>;
  statuses: Map<string, LeanDeclarationCheckStatus>;
}

export async function loadStaticLeanArtifactMetadata(
  root: string,
  declarations: readonly LeanDeclaration[]
): Promise<StaticLeanArtifactMetadata> {
  const artifacts = await loadFreshIleanArtifacts(root, declarations);
  const metadata = applyLeanIleanArtifacts(declarations, artifacts);
  const cache = await readLeanArtifactCache(root);
  const statuses = collectLeanSourceCheckStatuses(metadata.declarations);
  const validExtractions = new Map<string, LeanArtifactExtraction>();
  const fingerprints = new Map<string, string | undefined>();

  for (const declaration of metadata.declarations) {
    if (!isTheoremLikeDeclaration(declaration) || !declaration.artifactName || !declaration.artifactModule) {
      continue;
    }
    const entry = cache?.entries[declaration.artifactName];
    if (!entry || entry.module !== declaration.artifactModule) {
      continue;
    }

    let fingerprint = fingerprints.get(declaration.uri);
    if (!fingerprints.has(declaration.uri)) {
      fingerprint = await leanTraceFingerprint(declaration.uri, root);
      fingerprints.set(declaration.uri, fingerprint);
    }
    if (!fingerprint || entry.traceFingerprint !== fingerprint) {
      continue;
    }

    validExtractions.set(declaration.artifactName, entry);
    if (statuses.has(declaration.name)) {
      continue;
    }
    const hasSorry = entry.axioms.includes("sorryAx");
    const directSorry = entry.valueConstants.includes("sorryAx");
    statuses.set(declaration.name, {
      checked: !hasSorry,
      ownChecked: !directSorry,
      dependencies: entry.axioms,
      failedDependencies: hasSorry ? ["sorryAx"] : [],
      reason: hasSorry
        ? "Lean's cached build artifacts report a transitive dependency on sorryAx."
        : "Lean's cached build artifacts report no transitive dependency on sorryAx."
    });
  }

  mergeArtifactExtractionDependencies(metadata.declarations, metadata.dependencyGraph, validExtractions);
  fillSourceSnapshotStatuses(root, metadata.declarations, metadata.dependencyGraph, statuses);
  return { ...metadata, statuses };
}

function fillSourceSnapshotStatuses(
  root: string,
  declarations: readonly LeanDeclaration[],
  dependencyGraph: ReadonlyMap<string, string[]>,
  statuses: Map<string, LeanDeclarationCheckStatus>
): void {
  const index = new HandwaveIndex(root, [...declarations], [], statuses, dependencyGraph);
  const visiting = new Set<string>();

  const infer = (name: string): LeanDeclarationCheckStatus | undefined => {
    const known = statuses.get(name);
    if (known) {
      return known;
    }
    const declaration = index.leanDeclarations.get(name);
    if (!declaration || !isTheoremLikeDeclaration(declaration) || visiting.has(name)) {
      return undefined;
    }

    visiting.add(name);
    const dependencies = index.dependenciesForLean(name);
    const failedDependencies = dependencies.filter((dependency) => infer(dependency)?.checked === false);
    visiting.delete(name);
    const checked = failedDependencies.length === 0;
    const status: LeanDeclarationCheckStatus = {
      checked,
      ownChecked: true,
      dependencies,
      failedDependencies,
      reason: checked
        ? "Static source analysis found no direct or indexed transitive use of `sorry` or `admit`."
        : `Static source analysis found unchecked indexed dependencies: ${failedDependencies.join(", ")}.`
    };
    statuses.set(name, status);
    return status;
  };

  for (const declaration of declarations) {
    if (isTheoremLikeDeclaration(declaration)) {
      infer(declaration.name);
    }
  }
}

async function loadFreshIleanArtifacts(
  root: string,
  declarations: readonly LeanDeclaration[]
): Promise<LeanIleanArtifact[]> {
  const artifacts: LeanIleanArtifact[] = [];
  const uris = [...new Set(declarations.map((declaration) => declaration.uri))].sort();
  for (const uri of uris) {
    const artifactBase = leanCompiledArtifactBasePath(uri, root);
    if (!artifactBase) {
      continue;
    }
    try {
      const [sourceStat, ileanStat, contents] = await Promise.all([
        fs.stat(uri),
        fs.stat(`${artifactBase}.ilean`),
        fs.readFile(`${artifactBase}.ilean`, "utf8")
      ]);
      if (ileanStat.mtimeMs + 1 >= sourceStat.mtimeMs) {
        artifacts.push({ uri, contents });
      }
    } catch {
      // Missing or stale compiled artifacts leave the source-only graph in use.
    }
  }
  return artifacts;
}

async function readLeanArtifactCache(root: string) {
  try {
    const contents = await fs.readFile(path.join(root, leanArtifactCacheRelativePath), "utf8");
    return parseLeanArtifactCache(contents);
  } catch {
    return undefined;
  }
}

async function leanTraceFingerprint(uri: string, root: string): Promise<string | undefined> {
  const artifactBase = leanCompiledArtifactBasePath(uri, root);
  if (!artifactBase) {
    return undefined;
  }
  try {
    const contents = await fs.readFile(`${artifactBase}.trace`);
    return createHash("sha256").update(contents).digest("hex");
  } catch {
    return undefined;
  }
}

function leanCompiledArtifactBasePath(uri: string, root: string): string | undefined {
  const relative = path.relative(root, uri);
  if (relative.startsWith("..") || path.isAbsolute(relative) || !relative.endsWith(".lean")) {
    return undefined;
  }
  const withoutExtension = relative.slice(0, -".lean".length);
  return withoutExtension
    ? path.join(root, ".lake", "build", "lib", "lean", ...withoutExtension.split(/[\\/]+/))
    : undefined;
}

function mergeArtifactExtractionDependencies(
  declarations: readonly LeanDeclaration[],
  dependencyGraph: Map<string, string[]>,
  extractions: ReadonlyMap<string, LeanArtifactExtraction>
): void {
  const byArtifactName = new Map<string, LeanDeclaration>();
  for (const declaration of declarations) {
    if (declaration.artifactName && isTheoremLikeDeclaration(declaration)) {
      byArtifactName.set(declaration.artifactName, declaration);
    }
  }

  for (const [artifactName, extraction] of extractions) {
    const declaration = byArtifactName.get(artifactName);
    if (!declaration) {
      continue;
    }
    const dependencies = new Set(dependencyGraph.get(declaration.name) ?? []);
    for (const constant of [...extraction.typeConstants, ...extraction.valueConstants]) {
      const dependency = byArtifactName.get(constant);
      if (dependency && dependency.name !== declaration.name) {
        dependencies.add(dependency.name);
      }
    }
    dependencyGraph.set(declaration.name, [...dependencies]);
  }
}

function isTheoremLikeDeclaration(declaration: LeanDeclaration): boolean {
  return declaration.kind === "theorem" || declaration.kind === "lemma";
}
