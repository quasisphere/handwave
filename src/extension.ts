import * as vscode from "vscode";
import * as path from "node:path";
import { spawn } from "node:child_process";
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
  LeanDeclarationCheckStatus,
  PositionLike,
  RangeLike
} from "./handwave/types";

export function activate(context: vscode.ExtensionContext): void {
  const controller = new HandwaveController(context);
  context.subscriptions.push(controller);
  void controller.rebuildIndex();

  const startupRebuild = setTimeout(() => void controller.rebuildIndex(), 1000);
  context.subscriptions.push(new vscode.Disposable(() => clearTimeout(startupRebuild)));
}

export function deactivate(): void {
  // VS Code disposes registered subscriptions for us.
}

class HandwaveController
  implements vscode.Disposable, vscode.DocumentLinkProvider, vscode.HoverProvider, vscode.DefinitionProvider, vscode.CodeLensProvider {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly diagnostics = vscode.languages.createDiagnosticCollection("handwave");
  private readonly codeLensEmitter = new vscode.EventEmitter<void>();
  private readonly previewPanels = new Map<string, vscode.WebviewPanel>();
  private readonly leanDiagnosticUrisSeen = new Set<string>();
  private readonly leanDiagnosticUrisRequested = new Set<string>();
  private readonly leanAxiomCheckStatuses = new Map<string, LeanDeclarationCheckStatus>();
  private readonly leanAxiomChecksRequested = new Set<string>();
  private declarations: LeanDeclaration[] = [];
  private articles: ArticleDocument[] = [];
  private index = new HandwaveIndex("", [], []);
  private rebuildTimer: NodeJS.Timeout | undefined;
  private documentUpdateTimer: NodeJS.Timeout | undefined;
  private diagnosticUpdateTimer: NodeJS.Timeout | undefined;
  private isIndexing = false;

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
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (isLeanOrArticle(event.document.uri)) {
          if (isLeanUri(event.document.uri)) {
            this.invalidateLeanAxiomChecks();
          }
          this.scheduleDocumentUpdate(event.document);
        }
      }),
      vscode.workspace.onDidSaveTextDocument((document) => {
        if (isLeanOrArticle(document.uri)) {
          if (isLeanUri(document.uri)) {
            this.invalidateLeanAxiomChecks();
          }
          this.scheduleFullRebuild();
        }
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("handwave")) {
          void this.rebuildIndex();
        }
      }),
      vscode.languages.onDidChangeDiagnostics((event) => {
        const leanUris = event.uris.filter(isLeanUri);
        if (leanUris.length > 0) {
          for (const uri of leanUris) {
            this.leanDiagnosticUrisSeen.add(uri.fsPath);
          }
          this.scheduleLeanStatusRefresh();
        }
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        void this.rebuildIndex();
      })
    );

    for (const pattern of ["**/*.lean", "**/*.hw", "**/*.hw.md"]) {
      const watcher = vscode.workspace.createFileSystemWatcher(pattern);
      this.disposables.push(
        watcher,
        watcher.onDidCreate((uri) => {
          if (isLeanUri(uri)) {
            this.invalidateLeanAxiomChecks();
          }
          this.scheduleFullRebuild();
        }),
        watcher.onDidDelete((uri) => {
          if (isLeanUri(uri)) {
            this.invalidateLeanAxiomChecks();
          }
          this.scheduleFullRebuild();
        }),
        watcher.onDidChange((uri) => {
          if (isLeanUri(uri)) {
            this.invalidateLeanAxiomChecks();
          }
          this.scheduleFullRebuild();
        })
      );
    }
  }

  dispose(): void {
    if (this.rebuildTimer) {
      clearTimeout(this.rebuildTimer);
    }
    if (this.documentUpdateTimer) {
      clearTimeout(this.documentUpdateTimer);
    }
    if (this.diagnosticUpdateTimer) {
      clearTimeout(this.diagnosticUpdateTimer);
    }
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    for (const panel of this.previewPanels.values()) {
      panel.dispose();
    }
  }

  private scheduleFullRebuild(): void {
    if (this.documentUpdateTimer) {
      clearTimeout(this.documentUpdateTimer);
      this.documentUpdateTimer = undefined;
    }
    if (this.rebuildTimer) {
      clearTimeout(this.rebuildTimer);
    }
    this.rebuildTimer = setTimeout(() => {
      this.rebuildTimer = undefined;
      void this.rebuildIndex();
    }, 250);
  }

  private scheduleDocumentUpdate(document: vscode.TextDocument): void {
    if (this.documentUpdateTimer) {
      clearTimeout(this.documentUpdateTimer);
    }
    this.documentUpdateTimer = setTimeout(() => {
      this.documentUpdateTimer = undefined;
      void this.updateIndexedDocument(document);
    }, 500);
  }

  private scheduleLeanStatusRefresh(): void {
    if (this.diagnosticUpdateTimer) {
      clearTimeout(this.diagnosticUpdateTimer);
    }
    this.diagnosticUpdateTimer = setTimeout(() => {
      this.diagnosticUpdateTimer = undefined;
      const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
      if (workspaceFolders.length === 0) {
        return;
      }
      this.rebuildCachedIndex(workspaceFolders);
      void this.refreshArticlePreviews();
    }, 200);
  }

  async rebuildIndex(showNotification = false): Promise<void> {
    const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
    if (workspaceFolders.length === 0) {
      this.isIndexing = false;
      this.declarations = [];
      this.articles = [];
      this.index = new HandwaveIndex("", [], []);
      this.diagnostics.clear();
      return;
    }

    this.isIndexing = true;
    this.invalidateLeanAxiomChecks();
    void this.refreshArticlePreviews();

    const config = vscode.workspace.getConfiguration("handwave");
    const leanGlobs = config.get<string[]>("leanGlobs", ["**/*.lean"]);
    const articleGlobs = config.get<string[]>("articleGlobs", ["**/*.hw.md", "**/*.hw"]);
    const leanUris = await findWorkspaceFiles(leanGlobs, workspaceFolders);
    const articleUris = await findWorkspaceFiles(articleGlobs, workspaceFolders);

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
    this.index = new HandwaveIndex(
      workspaceFolders.map((folder) => folder.uri.fsPath),
      declarations,
      articles,
      this.currentLeanCheckStatuses(declarations)
    );

    if (config.get<boolean>("enableDiagnostics", true)) {
      this.publishDiagnostics(collectDiagnostics(this.index, declarations, articles));
    } else {
      this.diagnostics.clear();
    }

    void this.triggerLeanDiagnosticsForIncludedTheorems(articles);
    this.isIndexing = false;
    this.codeLensEmitter.fire();
    await this.refreshArticlePreviews();

    if (showNotification) {
      void vscode.window.showInformationMessage(
        `Handwave indexed ${declarations.length} Lean declarations and ${articles.length} articles.`
      );
    }
  }

  private async updateIndexedDocument(document: vscode.TextDocument): Promise<void> {
    const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
    if (workspaceFolders.length === 0) {
      return;
    }

    if (isArticleUri(document.uri)) {
      const article = parseArticleDocument(document.getText(), document.uri.fsPath);
      this.articles = replaceByUri(this.articles, article);
      this.rebuildCachedIndex(workspaceFolders);
      this.refreshDiagnostics();
      void this.triggerLeanDiagnosticsForIncludedTheorems([article]);
      this.codeLensEmitter.fire();
      await this.refreshArticlePreview(document.uri);
      return;
    }

    if (isLeanUri(document.uri)) {
      const declarations = parseLeanDocument(document.getText(), document.uri.fsPath);
      this.declarations = [
        ...this.declarations.filter((declaration) => declaration.uri !== document.uri.fsPath),
        ...declarations
      ];
      this.rebuildCachedIndex(workspaceFolders);
      this.refreshDiagnostics();
      void this.triggerLeanDiagnosticsForIncludedTheorems(this.articles);
      this.codeLensEmitter.fire();
      await this.refreshArticlePreviews();
    }
  }

  private invalidateLeanAxiomChecks(): void {
    this.leanAxiomCheckStatuses.clear();
    this.leanAxiomChecksRequested.clear();
  }

  private rebuildCachedIndex(workspaceFolders: readonly vscode.WorkspaceFolder[]): void {
    this.index = new HandwaveIndex(
      workspaceFolders.map((folder) => folder.uri.fsPath),
      this.declarations,
      this.articles,
      this.currentLeanCheckStatuses(this.declarations)
    );
  }

  private currentLeanCheckStatuses(declarations: readonly LeanDeclaration[]): Map<string, LeanDeclarationCheckStatus> {
    const statuses = collectLeanDiagnosticCheckStatuses(declarations, this.leanDiagnosticUrisSeen);
    for (const declaration of declarations) {
      if (
        isTheoremLikeDeclaration(declaration) &&
        this.leanAxiomChecksRequested.has(declaration.name) &&
        !this.leanAxiomCheckStatuses.has(declaration.name)
      ) {
        const diagnosticStatus = statuses.get(declaration.name);
        if (!diagnosticStatus || diagnosticStatus.checked) {
          statuses.delete(declaration.name);
        }
      }
    }
    for (const [name, axiomStatus] of this.leanAxiomCheckStatuses) {
      const diagnosticStatus = statuses.get(name);
      statuses.set(name, mergeLeanCheckStatuses(diagnosticStatus, axiomStatus));
    }
    return statuses;
  }

  private refreshDiagnostics(): void {
    const config = vscode.workspace.getConfiguration("handwave");
    if (config.get<boolean>("enableDiagnostics", true)) {
      this.publishDiagnostics(collectDiagnostics(this.index, this.declarations, this.articles));
    } else {
      this.diagnostics.clear();
    }
  }

  private async triggerLeanDiagnosticsForIncludedTheorems(articles: readonly ArticleDocument[]): Promise<void> {
    const uris = new Map<string, vscode.Uri>();
    const theoremDeclarations = new Map<string, LeanDeclaration>();

    for (const article of articles) {
      for (const include of article.includes) {
        const resolved = this.index.resolve(include.target, article.uri);
        if (!resolved) {
          continue;
        }

        const declaration = this.index.leanDeclarations.get(resolved.title);
        if (!declaration || !isTheoremLikeDeclaration(declaration)) {
          continue;
        }

        theoremDeclarations.set(declaration.name, declaration);
        if (!this.leanDiagnosticUrisRequested.has(declaration.uri)) {
          uris.set(declaration.uri, vscode.Uri.file(declaration.uri));
        }
      }
    }

    void this.triggerLeanAxiomChecks([...theoremDeclarations.values()]);
    this.refreshLeanStatusViews();

    for (const uri of uris.values()) {
      this.leanDiagnosticUrisRequested.add(uri.fsPath);
      try {
        await vscode.workspace.openTextDocument(uri);
      } catch {
        this.leanDiagnosticUrisRequested.delete(uri.fsPath);
      }
    }

  }

  private refreshLeanStatusViews(): void {
    const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
    if (workspaceFolders.length === 0) {
      return;
    }
    this.rebuildCachedIndex(workspaceFolders);
    void this.refreshArticlePreviews();
  }

  private async triggerLeanAxiomChecks(declarations: readonly LeanDeclaration[]): Promise<void> {
    const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
    if (workspaceFolders.length === 0) {
      return;
    }

    const batches = new Map<string, { root: string; moduleName: string; names: string[] }>();
    for (const declaration of declarations) {
      if (this.leanAxiomChecksRequested.has(declaration.name)) {
        continue;
      }

      const target = leanAxiomProbeTarget(declaration.uri, workspaceFolders);
      if (!target) {
        continue;
      }

      this.leanAxiomChecksRequested.add(declaration.name);
      const key = `${target.root}\0${target.moduleName}`;
      const batch = batches.get(key) ?? { ...target, names: [] };
      batch.names.push(declaration.name);
      batches.set(key, batch);
    }

    await Promise.all([...batches.values()].map((batch) => this.runLeanAxiomProbe(batch)));
  }

  private async runLeanAxiomProbe(batch: { root: string; moduleName: string; names: string[] }): Promise<void> {
    const result = await runLakeLeanStdin(
      batch.root,
      [
        `import ${batch.moduleName}`,
        ...batch.names.map((name) => `#print axioms ${name}`),
        ""
      ].join("\n")
    );

    if (!result.ok) {
      for (const name of batch.names) {
        this.leanAxiomCheckStatuses.set(name, {
          checked: false,
          ownChecked: false,
          dependencies: [],
          failedDependencies: [],
          reason: "Lean axiom check failed; dependency status could not be certified."
        });
      }
      this.refreshLeanStatusViews();
      return;
    }

    const axiomsByName = parseLeanAxiomOutput(`${result.stdout}\n${result.stderr}`);
    for (const name of batch.names) {
      const axioms = axiomsByName.get(name);
      if (!axioms) {
        continue;
      }
      const hasSorry = axioms.includes("sorryAx");
      this.leanAxiomCheckStatuses.set(name, {
        checked: !hasSorry,
        ownChecked: true,
        dependencies: axioms,
        failedDependencies: hasSorry ? ["sorryAx"] : [],
        reason: hasSorry
          ? "Lean reports a transitive dependency on sorryAx."
          : "Lean axiom check reports no transitive dependency on sorryAx."
      });
    }

    const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
    if (workspaceFolders.length > 0) {
      this.rebuildCachedIndex(workspaceFolders);
      await this.refreshArticlePreviews();
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
      if (parsedTarget.selector === "statement" || parsedTarget.selector === "proof") {
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
      diagnostic.source = "handwave";
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
    if (!this.isIndexing && this.declarations.length === 0) {
      void this.rebuildIndex();
    }

    const existing = this.previewPanels.get(articleUri.fsPath);
    if (existing) {
      existing.reveal(vscode.ViewColumn.Beside);
      const article = this.articles.find((item) => item.uri === articleUri.fsPath);
      if (article) {
        void this.triggerLeanDiagnosticsForIncludedTheorems([article]);
      }
      await this.renderArticlePreview(articleUri, existing);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      "handwave.articlePreview",
      `Handwave: ${articleUri.path.split("/").pop() ?? "Article"}`,
      vscode.ViewColumn.Beside,
      { enableCommandUris: true, enableScripts: true }
    );

    this.previewPanels.set(articleUri.fsPath, panel);
    panel.onDidDispose(() => this.previewPanels.delete(articleUri.fsPath), undefined, this.disposables);
    const article = this.articles.find((item) => item.uri === articleUri.fsPath);
    if (article) {
      void this.triggerLeanDiagnosticsForIncludedTheorems([article]);
    }
    await this.renderArticlePreview(articleUri, panel);
  }

  private async refreshArticlePreviews(): Promise<void> {
    await Promise.all(
      [...this.previewPanels.entries()].map(([fsPath, panel]) =>
        this.renderArticlePreview(vscode.Uri.file(fsPath), panel)
      )
    );
  }

  private async refreshArticlePreview(articleUri: vscode.Uri): Promise<void> {
    const panel = this.previewPanels.get(articleUri.fsPath);
    if (panel) {
      await this.renderArticlePreview(articleUri, panel);
    }
  }

  private async renderArticlePreview(articleUri: vscode.Uri, panel: vscode.WebviewPanel): Promise<void> {
    try {
      const text = await readWorkspaceText(articleUri);
      panel.webview.html = renderArticleHtml(
        text,
        articleUri.fsPath,
        this.index,
        (target) => commandUriString("handwave.openTarget", target, articleUri.fsPath),
        { indexing: this.isIndexing }
      );
    } catch {
      panel.webview.html = "<!doctype html><html><body><p>Article file is no longer available.</p></body></html>";
    }
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

function collectLeanDiagnosticCheckStatuses(
  declarations: readonly LeanDeclaration[],
  leanDiagnosticUrisSeen: ReadonlySet<string>
): Map<string, LeanDeclarationCheckStatus> {
  const statuses = new Map<string, LeanDeclarationCheckStatus>();
  const diagnosticsByUri = new Map<string, vscode.Diagnostic[]>();

  for (const declaration of declarations) {
    if (!isTheoremLikeDeclaration(declaration)) {
      continue;
    }

    const diagnostics = diagnosticsByUri.get(declaration.uri) ??
      vscode.languages.getDiagnostics(vscode.Uri.file(declaration.uri)).filter((diagnostic) =>
        diagnostic.source !== "handwave"
      );
    diagnosticsByUri.set(declaration.uri, diagnostics);

    if (diagnostics.length === 0 && !leanDiagnosticUrisSeen.has(declaration.uri)) {
      continue;
    }

    const declarationRange = toVsCodeRange(declaration.range);
    const relevant = diagnostics.filter((diagnostic) =>
      rangesOverlap(diagnostic.range, declarationRange) && isLeanCheckDiagnostic(diagnostic)
    );
    const checked = relevant.length === 0;
    statuses.set(declaration.name, {
      checked,
      ownChecked: checked,
      dependencies: [],
      failedDependencies: [],
      reason: checked
        ? "Lean LSP diagnostics report no errors or incomplete proof warnings for this declaration."
        : summarizeLeanDiagnostics(relevant)
    });
  }

  return statuses;
}

function mergeLeanCheckStatuses(
  diagnosticStatus: LeanDeclarationCheckStatus | undefined,
  axiomStatus: LeanDeclarationCheckStatus
): LeanDeclarationCheckStatus {
  if (!diagnosticStatus) {
    return axiomStatus;
  }
  if (!diagnosticStatus.checked) {
    return diagnosticStatus;
  }
  return axiomStatus;
}

function isTheoremLikeDeclaration(declaration: LeanDeclaration): boolean {
  return declaration.kind === "theorem" || declaration.kind === "lemma";
}

function isLeanCheckDiagnostic(diagnostic: vscode.Diagnostic): boolean {
  return diagnostic.severity === vscode.DiagnosticSeverity.Error ||
    isIncompleteProofDiagnostic(diagnostic);
}

function isIncompleteProofDiagnostic(diagnostic: vscode.Diagnostic): boolean {
  if (diagnostic.severity !== vscode.DiagnosticSeverity.Warning) {
    return false;
  }
  return /\b(?:sorry|admit)\b/i.test(diagnostic.message);
}

function summarizeLeanDiagnostics(diagnostics: vscode.Diagnostic[]): string {
  const messages = diagnostics.map((diagnostic) => diagnostic.message.trim()).filter(Boolean);
  if (messages.length === 0) {
    return "Lean LSP diagnostics report that this declaration is unchecked.";
  }
  const [first, ...rest] = messages;
  return rest.length === 0 ? first : `${first} (${rest.length} more)`;
}

function leanAxiomProbeTarget(
  fsPath: string,
  workspaceFolders: readonly vscode.WorkspaceFolder[]
): { root: string; moduleName: string } | undefined {
  const root = workspaceRootForFile(fsPath, workspaceFolders);
  if (!root) {
    return undefined;
  }

  const relative = path.relative(root, fsPath);
  if (relative.startsWith("..") || path.isAbsolute(relative) || !relative.endsWith(".lean")) {
    return undefined;
  }

  const withoutExtension = relative.slice(0, -".lean".length);
  const moduleName = withoutExtension.split(path.sep).filter(Boolean).join(".");
  return moduleName ? { root, moduleName } : undefined;
}

function workspaceRootForFile(
  fsPath: string,
  workspaceFolders: readonly vscode.WorkspaceFolder[]
): string | undefined {
  const normalizedPath = path.resolve(fsPath);
  const roots = workspaceFolders
    .map((folder) => path.resolve(folder.uri.fsPath))
    .filter((root) => normalizedPath === root || normalizedPath.startsWith(root + path.sep))
    .sort((first, second) => second.length - first.length);
  return roots[0];
}

function runLakeLeanStdin(
  cwd: string,
  input: string,
  timeoutMs = 60000
): Promise<{ ok: true; stdout: string; stderr: string } | { ok: false; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("lake", ["env", "lean", "--stdin"], { cwd });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        child.kill();
      }
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, stdout, stderr: stderr || error.message });
    });
    child.on("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(code === 0 ? { ok: true, stdout, stderr } : { ok: false, stdout, stderr });
    });

    child.stdin.end(input);
  });
}

