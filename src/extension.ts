import * as vscode from "vscode";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { collectDiagnostics, DiagnosticIssue } from "./handwave/diagnostics";
import { HandwaveIndex } from "./handwave/index";
import { containsPosition } from "./handwave/position";
import { blankLeanCommentsAndStrings, parseArticleDocument, parseLeanDocument, parseTarget } from "./handwave/parser";
import { leanDeclarationAnchorId, renderArticleHtml, renderLeanDocumentHtml } from "./handwave/renderer";
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

interface HandwavePreviewState {
  key: string;
  panel: vscode.WebviewPanel;
  uri: vscode.Uri;
  focusId?: string;
  target?: string;
  history: PreviewHistoryEntry[];
  historyIndex: number;
}

interface PreviewHistoryEntry {
  uri: string;
  focusId?: string;
  target?: string;
}

interface LeanAxiomCheckRequest {
  declaration: LeanDeclaration;
  generation: number;
}

interface LeanAxiomCheckJob {
  key: string;
  label: string;
  requests: LeanAxiomCheckRequest[];
}

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
  private readonly leanProcessStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  private readonly previewPanels = new Map<string, HandwavePreviewState>();
  private readonly leanDiagnosticUrisSeen = new Set<string>();
  private readonly leanDiagnosticUrisRequested = new Set<string>();
  private readonly leanAxiomCheckStatuses = new Map<string, LeanDeclarationCheckStatus>();
  private readonly leanAxiomChecksRequested = new Set<string>();
  private readonly leanAxiomCheckQueue = new Map<string, LeanAxiomCheckJob>();
  private declarations: LeanDeclaration[] = [];
  private articles: ArticleDocument[] = [];
  private index = new HandwaveIndex("", [], []);
  private rebuildTimer: NodeJS.Timeout | undefined;
  private documentUpdateTimer: NodeJS.Timeout | undefined;
  private diagnosticUpdateTimer: NodeJS.Timeout | undefined;
  private axiomCheckTimer: NodeJS.Timeout | undefined;
  private leanProcessStatusTimer: NodeJS.Timeout | undefined;
  private leanProcessStartedAt: number | undefined;
  private leanProcessStatusLabel: string | undefined;
  private leanProcessTimeoutMs: number | undefined;
  private isIndexing = false;
  private isFlushingAxiomChecks = false;
  private leanAxiomCheckGeneration = 0;
  private nextPreviewKey = 1;

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
      this.leanProcessStatusBar,
      vscode.languages.registerDocumentLinkProvider(articleSelector, this),
      vscode.languages.registerHoverProvider(allSelector, this),
      vscode.languages.registerDefinitionProvider(articleSelector, this),
      vscode.languages.registerCodeLensProvider(leanSelector, this),
      vscode.commands.registerCommand("handwave.rebuildIndex", () => {
        this.invalidateLeanAxiomChecks();
        return this.rebuildIndex(true);
      }),
      vscode.commands.registerCommand("handwave.openArticlePreview", (uri?: vscode.Uri) => this.openArticlePreview(uri)),
      vscode.commands.registerCommand("handwave.previewBack", () => this.navigatePreviewHistory(-1)),
      vscode.commands.registerCommand("handwave.previewForward", () => this.navigatePreviewHistory(1)),
      vscode.commands.registerCommand("handwave.showBacklinks", () => this.showBacklinks()),
      vscode.commands.registerCommand("handwave.showBacklinksForTarget", (target: string) => this.showBacklinks(target)),
      vscode.commands.registerCommand("handwave.openPreviewTarget", (target: string, fromUri?: string, previewKey?: string) =>
        this.openPreviewTarget(target, fromUri, previewKey)
      ),
      vscode.commands.registerCommand("handwave.openTarget", (target: string, fromUri?: string) => this.openTarget(target, fromUri)),
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (isLeanOrArticle(event.document.uri)) {
          if (isLeanUri(event.document.uri)) {
            this.invalidateLeanAxiomChecksAfterLeanChange();
          }
          this.scheduleDocumentUpdate(event.document);
        }
      }),
      vscode.workspace.onDidSaveTextDocument((document) => {
        if (isLeanOrArticle(document.uri)) {
          if (isLeanUri(document.uri)) {
            this.invalidateLeanAxiomChecksAfterLeanChange();
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
        this.invalidateLeanAxiomChecks();
        void this.rebuildIndex();
      })
    );

    for (const pattern of ["**/*.lean", "**/*.hw", "**/*.hw.md"]) {
      const watcher = vscode.workspace.createFileSystemWatcher(pattern);
      this.disposables.push(
        watcher,
        watcher.onDidCreate((uri) => {
          if (isLeanUri(uri)) {
            this.invalidateLeanAxiomChecksAfterLeanChange();
          }
          this.scheduleFullRebuild();
        }),
        watcher.onDidDelete((uri) => {
          if (isLeanUri(uri)) {
            this.invalidateLeanAxiomChecksAfterLeanChange();
          }
          this.scheduleFullRebuild();
        }),
        watcher.onDidChange((uri) => {
          if (isLeanUri(uri)) {
            this.invalidateLeanAxiomChecksAfterLeanChange();
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
    if (this.axiomCheckTimer) {
      clearTimeout(this.axiomCheckTimer);
    }
    this.clearLeanProcessStatus();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    for (const state of this.previewPanels.values()) {
      state.panel.dispose();
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
      void this.refreshPreviews();
      void this.triggerLeanDiagnosticsForOpenPreviews();
    }, 500);
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
    void this.refreshPreviews();

    const config = vscode.workspace.getConfiguration("handwave");
    const leanGlobs = config.get<string[]>("leanGlobs", ["**/*.lean"]);
    const articleGlobs = config.get<string[]>("articleGlobs", ["**/*.hw.md", "**/*.hw"]);
    const excludeGlob = config.get<string>("excludeGlob", "**/{node_modules,out,.git,.jj,.lake}/**");
    const leanUris = await findWorkspaceFiles(leanGlobs, workspaceFolders, excludeGlob);
    const articleUris = await findWorkspaceFiles(articleGlobs, workspaceFolders, excludeGlob);

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
    this.pruneLeanAxiomChecks(declarations);
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

    this.isIndexing = false;
    this.codeLensEmitter.fire();
    void this.triggerLeanDiagnosticsForOpenPreviews();
    await this.refreshPreviews();

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
      await this.refreshPreviewsForUri(document.uri);
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
      void this.triggerLeanDiagnosticsForOpenPreviews();
      this.codeLensEmitter.fire();
      await this.refreshPreviews();
    }
  }

  private invalidateLeanAxiomChecks(): void {
    this.leanAxiomCheckGeneration++;
    this.leanAxiomCheckStatuses.clear();
    this.leanAxiomChecksRequested.clear();
    this.leanAxiomCheckQueue.clear();
    if (this.axiomCheckTimer) {
      clearTimeout(this.axiomCheckTimer);
      this.axiomCheckTimer = undefined;
    }
  }

  private invalidateLeanAxiomChecksAfterLeanChange(): void {
    // A Lean edit can change the transitive axiom footprint of declarations in
    // other files. Without a dependency graph, per-file invalidation leaves
    // stale red/green badges for theorems whose dependencies changed elsewhere.
    this.invalidateLeanAxiomChecks();
  }

  private pruneLeanAxiomChecks(declarations: readonly LeanDeclaration[]): void {
    const names = new Set(declarations.map((declaration) => declaration.name));

    for (const name of this.leanAxiomCheckStatuses.keys()) {
      if (!names.has(name)) {
        this.leanAxiomCheckStatuses.delete(name);
      }
    }
    for (const name of this.leanAxiomChecksRequested) {
      if (!names.has(name)) {
        this.leanAxiomChecksRequested.delete(name);
      }
    }
    this.removeLeanAxiomRequestsFromQueue(new Set(
      [...this.leanAxiomCheckQueue.values()]
        .flatMap((job) => job.requests.map((request) => request.declaration.name))
        .filter((name) => !names.has(name))
    ));
  }

  private removeLeanAxiomRequestsFromQueue(names: ReadonlySet<string>): void {
    if (names.size === 0) {
      return;
    }

    for (const [key, job] of this.leanAxiomCheckQueue) {
      job.requests = job.requests.filter((request) => !names.has(request.declaration.name));
      if (job.requests.length === 0) {
        this.leanAxiomCheckQueue.delete(key);
      }
    }
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
    const config = vscode.workspace.getConfiguration("handwave");
    const dependencyChecksEnabled = config.get<boolean>("enableLeanDependencyChecks", true);
    const statuses = collectLeanDiagnosticCheckStatuses(
      declarations,
      this.leanDiagnosticUrisSeen,
      !dependencyChecksEnabled
    );
    if (!dependencyChecksEnabled) {
      return statuses;
    }
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

  private async triggerLeanDiagnosticsForIncludedTheorems(
    articles: readonly ArticleDocument[],
    declarationFilter: (declaration: LeanDeclaration) => boolean = () => true
  ): Promise<void> {
    for (const article of articles) {
      const theoremDeclarations = new Map<string, LeanDeclaration>();
      for (const include of article.includes) {
        const resolved = this.index.resolve(include.target, article.uri);
        if (!resolved) {
          continue;
        }

        const declaration = this.index.leanDeclarations.get(resolved.title);
        if (!declaration || !isTheoremLikeDeclaration(declaration) || !declarationFilter(declaration)) {
          continue;
        }

        theoremDeclarations.set(declaration.name, declaration);
      }
      await this.triggerLeanDiagnosticsForDeclarations([...theoremDeclarations.values()], {
        jobKey: `article:${article.uri}`,
        jobLabel: vscode.workspace.asRelativePath(article.uri, false)
      });
    }
  }

  private async triggerLeanDiagnosticsForDeclarations(
    declarations: readonly LeanDeclaration[],
    options: { jobKey?: string; jobLabel?: string } = {}
  ): Promise<void> {
    const uris = new Map<string, vscode.Uri>();
    for (const declaration of declarations) {
      if (!this.leanDiagnosticUrisRequested.has(declaration.uri)) {
        uris.set(declaration.uri, vscode.Uri.file(declaration.uri));
      }
    }

    void this.triggerLeanAxiomChecks(declarations, options);
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
    void this.refreshPreviews();
  }

  private async triggerLeanAxiomChecks(
    declarations: readonly LeanDeclaration[],
    options: { jobKey?: string; jobLabel?: string } = {}
  ): Promise<void> {
    const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
    if (workspaceFolders.length === 0) {
      return;
    }
    const config = vscode.workspace.getConfiguration("handwave");
    if (!config.get<boolean>("enableLeanDependencyChecks", true)) {
      return;
    }

    const diagnosticStatuses = collectLeanDiagnosticCheckStatuses(declarations, this.leanDiagnosticUrisSeen);
    const requests: LeanAxiomCheckRequest[] = [];

    for (const declaration of declarations) {
      if (this.leanAxiomChecksRequested.has(declaration.name)) {
        continue;
      }
      if (!this.leanDiagnosticUrisSeen.has(declaration.uri)) {
        continue;
      }
      if (leanFileHasBlockingDiagnostics(declaration.uri)) {
        continue;
      }
      const diagnosticStatus = diagnosticStatuses.get(declaration.name);
      if (diagnosticStatus && !diagnosticStatus.checked) {
        continue;
      }

      const target = leanAxiomProbeTarget(declaration.uri, workspaceFolders);
      if (!target) {
        continue;
      }

      this.leanAxiomChecksRequested.add(declaration.name);
      requests.push({
        declaration,
        generation: this.leanAxiomCheckGeneration
      });
    }

    if (requests.length > 0) {
      this.enqueueLeanAxiomCheckJob({
        key: options.jobKey ?? leanAxiomDefaultJobKey(requests),
        label: options.jobLabel ?? leanAxiomDefaultJobLabel(requests),
        requests
      });
      this.scheduleLeanAxiomCheckFlush();
    }
  }

  private enqueueLeanAxiomCheckJob(job: LeanAxiomCheckJob): void {
    const existing = this.leanAxiomCheckQueue.get(job.key);
    if (!existing) {
      this.leanAxiomCheckQueue.set(job.key, job);
      return;
    }

    const existingNames = new Set(existing.requests.map((request) => request.declaration.name));
    existing.requests.push(...job.requests.filter((request) => !existingNames.has(request.declaration.name)));
  }

  private scheduleLeanAxiomCheckFlush(): void {
    if (this.axiomCheckTimer) {
      clearTimeout(this.axiomCheckTimer);
    }
    const config = vscode.workspace.getConfiguration("handwave");
    const delayMs = config.get<number>("leanDependencyCheckDelayMs", 2500);
    this.axiomCheckTimer = setTimeout(() => {
      this.axiomCheckTimer = undefined;
      void this.flushLeanAxiomChecks();
    }, Math.max(0, delayMs));
  }

  private async flushLeanAxiomChecks(): Promise<void> {
    const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
    if (workspaceFolders.length === 0 || this.leanAxiomCheckQueue.size === 0) {
      return;
    }
    if (this.isFlushingAxiomChecks) {
      this.scheduleLeanAxiomCheckFlush();
      return;
    }

    const queued = [...this.leanAxiomCheckQueue.values()];
    this.leanAxiomCheckQueue.clear();

    let changed = false;
    this.isFlushingAxiomChecks = true;
    try {
      for (const job of queued) {
        const jobChanged = await this.runLeanAxiomProbeJob(job, workspaceFolders);
        changed = jobChanged || changed;
        if (jobChanged) {
          this.refreshLeanStatusViews();
        }
      }
    } finally {
      this.isFlushingAxiomChecks = false;
    }

    if (changed) {
      this.refreshLeanStatusViews();
    }
    if (this.leanAxiomCheckQueue.size > 0) {
      this.scheduleLeanAxiomCheckFlush();
    }
  }

  private async runLeanAxiomProbeJob(
    job: LeanAxiomCheckJob,
    workspaceFolders: readonly vscode.WorkspaceFolder[]
  ): Promise<boolean> {
    const requests = job.requests.filter((request) => this.isCurrentAxiomRequest(request));
    if (requests.length === 0) {
      return false;
    }

    const root = leanAxiomProbeRootForRequests(requests, workspaceFolders);
    if (!root) {
      return false;
    }

    let input: string;
    try {
      input = await leanAxiomProbeInput(root, requests);
    } catch {
      let changed = false;
      for (const request of requests) {
        changed = this.clearLeanAxiomRequest(request, { allowRetry: true }) || changed;
      }
      return changed;
    }

    const names = requests.map((request) => request.declaration.name);
    const config = vscode.workspace.getConfiguration("handwave");
    const timeoutMs = config.get<number>("leanDependencyCheckTimeoutMs", 300000);
    this.beginLeanProcessStatus(job.label, timeoutMs);
    const result = await runLakeLeanStdin(root, input, timeoutMs);
    this.clearLeanProcessStatus();

    if (!result.ok) {
      let changed = false;
      for (const request of requests) {
        if (!this.isCurrentAxiomRequest(request)) {
          continue;
        }
        changed = this.leanAxiomCheckStatuses.delete(request.declaration.name) || changed;
      }
      return changed;
    }

    const axiomsByName = parseLeanAxiomOutput(`${result.stdout}\n${result.stderr}`);
    let changed = false;
    for (const request of requests) {
      const name = request.declaration.name;
      if (!this.isCurrentAxiomRequest(request)) {
        continue;
      }
      const axioms = axiomsByName.get(name);
      if (!axioms) {
        changed = this.leanAxiomCheckStatuses.delete(name) || changed;
        continue;
      }

      const hasSorry = axioms.includes("sorryAx");
      const nextStatus = {
        checked: !hasSorry,
        ownChecked: true,
        dependencies: axioms,
        failedDependencies: hasSorry ? ["sorryAx"] : [],
        reason: hasSorry
          ? "Lean checks this declaration, but a transitive dependency still depends on sorryAx."
          : "Lean axiom check reports no transitive dependency on sorryAx."
      };
      const previous = this.leanAxiomCheckStatuses.get(name);
      this.leanAxiomCheckStatuses.set(name, {
        ...nextStatus
      });
      changed = changed || !leanCheckStatusesEqual(previous, nextStatus);
    }
    return changed;
  }

  private clearLeanAxiomRequest(
    request: LeanAxiomCheckRequest,
    options: { allowRetry?: boolean } = {}
  ): boolean {
    if (!this.isCurrentAxiomRequest(request)) {
      return false;
    }

    const name = request.declaration.name;
    const statusChanged = this.leanAxiomCheckStatuses.delete(name);
    const requestedChanged = options.allowRetry ? this.leanAxiomChecksRequested.delete(name) : false;
    return statusChanged || requestedChanged;
  }

  private beginLeanProcessStatus(label: string, timeoutMs: number): void {
    this.leanProcessStartedAt = Date.now();
    this.leanProcessStatusLabel = label;
    this.leanProcessTimeoutMs = timeoutMs;
    if (this.leanProcessStatusTimer) {
      clearInterval(this.leanProcessStatusTimer);
    }
    this.updateLeanProcessStatus();
    this.leanProcessStatusTimer = setInterval(() => this.updateLeanProcessStatus(), 1000);
    this.leanProcessStatusBar.show();
  }

  private updateLeanProcessStatus(): void {
    if (this.leanProcessStartedAt === undefined) {
      return;
    }

    const elapsedMs = Date.now() - this.leanProcessStartedAt;
    const elapsed = formatDuration(elapsedMs);
    const timeout = this.leanProcessTimeoutMs === undefined ? undefined : formatDuration(this.leanProcessTimeoutMs);
    this.leanProcessStatusBar.text = `$(sync~spin) Handwave Lean ${elapsed}`;
    this.leanProcessStatusBar.tooltip = [
      "Handwave Lean dependency check is running.",
      this.leanProcessStatusLabel ? `Target: ${this.leanProcessStatusLabel}` : undefined,
      timeout ? `Timeout: ${timeout}` : undefined
    ].filter(Boolean).join("\n");
  }

  private clearLeanProcessStatus(): void {
    if (this.leanProcessStatusTimer) {
      clearInterval(this.leanProcessStatusTimer);
      this.leanProcessStatusTimer = undefined;
    }
    this.leanProcessStartedAt = undefined;
    this.leanProcessStatusLabel = undefined;
    this.leanProcessTimeoutMs = undefined;
    this.leanProcessStatusBar.hide();
  }

  private isCurrentAxiomRequest(request: LeanAxiomCheckRequest): boolean {
    return request.generation === this.leanAxiomCheckGeneration &&
      this.leanAxiomChecksRequested.has(request.declaration.name);
  }

  private async triggerLeanDiagnosticsForOpenPreviews(): Promise<void> {
    for (const state of this.previewPanels.values()) {
      await this.triggerLeanDiagnosticsForPreview(state);
    }
  }

  provideDocumentLinks(document: vscode.TextDocument): vscode.DocumentLink[] {
    const article = parseArticleDocument(document.getText(), document.uri.fsPath);
    return [...article.links, ...article.includes].map((ref) => {
      const target = ref.target;
      const link = new vscode.DocumentLink(
        toVsCodeRange(ref.targetRange),
        commandUri("handwave.openPreviewTarget", target, document.uri.fsPath)
      );
      link.tooltip = `Preview ${target}`;
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
    const previewUri = uri ?? await this.pickPreviewUri();
    if (!previewUri) {
      return;
    }
    if (!this.isIndexing && this.declarations.length === 0) {
      void this.rebuildIndex();
    }

    const existing = this.previewStateForUri(previewUri);
    if (existing) {
      existing.panel.reveal(vscode.ViewColumn.Beside);
      existing.uri = previewUri;
      existing.focusId = undefined;
      existing.target = undefined;
      this.replacePreviewHistory(existing);
      void this.triggerLeanDiagnosticsForPreview(existing);
      await this.renderPreview(existing);
      return;
    }

    const key = String(this.nextPreviewKey++);
    const panel = vscode.window.createWebviewPanel(
      "handwave.articlePreview",
      `Handwave: ${previewUri.path.split("/").pop() ?? "Preview"}`,
      vscode.ViewColumn.Beside,
      { enableCommandUris: true, enableScripts: true }
    );

    const state = this.createPreviewState(key, panel, previewUri);
    this.registerPreviewState(state);
    void this.triggerLeanDiagnosticsForPreview(state);
    await this.renderPreview(state);
  }

  private async refreshPreviews(): Promise<void> {
    await Promise.all([...this.previewPanels.values()].map((state) => this.renderPreview(state, { inPlace: true })));
  }

  private async refreshPreviewsForUri(uri: vscode.Uri): Promise<void> {
    await Promise.all(
      [...this.previewPanels.values()]
        .filter((state) => state.uri.fsPath === uri.fsPath)
        .map((state) => this.renderPreview(state, { inPlace: true }))
    );
  }

  private async renderPreview(
    state: HandwavePreviewState,
    options: { inPlace?: boolean; focus?: boolean } = {}
  ): Promise<void> {
    try {
      const text = await readWorkspaceText(state.uri);
      const commandHref = (target: string) =>
        commandUriString("handwave.openPreviewTarget", target, state.uri.fsPath, state.key);
      const focusId = options.focus ? state.focusId : undefined;
      state.panel.title = `Handwave: ${state.uri.path.split("/").pop() ?? "Preview"}`;
      const applyHtml = async (html: string) => {
        if (options.inPlace) {
          const delivered = await state.panel.webview.postMessage({
            type: "replaceContent",
            html,
            focusId,
            currentTarget: state.target,
            currentUri: state.uri.fsPath
          });
          if (delivered) {
            return;
          }
        }
        state.panel.webview.html = html;
      };

      if (isLeanUri(state.uri)) {
        await applyHtml(renderLeanDocumentHtml(
          text,
          state.uri.fsPath,
          this.index,
          commandHref,
          {
            focusId,
            currentTarget: state.target,
            currentUri: state.uri.fsPath
          }
        ));
        return;
      }
      await applyHtml(renderArticleHtml(
        text,
        state.uri.fsPath,
        this.index,
        commandHref,
        {
          indexing: this.isIndexing,
          focusId,
          currentTarget: state.target,
          currentUri: state.uri.fsPath
        }
      ));
    } catch {
      state.panel.webview.html = "<!doctype html><html><body><p>Preview file is no longer available.</p></body></html>";
    }
  }

  private previewStateForUri(uri: vscode.Uri): HandwavePreviewState | undefined {
    return [...this.previewPanels.values()].find((state) => state.uri.fsPath === uri.fsPath);
  }

  private createPreviewState(
    key: string,
    panel: vscode.WebviewPanel,
    uri: vscode.Uri,
    focusId?: string,
    target?: string
  ): HandwavePreviewState {
    const state: HandwavePreviewState = {
      key,
      panel,
      uri,
      focusId,
      target,
      history: [],
      historyIndex: -1
    };
    this.replacePreviewHistory(state);
    return state;
  }

  private registerPreviewState(state: HandwavePreviewState): void {
    this.previewPanels.set(state.key, state);
    state.panel.onDidDispose(
      () => {
        this.previewPanels.delete(state.key);
        void this.updatePreviewHistoryContext();
      },
      undefined,
      this.disposables
    );
    state.panel.onDidChangeViewState(
      () => {
        void this.updatePreviewHistoryContext();
      },
      undefined,
      this.disposables
    );
    state.panel.webview.onDidReceiveMessage(
      (message) => {
        void this.handlePreviewMessage(state, message);
      },
      undefined,
      this.disposables
    );
    void this.updatePreviewHistoryContext();
  }

  private replacePreviewHistory(state: HandwavePreviewState): void {
    state.history = [previewHistoryEntry(state)];
    state.historyIndex = 0;
    void this.updatePreviewHistoryContext();
  }

  private recordPreviewHistory(state: HandwavePreviewState): void {
    const entry = previewHistoryEntry(state);
    const current = state.history[state.historyIndex];
    if (current && previewHistoryEntriesEqual(current, entry)) {
      return;
    }

    state.history = state.history.slice(0, state.historyIndex + 1);
    state.history.push(entry);
    state.historyIndex = state.history.length - 1;
    void this.updatePreviewHistoryContext();
  }

  private async navigatePreviewHistory(delta: -1 | 1): Promise<void> {
    const state = this.activePreviewState();
    if (!state) {
      return;
    }

    const nextIndex = state.historyIndex + delta;
    if (nextIndex < 0 || nextIndex >= state.history.length) {
      return;
    }

    state.historyIndex = nextIndex;
    this.applyPreviewHistoryEntry(state, state.history[nextIndex]);
    state.panel.reveal(state.panel.viewColumn ?? vscode.ViewColumn.Beside);
    void this.triggerLeanDiagnosticsForPreview(state);
    await this.renderPreview(state, { inPlace: true, focus: true });
    await this.updatePreviewHistoryContext();
  }

  private applyPreviewHistoryEntry(state: HandwavePreviewState, entry: PreviewHistoryEntry): void {
    state.uri = vscode.Uri.file(entry.uri);
    state.focusId = entry.focusId;
    state.target = entry.target;
  }

  private activePreviewState(): HandwavePreviewState | undefined {
    return [...this.previewPanels.values()].find((state) => state.panel.active);
  }

  private async updatePreviewHistoryContext(): Promise<void> {
    const state = this.activePreviewState();
    await Promise.all([
      vscode.commands.executeCommand("setContext", "handwave.previewCanGoBack", Boolean(state && state.historyIndex > 0)),
      vscode.commands.executeCommand(
        "setContext",
        "handwave.previewCanGoForward",
        Boolean(state && state.historyIndex >= 0 && state.historyIndex < state.history.length - 1)
      )
    ]);
  }

  private async handlePreviewMessage(state: HandwavePreviewState, message: unknown): Promise<void> {
    if (!message || typeof message !== "object") {
      return;
    }

    const data = message as {
      type?: unknown;
      target?: unknown;
      text?: unknown;
      uri?: unknown;
      focusId?: unknown;
    };

    if (data.type === "navigate" && typeof data.target === "string") {
      await this.openPreviewTarget(data.target, state.uri.fsPath, state.key, true);
      return;
    }

    if (data.type === "navigateUri" && typeof data.uri === "string") {
      state.uri = vscode.Uri.file(data.uri);
      state.focusId = typeof data.focusId === "string" ? data.focusId : undefined;
      state.target = undefined;
      void this.triggerLeanDiagnosticsForPreview(state);
      await this.renderPreview(state, { inPlace: true, focus: true });
      return;
    }

    if (data.type === "copy" && typeof data.text === "string") {
      await vscode.env.clipboard.writeText(data.text);
    }
  }

  private async openPreviewTarget(
    target: string,
    fromUri?: string,
    previewKey?: string,
    inPlace = false
  ): Promise<void> {
    const resolved = this.index.resolve(target, fromUri);
    if (!resolved) {
      void vscode.window.showWarningMessage(`Handwave target not found: ${target}`);
      return;
    }

    const state = previewKey ? this.previewPanels.get(previewKey) : undefined;
    if (state) {
      state.uri = vscode.Uri.file(resolved.uri);
      state.focusId = focusIdForTarget(target);
      state.target = target;
      state.panel.reveal(state.panel.viewColumn ?? vscode.ViewColumn.Beside);
      this.recordPreviewHistory(state);
      void this.triggerLeanDiagnosticsForPreview(state);
      await this.renderPreview(state, { inPlace, focus: true });
      return;
    }

    const key = String(this.nextPreviewKey++);
    const uri = vscode.Uri.file(resolved.uri);
    const panel = vscode.window.createWebviewPanel(
      "handwave.articlePreview",
      `Handwave: ${uri.path.split("/").pop() ?? "Preview"}`,
      vscode.ViewColumn.Beside,
      { enableCommandUris: true, enableScripts: true }
    );
    const nextState = this.createPreviewState(key, panel, uri, focusIdForTarget(target), target);
    this.registerPreviewState(nextState);
    void this.triggerLeanDiagnosticsForPreview(nextState);
    await this.renderPreview(nextState, { focus: true });
  }

  private async triggerLeanDiagnosticsForPreview(state: HandwavePreviewState): Promise<void> {
    if (isArticleUri(state.uri)) {
      const article = this.articles.find((item) => item.uri === state.uri.fsPath);
      if (article) {
        await this.triggerLeanDiagnosticsForIncludedTheorems([article]);
      }
      return;
    }

    if (isLeanUri(state.uri)) {
      const target = state.target ? parseTarget(state.target) : undefined;
      await this.triggerLeanDiagnosticsForDeclarations(
        this.declarations.filter((declaration) =>
          declaration.uri === state.uri.fsPath &&
          isTheoremLikeDeclaration(declaration) &&
          (!target || target.kind !== "lean" || declaration.name === target.base)
        ),
        {
          jobKey: `lean:${state.uri.fsPath}`,
          jobLabel: vscode.workspace.asRelativePath(state.uri.fsPath, false)
        }
      );
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

  private async pickPreviewUri(): Promise<vscode.Uri | undefined> {
    const activeUri = vscode.window.activeTextEditor?.document.uri;
    if (activeUri && isLeanOrArticle(activeUri)) {
      return activeUri;
    }

    const leanUris = [...new Set(this.declarations.map((declaration) => declaration.uri))].sort();
    const items = [
      ...this.articles.map((article) => ({
        label: vscode.workspace.asRelativePath(article.uri),
        description: "Handwave article",
        uri: vscode.Uri.file(article.uri)
      })),
      ...leanUris.map((uri) => ({
        label: vscode.workspace.asRelativePath(uri),
        description: "Lean file",
        uri: vscode.Uri.file(uri)
      }))
    ];

    return (await vscode.window.showQuickPick(items, { placeHolder: "Choose a Handwave preview" }))?.uri;
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
  leanDiagnosticUrisSeen: ReadonlySet<string>,
  includeCleanStatuses = false
): Map<string, LeanDeclarationCheckStatus> {
  const statuses = new Map<string, LeanDeclarationCheckStatus>();
  const diagnosticsByUri = new Map<string, vscode.Diagnostic[]>();

  for (const declaration of declarations) {
    if (!isTheoremLikeDeclaration(declaration)) {
      continue;
    }

    const directIncompleteStatus = directIncompleteProofStatus(declaration);
    if (directIncompleteStatus) {
      statuses.set(declaration.name, directIncompleteStatus);
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
    if (relevant.length === 0) {
      if (includeCleanStatuses && !leanFileHasBlockingDiagnostics(declaration.uri)) {
        statuses.set(declaration.name, {
          checked: true,
          ownChecked: true,
          dependencies: [],
          failedDependencies: [],
          reason: "Lean LSP diagnostics report no local errors for this declaration."
        });
      }
      continue;
    }

    statuses.set(declaration.name, {
      checked: false,
      ownChecked: false,
      dependencies: [],
      failedDependencies: [],
      reason: summarizeLeanDiagnostics(relevant)
    });
  }

  return statuses;
}

function directIncompleteProofStatus(declaration: LeanDeclaration): LeanDeclarationCheckStatus | undefined {
  const proof = declaration.leanProof ?? "";
  const searchableProof = blankLeanCommentsAndStrings(proof);
  const match = /\b(?:sorry|admit)\b/i.exec(searchableProof);
  if (!match) {
    return undefined;
  }

  const token = match[0].toLowerCase();
  return {
    checked: false,
    ownChecked: false,
    dependencies: [],
    failedDependencies: [],
    reason: `Lean declaration contains a direct \`${token}\`.`
  };
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

function leanFileHasBlockingDiagnostics(uri: string): boolean {
  return vscode.languages.getDiagnostics(vscode.Uri.file(uri)).some((diagnostic) =>
    diagnostic.source !== "handwave" && diagnostic.severity === vscode.DiagnosticSeverity.Error
  );
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
): { root: string } | undefined {
  const root = workspaceRootForFile(fsPath, workspaceFolders);
  if (!root) {
    return undefined;
  }

  const relative = path.relative(root, fsPath);
  if (relative.startsWith("..") || path.isAbsolute(relative) || !relative.endsWith(".lean")) {
    return undefined;
  }

  const withoutExtension = relative.slice(0, -".lean".length);
  return withoutExtension ? { root } : undefined;
}

function leanAxiomProbeRootForRequests(
  requests: readonly LeanAxiomCheckRequest[],
  workspaceFolders: readonly vscode.WorkspaceFolder[]
): string | undefined {
  const roots = new Set<string>();
  for (const request of requests) {
    const target = leanAxiomProbeTarget(request.declaration.uri, workspaceFolders);
    if (!target) {
      return undefined;
    }
    roots.add(target.root);
  }

  return roots.size === 1 ? [...roots][0] : undefined;
}

async function leanAxiomProbeInput(
  root: string,
  requests: readonly LeanAxiomCheckRequest[]
): Promise<string> {
  const names = requests.map((request) => request.declaration.name);
  const uniqueUris = [...new Set(requests.map((request) => request.declaration.uri))].sort();
  if (uniqueUris.length === 1) {
    const source = await readWorkspaceText(vscode.Uri.file(uniqueUris[0]));
    return [
      source,
      ...names.map((name) => `#print axioms ${name}`),
      ""
    ].join("\n");
  }

  const modules = uniqueUris.map((uri) => leanModuleNameForFile(uri, root));
  if (modules.some((moduleName) => moduleName === undefined)) {
    throw new Error("Unable to derive Lean module name for Handwave dependency check.");
  }

  return [
    ...modules.map((moduleName) => `import ${moduleName}`),
    "",
    ...names.map((name) => `#print axioms ${name}`),
    ""
  ].join("\n");
}

function leanModuleNameForFile(fsPath: string, root: string): string | undefined {
  const relative = path.relative(root, fsPath);
  if (relative.startsWith("..") || path.isAbsolute(relative) || !relative.endsWith(".lean")) {
    return undefined;
  }

  const withoutExtension = relative.slice(0, -".lean".length);
  if (!withoutExtension) {
    return undefined;
  }
  return withoutExtension.split(/[\\/]+/).filter(Boolean).join(".");
}

function leanAxiomDefaultJobKey(requests: readonly LeanAxiomCheckRequest[]): string {
  const uris = [...new Set(requests.map((request) => request.declaration.uri))].sort();
  return `declarations:${uris.join("\0")}`;
}

function leanAxiomDefaultJobLabel(requests: readonly LeanAxiomCheckRequest[]): string {
  const uris = [...new Set(requests.map((request) => request.declaration.uri))].sort();
  if (uris.length === 1) {
    return vscode.workspace.asRelativePath(uris[0], false);
  }
  return `${requests.length} Lean dependency checks`;
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
  timeoutMs = 300000
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

function leanCheckStatusesEqual(
  first: LeanDeclarationCheckStatus | undefined,
  second: LeanDeclarationCheckStatus
): boolean {
  return Boolean(first) &&
    first!.checked === second.checked &&
    first!.ownChecked === second.ownChecked &&
    stringArraysEqual(first!.dependencies, second.dependencies) &&
    stringArraysEqual(first!.failedDependencies, second.failedDependencies) &&
    first!.reason === second.reason;
}

function stringArraysEqual(first: readonly string[], second: readonly string[]): boolean {
  return first.length === second.length && first.every((value, index) => value === second[index]);
}

function formatDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) {
    return `${minutes}:${String(seconds).padStart(2, "0")}`;
  }

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}:${String(remainingMinutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function focusIdForTarget(rawTarget: string): string | undefined {
  const target = parseTarget(rawTarget);
  if (target.kind === "lean") {
    return leanDeclarationAnchorId(target.base);
  }
  if (target.kind === "article" || target.kind === "local") {
    return target.anchor;
  }
  return undefined;
}

function previewHistoryEntry(state: HandwavePreviewState): PreviewHistoryEntry {
  return {
    uri: state.uri.fsPath,
    focusId: state.focusId,
    target: state.target
  };
}

function previewHistoryEntriesEqual(first: PreviewHistoryEntry, second: PreviewHistoryEntry): boolean {
  return first.uri === second.uri && first.focusId === second.focusId && first.target === second.target;
}

async function findWorkspaceFiles(
  globs: string[],
  workspaceFolders: readonly vscode.WorkspaceFolder[],
  excludeGlob = "**/{node_modules,out,.git,.jj,.lake}/**"
): Promise<vscode.Uri[]> {
  const found = new Map<string, vscode.Uri>();
  for (const folder of workspaceFolders) {
    for (const glob of globs) {
      const uris = await vscode.workspace.findFiles(
        new vscode.RelativePattern(folder, glob),
        new vscode.RelativePattern(folder, excludeGlob)
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
