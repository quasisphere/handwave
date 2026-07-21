import { createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import {
  buildTheoremExplorerPayload,
  TheoremExplorerPayload
} from "../handwave/explorer";
import { HandwaveIndex, isIndexedLeanDeclaration } from "../handwave/index";
import { parseArticleDocument, parseLeanDocument, parseTarget } from "../handwave/parser";
import {
  renderArticleFragmentHtml,
  renderLeanDeclarationPreviewHtml
} from "../handwave/renderer";
import {
  applyLeanDeclarationMetadataUpdate,
  applySourceTextEdit,
  LeanDeclarationMetadataUpdate,
  leanDeclarationTagSetEdit
} from "../handwave/tagEditor";
import {
  ArticleDocument,
  LeanDeclaration,
  LeanDeclarationCheckStatus
} from "../handwave/types";
import { loadStaticLeanArtifactMetadata } from "../static/artifacts";
import { TheoremExplorerArticleItem } from "../web/explorer";

const excludedDirectoryNames = new Set([".git", ".jj", ".lake", "node_modules", "out"]);

interface ArticleSource {
  uri: string;
  relativePath: string;
  target: string;
  title: string;
  text: string;
  revision: string;
  document: ArticleDocument;
}

export interface HandwaveServerBootstrap {
  payload: TheoremExplorerPayload;
  articleItems: TheoremExplorerArticleItem[];
}

export interface HandwaveServerArticle {
  target: string;
  title: string;
  source: string;
  revision: string;
  html: string;
  errors: string[];
}

export interface HandwaveServerDeclaration {
  name: string;
  sourceName: string;
  kind: string;
  target: string;
  revision: string;
  fields: {
    name: string;
    statement: string;
    proof: string;
  };
  tags: string[];
}

export class WorkspaceConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceConflictError";
  }
}

export class WorkspaceTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceTargetError";
  }
}

export class HandwaveLiveWorkspace {
  readonly root: string;

  private declarations: LeanDeclaration[] = [];
  private articles: ArticleSource[] = [];
  private statuses = new Map<string, LeanDeclarationCheckStatus>();
  private dependencyGraph = new Map<string, string[]>();
  private declarationFileRevisions = new Map<string, string>();
  private indexValue: HandwaveIndex;
  private payloadValue: TheoremExplorerPayload;

  constructor(rootDirectory: string) {
    this.root = path.resolve(rootDirectory);
    this.indexValue = new HandwaveIndex(this.root, [], []);
    this.payloadValue = buildTheoremExplorerPayload(this.indexValue, [], [this.root]);
  }

  get index(): HandwaveIndex {
    return this.indexValue;
  }

  async initialize(): Promise<void> {
    const files = await collectWorkspaceFiles(this.root);
    const leanFiles = files.filter(isLeanFile);
    const articleFiles = files.filter(isArticleFile);
    const parsedDeclarations: LeanDeclaration[] = [];
    this.declarationFileRevisions.clear();

    for (const file of leanFiles) {
      const text = await fs.readFile(file, "utf8");
      this.declarationFileRevisions.set(file, sourceRevision(text));
      parsedDeclarations.push(...parseLeanDocument(text, file).filter(isIndexedLeanDeclaration));
    }

    const artifactMetadata = await loadStaticLeanArtifactMetadata(this.root, parsedDeclarations);
    this.declarations = artifactMetadata.declarations.filter(isIndexedLeanDeclaration);
    this.statuses = artifactMetadata.statuses;
    this.dependencyGraph = artifactMetadata.dependencyGraph;
    this.articles = [];
    for (const file of articleFiles) {
      this.articles.push(await readArticleSource(this.root, file));
    }
    this.rebuildIndex();
  }

  bootstrap(): HandwaveServerBootstrap {
    return {
      payload: this.payloadValue,
      articleItems: this.articles.map(({ target, title, relativePath }) => ({
        target,
        title,
        relativePath
      }))
    };
  }

  previewHtml(name: string): string | undefined {
    const declaration = this.indexValue.leanDeclarations.get(name);
    if (!declaration) {
      return undefined;
    }
    return renderLeanDeclarationPreviewHtml(declaration, this.indexValue, () => "#", () => "#", {
      sourceLinks: false,
      editableMetadata: true
    });
  }

