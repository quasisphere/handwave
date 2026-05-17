import * as vscode from "vscode";
import { collectDiagnostics, DiagnosticIssue } from "./handwave/diagnostics";
import { HandwaveIndex } from "./handwave/index";
import { containsPosition } from "./handwave/position";
import { parseArticleDocument, parseLeanDocument, parseTarget } from "./handwave/parser";
import { renderArticleHtml } from "./handwave/renderer";
import {
  ArticleDocument,
  ArticleInclude,
  ArticleLink,
  Backlink,
  LeanDeclaration,
  PositionLike,
  RangeLike
} from "./handwave/types";

export function activate(context: vscode.ExtensionContext): void {
  const controller = new HandwaveController(context);
  context.subscriptions.push(controller);
  void controller.rebuildIndex();
}

export function deactivate(): void {
  // VS Code disposes registered subscriptions for us.
}

class HandwaveController
  implements vscode.Disposable, vscode.DocumentLinkProvider, vscode.HoverProvider, vscode.DefinitionProvider, vscode.CodeLensProvider {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly diagnostics = vscode.languages.createDiagnosticCollection("handwave");
  private readonly codeLensEmitter = new vscode.EventEmitter<void>();
  private declarations: LeanDeclaration[] = [];
  private articles: ArticleDocument[] = [];
  private index = new HandwaveIndex("", [], []);

  readonly onDidChangeCodeLenses = this.codeLensEmitter.event;

  constructor(private readonly context: vscode.ExtensionContext) {
    const articleSelector: vscode.DocumentSelector = [
      { scheme: "file", language: "handwave-article" },
      { scheme: "file", pattern: "**/*.hw.md" },
      { scheme: "file", pattern: "**/*.hw" }
    ];
    const leanSelector: vscode.DocumentSelector = [
      { scheme: "file", language: "lean4" },
      { scheme: "file", language: "lean" },
      { scheme: "file", pattern: "**/*.lean" }
    ];
    const allSelector: vscode.DocumentSelector = [...articleSelector, ...leanSelector];

    this.disposables.push(
      this.diagnostics,
      this.codeLensEmitter,
      vscode.languages.registerDocumentLinkProvider(articleSelector, this),
      vscode.languages.registerHoverProvider(allSelector, this),
      vscode.languages.registerDefinitionProvider(articleSelector, this),
      vscode.languages.registerCodeLensProvider(leanSelector, this),
      vscode.commands.registerCommand("handwave.rebuildIndex", () => this.rebuildIndex(true)),
      vscode.commands.registerCommand("handwave.openArticlePreview", (uri?: vscode.Uri) => this.openArticlePreview(uri)),
      vscode.commands.registerCommand("handwave.showBacklinks", () => this.showBacklinks()),
      vscode.commands.registerCommand("handwave.showBacklinksForTarget", (target: string) => this.showBacklinks(target)),
      vscode.commands.registerCommand("handwave.openTarget", (target: string, fromUri?: string) => this.openTarget(target, fromUri)),
      vscode.workspace.onDidSaveTextDocument((document) => {
        if (isLeanOrArticle(document.uri)) {
          void this.rebuildIndex();
        }
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("handwave")) {
          void this.rebuildIndex();
        }
      })
    );

    for (const pattern of ["**/*.lean", "**/*.hw", "**/*.hw.md"]) {
      const watcher = vscode.workspace.createFileSystemWatcher(pattern);
      this.disposables.push(
        watcher,
        watcher.onDidCreate(() => void this.rebuildIndex()),
        watcher.onDidDelete(() => void this.rebuildIndex()),
        watcher.onDidChange(() => void this.rebuildIndex())
      );
    }
  }

  dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }

  async rebuildIndex(showNotification = false): Promise<void> {
    const workspace = vscode.workspace.workspaceFolders?.[0];
    if (!workspace) {
      this.declarations = [];
      this.articles = [];
      this.index = new HandwaveIndex("", [], []);
      this.diagnostics.clear();
      return;
    }

    const config = vscode.workspace.getConfiguration("handwave");
    const leanGlobs = config.get<string[]>("leanGlobs", ["**/*.lean"]);
    const articleGlobs = config.get<string[]>("articleGlobs", ["**/*.hw.md", "**/*.hw"]);
    const leanUris = await findWorkspaceFiles(leanGlobs);
    const articleUris = await findWorkspaceFiles(articleGlobs);

    const declarations: LeanDeclaration[] = [];
    for (const uri of leanUris) {
      const text = await readWorkspaceText(uri);
      declarations.push(...parseLeanDocument(text, uri.fsPath));
    }

    const articles: ArticleDocument[] = [];
    for (const uri of articleUris) {
      const text = await readWorkspaceText(uri);
      articles.push(parseArticleDocument(text, uri.fsPath));
    }

    this.declarations = declarations;
    this.articles = articles;
    this.index = new HandwaveIndex(workspace.uri.fsPath, declarations, articles);

    if (config.get<boolean>("enableDiagnostics", true)) {
      this.publishDiagnostics(collectDiagnostics(this.index, declarations, articles));
    } else {
      this.diagnostics.clear();
    }

    this.codeLensEmitter.fire();

    if (showNotification) {
      void vscode.window.showInformationMessage(
        `Handwave indexed ${declarations.length} Lean declarations and ${articles.length} articles.`
      );
    }
  }

  provideDocumentLinks(document: vscode.TextDocument): vscode.DocumentLink[] {
    const article = parseArticleDocument(document.getText(), document.uri.fsPath);
    return [...article.links, ...article.includes].map((ref) => {
      const target = ref.target;
      const link = new vscode.DocumentLink(
        toVsCodeRange(ref.targetRange),
        commandUri("handwave.openTarget", target, document.uri.fsPath)
      );
      link.tooltip = `Open ${target}`;
      return link;
    });
  }

  provideHover(document: vscode.TextDocument, position: vscode.Position): vscode.Hover | undefined {
    const pos = fromVsCodePosition(position);
    if (isArticleUri(document.uri)) {
      const ref = this.referenceAt(document, pos);
      if (!ref) {
        return undefined;
      }

      const resolved = this.index.resolve(ref.target, document.uri.fsPath);
      if (!resolved) {
        return new vscode.Hover(`Unresolved Handwave target: \`${ref.target}\``);
      }

      const markdown = new vscode.MarkdownString();
      markdown.appendMarkdown(`**${resolved.title}**\n\n`);
      const parsedTarget = parseTarget(ref.target);
      if (parsedTarget.selector === "statement" || parsedTarget.selector === "proof.sketch") {
        markdown.appendMarkdown(resolved.preview);
      } else {
        markdown.appendCodeblock(resolved.preview, "lean");
      }
      return new vscode.Hover(markdown);
    }

    const declaration = this.declarationAt(document.uri.fsPath, pos);
    if (!declaration) {
      return undefined;
    }

    const markdown = new vscode.MarkdownString();
    markdown.appendMarkdown(`**${declaration.name}**\n\n`);
    markdown.appendCodeblock(declaration.statement, "lean");
    if (declaration.doc?.fields.statement) {
      markdown.appendMarkdown(`\n${declaration.doc.fields.statement}`);
    }
    return new vscode.Hover(markdown);
  }

  provideDefinition(document: vscode.TextDocument, position: vscode.Position): vscode.Definition | undefined {
    const ref = this.referenceAt(document, fromVsCodePosition(position));
    if (!ref) {
      return undefined;
    }

    const resolved = this.index.resolve(ref.target, document.uri.fsPath);
    if (!resolved) {
      return undefined;
    }

    return new vscode.Location(vscode.Uri.file(resolved.uri), toVsCodeRange(resolved.range));
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    return this.declarations
      .filter((declaration) => declaration.uri === document.uri.fsPath)
      .flatMap((declaration) => {
        const count = this.index.backlinkCountForLean(declaration.name);
        if (count === 0) {
          return [];
        }
        const title = count === 1 ? "1 Handwave citation" : `${count} Handwave citations`;
        return [
          new vscode.CodeLens(toVsCodeRange(declaration.nameRange), {
            title,
            command: "handwave.showBacklinksForTarget",
            arguments: [`lean:${declaration.name}`]
          })
        ];
      });
  }

  private publishDiagnostics(issues: DiagnosticIssue[]): void {
    const grouped = new Map<string, vscode.Diagnostic[]>();
    for (const issue of issues) {
      const diagnostic = new vscode.Diagnostic(
        toVsCodeRange(issue.range),
        issue.message,
        issue.severity === "error" ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning
      );
      grouped.set(issue.uri, [...(grouped.get(issue.uri) ?? []), diagnostic]);
    }

    this.diagnostics.clear();
    for (const [uri, diagnostics] of grouped) {
      this.diagnostics.set(vscode.Uri.file(uri), diagnostics);
    }
  }

  private async openArticlePreview(uri?: vscode.Uri): Promise<void> {
    const articleUri = uri ?? await this.pickArticleUri();
    if (!articleUri) {
      return;
    }

    const text = await readWorkspaceText(articleUri);
    const panel = vscode.window.createWebviewPanel(
      "handwave.articlePreview",
      `Handwave: ${articleUri.path.split("/").pop() ?? "Article"}`,
      vscode.ViewColumn.Beside,
      { enableCommandUris: true, enableScripts: true }
    );

    panel.webview.html = renderArticleHtml(text, articleUri.fsPath, this.index, (target) =>
      commandUriString("handwave.openTarget", target, articleUri.fsPath)
    );
  }

  private async showBacklinks(rawTarget?: string): Promise<void> {
    const target = rawTarget ?? await this.pickTarget();
    if (!target) {
      return;
    }

    const backlinks = this.index.backlinksFor(target);
    if (backlinks.length === 0) {
      void vscode.window.showInformationMessage(`No Handwave backlinks for ${target}.`);
      return;
    }

    const picked = await vscode.window.showQuickPick(
      backlinks.map((backlink) => ({
        label: backlink.label,
        description: vscode.workspace.asRelativePath(backlink.fromUri),
        backlink
      })),
      { placeHolder: `Backlinks for ${target}` }
    );

    if (picked) {
      await this.openBacklink(picked.backlink);
    }
  }

  private async openTarget(target: string, fromUri?: string): Promise<void> {
    const resolved = this.index.resolve(target, fromUri);
    if (!resolved) {
      void vscode.window.showWarningMessage(`Handwave target not found: ${target}`);
      return;
    }

    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(resolved.uri));
    await vscode.window.showTextDocument(document, { selection: toVsCodeRange(resolved.range), preview: true });
  }

  private async openBacklink(backlink: Backlink): Promise<void> {
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(backlink.fromUri));
    await vscode.window.showTextDocument(document, { selection: toVsCodeRange(backlink.range), preview: true });
  }

  private async pickArticleUri(): Promise<vscode.Uri | undefined> {
    const items = this.articles.map((article) => ({
      label: vscode.workspace.asRelativePath(article.uri),
      uri: vscode.Uri.file(article.uri)
    }));
    const activeUri = vscode.window.activeTextEditor?.document.uri;
    if (activeUri && isArticleUri(activeUri)) {
      return activeUri;
    }

    return (await vscode.window.showQuickPick(items, { placeHolder: "Choose a Handwave article" }))?.uri;
  }

  private async pickTarget(): Promise<string | undefined> {
    const activeEditor = vscode.window.activeTextEditor;
    if (activeEditor) {
      const ref = this.referenceAt(activeEditor.document, fromVsCodePosition(activeEditor.selection.active));
      if (ref) {
        return ref.target;
      }
      const declaration = this.declarationAt(activeEditor.document.uri.fsPath, fromVsCodePosition(activeEditor.selection.active));
      if (declaration) {
        return `lean:${declaration.name}`;
      }
    }

    const items = this.declarations.map((declaration) => ({
      label: `lean:${declaration.name}`,
      description: declaration.uri
    }));
    return (await vscode.window.showQuickPick(items, { placeHolder: "Choose a Handwave target" }))?.label;
  }

  private referenceAt(document: vscode.TextDocument, position: PositionLike): (ArticleLink | ArticleInclude) | undefined {
    if (!isArticleUri(document.uri)) {
      return undefined;
    }

    const article = parseArticleDocument(document.getText(), document.uri.fsPath);
    return [...article.links, ...article.includes].find((ref) => containsPosition(ref.targetRange, position));
  }

  private declarationAt(uri: string, position: PositionLike): LeanDeclaration | undefined {
    return this.declarations.find((declaration) => declaration.uri === uri && containsPosition(declaration.nameRange, position));
  }
}

