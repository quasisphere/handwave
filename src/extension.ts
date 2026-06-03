import * as vscode from "vscode";
import * as path from "node:path";
import * as fs from "node:fs";
import { spawn } from "node:child_process";
import { collectDiagnostics, DiagnosticIssue } from "./handwave/diagnostics";
import { HandwaveIndex } from "./handwave/index";
import { parseLeanAxiomOutput } from "./handwave/leanAxiom";
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
  priority: number;
}

type LeanAxiomCheckQueueItem = LeanAxiomCheckRequest;

interface LeanAxiomCheckJob {
  label: string;
  requests: LeanAxiomCheckRequest[];
}

interface PrioritizedLeanDeclaration {
  declaration: LeanDeclaration;
  priority: number;
}

type LeanAxiomCheckReadiness =
  | { kind: "ready" }
  | { kind: "skip" }
  | { kind: "blocked"; reason: string };

const topLevelPendingPriority = 0;
const topLevelStalePriority = 1;
const directDependencyPriority = 2;
const defaultLeanAxiomPriority = 1000;

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
  private readonly leanAxiomCheckQueue = new Map<string, LeanAxiomCheckQueueItem>();
  private readonly leanAxiomChecksRunning = new Set<string>();
  private declarations: LeanDeclaration[] = [];
  private articles: ArticleDocument[] = [];
  private index = new HandwaveIndex("", [], []);
  private rebuildTimer: NodeJS.Timeout | undefined;
  private documentUpdateTimer: NodeJS.Timeout | undefined;
  private diagnosticUpdateTimer: NodeJS.Timeout | undefined;
  private axiomCheckTimer: NodeJS.Timeout | undefined;
  private compiledLeanChangeTimer: NodeJS.Timeout | undefined;
  private compiledLeanPollTimer: NodeJS.Timeout | undefined;
  private leanProcessStatusTimer: NodeJS.Timeout | undefined;
  private leanProcessStartedAt: number | undefined;
  private leanProcessStatusLabel: string | undefined;
  private leanProcessTimeoutMs: number | undefined;
  private isIndexing = false;
  private isFlushingAxiomChecks = false;
  private leanAxiomQueueDirty = false;
  private leanAxiomCheckGeneration = 0;
  private compiledLeanArtifactsSnapshot: string | undefined;
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
        this.clearLeanAxiomChecks();
        return this.rebuildIndex(true);
      }),
      vscode.commands.registerCommand("handwave.refreshLeanStatus", () => this.refreshLeanStatus()),
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
            this.markLeanAxiomChecksStale();
          }
          this.scheduleDocumentUpdate(event.document);
        }
      }),
      vscode.workspace.onDidSaveTextDocument((document) => {
        if (isLeanOrArticle(document.uri)) {
          if (isLeanUri(document.uri)) {
            this.markLeanAxiomChecksStale();
          }
          this.scheduleFullRebuild();
        }
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("handwave")) {
          this.clearLeanAxiomChecks();
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
        this.clearLeanAxiomChecks();
        void this.rebuildIndex();
      })
    );

    for (const pattern of ["**/*.lean", "**/*.hw", "**/*.hw.md"]) {
      const watcher = vscode.workspace.createFileSystemWatcher(pattern);
      this.disposables.push(
        watcher,
        watcher.onDidCreate((uri) => {
          if (isLeanUri(uri)) {
            this.markLeanAxiomChecksStale();
          }
          this.scheduleFullRebuild();
        }),
        watcher.onDidDelete((uri) => {
          if (isLeanUri(uri)) {
            this.markLeanAxiomChecksStale();
          }
          this.scheduleFullRebuild();
        }),
        watcher.onDidChange((uri) => {
          if (isLeanUri(uri)) {
            this.markLeanAxiomChecksStale();
          }
          this.scheduleFullRebuild();
        })
      );
    }

    this.registerCompiledLeanArtifactWatchers();
    this.compiledLeanPollTimer = setInterval(() => this.pollCompiledLeanArtifacts(), 3000);
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
    if (this.compiledLeanChangeTimer) {
      clearTimeout(this.compiledLeanChangeTimer);
    }
    if (this.compiledLeanPollTimer) {
      clearInterval(this.compiledLeanPollTimer);
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

  private scheduleCompiledLeanStatusRefresh(): void {
    if (this.compiledLeanChangeTimer) {
      clearTimeout(this.compiledLeanChangeTimer);
    }
    this.compiledLeanChangeTimer = setTimeout(() => {
      this.compiledLeanChangeTimer = undefined;
      this.compiledLeanArtifactsSnapshot =
        this.compiledLeanArtifactSnapshotForOpenPreviews() ?? this.compiledLeanArtifactsSnapshot;
      this.markLeanAxiomChecksStale();
      void this.triggerLeanDiagnosticsForOpenPreviews();
    }, 750);
  }

  private registerCompiledLeanArtifactWatchers(): void {
    const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
    const patterns = [".lake/build/lib/lean/**/*.olean", ".lake/build/lib/lean/**/*.ilean"];
    for (const folder of workspaceFolders) {
      for (const pattern of patterns) {
        const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, pattern));
        this.disposables.push(
          watcher,
          watcher.onDidCreate(() => this.scheduleCompiledLeanStatusRefresh()),
          watcher.onDidChange(() => this.scheduleCompiledLeanStatusRefresh()),
          watcher.onDidDelete(() => this.scheduleCompiledLeanStatusRefresh())
        );
      }
    }
  }

  private pollCompiledLeanArtifacts(): void {
    const snapshot = this.compiledLeanArtifactSnapshotForOpenPreviews();
    if (!snapshot) {
      this.compiledLeanArtifactsSnapshot = undefined;
      return;
    }

    if (this.compiledLeanArtifactsSnapshot === undefined) {
      this.compiledLeanArtifactsSnapshot = snapshot;
      return;
    }

    if (snapshot !== this.compiledLeanArtifactsSnapshot) {
      this.compiledLeanArtifactsSnapshot = snapshot;
      this.scheduleCompiledLeanStatusRefresh();
    }
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

  private clearLeanAxiomChecks(): void {
    this.leanAxiomCheckGeneration++;
    this.leanAxiomCheckStatuses.clear();
    this.leanAxiomCheckQueue.clear();
    this.leanAxiomChecksRunning.clear();
    this.leanAxiomQueueDirty = false;
    if (this.axiomCheckTimer) {
      clearTimeout(this.axiomCheckTimer);
      this.axiomCheckTimer = undefined;
    }
  }

  private markLeanAxiomChecksStale(): void {
    // A Lean source or compiled-artifact change can alter the transitive axiom
    // footprint of declarations in other files. Keep the latest known answers
    // visible, but make them stale and allow fresh probes to be requested.
    this.leanAxiomCheckGeneration++;
    this.leanAxiomCheckQueue.clear();
    this.leanAxiomChecksRunning.clear();
    this.leanAxiomQueueDirty = true;
    if (this.axiomCheckTimer) {
      clearTimeout(this.axiomCheckTimer);
      this.axiomCheckTimer = undefined;
    }
    this.refreshLeanStatusViews();
    this.refreshLeanAxiomDemandForOpenPreviews();
  }

  private async refreshLeanStatus(): Promise<void> {
    this.markLeanAxiomChecksStale();
    await this.triggerLeanDiagnosticsForOpenPreviews();
  }

  private pruneLeanAxiomChecks(declarations: readonly LeanDeclaration[]): void {
    const names = new Set(declarations.map((declaration) => declaration.name));

    for (const name of this.leanAxiomCheckStatuses.keys()) {
      if (!names.has(name)) {
        this.leanAxiomCheckStatuses.delete(name);
      }
    }
    for (const name of this.leanAxiomCheckQueue.keys()) {
      if (!names.has(name)) {
        this.leanAxiomCheckQueue.delete(name);
      }
    }
    for (const name of this.leanAxiomChecksRunning) {
      if (!names.has(name)) {
        this.leanAxiomChecksRunning.delete(name);
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
    for (const [name, axiomStatus] of this.leanAxiomCheckStatuses) {
      const diagnosticStatus = statuses.get(name);
      statuses.set(
        name,
        mergeLeanCheckStatuses(
          diagnosticStatus,
          withLeanCheckStaleness(axiomStatus, this.leanAxiomCheckGeneration)
        )
      );
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
      await this.triggerLeanDiagnosticsForDeclarations(
        [...theoremDeclarations.values()]
      );
    }
  }

  private async triggerLeanDiagnosticsForDeclarations(
    declarations: readonly LeanDeclaration[]
  ): Promise<void> {
    await this.openLeanDocumentsForDeclarations(declarations);
    this.refreshLeanStatusViews();
    this.refreshLeanAxiomDemandForOpenPreviews();
  }

  private async openLeanDocumentsForDeclarations(declarations: readonly LeanDeclaration[]): Promise<void> {
    const uris = new Map<string, vscode.Uri>();
    for (const declaration of declarations) {
      if (!this.leanDiagnosticUrisRequested.has(declaration.uri)) {
        uris.set(declaration.uri, vscode.Uri.file(declaration.uri));
      }
    }

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

  private refreshLeanAxiomDemandForOpenPreviews(): void {
    const statusChanged = this.refreshLeanAxiomQueueForOpenPreviews();
    if (statusChanged) {
      this.refreshLeanStatusViews();
    }
    if (this.leanAxiomCheckQueue.size > 0) {
      this.scheduleLeanAxiomCheckFlush();
    }
  }

  private refreshLeanAxiomQueueForOpenPreviews(): boolean {
    const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
    if (workspaceFolders.length === 0) {
      this.leanAxiomCheckQueue.clear();
      return false;
    }
    const config = vscode.workspace.getConfiguration("handwave");
    if (!config.get<boolean>("enableLeanDependencyChecks", true)) {
      this.leanAxiomCheckQueue.clear();
      return false;
    }

    const visible = this.visibleTheoremDeclarationsForOpenPreviews();
    const visibleNames = new Set(visible.map((item) => item.declaration.name));
    for (const [name, item] of this.leanAxiomCheckQueue) {
      if (!visibleNames.has(name) || item.generation !== this.leanAxiomCheckGeneration) {
        this.leanAxiomCheckQueue.delete(name);
      }
    }

    if (visible.length === 0) {
      return false;
    }

    let statusChanged = false;
    const diagnosticStatuses = collectLeanDiagnosticCheckStatuses(
      visible.map((item) => item.declaration),
      this.leanDiagnosticUrisSeen
    );

    for (const { declaration, priority } of visible) {
      const readiness = this.leanAxiomCheckReadiness(declaration, workspaceFolders, diagnosticStatuses);
      if (readiness.kind === "skip") {
        this.leanAxiomCheckQueue.delete(declaration.name);
        continue;
      }

      if (readiness.kind === "blocked") {
        this.leanAxiomCheckQueue.delete(declaration.name);
        statusChanged = this.recordBlockedLeanAxiomStatus(declaration, readiness.reason) || statusChanged;
        continue;
      }

      const previousStatus = this.leanAxiomCheckStatuses.get(declaration.name);
      if (previousStatus?.blocked) {
        statusChanged = this.leanAxiomCheckStatuses.delete(declaration.name) || statusChanged;
      }

      if (!this.leanAxiomChecksRunning.has(declaration.name)) {
        this.enqueueLeanAxiomCheck({
          declaration,
          generation: this.leanAxiomCheckGeneration,
          priority
        });
      }
    }

    return statusChanged;
  }

  private leanAxiomCheckReadiness(
    declaration: LeanDeclaration,
    workspaceFolders: readonly vscode.WorkspaceFolder[],
    diagnosticStatuses: ReadonlyMap<string, LeanDeclarationCheckStatus>
  ): LeanAxiomCheckReadiness {
    const diagnosticStatus = diagnosticStatuses.get(declaration.name);
    if (diagnosticStatus && !diagnosticStatus.checked) {
      return { kind: "skip" };
    }

    const status = this.index.checkStatusForLean(declaration.name);
    if (status && !status.stale && !status.blocked) {
      return { kind: "skip" };
    }

    if (leanFileHasBlockingDiagnostics(declaration.uri)) {
      return {
        kind: "blocked",
        reason: "Handwave cannot run the Lean dependency check while this Lean file has errors."
      };
    }

    if (!leanAxiomProbeTarget(declaration.uri, workspaceFolders)) {
      return {
        kind: "blocked",
        reason: "Handwave cannot run the Lean dependency check because this declaration is not in a Lean module under a workspace root."
      };
    }

    return { kind: "ready" };
  }

  private enqueueLeanAxiomCheck(item: LeanAxiomCheckQueueItem): void {
    const existing = this.leanAxiomCheckQueue.get(item.declaration.name);
    if (
      existing &&
      existing.generation === item.generation &&
      existing.declaration.uri === item.declaration.uri &&
      existing.priority <= item.priority
    ) {
      return;
    }

    this.leanAxiomCheckQueue.set(item.declaration.name, item);
    this.leanAxiomQueueDirty = true;
  }

  private nextLeanAxiomCheckJob(
    workspaceFolders: readonly vscode.WorkspaceFolder[]
  ): LeanAxiomCheckJob | undefined {
    if (workspaceFolders.length === 0) {
      return undefined;
    }
    const config = vscode.workspace.getConfiguration("handwave");
    if (!config.get<boolean>("enableLeanDependencyChecks", true)) {
      return undefined;
    }

    const candidates = [...this.leanAxiomCheckQueue.values()]
      .filter((item) => item.generation === this.leanAxiomCheckGeneration)
      .sort(compareLeanAxiomCheckRequests);
    if (candidates.length === 0) {
      return undefined;
    }

    const batchSize = Math.max(1, Math.floor(config.get<number>("leanDependencyCheckBatchSize", 16)));
    const requests: LeanAxiomCheckRequest[] = [];
    let selectedRoot: string | undefined;
    const selectedUris = new Set<string>();
    let selectedHasPrivate = false;

    for (const { declaration, priority } of candidates) {
      const target = leanAxiomProbeTarget(declaration.uri, workspaceFolders);
      if (!target) {
        this.leanAxiomCheckQueue.delete(declaration.name);
        this.recordBlockedLeanAxiomStatus(
          declaration,
          "Handwave cannot run the Lean dependency check because this declaration is not in a Lean module under a workspace root."
        );
        continue;
      }
      if (selectedRoot !== undefined && selectedRoot !== target.root) {
        continue;
      }
      if (
        (selectedHasPrivate && !selectedUris.has(declaration.uri)) ||
        (declaration.isPrivate &&
          selectedUris.size > 0 &&
          (selectedUris.size > 1 || !selectedUris.has(declaration.uri)))
      ) {
        continue;
      }

      selectedRoot = target.root;
      selectedUris.add(declaration.uri);
      selectedHasPrivate = selectedHasPrivate || declaration.isPrivate;

      this.leanAxiomCheckQueue.delete(declaration.name);
      this.leanAxiomChecksRunning.add(declaration.name);
      requests.push({
        declaration,
        generation: this.leanAxiomCheckGeneration,
        priority
      });

      if (requests.length >= batchSize) {
        break;
      }
    }

    if (requests.length === 0) {
      return undefined;
    }

    requests.sort(compareLeanAxiomCheckRequests);
    return {
      label: leanAxiomDemandJobLabel(requests),
      requests
    };
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
    if (workspaceFolders.length === 0) {
      return;
    }
    if (this.isFlushingAxiomChecks) {
      this.leanAxiomQueueDirty = true;
      return;
    }

    this.isFlushingAxiomChecks = true;
    try {
      while (true) {
        this.leanAxiomQueueDirty = false;
        const statusChanged = this.refreshLeanAxiomQueueForOpenPreviews();
        if (statusChanged) {
          this.refreshLeanStatusViews();
        }

        const job = this.nextLeanAxiomCheckJob(workspaceFolders);
        if (!job) {
          break;
        }

        await this.openLeanDocumentsForDeclarations(job.requests.map((request) => request.declaration));
        const jobChanged = await this.runLeanAxiomProbeJob(job, workspaceFolders);
        if (jobChanged) {
          this.refreshLeanStatusViews();
        }
      }
    } finally {
      this.isFlushingAxiomChecks = false;
    }

    if (this.leanAxiomQueueDirty || this.leanAxiomCheckQueue.size > 0) {
      this.scheduleLeanAxiomCheckFlush();
    }
  }

  private async runLeanAxiomProbeJob(
    job: LeanAxiomCheckJob,
    workspaceFolders: readonly vscode.WorkspaceFolder[]
  ): Promise<boolean> {
    const requests = job.requests
      .filter((request) => this.isCurrentAxiomRequest(request))
      .sort(compareLeanAxiomCheckRequests);
    if (requests.length === 0) {
      return false;
    }

    const root = leanAxiomProbeRootForRequests(requests, workspaceFolders);
    if (!root) {
      let changed = false;
      for (const request of requests) {
        changed = this.recordBlockedLeanAxiomStatus(
          request.declaration,
          "Handwave cannot run these Lean dependency checks from a single workspace root."
        ) || changed;
        this.leanAxiomChecksRunning.delete(request.declaration.name);
      }
      return changed;
    }

    const config = vscode.workspace.getConfiguration("handwave");
    const timeoutMs = config.get<number>("leanDependencyCheckTimeoutMs", 300000);
    const batchSize = Math.max(1, Math.floor(config.get<number>("leanDependencyCheckBatchSize", 16)));
    const batches = chunkLeanAxiomRequests(requests, batchSize);
    let changed = false;

    for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
      const batch = batches[batchIndex];
      let input: string;
      try {
        input = await leanAxiomProbeInput(root, batch);
      } catch {
        for (const request of batch) {
          if (this.isCurrentAxiomRequest(request)) {
            changed = this.recordBlockedLeanAxiomStatus(
              request.declaration,
              "Handwave could not prepare the Lean dependency check for this declaration."
            ) || changed;
          }
          this.leanAxiomChecksRunning.delete(request.declaration.name);
        }
        continue;
      }

      this.beginLeanProcessStatus(leanAxiomBatchLabel(job.label, batchIndex, batches.length), timeoutMs);
      const result = await runLakeLeanStdin(root, input, timeoutMs);
      this.clearLeanProcessStatus();

      const axiomsByName = parseLeanAxiomOutput(`${result.stdout}\n${result.stderr}`);
      let batchChanged = false;
      try {
        for (const request of batch) {
          const name = request.declaration.name;
          if (!this.isCurrentAxiomRequest(request)) {
            continue;
          }
          const axioms = axiomsForDeclaration(axiomsByName, request.declaration);
          if (!axioms) {
            batchChanged = this.recordInconclusiveLeanAxiomStatus(
              request,
              result.ok
                ? "The Lean dependency check finished, but did not report an axiom status for this declaration."
                : "Handwave could not finish the Lean dependency check for this declaration."
            ) || batchChanged;
            continue;
          }

          const hasSorry = axioms.includes("sorryAx");
          const nextStatus = {
            checked: !hasSorry,
            ownChecked: true,
            dependencies: axioms,
            failedDependencies: hasSorry ? ["sorryAx"] : [],
            stale: false,
            generation: this.leanAxiomCheckGeneration,
            reason: hasSorry
              ? "Lean checks this declaration, but a transitive dependency still depends on sorryAx."
              : "Lean axiom check reports no transitive dependency on sorryAx."
          };
          const previous = this.leanAxiomCheckStatuses.get(name);
          this.leanAxiomCheckStatuses.set(name, {
            ...nextStatus
          });
          batchChanged = batchChanged || !leanCheckStatusesEqual(previous, nextStatus);
        }
      } finally {
        for (const request of batch) {
          this.leanAxiomChecksRunning.delete(request.declaration.name);
        }
      }

      if (batchChanged) {
        changed = true;
        this.refreshLeanStatusViews();
      }
    }
    return changed;
  }

  private recordInconclusiveLeanAxiomStatus(request: LeanAxiomCheckRequest, reason: string): boolean {
    if (!this.isCurrentAxiomRequest(request)) {
      return false;
    }

    const nextStatus: LeanDeclarationCheckStatus = {
      checked: false,
      ownChecked: false,
      dependencies: [],
      failedDependencies: [],
      inconclusive: true,
      stale: false,
      generation: this.leanAxiomCheckGeneration,
      reason
    };
    const previous = this.leanAxiomCheckStatuses.get(request.declaration.name);
    this.leanAxiomCheckStatuses.set(request.declaration.name, nextStatus);
    return !leanCheckStatusesEqual(previous, nextStatus);
  }

  private recordBlockedLeanAxiomStatus(declaration: LeanDeclaration, reason: string): boolean {
    const nextStatus: LeanDeclarationCheckStatus = {
      checked: false,
      ownChecked: false,
      dependencies: [],
      failedDependencies: [],
      blocked: true,
      stale: false,
      generation: this.leanAxiomCheckGeneration,
      reason
    };
    const previous = this.leanAxiomCheckStatuses.get(declaration.name);
    this.leanAxiomCheckStatuses.set(declaration.name, nextStatus);
    return !leanCheckStatusesEqual(previous, nextStatus);
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
      this.leanAxiomChecksRunning.has(request.declaration.name);
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
    markdown.appendMarkdown(`**${declaration.sourceName}**\n\n`);
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
      { enableCommandUris: true, enableFindWidget: true, enableScripts: true }
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
      const editorHref = (target: string) =>
        commandUriString("handwave.openTarget", target, state.uri.fsPath);
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
            currentUri: state.uri.fsPath,
            editorHref
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
          currentUri: state.uri.fsPath,
          editorHref
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
    const panelDisposables: vscode.Disposable[] = [];
    const disposePanelDisposables = () => {
      for (const disposable of panelDisposables.splice(0)) {
        disposable.dispose();
      }
    };

    state.panel.onDidDispose(
      () => {
        this.previewPanels.delete(state.key);
        disposePanelDisposables();
        void this.updatePreviewHistoryContext();
      }
    );
    panelDisposables.push(
      state.panel.onDidChangeViewState(
        () => {
          void this.updatePreviewHistoryContext();
        }
      ),
      state.panel.webview.onDidReceiveMessage(
        (message) => {
          void this.handlePreviewMessage(state, message);
        }
      )
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
      { enableCommandUris: true, enableFindWidget: true, enableScripts: true }
    );
    const nextState = this.createPreviewState(key, panel, uri, focusIdForTarget(target), target);
    this.registerPreviewState(nextState);
    void this.triggerLeanDiagnosticsForPreview(nextState);
    await this.renderPreview(nextState, { focus: true });
  }

  private async triggerLeanDiagnosticsForPreview(state: HandwavePreviewState): Promise<void> {
    const declarations = this.visibleTheoremDeclarationsForPreviewState(state)
      .map((item) => item.declaration);
    if (declarations.length === 0) {
      return;
    }
    await this.triggerLeanDiagnosticsForDeclarations(declarations);
  }

  private visibleTheoremDeclarationsForOpenPreviews(): PrioritizedLeanDeclaration[] {
    const result = new Map<string, PrioritizedLeanDeclaration>();
    for (const state of this.previewPanels.values()) {
      for (const item of this.visibleTheoremDeclarationsForPreviewState(state)) {
        const existing = result.get(item.declaration.name);
        if (!existing || item.priority < existing.priority) {
          result.set(item.declaration.name, item);
        }
      }
    }
    return [...result.values()].sort(comparePrioritizedLeanDeclarations);
  }

  private visibleTheoremDeclarationsForPreviewState(
    state: HandwavePreviewState
  ): PrioritizedLeanDeclaration[] {
    const result = new Map<string, LeanDeclaration>();
    const priorities = new Map<string, number>();
    const visit = (
      declaration: LeanDeclaration,
      priority: number,
      depth: number,
      path: ReadonlySet<string>
    ) => {
      const existingPriority = priorities.get(declaration.name);
      if (existingPriority !== undefined && existingPriority < priority) {
        return;
      }

      result.set(declaration.name, declaration);
      priorities.set(declaration.name, priority);
      for (const dependencyName of this.index.dependenciesForLean(declaration.name)) {
        const dependency = this.index.leanDeclarations.get(dependencyName);
        if (
          !dependency ||
          !isTheoremLikeDeclaration(dependency)
        ) {
          continue;
        }
        const dependencyPriority = directDependencyPriority + depth;
        const status = this.index.checkStatusForLean(dependency.name);
        if (status && !status.checked && !path.has(dependency.name)) {
          visit(
            dependency,
            dependencyPriority,
            depth + 1,
            new Set([...path, dependency.name])
          );
          continue;
        }

        const dependencyPriorityExisting = priorities.get(dependency.name);
        if (dependencyPriorityExisting === undefined || dependencyPriority < dependencyPriorityExisting) {
          result.set(dependency.name, dependency);
          priorities.set(dependency.name, dependencyPriority);
        }
      }
    };

    for (const declaration of this.theoremDeclarationsForPreviewState(state)) {
      visit(
        declaration,
        this.topLevelLeanAxiomPriority(declaration),
        0,
        new Set([declaration.name])
      );
    }

    return [...result.values()]
      .map((declaration) => ({
        declaration,
        priority: priorities.get(declaration.name) ?? defaultLeanAxiomPriority
      }))
      .sort(comparePrioritizedLeanDeclarations);
  }

  private topLevelLeanAxiomPriority(declaration: LeanDeclaration): number {
    const status = this.index.checkStatusForLean(declaration.name);
    if (!status) {
      return topLevelPendingPriority;
    }
    if (status.stale) {
      return topLevelStalePriority;
    }
    return directDependencyPriority;
  }

  private theoremDeclarationsForPreviewState(state: HandwavePreviewState): LeanDeclaration[] {
    if (isArticleUri(state.uri)) {
      const article = this.articles.find((item) => item.uri === state.uri.fsPath);
      if (!article) {
        return [];
      }

      const declarations = new Map<string, LeanDeclaration>();
      for (const include of article.includes) {
        const resolved = this.index.resolve(include.target, article.uri);
        if (!resolved) {
          continue;
        }

        const declaration = this.index.leanDeclarations.get(resolved.title);
        if (declaration && isTheoremLikeDeclaration(declaration)) {
          declarations.set(declaration.name, declaration);
        }
      }
      return [...declarations.values()];
    }

    if (!isLeanUri(state.uri)) {
      return [];
    }

    const target = state.target ? parseTarget(state.target) : undefined;
    return this.declarations.filter((declaration) =>
      declaration.uri === state.uri.fsPath &&
      isTheoremLikeDeclaration(declaration) &&
      (!declaration.isPrivate || (target?.kind === "lean" && declaration.name === target.base)) &&
      (!target || target.kind !== "lean" || declaration.name === target.base)
    );
  }

  private compiledLeanArtifactSnapshotForOpenPreviews(): string | undefined {
    const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
    if (workspaceFolders.length === 0 || this.previewPanels.size === 0) {
      return undefined;
    }

    const declarations = new Map<string, LeanDeclaration>();
    for (const state of this.previewPanels.values()) {
      for (const item of this.visibleTheoremDeclarationsForPreviewState(state)) {
        declarations.set(item.declaration.name, item.declaration);
      }
    }
    if (declarations.size === 0) {
      return undefined;
    }

    return [...declarations.values()]
      .flatMap((declaration) => leanCompiledArtifactPaths(declaration.uri, workspaceFolders))
      .sort()
      .map((artifactPath) => {
        try {
          const stat = fs.statSync(artifactPath);
          return `${artifactPath}:${stat.mtimeMs}:${stat.size}`;
        } catch {
          return `${artifactPath}:missing`;
        }
      })
      .join("\n");
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
      description: declaration.isPrivate
        ? `${declaration.sourceName} - private - ${declaration.uri}`
        : declaration.uri
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

function comparePrioritizedLeanDeclarations(
  first: PrioritizedLeanDeclaration,
  second: PrioritizedLeanDeclaration
): number {
  return first.priority - second.priority ||
    first.declaration.name.localeCompare(second.declaration.name);
}

function compareLeanAxiomCheckRequests(
  first: LeanAxiomCheckRequest,
  second: LeanAxiomCheckRequest
): number {
  return first.priority - second.priority ||
    first.declaration.name.localeCompare(second.declaration.name);
}

function chunkLeanAxiomRequests(
  requests: readonly LeanAxiomCheckRequest[],
  batchSize: number
): LeanAxiomCheckRequest[][] {
  const chunks: LeanAxiomCheckRequest[][] = [];
  for (let index = 0; index < requests.length; index += batchSize) {
    chunks.push(requests.slice(index, index + batchSize));
  }
  return chunks;
}

function leanAxiomBatchLabel(label: string, batchIndex: number, batchCount: number): string {
  return batchCount <= 1 ? label : `${label} (${batchIndex + 1}/${batchCount})`;
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

function axiomsForDeclaration(
  axiomsByName: ReadonlyMap<string, string[]>,
  declaration: LeanDeclaration
): string[] | undefined {
  const exact = axiomsByName.get(declaration.name) ?? axiomsByName.get(declaration.sourceName);
  if (exact || !declaration.isPrivate) {
    return exact;
  }

  const suffix = `.${declaration.sourceName}`;
  const matches = [...axiomsByName]
    .filter(([name]) => name.endsWith(suffix))
    .map(([, axioms]) => axioms);
  return matches.length === 1 ? matches[0] : undefined;
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

function withLeanCheckStaleness(
  status: LeanDeclarationCheckStatus,
  currentGeneration: number
): LeanDeclarationCheckStatus {
  const stale = status.generation !== undefined && status.generation !== currentGeneration;
  if (status.stale === stale) {
    return status;
  }

  return {
    ...status,
    stale,
    reason: stale
      ? `${status.reason} This is the latest known status, but it predates the current Lean source or build state.`
      : status.reason.replace(/\s+This is the latest known status, but it predates the current Lean source or build state\.$/, "")
  };
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
    const names = requests.map((request) => request.declaration.sourceName);
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

function leanCompiledArtifactPaths(
  fsPath: string,
  workspaceFolders: readonly vscode.WorkspaceFolder[]
): string[] {
  const root = workspaceRootForFile(fsPath, workspaceFolders);
  if (!root) {
    return [];
  }

  const relative = path.relative(root, fsPath);
  if (relative.startsWith("..") || path.isAbsolute(relative) || !relative.endsWith(".lean")) {
    return [];
  }

  const withoutExtension = relative.slice(0, -".lean".length);
  if (!withoutExtension) {
    return [];
  }

  const artifactBase = path.join(root, ".lake", "build", "lib", "lean", ...withoutExtension.split(/[\\/]+/));
  return [`${artifactBase}.olean`, `${artifactBase}.ilean`];
}

function leanAxiomDemandJobLabel(requests: readonly LeanAxiomCheckRequest[]): string {
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

function leanCheckStatusesEqual(
  first: LeanDeclarationCheckStatus | undefined,
  second: LeanDeclarationCheckStatus
): boolean {
  return Boolean(first) &&
    first!.checked === second.checked &&
    first!.ownChecked === second.ownChecked &&
    stringArraysEqual(first!.dependencies, second.dependencies) &&
    stringArraysEqual(first!.failedDependencies, second.failedDependencies) &&
    first!.reason === second.reason &&
    first!.inconclusive === second.inconclusive &&
    first!.blocked === second.blocked &&
    first!.stale === second.stale &&
    first!.generation === second.generation;
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
