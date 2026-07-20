import * as vscode from "vscode";
import * as path from "node:path";
import * as fs from "node:fs";
import { createHash } from "node:crypto";
import { spawn, ChildProcessWithoutNullStreams } from "node:child_process";
import { collectDiagnostics, DiagnosticIssue } from "./handwave/diagnostics";
import { buildTheoremExplorerPayload, HandwaveTheoremExplorerProvider } from "./handwave/explorer";
import { HandwaveIndex, isIndexedLeanDeclaration } from "./handwave/index";
import { parseLeanAxiomOutput } from "./handwave/leanAxiom";
import {
  applyLeanIleanArtifacts,
  LeanArtifactCacheFile,
  LeanArtifactExtraction,
  leanArtifactExtractorInput,
  leanArtifactExtractorSchemaVersion,
  parseLeanArtifactCache,
  parseLeanArtifactExtractorOutput
} from "./handwave/leanArtifacts";
import { LeanDependencyCheckBackend, shouldUseLeanServerDiagnostics } from "./handwave/leanCheck";
import { containsPosition } from "./handwave/position";
import {
  blankLeanCommentsAndStrings,
  isHandwaveNavigationTarget,
  normalizeHandwaveTag,
  parseArticleDocument,
  parseLeanDocument,
  parseTarget
} from "./handwave/parser";
import {
  leanDeclarationAnchorId,
  renderArticleHtml,
  renderCheckStatus,
  renderLeanDeclarationPreviewHtml,
  renderLeanDocumentHtml
} from "./handwave/renderer";
import { applySourceTextEdit, leanDeclarationTagToggleEdit } from "./handwave/tagEditor";
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