  article(target: string): HandwaveServerArticle | undefined {
    const article = this.articleSource(target);
    return article ? this.renderArticle(article, target) : undefined;
  }

  declaration(name: string): HandwaveServerDeclaration | undefined {
    const declaration = this.indexValue.leanDeclarations.get(name);
    if (!declaration) {
      return undefined;
    }
    return this.declarationResponse(declaration);
  }

  async saveArticle(
    target: string,
    source: string,
    expectedRevision: string
  ): Promise<HandwaveServerArticle> {
    const article = this.articleSource(target);
    if (!article) {
      throw new WorkspaceTargetError(`Article not found: ${target}`);
    }
    const currentSource = await fs.readFile(article.uri, "utf8");
    if (sourceRevision(currentSource) !== expectedRevision) {
      throw new WorkspaceConflictError(`${article.relativePath} changed after the editor was opened.`);
    }

    await atomicWriteFile(article.uri, source);
    const updated = articleSourceFromText(this.root, article.uri, source);
    this.articles = replaceArticle(this.articles, updated);
    this.rebuildIndex();
    return this.renderArticle(updated, target);
  }

  async saveDeclaration(
    name: string,
    update: LeanDeclarationMetadataUpdate,
    expectedRevision: string
  ): Promise<HandwaveServerDeclaration> {
    const declaration = this.indexValue.leanDeclarations.get(name);
    if (!declaration) {
      throw new WorkspaceTargetError(`Declaration not found: ${name}`);
    }
    const currentSource = await fs.readFile(declaration.uri, "utf8");
    if (sourceRevision(currentSource) !== expectedRevision) {
      throw new WorkspaceConflictError(`${path.relative(this.root, declaration.uri)} changed after the editor was opened.`);
    }
    const updatedSource = applyLeanDeclarationMetadataUpdate(
      currentSource,
      declaration.uri,
      declaration.name,
      update
    );
    if (updatedSource === undefined) {
      throw new WorkspaceTargetError(`Declaration not found after re-reading ${declaration.uri}: ${name}`);
    }

    if (updatedSource !== currentSource) {
      await atomicWriteFile(declaration.uri, updatedSource);
    }
    this.replaceLeanFile(declaration.uri, updatedSource);
    const updatedDeclaration = this.declarations.find((item) =>
      item.uri === declaration.uri && item.sourceName === declaration.sourceName
    );
    if (!updatedDeclaration) {
      throw new WorkspaceTargetError(`Declaration disappeared after editing metadata: ${name}`);
    }
    return this.declarationResponse(updatedDeclaration);
  }

  async setDeclarationTag(name: string, tag: string, active: boolean): Promise<boolean> {
    const declaration = this.indexValue.leanDeclarations.get(name);
    if (!declaration) {
      throw new WorkspaceTargetError(`Declaration not found: ${name}`);
    }
    const currentSource = await fs.readFile(declaration.uri, "utf8");
    const edit = leanDeclarationTagSetEdit(currentSource, declaration.uri, declaration.name, tag, active);
    if (!edit) {
      throw new WorkspaceTargetError(`Could not update ${tag} for ${name}`);
    }
    const updatedSource = applySourceTextEdit(currentSource, edit);
    if (updatedSource !== currentSource) {
      await atomicWriteFile(declaration.uri, updatedSource);
    }
    this.replaceLeanFile(declaration.uri, updatedSource);
    const updated = this.declarations.find((item) =>
      item.uri === declaration.uri && item.sourceName === declaration.sourceName
    );
    return Boolean(updated?.doc?.tags.includes(tag));
  }

  async refreshFile(file: string): Promise<boolean> {
    const resolved = path.resolve(file);
    if (!isWithinRoot(this.root, resolved) || (!isLeanFile(resolved) && !isArticleFile(resolved))) {
      return false;
    }
    try {
      const source = await fs.readFile(resolved, "utf8");
      const revision = sourceRevision(source);
      if (isLeanFile(resolved)) {
        if (this.declarationFileRevisions.get(resolved) === revision) {
          return false;
        }
        this.replaceLeanFile(resolved, source);
        return true;
      }
      const current = this.articles.find((article) => article.uri === resolved);
      if (current?.revision === revision) {
        return false;
      }
      this.articles = replaceArticle(this.articles, articleSourceFromText(this.root, resolved, source));
      this.rebuildIndex();
      return true;
    } catch {
      await this.initialize();
      return true;
    }
  }

