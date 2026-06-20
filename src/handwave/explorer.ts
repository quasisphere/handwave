import * as vscode from "vscode";
import * as path from "node:path";
import { HandwaveIndex } from "./index";
import { renderCheckStatus, renderLeanDeclarationPreviewHtml } from "./renderer";
import { LeanDeclaration } from "./types";

export interface TheoremExplorerPayload {
  generatedAt: number;
  theoremCount: number;
  milestoneCount: number;
  theorems: TheoremExplorerItem[];
}

export interface TheoremExplorerItem {
  name: string;
  sourceName: string;
  shortName: string;
  displayName: string;
  moduleName: string;
  uri: string;
  relativePath: string;
  target: string;
  tags: string[];
  milestone: boolean;
  isPrivate: boolean;
  dependencies: string[];
  dependents: TheoremExplorerLink[];
  references: TheoremExplorerLink[];
  statusHtml: string;
  previewHtml: string;
}

export interface TheoremExplorerLink {
  target: string;
  label: string;
  detail?: string;
}

export class HandwaveTheoremExplorerProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private view: vscode.WebviewView | undefined;

  constructor(
    private readonly payloadProvider: () => TheoremExplorerPayload,
    private readonly openPreviewTarget: (target: string) => Promise<void>,
    private readonly toggleTag: (target: string, tag: string) => Promise<void>
  ) {}

  dispose(): void {
    this.view = undefined;
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = renderTheoremExplorerHtml(this.payloadProvider());
    view.webview.onDidReceiveMessage((message: unknown) => {
      void this.handleMessage(message);
    });
  }

  refresh(): void {
    const payload = this.payloadProvider();
    void this.view?.webview.postMessage({ type: "setData", payload });
  }

  private async handleMessage(message: unknown): Promise<void> {
    if (!message || typeof message !== "object") {
      return;
    }
    const data = message as { type?: unknown; target?: unknown; tag?: unknown };
    if (data.type === "openPreview" && typeof data.target === "string") {
      await this.openPreviewTarget(data.target);
      return;
    }
    if (data.type === "toggleTag" && typeof data.target === "string" && typeof data.tag === "string") {
      await this.toggleTag(data.target, data.tag);
    }
  }
}

export function buildTheoremExplorerPayload(
  index: HandwaveIndex,
  declarations: readonly LeanDeclaration[],
  workspaceRoots: readonly string[]
): TheoremExplorerPayload {
  const theorems = declarations
    .filter(isTheoremLikeDeclaration)
    .map((declaration) => theoremExplorerItem(index, declaration, workspaceRoots))
    .sort(compareTheoremExplorerItems);
  addDependentLinks(theorems);
  const publicTheorems = theorems.filter((item) => !item.isPrivate);

  return {
    generatedAt: Date.now(),
    theoremCount: publicTheorems.length,
    milestoneCount: publicTheorems.filter((item) => item.milestone).length,
    theorems
  };
}

function theoremExplorerItem(
  index: HandwaveIndex,
  declaration: LeanDeclaration,
  workspaceRoots: readonly string[]
): TheoremExplorerItem {
  const displayName = declaration.doc?.fields.name?.trim() || shortLeanName(declaration.sourceName);
  const moduleName = leanModuleName(declaration.sourceName);
  return {
    name: declaration.name,
    sourceName: declaration.sourceName,
    shortName: shortLeanName(declaration.sourceName),
    displayName,
    moduleName,
    uri: declaration.uri,
    relativePath: relativeWorkspacePath(declaration.uri, workspaceRoots),
    target: `lean:${declaration.name}`,
    tags: declaration.doc?.tags ?? [],
    milestone: Boolean(declaration.doc?.tags.includes("milestone")),
    isPrivate: declaration.isPrivate,
    dependencies: index.dependenciesForLean(declaration.name),
    dependents: [],
    references: articleReferencesForLean(index, declaration.name, workspaceRoots),
    statusHtml: renderCheckStatus(index.checkStatusForLean(declaration.name)),
    previewHtml: renderLeanDeclarationPreviewHtml(
      declaration,
      index,
      () => "#",
      () => "#"
    )
  };
}

function addDependentLinks(theorems: TheoremExplorerItem[]): void {
  const byName = new Map(theorems.map((theorem) => [theorem.name, theorem]));
  const seenByDependency = new Map<string, Set<string>>();
  for (const theorem of theorems) {
    for (const dependencyName of theorem.dependencies) {
      const dependency = byName.get(dependencyName);
      if (!dependency || dependency.name === theorem.name) {
        continue;
      }

      let seen = seenByDependency.get(dependency.name);
      if (!seen) {
        seen = new Set();
        seenByDependency.set(dependency.name, seen);
      }
      if (seen.has(theorem.name)) {
        continue;
      }

      seen.add(theorem.name);
      dependency.dependents.push(theoremExplorerLink(theorem));
    }
  }

  for (const theorem of theorems) {
    theorem.dependents.sort(compareTheoremExplorerLinks);
  }
}

function theoremExplorerLink(theorem: TheoremExplorerItem): TheoremExplorerLink {
  return {
    target: theorem.target,
    label: theorem.displayName,
    detail: theorem.moduleName || theorem.relativePath
  };
}

