import * as path from "node:path";
import { promises as fs } from "node:fs";
import { gzipSync } from "node:zlib";
import {
  buildTheoremExplorerPayload,
  TheoremExplorerPayload
} from "../handwave/explorer";
import { HandwaveIndex, isIndexedLeanDeclaration } from "../handwave/index";
import { parseArticleDocument, parseLeanDocument } from "../handwave/parser";
import {
  renderArticleFragmentHtml,
  renderLeanDeclarationPreviewHtml
} from "../handwave/renderer";
import { ArticleDocument, LeanDeclaration } from "../handwave/types";
import {
  renderTheoremExplorerHtml,
  TheoremExplorerArticleItem
} from "../web/explorer";
import { loadStaticLeanArtifactMetadata } from "./artifacts";
import {
  encodeStaticExplorerPayload,
  HandwaveStaticData
} from "./data";

const excludedDirectoryNames = new Set([
  ".git",
  ".jj",
  ".lake",
  "node_modules",
  "out"
]);

interface StaticArticleSource {
  uri: string;
  text: string;
  document: ArticleDocument;
}

export interface HandwaveStaticSite {
  html: string;
  data: Buffer;
  dataFileName: string;
  singlePage: boolean;
  declarationCount: number;
  theoremCount: number;
  articleCount: number;
}

export interface HandwaveStaticSiteExportResult extends HandwaveStaticSite {
  outputDirectory: string;
  outputFile: string;
  dataFile?: string;
}

export interface HandwaveStaticSiteOptions {
  singlePage?: boolean;
}

const staticDataFileName = "handwave-data.json.gz";

export async function buildHandwaveStaticSite(
  rootDirectory: string,
  options: HandwaveStaticSiteOptions = {}
): Promise<HandwaveStaticSite> {
  const root = path.resolve(rootDirectory);
  const files = await collectWorkspaceFiles(root);
  const parsedDeclarations = await parseLeanFiles(files.filter(isLeanFile));
  const sourceDeclarations = parsedDeclarations.filter(isIndexedLeanDeclaration);
  const artifactMetadata = await loadStaticLeanArtifactMetadata(root, sourceDeclarations);
  const declarations = artifactMetadata.declarations;
  const articleSources = await parseArticleFiles(files.filter(isArticleFile));
  const articles = articleSources.map((article) => article.document);
  const indexedDeclarations = declarations.filter(isIndexedLeanDeclaration);
  const index = new HandwaveIndex(
    root,
    indexedDeclarations,
    articles,
    artifactMetadata.statuses,
    artifactMetadata.dependencyGraph,
    artifactMetadata.definitionTheoremReferenceGraph,
    artifactMetadata.theoremDefinitionReferenceGraph
  );
  const payload = sanitizeStaticPayload(
    buildTheoremExplorerPayload(index, indexedDeclarations, [root])
  );
  const previewHtmlByName = new Map<string, string>();
  const articleHtmlByTarget = new Map<string, string>();
  const articleItems: TheoremExplorerArticleItem[] = [];

  for (const item of [...payload.theorems, ...payload.definitions]) {
    const declaration = index.leanDeclarations.get(item.name);
    if (!declaration) {
      continue;
    }
    previewHtmlByName.set(
      item.name,
      renderLeanDeclarationPreviewHtml(declaration, index, () => "#", () => "#", {
        sourceLinks: false
      })
    );
  }

  for (const article of articleSources) {
    const relativePath = webPath(path.relative(root, article.uri));
    const target = `article:${relativePath}`;
    articleHtmlByTarget.set(
      target,
      renderArticleFragmentHtml(article.text, article.uri, index, () => "#", {
        sourceLinks: false,
        editableTags: false
      })
    );
    articleItems.push({
      target,
      title: article.document.anchors[0]?.title ?? path.basename(relativePath),
      relativePath
    });
  }

  const staticData: HandwaveStaticData = {
    schemaVersion: 1,
    graph: encodeStaticExplorerPayload(payload),
    previews: [...previewHtmlByName],
    articles: [...articleHtmlByTarget],
    articleItems
  };
  const data = gzipSync(Buffer.from(JSON.stringify(staticData), "utf8"), { level: 9 });
  const singlePage = options.singlePage === true;

  return {
    html: renderTheoremExplorerHtml(payload, {
      milestoneControls: false,
      localNavigation: true,
      applicationShell: true,
      ...(singlePage
        ? { staticDataBase64: data.toString("base64") }
        : { staticDataUrl: staticDataFileName })
    }),
    data,
    dataFileName: staticDataFileName,
    singlePage,
    declarationCount: indexedDeclarations.length,
    theoremCount: payload.theoremCount,
    articleCount: articles.length
  };
}