function parseLeanAxiomOutput(output: string): Map<string, string[]> {
  const axiomsByName = new Map<string, string[]>();
  const pattern = /'([^']+)'\s+depends on axioms:\s+\[([^\]]*)\]/g;
  for (const match of output.matchAll(pattern)) {
    axiomsByName.set(
      match[1],
      match[2].split(",").map((axiom) => axiom.trim()).filter(Boolean)
    );
  }
  return axiomsByName;
}

async function findWorkspaceFiles(
  globs: string[],
  workspaceFolders: readonly vscode.WorkspaceFolder[]
): Promise<vscode.Uri[]> {
  const found = new Map<string, vscode.Uri>();
  for (const folder of workspaceFolders) {
    for (const glob of globs) {
      const uris = await vscode.workspace.findFiles(
        new vscode.RelativePattern(folder, glob),
        new vscode.RelativePattern(folder, "**/{node_modules,out,.git,.jj}/**")
      );
      for (const uri of uris) {
        found.set(uri.fsPath, uri);
      }
    }
  }
  return [...found.values()];
}

async function readWorkspaceText(uri: vscode.Uri): Promise<string> {
  const openDocument = vscode.workspace.textDocuments.find((document) =>
    document.uri.scheme === uri.scheme && document.uri.fsPath === uri.fsPath
  );
  if (openDocument) {
    return openDocument.getText();
  }

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

function rangesOverlap(first: vscode.Range, second: vscode.Range): boolean {
  return first.start.isBefore(second.end) && second.start.isBefore(first.end);
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
  return isArticleUri(uri) || isLeanUri(uri);
}

function isArticleUri(uri: vscode.Uri): boolean {
  return uri.fsPath.endsWith(".hw") || uri.fsPath.endsWith(".hw.md");
}

function isLeanUri(uri: vscode.Uri): boolean {
  return uri.fsPath.endsWith(".lean");
}

function replaceByUri<T extends { uri: string }>(items: T[], updated: T): T[] {
  const remaining = items.filter((item) => item.uri !== updated.uri);
  return [...remaining, updated];
}