function articleReferencesForLean(
  index: HandwaveIndex,
  name: string,
  workspaceRoots: readonly string[]
): TheoremExplorerLink[] {
  const references = new Map<string, TheoremExplorerLink>();
  for (const backlink of index.backlinksFor(`lean:${name}`)) {
    const relativePath = relativeWorkspacePath(backlink.fromUri, workspaceRoots);
    const article = index.articles.get(backlink.fromUri);
    references.set(backlink.fromUri, {
      target: `article:${relativePath}`,
      label: relativePath,
      detail: article?.anchors[0]?.title
    });
  }
  return [...references.values()].sort(compareTheoremExplorerLinks);
}

function compareTheoremExplorerLinks(first: TheoremExplorerLink, second: TheoremExplorerLink): number {
  return first.label.localeCompare(second.label) ||
    (first.detail ?? "").localeCompare(second.detail ?? "") ||
    first.target.localeCompare(second.target);
}

function compareTheoremExplorerItems(first: TheoremExplorerItem, second: TheoremExplorerItem): number {
  return first.moduleName.localeCompare(second.moduleName) ||
    first.shortName.localeCompare(second.shortName) ||
    first.sourceName.localeCompare(second.sourceName);
}

function isTheoremLikeDeclaration(declaration: LeanDeclaration): boolean {
  return declaration.kind === "theorem" || declaration.kind === "lemma";
}

function leanModuleName(name: string): string {
  const parts = name.split(".").filter(Boolean);
  return parts.length > 1 ? parts.slice(0, -1).join(".") : "";
}

function shortLeanName(name: string): string {
  return name.split(".").filter(Boolean).pop() ?? name;
}

function relativeWorkspacePath(uri: string, workspaceRoots: readonly string[]): string {
  const normalizedUri = path.resolve(uri);
  const root = workspaceRoots
    .map((item) => path.resolve(item))
    .filter((item) => normalizedUri === item || normalizedUri.startsWith(item + path.sep))
    .sort((first, second) => second.length - first.length)[0];
  return root ? path.relative(root, normalizedUri) : uri;
}