export async function exportHandwaveStaticSite(
  rootDirectory: string,
  outputDirectory: string,
  options: HandwaveStaticSiteOptions = {}
): Promise<HandwaveStaticSiteExportResult> {
  const site = await buildHandwaveStaticSite(rootDirectory, options);
  const resolvedOutputDirectory = path.resolve(outputDirectory);
  const outputFile = path.join(resolvedOutputDirectory, "index.html");
  const dataFile = path.join(resolvedOutputDirectory, site.dataFileName);
  await fs.mkdir(resolvedOutputDirectory, { recursive: true });
  if (site.singlePage) {
    await fs.writeFile(outputFile, site.html, "utf8");
    await removeGeneratedDataFile(dataFile);
    return {
      ...site,
      outputDirectory: resolvedOutputDirectory,
      outputFile
    };
  }
  await Promise.all([
    fs.writeFile(outputFile, site.html, "utf8"),
    fs.writeFile(dataFile, site.data)
  ]);
  return {
    ...site,
    outputDirectory: resolvedOutputDirectory,
    outputFile,
    dataFile
  };
}

async function removeGeneratedDataFile(dataFile: string): Promise<void> {
  try {
    await fs.unlink(dataFile);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
  }
}

async function collectWorkspaceFiles(directory: string): Promise<string[]> {
  const result: string[] = [];
  const entries = await fs.readdir(directory, { withFileTypes: true });
  entries.sort((first, second) => first.name.localeCompare(second.name));

  for (const entry of entries) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!excludedDirectoryNames.has(entry.name)) {
        result.push(...await collectWorkspaceFiles(file));
      }
      continue;
    }
    if (entry.isFile() && (isLeanFile(file) || isArticleFile(file))) {
      result.push(file);
    }
  }

  return result;
}

async function parseLeanFiles(files: readonly string[]): Promise<LeanDeclaration[]> {
  const declarations: LeanDeclaration[] = [];
  for (const file of files) {
    const text = await fs.readFile(file, "utf8");
    declarations.push(...parseLeanDocument(text, file));
  }
  return declarations;
}

async function parseArticleFiles(files: readonly string[]): Promise<StaticArticleSource[]> {
  const articles: StaticArticleSource[] = [];
  for (const file of files) {
    const text = await fs.readFile(file, "utf8");
    articles.push({
      uri: file,
      text,
      document: parseArticleDocument(text, file)
    });
  }
  return articles;
}

function sanitizeStaticPayload(payload: TheoremExplorerPayload): TheoremExplorerPayload {
  return {
    ...payload,
    definitions: payload.definitions.map((definition) => ({
      ...definition,
      uri: webPath(definition.relativePath),
      relativePath: webPath(definition.relativePath),
      references: definition.references.map((reference) => ({
        ...reference,
        target: webPath(reference.target),
        label: webPath(reference.label)
      }))
    })),
    theorems: payload.theorems.map((theorem) => ({
      ...theorem,
      uri: webPath(theorem.relativePath),
      relativePath: webPath(theorem.relativePath),
      references: theorem.references.map((reference) => ({
        ...reference,
        target: webPath(reference.target),
        label: webPath(reference.label)
      }))
    }))
  };
}

function isLeanFile(file: string): boolean {
  return file.endsWith(".lean");
}

function isArticleFile(file: string): boolean {
  return file.endsWith(".hw") || file.endsWith(".hw.md");
}

function webPath(value: string): string {
  return value.replace(/\\/g, "/");
}