  private articleSource(target: string): ArticleSource | undefined {
    const parsed = parseTarget(target);
    if (parsed.kind !== "article") {
      return undefined;
    }
    return this.articles.find((article) => article.target === `article:${parsed.base}`);
  }

  private renderArticle(article: ArticleSource, requestedTarget: string): HandwaveServerArticle {
    const fragment = renderArticleFragmentHtml(article.text, article.uri, this.indexValue, () => "#", {
      sourceLinks: false,
      editableTags: true,
      editableArticles: true,
      editableMetadata: true
    });
    return {
      target: requestedTarget,
      title: article.title,
      source: article.text,
      revision: article.revision,
      html: `<div class="live-article-document" data-article-target="${escapeAttribute(article.target)}">${fragment}</div>`,
      errors: article.document.errors.map((error) => error.message)
    };
  }

  private declarationResponse(declaration: LeanDeclaration): HandwaveServerDeclaration {
    return {
      name: declaration.name,
      sourceName: declaration.sourceName,
      kind: declaration.kind,
      target: `lean:${declaration.name}`,
      revision: this.declarationFileRevisions.get(declaration.uri) ?? "",
      fields: {
        name: declaration.doc?.fields.name ?? "",
        statement: declaration.doc?.fields.statement ?? "",
        proof: declaration.doc?.fields.proof ?? ""
      },
      tags: declaration.doc?.tags ?? []
    };
  }

  private replaceLeanFile(uri: string, source: string): void {
    const previous = this.declarations.filter((declaration) => declaration.uri === uri);
    const parsed = parseLeanDocument(source, uri)
      .filter(isIndexedLeanDeclaration)
      .map((declaration) => {
        const old = previous.find((candidate) => candidate.sourceName === declaration.sourceName);
        return old
          ? {
            ...declaration,
            name: old.isPrivate ? old.name : declaration.name,
            artifactName: old.artifactName,
            artifactModule: old.artifactModule
          }
          : declaration;
      });
    this.declarations = [
      ...this.declarations.filter((declaration) => declaration.uri !== uri),
      ...parsed
    ];
    this.declarationFileRevisions.set(uri, sourceRevision(source));
    this.rebuildIndex();
  }

  private rebuildIndex(): void {
    this.indexValue = new HandwaveIndex(
      this.root,
      this.declarations,
      this.articles.map((article) => article.document),
      this.statuses,
      this.dependencyGraph
    );
    this.payloadValue = sanitizePayload(
      buildTheoremExplorerPayload(this.indexValue, this.declarations, [this.root])
    );
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
    } else if (entry.isFile() && (isLeanFile(file) || isArticleFile(file))) {
      result.push(file);
    }
  }
  return result;
}

async function readArticleSource(root: string, uri: string): Promise<ArticleSource> {
  return articleSourceFromText(root, uri, await fs.readFile(uri, "utf8"));
}

function articleSourceFromText(root: string, uri: string, text: string): ArticleSource {
  const relativePath = webPath(path.relative(root, uri));
  const document = parseArticleDocument(text, uri);
  return {
    uri,
    relativePath,
    target: `article:${relativePath}`,
    title: document.anchors[0]?.title ?? path.basename(relativePath),
    text,
    revision: sourceRevision(text),
    document
  };
}

function replaceArticle(articles: ArticleSource[], updated: ArticleSource): ArticleSource[] {
  return [
    ...articles.filter((article) => article.uri !== updated.uri),
    updated
  ].sort((first, second) => first.relativePath.localeCompare(second.relativePath));
}

function sanitizePayload(payload: TheoremExplorerPayload): TheoremExplorerPayload {
  return {
    ...payload,
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

async function atomicWriteFile(uri: string, source: string): Promise<void> {
  const stat = await fs.stat(uri);
  const temporary = path.join(
    path.dirname(uri),
    `.${path.basename(uri)}.handwave-${process.pid}-${randomBytes(6).toString("hex")}`
  );
  let handle;
  try {
    handle = await fs.open(temporary, "wx", stat.mode);
    await handle.writeFile(source, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(temporary, uri);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await fs.unlink(temporary).catch(() => undefined);
    throw error;
  }
}

function sourceRevision(source: string): string {
  return createHash("sha256").update(source).digest("hex");
}

function isWithinRoot(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
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

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}