interface IndexedSourceUpdateOptions {
  leanMetadataOnly?: boolean;
  refreshTheoremExplorer?: boolean;
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

interface LeanAxiomDemand extends PrioritizedLeanDeclaration {
  group: number;
  depth: number;
  rank: number;
}

type LeanAxiomCheckReadiness =
  | { kind: "ready" }
  | { kind: "skip" }
  | { kind: "blocked"; reason: string };

type LeanAxiomProbeResult =
  | { ok: true; stdout: string; stderr: string; backend: LeanDependencyCheckBackend }
  | { ok: false; stdout: string; stderr: string; backend: LeanDependencyCheckBackend };

const priorityGroupStride = 1_000_000;
const priorityDepthStride = 1_000;
const visibleTheoremPriorityGroup = 0;
const dependencyPriorityGroup = 1;
const pendingPriorityRank = 0;
const stalePriorityRank = 1;
const knownPriorityRank = 2;
const coveredByGreenParentPriorityRank = 3;
const leanServerProbeRelativePath = path.join(".lake", "handwave", "AxiomProbe.lean");
const leanArtifactCacheRelativePath = path.join(".lake", "handwave", "artifact-index-v1.json");

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
  private readonly indexStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 101);
  private readonly leanProcessStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  private readonly theoremExplorerProvider: HandwaveTheoremExplorerProvider;
  private readonly previewPanels = new Map<string, HandwavePreviewState>();
  private readonly leanDiagnosticUrisSeen = new Set<string>();
  private readonly leanDiagnosticUrisRequested = new Set<string>();
  private readonly leanAxiomCheckStatuses = new Map<string, LeanDeclarationCheckStatus>();
  private readonly leanAxiomCheckQueue = new Map<string, LeanAxiomCheckQueueItem>();
  private readonly leanAxiomChecksRunning = new Set<string>();
  private readonly leanAxiomFailedGenerations = new Map<string, number>();
  private readonly theoremExplorerVisibleNames = new Set<string>();
  private theoremExplorerStatusHtml = new Map<string, string>();
  private readonly managedMetadataDocumentEdits = new Set<string>();
  private theoremExplorerVisibleKey = "";
  private declarations: LeanDeclaration[] = [];
  private articles: ArticleDocument[] = [];
  private index = new HandwaveIndex("", [], []);
  private rebuildTimer: NodeJS.Timeout | undefined;
  private documentUpdateTimer: NodeJS.Timeout | undefined;
  private diagnosticUpdateTimer: NodeJS.Timeout | undefined;
  private theoremExplorerRefreshTimer: NodeJS.Timeout | undefined;
  private axiomCheckTimer: NodeJS.Timeout | undefined;
  private compiledLeanChangeTimer: NodeJS.Timeout | undefined;
  private compiledLeanPollTimer: NodeJS.Timeout | undefined;
  private indexStatusTimer: NodeJS.Timeout | undefined;
  private indexStatusStartedAt: number | undefined;
  private leanProcessStatusTimer: NodeJS.Timeout | undefined;
  private leanProcessStartedAt: number | undefined;
  private leanProcessStatusLabel: string | undefined;
  private leanProcessTimeoutMs: number | undefined;
  private activeLeanAxiomProbeAbort: AbortController | undefined;
  private isIndexing = false;
  private isFlushingAxiomChecks = false;
  private leanAxiomQueueDirty = false;
  private leanAxiomCheckGeneration = 0;
  private indexGeneration = 0;
  private activeRebuildGeneration: number | undefined;
  private compiledLeanArtifactsSnapshot: string | undefined;
  private readonly managedSourceWrites = new Map<string, number>();
  private leanArtifactDependencyGraph = new Map<string, string[]>();
  private managedLeanArtifactRefreshUntil = 0;
  private nextPreviewKey = 1;

  readonly onDidChangeCodeLenses = this.codeLensEmitter.event;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.theoremExplorerProvider = new HandwaveTheoremExplorerProvider(
      () => this.theoremExplorerPayload(),
      (name) => this.theoremExplorerPreview(name),
      (target) => this.openPreviewTarget(target),
      (target, tag) => this.toggleLeanDeclarationTag(target, tag),
      (names) => this.updateTheoremExplorerVisibleTheorems(names)
    );
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
      this.indexStatusBar,
      this.leanProcessStatusBar,
      this.theoremExplorerProvider,
      vscode.window.registerWebviewViewProvider("handwave.theoremExplorer", this.theoremExplorerProvider),
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
          if (isLeanUri(event.document.uri) && this.managedMetadataDocumentEdits.has(event.document.uri.fsPath)) {
            return;
          }
          if (isLeanUri(event.document.uri)) {
            this.markLeanAxiomChecksStale();
          }
          this.scheduleDocumentUpdate(event.document);
        }
      }),
      vscode.workspace.onDidSaveTextDocument((document) => {
        if (isLeanOrArticle(document.uri)) {
          if (isLeanUri(document.uri) && this.managedMetadataDocumentEdits.has(document.uri.fsPath)) {
            return;
          }
          if (isLeanUri(document.uri)) {
            this.markLeanAxiomChecksStale();
          }
          void this.updateIndexedDocument(document);
        }
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("handwave")) {
          this.clearLeanAxiomChecks();
          void this.rebuildIndex();
        }
      }),
      vscode.languages.onDidChangeDiagnostics((event) => {
        if (!this.usesLeanServerDiagnostics()) {
          return;
        }
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
      }),
      vscode.workspace.onDidGrantWorkspaceTrust(() => {
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
          if (this.isManagedSourceWrite(uri)) {
            return;
          }
          if (isLeanUri(uri)) {
            this.markLeanAxiomChecksStale();
          }
          const document = this.openTextDocumentForUri(uri);
          if (document) {
            this.scheduleDocumentUpdate(document);
            return;
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
    if (this.theoremExplorerRefreshTimer) {
      clearTimeout(this.theoremExplorerRefreshTimer);
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
    this.clearIndexStatus();
    this.cancelActiveLeanAxiomProbe();
    this.clearLeanProcessStatus();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    for (const state of this.previewPanels.values()) {
      state.panel.dispose();
    }
  }

  private scheduleFullRebuild(): void {
    this.indexGeneration++;
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
      this.refreshLeanStatusViews();
      void this.triggerLeanChecksForOpenPreviews();
    }, 500);
  }

  private scheduleCompiledLeanStatusRefresh(): void {
    if (Date.now() < this.managedLeanArtifactRefreshUntil) {
      return;
    }
    if (this.compiledLeanChangeTimer) {
      clearTimeout(this.compiledLeanChangeTimer);
    }
    this.compiledLeanChangeTimer = setTimeout(() => {
      this.compiledLeanChangeTimer = undefined;
      this.compiledLeanArtifactsSnapshot =
        this.compiledLeanArtifactSnapshotForOpenPreviews() ?? this.compiledLeanArtifactsSnapshot;
      this.markLeanAxiomChecksStale();
      const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
      if (workspaceFolders.length > 0) {
        void this.refreshLeanArtifactMetadata(workspaceFolders).then(() =>
          this.triggerLeanChecksForOpenPreviews()
        );
      }
    }, 750);
  }

  private openTextDocumentForUri(uri: vscode.Uri): vscode.TextDocument | undefined {
    return vscode.workspace.textDocuments.find((document) =>
      document.uri.scheme === uri.scheme && document.uri.fsPath === uri.fsPath
    );
  }

  private markManagedSourceWrite(uri: vscode.Uri): void {
    const until = Date.now() + 3000;
    this.managedSourceWrites.set(uri.fsPath, until);
    setTimeout(() => {
      if (this.managedSourceWrites.get(uri.fsPath) === until) {
        this.managedSourceWrites.delete(uri.fsPath);
      }
    }, 3000);
  }

  private isManagedSourceWrite(uri: vscode.Uri): boolean {
    const until = this.managedSourceWrites.get(uri.fsPath);
    if (!until) {
      return false;
    }
    if (Date.now() >= until) {
      this.managedSourceWrites.delete(uri.fsPath);
      return false;
    }
    return true;
  }

  private registerCompiledLeanArtifactWatchers(): void {
    const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
    const patterns = [
      ".lake/build/lib/lean/**/*.olean",
      ".lake/build/lib/lean/**/*.ilean",
      ".lake/build/lib/lean/**/*.trace"
    ];
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

  private beginIndexStatus(): void {
    if (this.indexStatusStartedAt === undefined) {
      this.indexStatusStartedAt = Date.now();
    }
    this.updateIndexStatus();
    if (!this.indexStatusTimer) {
      this.indexStatusTimer = setInterval(() => this.updateIndexStatus(), 1000);
    }
    this.indexStatusBar.show();
  }

  private updateIndexStatus(): void {
    if (this.indexStatusStartedAt === undefined) {
      return;
    }
    const elapsed = formatDuration(Date.now() - this.indexStatusStartedAt);
    this.indexStatusBar.text = `$(sync~spin) Handwave Indexing ${elapsed}`;
    this.indexStatusBar.tooltip = "Handwave is indexing Lean declarations and articles.";
  }

  private finishIndexing(rebuildGeneration: number): void {
    if (this.activeRebuildGeneration !== rebuildGeneration) {
      return;
    }
    this.activeRebuildGeneration = undefined;
    this.isIndexing = false;
    this.clearIndexStatus();
  }

  private clearIndexStatus(): void {
    if (this.indexStatusTimer) {
      clearInterval(this.indexStatusTimer);
      this.indexStatusTimer = undefined;
    }
    this.indexStatusStartedAt = undefined;
    this.indexStatusBar.hide();
  }

  async rebuildIndex(showNotification = false): Promise<void> {
    const rebuildGeneration = ++this.indexGeneration;
    this.activeRebuildGeneration = rebuildGeneration;
    this.isIndexing = true;
    this.beginIndexStatus();
    void this.refreshPreviews();
    try {
      const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
      if (workspaceFolders.length === 0) {
        this.finishIndexing(rebuildGeneration);
        this.declarations = [];
        this.articles = [];
        this.index = new HandwaveIndex("", [], []);
        this.diagnostics.clear();
        this.refreshTheoremExplorer();
        return;
      }

      const config = vscode.workspace.getConfiguration("handwave");
      const leanGlobs = config.get<string[]>("leanGlobs", ["**/*.lean"]);
      const articleGlobs = config.get<string[]>("articleGlobs", ["**/*.hw.md", "**/*.hw"]);
      const excludeGlob = config.get<string>("excludeGlob", "**/{node_modules,out,.git,.jj,.lake}/**");
      const leanUris = await findWorkspaceFiles(leanGlobs, workspaceFolders, excludeGlob);
      const articleUris = await findWorkspaceFiles(articleGlobs, workspaceFolders, excludeGlob);

      let declarations: LeanDeclaration[] = [];
      for (const uri of leanUris) {
        const text = await readWorkspaceText(uri);
        declarations.push(...parseLeanDocument(text, uri.fsPath));
      }
      declarations = declarations.filter(isIndexedLeanDeclaration);

      const artifactMetadata = await loadLeanArtifactMetadata(declarations, workspaceFolders);
      declarations = artifactMetadata.declarations;

      const articles: ArticleDocument[] = [];
      for (const uri of articleUris) {
        const text = await readWorkspaceText(uri);
        articles.push(parseArticleDocument(text, uri.fsPath));
      }

      if (rebuildGeneration !== this.indexGeneration) {
        if (this.activeRebuildGeneration === rebuildGeneration) {
          this.scheduleFullRebuild();
        }
        return;
      }

      this.declarations = declarations;
      this.articles = articles;
      this.leanArtifactDependencyGraph = artifactMetadata.dependencyGraph;
      this.pruneLeanAxiomChecks(declarations);
      await this.hydrateLeanArtifactCache(declarations, workspaceFolders);
      if (rebuildGeneration !== this.indexGeneration) {
        if (this.activeRebuildGeneration === rebuildGeneration) {
          this.scheduleFullRebuild();
        }
        return;
      }
      this.index = new HandwaveIndex(
        workspaceFolders.map((folder) => folder.uri.fsPath),
        declarations,
        articles,
        this.currentLeanCheckStatuses(declarations),
        this.leanArtifactDependencyGraph
      );

      if (config.get<boolean>("enableDiagnostics", true)) {
        this.publishDiagnostics(collectDiagnostics(this.index, declarations, articles));
      } else {
        this.diagnostics.clear();
      }

      this.finishIndexing(rebuildGeneration);
      this.codeLensEmitter.fire();
      this.refreshTheoremExplorer();
      void this.triggerLeanChecksForOpenPreviews();
      await this.refreshPreviews();

      if (showNotification) {
        void vscode.window.showInformationMessage(
          `Handwave indexed ${declarations.length} Lean declarations and ${articles.length} articles.`
        );
      }
    } finally {
      if (
        this.activeRebuildGeneration === rebuildGeneration &&
        this.rebuildTimer === undefined
      ) {
        this.finishIndexing(rebuildGeneration);
        void this.refreshPreviews();
      }
    }
  }

  private async updateIndexedDocument(
    document: vscode.TextDocument,
    options: IndexedSourceUpdateOptions = {}
  ): Promise<void> {
    await this.updateIndexedSource(document.uri, document.getText(), options);
  }

  private async updateIndexedSource(
    uri: vscode.Uri,
    text: string,
    options: IndexedSourceUpdateOptions = {}
  ): Promise<void> {
    this.indexGeneration++;
    const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
    if (workspaceFolders.length === 0) {
      return;
    }

    if (isArticleUri(uri)) {
      const article = parseArticleDocument(text, uri.fsPath);
      this.articles = replaceByUri(this.articles, article);
      this.rebuildCachedIndex(workspaceFolders);
      this.refreshDiagnostics();
      void this.triggerLeanChecksForIncludedTheorems([article]);
      this.codeLensEmitter.fire();
      await this.refreshPreviewsForUri(uri);
      return;
    }

    if (isLeanUri(uri)) {
      let declarations = parseLeanDocument(text, uri.fsPath)
        .filter(isIndexedLeanDeclaration);
      const previousDeclarations = this.declarations.filter((declaration) => declaration.uri === uri.fsPath);
      if (options.leanMetadataOnly) {
        declarations = declarations.map((declaration) => {
          const previous = previousDeclarations.find((candidate) =>
            candidate.name === declaration.name ||
            (candidate.isPrivate && declaration.isPrivate && candidate.sourceName === declaration.sourceName)
          );
          return previous
            ? {
              ...declaration,
              name: previous.name,
              artifactName: previous.artifactName,
              artifactModule: previous.artifactModule
            }
            : declaration;
        });
      } else {
        for (const declaration of previousDeclarations) {
          this.leanArtifactDependencyGraph.delete(declaration.name);
        }
      }
      this.declarations = [
        ...this.declarations.filter((declaration) => declaration.uri !== uri.fsPath),
        ...declarations
      ];
      this.rebuildCachedIndex(workspaceFolders, options.refreshTheoremExplorer ?? true);
      this.refreshDiagnostics();
      if (!options.leanMetadataOnly) {
        void this.triggerLeanChecksForOpenPreviews();
      }
      this.codeLensEmitter.fire();
      await this.refreshPreviews();
    }
  }

  private clearLeanAxiomChecks(): void {
    this.cancelActiveLeanAxiomProbe();
    this.leanAxiomCheckGeneration++;
    this.leanAxiomCheckStatuses.clear();
    this.leanAxiomCheckQueue.clear();
    this.leanAxiomChecksRunning.clear();
    this.leanAxiomFailedGenerations.clear();
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
    this.cancelActiveLeanAxiomProbe();
    this.leanAxiomCheckGeneration++;
    this.leanAxiomCheckQueue.clear();
    this.leanAxiomChecksRunning.clear();
    this.leanAxiomFailedGenerations.clear();
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
    await this.triggerLeanChecksForOpenPreviews();
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

  private async hydrateLeanArtifactCache(
    declarations: readonly LeanDeclaration[],
    workspaceFolders: readonly vscode.WorkspaceFolder[]
  ): Promise<void> {
    const caches = new Map<string, LeanArtifactCacheFile>();
    const fingerprints = new Map<string, string | undefined>();
    const validExtractions = new Map<string, LeanArtifactExtraction>();

    for (const declaration of declarations) {
      if (!isTheoremLikeDeclaration(declaration) || !declaration.artifactName || !declaration.artifactModule) {
        continue;
      }
      if (openLeanDocumentIsDirty(declaration.uri)) {
        continue;
      }
      const root = workspaceRootForFile(declaration.uri, workspaceFolders);
      if (!root) {
        continue;
      }

      let cache = caches.get(root);
      if (!cache) {
        cache = await readLeanArtifactCache(root);
        caches.set(root, cache);
      }
      const entry = cache.entries[declaration.artifactName];
      if (!entry || entry.module !== declaration.artifactModule) {
        continue;
      }

      let fingerprint = fingerprints.get(declaration.uri);
      if (!fingerprints.has(declaration.uri)) {
        fingerprint = leanTraceFingerprint(declaration.uri, root);
        fingerprints.set(declaration.uri, fingerprint);
      }
      if (!fingerprint || entry.traceFingerprint !== fingerprint) {
        continue;
      }

      const hasSorry = entry.axioms.includes("sorryAx");
      const directSorry = entry.valueConstants.includes("sorryAx");
      this.leanAxiomCheckStatuses.set(declaration.name, {
        checked: !hasSorry,
        ownChecked: !directSorry,
        dependencies: entry.axioms,
        failedDependencies: hasSorry ? ["sorryAx"] : [],
        stale: false,
        generation: this.leanAxiomCheckGeneration,
        reason: hasSorry
          ? "Lean's cached build artifacts report a transitive dependency on sorryAx."
          : "Lean's cached build artifacts report no transitive dependency on sorryAx."
      });
      validExtractions.set(declaration.artifactName, entry);
    }
    this.mergeLeanArtifactExtractionDependencies(validExtractions);
  }

  private mergeLeanArtifactExtractionDependencies(
    extractions: ReadonlyMap<string, LeanArtifactExtraction>
  ): void {
    const byArtifactName = new Map<string, LeanDeclaration>();
    for (const declaration of this.declarations) {
      if (declaration.artifactName && isTheoremLikeDeclaration(declaration)) {
        byArtifactName.set(declaration.artifactName, declaration);
      }
    }

    for (const [artifactName, extraction] of extractions) {
      const declaration = byArtifactName.get(artifactName);
      if (!declaration) {
        continue;
      }
      const existing = this.leanArtifactDependencyGraph.get(declaration.name) ?? [];
      const dependencies = new Set(existing);
      for (const constant of [...extraction.typeConstants, ...extraction.valueConstants]) {
        const dependency = byArtifactName.get(constant);
        if (dependency && dependency.name !== declaration.name) {
          dependencies.add(dependency.name);
        }
      }
      this.leanArtifactDependencyGraph.set(declaration.name, [...dependencies]);
    }
  }

  private async refreshLeanArtifactMetadata(
    workspaceFolders: readonly vscode.WorkspaceFolder[]
  ): Promise<void> {
    // Lake has just validated these artifacts by content hash, so mtimes are
    // irrelevant (for example after touching an otherwise unchanged source).
    const metadata = await loadLeanArtifactMetadata(this.declarations, workspaceFolders, false);
    const dependencyGraphChanged = !stringArrayMapsEqual(
      this.leanArtifactDependencyGraph,
      metadata.dependencyGraph
    );
    this.declarations = metadata.declarations;
    this.leanArtifactDependencyGraph = metadata.dependencyGraph;
    this.rebuildCachedIndex(workspaceFolders, dependencyGraphChanged);
  }

  private async persistLeanArtifactExtractions(
    root: string,
    requests: readonly LeanAxiomCheckRequest[],
    extractions: ReadonlyMap<string, LeanArtifactExtraction>
  ): Promise<void> {
    if (extractions.size === 0) {
      return;
    }
    const cache = await readLeanArtifactCache(root);
    for (const request of requests) {
      const declaration = this.declarations.find((candidate) => candidate.name === request.declaration.name) ??
        request.declaration;
      if (!declaration.artifactName || !declaration.artifactModule) {
        continue;
      }
      const extraction = extractions.get(declaration.artifactName);
      const traceFingerprint = leanTraceFingerprint(declaration.uri, root);
      if (!extraction || !traceFingerprint) {
        continue;
      }
      cache.entries[declaration.artifactName] = {
        ...extraction,
        module: declaration.artifactModule,
        traceFingerprint
      };
    }
    await writeLeanArtifactCache(root, cache);
  }

  private rebuildCachedIndex(
    workspaceFolders: readonly vscode.WorkspaceFolder[],
    refreshTheoremExplorer = true
  ): void {
    this.index = new HandwaveIndex(
      workspaceFolders.map((folder) => folder.uri.fsPath),
      this.declarations,
      this.articles,
      this.currentLeanCheckStatuses(this.declarations),
      this.leanArtifactDependencyGraph
    );
    if (refreshTheoremExplorer) {
      this.refreshTheoremExplorer();
    }
  }

  private theoremExplorerPayload() {
    const workspaceRoots = (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath);
    const payload = buildTheoremExplorerPayload(this.index, this.declarations, workspaceRoots);
    this.theoremExplorerStatusHtml = new Map(
      payload.theorems.map((theorem) => [theorem.name, theorem.statusHtml])
    );
    return payload;
  }

  private theoremExplorerPreview(name: string): string | undefined {
    const declaration = this.index.leanDeclarations.get(name);
    if (!declaration || !isTheoremLikeDeclaration(declaration)) {
      return undefined;
    }
    return renderLeanDeclarationPreviewHtml(
      declaration,
      this.index,
      () => "#",
      () => "#"
    );
  }

  private refreshTheoremExplorerStatuses(): void {
    const nextStatuses = new Map<string, string>();
    const updates: Array<{ name: string; statusHtml: string }> = [];
    for (const declaration of this.declarations) {
      if (!isIndexedLeanDeclaration(declaration) || !isTheoremLikeDeclaration(declaration)) {
        continue;
      }
      const statusHtml = renderCheckStatus(this.index.checkStatusForLean(declaration.name));
      nextStatuses.set(declaration.name, statusHtml);
      if (this.theoremExplorerStatusHtml.get(declaration.name) !== statusHtml) {
        updates.push({ name: declaration.name, statusHtml });
      }
    }
    this.theoremExplorerStatusHtml = nextStatuses;
    this.theoremExplorerProvider.setStatuses(updates);
  }

  private refreshTheoremExplorer(): void {
    if (this.theoremExplorerRefreshTimer) {
      clearTimeout(this.theoremExplorerRefreshTimer);
    }
    this.theoremExplorerRefreshTimer = setTimeout(() => {
      this.theoremExplorerRefreshTimer = undefined;
      this.theoremExplorerProvider.refresh();
    }, 50);
  }

  private async updateTheoremExplorerVisibleTheorems(names: readonly string[]): Promise<void> {
    const nextNames = [...new Set(names)].sort();
    const nextKey = nextNames.join("\n");
    if (nextKey === this.theoremExplorerVisibleKey) {
      return;
    }

    this.theoremExplorerVisibleKey = nextKey;
    this.theoremExplorerVisibleNames.clear();
    for (const name of nextNames) {
      this.theoremExplorerVisibleNames.add(name);
    }

    const declarations = this.visibleTheoremDeclarationsForTheoremExplorer()
      .map((item) => item.declaration);
    if (declarations.length === 0) {
      this.refreshLeanAxiomDemandForOpenPreviews();
      return;
    }

    await this.triggerLeanChecksForDeclarations(declarations, false);
  }

  private currentLeanCheckStatuses(declarations: readonly LeanDeclaration[]): Map<string, LeanDeclarationCheckStatus> {
    const config = vscode.workspace.getConfiguration("handwave");
    const dependencyChecksEnabled = config.get<boolean>("enableLeanDependencyChecks", true);
    const statuses = this.usesLeanServerDiagnostics()
      ? collectLeanDiagnosticCheckStatuses(declarations, this.leanDiagnosticUrisSeen)
      : collectLeanSourceCheckStatuses(declarations);
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

  private async triggerLeanChecksForIncludedTheorems(
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
      await this.triggerLeanChecksForDeclarations(
        [...theoremDeclarations.values()]
      );
    }
  }

  private async triggerLeanChecksForDeclarations(
    declarations: readonly LeanDeclaration[],
    refreshViews = true
  ): Promise<void> {
    // Opening a hidden Lean document activates a Lean LSP file worker. Keep the
    // default subprocess backend independent of the language server.
    if (this.usesLeanServerDiagnostics()) {
      await this.openLeanDocumentsForDeclarations(declarations);
    }
    if (refreshViews) {
      this.refreshLeanStatusViews();
    }
    this.refreshLeanAxiomDemandForOpenPreviews();
  }

  private usesLeanServerDiagnostics(): boolean {
    const config = vscode.workspace.getConfiguration("handwave");
    return shouldUseLeanServerDiagnostics(
      config.get<boolean>("enableLeanDependencyChecks", true),
      leanDependencyCheckBackend(config)
    );
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
        this.leanDiagnosticUrisSeen.add(uri.fsPath);
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
    this.rebuildCachedIndex(workspaceFolders, false);
    this.refreshTheoremExplorerStatuses();
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
    const backend = leanDependencyCheckBackend(config);
    const diagnosticStatuses = backend === "leanServer"
      ? collectLeanDiagnosticCheckStatuses(
        visible.map((item) => item.declaration),
        this.leanDiagnosticUrisSeen
      )
      : new Map<string, LeanDeclarationCheckStatus>();

    for (const { declaration, priority } of visible) {
      const readiness = this.leanAxiomCheckReadiness(
        declaration,
        workspaceFolders,
        diagnosticStatuses,
        backend
      );
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
    diagnosticStatuses: ReadonlyMap<string, LeanDeclarationCheckStatus>,
    backend: LeanDependencyCheckBackend
  ): LeanAxiomCheckReadiness {
    if (!vscode.workspace.isTrusted) {
      return {
        kind: "blocked",
        reason: "Handwave does not execute Lean or Lake in an untrusted workspace."
      };
    }

    if (this.leanAxiomFailedGenerations.get(declaration.name) === this.leanAxiomCheckGeneration) {
      return { kind: "skip" };
    }
    if (backend === "leanServer") {
      const diagnosticStatus = diagnosticStatuses.get(declaration.name);
      if (diagnosticStatus && !diagnosticStatus.checked) {
        return { kind: "skip" };
      }
    }

    const status = this.index.checkStatusForLean(declaration.name);
    if (status && !status.stale && !status.blocked) {
      return { kind: "skip" };
    }

    if (backend === "leanServer" && leanFileHasBlockingDiagnostics(declaration.uri)) {
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

    const batchSize = Math.max(1, Math.floor(config.get<number>("leanDependencyCheckBatchSize", 1024)));
    const requests: LeanAxiomCheckRequest[] = [];
    let selectedRoot: string | undefined;
    const selectedUris = new Set<string>();
    let selectedRequiresSourceProbe = false;
    let blockedChanged = false;

    for (const { declaration, priority } of candidates) {
      const target = leanAxiomProbeTarget(declaration.uri, workspaceFolders);
      if (!target) {
        this.leanAxiomCheckQueue.delete(declaration.name);
        blockedChanged = this.recordBlockedLeanAxiomStatus(
          declaration,
          "Handwave cannot run the Lean dependency check because this declaration is not in a Lean module under a workspace root."
        ) || blockedChanged;
        continue;
      }
      if (selectedRoot !== undefined && selectedRoot !== target.root) {
        continue;
      }
      const requiresSourceProbe = leanAxiomJobRequiresSourceIsolation(declaration);
      if (
        (selectedRequiresSourceProbe && !selectedUris.has(declaration.uri)) ||
        (requiresSourceProbe &&
          selectedUris.size > 0 &&
          (selectedUris.size > 1 || !selectedUris.has(declaration.uri)))
      ) {
        continue;
      }

      selectedRoot = target.root;
      selectedUris.add(declaration.uri);
      selectedRequiresSourceProbe = selectedRequiresSourceProbe || requiresSourceProbe;

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
      if (blockedChanged) {
        this.refreshLeanStatusViews();
      }
      return undefined;
    }

    requests.sort(compareLeanAxiomCheckRequests);
    if (blockedChanged) {
      this.refreshLeanStatusViews();
    }
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

        if (this.usesLeanServerDiagnostics()) {
          await this.openLeanDocumentsForDeclarations(job.requests.map((request) => request.declaration));
        }
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
    const backend = leanDependencyCheckBackend(config);
    const abortController = new AbortController();
    this.activeLeanAxiomProbeAbort = abortController;
    this.beginLeanProcessStatus(job.label, timeoutMs);
    let activeRequests = requests;
    let result: LeanAxiomProbeResult | undefined;
    let usedArtifactExtractor = false;
    try {
      const canUseArtifacts = backend === "subprocess" &&
        requests.every((request) => !leanAxiomJobRequiresSourceIsolation(request.declaration));
      if (canUseArtifacts && config.get<boolean>("autoBuildLeanArtifacts", true)) {
        const buildTimeoutMs = config.get<number>("leanArtifactBuildTimeoutMs", 600000);
        this.managedLeanArtifactRefreshUntil = Number.MAX_SAFE_INTEGER;
        let buildResult: { ok: boolean; stdout: string; stderr: string };
        try {
          buildResult = await runLakeBuildForDeclarations(
            root,
            requests.map((request) => request.declaration),
            buildTimeoutMs,
            abortController.signal
          );
        } finally {
          this.compiledLeanArtifactsSnapshot =
            this.compiledLeanArtifactSnapshotForOpenPreviews() ?? this.compiledLeanArtifactsSnapshot;
        }
        if (!buildResult.ok) {
          result = { ...buildResult, backend: "subprocess" };
        } else {
          await this.refreshLeanArtifactMetadata(workspaceFolders);
          activeRequests = requests.map((request) => ({
            ...request,
            declaration: this.declarations.find((candidate) => candidate.name === request.declaration.name) ??
              request.declaration
          }));
        }
      }

      if (!result) {
        const artifactInput = canUseArtifacts
          ? leanArtifactInputForRequests(activeRequests)
          : undefined;
        const input = artifactInput ?? await leanAxiomProbeInput(root, activeRequests);
        usedArtifactExtractor = artifactInput !== undefined;
        result = await runLeanAxiomProbe(
          root,
          input,
          activeRequests,
          timeoutMs,
          backend,
          abortController.signal
        );
      }
    } catch (error) {
      result = {
        ok: false,
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
        backend
      };
    } finally {
      if (this.managedLeanArtifactRefreshUntil === Number.MAX_SAFE_INTEGER) {
        this.managedLeanArtifactRefreshUntil = Date.now() + 2500;
      }
      if (this.activeLeanAxiomProbeAbort === abortController) {
        this.activeLeanAxiomProbeAbort = undefined;
      }
      this.clearLeanProcessStatus();
    }

    const combinedOutput = `${result.stdout}\n${result.stderr}`;
    const extractions = parseLeanArtifactExtractorOutput(combinedOutput);
    this.mergeLeanArtifactExtractionDependencies(extractions);
    const axiomsByName = parseLeanAxiomOutput(combinedOutput);
    let changed = false;
    try {
      for (const request of activeRequests) {
        const name = request.declaration.name;
        if (!this.isCurrentAxiomRequest(request)) {
          continue;
        }
        const extraction = request.declaration.artifactName
          ? extractions.get(request.declaration.artifactName)
          : undefined;
        const axioms = extraction?.axioms ?? axiomsForDeclaration(axiomsByName, request.declaration);
        if (!axioms) {
          this.leanAxiomFailedGenerations.set(name, this.leanAxiomCheckGeneration);
          changed = this.recordInconclusiveLeanAxiomStatus(
            request,
            result.ok
              ? "The Lean dependency check finished, but did not report an axiom status for this declaration."
              : "Handwave could not finish the Lean dependency check for this declaration."
          ) || changed;
          continue;
        }

        const hasSorry = axioms.includes("sorryAx");
        const directSorry = extraction?.valueConstants.includes("sorryAx") ?? false;
        const backendLabel = usedArtifactExtractor
          ? "Lean artifact extractor"
          : leanAxiomProbeBackendLabel(result.backend);
        const nextStatus = {
          checked: !hasSorry,
          ownChecked: !directSorry,
          dependencies: axioms,
          failedDependencies: hasSorry ? ["sorryAx"] : [],
          stale: false,
          generation: this.leanAxiomCheckGeneration,
          reason: hasSorry
            ? `${backendLabel} checks this declaration, but a transitive dependency still depends on sorryAx.`
            : `${backendLabel} reports no transitive dependency on sorryAx.`
        };
        const previous = this.leanAxiomCheckStatuses.get(name);
        this.leanAxiomCheckStatuses.set(name, {
          ...nextStatus
        });
        this.leanAxiomFailedGenerations.delete(name);
        changed = changed || !leanCheckStatusesEqual(previous, nextStatus);
      }
      if (usedArtifactExtractor) {
        await this.persistLeanArtifactExtractions(root, activeRequests, extractions);
      }
      return changed;
    } finally {
      for (const request of requests) {
        this.leanAxiomChecksRunning.delete(request.declaration.name);
      }
    }
  }

  private recordInconclusiveLeanAxiomStatus(request: LeanAxiomCheckRequest, reason: string): boolean {
    if (!this.isCurrentAxiomRequest(request)) {
      return false;
    }

    const previous = this.leanAxiomCheckStatuses.get(request.declaration.name);
    if (isInformativeLeanAxiomStatus(previous)) {
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
    this.leanAxiomCheckStatuses.set(request.declaration.name, nextStatus);
    return !leanCheckStatusesEqual(previous, nextStatus);
  }

  private recordBlockedLeanAxiomStatus(declaration: LeanDeclaration, reason: string): boolean {
    const previous = this.leanAxiomCheckStatuses.get(declaration.name);
    if (isInformativeLeanAxiomStatus(previous)) {
      return false;
    }

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

  private cancelActiveLeanAxiomProbe(): void {
    if (!this.activeLeanAxiomProbeAbort) {
      return;
    }

    this.activeLeanAxiomProbeAbort.abort();
    this.activeLeanAxiomProbeAbort = undefined;
  }

  private isCurrentAxiomRequest(request: LeanAxiomCheckRequest): boolean {
    return request.generation === this.leanAxiomCheckGeneration &&
      this.leanAxiomChecksRunning.has(request.declaration.name);
  }

  private async triggerLeanChecksForOpenPreviews(): Promise<void> {
    for (const state of this.previewPanels.values()) {
      await this.triggerLeanChecksForPreview(state);
    }
  }

  provideDocumentLinks(document: vscode.TextDocument): vscode.DocumentLink[] {
    const article = parseArticleDocument(document.getText(), document.uri.fsPath);
    return [...article.links, ...article.includes].map((ref) => {
      const target = ref.target;
      const handwaveNavigation = isHandwaveNavigationTarget(target);
      const link = new vscode.DocumentLink(
        toVsCodeRange(ref.targetRange),
        handwaveNavigation
          ? commandUri("handwave.openPreviewTarget", target, document.uri.fsPath)
          : vscode.Uri.parse(target)
      );
      link.tooltip = handwaveNavigation ? `Preview ${target}` : `Open ${target}`;
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

      if (!isHandwaveNavigationTarget(ref.target)) {
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
      void this.triggerLeanChecksForPreview(existing);
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
    void this.triggerLeanChecksForPreview(state);
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
    void this.triggerLeanChecksForPreview(state);
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
      tag?: unknown;
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
      void this.triggerLeanChecksForPreview(state);
      await this.renderPreview(state, { inPlace: true, focus: true });
      return;
    }

    if (data.type === "toggleTag" && typeof data.target === "string" && typeof data.tag === "string") {
      void this.toggleLeanDeclarationTag(data.target, data.tag);
      return;
    }

    if (data.type === "copy" && typeof data.text === "string") {
      await vscode.env.clipboard.writeText(data.text);
    }
  }

  private async toggleLeanDeclarationTag(rawTarget: string, rawTag: string): Promise<void> {
    const tag = normalizeHandwaveTag(rawTag);
    const target = parseTarget(rawTarget);
    if (!tag || target.kind !== "lean") {
      void vscode.window.showWarningMessage(`Handwave cannot toggle tag ${rawTag} for ${rawTarget}.`);
      return;
    }

    const indexedDeclaration = this.index.leanDeclarations.get(target.base);
    if (!indexedDeclaration || !isTheoremLikeDeclaration(indexedDeclaration)) {
      void vscode.window.showWarningMessage(`Handwave theorem not found: ${rawTarget}`);
      return;
    }

    const uri = vscode.Uri.file(indexedDeclaration.uri);
    const document = this.openTextDocumentForUri(uri);
    let source: string;
    try {
      source = document?.getText() ??
        Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf8");
    } catch (error) {
      void vscode.window.showWarningMessage(`Handwave could not read ${uri.fsPath}: ${String(error)}`);
      return;
    }

    const sourceEdit = leanDeclarationTagToggleEdit(source, uri.fsPath, indexedDeclaration.name, tag);
    if (!sourceEdit) {
      void vscode.window.showWarningMessage(`Handwave theorem not found: ${rawTarget}`);
      return;
    }

    if (!document) {
      const updatedSource = applySourceTextEdit(source, sourceEdit);
      try {
        this.markManagedSourceWrite(uri);
        await vscode.workspace.fs.writeFile(uri, Buffer.from(updatedSource, "utf8"));
      } catch (error) {
        this.managedSourceWrites.delete(uri.fsPath);
        void vscode.window.showWarningMessage(`Handwave could not update tags for ${rawTarget}: ${String(error)}`);
        return;
      }

      await this.updateIndexedSource(uri, updatedSource, {
        leanMetadataOnly: true,
        refreshTheoremExplorer: false
      });
      const updatedDeclaration = this.index.leanDeclarations.get(indexedDeclaration.name);
      this.theoremExplorerProvider.setTag(
        `lean:${indexedDeclaration.name}`,
        tag,
        Boolean(updatedDeclaration?.doc?.tags.includes(tag))
      );
      return;
    }

    const wasDirty = document.isDirty;
    if (!wasDirty) {
      this.managedMetadataDocumentEdits.add(uri.fsPath);
    }
    try {
      const edit = new vscode.WorkspaceEdit();
      edit.replace(
        uri,
        new vscode.Range(document.positionAt(sourceEdit.start), document.positionAt(sourceEdit.end)),
        sourceEdit.text
      );
      const applied = await vscode.workspace.applyEdit(edit);
      if (!applied) {
        void vscode.window.showWarningMessage(`Handwave could not update tags for ${rawTarget}.`);
        return;
      }

      await this.updateIndexedDocument(document, wasDirty
        ? {}
        : { leanMetadataOnly: true, refreshTheoremExplorer: false });
      if (!wasDirty) {
        const updatedDeclaration = this.index.leanDeclarations.get(indexedDeclaration.name);
        this.theoremExplorerProvider.setTag(
          `lean:${indexedDeclaration.name}`,
          tag,
          Boolean(updatedDeclaration?.doc?.tags.includes(tag))
        );
        this.markManagedSourceWrite(uri);
        if (!(await document.save())) {
          void vscode.window.showWarningMessage(`Handwave updated tags for ${rawTarget}, but could not save the file.`);
        }
      }
    } finally {
      this.managedMetadataDocumentEdits.delete(uri.fsPath);
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
      void this.triggerLeanChecksForPreview(state);
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
    void this.triggerLeanChecksForPreview(nextState);
    await this.renderPreview(nextState, { focus: true });
  }

  private async triggerLeanChecksForPreview(state: HandwavePreviewState): Promise<void> {
    const declarations = this.visibleTheoremDeclarationsForPreviewState(state)
      .map((item) => item.declaration);
    if (declarations.length === 0) {
      return;
    }
    await this.triggerLeanChecksForDeclarations(declarations);
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
    for (const item of this.visibleTheoremDeclarationsForTheoremExplorer()) {
      const existing = result.get(item.declaration.name);
      if (!existing || item.priority < existing.priority) {
        result.set(item.declaration.name, item);
      }
    }
    return [...result.values()].sort(comparePrioritizedLeanDeclarations);
  }

  private visibleTheoremDeclarationsForTheoremExplorer(): PrioritizedLeanDeclaration[] {
    const declarations: LeanDeclaration[] = [];
    for (const name of this.theoremExplorerVisibleNames) {
      const declaration = this.index.leanDeclarations.get(name);
      if (!declaration || !isTheoremLikeDeclaration(declaration)) {
        continue;
      }
      declarations.push(declaration);
    }
    const depths = this.visibleTheoremTopologicalDepths(declarations);
    return declarations
      .map((declaration) => this.leanAxiomDemand(
        declaration,
        visibleTheoremPriorityGroup,
        depths.get(declaration.name) ?? 0,
        false
      ))
      .sort(comparePrioritizedLeanDeclarations);
  }

  private visibleTheoremDeclarationsForPreviewState(
    state: HandwavePreviewState
  ): PrioritizedLeanDeclaration[] {
    const topLevelDeclarations = this.theoremDeclarationsForPreviewState(state);
    const topLevelNames = new Set(topLevelDeclarations.map((declaration) => declaration.name));
    const topLevelDepths = this.visibleTheoremTopologicalDepths(topLevelDeclarations);
    const demands = new Map<string, LeanAxiomDemand>();
    const recordDemand = (
      declaration: LeanDeclaration,
      group: number,
      depth: number,
      coveredByGreenAncestor: boolean
    ): boolean => {
      const demand = this.leanAxiomDemand(declaration, group, depth, coveredByGreenAncestor);
      const existing = demands.get(declaration.name);
      if (existing && !shouldReplaceLeanAxiomDemand(existing, demand)) {
        return false;
      }
      demands.set(declaration.name, demand);
      return true;
    };
    const visit = (
      declaration: LeanDeclaration,
      group: number,
      depth: number,
      path: ReadonlySet<string>,
      coveredByGreenAncestor: boolean
    ) => {
      if (!recordDemand(declaration, group, depth, coveredByGreenAncestor)) {
        return;
      }

      const parentStatus = this.index.checkStatusForLean(declaration.name);
      const nextCoveredByGreenAncestor = coveredByGreenAncestor || Boolean(parentStatus?.checked);
      for (const dependencyName of this.index.dependenciesForLean(declaration.name)) {
        const dependency = this.index.leanDeclarations.get(dependencyName);
        if (
          !dependency ||
          !isTheoremLikeDeclaration(dependency)
        ) {
          continue;
        }
        const status = this.index.checkStatusForLean(dependency.name);
        const dependencyGroup = topLevelNames.has(dependency.name)
          ? visibleTheoremPriorityGroup
          : dependencyPriorityGroup;
        const dependencyDepth = Math.max(depth + 1, topLevelDepths.get(dependency.name) ?? 0);
        const dependencyCoveredByGreenAncestor =
          dependencyGroup === dependencyPriorityGroup && nextCoveredByGreenAncestor;
        if ((!status || !status.checked) && !path.has(dependency.name)) {
          visit(
            dependency,
            dependencyGroup,
            dependencyDepth,
            new Set([...path, dependency.name]),
            dependencyCoveredByGreenAncestor
          );
          continue;
        }

        recordDemand(
          dependency,
          dependencyGroup,
          dependencyDepth,
          dependencyCoveredByGreenAncestor
        );
      }
    };

    for (const declaration of topLevelDeclarations) {
      visit(
        declaration,
        visibleTheoremPriorityGroup,
        topLevelDepths.get(declaration.name) ?? 0,
        new Set([declaration.name]),
        false
      );
    }

    return [...demands.values()]
      .sort(comparePrioritizedLeanDeclarations);
  }

  private leanAxiomDemand(
    declaration: LeanDeclaration,
    group: number,
    depth: number,
    coveredByGreenAncestor: boolean
  ): LeanAxiomDemand {
    const rank = leanAxiomDemandPriorityRank(
      this.index.checkStatusForLean(declaration.name),
      coveredByGreenAncestor
    );
    return {
      declaration,
      group,
      depth,
      rank,
      priority: leanAxiomDemandPriority(group, depth, rank)
    };
  }

  private visibleTheoremTopologicalDepths(declarations: readonly LeanDeclaration[]): Map<string, number> {
    const names = new Set(declarations.map((declaration) => declaration.name));
    const depths = new Map<string, number>();
    const visit = (declaration: LeanDeclaration, depth: number, path: ReadonlySet<string>) => {
      const existing = depths.get(declaration.name);
      if (existing !== undefined && existing >= depth) {
        return;
      }
      depths.set(declaration.name, depth);
      for (const dependencyName of this.index.dependenciesForLean(declaration.name)) {
        if (!names.has(dependencyName) || path.has(dependencyName)) {
          continue;
        }
        const dependency = this.index.leanDeclarations.get(dependencyName);
        if (!dependency || !isTheoremLikeDeclaration(dependency)) {
          continue;
        }
        visit(dependency, depth + 1, new Set([...path, dependencyName]));
      }
    };

    for (const declaration of declarations) {
      visit(declaration, 0, new Set([declaration.name]));
    }

    return depths;
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
  leanDiagnosticUrisSeen: ReadonlySet<string>
): Map<string, LeanDeclarationCheckStatus> {
  const statuses = collectLeanSourceCheckStatuses(declarations);
  const diagnosticsByUri = new Map<string, vscode.Diagnostic[]>();

  for (const declaration of declarations) {
    if (!isTheoremLikeDeclaration(declaration)) {
      continue;
    }

    if (statuses.has(declaration.name)) {
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

function collectLeanSourceCheckStatuses(
  declarations: readonly LeanDeclaration[]
): Map<string, LeanDeclarationCheckStatus> {
  // These statuses must remain derivable without opening a document or asking
  // the Lean language server for diagnostics.
  const statuses = new Map<string, LeanDeclarationCheckStatus>();
  for (const declaration of declarations) {
    if (!isTheoremLikeDeclaration(declaration)) {
      continue;
    }
    const directIncompleteStatus = directIncompleteProofStatus(declaration);
    if (directIncompleteStatus) {
      statuses.set(declaration.name, directIncompleteStatus);
    }
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

function leanAxiomDemandPriority(group: number, depth: number, rank: number): number {
  return group * priorityGroupStride + depth * priorityDepthStride + rank;
}

function shouldReplaceLeanAxiomDemand(existing: LeanAxiomDemand, candidate: LeanAxiomDemand): boolean {
  if (candidate.group !== existing.group) {
    return candidate.group < existing.group;
  }
  if (candidate.depth !== existing.depth) {
    return candidate.depth > existing.depth;
  }
  return candidate.rank < existing.rank;
}

function leanAxiomDemandPriorityRank(
  status: LeanDeclarationCheckStatus | undefined,
  coveredByGreenAncestor: boolean
): number {
  if (!status || status.blocked) {
    return coveredByGreenAncestor
      ? coveredByGreenParentPriorityRank
      : pendingPriorityRank;
  }
  if (status.stale) {
    return stalePriorityRank;
  }
  return knownPriorityRank;
}

function compareLeanAxiomCheckRequests(
  first: LeanAxiomCheckRequest,
  second: LeanAxiomCheckRequest
): number {
  return first.priority - second.priority ||
    first.declaration.name.localeCompare(second.declaration.name);
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

function leanArtifactInputForRequests(
  requests: readonly LeanAxiomCheckRequest[]
): string | undefined {
  const modules: string[] = [];
  const artifactNames: string[] = [];
  for (const request of requests) {
    const { artifactModule, artifactName } = request.declaration;
    if (!artifactModule || !artifactName) {
      return undefined;
    }
    modules.push(artifactModule);
    artifactNames.push(artifactName);
  }
  return leanArtifactExtractorInput(modules, artifactNames);
}

async function leanAxiomProbeInput(
  root: string,
  requests: readonly LeanAxiomCheckRequest[]
): Promise<string> {
  if (requests.every((request) => !leanAxiomProbeRequiresSource(request.declaration, root))) {
    const importedInput = leanAxiomImportedProbeInput(root, requests);
    if (importedInput) {
      return importedInput;
    }
  }

  return leanAxiomSourceProbeInput(root, requests);
}

async function leanAxiomSourceProbeInput(
  root: string,
  requests: readonly LeanAxiomCheckRequest[]
): Promise<string> {
  const names = requests.map((request) => request.declaration.sourceName);
  const uniqueUris = [...new Set(requests.map((request) => request.declaration.uri))].sort();
  if (uniqueUris.length === 1) {
    const source = await readWorkspaceText(vscode.Uri.file(uniqueUris[0]));
    const prefix = source.slice(0, sourcePrefixEndOffset(source, requests));
    return [
      prefix,
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

function sourcePrefixEndOffset(
  source: string,
  requests: readonly LeanAxiomCheckRequest[]
): number {
  return Math.max(
    0,
    ...requests.map((request) => offsetAtPosition(source, request.declaration.range.end))
  );
}

function offsetAtPosition(source: string, position: PositionLike): number {
  let line = 0;
  let lineStart = 0;
  for (let offset = 0; offset < source.length && line < position.line; offset++) {
    if (source.charCodeAt(offset) === 10) {
      line++;
      lineStart = offset + 1;
    }
  }
  return Math.max(0, Math.min(source.length, lineStart + position.character));
}

function leanAxiomImportedProbeInput(
  root: string,
  requests: readonly LeanAxiomCheckRequest[]
): string | undefined {
  const moduleNames: string[] = [];
  for (const request of requests) {
    const moduleName = leanModuleNameForFile(request.declaration.uri, root);
    if (!moduleName) {
      return undefined;
    }
    moduleNames.push(moduleName);
  }
  const uniqueModuleNames = [...new Set(moduleNames)].sort();

  return [
    ...uniqueModuleNames.map((moduleName) => `import ${moduleName}`),
    "",
    ...requests.map((request) => `#print axioms ${request.declaration.sourceName}`),
    ""
  ].join("\n");
}

function leanAxiomProbeRequiresSource(declaration: LeanDeclaration, root: string): boolean {
  return leanAxiomJobRequiresSourceIsolation(declaration) ||
    !leanCompiledOleanIsFreshForSource(declaration.uri, root) ||
    (declaration.isPrivate && !declaration.artifactName);
}

function leanAxiomJobRequiresSourceIsolation(declaration: LeanDeclaration): boolean {
  return openLeanDocumentIsDirty(declaration.uri);
}

function leanCompiledOleanIsFreshForSource(fsPath: string, root: string): boolean {
  const openDocument = vscode.workspace.textDocuments.find((document) =>
    document.uri.scheme === "file" && document.uri.fsPath === fsPath
  );
  if (openDocument?.isDirty) {
    return false;
  }

  const oleanPath = leanCompiledOleanPath(fsPath, root);
  if (!oleanPath) {
    return false;
  }

  try {
    const sourceStat = fs.statSync(fsPath);
    const oleanStat = fs.statSync(oleanPath);
    return oleanStat.mtimeMs + 1 >= sourceStat.mtimeMs;
  } catch {
    return false;
  }
}

function leanCompiledOleanPath(fsPath: string, root: string): string | undefined {
  const artifactBase = leanCompiledArtifactBasePath(fsPath, root);
  return artifactBase ? `${artifactBase}.olean` : undefined;
}

function leanCompiledIleanPath(fsPath: string, root: string): string | undefined {
  const artifactBase = leanCompiledArtifactBasePath(fsPath, root);
  return artifactBase ? `${artifactBase}.ilean` : undefined;
}

function leanCompiledTracePath(fsPath: string, root: string): string | undefined {
  const artifactBase = leanCompiledArtifactBasePath(fsPath, root);
  return artifactBase ? `${artifactBase}.trace` : undefined;
}

function leanCompiledArtifactBasePath(fsPath: string, root: string): string | undefined {
  const relative = path.relative(root, fsPath);
  if (relative.startsWith("..") || path.isAbsolute(relative) || !relative.endsWith(".lean")) {
    return undefined;
  }

  const withoutExtension = relative.slice(0, -".lean".length);
  if (!withoutExtension) {
    return undefined;
  }

  return path.join(root, ".lake", "build", "lib", "lean", ...withoutExtension.split(/[\\/]+/));
}

async function loadLeanArtifactMetadata(
  declarations: readonly LeanDeclaration[],
  workspaceFolders: readonly vscode.WorkspaceFolder[],
  requireMtimeFresh = true
): Promise<ReturnType<typeof applyLeanIleanArtifacts>> {
  const artifacts: Array<{ uri: string; contents: string }> = [];
  const uris = [...new Set(declarations.map((declaration) => declaration.uri))].sort();
  for (const uri of uris) {
    if (openLeanDocumentIsDirty(uri)) {
      continue;
    }
    const root = workspaceRootForFile(uri, workspaceFolders);
    const ileanPath = root ? leanCompiledIleanPath(uri, root) : undefined;
    if (!ileanPath) {
      continue;
    }
    try {
      const [sourceStat, ileanStat, contents] = await Promise.all([
        fs.promises.stat(uri),
        fs.promises.stat(ileanPath),
        fs.promises.readFile(ileanPath, "utf8")
      ]);
      if (requireMtimeFresh && ileanStat.mtimeMs + 1 < sourceStat.mtimeMs) {
        continue;
      }
      artifacts.push({ uri, contents });
    } catch {
      // A missing or incompatible `.ilean` simply leaves the source graph in use.
    }
  }
  return applyLeanIleanArtifacts(declarations, artifacts);
}

function openLeanDocumentIsDirty(fsPath: string): boolean {
  return vscode.workspace.textDocuments.some((document) =>
    document.uri.scheme === "file" && document.uri.fsPath === fsPath && document.isDirty
  );
}

function leanTraceFingerprint(fsPath: string, root: string): string | undefined {
  const tracePath = leanCompiledTracePath(fsPath, root);
  if (!tracePath) {
    return undefined;
  }
  try {
    const contents = fs.readFileSync(tracePath);
    return createHash("sha256").update(contents).digest("hex");
  } catch {
    return undefined;
  }
}

async function readLeanArtifactCache(root: string): Promise<LeanArtifactCacheFile> {
  try {
    const contents = await fs.promises.readFile(path.join(root, leanArtifactCacheRelativePath), "utf8");
    return parseLeanArtifactCache(contents) ?? emptyLeanArtifactCache();
  } catch {
    return emptyLeanArtifactCache();
  }
}

async function writeLeanArtifactCache(root: string, cache: LeanArtifactCacheFile): Promise<void> {
  const cachePath = path.join(root, leanArtifactCacheRelativePath);
  const directory = path.dirname(cachePath);
  const temporaryPath = `${cachePath}.${process.pid}.tmp`;
  try {
    await fs.promises.mkdir(directory, { recursive: true });
    await fs.promises.writeFile(temporaryPath, JSON.stringify(cache), "utf8");
    await fs.promises.rename(temporaryPath, cachePath);
  } catch {
    try {
      await fs.promises.unlink(temporaryPath);
    } catch {
      // The cache is an optimization; failures must not break previews.
    }
  }
}

function emptyLeanArtifactCache(): LeanArtifactCacheFile {
  return { schemaVersion: leanArtifactExtractorSchemaVersion, entries: {} };
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
  return [`${artifactBase}.olean`, `${artifactBase}.ilean`, `${artifactBase}.trace`];
}

function leanAxiomDemandJobLabel(requests: readonly LeanAxiomCheckRequest[]): string {
  const uris = [...new Set(requests.map((request) => request.declaration.uri))].sort();
  if (uris.length === 1) {
    return vscode.workspace.asRelativePath(uris[0], false);
  }
  return `${requests.length} Lean dependency checks`;
}

function leanDependencyCheckBackend(config: vscode.WorkspaceConfiguration): LeanDependencyCheckBackend {
  const value = config.get<string>("leanDependencyCheckBackend", "subprocess");
  return value === "leanServer" ? "leanServer" : "subprocess";
}

function leanAxiomProbeBackendLabel(backend: LeanDependencyCheckBackend): string {
  return backend === "leanServer" ? "Lean server axiom check" : "Lean subprocess axiom check";
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

async function runLeanAxiomProbe(
  root: string,
  input: string,
  requests: readonly LeanAxiomCheckRequest[],
  timeoutMs: number,
  backend: LeanDependencyCheckBackend,
  signal?: AbortSignal
): Promise<LeanAxiomProbeResult> {
  if (backend === "subprocess") {
    const result = await runLakeLeanStdin(root, input, timeoutMs, signal);
    return { ...result, backend: "subprocess" };
  }

  return runLeanServerAxiomProbe(root, input, requests, timeoutMs, signal);
}

async function runLeanServerAxiomProbe(
  root: string,
  input: string,
  requests: readonly LeanAxiomCheckRequest[],
  timeoutMs: number,
  signal?: AbortSignal
): Promise<LeanAxiomProbeResult> {
  if (signal?.aborted) {
    return {
      ok: false,
      stdout: "",
      stderr: "Handwave canceled the Lean server axiom check.",
      backend: "leanServer"
    };
  }

  const leanExtension = vscode.extensions.getExtension("leanprover.lean4");
  if (!leanExtension) {
    return {
      ok: false,
      stdout: "",
      stderr: "The Lean 4 VS Code extension is not installed.",
      backend: "leanServer"
    };
  }

  try {
    await leanExtension.activate();
  } catch (error) {
    return {
      ok: false,
      stdout: "",
      stderr: `The Lean 4 VS Code extension could not be activated: ${String(error)}`,
      backend: "leanServer"
    };
  }

  const marker = `handwave_probe_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const probeInput = `${input.replace(/\s*$/, "")}\n\n#check "${marker}"\n`;
  const probeUri = vscode.Uri.file(path.join(root, leanServerProbeRelativePath));

  try {
    await writeLeanServerProbeDocument(probeUri, probeInput);
  } catch (error) {
    return {
      ok: false,
      stdout: "",
      stderr: `Handwave could not write the Lean server probe file: ${String(error)}`,
      backend: "leanServer"
    };
  }

  return waitForLeanServerAxiomDiagnostics(probeUri, requests, marker, timeoutMs, signal);
}

async function writeLeanServerProbeDocument(uri: vscode.Uri, text: string): Promise<void> {
  await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(uri.fsPath)));
  await vscode.workspace.fs.writeFile(uri, Buffer.from(text, "utf8"));
  const document = await vscode.workspace.openTextDocument(uri);
  if (document.getText() === text) {
    return;
  }

  const edit = new vscode.WorkspaceEdit();
  edit.replace(uri, fullDocumentRange(document), text);
  const applied = await vscode.workspace.applyEdit(edit);
  if (!applied) {
    throw new Error("VS Code rejected the probe document edit.");
  }
  await document.save();
}

function waitForLeanServerAxiomDiagnostics(
  uri: vscode.Uri,
  requests: readonly LeanAxiomCheckRequest[],
  marker: string,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<LeanAxiomProbeResult> {
  return new Promise((resolve) => {
    let settled = false;
    let errorTimer: NodeJS.Timeout | undefined;

    const dispose = vscode.languages.onDidChangeDiagnostics((event) => {
      if (event.uris.some((item) => sameUri(item, uri))) {
        inspect();
      }
    });

    const timeout = setTimeout(() => {
      finish(false, "", leanServerDiagnosticText(uri) || "Timed out waiting for Lean server axiom diagnostics.");
    }, timeoutMs);

    const finish = (ok: boolean, stdout: string, stderr: string) => {
      if (settled) {
        return;
      }
      settled = true;
      if (errorTimer) {
        clearTimeout(errorTimer);
      }
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      dispose.dispose();
      resolve(ok
        ? { ok: true, stdout, stderr, backend: "leanServer" }
        : { ok: false, stdout, stderr, backend: "leanServer" });
    };

    const abort = () => {
      finish(false, "", "Handwave canceled the Lean server axiom check.");
    };
    signal?.addEventListener("abort", abort, { once: true });

    const scheduleErrorResult = (text: string) => {
      if (errorTimer) {
        clearTimeout(errorTimer);
      }
      errorTimer = setTimeout(() => {
        finish(false, "", text);
      }, 900);
    };

    const inspect = () => {
      if (settled) {
        return;
      }
      const diagnostics = vscode.languages.getDiagnostics(uri);
      const text = diagnostics.map((diagnostic) => diagnostic.message).join("\n");
      const hasMarker = text.includes(marker);
      if (hasMarker && leanAxiomOutputCoversRequests(text, requests)) {
        finish(true, text, "");
        return;
      }
      if (diagnostics.some((diagnostic) => diagnostic.severity === vscode.DiagnosticSeverity.Error)) {
        scheduleErrorResult(leanServerDiagnosticText(uri));
      }
    };

    inspect();
    if (signal?.aborted) {
      abort();
    }
  });
}

function leanAxiomOutputCoversRequests(
  output: string,
  requests: readonly LeanAxiomCheckRequest[]
): boolean {
  const axiomsByName = parseLeanAxiomOutput(output);
  return requests.every((request) => axiomsForDeclaration(axiomsByName, request.declaration) !== undefined);
}

function leanServerDiagnosticText(uri: vscode.Uri): string {
  return vscode.languages.getDiagnostics(uri)
    .map((diagnostic) => `${diagnosticSeverityLabel(diagnostic.severity)}: ${diagnostic.message}`)
    .join("\n");
}

function diagnosticSeverityLabel(severity: vscode.DiagnosticSeverity): string {
  switch (severity) {
    case vscode.DiagnosticSeverity.Error:
      return "error";
    case vscode.DiagnosticSeverity.Warning:
      return "warning";
    case vscode.DiagnosticSeverity.Information:
      return "info";
    case vscode.DiagnosticSeverity.Hint:
      return "hint";
  }
}

function fullDocumentRange(document: vscode.TextDocument): vscode.Range {
  const lastLine = document.lineAt(Math.max(0, document.lineCount - 1));
  return new vscode.Range(new vscode.Position(0, 0), lastLine.rangeIncludingLineBreak.end);
}

function sameUri(first: vscode.Uri, second: vscode.Uri): boolean {
  return first.scheme === second.scheme && first.fsPath === second.fsPath;
}

function runLakeLeanStdin(
  cwd: string,
  input: string,
  timeoutMs = 300000,
  signal?: AbortSignal
): Promise<{ ok: true; stdout: string; stderr: string } | { ok: false; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve({ ok: false, stdout: "", stderr: "Handwave canceled the Lean subprocess axiom check." });
      return;
    }

    const child = spawn("lake", ["env", "lean", "--stdin"], {
      cwd,
      detached: process.platform !== "win32"
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let canceled = false;
    let killTimer: NodeJS.Timeout | undefined;

    const timer = setTimeout(() => {
      if (!settled) {
        timedOut = true;
        terminateLeanSubprocess(child);
        killTimer = setTimeout(() => terminateLeanSubprocess(child, "SIGKILL"), 2000);
      }
    }, timeoutMs);

    const abort = () => {
      if (settled) {
        return;
      }
      canceled = true;
      terminateLeanSubprocess(child);
      killTimer = setTimeout(() => terminateLeanSubprocess(child, "SIGKILL"), 2000);
    };
    signal?.addEventListener("abort", abort, { once: true });

    const cleanup = () => {
      clearTimeout(timer);
      if (killTimer) {
        clearTimeout(killTimer);
      }
      signal?.removeEventListener("abort", abort);
    };

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.stdin.on("error", () => {
      // The process may exit or be canceled before VS Code finishes writing the probe.
    });
    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve({ ok: false, stdout, stderr: stderr || error.message });
    });
    child.on("close", (code, signalName) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      if (code === 0) {
        resolve({ ok: true, stdout, stderr });
        return;
      }
      const reason = stderr ||
        (timedOut
          ? `Timed out after ${formatDuration(timeoutMs)} waiting for Lean subprocess axiom check.`
          : canceled
            ? "Handwave canceled the Lean subprocess axiom check."
            : `Lean subprocess axiom check exited with ${code === null ? signalName ?? "unknown status" : `code ${code}`}.`);
      resolve({ ok: false, stdout, stderr: reason });
    });

    child.stdin.end(input);
  });
}

function runLakeBuildForDeclarations(
  root: string,
  declarations: readonly LeanDeclaration[],
  timeoutMs: number,
  signal?: AbortSignal
): Promise<{ ok: true; stdout: string; stderr: string } | { ok: false; stdout: string; stderr: string }> {
  const targets = new Set<string>();
  for (const declaration of declarations) {
    const relative = path.relative(root, declaration.uri);
    if (relative.startsWith("..") || path.isAbsolute(relative) || !relative.endsWith(".lean")) {
      continue;
    }
    const target = relative.split(path.sep).join("/");
    targets.add(`${target}:olean`);
    targets.add(`${target}:ilean`);
  }
  if (targets.size === 0) {
    return Promise.resolve({
      ok: false,
      stdout: "",
      stderr: "Handwave could not derive Lake module targets for the requested declarations."
    });
  }

  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve({ ok: false, stdout: "", stderr: "Handwave canceled the Lean artifact build." });
      return;
    }

    const child = spawn("lake", ["--quiet", "--log-level=error", "build", ...targets], {
      cwd: root,
      detached: process.platform !== "win32"
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let canceled = false;
    let killTimer: NodeJS.Timeout | undefined;

    const timer = setTimeout(() => {
      if (!settled) {
        timedOut = true;
        terminateLeanSubprocess(child);
        killTimer = setTimeout(() => terminateLeanSubprocess(child, "SIGKILL"), 2000);
      }
    }, timeoutMs);

    const abort = () => {
      if (!settled) {
        canceled = true;
        terminateLeanSubprocess(child);
        killTimer = setTimeout(() => terminateLeanSubprocess(child, "SIGKILL"), 2000);
      }
    };
    signal?.addEventListener("abort", abort, { once: true });

    const cleanup = () => {
      clearTimeout(timer);
      if (killTimer) {
        clearTimeout(killTimer);
      }
      signal?.removeEventListener("abort", abort);
    };

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
      cleanup();
      resolve({ ok: false, stdout, stderr: stderr || error.message });
    });
    child.on("close", (code, signalName) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      if (code === 0) {
        resolve({ ok: true, stdout, stderr });
        return;
      }
      resolve({
        ok: false,
        stdout,
        stderr: stderr || (timedOut
          ? `Timed out after ${formatDuration(timeoutMs)} waiting for the Lean artifact build.`
          : canceled
            ? "Handwave canceled the Lean artifact build."
            : `Lean artifact build exited with ${code === null ? signalName ?? "unknown status" : `code ${code}`}.`)
      });
    });
  });
}

function terminateLeanSubprocess(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals = "SIGTERM"): void {
  if (child.pid === undefined) {
    child.kill(signal);
    return;
  }

  if (process.platform !== "win32") {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall back to the direct child if the process group is already gone.
    }
  }

  child.kill(signal);
}

function isInformativeLeanAxiomStatus(
  status: LeanDeclarationCheckStatus | undefined
): status is LeanDeclarationCheckStatus {
  return Boolean(status && !status.inconclusive && !status.blocked);
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

function stringArrayMapsEqual(
  first: ReadonlyMap<string, readonly string[]>,
  second: ReadonlyMap<string, readonly string[]>
): boolean {
  if (first.size !== second.size) {
    return false;
  }
  for (const [name, values] of first) {
    const otherValues = second.get(name);
    if (!otherValues || !stringArraysEqual(values, otherValues)) {
      return false;
    }
  }
  return true;
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
  return uri.fsPath.endsWith(".lean") && !isHandwaveLeanServerProbeUri(uri);
}

function isHandwaveLeanServerProbeUri(uri: vscode.Uri): boolean {
  const normalized = path.normalize(uri.fsPath);
  return normalized.endsWith(path.sep + leanServerProbeRelativePath);
}

function replaceByUri<T extends { uri: string }>(items: T[], updated: T): T[] {
  const remaining = items.filter((item) => item.uri !== updated.uri);
  return [...remaining, updated];
}
