import * as vscode from "vscode";
import * as path from "node:path";
import { HandwaveIndex } from "./index";
import { renderLeanDeclarationPreviewHtml } from "./renderer";
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
  previewHtml: string;
}

export class HandwaveTheoremExplorerProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private view: vscode.WebviewView | undefined;

  constructor(
    private readonly payloadProvider: () => TheoremExplorerPayload,
    private readonly openPreviewTarget: (target: string) => Promise<void>
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
    const data = message as { type?: unknown; target?: unknown };
    if (data.type === "openPreview" && typeof data.target === "string") {
      await this.openPreviewTarget(data.target);
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
    previewHtml: renderLeanDeclarationPreviewHtml(
      declaration,
      index,
      () => "#",
      () => "#"
    )
  };
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
    .tree {
      min-height: 0;
      overflow: auto;
      padding: 4px 0 8px;
    }
    .tree-empty {
      color: var(--muted);
      padding: 10px 12px;
    }
    .node {
      position: relative;
    }
    .children {
      margin-left: 13px;
    }
    .node-via-hidden > .theorem-row::before {
      border-left: 1px dotted var(--muted);
      bottom: -6px;
      content: "";
      left: 5px;
      position: absolute;
      top: -6px;
    }
    .theorem-row {
      align-items: center;
      background: transparent;
      border: 0;
      color: inherit;
      cursor: pointer;
      display: grid;
      gap: 4px;
      grid-template-columns: 12px 14px minmax(0, 1fr);
      min-height: 24px;
      padding: 2px 8px;
      position: relative;
      text-align: left;
      width: 100%;
    }
    .theorem-row:hover,
    .theorem-row-selected {
      background: var(--hover);
    }
    .twisty {
      color: var(--muted);
      font-size: 0.9em;
      text-align: center;
    }
    .star {
      color: var(--muted);
      text-align: center;
    }
    .star-on {
      color: var(--warning);
    }
    .theorem-title,
    .theorem-module {
      display: block;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .theorem-title {
      font-weight: 600;
    }
    .theorem-module {
      color: var(--muted);
      font-size: 0.88em;
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
      <div id="stats" class="stats"></div>
    </section>
    <section id="tree" class="tree" aria-label="Theorem tree"></section>
    <section id="preview" class="preview" aria-label="Theorem preview">
      <p class="preview-empty">Select a theorem.</p>
    </section>
  </main>
  <script>
    const vscode = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : undefined;
    let payload = ${jsonForScript(payload)};
    let milestoneOnly = true;
    let selectedName = "";

    const search = document.getElementById("search");
    const milestoneFilter = document.getElementById("milestone-filter");
    const stats = document.getElementById("stats");
    const tree = document.getElementById("tree");
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
        theorem.name.toLowerCase() === query ||
        theorem.sourceName.toLowerCase() === query ||
        theorem.shortName.toLowerCase() === query
      );
      return exact.length === 1 ? exact[0] : undefined;
    }

    function rootTheorems() {
      const query = search.value.trim().toLowerCase();
      const theoremList = publicTheorems();
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
        return theorem.name.toLowerCase().includes(query) ||
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

    function renderTree() {
      const theoremMap = byName();
      const roots = rootTheorems();
      stats.textContent = milestoneOnly
        ? String(roots.length) + " of " + String(payload.milestoneCount) + " milestones"
        : String(roots.length) + " of " + String(payload.theoremCount) + " theorems";
      if (roots.length === 0) {
        tree.innerHTML = '<div class="tree-empty">No theorems.</div>';
        renderPreview();
        return;
      }
      tree.innerHTML = roots.map((theorem) =>
        renderNode({
          name: theorem.name,
          viaHidden: false,
          children: dependencyChildren(theorem.name, theoremMap, new Set([theorem.name]))
        }, theoremMap, 0)
      ).join("");
      renderPreview();
    }

    function renderNode(node, theoremMap, depth) {
      const theorem = theoremMap.get(node.name);
      if (!theorem) {
        return "";
      }
      const children = node.children || [];
      const selected = theorem.name === selectedName ? " theorem-row-selected" : "";
      const viaHidden = node.viaHidden ? " node-via-hidden" : "";
      const star = theorem.milestone ? "★" : "☆";
      const starClass = theorem.milestone ? "star star-on" : "star";
      return '<div class="node' + viaHidden + '" data-name="' + html(theorem.name) + '">' +
        '<button class="theorem-row' + selected + '" type="button" data-select-theorem="' + html(theorem.name) + '">' +
        '<span class="twisty">' + (children.length > 0 ? "▾" : "") + '</span>' +
        '<span class="' + starClass + '">' + star + '</span>' +
        '<span><span class="theorem-title">' + html(theorem.displayName) + '</span>' +
        '<span class="theorem-module">' + html(theorem.moduleName || theorem.relativePath) + '</span></span>' +
        '</button>' +
        (children.length > 0
          ? '<div class="children">' + children.map((child) => renderNode(child, theoremMap, depth + 1)).join("") + '</div>'
          : '') +
        '</div>';
    }

    function renderPreview() {
      const theorem = byName().get(selectedName);
      if (!theorem) {
        preview.innerHTML = '<p class="preview-empty">Select a theorem.</p>';
        return;
      }
      preview.innerHTML = theorem.previewHtml;
      window.MathJax?.typesetPromise?.([preview]).catch(() => undefined);
    }

    function html(value) {
      return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
    }

    search.addEventListener("input", () => {
      renderTree();
    });

    milestoneFilter.addEventListener("click", () => {
      milestoneOnly = !milestoneOnly;
      milestoneFilter.setAttribute("aria-pressed", String(milestoneOnly));
      milestoneFilter.textContent = milestoneOnly ? "★" : "☆";
      renderTree();
    });

    tree.addEventListener("click", (event) => {
      const target = event.target instanceof Element ? event.target : undefined;
      const button = target?.closest("[data-select-theorem]");
      if (!button) {
        return;
      }
      selectedName = button.dataset.selectTheorem || "";
      renderTree();
    });

    preview.addEventListener("click", (event) => {
      const target = event.target instanceof Element ? event.target : undefined;
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
      renderTree();
    });

    renderTree();
  </script>
</body>
</html>`;
}

function jsonForScript(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}