function renderTheoremExplorerHtml(payload: TheoremExplorerPayload): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Handwave Theorem Explorer</title>
  <style>
    :root {
      color-scheme: light dark;
      --border: color-mix(in srgb, currentColor 18%, transparent);
      --muted: color-mix(in srgb, currentColor 62%, transparent);
      --surface: color-mix(in srgb, currentColor 5%, transparent);
      --hover: color-mix(in srgb, currentColor 9%, transparent);
      --accent: var(--vscode-focusBorder, #2f6feb);
      --warning: var(--vscode-editorWarning-foreground, #9a6700);
    }
    * { box-sizing: border-box; }
    body {
      background: var(--vscode-sideBar-background, var(--vscode-editor-background));
      color: var(--vscode-sideBar-foreground, var(--vscode-editor-foreground));
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      line-height: 1.45;
      margin: 0;
      min-width: 0;
    }
    button,
    input {
      font: inherit;
    }
    .explorer {
      display: grid;
      grid-template-rows: auto minmax(150px, 1fr) minmax(150px, 42vh);
      height: 100vh;
      min-height: 0;
    }
    .toolbar {
      border-bottom: 1px solid var(--border);
      display: grid;
      gap: 6px;
      padding: 8px;
    }
    .search-row {
      align-items: center;
      display: grid;
      gap: 6px;
      grid-template-columns: minmax(0, 1fr) auto;
    }
    .search {
      background: var(--vscode-input-background, transparent);
      border: 1px solid var(--vscode-input-border, var(--border));
      color: var(--vscode-input-foreground, currentColor);
      height: 26px;
      min-width: 0;
      padding: 3px 7px;
      width: 100%;
    }
    .search:focus {
      border-color: var(--accent);
      outline: none;
    }
    .suggestions {
      background: var(--vscode-dropdown-background, var(--vscode-sideBar-background, var(--vscode-editor-background)));
      border: 1px solid var(--vscode-dropdown-border, var(--border));
      box-shadow: 0 4px 12px color-mix(in srgb, #000 22%, transparent);
      max-height: 260px;
      overflow: auto;
      padding: 4px 0;
      z-index: 3;
    }
    .suggestions[hidden] {
      display: none;
    }
    .suggestion-group-title {
      color: var(--muted);
      font-size: 0.78em;
      font-weight: 700;
      padding: 5px 8px 2px;
      text-transform: uppercase;
    }
    .suggestion-option {
      background: transparent;
      border: 0;
      color: inherit;
      cursor: pointer;
      display: grid;
      gap: 1px;
      padding: 5px 8px;
      text-align: left;
      width: 100%;
    }
    .suggestion-option:hover,
    .suggestion-option-active {
      background: var(--hover);
    }
    .suggestion-label {
      font-weight: 600;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .suggestion-detail,
    .suggestion-empty {
      color: var(--muted);
      font-size: 0.88em;
    }
    .suggestion-empty {
      padding: 6px 8px;
    }
    .icon-button {
      align-items: center;
      background: transparent;
      border: 1px solid var(--border);
      border-radius: 4px;
      color: inherit;
      cursor: pointer;
      display: inline-flex;
      height: 26px;
      justify-content: center;
      min-width: 28px;
      padding: 0 7px;
    }
    .icon-button:hover,
    .icon-button[aria-pressed="true"] {
      background: var(--hover);
    }
    .icon-button[aria-pressed="true"] {
      color: var(--warning);
    }
    .stats {
      color: var(--muted);
      font-size: 0.9em;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .graph {
      min-height: 0;
      overflow: auto;
      padding: 8px;
    }
    .graph-empty {
      color: var(--muted);
      padding: 10px 12px;
    }
    .graph-canvas {
      min-height: 100%;
      position: relative;
    }
    .graph-canvas-measuring {
      visibility: hidden;
    }
    .graph-edges {
      inset: 0;
      overflow: visible;
      pointer-events: none;
      position: absolute;
    }
    .graph-edge {
      fill: none;
      stroke: var(--muted);
      stroke-opacity: 0.62;
      stroke-width: 1.2;
    }
    .graph-edge-hidden {
      stroke-dasharray: 3 4;
    }
    .graph-edge-highlight {
      stroke: var(--accent);
      stroke-opacity: 0.95;
      stroke-width: 2;
    }
    .graph-node {
      align-items: start;
      background: var(--vscode-sideBar-background, var(--vscode-editor-background));
      border: 1px solid var(--border);
      border-radius: 6px;
      color: inherit;
      cursor: pointer;
      display: grid;
      gap: 4px;
      grid-template-columns: 18px 16px minmax(0, 1fr);
      min-height: 46px;
      padding: 5px 7px;
      position: absolute;
      text-align: left;
    }
    .graph-node:hover,
    .graph-node-selected {
      background: var(--hover);
      border-color: color-mix(in srgb, var(--accent) 55%, var(--border));
    }
    .graph-node-dependency {
      background: color-mix(in srgb, var(--accent) 12%, var(--vscode-sideBar-background, var(--vscode-editor-background)));
      border-color: color-mix(in srgb, var(--accent) 46%, var(--border));
    }
    .star {
      color: var(--muted);
      line-height: 1.25;
      text-align: center;
    }
    .star-on {
      color: var(--warning);
    }
    .preview-milestone-control {
      background: transparent;
      border: 0;
      color: var(--muted);
      cursor: pointer;
      font: inherit;
      font-weight: 700;
      margin: 0 0.25em 0 0.1em;
      padding: 0 2px;
      vertical-align: baseline;
    }
    .preview-milestone-control:hover {
      color: var(--warning);
    }
    .preview-milestone-control-active {
      color: var(--warning);
    }
    .theorem-node-text {
      min-width: 0;
    }
    .theorem-title,
    .theorem-module {
      display: block;
    }
    .theorem-title {
      font-weight: 600;
      line-height: 1.2;
      overflow: visible;
      text-overflow: clip;
      white-space: normal;
      word-break: break-word;
    }
    .theorem-module {
      color: var(--muted);
      font-size: 0.88em;
      line-height: 1.15;
      overflow: visible;
      text-overflow: clip;
      white-space: normal;
      word-break: break-word;
    }
    .preview {
      border-top: 1px solid var(--border);
      min-height: 0;
      overflow: auto;
      padding: 10px 12px 16px;
    }
    .preview-empty {
      color: var(--muted);
      margin: 0;
    }
    .theorem-view,
    .definition-view {
      margin: 0;
    }
    .theorem-statement,
    .definition-statement {
      margin: 0 0 1em;
    }
    .theorem-line,
    .definition-line,
    .prose-paragraph {
      margin: 0;
    }
    .prose-paragraph + .prose-paragraph,
    .theorem-line + .prose-paragraph,
    .definition-line + .prose-paragraph {
      margin-top: 0.65em;
    }
    .declaration-link {
      color: inherit;
      text-decoration: none;
    }
    .declaration-link:hover {
      color: var(--vscode-textLink-foreground, var(--accent));
      text-decoration: underline;
    }
    .declaration-label strong,
    .proof-line strong {
      font-size: 1em;
    }
    .check-status {
      display: inline-block;
      font-weight: 700;
      margin-right: 0.35em;
      min-width: 1em;
      text-align: center;
    }
    .graph-node > .check-status {
      line-height: 1.25;
      margin-right: 0;
    }
    .check-status-checked {
      color: var(--vscode-testing-iconPassed, #1a7f37);
    }
    .check-status-unchecked {
      color: var(--vscode-testing-iconFailed, #d1242f);
    }
    .check-status-dependency-warning,
    .check-status-blocked {
      color: var(--warning);
    }
    .check-status-inconclusive,
    .check-status-pending {
      color: var(--muted);
    }
    .proof-section {
      margin-top: 0.9em;
      position: relative;
    }
    .proof-line {
      display: block;
      margin: 0;
    }
    .collapse-control {
      display: none;
    }
    .proof-content,
    .proof-body {
      display: block;
    }
    .qed {
      float: right;
      line-height: 1.6;
      margin-left: 1em;
    }
    .viewer-info {
      border-top: 1px solid var(--border);
      display: grid;
      gap: 10px;
      margin-top: 14px;
      padding-top: 10px;
    }
    .viewer-info-section {
      display: grid;
      gap: 4px;
    }
    .viewer-info-title {
      color: var(--muted);
      font-size: 0.84em;
      font-weight: 700;
      letter-spacing: 0;
      margin: 0;
      text-transform: uppercase;
    }
    .viewer-info-list {
      display: grid;
      gap: 3px;
      list-style: none;
      margin: 0;
      padding: 0;
    }
    .viewer-info-empty {
      color: var(--muted);
      margin: 0;
    }
    .viewer-info-link {
      color: var(--vscode-textLink-foreground, var(--accent));
      text-decoration: none;
    }
    .viewer-info-link:hover {
      text-decoration: underline;
    }
    .viewer-info-detail {
      color: var(--muted);
      display: block;
      font-size: 0.88em;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .lean-content {
      display: none;
    }
    .preview pre {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 6px;
      font-family: var(--vscode-editor-font-family);
      font-size: 0.88em;
      margin: 8px 0 0;
      max-height: 180px;
      overflow: auto;
      padding: 8px;
      white-space: pre-wrap;
    }
    mjx-container {
      max-width: 100%;
      overflow-x: auto;
      overflow-y: hidden;
    }
  </style>
  <script>
    window.MathJax = {
      tex: {
        inlineMath: [["$", "$"], ["\\\\(", "\\\\)"]],
        displayMath: [["$$", "$$"], ["\\\\[", "\\\\]"]],
        processEscapes: true
      },
      options: {
        skipHtmlTags: ["script", "noscript", "style", "textarea", "pre", "code"]
      }
    };
  </script>
  <script async src="https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-chtml.js"></script>
</head>
<body>
  <main class="explorer">
    <section class="toolbar">
      <div class="search-row">
        <input id="search" class="search" type="search" placeholder="Module or theorem" aria-label="Module or theorem">
        <button id="milestone-filter" class="icon-button" type="button" aria-pressed="true" title="Milestones">★</button>
      </div>
      <div id="suggestions" class="suggestions" role="listbox" aria-label="Search suggestions" hidden></div>
      <div id="stats" class="stats"></div>
    </section>
    <section id="graph" class="graph" aria-label="Theorem dependency graph"></section>
    <section id="preview" class="preview" aria-label="Theorem preview">
      <p class="preview-empty">Select a theorem.</p>
    </section>
  </main>
  <script>
    const vscode = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : undefined;
    let payload = ${jsonForScript(payload)};
    let milestoneOnly = true;
    let selectedName = "";
    let searchSelection = undefined;
    let suggestionsOpen = false;
    let suggestionItems = [];
    let activeSuggestionIndex = -1;
    let graphLayoutVersion = 0;

    const search = document.getElementById("search");
    const suggestions = document.getElementById("suggestions");
    const milestoneFilter = document.getElementById("milestone-filter");
    const stats = document.getElementById("stats");
    const graph = document.getElementById("graph");
    const preview = document.getElementById("preview");

    function byName() {
      const result = new Map();
      for (const theorem of payload.theorems) {
        result.set(theorem.name, theorem);
      }
      return result;
    }

    function publicTheorems() {
      return payload.theorems.filter((theorem) => !theorem.isPrivate);
    }

    function exactTheorem(query, theorems) {
      if (!query) {
        return undefined;
      }
      const exact = theorems.filter((theorem) =>
        theorem.displayName.toLowerCase() === query ||
        theorem.name.toLowerCase() === query ||
        theorem.sourceName.toLowerCase() === query ||
        theorem.shortName.toLowerCase() === query
      );
      return exact.length === 1 ? exact[0] : undefined;
    }

    function setMilestoneOnly(nextValue) {
      milestoneOnly = nextValue;
      milestoneFilter.setAttribute("aria-pressed", String(milestoneOnly));
      milestoneFilter.textContent = milestoneOnly ? "★" : "☆";
    }

    function rootTheorems() {
      const query = search.value.trim().toLowerCase();
      const theoremList = publicTheorems();
      if (searchSelection?.type === "module") {
        return theoremList.filter((theorem) =>
          theorem.moduleName === searchSelection.value &&
          (!milestoneOnly || theorem.milestone)
        );
      }
      if (searchSelection?.type === "theorem") {
        const theorem = byName().get(searchSelection.value);
        return theorem ? [theorem] : [];
      }
      const exact = exactTheorem(query, theoremList);
      if (exact) {
        return [exact];
      }
      return theoremList.filter((theorem) => {
        if (milestoneOnly && !theorem.milestone) {
          return false;
        }
        if (!query) {
          return true;
        }
        return theorem.displayName.toLowerCase().includes(query) ||
          theorem.name.toLowerCase().includes(query) ||
          theorem.sourceName.toLowerCase().includes(query) ||
          theorem.shortName.toLowerCase().includes(query) ||
          theorem.moduleName.toLowerCase().includes(query) ||
          theorem.relativePath.toLowerCase().includes(query);
      });
    }

    function dependencyChildren(name, theoremMap, path) {
      const theorem = theoremMap.get(name);
      if (!theorem) {
        return [];
      }
      const result = [];
      const seen = new Set();
      for (const dependencyName of theorem.dependencies) {
        for (const child of collectDependencyNode(dependencyName, theoremMap, path, false)) {
          const key = child.name + ":" + String(child.viaHidden);
          if (seen.has(key)) {
            continue;
          }
          seen.add(key);
          result.push(child);
        }
      }
      return result;
    }

    function collectDependencyNode(name, theoremMap, path, viaHidden) {
      const theorem = theoremMap.get(name);
      if (!theorem || path.has(name)) {
        return [];
      }
      const nextPath = new Set(path);
      nextPath.add(name);
      if (!milestoneOnly || theorem.milestone) {
        return [{
          name,
          viaHidden,
          children: dependencyChildren(name, theoremMap, nextPath)
        }];
      }
      return theorem.dependencies.flatMap((dependencyName) =>
        collectDependencyNode(dependencyName, theoremMap, nextPath, true)
      );
    }

    function renderExplorerGraph() {
      const theoremMap = byName();
      const roots = rootTheorems();
      stats.textContent = graphStatsText(roots);
      if (roots.length === 0) {
        graphLayoutVersion++;
        graph.innerHTML = '<div class="graph-empty">No theorems.</div>';
        renderPreview();
        return;
      }
      const layout = layoutGraph(roots, theoremMap);
      const version = ++graphLayoutVersion;
      graph.innerHTML = renderGraph(layout, theoremMap);
      window.requestAnimationFrame(() => applyMeasuredGraphLayout(layout, version));
      renderPreview();
    }

    function graphStatsText(roots) {
      if (searchSelection?.type === "module") {
        const noun = milestoneOnly ? "milestone" : "theorem";
        return String(roots.length) + " " + noun + (roots.length === 1 ? "" : "s") + " in " + searchSelection.value;
      }
      if (searchSelection?.type === "theorem") {
        return roots.length === 0 ? "No selected theorem" : "Selected theorem with dependencies";
      }
      return milestoneOnly
        ? String(roots.length) + " of " + String(payload.milestoneCount) + " milestones"
        : String(roots.length) + " of " + String(payload.theoremCount) + " theorems";
    }

    function layoutGraph(roots, theoremMap) {
      const nodes = new Map();
      const edges = new Map();
      for (const root of roots) {
        visitGraphNode(root.name, theoremMap, nodes, edges, 0, new Set([root.name]));
      }

      const columns = new Map();
      for (const node of nodes.values()) {
        const list = columns.get(node.column) || [];
        list.push(node);
        columns.set(node.column, list);
      }
      for (const list of columns.values()) {
        list.sort((first, second) => {
          const firstTheorem = theoremMap.get(first.name);
          const secondTheorem = theoremMap.get(second.name);
          return (firstTheorem?.moduleName || "").localeCompare(secondTheorem?.moduleName || "") ||
            (firstTheorem?.displayName || first.name).localeCompare(secondTheorem?.displayName || second.name);
        });
      }

      const nodeWidth = 208;
      const columnGap = 86;
      const rowGap = 18;
      const maxColumn = Math.max(0, ...[...nodes.values()].map((node) => node.column));
      const orderedNodes = [];

      for (const [column, list] of [...columns.entries()].sort((first, second) => first[0] - second[0])) {
        for (const node of list) {
          node.x = column * (nodeWidth + columnGap);
          node.y = 0;
          orderedNodes.push(node);
        }
      }

      return {
        edges: [...edges.values()],
        height: 80,
        nodes: orderedNodes,
        nodeWidth,
        rowGap,
        width: (maxColumn + 1) * (nodeWidth + columnGap) - columnGap + 16
      };
    }

    function visitGraphNode(name, theoremMap, nodes, edges, column, path) {
      const theorem = theoremMap.get(name);
      if (!theorem) {
        return;
      }
      const existing = nodes.get(name);
      if (existing) {
        existing.column = Math.max(existing.column, column);
      } else {
        nodes.set(name, { name, column, height: 46, x: 0, y: 0 });
      }

      for (const child of dependencyChildren(name, theoremMap, path)) {
        const edgeKey = name + "->" + child.name + ":" + String(child.viaHidden);
        if (!edges.has(edgeKey)) {
          edges.set(edgeKey, { from: name, to: child.name, viaHidden: child.viaHidden });
        }
        if (path.has(child.name)) {
          continue;
        }
        const nextPath = new Set(path);
        nextPath.add(child.name);
        visitGraphNode(child.name, theoremMap, nodes, edges, column + 1, nextPath);
      }
    }

    function renderGraph(layout, theoremMap) {
      const highlight = graphHighlight(layout.edges, selectedName);
      return '<div class="graph-canvas graph-canvas-measuring" style="width: ' + String(layout.width) + 'px; height: ' + String(layout.height) + 'px;">' +
        '<svg class="graph-edges" width="' + String(layout.width) + '" height="' + String(layout.height) + '" aria-hidden="true"></svg>' +
        layout.nodes.map((node, index) => renderNode(node, theoremMap, layout, highlight, index)).join("") +
        '</div>';
    }

    function applyMeasuredGraphLayout(layout, version) {
      if (version !== graphLayoutVersion) {
        return;
      }
      const canvas = graph.querySelector(".graph-canvas");
      const svg = graph.querySelector(".graph-edges");
      if (!canvas || !svg) {
        return;
      }

      const columns = new Map();
      layout.nodes.forEach((node, index) => {
        const element = canvas.querySelector('[data-graph-node-index="' + String(index) + '"]');
        node.element = element;
        node.height = element ? Math.ceil(element.getBoundingClientRect().height) : 46;
        const list = columns.get(node.column) || [];
        list.push(node);
        columns.set(node.column, list);
      });

      let maxColumnHeight = 0;
      for (const list of columns.values()) {
        let y = 0;
        for (const node of list) {
          node.y = y;
          if (node.element) {
            node.element.style.left = String(node.x) + "px";
            node.element.style.top = String(node.y) + "px";
          }
          y += node.height + layout.rowGap;
        }
        maxColumnHeight = Math.max(maxColumnHeight, Math.max(0, y - layout.rowGap));
      }

      layout.height = maxColumnHeight + 12;
      canvas.style.width = String(layout.width) + "px";
      canvas.style.height = String(layout.height) + "px";
      svg.setAttribute("width", String(layout.width));
      svg.setAttribute("height", String(layout.height));
      svg.innerHTML = renderGraphEdges(layout, graphHighlight(layout.edges, selectedName));
      canvas.classList.remove("graph-canvas-measuring");
    }

    function renderGraphEdges(layout, highlight) {
      const edges = [...layout.edges].sort((first, second) =>
        Number(highlight.edges.has(graphEdgeKey(first))) - Number(highlight.edges.has(graphEdgeKey(second)))
      );
      return edges.map((edge) => renderEdge(edge, layout, highlight)).join("");
    }

    function graphHighlight(edges, selectedName) {
      const nodes = new Set();
      const highlightedEdges = new Set();
      if (!selectedName) {
        return { nodes, edges: highlightedEdges };
      }

      const bySource = new Map();
      for (const edge of edges) {
        const list = bySource.get(edge.from) || [];
        list.push(edge);
        bySource.set(edge.from, list);
      }

      const visited = new Set([selectedName]);
      const visit = (name) => {
        for (const edge of bySource.get(name) || []) {
          highlightedEdges.add(graphEdgeKey(edge));
          if (edge.to === selectedName) {
            continue;
          }
          nodes.add(edge.to);
          if (visited.has(edge.to)) {
            continue;
          }
          visited.add(edge.to);
          visit(edge.to);
        }
      };
      visit(selectedName);
      return { nodes, edges: highlightedEdges };
    }

    function graphEdgeKey(edge) {
      return edge.from + "->" + edge.to + ":" + String(edge.viaHidden);
    }

    function renderEdge(edge, layout, highlight) {
      const from = layout.nodes.find((node) => node.name === edge.from);
      const to = layout.nodes.find((node) => node.name === edge.to);
      if (!from || !to) {
        return "";
      }
      const startX = from.x + layout.nodeWidth;
      const startY = from.y + from.height / 2;
      const endX = to.x;
      const endY = to.y + to.height / 2;
      const midX = (startX + endX) / 2;
      const cssClass = "graph-edge" +
        (edge.viaHidden ? " graph-edge-hidden" : "") +
        (highlight.edges.has(graphEdgeKey(edge)) ? " graph-edge-highlight" : "");
      return '<path class="' + cssClass + '" d="M ' + String(startX) + ' ' + String(startY) +
        ' C ' + String(midX) + ' ' + String(startY) + ', ' + String(midX) + ' ' + String(endY) +
        ', ' + String(endX) + ' ' + String(endY) + '"></path>';
    }

    function renderNode(node, theoremMap, layout, highlight, index) {
      const theorem = theoremMap.get(node.name);
      if (!theorem) {
        return "";
      }
      const selected = theorem.name === selectedName ? " graph-node-selected" : "";
      const dependency = highlight.nodes.has(theorem.name) ? " graph-node-dependency" : "";
      const star = theorem.milestone ? "★" : "☆";
      const starClass = theorem.milestone ? "star star-on" : "star";
      return '<button class="graph-node' + selected + dependency + '" type="button" data-select-theorem="' + html(theorem.name) +
        '" data-graph-node-index="' + String(index) +
        '" style="left: ' + String(node.x) + 'px; top: ' + String(node.y) +
        'px; width: ' + String(layout.nodeWidth) + 'px;">' +
        (theorem.statusHtml || '') +
        '<span class="' + starClass + '">' + star + '</span>' +
        '<span class="theorem-node-text"><span class="theorem-title">' + html(theorem.displayName) + '</span>' +
        '<span class="theorem-module">' + html(theorem.moduleName || theorem.relativePath) + '</span></span>' +
        '</button>';
    }

    function searchSuggestionItems(query) {
      const normalized = query.trim().toLowerCase();
      if (!normalized) {
        return [];
      }

      const theoremList = publicTheorems();
      const modules = new Map();
      for (const theorem of theoremList) {
        if (!theorem.moduleName || !theorem.moduleName.toLowerCase().includes(normalized)) {
          continue;
        }
        modules.set(theorem.moduleName, (modules.get(theorem.moduleName) || 0) + 1);
      }

      const moduleItems = [...modules.entries()]
        .sort((first, second) => first[0].localeCompare(second[0]))
        .map(([moduleName, count]) => ({
          type: "module",
          value: moduleName,
          label: moduleName,
          detail: String(count) + " theorem" + (count === 1 ? "" : "s")
        }));

      const theoremItems = theoremList
        .filter((theorem) =>
          theorem.displayName.toLowerCase().includes(normalized) ||
          theorem.name.toLowerCase().includes(normalized) ||
          theorem.sourceName.toLowerCase().includes(normalized) ||
          theorem.shortName.toLowerCase().includes(normalized)
        )
        .sort((first, second) =>
          first.moduleName.localeCompare(second.moduleName) ||
          first.displayName.localeCompare(second.displayName) ||
          first.sourceName.localeCompare(second.sourceName)
        )
        .map((theorem) => ({
          type: "theorem",
          value: theorem.name,
          label: theorem.displayName,
          detail: theorem.sourceName
        }));

      return [...moduleItems, ...theoremItems];
    }

    function renderSuggestions() {
      const query = search.value.trim();
      if (!suggestionsOpen || !query) {
        hideSuggestions();
        return;
      }

      suggestionItems = searchSuggestionItems(query);
      if (activeSuggestionIndex >= suggestionItems.length) {
        activeSuggestionIndex = suggestionItems.length - 1;
      }
      if (suggestionItems.length === 0) {
        activeSuggestionIndex = -1;
        suggestions.hidden = false;
        suggestions.innerHTML = '<div class="suggestion-empty">No matches.</div>';
        return;
      }

      const moduleItems = [];
      const theoremItems = [];
      suggestionItems.forEach((item, index) => {
        const rendered = renderSuggestionOption(item, index);
        if (item.type === "module") {
          moduleItems.push(rendered);
        } else {
          theoremItems.push(rendered);
        }
      });

      suggestions.hidden = false;
      suggestions.innerHTML =
        (moduleItems.length > 0
          ? '<div class="suggestion-group-title">Modules</div>' + moduleItems.join("")
          : '') +
        (theoremItems.length > 0
          ? '<div class="suggestion-group-title">Theorems</div>' + theoremItems.join("")
          : '');
    }

    function renderSuggestionOption(item, index) {
      const active = index === activeSuggestionIndex ? " suggestion-option-active" : "";
      return '<button class="suggestion-option' + active + '" type="button" role="option" data-suggestion-index="' + String(index) +
        '" aria-selected="' + String(index === activeSuggestionIndex) +
        '" onpointerdown="selectSuggestionIndex(' + String(index) + '); return false;"' +
        ' onmousedown="selectSuggestionIndex(' + String(index) + '); return false;"' +
        ' onclick="selectSuggestionIndex(' + String(index) + '); return false;">' +
        '<span class="suggestion-label">' + html(item.label) + '</span>' +
        '<span class="suggestion-detail">' + html(item.detail) + '</span>' +
        '</button>';
    }

    function hideSuggestions() {
      suggestionItems = [];
      activeSuggestionIndex = -1;
      suggestions.hidden = true;
      suggestions.innerHTML = "";
    }

    function moveActiveSuggestion(delta) {
      if (!suggestionsOpen) {
        suggestionsOpen = true;
      }
      if (suggestionItems.length === 0) {
        suggestionItems = searchSuggestionItems(search.value);
      }
      if (suggestionItems.length === 0) {
        renderSuggestions();
        return;
      }
      activeSuggestionIndex = activeSuggestionIndex < 0
        ? (delta > 0 ? 0 : suggestionItems.length - 1)
        : (activeSuggestionIndex + delta + suggestionItems.length) % suggestionItems.length;
      renderSuggestions();
      suggestions.querySelector('[data-suggestion-index="' + String(activeSuggestionIndex) + '"]')?.scrollIntoView({ block: "nearest" });
    }

    function setActiveSuggestionIndex(index) {
      activeSuggestionIndex = index;
      for (const option of suggestions.querySelectorAll("[data-suggestion-index]")) {
        const active = Number(option.dataset.suggestionIndex) === activeSuggestionIndex;
        option.classList.toggle("suggestion-option-active", active);
        option.setAttribute("aria-selected", String(active));
      }
    }

    function selectSuggestionIndex(index) {
      const item = suggestionItems[index];
      if (!item) {
        return;
      }
      applySearchSelection(item);
    }

    function applySearchSelection(item) {
      searchSelection = item;
      search.value = searchSelectionText(item);
      suggestionsOpen = false;
      hideSuggestions();
      if (item.type === "theorem") {
        selectedName = item.value;
      }
      renderExplorerGraph();
    }

    function restrictToTheorem(theorem) {
      applySearchSelection({
        type: "theorem",
        value: theorem.name,
        label: theorem.displayName,
        detail: theorem.sourceName
      });
    }

    function searchSelectionText(item) {
      if (item.type === "module" || !item.detail || item.detail === item.label) {
        return item.label;
      }
      return item.label + " (" + item.detail + ")";
    }

    function renderPreview() {
      const theorem = byName().get(selectedName);
      if (!theorem) {
        preview.innerHTML = '<p class="preview-empty">Select a theorem.</p>';
        return;
      }
      preview.innerHTML = injectPreviewMilestoneControl(theorem.previewHtml, theorem) + renderViewerInfo(theorem);
      window.MathJax?.typesetPromise?.([preview]).catch(() => undefined);
    }

    function injectPreviewMilestoneControl(previewHtml, theorem) {
      const marker = '<span class="declaration-label"';
      const index = previewHtml.indexOf(marker);
      const control = renderPreviewMilestoneControl(theorem);
      if (index < 0) {
        return control + previewHtml;
      }
      return previewHtml.slice(0, index) + control + previewHtml.slice(index);
    }

    function renderPreviewMilestoneControl(theorem) {
      const active = Boolean(theorem.milestone);
      const label = active ? "Remove milestone tag" : "Add milestone tag";
      const cssClass = active
        ? "preview-milestone-control preview-milestone-control-active"
        : "preview-milestone-control preview-milestone-control-inactive";
      return '<button class="' + cssClass + '" type="button" data-toggle-tag="milestone" data-handwave-target="' + html(theorem.target) +
        '" aria-pressed="' + String(active) + '" title="' + html(label) + '" aria-label="' + html(label) + '">' +
        (active ? "★" : "☆") +
        '</button>';
    }

    function renderViewerInfo(theorem) {
      return '<aside class="viewer-info" aria-label="Theorem references">' +
        renderViewerInfoSection(
          "Theorems depending on this",
          theorem.dependents || [],
          "No indexed theorem depends on this theorem."
        ) +
        renderViewerInfoSection(
          "Referenced in Handwave files",
          theorem.references || [],
          "No Handwave markdown file references this theorem."
        ) +
        '</aside>';
    }

    function renderViewerInfoSection(title, links, emptyText) {
      const items = links.length > 0
        ? '<ul class="viewer-info-list">' + links.map(renderViewerInfoLink).join("") + '</ul>'
        : '<p class="viewer-info-empty">' + html(emptyText) + '</p>';
      return '<section class="viewer-info-section">' +
        '<h2 class="viewer-info-title">' + html(title) + '</h2>' +
        items +
        '</section>';
    }

    function renderViewerInfoLink(link) {
      const detail = link.detail
        ? '<span class="viewer-info-detail">' + html(link.detail) + '</span>'
        : '';
      return '<li><a class="viewer-info-link" href="#" data-handwave-target="' + html(link.target) +
        '" title="Open ' + html(link.target) + '">' + html(link.label) + '</a>' + detail + '</li>';
    }

    function html(value) {
      return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
    }

    search.addEventListener("input", () => {
      searchSelection = undefined;
      suggestionsOpen = true;
      renderSuggestions();
      renderExplorerGraph();
    });

    search.addEventListener("focus", () => {
      if (searchSelection) {
        return;
      }
      suggestionsOpen = true;
      renderSuggestions();
    });

    search.addEventListener("blur", () => {
      window.setTimeout(() => {
        suggestionsOpen = false;
        hideSuggestions();
      }, 120);
    });

    search.addEventListener("keydown", (event) => {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        moveActiveSuggestion(1);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        moveActiveSuggestion(-1);
        return;
      }
      if (event.key === "Enter" && activeSuggestionIndex >= 0) {
        event.preventDefault();
        selectSuggestionIndex(activeSuggestionIndex);
        return;
      }
      if (event.key === "Escape") {
        suggestionsOpen = false;
        hideSuggestions();
      }
    });

    function selectSuggestionFromEvent(event) {
      const target = event.target instanceof Element ? event.target : undefined;
      const option = target?.closest("[data-suggestion-index]");
      if (!option) {
        return false;
      }
      event.preventDefault();
      selectSuggestionIndex(Number(option.dataset.suggestionIndex));
      return true;
    }

    suggestions.addEventListener("pointerdown", (event) => {
      selectSuggestionFromEvent(event);
    });

    suggestions.addEventListener("mousedown", (event) => {
      selectSuggestionFromEvent(event);
    });

    suggestions.addEventListener("mouseover", (event) => {
      const target = event.target instanceof Element ? event.target : undefined;
      const option = target?.closest("[data-suggestion-index]");
      if (!option) {
        return;
      }
      setActiveSuggestionIndex(Number(option.dataset.suggestionIndex));
    });

    suggestions.addEventListener("click", (event) => {
      selectSuggestionFromEvent(event);
    });

    milestoneFilter.addEventListener("click", () => {
      setMilestoneOnly(!milestoneOnly);
      renderExplorerGraph();
    });

    graph.addEventListener("click", (event) => {
      const target = event.target instanceof Element ? event.target : undefined;
      const button = target?.closest("[data-select-theorem]");
      if (!button) {
        return;
      }
      const theorem = byName().get(button.dataset.selectTheorem || "");
      if (!theorem) {
        return;
      }
      if (event.detail >= 2) {
        restrictToTheorem(theorem);
        return;
      }
      selectedName = theorem.name;
      renderExplorerGraph();
    });

    graph.addEventListener("dblclick", (event) => {
      const target = event.target instanceof Element ? event.target : undefined;
      const button = target?.closest("[data-select-theorem]");
      if (!button) {
        return;
      }
      event.preventDefault();
      const theorem = byName().get(button.dataset.selectTheorem || "");
      if (theorem) {
        restrictToTheorem(theorem);
      }
    });

    preview.addEventListener("click", (event) => {
      const target = event.target instanceof Element ? event.target : undefined;
      const tagButton = target?.closest("[data-toggle-tag]");
      if (tagButton) {
        event.preventDefault();
        const tag = tagButton.dataset.toggleTag;
        const handwaveTarget = tagButton.dataset.handwaveTarget;
        if (tag && handwaveTarget) {
          vscode?.postMessage({ type: "toggleTag", target: handwaveTarget, tag });
        }
        return;
      }
      const link = target?.closest("a[data-handwave-target]");
      if (!link) {
        return;
      }
      event.preventDefault();
      const targetName = link.dataset.handwaveTarget;
      if (targetName) {
        vscode?.postMessage({ type: "openPreview", target: targetName });
      }
    });

    window.addEventListener("message", (event) => {
      const message = event.data || {};
      if (message.type !== "setData" || !message.payload) {
        return;
      }
      payload = message.payload;
      if (selectedName && !byName().has(selectedName)) {
        selectedName = "";
      }
      if (searchSelection?.type === "theorem" && !byName().has(searchSelection.value)) {
        searchSelection = undefined;
      }
      if (
        searchSelection?.type === "module" &&
        !publicTheorems().some((theorem) => theorem.moduleName === searchSelection.value)
      ) {
        searchSelection = undefined;
      }
      renderSuggestions();
      renderExplorerGraph();
    });

    renderExplorerGraph();
  </script>
</body>
</html>`;
}

function jsonForScript(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}