async function findWorkspaceFiles(globs: string[]): Promise<vscode.Uri[]> {
  const found = new Map<string, vscode.Uri>();
  for (const glob of globs) {
    const uris = await vscode.workspace.findFiles(glob, "**/{node_modules,out,.git,.jj}/**");
    for (const uri of uris) {
      found.set(uri.fsPath, uri);
    }
  }
  return [...found.values()];
}

async function readWorkspaceText(uri: vscode.Uri): Promise<string> {
  const bytes = await vscode.workspace.fs.readFile(uri);
  return Buffer.from(bytes).toString("utf8");
}

function toVsCodeRange(range: RangeLike): vscode.Range {
  return new vscode.Range(
    range.start.line,
    range.start.character,
    range.end.line,
    range.end.character
  );
}

function fromVsCodePosition(position: vscode.Position): PositionLike {
  return {
    line: position.line,
    character: position.character
  };
}

function commandUri(command: string, ...args: unknown[]): vscode.Uri {
  return vscode.Uri.parse(commandUriString(command, ...args));
}

function commandUriString(command: string, ...args: unknown[]): string {
  return `command:${command}?${encodeURIComponent(JSON.stringify(args))}`;
}

function isLeanOrArticle(uri: vscode.Uri): boolean {
  return isArticleUri(uri) || uri.fsPath.endsWith(".lean");
}

function isArticleUri(uri: vscode.Uri): boolean {
  return uri.fsPath.endsWith(".hw") || uri.fsPath.endsWith(".hw.md");
}
