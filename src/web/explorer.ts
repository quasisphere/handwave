import type { TheoremExplorerPayload } from "../handwave/explorer";
import { renderMathJaxConfigurationScript } from "../handwave/mathJax";

export interface TheoremExplorerRenderOptions {
  previewHtmlByName?: ReadonlyMap<string, string>;
  articleHtmlByTarget?: ReadonlyMap<string, string>;
  articleItems?: readonly TheoremExplorerArticleItem[];
  milestoneControls?: boolean;
  localNavigation?: boolean;
  applicationShell?: boolean;
}

export interface TheoremExplorerArticleItem {
  target: string;
  title: string;
  relativePath: string;
}

export function renderTheoremExplorerHtml(
  payload: TheoremExplorerPayload,
  options: TheoremExplorerRenderOptions = {}
): string {
  const previewHtmlMap = options.previewHtmlByName
    ? `new Map(${jsonForScript([...options.previewHtmlByName])})`
    : "new Map()";
  const articleHtmlMap = options.articleHtmlByTarget
    ? `new Map(${jsonForScript([...options.articleHtmlByTarget])})`
    : "new Map()";
  const articleItems = jsonForScript(options.articleItems ?? []);
  const applicationShell = options.applicationShell === true;
  const previewHtmlWithMilestoneControl = options.milestoneControls === false
    ? "previewHtml"
    : "injectPreviewMilestoneControl(previewHtml, theorem)";
  const localNavigationCondition = options.localNavigation
    ? "!openTargetLocally(targetName)"
    : "!link.closest(\".viewer-info\") || !openTargetLocally(targetName)";
  const initialThemeScript = applicationShell
    ? `<script>
    try {
      const storedTheme = localStorage.getItem("handwave-theme");
      document.documentElement.dataset.theme = storedTheme === "light" || storedTheme === "dark"
        ? storedTheme
        : (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    } catch {
      document.documentElement.dataset.theme = "light";
    }
    </script>`
    : "";
  const statusFilterControls = `<div id="status-filters" class="status-filter-group" role="group" aria-label="Theorem status filters">
      <button class="icon-button status-filter-button status-filter-green" type="button" data-status-filter="green" aria-pressed="true" aria-label="Green theorem status" title="Hide green theorems">✓</button>
      <button class="icon-button status-filter-button status-filter-yellow" type="button" data-status-filter="yellow" aria-pressed="true" aria-label="Yellow theorem status" title="Hide yellow theorems">✓</button>
      <button class="icon-button status-filter-button status-filter-red" type="button" data-status-filter="red" aria-pressed="true" aria-label="Red theorem status" title="Hide red theorems">✗</button>
      <button class="icon-button status-filter-button status-filter-unknown" type="button" data-status-filter="unknown" aria-pressed="true" aria-label="Unknown theorem status" title="Hide unknown-status theorems">?</button>
    </div>`;
  const explorerBody = applicationShell
    ? `<main id="application" class="explorer explorer-application" data-view="overview">
    <header class="app-bar">
      <div class="navigation-root">
        <button id="navigation-toggle" class="app-icon-button" type="button" aria-expanded="false" aria-controls="navigation-menu" title="Open navigation" aria-label="Open navigation"><span class="hamburger-icon" aria-hidden="true"></span></button>
        <nav id="navigation-menu" class="navigation-menu" aria-label="Views" hidden>
          <button class="navigation-item" type="button" data-switch-view="overview" aria-current="page"><span class="navigation-item-title">Overview</span><span class="navigation-item-detail">Browse articles, modules, and milestones</span></button>
          <button class="navigation-item" type="button" data-switch-view="explorer"><span class="navigation-item-title">Theorem explorer</span><span class="navigation-item-detail">Browse the dependency graph</span></button>
          <button id="article-view-navigation" class="navigation-item" type="button" data-switch-view="article" disabled><span class="navigation-item-title">Article view</span><span id="current-article-label" class="navigation-item-detail">Select an article from search</span></button>
        </nav>
      </div>
      <div class="global-search">
        <input id="search" class="search" type="search" placeholder="Search articles, modules, or theorems" aria-label="Search articles, modules, or theorems" autocomplete="off">
        <button id="search-rendered" class="search-rendered" type="button" tabindex="-1" aria-label="Edit search" hidden></button>
        <div id="suggestions" class="suggestions" role="listbox" aria-label="Search suggestions" hidden></div>
      </div>
      <button id="theme-toggle" class="app-icon-button theme-toggle" type="button" title="Use dark theme" aria-label="Use dark theme"><span id="theme-icon" aria-hidden="true">☾</span></button>
    </header>
    <section id="overview" class="overview-view" aria-label="Handwave overview">
      <header class="overview-header">
        <h1>Overview</h1>
        <p id="overview-summary">Articles, modules, and milestone theorems</p>
      </header>
      <div class="overview-columns">
        <section class="overview-column" aria-labelledby="overview-articles-title">
          <h2 id="overview-articles-title">Articles</h2>
          <div id="overview-articles" class="overview-list"></div>
        </section>
        <section class="overview-column" aria-labelledby="overview-modules-title">
          <h2 id="overview-modules-title">Modules</h2>
          <div id="overview-modules" class="overview-list"></div>
        </section>
        <section class="overview-column" aria-labelledby="overview-milestones-title">
          <h2 id="overview-milestones-title">Milestone theorems</h2>
          <div id="overview-milestones" class="overview-list"></div>
        </section>
      </div>
    </section>
    <section class="explorer-toolbar">
      <div id="stats" class="stats"></div>
      <div class="explorer-filter-controls">
        <button id="milestone-filter" class="icon-button" type="button" aria-pressed="true" title="Milestones">★</button>
        ${statusFilterControls}
      </div>
    </section>
    <section id="graph" class="graph" aria-label="Theorem dependency graph"></section>
    <section id="preview" class="preview" aria-label="Theorem or article preview">
      <p class="preview-empty">Select a theorem.</p>
    </section>
  </main>`
    : `<main id="application" class="explorer">
    <section class="toolbar">
      <div class="search-row">
        <input id="search" class="search" type="search" placeholder="Module or theorem" aria-label="Module or theorem">
        <div class="explorer-filter-controls">
          <button id="milestone-filter" class="icon-button" type="button" aria-pressed="true" title="Milestones">★</button>
          ${statusFilterControls}
        </div>
      </div>
      <div id="suggestions" class="suggestions" role="listbox" aria-label="Search suggestions" hidden></div>
      <div id="stats" class="stats"></div>
    </section>
    <section id="graph" class="graph" aria-label="Theorem dependency graph"></section>
    <section id="preview" class="preview" aria-label="Theorem preview">
      <p class="preview-empty">Select a theorem.</p>
    </section>
  </main>`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Handwave Theorem Explorer</title>
  ${initialThemeScript}
  <style>
    :root {
      color-scheme: light dark;
      --border: color-mix(in srgb, currentColor 18%, transparent);
      --muted: color-mix(in srgb, currentColor 62%, transparent);
      --surface: color-mix(in srgb, currentColor 5%, transparent);
      --hover: color-mix(in srgb, currentColor 9%, transparent);
      --accent: var(--vscode-focusBorder, #2f6feb);
      --danger: #d1242f;
      --warning: var(--vscode-editorWarning-foreground, #9a6700);
      --page-background: var(--vscode-sideBar-background, var(--vscode-editor-background, Canvas));
      --popover-background: var(--vscode-editorHoverWidget-background, var(--vscode-editor-background, Canvas));
      --syntax-keyword: var(--vscode-symbolIcon-keywordForeground, #cf222e);
      --syntax-constant: var(--vscode-symbolIcon-constantForeground, #0550ae);
      --syntax-comment: var(--vscode-descriptionForeground, #6e7781);
      --syntax-string: var(--vscode-symbolIcon-stringForeground, #0a7f42);
      --syntax-operator: var(--vscode-symbolIcon-operatorForeground, #8250df);
    }
    :root[data-theme="light"] {
      color-scheme: light;
      --page-background: #ffffff;
      --page-foreground: #1f2328;
      --popover-background: #ffffff;
      --surface: #f6f8fa;
      --hover: #eaeef2;
      --border: #d0d7de;
      --muted: #57606a;
    }
    :root[data-theme="dark"] {
      color-scheme: dark;
      --page-background: #0d1117;
      --page-foreground: #e6edf3;
      --popover-background: #161b22;
      --surface: #161b22;
      --hover: #21262d;
      --border: #30363d;
      --muted: #8b949e;
      --accent: #58a6ff;
      --warning: #d29922;
      --syntax-keyword: #ff7b72;
      --syntax-constant: #79c0ff;
      --syntax-comment: #8b949e;
      --syntax-string: #a5d6ff;
      --syntax-operator: #d2a8ff;
    }
    * { box-sizing: border-box; }
    body {
      background: var(--page-background);
      color: var(--page-foreground, var(--vscode-sideBar-foreground, var(--vscode-editor-foreground, CanvasText)));
      font-family: var(--vscode-font-family, ui-sans-serif, system-ui, sans-serif);
      font-size: var(--vscode-font-size, 13px);
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
    .explorer-application {
      grid-template-rows: auto auto minmax(150px, 1fr) minmax(150px, 42vh);
    }
    .app-bar {
      align-items: center;
      background: var(--page-background);
      border-bottom: 1px solid var(--border);
      display: grid;
      gap: 10px;
      grid-template-columns: auto minmax(180px, 680px) auto;
      justify-content: space-between;
      min-height: 48px;
      padding: 7px 10px;
      position: relative;
      z-index: 20;
    }
    .navigation-root {
      position: relative;
    }
    .app-icon-button {
      align-items: center;
      background: transparent;
      border: 1px solid transparent;
      border-radius: 6px;
      color: inherit;
      cursor: pointer;
      display: inline-flex;
      font: inherit;
      height: 32px;
      justify-content: center;
      padding: 0;
      width: 34px;
    }
    .app-icon-button:hover,
    .app-icon-button[aria-expanded="true"] {
      background: var(--hover);
      border-color: var(--border);
    }
    .hamburger-icon,
    .hamburger-icon::before,
    .hamburger-icon::after {
      background: currentColor;
      border-radius: 1px;
      content: "";
      display: block;
      height: 2px;
      position: relative;
      width: 17px;
    }
    .hamburger-icon::before {
      position: absolute;
      top: -6px;
    }
    .hamburger-icon::after {
      position: absolute;
      top: 6px;
    }
    .navigation-menu {
      background: var(--popover-background);
      border: 1px solid var(--border);
      border-radius: 8px;
      box-shadow: 0 8px 24px color-mix(in srgb, black 24%, transparent);
      display: grid;
      gap: 3px;
      left: 0;
      min-width: 240px;
      padding: 5px;
      position: absolute;
      top: calc(100% + 7px);
      z-index: 30;
    }
    .navigation-menu[hidden] {
      display: none;
    }
    .navigation-item {
      background: transparent;
      border: 0;
      border-radius: 5px;
      color: inherit;
      cursor: pointer;
      display: grid;
      gap: 1px;
      padding: 8px 10px;
      text-align: left;
      width: 100%;
    }
    .navigation-item:hover,
    .navigation-item[aria-current="page"] {
      background: var(--hover);
    }
    .navigation-item:disabled {
      cursor: default;
      opacity: 0.52;
    }
    .navigation-item-title {
      font-weight: 650;
    }
    .navigation-item-detail {
      color: var(--muted);
      font-size: 0.84em;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .global-search {
      max-width: 680px;
      min-width: 0;
      position: relative;
      width: min(52vw, 680px);
    }
    .global-search .search {
      border-radius: 6px;
      height: 32px;
      padding-left: 10px;
      padding-right: 10px;
    }
    .search-rendered {
      align-items: center;
      background: var(--vscode-input-background, var(--page-background));
      border: 1px solid var(--vscode-input-border, var(--border));
      border-radius: 6px;
      color: var(--vscode-input-foreground, var(--page-foreground));
      cursor: text;
      display: flex;
      font: inherit;
      height: 32px;
      inset: 0 0 auto;
      overflow: hidden;
      padding: 3px 10px;
      position: absolute;
      text-align: left;
      white-space: nowrap;
      width: 100%;
      z-index: 1;
    }
    .search-rendered[hidden] {
      display: none;
    }
    .search-rendered-label {
      display: block;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .search-rendered mjx-container,
    .suggestion-label mjx-container {
      display: inline-block !important;
      margin: 0 !important;
      overflow: visible;
      vertical-align: -0.15em;
    }
    .global-search .suggestions {
      left: 0;
      position: absolute;
      right: 0;
      top: calc(100% + 6px);
      z-index: 30;
    }
    .theme-toggle {
      font-size: 1.2em;
    }
    .explorer-toolbar {
      align-items: center;
      border-bottom: 1px solid var(--border);
      display: flex;
      gap: 8px;
      justify-content: space-between;
      min-height: 36px;
      padding: 5px 9px;
    }
    .explorer-filter-controls,
    .status-filter-group {
      align-items: center;
      display: inline-flex;
    }
    .explorer-filter-controls {
      flex: 0 0 auto;
      gap: 6px;
    }
    .status-filter-group {
      gap: 3px;
    }
    .overview-view {
      display: none;
    }
    .explorer-application[data-view="overview"] {
      grid-template-rows: auto minmax(0, 1fr);
    }
    .explorer-application[data-view="overview"] .overview-view {
      display: grid;
    }
    .explorer-application[data-view="overview"] .explorer-toolbar,
    .explorer-application[data-view="overview"] .graph,
    .explorer-application[data-view="overview"] .preview {
      display: none;
    }
    .overview-view {
      gap: 18px;
      grid-template-rows: auto minmax(0, 1fr);
      min-height: 0;
      padding: 26px clamp(18px, 3vw, 40px) 32px;
    }
    .overview-header {
      margin: 0 auto;
      max-width: 1440px;
      width: 100%;
    }
    .overview-header h1 {
      font-size: clamp(1.7rem, 3vw, 2.35rem);
      letter-spacing: -0.025em;
      line-height: 1.1;
      margin: 0;
    }
    .overview-header p {
      color: var(--muted);
      font-size: 0.95em;
      margin: 7px 0 0;
    }
    .overview-columns {
      display: grid;
      gap: clamp(12px, 2vw, 22px);
      grid-template-columns: repeat(3, minmax(0, 1fr));
      margin: 0 auto;
      max-width: 1440px;
      min-height: 0;
      width: 100%;
    }
    .overview-column {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 10px;
      display: grid;
      grid-template-rows: auto minmax(0, 1fr);
      min-height: 0;
      overflow: hidden;
    }
    .overview-column h2 {
      border-bottom: 1px solid var(--border);
      font-size: 0.92em;
      letter-spacing: 0.04em;
      margin: 0;
      padding: 12px 14px 10px;
      text-transform: uppercase;
    }
    .overview-list {
      min-height: 0;
      overflow: auto;
      padding: 5px;
    }
    .overview-item {
      align-items: center;
      background: transparent;
      border: 1px solid transparent;
      border-radius: 6px;
      color: inherit;
      cursor: pointer;
      display: grid;
      gap: 2px;
      padding: 8px 9px;
      text-align: left;
      width: 100%;
    }
    .overview-item:hover,
    .overview-item:focus-visible {
      background: var(--hover);
      border-color: var(--border);
      outline: none;
    }
    .overview-item-label-row {
      align-items: baseline;
      display: flex;
      gap: 7px;
      min-width: 0;
    }
    .overview-item-status {
      flex: 0 0 auto;
    }
    .overview-item-status .check-status {
      margin: 0;
    }
    .overview-item-label {
      font-weight: 620;
      min-width: 0;
      overflow-wrap: anywhere;
    }
    .overview-item-detail {
      color: var(--muted);
      font-size: 0.84em;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .overview-empty {
      color: var(--muted);
      margin: 0;
      padding: 12px 10px;
    }
    .explorer-application[data-view="article"] {
      grid-template-rows: auto minmax(0, 1fr);
    }
    .explorer-application[data-view="article"] .explorer-toolbar,
    .explorer-application[data-view="article"] .graph {
      display: none;
    }
    .explorer-application[data-view="article"] .preview {
      border-top: 0;
      padding: 0;
    }
    .article-layout {
      align-items: start;
      display: grid;
      grid-template-columns: clamp(200px, 22vw, 280px) minmax(0, 1fr);
      min-height: 100%;
      width: 100%;
    }
    .article-toc {
      align-self: start;
      background: var(--page-background);
      border-right: 1px solid var(--border);
      box-sizing: border-box;
      max-height: calc(100vh - 48px);
      overflow: auto;
      padding: 20px 12px 28px 14px;
      position: sticky;
      top: 0;
    }
    .article-toc-heading {
      font-size: 0.82em;
      font-weight: 750;
      letter-spacing: 0.04em;
      margin: 0 0 10px 22px;
      text-transform: uppercase;
    }
    .article-toc-list,
    .article-toc-children {
      list-style: none;
      margin: 0;
      padding: 0;
    }
    .article-toc-children {
      border-left: 1px solid var(--border);
      margin-left: 9px;
      padding-left: 9px;
    }
    .article-toc-title-item > .article-toc-children {
      border-left: 0;
      margin-left: 0;
      padding-left: 0;
    }
    .article-toc-children[hidden] {
      display: none;
    }
    .article-toc-row {
      align-items: start;
      display: grid;
      grid-template-columns: 20px minmax(0, 1fr);
      margin: 2px 0;
    }
    .article-toc-fold,
    .article-toc-link {
      background: transparent;
      border: 0;
      color: inherit;
      cursor: pointer;
      font: inherit;
    }
    .article-toc-fold {
      border-radius: 3px;
      height: 22px;
      line-height: 20px;
      padding: 0;
      text-align: center;
      width: 20px;
    }
    .article-toc-fold-spacer {
      display: block;
      height: 22px;
      width: 20px;
    }
    .article-toc-link {
      border-radius: 4px;
      line-height: 1.28;
      overflow-wrap: anywhere;
      padding: 3px 5px;
      text-align: left;
      width: 100%;
    }
    .article-toc-fold:hover,
    .article-toc-fold:focus-visible,
    .article-toc-link:hover,
    .article-toc-link:focus-visible,
    .article-toc-link.is-current {
      background: var(--hover);
      outline: none;
    }
    .article-toc-link.is-current {
      color: var(--vscode-textLink-foreground, var(--accent));
      font-weight: 650;
    }
    .article-toc-title-link {
      font-weight: 720;
      margin-bottom: 3px;
    }
    .article-toc-empty {
      color: var(--muted);
      font-size: 0.9em;
      margin: 0 0 0 22px;
    }
    .explorer-application[data-view="article"] .article-view {
      box-sizing: border-box;
      margin: 0 auto;
      max-width: 880px;
      min-width: 0;
      padding: 28px 28px 72px;
      width: 100%;
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
      background: var(--vscode-dropdown-background, var(--page-background));
      border: 1px solid var(--vscode-dropdown-border, var(--border));
      box-shadow: 0 4px 12px color-mix(in srgb, #000 22%, transparent);
      max-height: 260px;
      overflow: auto;
      padding: 4px 0;
      z-index: 30;
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
    .status-filter-button {
      --status-filter-color: var(--muted);
      color: var(--status-filter-color);
      font-weight: 750;
      min-width: 26px;
      padding: 0 5px;
    }
    .status-filter-green {
      --status-filter-color: var(--vscode-testing-iconPassed, #1a7f37);
    }
    .status-filter-yellow {
      --status-filter-color: var(--warning);
    }
    .status-filter-red {
      --status-filter-color: var(--vscode-testing-iconFailed, #d1242f);
    }
    .icon-button.status-filter-button[aria-pressed="true"] {
      background: color-mix(in srgb, var(--status-filter-color) 13%, var(--page-background));
      border-color: color-mix(in srgb, var(--status-filter-color) 52%, var(--border));
      color: var(--status-filter-color);
    }
    .icon-button.status-filter-button[aria-pressed="false"] {
      color: var(--status-filter-color);
      opacity: 0.35;
    }
    .icon-button.status-filter-button[aria-pressed="false"]:hover,
    .icon-button.status-filter-button[aria-pressed="false"]:focus-visible {
      opacity: 0.7;
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
      background: var(--page-background);
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
      background: color-mix(in srgb, currentColor 9%, var(--page-background));
      border-color: color-mix(in srgb, var(--accent) 55%, var(--border));
    }
    .graph-node-dependency {
      background: color-mix(in srgb, var(--accent) 12%, var(--page-background));
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
      padding: 10px 12px 16px 30px;
    }
    .preview-empty {
      color: var(--muted);
      margin: 0;
    }
    .article-view h1,
    .article-view h2,
    .article-view h3,
    .article-view h4,
    .article-view h5,
    .article-view h6 {
      line-height: 1.2;
      margin: 1.4em 0 0.5em;
    }
    .article-view h1 {
      margin-top: 0;
    }
    .article-view .include {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 6px;
      margin: 1em 0;
      padding: 10px 12px;
      white-space: pre-wrap;
    }
    .theorem-view,
    .definition-view {
      margin: 0;
    }
    .preview .theorem-view + .theorem-view,
    .preview .theorem-view + .definition-view,
    .preview .definition-view + .theorem-view,
    .preview .definition-view + .definition-view {
      margin-top: 1.25em;
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
    .graph-node-status {
      line-height: 1.25;
      text-align: center;
    }
    .graph-node-status > .check-status {
      line-height: 1.25;
      margin-right: 0;
    }
    .check-status-checked {
      color: var(--vscode-testing-iconPassed, #1a7f37);
    }
    .check-status-unchecked {
      color: var(--vscode-testing-iconFailed, #d1242f);
    }
    .check-status-dependency-warning {
      color: var(--warning);
    }
    .check-status-inconclusive,
    .check-status-blocked,
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
    .proof-body,
    .proof-body > .prose-content,
    .proof-body > .prose-content > .prose-paragraph:first-child {
      display: inline;
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
    .preview .theorem-line {
      position: relative;
    }
    .preview .theorem-line > .check-status {
      left: -1.55em;
      margin-right: 0;
      position: absolute;
      top: 0;
    }
    .preview .declaration-label {
      display: inline-block;
      position: relative;
    }
    .preview .source-popover {
      background: var(--popover-background);
      border: 1px solid var(--vscode-editorHoverWidget-border, var(--border));
      border-radius: 6px;
      box-shadow: 0 6px 18px color-mix(in srgb, black 18%, transparent);
      box-sizing: border-box;
      display: none;
      left: 0;
      max-width: min(560px, calc(100vw - 32px));
      min-width: min(18em, calc(100vw - 32px));
      padding: 6px 8px;
      position: absolute;
      top: calc(100% + 2px);
      width: max-content;
      z-index: 10;
    }
    .preview .source-popover::before {
      content: "";
      height: 8px;
      left: 0;
      position: absolute;
      right: 0;
      top: -8px;
    }
    .preview .source-popover a,
    .preview .source-popover .source-name {
      display: inline-block;
      font-family: var(--vscode-editor-font-family, ui-monospace, monospace);
      font-size: 0.9em;
      max-width: 48ch;
      overflow: hidden;
      text-overflow: ellipsis;
      vertical-align: bottom;
      white-space: nowrap;
    }
    .preview .source-popover-row {
      align-items: center;
      display: inline-flex;
      max-width: 100%;
    }
    .preview .source-popover-row + .source-popover-row {
      border-top: 1px solid var(--border);
      margin-top: 6px;
      padding-top: 6px;
    }
    .preview .source-popover-separator {
      color: var(--muted);
      margin: 0 7px;
    }
    .preview .declaration-label:hover .source-popover,
    .preview .declaration-label:focus-within .source-popover {
      display: block;
    }
    .preview .view-switch {
      align-items: center;
      display: inline-flex;
      gap: 2px;
    }
    .preview .milestone-tag {
      color: var(--warning);
      display: inline-flex;
      font-weight: 700;
      justify-content: center;
      margin-right: 4px;
      width: 1.2em;
    }
    .preview .mode-control,
    .preview .collapse-control {
      background: transparent;
      border: 1px solid var(--border);
      border-radius: 4px;
      color: var(--vscode-button-secondaryForeground, currentColor);
      cursor: pointer;
      font: inherit;
      font-size: 0.72em;
      font-variant: small-caps;
      letter-spacing: 0;
      line-height: 1.2;
      padding: 2px 6px;
      text-transform: lowercase;
    }
    .preview .collapse-control {
      align-items: center;
      border-color: transparent;
      display: inline-flex;
      font-size: 1.05em;
      height: 1.25em;
      justify-content: center;
      padding: 0;
      text-transform: none;
      width: 1.25em;
    }
    .preview .mode-control:hover,
    .preview .collapse-control:hover,
    .preview .copy-control:hover {
      background: var(--vscode-button-secondaryHoverBackground, var(--surface));
    }
    .preview .mode-control[aria-pressed="true"] {
      background: var(--vscode-button-secondaryBackground, var(--surface));
      border-color: color-mix(in srgb, currentColor 34%, transparent);
    }
    .preview .copy-control {
      align-items: center;
      background: transparent;
      border: 1px solid var(--border);
      border-radius: 4px;
      color: var(--vscode-button-secondaryForeground, currentColor);
      cursor: pointer;
      display: inline-flex;
      font: inherit;
      height: 1.55em;
      justify-content: center;
      margin-left: 6px;
      padding: 0;
      width: 1.55em;
    }
    .preview .copy-icon {
      display: inline-block;
      height: 0.82em;
      position: relative;
      width: 0.82em;
    }
    .preview .copy-icon::before,
    .preview .copy-icon::after {
      border: 1.4px solid currentColor;
      border-radius: 2px;
      box-sizing: border-box;
      content: "";
      height: 0.62em;
      position: absolute;
      width: 0.52em;
    }
    .preview .copy-icon::before {
      left: 0.08em;
      top: 0.18em;
    }
    .preview .copy-icon::after {
      background: var(--popover-background);
      left: 0.22em;
      top: 0.02em;
    }
    .preview .dependency-tree {
      border-top: 1px solid var(--border);
      display: block;
      font-family: var(--vscode-editor-font-family, ui-monospace, monospace);
      font-size: 0.9em;
      margin-top: 6px;
      max-height: min(45vh, 360px);
      min-width: 18em;
      overflow: auto;
      padding-top: 6px;
    }
    .preview .dependency-tree-list,
    .preview .dependency-tree-item {
      display: block;
    }
    .preview .dependency-tree-list {
      list-style: none;
      margin: 0;
      padding-left: 0;
    }
    .preview .dependency-tree-list .dependency-tree-list {
      border-left: 1px solid var(--border);
      margin-left: 0.62em;
      padding-left: 0.95em;
    }
    .preview .dependency-tree-item + .dependency-tree-item {
      margin-top: 4px;
    }
    .preview .dependency-node {
      align-items: center;
      display: flex;
      min-width: 0;
      white-space: nowrap;
    }
    .preview .dependency-tree .check-status {
      flex: 0 0 auto;
      margin-right: 0.45em;
    }
    .preview .dependency-link {
      max-width: 48ch;
    }
    .preview .sr-only {
      clip: rect(0 0 0 0);
      clip-path: inset(50%);
      height: 1px;
      overflow: hidden;
      position: absolute;
      white-space: nowrap;
      width: 1px;
    }
    .preview .lean-content {
      display: block;
    }
    .preview .theorem-view pre,
    .preview .definition-view pre {
      margin: 0;
      tab-size: 2;
      white-space: pre;
    }
    .preview .lean-source {
      display: block;
    }
    .preview .lean-keyword { color: var(--syntax-keyword); font-weight: 600; }
    .preview .lean-constant { color: var(--syntax-constant); }
    .preview .lean-comment { color: var(--syntax-comment); font-style: italic; }
    .preview .lean-string { color: var(--syntax-string); }
    .preview .lean-operator { color: var(--syntax-operator); }
    .preview [data-mode="text"] .lean-content,
    .preview [data-mode="lean"] .prose-content,
    .preview [data-mode="collapsed"] .proof-content {
      display: none;
    }
    .preview .proof-line .collapse-control {
      left: -1.55em;
      position: absolute;
      top: -0.05em;
    }
    .preview .proof-body .lean-content {
      margin-top: 0.5em;
    }
    mjx-container {
      max-width: 100%;
      overflow-x: auto;
      overflow-y: hidden;
    }
    @media (max-width: 620px) {
      .app-bar {
        gap: 6px;
        padding-left: 6px;
        padding-right: 6px;
      }
      .global-search {
        width: 100%;
      }
      .article-layout {
        grid-template-columns: minmax(132px, 34vw) minmax(0, 1fr);
      }
      .article-toc {
        font-size: 0.84em;
        padding: 14px 6px 22px 7px;
      }
      .article-toc-heading,
      .article-toc-empty {
        margin-left: 18px;
      }
      .article-toc-row {
        grid-template-columns: 18px minmax(0, 1fr);
      }
      .article-toc-fold,
      .article-toc-fold-spacer {
        width: 18px;
      }
      .explorer-application[data-view="article"] .article-view {
        padding: 20px 16px 56px;
      }
    }
    @media (max-width: 780px) {
      .explorer-application[data-view="overview"] .overview-view {
        display: block;
        overflow: auto;
      }
      .overview-columns {
        grid-template-columns: 1fr;
        margin-top: 18px;
      }
      .overview-column {
        min-height: 260px;
      }
      .overview-list {
        max-height: min(52vh, 440px);
      }
    }
  </style>
  <script>
    ${renderMathJaxConfigurationScript()}
  </script>
  <script async src="https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-chtml.js"></script>
</head>
<body>
  ${explorerBody}
  <script>
    const vscode = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : undefined;
    let payload = ${jsonForScript(payload)};
    let theoremMap = createTheoremMap(payload);
    let publicTheoremList = payload.theorems.filter((theorem) => !theorem.isPrivate);
    let milestoneOnly = true;
    const statusFilterCategories = ["green", "yellow", "red", "unknown"];
    let enabledStatusFilters = new Set(statusFilterCategories);
    let selectedName = "";
    let selectedArticleTarget = "";
    let lastArticleTarget = "";
    let searchSelection = undefined;
    let suggestionsOpen = false;
    let suggestionItems = [];
    let activeSuggestionIndex = -1;
    let graphLayoutVersion = 0;
    let graphMathTypesetLayout = undefined;
    let graphMathTypesetVersion = 0;
    let graphMathTypesetScheduled = false;
    let searchMathTypesetVersion = 0;
    let overviewMathTypesetVersion = 0;
    let currentGraphLayout = undefined;
    let visibleTheoremKey = "";
    let nextPreviewRequestId = 1;
    let previewMathTypesetVersion = 0;
    let articleScrollFrame = 0;
    let mathTypesetPromise = Promise.resolve();
    const previewHtmlByName = ${previewHtmlMap};
    const articleHtmlByTarget = ${articleHtmlMap};
    const articleSearchItems = ${articleItems};
    const applicationShellEnabled = ${String(applicationShell)};
    const pendingPreviewRequestIds = new Map();

    const search = document.getElementById("search");
    const searchRendered = document.getElementById("search-rendered");
    const suggestions = document.getElementById("suggestions");
    const milestoneFilter = document.getElementById("milestone-filter");
    const statusFilters = document.getElementById("status-filters");
    const stats = document.getElementById("stats");
    const graph = document.getElementById("graph");
    const preview = document.getElementById("preview");
    const application = document.getElementById("application");
    const navigationRoot = document.querySelector(".navigation-root");
    const navigationToggle = document.getElementById("navigation-toggle");
    const navigationMenu = document.getElementById("navigation-menu");
    const articleViewNavigation = document.getElementById("article-view-navigation");
    const currentArticleLabel = document.getElementById("current-article-label");
    const overview = document.getElementById("overview");
    const overviewSummary = document.getElementById("overview-summary");
    const overviewArticles = document.getElementById("overview-articles");
    const overviewModules = document.getElementById("overview-modules");
    const overviewMilestones = document.getElementById("overview-milestones");
    const themeToggle = document.getElementById("theme-toggle");
    const themeIcon = document.getElementById("theme-icon");

    function clearTypesetMath(element) {
      const mathJax = window.MathJax;
      if (
        !element.querySelector("mjx-container") ||
        typeof mathJax?.typesetClear !== "function"
      ) {
        return;
      }
      mathJax.typesetClear([element]);
    }

    function replaceTypesetContent(element, htmlContent) {
      clearTypesetMath(element);
      element.innerHTML = htmlContent;
    }

    function queueMathTypeset(elementsProvider, isCurrent, onComplete) {
      const mathJax = window.MathJax;
      if (typeof mathJax?.typesetPromise !== "function") {
        return;
      }
      mathTypesetPromise = mathTypesetPromise
        .catch(() => undefined)
        .then(() => {
          if (!isCurrent()) {
            return undefined;
          }
          const elements = elementsProvider();
          if (elements.length === 0) {
            return undefined;
          }
          return mathJax.typesetPromise(elements).then(() => {
            if (isCurrent()) {
              onComplete?.();
            }
          });
        })
        .catch(() => undefined);
    }

    function containsMathDelimiter(value) {
      const text = String(value ?? "");
      if (
        (text.includes("\\\\(") && text.includes("\\\\)")) ||
        (text.includes("\\\\[") && text.includes("\\\\]"))
      ) {
        return true;
      }
      let dollarCount = 0;
      for (let index = 0; index < text.length; index += 1) {
        if (text[index] === "$" && (index === 0 || text[index - 1] !== "\\\\")) {
          dollarCount += 1;
          if (dollarCount >= 2) {
            return true;
          }
        }
      }
      return false;
    }

    function scheduleSearchMathTypeset() {
      const version = ++searchMathTypesetVersion;
      queueMathTypeset(
        () => [
          ...suggestions.querySelectorAll("[data-search-math]"),
          ...(searchRendered && !searchRendered.hidden && searchRendered.hasAttribute("data-search-math")
            ? [searchRendered]
            : [])
        ],
        () => version === searchMathTypesetVersion
      );
    }

    function updateRenderedSearchValue() {
      if (!searchRendered) {
        return;
      }
      const label = searchSelection?.label;
      if (!label || document.activeElement === search) {
        searchRendered.hidden = true;
        searchRendered.removeAttribute("data-search-math");
        searchMathTypesetVersion++;
        return;
      }
      replaceTypesetContent(
        searchRendered,
        '<span class="search-rendered-label">' + html(label) + '</span>'
      );
      searchRendered.hidden = false;
      searchRendered.setAttribute("aria-label", "Edit search: " + label);
      searchRendered.toggleAttribute("data-search-math", containsMathDelimiter(label));
      scheduleSearchMathTypeset();
    }

    function scheduleGraphMathTypeset(layout, version) {
      graphMathTypesetLayout = layout;
      graphMathTypesetVersion = version;
      if (graphMathTypesetScheduled) {
        return;
      }
      graphMathTypesetScheduled = true;
      window.requestAnimationFrame(() => {
        graphMathTypesetScheduled = false;
        const scheduledLayout = graphMathTypesetLayout;
        const scheduledVersion = graphMathTypesetVersion;
        if (!scheduledLayout) {
          return;
        }
        queueMathTypeset(
          () => [...graph.querySelectorAll("[data-graph-math]")],
          () => scheduledVersion === graphMathTypesetVersion && scheduledVersion === graphLayoutVersion,
          () => window.requestAnimationFrame(() => applyMeasuredGraphLayout(scheduledLayout, scheduledVersion))
        );
      });
    }

    function createTheoremMap(sourcePayload) {
      const result = new Map();
      for (const theorem of sourcePayload.theorems) {
        result.set(theorem.name, theorem);
      }
      return result;
    }

    function byName() {
      return theoremMap;
    }

    function theoremForTarget(target) {
      const name = leanNameFromTarget(target);
      return name ? byName().get(name) : undefined;
    }

    function leanNameFromTarget(target) {
      if (typeof target !== "string" || !target.startsWith("lean:")) {
        return undefined;
      }

      let name = target.slice("lean:".length);
      for (const selector of ["lean.statement", "lean.proof", "statement", "proof"]) {
        const suffix = "." + selector;
        if (name.endsWith(suffix)) {
          name = name.slice(0, -suffix.length);
          break;
        }
      }
      return name || undefined;
    }

    function openTargetLocally(target) {
      const theorem = theoremForTarget(target);
      if (theorem) {
        restrictToTheorem(theorem);
        preview.scrollTop = 0;
        return true;
      }

      const articleTarget = staticArticleTarget(target);
      const articleBase = articleTargetBase(articleTarget);
      if (!articleTarget || !articleBase || !articleHtmlByTarget.has(articleBase)) {
        return false;
      }

      showArticle(articleTarget, true);
      return true;
    }

    function articleItemForTarget(target) {
      const base = articleTargetBase(target);
      return articleSearchItems.find((article) => article.target === base);
    }

    function overviewModuleItems() {
      const modules = new Map();
      for (const theorem of publicTheorems()) {
        if (theorem.moduleName) {
          modules.set(theorem.moduleName, (modules.get(theorem.moduleName) || 0) + 1);
        }
      }
      return [...modules.entries()]
        .sort((first, second) => first[0].localeCompare(second[0]))
        .map(([moduleName, count]) => ({
          type: "module",
          value: moduleName,
          label: moduleName,
          detail: String(count) + " theorem" + (count === 1 ? "" : "s")
        }));
    }

    function overviewArticleItems() {
      return [...articleSearchItems]
        .sort((first, second) =>
          first.title.localeCompare(second.title) ||
          first.relativePath.localeCompare(second.relativePath)
        )
        .map((article) => ({
          type: "article",
          value: article.target,
          label: article.title,
          detail: article.relativePath
        }));
    }

    function overviewMilestoneItems() {
      return publicTheorems()
        .filter((theorem) => theorem.milestone)
        .sort((first, second) =>
          first.moduleName.localeCompare(second.moduleName) ||
          first.displayName.localeCompare(second.displayName) ||
          first.sourceName.localeCompare(second.sourceName)
        )
        .map((theorem) => ({
          type: "theorem",
          value: theorem.name,
          label: theorem.displayName,
          detail: theorem.moduleName || theorem.relativePath,
          statusHtml: theorem.statusHtml
        }));
    }

    function renderOverviewItem(item) {
      const mathAttribute = containsMathDelimiter(item.label) ? ' data-overview-math="true"' : '';
      const status = item.statusHtml
        ? '<span class="overview-item-status">' + item.statusHtml + '</span>'
        : '';
      return '<button class="overview-item" type="button" data-overview-type="' + html(item.type) +
        '" data-overview-value="' + html(item.value) + '" title="Open ' + html(item.label) + '">' +
        '<span class="overview-item-label-row">' + status +
        '<span class="overview-item-label"' + mathAttribute + '>' + html(item.label) + '</span></span>' +
        '<span class="overview-item-detail">' + html(item.detail || '') + '</span>' +
        '</button>';
    }

    function renderOverviewList(element, items, emptyText) {
      replaceTypesetContent(
        element,
        items.length > 0
          ? items.map(renderOverviewItem).join("")
          : '<p class="overview-empty">' + html(emptyText) + '</p>'
      );
    }

    function renderOverview() {
      if (
        !applicationShellEnabled ||
        !overview ||
        !overviewSummary ||
        !overviewArticles ||
        !overviewModules ||
        !overviewMilestones
      ) {
        return;
      }
      const articles = overviewArticleItems();
      const modules = overviewModuleItems();
      const milestones = overviewMilestoneItems();
      overviewSummary.textContent =
        String(articles.length) + " article" + (articles.length === 1 ? "" : "s") + " · " +
        String(modules.length) + " module" + (modules.length === 1 ? "" : "s") + " · " +
        String(milestones.length) + " milestone theorem" + (milestones.length === 1 ? "" : "s");
      renderOverviewList(overviewArticles, articles, "No articles are available.");
      renderOverviewList(overviewModules, modules, "No theorem modules are available.");
      renderOverviewList(overviewMilestones, milestones, "No milestone theorems are available.");
      const version = ++overviewMathTypesetVersion;
      queueMathTypeset(
        () => [...overview.querySelectorAll("[data-overview-math]")],
        () => version === overviewMathTypesetVersion
      );
    }

    function showArticle(target, updateSearch = false, recordHistory = true) {
      const base = articleTargetBase(target);
      if (!base || !articleHtmlByTarget.has(base)) {
        return false;
      }
      selectedArticleTarget = target;
      lastArticleTarget = target;
      selectedName = "";
      const article = articleItemForTarget(target);
      if (updateSearch && article) {
        searchSelection = {
          type: "article",
          value: article.target,
          label: article.title,
          detail: article.relativePath
        };
        search.value = article.title;
        updateRenderedSearchValue();
      }
      preview.scrollTop = 0;
      updateApplicationView("article");
      renderPreview();
      if (recordHistory) {
        recordApplicationHistory("push");
      }
      return true;
    }

    function updateApplicationView(view) {
      if (!applicationShellEnabled || !application) {
        return;
      }
      const overviewView = view === "overview";
      const articleView = view === "article" && Boolean(selectedArticleTarget);
      application.dataset.view = overviewView ? "overview" : (articleView ? "article" : "explorer");
      for (const item of application.querySelectorAll("[data-switch-view]")) {
        const active = item.dataset.switchView === application.dataset.view;
        if (active) {
          item.setAttribute("aria-current", "page");
        } else {
          item.removeAttribute("aria-current");
        }
      }
      const article = articleItemForTarget(lastArticleTarget);
      if (articleViewNavigation) {
        articleViewNavigation.disabled = !lastArticleTarget;
      }
      if (currentArticleLabel) {
        currentArticleLabel.textContent = article?.title || "Select an article from search";
      }
      preview.setAttribute("aria-label", articleView ? "Article view" : "Theorem preview");
      document.title = overviewView
        ? "Handwave Overview"
        : (articleView && article ? article.title + " – Handwave" : "Handwave Theorem Explorer");
    }

    function switchApplicationView(view, recordHistory = true) {
      if (view === "article") {
        if (lastArticleTarget) {
          showArticle(lastArticleTarget, true, recordHistory);
        }
        return;
      }
      if (view === "overview") {
        selectedArticleTarget = "";
        selectedName = "";
        searchSelection = undefined;
        search.value = "";
        suggestionsOpen = false;
        hideSuggestions();
        updateRenderedSearchValue();
        updateApplicationView("overview");
        renderOverview();
        if (recordHistory) {
          recordApplicationHistory("push");
        }
        return;
      }
      selectedArticleTarget = "";
      if (searchSelection?.type === "article") {
        searchSelection = undefined;
        search.value = "";
        updateRenderedSearchValue();
      }
      updateApplicationView("explorer");
      renderExplorerGraph();
      if (recordHistory) {
        recordApplicationHistory("push");
      }
    }

    function setNavigationMenuOpen(open) {
      if (!navigationMenu || !navigationToggle) {
        return;
      }
      navigationMenu.hidden = !open;
      navigationToggle.setAttribute("aria-expanded", String(open));
      navigationToggle.setAttribute("title", open ? "Close navigation" : "Open navigation");
      navigationToggle.setAttribute("aria-label", open ? "Close navigation" : "Open navigation");
    }

    function syncThemeControl() {
      if (!themeToggle || !themeIcon) {
        return;
      }
      const dark = document.documentElement.dataset.theme === "dark";
      themeIcon.textContent = dark ? "☀" : "☾";
      const label = dark ? "Use light theme" : "Use dark theme";
      themeToggle.setAttribute("title", label);
      themeToggle.setAttribute("aria-label", label);
    }

    function toggleTheme() {
      const nextTheme = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
      document.documentElement.dataset.theme = nextTheme;
      try {
        localStorage.setItem("handwave-theme", nextTheme);
      } catch {
        // A restrictive host may disable storage; the current-page theme still works.
      }
      syncThemeControl();
    }

    function staticArticleTarget(target) {
      if (typeof target !== "string") {
        return undefined;
      }
      if (target.startsWith("article:")) {
        return target;
      }
      if (target.startsWith("local:#") && selectedArticleTarget.startsWith("article:")) {
        return articleTargetBase(selectedArticleTarget) + target.slice("local:".length);
      }
      return undefined;
    }

    function articleTargetBase(target) {
      if (!target) {
        return undefined;
      }
      const hashIndex = target.indexOf("#");
      return hashIndex >= 0 ? target.slice(0, hashIndex) : target;
    }

    function historySearchSelection(item) {
      if (!item) {
        return null;
      }
      const result = {
        type: item.type,
        value: item.value,
        label: item.label
      };
      if (item.detail) {
        result.detail = item.detail;
      }
      return result;
    }

    function historyRootTheoremName() {
      if (searchSelection?.type !== "theorem") {
        return "";
      }
      return byName().has(searchSelection.value) ? searchSelection.value : "";
    }

    function currentApplicationHistoryState() {
      const currentView = application?.dataset.view;
      const overviewView = currentView === "overview";
      const articleView = currentView === "article" && Boolean(selectedArticleTarget);
      return {
        handwaveStaticView: true,
        view: overviewView ? "overview" : (articleView ? "article" : "explorer"),
        articleTarget: articleView ? selectedArticleTarget : "",
        lastArticleTarget,
        selectedName: articleView || overviewView ? "" : historyRootTheoremName(),
        searchSelection: overviewView ? null : historySearchSelection(searchSelection),
        searchValue: overviewView ? "" : search.value,
        milestoneOnly,
        statusFilters: statusFilterCategories.filter((category) => enabledStatusFilters.has(category))
      };
    }

    function applicationHistoryUrl(state) {
      if (state.view === "article" && state.articleTarget) {
        return "#article=" + encodeURIComponent(state.articleTarget);
      }
      if (state.selectedName) {
        return "#theorem=" + encodeURIComponent(state.selectedName);
      }
      if (state.searchSelection?.type === "module") {
        return "#module=" + encodeURIComponent(state.searchSelection.value);
      }
      if (state.view === "overview") {
        return "#overview";
      }
      return "#explorer";
    }

    function recordApplicationHistory(mode) {
      if (!applicationShellEnabled || !application) {
        return;
      }
      const state = currentApplicationHistoryState();
      const url = applicationHistoryUrl(state);
      try {
        if (JSON.stringify(window.history.state) === JSON.stringify(state)) {
          if (window.location.hash !== url) {
            window.history.replaceState(state, "", url);
          }
          return;
        }
        if (mode === "replace") {
          window.history.replaceState(state, "", url);
        } else {
          window.history.pushState(state, "", url);
        }
      } catch {
        // Some embedded or restrictive hosts disable the History API.
      }
    }

    function decodedHistoryValue(prefix) {
      if (!window.location.hash.startsWith(prefix)) {
        return undefined;
      }
      try {
        return decodeURIComponent(window.location.hash.slice(prefix.length));
      } catch {
        return undefined;
      }
    }

    function applicationHistoryStateFromLocation() {
      const articleTarget = decodedHistoryValue("#article=");
      const articleBase = articleTargetBase(articleTarget);
      const article = articleBase ? articleItemForTarget(articleBase) : undefined;
      if (articleTarget && articleBase && articleHtmlByTarget.has(articleBase) && article) {
        return {
          handwaveStaticView: true,
          view: "article",
          articleTarget,
          lastArticleTarget: articleTarget,
          selectedName: "",
          searchSelection: {
            type: "article",
            value: article.target,
            label: article.title,
            detail: article.relativePath
          },
          searchValue: article.title,
          milestoneOnly: true,
          statusFilters: [...statusFilterCategories]
        };
      }

      const theoremName = decodedHistoryValue("#theorem=");
      const theorem = theoremName ? byName().get(theoremName) : undefined;
      if (theorem) {
        return {
          handwaveStaticView: true,
          view: "explorer",
          articleTarget: "",
          lastArticleTarget: "",
          selectedName: theorem.name,
          searchSelection: {
            type: "theorem",
            value: theorem.name,
            label: theorem.displayName,
            detail: theorem.sourceName
          },
          searchValue: searchSelectionText({
            type: "theorem",
            value: theorem.name,
            label: theorem.displayName,
            detail: theorem.sourceName
          }),
          milestoneOnly: true,
          statusFilters: [...statusFilterCategories]
        };
      }

      const moduleName = decodedHistoryValue("#module=");
      const moduleCount = moduleName
        ? publicTheorems().filter((item) => item.moduleName === moduleName).length
        : 0;
      if (moduleName && moduleCount > 0) {
        return {
          handwaveStaticView: true,
          view: "explorer",
          articleTarget: "",
          lastArticleTarget: "",
          selectedName: "",
          searchSelection: {
            type: "module",
            value: moduleName,
            label: moduleName,
            detail: String(moduleCount) + " theorem" + (moduleCount === 1 ? "" : "s")
          },
          searchValue: moduleName,
          milestoneOnly: true,
          statusFilters: [...statusFilterCategories]
        };
      }

      return {
        handwaveStaticView: true,
        view: window.location.hash === "#explorer" ? "explorer" : "overview",
        articleTarget: "",
        lastArticleTarget: "",
        selectedName: "",
        searchSelection: null,
        searchValue: "",
        milestoneOnly: true,
        statusFilters: [...statusFilterCategories]
      };
    }

    function validatedHistorySearchSelection(item) {
      if (!item || typeof item.type !== "string" || typeof item.value !== "string") {
        return undefined;
      }
      if (item.type === "article") {
        const article = articleItemForTarget(item.value);
        return article ? {
          type: "article",
          value: article.target,
          label: article.title,
          detail: article.relativePath
        } : undefined;
      }
      if (item.type === "theorem") {
        const theorem = byName().get(item.value);
        return theorem ? {
          type: "theorem",
          value: theorem.name,
          label: theorem.displayName,
          detail: theorem.sourceName
        } : undefined;
      }
      if (
        item.type === "module" &&
        publicTheorems().some((theorem) => theorem.moduleName === item.value)
      ) {
        return {
          type: "module",
          value: item.value,
          label: typeof item.label === "string" ? item.label : item.value,
          detail: typeof item.detail === "string" ? item.detail : undefined
        };
      }
      return undefined;
    }

    function restoreApplicationHistory(rawState) {
      if (!applicationShellEnabled || !application) {
        return false;
      }
      const state = rawState?.handwaveStaticView === true
        ? rawState
        : applicationHistoryStateFromLocation();
      let restoredSelection = validatedHistorySearchSelection(state.searchSelection);
      const articleTarget = typeof state.articleTarget === "string" ? state.articleTarget : "";
      const articleBase = articleTargetBase(articleTarget);
      const validArticleTarget = Boolean(articleBase && articleHtmlByTarget.has(articleBase));
      const rememberedArticleTarget = typeof state.lastArticleTarget === "string"
        ? state.lastArticleTarget
        : "";
      const rememberedArticleBase = articleTargetBase(rememberedArticleTarget);
      lastArticleTarget = rememberedArticleBase && articleHtmlByTarget.has(rememberedArticleBase)
        ? rememberedArticleTarget
        : (validArticleTarget ? articleTarget : "");
      setMilestoneOnly(state.milestoneOnly !== false);
      setEnabledStatusFilters(
        Array.isArray(state.statusFilters) ? state.statusFilters : statusFilterCategories
      );
      suggestionsOpen = false;
      hideSuggestions();
      setNavigationMenuOpen(false);

      if (state.view === "overview") {
        selectedArticleTarget = "";
        selectedName = "";
        searchSelection = undefined;
        search.value = "";
        updateRenderedSearchValue();
        updateApplicationView("overview");
        renderOverview();
        return true;
      }

      if (state.view === "article" && validArticleTarget) {
        const article = articleItemForTarget(articleTarget);
        if (article && restoredSelection?.type !== "article") {
          restoredSelection = {
            type: "article",
            value: article.target,
            label: article.title,
            detail: article.relativePath
          };
        }
        searchSelection = restoredSelection;
        search.value = typeof state.searchValue === "string" && state.searchValue
          ? state.searchValue
          : (restoredSelection ? searchSelectionText(restoredSelection) : "");
        updateRenderedSearchValue();
        return showArticle(articleTarget, false, false);
      }

      if (restoredSelection?.type === "article") {
        restoredSelection = undefined;
      }
      selectedArticleTarget = "";
      searchSelection = restoredSelection;
      search.value = typeof state.searchValue === "string"
        ? state.searchValue
        : (restoredSelection ? searchSelectionText(restoredSelection) : "");
      const restoredName = typeof state.selectedName === "string" && byName().has(state.selectedName)
        ? state.selectedName
        : (restoredSelection?.type === "theorem" ? restoredSelection.value : "");
      selectedName = restoredName;
      updateRenderedSearchValue();
      preview.scrollTop = 0;
      updateApplicationView("explorer");
      renderExplorerGraph();
      return true;
    }

    function setTheoremMilestone(theorem, active) {
      const tags = Array.isArray(theorem.tags)
        ? theorem.tags.filter((tag) => tag !== "milestone")
        : [];
      theorem.tags = active ? [...tags, "milestone"] : tags;
      theorem.milestone = active;
    }

    function updatePayloadMilestoneCount() {
      payload.milestoneCount = publicTheorems().filter((theorem) => theorem.milestone).length;
    }

    function setTagState(target, tag, active) {
      if (tag !== "milestone") {
        return false;
      }
      const theorem = theoremForTarget(target);
      if (!theorem) {
        return false;
      }

      if (theorem.milestone === active) {
        return false;
      }

      setTheoremMilestone(theorem, active);
      updatePayloadMilestoneCount();
      renderExplorerGraph();
      if (applicationShellEnabled && application?.dataset.view === "overview") {
        renderOverview();
      }
      return true;
    }

    function optimisticallyToggleTag(target, tag) {
      const theorem = theoremForTarget(target);
      return theorem ? setTagState(target, tag, !theorem.milestone) : false;
    }

    function publicTheorems() {
      return publicTheoremList;
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

    function isStatusFilterCategory(value) {
      return typeof value === "string" && statusFilterCategories.includes(value);
    }

    function theoremStatusCategory(theorem) {
      return isStatusFilterCategory(theorem?.statusCategory) ? theorem.statusCategory : "unknown";
    }

    function setEnabledStatusFilters(categories) {
      const requested = new Set(Array.isArray(categories) ? categories : statusFilterCategories);
      enabledStatusFilters = new Set(
        statusFilterCategories.filter((category) => requested.has(category))
      );
      for (const button of statusFilters.querySelectorAll("[data-status-filter]")) {
        const category = button.dataset.statusFilter;
        const enabled = enabledStatusFilters.has(category);
        button.setAttribute("aria-pressed", String(enabled));
        button.setAttribute(
          "title",
          (enabled ? "Hide " : "Show ") +
            (category === "unknown" ? "unknown-status" : category) +
            " theorems"
        );
      }
    }

    function theoremPassesExplorerFilters(theorem) {
      return (
        (!milestoneOnly || theorem.milestone) &&
        enabledStatusFilters.has(theoremStatusCategory(theorem))
      );
    }

    function rootTheorems() {
      const query = search.value.trim().toLowerCase();
      const theoremList = publicTheorems();
      if (searchSelection?.type === "module") {
        return theoremList.filter((theorem) =>
          theorem.moduleName === searchSelection.value &&
          theoremPassesExplorerFilters(theorem)
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
        if (!theoremPassesExplorerFilters(theorem)) {
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
      if (theoremPassesExplorerFilters(theorem)) {
        return [{
          name,
          viaHidden
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
        currentGraphLayout = undefined;
        reportVisibleTheorems([]);
        replaceTypesetContent(graph, '<div class="graph-empty">No theorems.</div>');
        renderPreview();
        return;
      }
      const layout = layoutGraph(roots, theoremMap);
      const version = ++graphLayoutVersion;
      reportVisibleTheorems(layout.nodes.map((node) => node.name));
      replaceTypesetContent(graph, renderGraph(layout, theoremMap));
      window.requestAnimationFrame(() => applyMeasuredGraphLayout(layout, version));
      if (graph.querySelector("[data-graph-math]")) {
        scheduleGraphMathTypeset(layout, version);
      }
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
        nodesByName: nodes,
        nodeWidth,
        rowGap,
        width: (maxColumn + 1) * (nodeWidth + columnGap) - columnGap + 16
      };
    }

    function reportVisibleTheorems(names) {
      const uniqueNames = [...new Set(names)].sort();
      const key = uniqueNames.join("\\n");
      if (key === visibleTheoremKey) {
        return;
      }
      visibleTheoremKey = key;
      vscode?.postMessage({ type: "visibleTheorems", names: uniqueNames });
    }

    function visitGraphNode(name, theoremMap, nodes, edges, column, path) {
      const theorem = theoremMap.get(name);
      if (!theorem) {
        return;
      }
      const existing = nodes.get(name);
      if (existing) {
        if (existing.column >= column) {
          return;
        }
        existing.column = column;
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
      const elements = canvas.querySelectorAll("[data-graph-node-index]");
      layout.nodes.forEach((node, index) => {
        const element = elements[index];
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
      currentGraphLayout = layout;
    }

    function renderGraphEdges(layout, highlight) {
      const edges = [...layout.edges].sort((first, second) =>
        Number(highlight.edges.has(graphEdgeKey(first))) - Number(highlight.edges.has(graphEdgeKey(second)))
      );
      return edges.map((edge) => renderEdge(edge, layout, highlight)).join("");
    }

    function updateGraphSelection() {
      if (!currentGraphLayout) {
        renderPreview();
        return;
      }

      const highlight = graphHighlight(currentGraphLayout.edges, selectedName);
      const theoremMap = byName();
      currentGraphLayout.nodes.forEach((node, index) => {
        const theorem = theoremMap.get(node.name);
        const element = node.element || graph.querySelector('[data-graph-node-index="' + String(index) + '"]');
        if (!theorem || !element) {
          return;
        }
        element.classList.toggle("graph-node-selected", theorem.name === selectedName);
        element.classList.toggle("graph-node-dependency", highlight.nodes.has(theorem.name));
      });

      const svg = graph.querySelector(".graph-edges");
      if (svg) {
        svg.innerHTML = renderGraphEdges(currentGraphLayout, highlight);
      }
      renderPreview();
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
      const from = layout.nodesByName.get(edge.from);
      const to = layout.nodesByName.get(edge.to);
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
      const mathAttribute = theorem.displayNameHasMath ? ' data-graph-math="true"' : '';
      return '<button class="graph-node' + selected + dependency + '" type="button" data-select-theorem="' + html(theorem.name) +
        '" data-graph-node-index="' + String(index) +
        '" style="left: ' + String(node.x) + 'px; top: ' + String(node.y) +
        'px; width: ' + String(layout.nodeWidth) + 'px;">' +
        '<span class="graph-node-status">' + (theorem.statusHtml || '') + '</span>' +
        '<span class="' + starClass + '">' + star + '</span>' +
        '<span class="theorem-node-text"><span class="theorem-title"' + mathAttribute + '>' + html(theorem.displayName) + '</span>' +
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
        .slice(0, applicationShellEnabled ? 6 : modules.size)
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
        .slice(0, applicationShellEnabled ? 12 : theoremList.length)
        .map((theorem) => ({
          type: "theorem",
          value: theorem.name,
          label: theorem.displayName,
          detail: theorem.sourceName
        }));

      const articleItems = articleSearchItems
        .filter((article) =>
          article.title.toLowerCase().includes(normalized) ||
          article.relativePath.toLowerCase().includes(normalized)
        )
        .sort((first, second) =>
          first.title.localeCompare(second.title) ||
          first.relativePath.localeCompare(second.relativePath)
        )
        .slice(0, 10)
        .map((article) => ({
          type: "article",
          value: article.target,
          label: article.title,
          detail: article.relativePath
        }));

      return [...articleItems, ...theoremItems, ...moduleItems];
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
        replaceTypesetContent(suggestions, '<div class="suggestion-empty">No matches.</div>');
        return;
      }

      const moduleItems = [];
      const theoremItems = [];
      const articleItems = [];
      suggestionItems.forEach((item, index) => {
        const rendered = renderSuggestionOption(item, index);
        if (item.type === "module") {
          moduleItems.push(rendered);
        } else if (item.type === "article") {
          articleItems.push(rendered);
        } else {
          theoremItems.push(rendered);
        }
      });

      suggestions.hidden = false;
      replaceTypesetContent(suggestions,
        (articleItems.length > 0
          ? '<div class="suggestion-group-title">Articles</div>' + articleItems.join("")
          : '') +
        (theoremItems.length > 0
          ? '<div class="suggestion-group-title">Theorems</div>' + theoremItems.join("")
          : '') +
        (moduleItems.length > 0
          ? '<div class="suggestion-group-title">Modules</div>' + moduleItems.join("")
          : '')
      );
      scheduleSearchMathTypeset();
    }

    function renderSuggestionOption(item, index) {
      const active = index === activeSuggestionIndex ? " suggestion-option-active" : "";
      const mathAttribute = applicationShellEnabled && containsMathDelimiter(item.label)
        ? ' data-search-math="true"'
        : '';
      return '<button class="suggestion-option' + active + '" type="button" role="option" data-suggestion-index="' + String(index) +
        '" aria-selected="' + String(index === activeSuggestionIndex) +
        '" onpointerdown="selectSuggestionIndex(' + String(index) + '); return false;"' +
        ' onmousedown="selectSuggestionIndex(' + String(index) + '); return false;"' +
        ' onclick="selectSuggestionIndex(' + String(index) + '); return false;">' +
        '<span class="suggestion-label"' + mathAttribute + '>' + html(item.label) + '</span>' +
        '<span class="suggestion-detail">' + html(item.detail) + '</span>' +
        '</button>';
    }

    function hideSuggestions() {
      suggestionItems = [];
      activeSuggestionIndex = -1;
      suggestions.hidden = true;
      replaceTypesetContent(suggestions, "");
      searchMathTypesetVersion++;
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
      updateRenderedSearchValue();
      if (item.type === "article") {
        showArticle(item.value);
        return;
      }
      selectedArticleTarget = "";
      updateApplicationView("explorer");
      if (item.type === "theorem") {
        selectedName = item.value;
      } else {
        selectedName = "";
      }
      renderExplorerGraph();
      recordApplicationHistory("push");
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
      if (item.type === "module" || item.type === "article" || !item.detail || item.detail === item.label) {
        return item.label;
      }
      return item.label + " (" + item.detail + ")";
    }

    function renderPreview() {
      const mathVersion = ++previewMathTypesetVersion;
      const articleBase = articleTargetBase(selectedArticleTarget);
      const articleHtml = articleBase ? articleHtmlByTarget.get(articleBase) : undefined;
      if (articleHtml !== undefined) {
        replaceTypesetContent(
          preview,
          '<div class="article-layout">' +
            '<aside class="article-toc" aria-label="Table of contents">' +
              '<div class="article-toc-heading">Contents</div>' +
              '<nav class="article-toc-nav" aria-label="Article sections"></nav>' +
            '</aside>' +
            '<article class="article-view">' + articleHtml + '</article>' +
          '</div>'
        );
        renderArticleTableOfContents();
        focusSelectedArticleAnchor();
        queueMathTypeset(
          () => [preview],
          () => mathVersion === previewMathTypesetVersion,
          focusSelectedArticleAnchor
        );
        return;
      }
      const theorem = byName().get(selectedName);
      if (!theorem) {
        replaceTypesetContent(preview, '<p class="preview-empty">Select a theorem.</p>');
        return;
      }
      const previewHtml = previewHtmlByName.get(theorem.name);
      if (previewHtml === undefined) {
        replaceTypesetContent(
          preview,
          '<p class="preview-empty">Loading theorem preview…</p>' + renderViewerInfo(theorem)
        );
        if (!pendingPreviewRequestIds.has(theorem.name)) {
          const requestId = nextPreviewRequestId++;
          pendingPreviewRequestIds.set(theorem.name, requestId);
          vscode?.postMessage({ type: "requestPreview", name: theorem.name, requestId });
        }
        return;
      }
      replaceTypesetContent(
        preview,
        ${previewHtmlWithMilestoneControl} + renderViewerInfo(theorem)
      );
      queueMathTypeset(
        () => [preview],
        () => mathVersion === previewMathTypesetVersion
      );
    }

    function renderArticleTableOfContents() {
      const article = preview.querySelector(".article-view");
      const navigation = preview.querySelector(".article-toc-nav");
      if (!article || !navigation) {
        return;
      }
      const headings = [...article.querySelectorAll("h1[id],h2[id],h3[id],h4[id],h5[id],h6[id]")];
      const root = { level: 0, children: [] };
      const stack = [root];
      for (const [index, heading] of headings.entries()) {
        const level = Number(heading.tagName.slice(1));
        while (stack.length > 1 && stack[stack.length - 1].level >= level) {
          stack.pop();
        }
        const node = {
          id: heading.id,
          label: heading.textContent?.trim() || heading.id,
          level,
          isTitle: index === 0 && heading.tagName === "H1",
          children: []
        };
        stack[stack.length - 1].children.push(node);
        stack.push(node);
      }
      navigation.innerHTML = root.children.length > 0
        ? '<ul class="article-toc-list">' + renderArticleTocNodes(root.children) + '</ul>'
        : '<p class="article-toc-empty">No sections.</p>';
    }

    function renderArticleTocNodes(nodes) {
      return nodes.map((node) => {
        const children = node.children.length > 0
          ? '<ul class="article-toc-children">' + renderArticleTocNodes(node.children) + '</ul>'
          : '';
        const fold = node.children.length > 0 && !node.isTitle
          ? '<button class="article-toc-fold" type="button" data-toc-fold aria-expanded="true" aria-label="Collapse ' + html(node.label) + '">▾</button>'
          : '<span class="article-toc-fold-spacer" aria-hidden="true"></span>';
        const linkClass = node.isTitle ? ' article-toc-title-link' : '';
        const itemClass = node.isTitle ? ' article-toc-title-item' : '';
        return '<li class="article-toc-item' + itemClass + '">' +
          '<div class="article-toc-row">' + fold +
            '<button class="article-toc-link' + linkClass + '" type="button" data-toc-target="' + html(node.id) + '" data-toc-label="' + html(node.label) + '">' + html(node.label) + '</button>' +
          '</div>' + children +
          '</li>';
      }).join("");
    }

    function articleHeadingById(anchorId) {
      for (const element of preview.querySelectorAll(".article-view [id]")) {
        if (element.id === anchorId) {
          return element;
        }
      }
      return undefined;
    }

    function articleTocChildList(item) {
      return [...item.children].find((child) => child.classList.contains("article-toc-children"));
    }

    function setArticleTocItemExpanded(item, expanded) {
      const children = articleTocChildList(item);
      const row = [...item.children].find((child) => child.classList.contains("article-toc-row"));
      const fold = row
        ? [...row.children].find((child) => child.hasAttribute("data-toc-fold"))
        : undefined;
      if (!children || !fold) {
        return false;
      }
      children.hidden = !expanded;
      fold.setAttribute("aria-expanded", String(expanded));
      fold.textContent = expanded ? "▾" : "▸";
      const label = row
        ? [...row.children].find((child) => child.hasAttribute("data-toc-target"))?.dataset.tocLabel
        : undefined;
      fold.setAttribute("aria-label", (expanded ? "Collapse " : "Expand ") + (label || "section"));
      return true;
    }

    function revealArticleTocLink(link) {
      let childList = link.closest(".article-toc-children");
      while (childList) {
        const parentItem = childList.parentElement;
        if (!parentItem?.classList.contains("article-toc-item")) {
          break;
        }
        setArticleTocItemExpanded(parentItem, true);
        childList = parentItem.parentElement?.closest(".article-toc-children");
      }
      const contents = link.closest(".article-toc");
      if (!contents) {
        return;
      }
      const contentsRect = contents.getBoundingClientRect();
      const linkRect = link.getBoundingClientRect();
      const edgePadding = 8;
      if (linkRect.top < contentsRect.top + edgePadding) {
        contents.scrollTop -= contentsRect.top + edgePadding - linkRect.top;
      } else if (linkRect.bottom > contentsRect.bottom - edgePadding) {
        contents.scrollTop += linkRect.bottom - contentsRect.bottom + edgePadding;
      }
    }

    function updateArticleTocSelection(anchorId) {
      let currentLink = undefined;
      for (const link of preview.querySelectorAll("[data-toc-target]")) {
        const current = link.dataset.tocTarget === anchorId;
        link.classList.toggle("is-current", current);
        if (current) {
          link.setAttribute("aria-current", "location");
          currentLink = link;
        } else {
          link.removeAttribute("aria-current");
        }
      }
      if (currentLink) {
        revealArticleTocLink(currentLink);
      }
    }

    function updateArticleTocSelectionFromScroll() {
      const headings = [...preview.querySelectorAll(".article-view h1[id],.article-view h2[id],.article-view h3[id],.article-view h4[id],.article-view h5[id],.article-view h6[id]")];
      if (headings.length === 0) {
        return;
      }
      let currentHeading = headings[0];
      const previewTop = preview.getBoundingClientRect().top;
      const threshold = previewTop + Math.min(48, Math.max(24, preview.clientHeight * 0.1));
      const atArticleEnd = preview.scrollTop > 0 &&
        preview.scrollHeight - preview.scrollTop - preview.clientHeight <= 2;
      if (atArticleEnd) {
        currentHeading = headings[headings.length - 1];
      } else {
        for (const heading of headings) {
          if (heading.getBoundingClientRect().top > threshold) {
            break;
          }
          currentHeading = heading;
        }
      }
      updateArticleTocSelection(currentHeading.id);
    }

    function scheduleArticleTocSelectionUpdate() {
      if (articleScrollFrame !== 0) {
        return;
      }
      articleScrollFrame = window.requestAnimationFrame(() => {
        articleScrollFrame = 0;
        updateArticleTocSelectionFromScroll();
      });
    }

    function scrollArticleToAnchor(anchorId, behavior = "auto") {
      const element = articleHeadingById(anchorId);
      if (!element) {
        return false;
      }
      const previewTop = preview.getBoundingClientRect().top;
      const elementTop = element.getBoundingClientRect().top;
      const top = Math.max(0, preview.scrollTop + elementTop - previewTop - 16);
      if (behavior === "smooth") {
        preview.scrollTo({ top, behavior });
      } else {
        preview.scrollTop = top;
      }
      updateArticleTocSelection(anchorId);
      return true;
    }

    function focusSelectedArticleAnchor() {
      const hashIndex = selectedArticleTarget.indexOf("#");
      if (hashIndex < 0) {
        updateArticleTocSelectionFromScroll();
        return;
      }
      let anchorId = selectedArticleTarget.slice(hashIndex + 1);
      try {
        anchorId = decodeURIComponent(anchorId);
      } catch {
        // Keep malformed percent escapes literal, matching ordinary fragment behavior.
      }
      scrollArticleToAnchor(anchorId);
    }

    function applyHandwaveSectionMode(section, nextMode, lastMode) {
      section.dataset.mode = nextMode;
      if (lastMode) {
        section.dataset.lastMode = lastMode;
      } else if (nextMode !== "collapsed") {
        section.dataset.lastMode = nextMode;
      }
      for (const control of section.querySelectorAll("[data-set-mode]")) {
        control.setAttribute("aria-pressed", String(control.dataset.setMode === nextMode));
      }
      for (const control of section.querySelectorAll("[data-toggle-collapsed]")) {
        const expanded = nextMode !== "collapsed";
        control.setAttribute("aria-expanded", String(expanded));
        control.textContent = expanded ? "▾" : "▸";
        control.setAttribute("aria-label", expanded ? "Collapse proof" : "Expand proof");
      }
    }

    function copyHandwaveTarget(button) {
      const target = button.dataset.copyTarget || "";
      navigator.clipboard?.writeText(target).catch(() => undefined);
      const previousLabel = button.getAttribute("aria-label") || "Copy";
      const previousTitle = button.getAttribute("title") || previousLabel;
      button.setAttribute("aria-label", "Copied");
      button.setAttribute("title", "Copied");
      window.setTimeout(() => {
        button.setAttribute("aria-label", previousLabel);
        button.setAttribute("title", previousTitle);
      }, 900);
    }

    function setPreview(name, requestId, previewHtml) {
      if (pendingPreviewRequestIds.get(name) !== requestId) {
        return;
      }
      pendingPreviewRequestIds.delete(name);
      previewHtmlByName.set(name, previewHtml);
      if (name === selectedName) {
        renderPreview();
      }
    }

    function setStatuses(updates) {
      let selectedStatusChanged = false;
      let overviewStatusChanged = false;
      let filteredGraphChanged = false;
      const graphNodesByName = new Map();
      for (const node of graph.querySelectorAll("[data-select-theorem]")) {
        graphNodesByName.set(node.dataset.selectTheorem || "", node);
      }
      for (const update of updates) {
        if (!update || typeof update.name !== "string" || typeof update.statusHtml !== "string") {
          continue;
        }
        const theorem = byName().get(update.name);
        const nextCategory = isStatusFilterCategory(update.statusCategory)
          ? update.statusCategory
          : theoremStatusCategory(theorem);
        if (
          !theorem ||
          (theorem.statusHtml === update.statusHtml && theoremStatusCategory(theorem) === nextCategory)
        ) {
          continue;
        }
        const categoryChanged = theoremStatusCategory(theorem) !== nextCategory;
        theorem.statusCategory = nextCategory;
        theorem.statusHtml = update.statusHtml;
        overviewStatusChanged = true;
        filteredGraphChanged ||= categoryChanged && enabledStatusFilters.size < statusFilterCategories.length;
        previewHtmlByName.delete(update.name);
        if (update.name === selectedName) {
          selectedStatusChanged = true;
        }
        const node = graphNodesByName.get(update.name);
        if (node) {
          const status = node.querySelector(".graph-node-status");
          if (status) {
            status.innerHTML = update.statusHtml;
          }
        }
      }
      const explorerVisible = !applicationShellEnabled || application?.dataset.view === "explorer";
      if (selectedStatusChanged) {
        pendingPreviewRequestIds.delete(selectedName);
      }
      if (filteredGraphChanged && explorerVisible) {
        renderExplorerGraph();
      } else if (selectedStatusChanged) {
        renderPreview();
      }
      if (overviewStatusChanged && applicationShellEnabled && application?.dataset.view === "overview") {
        renderOverview();
      }
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

    overview?.addEventListener("click", (event) => {
      const target = event.target instanceof Element ? event.target : undefined;
      const item = target?.closest("[data-overview-type][data-overview-value]");
      if (!item) {
        return;
      }
      const type = item.dataset.overviewType;
      const value = item.dataset.overviewValue || "";
      if (type === "article") {
        const article = articleItemForTarget(value);
        if (article) {
          applySearchSelection({
            type: "article",
            value: article.target,
            label: article.title,
            detail: article.relativePath
          });
        }
        return;
      }
      if (type === "module") {
        const count = publicTheorems().filter((theorem) => theorem.moduleName === value).length;
        if (count > 0) {
          applySearchSelection({
            type: "module",
            value,
            label: value,
            detail: String(count) + " theorem" + (count === 1 ? "" : "s")
          });
        }
        return;
      }
      if (type === "theorem") {
        const theorem = publicTheorems().find((item) => item.name === value);
        if (theorem) {
          restrictToTheorem(theorem);
        }
      }
    });

    navigationToggle?.addEventListener("click", (event) => {
      event.stopPropagation();
      setNavigationMenuOpen(navigationToggle.getAttribute("aria-expanded") !== "true");
    });

    navigationMenu?.addEventListener("click", (event) => {
      const target = event.target instanceof Element ? event.target : undefined;
      const item = target?.closest("[data-switch-view]");
      if (!item || item.disabled) {
        return;
      }
      switchApplicationView(item.dataset.switchView);
      setNavigationMenuOpen(false);
    });

    document.addEventListener("click", (event) => {
      if (
        navigationMenu &&
        !navigationMenu.hidden &&
        event.target instanceof Node &&
        !navigationRoot?.contains(event.target)
      ) {
        setNavigationMenuOpen(false);
      }
    });

    themeToggle?.addEventListener("click", toggleTheme);

    search.addEventListener("input", () => {
      searchSelection = undefined;
      updateRenderedSearchValue();
      suggestionsOpen = true;
      renderSuggestions();
      if (!applicationShellEnabled || application?.dataset.view === "explorer") {
        selectedName = "";
        renderExplorerGraph();
        recordApplicationHistory("replace");
      }
    });

    search.addEventListener("focus", () => {
      updateRenderedSearchValue();
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
        updateRenderedSearchValue();
      }, 120);
    });

    searchRendered?.addEventListener("click", () => {
      searchRendered.hidden = true;
      search.focus();
      search.select();
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
        setNavigationMenuOpen(false);
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
      recordApplicationHistory("replace");
    });

    statusFilters.addEventListener("click", (event) => {
      const target = event.target instanceof Element ? event.target : undefined;
      const button = target?.closest("[data-status-filter]");
      const category = button?.dataset.statusFilter;
      if (!isStatusFilterCategory(category)) {
        return;
      }
      const nextFilters = new Set(enabledStatusFilters);
      if (nextFilters.has(category)) {
        nextFilters.delete(category);
      } else {
        nextFilters.add(category);
      }
      setEnabledStatusFilters([...nextFilters]);
      renderExplorerGraph();
      recordApplicationHistory("replace");
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
      selectedArticleTarget = "";
      selectedName = theorem.name;
      updateApplicationView("explorer");
      updateGraphSelection();
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
      const tocLink = target?.closest("[data-toc-target]");
      if (tocLink) {
        const anchorId = tocLink.dataset.tocTarget;
        const articleBase = articleTargetBase(selectedArticleTarget);
        if (anchorId && articleBase) {
          event.preventDefault();
          selectedArticleTarget = articleBase + "#" + anchorId;
          lastArticleTarget = selectedArticleTarget;
          scrollArticleToAnchor(anchorId, "smooth");
          recordApplicationHistory("push");
        }
        return;
      }
      const tocFold = target?.closest("[data-toc-fold]");
      if (tocFold) {
        const item = tocFold.closest(".article-toc-item");
        if (item) {
          event.preventDefault();
          const expanded = tocFold.getAttribute("aria-expanded") !== "false";
          setArticleTocItemExpanded(item, !expanded);
          updateArticleTocSelectionFromScroll();
        }
        return;
      }
      const modeButton = target?.closest("[data-set-mode]");
      if (modeButton) {
        const section = modeButton.closest("[data-mode]");
        const nextMode = modeButton.dataset.setMode;
        if (section && nextMode) {
          event.preventDefault();
          applyHandwaveSectionMode(section, nextMode);
        }
        return;
      }
      const collapseButton = target?.closest("[data-toggle-collapsed]");
      if (collapseButton) {
        const section = collapseButton.closest("[data-mode]");
        if (section) {
          event.preventDefault();
          const nextMode = section.dataset.mode === "collapsed"
            ? (section.dataset.lastMode || "text")
            : "collapsed";
          const lastMode = section.dataset.mode !== "collapsed"
            ? (section.dataset.mode || "text")
            : section.dataset.lastMode;
          applyHandwaveSectionMode(section, nextMode, lastMode);
        }
        return;
      }
      const copyButton = target?.closest("[data-copy-target]");
      if (copyButton) {
        event.preventDefault();
        copyHandwaveTarget(copyButton);
        return;
      }
      const tagButton = target?.closest("[data-toggle-tag]");
      if (tagButton) {
        event.preventDefault();
        const tag = tagButton.dataset.toggleTag;
        const handwaveTarget = tagButton.dataset.handwaveTarget;
        if (tag && handwaveTarget) {
          optimisticallyToggleTag(handwaveTarget, tag);
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
        if (${localNavigationCondition}) {
          vscode?.postMessage({ type: "openPreview", target: targetName });
        }
      }
    });

    preview.addEventListener("scroll", scheduleArticleTocSelectionUpdate, { passive: true });

    window.addEventListener("message", (event) => {
      const message = event.data || {};
      if (
        message.type === "setPreview" &&
        typeof message.name === "string" &&
        typeof message.requestId === "number" &&
        typeof message.html === "string"
      ) {
        setPreview(message.name, message.requestId, message.html);
        return;
      }
      if (message.type === "setStatuses" && Array.isArray(message.updates)) {
        setStatuses(message.updates);
        return;
      }
      if (
        message.type === "setTag" &&
        typeof message.target === "string" &&
        typeof message.tag === "string" &&
        typeof message.active === "boolean"
      ) {
        setTagState(message.target, message.tag, message.active);
        return;
      }
      if (message.type !== "setData" || !message.payload) {
        return;
      }
      payload = message.payload;
      theoremMap = createTheoremMap(payload);
      publicTheoremList = payload.theorems.filter((theorem) => !theorem.isPrivate);
      previewHtmlByName.clear();
      pendingPreviewRequestIds.clear();
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
      updateRenderedSearchValue();
      renderSuggestions();
      if (applicationShellEnabled && application?.dataset.view === "overview") {
        renderOverview();
      } else {
        renderExplorerGraph();
      }
    });

    window.addEventListener("popstate", (event) => {
      restoreApplicationHistory(event.state);
    });

    syncThemeControl();
    if (applicationShellEnabled) {
      restoreApplicationHistory(window.history.state);
      recordApplicationHistory("replace");
    } else {
      updateApplicationView("explorer");
      updateRenderedSearchValue();
      renderExplorerGraph();
    }
    window.addEventListener("load", () => {
      updateRenderedSearchValue();
      scheduleSearchMathTypeset();
      if (applicationShellEnabled && application?.dataset.view === "overview") {
        renderOverview();
      }
    });
  </script>
</body>
</html>`;
}

function jsonForScript(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}
