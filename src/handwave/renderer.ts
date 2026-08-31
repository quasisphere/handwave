import { HandwaveIndex, isIndexedLeanDeclaration } from "./index";
import {
  handwaveMarkdownAnchor,
  handwaveMarkdownHeading,
  handwaveMarkdownInclude,
  handwaveMarkdownLink,
  handwaveMarkdownReferences,
  markdownChildren,
  parseHandwaveMarkdown,
  type HandwaveMarkdownNode,
  type HandwaveMarkdownReferences,
  type HandwaveMarkdownTree
} from "./markdown";
import { renderMathJaxConfigurationScript } from "./mathJax";
import {
  hasHandwaveTag,
  isHandwaveNavigationTarget,
  parseArticleDocument,
  parseLeanDocument,
  parseTarget
} from "./parser";
import { LeanDeclaration } from "./types";

interface RenderOptions {
  indexing?: boolean;
  focusId?: string;
  currentTarget?: string;
  currentUri?: string;
  editorHref?: (target: string) => string;
  sourceLinks?: boolean;
  editableTags?: boolean;
  editableArticles?: boolean;
  editableMetadata?: boolean;
}

interface DeclarationRenderOptions {
  popovers?: boolean;
  milestoneControls?: boolean;
  dependencyTree?: boolean;
  definitionReferences?: boolean;
  sourceLinks?: boolean;
  editableTags?: boolean;
  editableMetadata?: boolean;
}

type LeanCheckStatus = ReturnType<HandwaveIndex["checkStatusForLean"]>;

interface DependencyTreeNode {
  name: string;
  status: LeanCheckStatus;
  children: DependencyTreeNode[];
  cycle: boolean;
}

export function renderArticleHtml(
  text: string,
  uri: string,
  index: HandwaveIndex,
  commandHref: (target: string) => string,
  options: RenderOptions = {}
): string {
  const markdownTree = parseHandwaveMarkdown(text);
  const body = renderArticleFragmentHtmlFromTree(
    text,
    uri,
    index,
    commandHref,
    options,
    markdownTree
  );
  const article = parseArticleDocument(text, uri, markdownTree);
  const title = article.anchors[0]?.title ?? "Handwave Article";

  return renderHtmlShell(title, body, options);
}

export function renderArticleFragmentHtml(
  text: string,
  uri: string,
  index: HandwaveIndex,
  commandHref: (target: string) => string,
  options: RenderOptions = {}
): string {
  return renderArticleFragmentHtmlFromTree(
    text,
    uri,
    index,
    commandHref,
    options,
    parseHandwaveMarkdown(text)
  );
}

function renderArticleFragmentHtmlFromTree(
  text: string,
  uri: string,
  index: HandwaveIndex,
  commandHref: (target: string) => string,
  options: RenderOptions,
  markdownTree: HandwaveMarkdownTree
): string {
  const editorHref = options.editorHref ?? commandHref;
  const renderInclude = (target: string): string => {
    const parsedTarget = parseTarget(target);
    if (parsedTarget.kind === "lean" && !parsedTarget.selector) {
      const declaration = index.leanDeclarations.get(parsedTarget.base);
      if (declaration) {
        return renderDeclarationPackage(declaration, target, commandHref, editorHref, index, {
          sourceLinks: options.sourceLinks,
          editableTags: options.editableTags,
          editableMetadata: options.editableMetadata
        });
      }
    }

    const resolved = index.resolve(target, uri);
    if (!resolved) {
      if (options.indexing) {
        return `<div class="include include-pending"><span class="include-status" aria-hidden="true">…</span> Loading include: <code>${escapeHtml(target)}</code></div>`;
      }
      return `<div class="include unresolved">Unresolved include: <code>${escapeHtml(target)}</code></div>`;
    }

    const preview = renderProseParagraphs(resolved.preview, commandHref);
    return `<div class="include" data-target="${escapeHtml(target)}">${preview}</div>`;
  };

  return renderMarkdownDocument(
    text,
    markdownTree,
    commandHref,
    options.editableArticles === true,
    renderInclude
  );
}

export function renderLeanDocumentHtml(
  text: string,
  uri: string,
  index: HandwaveIndex,
  commandHref: (target: string) => string,
  options: RenderOptions = {}
): string {
  const editorHref = options.editorHref ?? commandHref;
  const indexedDeclarations = [...index.leanDeclarations.values()]
    .filter((declaration) => declaration.uri === uri && !declaration.isPrivate)
    .sort((first, second) =>
      first.range.start.line - second.range.start.line ||
      first.range.start.character - second.range.start.character
    );
  const declarations = indexedDeclarations.length > 0
    ? indexedDeclarations
    : parseLeanDocument(text, uri)
      .filter(isIndexedLeanDeclaration)
      .filter((declaration) => !declaration.isPrivate);
  const target = options.currentTarget ? parseTarget(options.currentTarget) : undefined;
  const targetDeclaration = target?.kind === "lean" ? index.leanDeclarations.get(target.base) : undefined;
  if (
    targetDeclaration &&
    targetDeclaration.uri === uri &&
    isTheoremLike(targetDeclaration)
  ) {
    return renderLeanTheoremContextHtml(targetDeclaration, index, commandHref, editorHref, options);
  }

  const title = uri.split(/[\\/]/).pop() ?? "Lean file";
  const body = [
    `<h1>${escapeHtml(title)}</h1>`,
    `<p class="lean-file-path">${escapeHtml(uri)}</p>`,
    declarations.length === 0
      ? `<p class="lean-file-empty">No Lean declarations were found in this file.</p>${renderLeanBlock(text)}`
      : declarations.map((declaration) =>
        renderDeclarationPackage(declaration, `lean:${declaration.name}`, commandHref, editorHref, index)
      ).join("\n")
  ].join("\n");

  return renderHtmlShell(title, body, options);
}

export function leanDeclarationAnchorId(name: string): string {
  return `lean-${name.replace(/[^A-Za-z0-9_-]+/g, "-")}`;
}

export function renderLeanDeclarationPreviewHtml(
  declaration: LeanDeclaration,
  index: HandwaveIndex,
  commandHref: (target: string) => string,
  editorHref: (target: string) => string,
  options: Pick<
    DeclarationRenderOptions,
    "sourceLinks" | "editableMetadata" | "definitionReferences"
  > = {}
): string {
  return renderDeclarationPackage(
    declaration,
    `lean:${declaration.name}`,
    commandHref,
    editorHref,
    index,
    {
      dependencyTree: false,
      definitionReferences: false,
      milestoneControls: false,
      sourceLinks: options.sourceLinks,
      editableMetadata: options.editableMetadata
    }
  );
}

function renderHtmlShell(
  title: string,
  body: string,
  options: { focusId?: string; currentTarget?: string; currentUri?: string } = {}
): string {
  const focusScript = options.focusId
    ? `focusHandwaveTarget(${JSON.stringify(options.focusId)});`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
  <style>
    :root {
      color-scheme: light dark;
      --border: color-mix(in srgb, currentColor 18%, transparent);
      --muted: color-mix(in srgb, currentColor 64%, transparent);
      --accent: #2f6feb;
      --danger: #d1242f;
      --success: #1a7f37;
      --warning: var(--vscode-editorWarning-foreground, #9a6700);
      --surface: color-mix(in srgb, currentColor 4%, transparent);
      --syntax-keyword: var(--vscode-symbolIcon-keywordForeground, #cf222e);
      --syntax-constant: var(--vscode-symbolIcon-constantForeground, #0550ae);
      --syntax-comment: var(--vscode-descriptionForeground, #6e7781);
      --syntax-string: var(--vscode-symbolIcon-stringForeground, #0a7f42);
      --syntax-operator: var(--vscode-symbolIcon-operatorForeground, #8250df);
    }
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      line-height: 1.62;
      max-width: 840px;
      margin: 0 auto;
      padding: 32px 24px 48px;
      color: var(--vscode-editor-foreground);
      background: var(--vscode-editor-background);
    }
    h1, h2, h3, h4 {
      line-height: 1.2;
      margin: 1.6em 0 0.5em;
    }
    h1 { margin-top: 0; }
    a {
      color: var(--vscode-textLink-foreground, var(--accent));
      text-decoration: none;
    }
    .declaration-link {
      color: inherit;
      text-decoration: none;
    }
    .declaration-link:hover {
      color: var(--vscode-textLink-foreground, var(--accent));
    }
    code, pre {
      font-family: var(--vscode-editor-font-family);
      font-size: 0.95em;
    }
    pre, .include {
      border: 1px solid var(--border);
      border-radius: 6px;
      background: var(--surface);
      padding: 12px 14px;
      overflow: auto;
    }
    .include {
      margin: 1em 0;
      white-space: pre-wrap;
    }
    .theorem-view,
    .definition-view {
      margin: 1.25em 0;
      padding: 0;
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
    .theorem-line {
      position: relative;
    }
    .check-status {
      display: inline-block;
      font-weight: 700;
      margin-right: 0.35em;
      min-width: 1em;
      text-align: center;
    }
    .theorem-line > .check-status {
      left: -1.55em;
      margin-right: 0;
      position: absolute;
      top: 0;
    }
    .check-status-checked {
      color: var(--vscode-testing-iconPassed, var(--success));
    }
    .check-status-unchecked {
      color: var(--vscode-testing-iconFailed, var(--danger));
    }
    .check-status-dependency-warning {
      color: var(--warning);
    }
    .check-status-inconclusive,
    .check-status-blocked {
      color: var(--muted);
    }
    .check-status-pending {
      animation: check-status-pulse 1.2s ease-in-out infinite;
      color: var(--muted);
    }
    .check-status-stale {
      font-weight: 600;
    }
    @keyframes check-status-pulse {
      0%, 100% { opacity: 0.45; }
      50% { opacity: 1; }
    }
    .prose-paragraph + .prose-paragraph,
    .theorem-line + .prose-paragraph,
    .definition-line + .prose-paragraph {
      margin-top: 0.65em;
    }
    .declaration-label {
      display: inline-block;
      position: relative;
    }
    .milestone-control {
      align-items: center;
      background: transparent;
      border: 1px solid transparent;
      border-radius: 4px;
      color: var(--vscode-button-secondaryForeground, currentColor);
      cursor: pointer;
      display: inline-flex;
      font: inherit;
      height: 1.55em;
      justify-content: center;
      margin-right: 4px;
      padding: 0;
      width: 1.55em;
    }
    .milestone-control:hover {
      background: var(--vscode-button-secondaryHoverBackground, var(--surface));
      border-color: var(--border);
    }
    .milestone-control-active {
      color: var(--vscode-editorWarning-foreground, #9a6700);
    }
    .milestone-control-inactive {
      color: var(--muted);
    }
    .milestone-tag {
      color: var(--vscode-editorWarning-foreground, #9a6700);
      display: inline-flex;
      font-weight: 700;
      justify-content: center;
      margin-right: 4px;
      width: 1.2em;
    }
    .source-popover {
      background: var(--vscode-editorHoverWidget-background, var(--vscode-editor-background));
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
    .source-popover::before {
      content: "";
      height: 8px;
      left: 0;
      position: absolute;
      right: 0;
      top: -8px;
    }
    .source-popover a,
    .source-popover .source-name {
      display: inline-block;
      font-family: var(--vscode-editor-font-family);
      font-size: 0.9em;
      max-width: 48ch;
      overflow: hidden;
      text-overflow: ellipsis;
      vertical-align: bottom;
      white-space: nowrap;
    }
    .source-popover-row {
      align-items: center;
      display: inline-flex;
      max-width: 100%;
    }
    .dependency-tree {
      border-top: 1px solid var(--border);
      display: block;
      font-family: var(--vscode-editor-font-family);
      font-size: 0.9em;
      margin-top: 6px;
      max-height: min(45vh, 360px);
      min-width: 18em;
      overflow: auto;
      padding-top: 6px;
    }
    .definition-references {
      border-top: 1px solid var(--border);
      display: block;
      font-family: var(--vscode-editor-font-family);
      font-size: 0.9em;
      margin-top: 6px;
      min-width: 18em;
      padding-top: 6px;
    }
    .definition-references-title {
      color: var(--muted);
      display: block;
      font-family: var(--vscode-font-family, ui-sans-serif, system-ui, sans-serif);
      font-size: 0.85em;
      font-variant-caps: all-small-caps;
      font-weight: 600;
      letter-spacing: 0.08em;
      margin-bottom: 4px;
    }
    .definition-reference-list {
      display: grid;
      gap: 4px;
    }
    .definition-reference-item {
      display: block;
    }
    .dependency-tree-list {
      display: block;
      list-style: none;
      margin: 0;
      padding-left: 0;
    }
    .dependency-tree-list .dependency-tree-list {
      border-left: 1px solid var(--border);
      margin-left: 0.62em;
      padding-left: 0.95em;
    }
    .dependency-tree-item + .dependency-tree-item {
      margin-top: 4px;
    }
    .dependency-tree-item {
      display: block;
    }
    .dependency-node {
      align-items: center;
      display: flex;
      min-width: 0;
      white-space: nowrap;
    }
    .dependency-tree .check-status {
      flex: 0 0 auto;
      margin-right: 0.45em;
    }
    .dependency-link {
      max-width: 48ch;
    }
    .copy-control {
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
    .copy-control:hover {
      background: var(--vscode-button-secondaryHoverBackground, var(--surface));
    }
    .copy-icon {
      display: inline-block;
      height: 0.82em;
      position: relative;
      width: 0.82em;
    }
    .copy-icon::before,
    .copy-icon::after {
      border: 1.4px solid currentColor;
      border-radius: 2px;
      box-sizing: border-box;
      content: "";
      height: 0.62em;
      position: absolute;
      width: 0.52em;
    }
    .copy-icon::before {
      left: 0.08em;
      top: 0.18em;
    }
    .copy-icon::after {
      background: var(--vscode-editorHoverWidget-background, var(--vscode-editor-background));
      left: 0.22em;
      top: 0.02em;
    }
    .sr-only {
      clip: rect(0 0 0 0);
      clip-path: inset(50%);
      height: 1px;
      overflow: hidden;
      position: absolute;
      white-space: nowrap;
      width: 1px;
    }
    .source-popover-row + .source-popover-row {
      border-top: 1px solid var(--border);
      margin-top: 6px;
      padding-top: 6px;
    }
    .source-popover-separator {
      color: var(--muted);
      margin: 0 7px;
    }
    .declaration-label:hover .source-popover,
    .declaration-label:focus-within .source-popover {
      display: block;
    }
    .theorem-line strong,
    .definition-line strong,
    .proof-line strong {
      font-size: 1em;
    }
    .view-switch {
      align-items: center;
      display: inline-flex;
      gap: 2px;
    }
    .mode-control,
    .collapse-control {
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
    .collapse-control {
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
    .mode-control:hover,
    .collapse-control:hover {
      background: var(--vscode-button-secondaryHoverBackground, var(--surface));
    }
    .mode-control[aria-pressed="true"] {
      background: var(--vscode-button-secondaryBackground, var(--surface));
      border-color: color-mix(in srgb, currentColor 34%, transparent);
    }
    .theorem-view pre,
    .definition-view pre {
      margin: 0;
      tab-size: 2;
      white-space: pre;
    }
    .lean-source {
      display: block;
    }
    .lean-file-path {
      color: var(--muted);
      font-family: var(--vscode-editor-font-family);
      font-size: 0.9em;
      margin-top: -0.6em;
    }
    .lean-file-empty {
      color: var(--muted);
    }
    .focused-target {
      animation: focus-flash 1.6s ease-out 1;
    }
    @keyframes focus-flash {
      0% { background: color-mix(in srgb, var(--accent) 16%, transparent); }
      100% { background: transparent; }
    }
    .lean-keyword { color: var(--syntax-keyword); font-weight: 600; }
    .lean-constant { color: var(--syntax-constant); }
    .lean-comment { color: var(--syntax-comment); font-style: italic; }
    .lean-string { color: var(--syntax-string); }
    .lean-operator { color: var(--syntax-operator); }
    [data-mode="text"] .lean-content,
    [data-mode="lean"] .prose-content,
    [data-mode="collapsed"] .proof-content {
      display: none;
    }
    .proof-section {
      margin-top: 0.9em;
      position: relative;
    }
    .proof-line {
      display: block;
      margin-bottom: 0;
      margin-left: 0;
    }
    .proof-line .collapse-control {
      left: -1.55em;
      position: absolute;
      top: -0.05em;
    }
    .proof-body {
      display: inline;
    }
    .proof-content {
      display: inline;
    }
    [data-mode="text"] .proof-body > .prose-content {
      display: inline;
    }
    .proof-body > .prose-content > .prose-paragraph:first-child {
      display: inline;
    }
    .proof-body .lean-content {
      margin-top: 0.5em;
    }
    .qed {
      float: right;
      line-height: 1.6;
      margin-left: 1em;
    }
    .unresolved {
      border-color: color-mix(in srgb, var(--danger) 45%, transparent);
      color: var(--vscode-errorForeground, var(--danger));
    }
    .include-pending {
      color: var(--muted);
    }
    .include-status {
      display: inline-block;
      font-weight: 700;
      margin-right: 0.35em;
      min-width: 1em;
      text-align: center;
    }
    blockquote {
      border-left: 3px solid var(--border);
      color: var(--muted);
      margin-left: 0;
      padding-left: 1em;
    }
    body > ul,
    body > ol,
    blockquote ul,
    blockquote ol,
    .article-editable-list > ul,
    .article-editable-list > ol {
      padding-left: 1.65em;
    }
    li > ul,
    li > ol {
      margin: 0.25em 0;
    }
    mjx-container {
      overflow-x: auto;
      overflow-y: hidden;
      max-width: 100%;
    }
  </style>
  <script>
    ${renderMathJaxConfigurationScript()}
  </script>
  <script async src="https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-chtml.js"></script>
</head>
<body>
<main id="handwave-content">
${body}
</main>
<script>
  const handwaveVscode = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : undefined;

  function focusHandwaveTarget(focusId) {
    if (!focusId) {
      return;
    }

    const focus = document.getElementById(focusId);
    if (focus) {
      focus.scrollIntoView({ block: "start" });
      focus.classList.add("focused-target");
    }
  }

  function handwaveSectionKey(section) {
    const target = section.closest("[data-target]")?.dataset.target || "";
    const part = section.dataset.section || "";
    return target && part ? target + "::" + part : "";
  }

  function collectHandwaveViewModes(root) {
    const modes = {};
    for (const section of root.querySelectorAll("[data-section][data-mode]")) {
      const key = handwaveSectionKey(section);
      if (!key) {
        continue;
      }
      modes[key] = {
        mode: section.dataset.mode || "text",
        lastMode: section.dataset.lastMode || ""
      };
    }
    return modes;
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
      control.setAttribute("aria-expanded", String(nextMode !== "collapsed"));
      control.textContent = nextMode === "collapsed" ? "▸" : "▾";
      control.setAttribute("aria-label", nextMode === "collapsed" ? "Expand proof" : "Collapse proof");
    }
  }

  function restoreHandwaveViewModes(root, modes) {
    for (const section of root.querySelectorAll("[data-section][data-mode]")) {
      const mode = modes[handwaveSectionKey(section)];
      if (!mode) {
        continue;
      }
      applyHandwaveSectionMode(section, mode.mode, mode.lastMode);
    }
  }

  window.addEventListener("load", () => {
    ${focusScript}
  });

  function toggleHandwaveTag(control) {
    const handwaveTarget = control.dataset.handwaveTarget;
    const tag = control.dataset.toggleTag;
    if (!handwaveTarget || !tag) {
      return;
    }

    if (tag === "milestone") {
      setMilestoneControlState(control, control.getAttribute("aria-pressed") !== "true");
    }
    handwaveVscode?.postMessage({ type: "toggleTag", target: handwaveTarget, tag });
  }

  function setMilestoneControlState(control, active) {
    control.setAttribute("aria-pressed", String(active));
    control.textContent = active ? "★" : "☆";
    const label = active ? "Remove milestone tag" : "Add milestone tag";
    control.setAttribute("title", label);
    control.setAttribute("aria-label", label);
    control.classList.toggle("milestone-control-active", active);
    control.classList.toggle("milestone-control-inactive", !active);
    control.classList.toggle("preview-milestone-control-active", active);
    control.classList.toggle("preview-milestone-control-inactive", !active);
  }

  document.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : undefined;
    const control = target?.closest("[data-toggle-tag][data-handwave-target]");
    if (!control) {
      return;
    }

    event.preventDefault();
    event.stopImmediatePropagation();
    toggleHandwaveTag(control);
  });

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") {
      return;
    }

    const target = event.target instanceof Element ? event.target : undefined;
    const control = target?.closest("[data-toggle-tag][data-handwave-target]");
    if (!control) {
      return;
    }

    event.preventDefault();
    event.stopImmediatePropagation();
    toggleHandwaveTag(control);
  });

  document.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : undefined;
    const link = target?.closest("a[data-handwave-target]");
    if (!link || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return;
    }

    event.preventDefault();
    const handwaveTarget = link.dataset.handwaveTarget;
    if (!handwaveTarget) {
      return;
    }

    handwaveVscode?.postMessage({ type: "navigate", target: handwaveTarget });
  });

  document.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : undefined;
    const button = target?.closest("[data-copy-target]");
    if (!button) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    const text = button.dataset.copyTarget || "";
    if (handwaveVscode) {
      handwaveVscode.postMessage({ type: "copy", text });
    } else if (navigator.clipboard) {
      navigator.clipboard.writeText(text).catch(() => undefined);
    }
    const previousLabel = button.getAttribute("aria-label") || "Copy";
    const previousTitle = button.getAttribute("title") || previousLabel;
    button.setAttribute("aria-label", "Copied");
    button.setAttribute("title", "Copied");
    window.setTimeout(() => {
      button.setAttribute("aria-label", previousLabel);
      button.setAttribute("title", previousTitle);
    }, 900);
  });

  window.addEventListener("message", (event) => {
    const message = event.data || {};
    if (message.type !== "replaceContent" || typeof message.html !== "string") {
      return;
    }

    const parser = new DOMParser();
    const nextDocument = parser.parseFromString(message.html, "text/html");
    const nextContent = nextDocument.getElementById("handwave-content");
    const content = document.getElementById("handwave-content");
    if (!nextContent || !content) {
      return;
    }

    const viewModes = collectHandwaveViewModes(content);
    content.innerHTML = nextContent.innerHTML;
    restoreHandwaveViewModes(content, viewModes);
    if (nextDocument.title) {
      document.title = nextDocument.title;
    }
    focusHandwaveTarget(typeof message.focusId === "string" ? message.focusId : null);
    window.MathJax?.typesetPromise?.([content]).catch(() => undefined);
  });

  document.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : undefined;
    const button = target?.closest("[data-set-mode]");
    if (!button) {
      return;
    }

    const section = button.closest("[data-mode]");
    if (!section) {
      return;
    }

    const nextMode = button.dataset.setMode;
    if (!nextMode) {
      return;
    }
    applyHandwaveSectionMode(section, nextMode);
  });

  document.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : undefined;
    const button = target?.closest("[data-toggle-collapsed]");
    if (!button) {
      return;
    }

    const section = button.closest("[data-mode]");
    if (!section) {
      return;
    }

    const nextMode = section.dataset.mode === "collapsed" ? (section.dataset.lastMode || "text") : "collapsed";
    const lastMode = section.dataset.mode !== "collapsed" ? (section.dataset.mode || "text") : section.dataset.lastMode;
    applyHandwaveSectionMode(section, nextMode, lastMode);
  });
</script>
</body>
</html>`;
}

function renderArticleEditControl(className: string, offset: number, blockType: string): string {
  const label = `Edit this ${blockType}`;
  return `<button class="${className}" type="button" data-edit-article data-edit-offset="${offset}" title="${label}" aria-label="${label}">Edit</button>`;
}

function renderMarkdownDocument(
  text: string,
  markdownTree: HandwaveMarkdownTree,
  commandHref: (target: string) => string,
  editableArticles: boolean,
  renderInclude?: (target: string) => string
): string {
  return new MarkdownHtmlRenderer(
    text,
    commandHref,
    true,
    editableArticles,
    renderInclude
  ).renderDocument(markdownTree);
}

function renderInlineMarkdown(
  text: string,
  commandHref: (target: string) => string,
  renderLinks = true
): string {
  const markdownTree = parseHandwaveMarkdown(text);
  return new MarkdownHtmlRenderer(text, commandHref, renderLinks, false)
    .renderInlineDocument(markdownTree);
}

class MarkdownHtmlRenderer {
  private references: HandwaveMarkdownReferences = new Map();

  constructor(
    private readonly text: string,
    private readonly commandHref: (target: string) => string,
    private readonly renderLinks: boolean,
    private readonly editableArticles: boolean,
    private readonly renderInclude?: (target: string) => string
  ) {}

  renderDocument(tree: HandwaveMarkdownTree): string {
    this.references = handwaveMarkdownReferences(this.text, tree);
    return markdownChildren(tree.topNode)
      .map((node) => this.renderBlock(node, false, this.editableArticles))
      .filter(Boolean)
      .join("\n");
  }

  renderInlineDocument(tree: HandwaveMarkdownTree): string {
    this.references = handwaveMarkdownReferences(this.text, tree);
    return this.renderInlineContents(tree.topNode);
  }

  private renderBlock(node: HandwaveMarkdownNode, tightParagraph: boolean, editable: boolean): string {
    const heading = handwaveMarkdownHeading(this.text, node);
    if (heading) {
      const id = heading.explicitId ?? slugForHeading(heading.title);
      const editControl = editable
        ? renderArticleEditControl(
          "article-heading-edit",
          heading.titleFrom,
          heading.level === 1 ? "title" : "heading"
        )
        : "";
      const cssClass = editable ? ` class="article-editable-heading"` : "";
      return `<h${heading.level} id="${escapeHtml(id)}"${cssClass}>${editControl}${this.renderInlineContents(node, heading.titleFrom, heading.titleTo)}</h${heading.level}>`;
    }

    switch (node.name) {
      case "Paragraph": {
        const contents = this.renderInlineContents(node);
        if (tightParagraph) {
          return contents;
        }
        const editControl = editable
          ? renderArticleEditControl("article-block-edit", this.firstContentOffset(node), "paragraph")
          : "";
        const cssClass = editable ? ` class="article-editable-block"` : "";
        return `<p${cssClass}>${editControl}${contents}</p>`;
      }
      case "Blockquote": {
        const editControl = editable
          ? renderArticleEditControl("article-block-edit", this.firstContentOffset(node), "quote")
          : "";
        const cssClass = editable ? ` class="article-editable-block"` : "";
        const contents = markdownChildren(node)
          .filter((child) => child.name !== "QuoteMark")
          .map((child) => this.renderBlock(child, false, false))
          .filter(Boolean)
          .join("\n");
        return `<blockquote${cssClass}>${editControl}${contents}</blockquote>`;
      }
      case "BulletList":
        return this.renderList(node, false, editable);
      case "OrderedList":
        return this.renderList(node, true, editable);
      case "ListItem":
        return this.renderListItem(node, tightParagraph);
      case "FencedCode":
      case "CodeBlock":
        return this.renderCodeBlock(node);
      case "HorizontalRule":
        return "<hr>";
      case "HandwaveIncludeBlock":
        return this.renderHandwaveInclude(node);
      case "LinkReference":
        return "";
      case "HTMLBlock":
      case "CommentBlock":
      case "ProcessingInstructionBlock":
        return `<pre><code>${escapeHtml(this.text.slice(node.from, node.to))}</code></pre>`;
      default: {
        const children = markdownChildren(node);
        if (children.length === 0) {
          return renderTypographicText(this.text.slice(node.from, node.to));
        }
        return children
          .map((child) => this.renderBlock(child, false, false))
          .filter(Boolean)
          .join("\n");
      }
    }
  }

  private renderList(node: HandwaveMarkdownNode, ordered: boolean, editable: boolean): string {
    const tight = !this.isLooseList(node);
    const items = markdownChildren(node)
      .filter((child) => child.name === "ListItem")
      .map((child) => this.renderListItem(child, tight))
      .join("\n");
    let startAttribute = "";
    if (ordered) {
      const firstMark = markdownChildren(markdownChildren(node)[0] ?? node)
        .find((child) => child.name === "ListMark");
      const start = firstMark
        ? Number.parseInt(this.text.slice(firstMark.from, firstMark.to), 10)
        : 1;
      if (Number.isFinite(start) && start !== 1) {
        startAttribute = ` start="${start}"`;
      }
    }
    const tag = ordered ? "ol" : "ul";
    const list = `<${tag}${startAttribute}>${items}</${tag}>`;
    if (!editable) {
      return list;
    }
    const editControl = renderArticleEditControl(
      "article-block-edit",
      this.firstContentOffset(node),
      "list"
    );
    return `<div class="article-editable-block article-editable-list">${editControl}${list}</div>`;
  }

  private renderListItem(node: HandwaveMarkdownNode, tight: boolean): string {
    const contents = markdownChildren(node)
      .filter((child) => child.name !== "ListMark")
      .map((child) => this.renderBlock(child, tight && child.name === "Paragraph", false))
      .filter(Boolean)
      .join("\n");
    return `<li>${contents}</li>`;
  }

  private renderCodeBlock(node: HandwaveMarkdownNode): string {
    const children = markdownChildren(node);
    const code = children
      .filter((child) => child.name === "CodeText")
      .map((child) => this.text.slice(child.from, child.to))
      .join("");
    const info = children.find((child) => child.name === "CodeInfo");
    const language = info
      ? this.text.slice(info.from, info.to).trim().split(/\s+/, 1)[0]
      : "";
    const languageClass = language ? ` class="language-${escapeHtml(language)}"` : "";
    return `<pre><code${languageClass}>${escapeHtml(code)}</code></pre>`;
  }

  private renderInlineContents(
    node: HandwaveMarkdownNode,
    from = node.from,
    to = node.to
  ): string {
    const fragments: string[] = [];
    let cursor = from;
    for (const child of markdownChildren(node)) {
      if (child.to <= from || child.from >= to) {
        continue;
      }
      const childFrom = Math.max(child.from, from);
      const childTo = Math.min(child.to, to);
      if (cursor < childFrom) {
        fragments.push(renderMarkdownText(this.text.slice(cursor, childFrom)));
      }
      fragments.push(this.renderInlineNode(child, childFrom, childTo));
      cursor = child.name === "QuoteMark" && childTo < to && this.text[childTo] === " "
        ? childTo + 1
        : childTo;
    }
    if (cursor < to) {
      fragments.push(renderMarkdownText(this.text.slice(cursor, to)));
    }
    return fragments.join("");
  }

  private renderInlineNode(
    node: HandwaveMarkdownNode,
    from = node.from,
    to = node.to
  ): string {
    if (from !== node.from || to !== node.to) {
      return renderMarkdownText(this.text.slice(from, to));
    }
    switch (node.name) {
      case "Emphasis":
        return this.renderDelimited(node, "em");
      case "StrongEmphasis":
        return this.renderDelimited(node, "strong");
      case "Link":
        return this.renderLink(node);
      case "Image":
        return this.renderImage(node);
      case "Autolink":
        return this.renderAutolink(node);
      case "InlineCode":
        return `<code>${escapeHtml(this.inlineCodeText(node))}</code>`;
      case "Escape":
        return renderTypographicText(this.text.slice(node.from + 1, node.to));
      case "Entity":
        return this.text.slice(node.from, node.to);
      case "HardBreak":
        return "<br>\n";
      case "HandwaveMath":
        return escapeHtml(this.text.slice(node.from, node.to));
      case "HandwaveAnchor": {
        const anchor = handwaveMarkdownAnchor(this.text, node);
        return anchor ? `<span id="${escapeHtml(anchor.id)}"></span>` : "";
      }
      case "HandwaveIncludeInline":
      case "HandwaveIncludeBlock":
        return this.renderHandwaveInclude(node);
      case "HTMLTag":
        return escapeHtml(this.text.slice(node.from, node.to));
      case "EmphasisMark":
      case "CodeMark":
      case "LinkMark":
      case "URL":
      case "LinkTitle":
      case "LinkLabel":
      case "HeaderMark":
      case "ListMark":
      case "QuoteMark":
        return "";
      default:
        return this.renderInlineContents(node, from, to);
    }
  }

  private renderDelimited(node: HandwaveMarkdownNode, tag: "em" | "strong"): string {
    const marks = markdownChildren(node).filter((child) => child.name === "EmphasisMark");
    const openingMark = marks[0];
    const closingMark = marks[marks.length - 1];
    if (!openingMark || !closingMark || openingMark === closingMark) {
      return this.renderInlineContents(node);
    }
    return `<${tag}>${this.renderInlineContents(node, openingMark.to, closingMark.from)}</${tag}>`;
  }

  private renderLink(node: HandwaveMarkdownNode): string {
    const link = handwaveMarkdownLink(this.text, node, this.references);
    if (!link) {
      return renderTypographicText(this.text.slice(node.from, node.to));
    }
    const label = this.renderInlineContents(node, link.labelFrom, link.labelTo);
    if (!this.renderLinks) {
      return label;
    }
    const target = link.target;
    const handwaveNavigation = isHandwaveNavigationTarget(target);
    const href = handwaveNavigation ? this.commandHref(target) : safeMarkdownHref(target);
    if (!href) {
      return label;
    }
    const navigationAttribute = handwaveNavigation
      ? ` data-handwave-target="${escapeHtml(target)}"`
      : "";
    const title = this.linkTitle(node) ?? target;
    return `<a href="${escapeHtml(href)}"${navigationAttribute} title="${escapeHtml(title)}">${label}</a>`;
  }

  private renderAutolink(node: HandwaveMarkdownNode): string {
    const urlNode = markdownChildren(node).find((child) => child.name === "URL");
    if (!urlNode) {
      return renderTypographicText(this.text.slice(node.from, node.to));
    }
    const label = this.text.slice(urlNode.from, urlNode.to);
    if (!this.renderLinks) {
      return renderTypographicText(label);
    }
    const target = label.includes("@") && !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(label)
      ? `mailto:${label}`
      : label;
    const href = safeMarkdownHref(target);
    return href
      ? `<a href="${escapeHtml(href)}" title="${escapeHtml(target)}">${renderTypographicText(label)}</a>`
      : renderTypographicText(label);
  }

  private renderImage(node: HandwaveMarkdownNode): string {
    const children = markdownChildren(node);
    const closingLabel = children.find((child) =>
      child.name === "LinkMark" && this.text.slice(child.from, child.to) === "]"
    );
    const urlNode = children.find((child) => child.name === "URL");
    if (!closingLabel || !urlNode) {
      return renderTypographicText(this.text.slice(node.from, node.to));
    }
    const labelFrom = node.from + 2;
    const alt = this.plainInlineText(node, labelFrom, closingLabel.from);
    const target = normalizeMarkdownUrl(this.text.slice(urlNode.from, urlNode.to));
    const href = safeMarkdownHref(target);
    if (!href) {
      return escapeHtml(alt);
    }
    const title = this.linkTitle(node);
    const titleAttribute = title === undefined ? "" : ` title="${escapeHtml(title)}"`;
    return `<img src="${escapeHtml(href)}" alt="${escapeHtml(alt)}"${titleAttribute}>`;
  }

  private renderHandwaveInclude(node: HandwaveMarkdownNode): string {
    const include = handwaveMarkdownInclude(this.text, node);
    if (!include || !this.renderInclude) {
      return escapeHtml(this.text.slice(node.from, node.to));
    }
    return this.renderInclude(include.target);
  }

  private inlineCodeText(node: HandwaveMarkdownNode): string {
    const marks = markdownChildren(node).filter((child) => child.name === "CodeMark");
    if (marks.length < 2) {
      return this.text.slice(node.from, node.to);
    }
    let contents = this.text.slice(marks[0].to, marks[marks.length - 1].from)
      .replace(/\r\n|\r|\n/g, " ");
    if (
      contents.length >= 2 &&
      contents.startsWith(" ") &&
      contents.endsWith(" ") &&
      /[^ ]/.test(contents)
    ) {
      contents = contents.slice(1, -1);
    }
    return contents;
  }

  private linkTitle(node: HandwaveMarkdownNode): string | undefined {
    const title = markdownChildren(node).find((child) => child.name === "LinkTitle");
    if (!title) {
      return undefined;
    }
    const source = this.text.slice(title.from, title.to);
    return source.length >= 2 ? source.slice(1, -1) : source;
  }

  private plainInlineText(node: HandwaveMarkdownNode, from: number, to: number): string {
    const fragments: string[] = [];
    let cursor = from;
    for (const child of markdownChildren(node)) {
      if (child.to <= from || child.from >= to) {
        continue;
      }
      const childFrom = Math.max(child.from, from);
      const childTo = Math.min(child.to, to);
      if (cursor < childFrom) {
        fragments.push(this.text.slice(cursor, childFrom));
      }
      if (!/^(?:EmphasisMark|CodeMark|LinkMark)$/.test(child.name)) {
        fragments.push(
          child.name === "Escape"
            ? this.text.slice(child.from + 1, child.to)
            : markdownChildren(child).length > 0
              ? this.plainInlineText(child, childFrom, childTo)
              : this.text.slice(childFrom, childTo)
        );
      }
      cursor = childTo;
    }
    if (cursor < to) {
      fragments.push(this.text.slice(cursor, to));
    }
    return fragments.join("");
  }

  private firstContentOffset(node: HandwaveMarkdownNode): number {
    if (node.name === "Paragraph") {
      return node.from;
    }
    for (const child of markdownChildren(node)) {
      if (/^(?:ListMark|QuoteMark|HeaderMark|CodeMark)$/.test(child.name)) {
        continue;
      }
      return this.firstContentOffset(child);
    }
    const source = this.text.slice(node.from, node.to);
    const firstNonSpace = source.search(/\S/);
    return firstNonSpace < 0 ? node.from : node.from + firstNonSpace;
  }

  private isLooseList(node: HandwaveMarkdownNode): boolean {
    const items = markdownChildren(node).filter((child) => child.name === "ListItem");
    for (let index = 1; index < items.length; index++) {
      if (hasMarkdownBlankLine(this.text.slice(items[index - 1].to, items[index].from))) {
        return true;
      }
    }
    return items.some((item) => {
      const blocks = markdownChildren(item).filter((child) => child.name !== "ListMark");
      for (let index = 1; index < blocks.length; index++) {
        if (hasMarkdownBlankLine(this.text.slice(blocks[index - 1].to, blocks[index].from))) {
          return true;
        }
      }
      return false;
    });
  }
}

function renderMarkdownText(text: string): string {
  return renderTypographicText(text.replace(/(?:\r\n|\r|\n)[ \t]*/g, " "));
}

function hasMarkdownBlankLine(source: string): boolean {
  return /(?:\r\n|\r|\n)[ \t]*(?:>[ \t]*)?(?:\r\n|\r|\n)/.test(source);
}

function normalizeMarkdownUrl(target: string): string {
  return target.startsWith("<") && target.endsWith(">")
    ? target.slice(1, -1)
    : target;
}

function safeMarkdownHref(target: string): string | undefined {
  const schemeProbe = target.replace(/[\u0000-\u0020\u007f]+/g, "").toLowerCase();
  return /^(?:javascript|vbscript|data):/.test(schemeProbe) ? undefined : target;
}

function renderTypographicText(text: string): string {
  return escapeHtml(applyLatexTextTypography(text));
}

export function applyLatexTextTypography(text: string): string {
  const fragments: string[] = [];
  let cursor = 0;
  for (const match of protectedInlineMatches(text)) {
    const matchIndex = match.index ?? 0;
    fragments.push(replaceLatexTextDashes(text.slice(cursor, matchIndex)));
    fragments.push(match[0]);
    cursor = matchIndex + match[0].length;
  }
  fragments.push(replaceLatexTextDashes(text.slice(cursor)));
  return fragments.join("");
}

function protectedInlineMatches(text: string): IterableIterator<RegExpMatchArray> {
  return text.matchAll(/(`+)([\s\S]*?)\1|\$\$[\s\S]*?\$\$|\$(?:\\.|[^$\n])+\$|\\\([\s\S]*?\\\)|\\\[[\s\S]*?\\\]|(?:https?:\/\/|mailto:|www\.)[^\s<]+/g);
}

function replaceLatexTextDashes(text: string): string {
  return text.replace(/---|--/g, (dashes) => dashes.length === 3 ? "—" : "–");
}

function proseParagraphs(text: string): string[] {
  return text
    .split(/\r?\n[ \t]*\r?\n/)
    .map((paragraph) => paragraph.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).join(" "))
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
}

function renderProseParagraphs(text: string, commandHref: (target: string) => string): string {
  return proseParagraphs(text)
    .map((paragraph) => `<p class="prose-paragraph">${renderInlineMarkdown(paragraph, commandHref)}</p>`)
    .join("");
}

function renderLabeledProseParagraphs(
  lineClass: string,
  labelHtml: string,
  text: string,
  commandHref: (target: string) => string
): string {
  const paragraphs = proseParagraphs(text);
  if (paragraphs.length === 0) {
    return `<p class="${escapeHtml(lineClass)}">${labelHtml}</p>`;
  }

  const [first, ...rest] = paragraphs;
  return [
    `<p class="${escapeHtml(lineClass)}">${labelHtml} <span class="prose-content">${renderInlineMarkdown(first, commandHref)}</span></p>`,
    ...rest.map((paragraph) =>
      `<p class="prose-paragraph prose-content">${renderInlineMarkdown(paragraph, commandHref)}</p>`
    )
  ].join("");
}

function renderProofParagraphs(text: string, commandHref: (target: string) => string): string {
  const paragraphs = proseParagraphs(text);
  if (paragraphs.length === 0) {
    return `<p class="prose-paragraph"><span class="qed" aria-label="QED">□</span></p>`;
  }

  return paragraphs
    .map((paragraph, index) => {
      const qed = index === paragraphs.length - 1 ? `<span class="qed" aria-label="QED">□</span>` : "";
      return `<p class="prose-paragraph">${renderInlineMarkdown(paragraph, commandHref)}${qed}</p>`;
    })
    .join("");
}

function renderDeclarationPackage(
  declaration: LeanDeclaration,
  target: string,
  commandHref: (target: string) => string,
  editorHref: (target: string) => string,
  index: HandwaveIndex,
  options: DeclarationRenderOptions = {}
): string {
  if (isTheoremLike(declaration)) {
    return renderTheoremView(declaration, target, commandHref, editorHref, index, options);
  }

  return renderDefinitionView(declaration, target, commandHref, editorHref, options);
}

function renderTheoremView(
  declaration: LeanDeclaration,
  target: string,
  commandHref: (target: string) => string,
  editorHref: (target: string) => string,
  index: HandwaveIndex,
  options: DeclarationRenderOptions = {}
): string {
  const proseStatement =
    declaration.doc?.fields.statement ??
    `See the Lean statement for ${declaration.name}.`;
  const proseProof = declaration.doc?.fields.proof ?? "No prose proof has been written yet.";
  const leanProof = declaration.leanProof ?? declaration.statement;
  const label = declarationLabel("Theorem", declaration);
  const status = index.checkStatusForLean(declaration.name);
  const dependencyTree = options.dependencyTree === false
    ? ""
    : renderDependencyTree(declaration.name, index, commandHref);
  const definitionReferences = options.definitionReferences === false
    ? ""
    : renderStatementDefinitionReferences(declaration.name, index, commandHref);
  const milestoneControl = options.milestoneControls === false
    ? ""
    : renderMilestoneTagControl(declaration, target, options.editableTags !== false);
  const metadataControl = renderMetadataEditControl(target, options.editableMetadata === true);

  return compactHtml(`
    <section class="theorem-view" id="${escapeHtml(leanDeclarationAnchorId(declaration.name))}" data-target="${escapeHtml(target)}">
      ${metadataControl}
      <div class="theorem-statement" data-section="statement" data-mode="text">
        ${renderLabeledProseParagraphs("theorem-line", `${renderCheckStatus(status)}${renderDeclarationLabel(label, target, commandHref, editorHref, "Theorem view", `${dependencyTree}${definitionReferences}`, declaration.sourceName, milestoneControl, options)}`, proseStatement, commandHref)}
        ${renderLeanBlock(declaration.leanStatement)}
      </div>
      <div class="proof-section" data-section="proof" data-mode="text">
        <div class="proof-line"><button class="collapse-control" type="button" data-toggle-collapsed="proof" aria-expanded="true" aria-label="Collapse proof">▾</button>${renderProofLabel(options)} <div class="proof-content">
          <div class="proof-body">
            <div class="prose-content">${renderProofParagraphs(proseProof, commandHref)}</div>
            ${renderLeanBlock(leanProof)}
          </div>
        </div></div>
      </div>
    </section>
  `);
}

function renderDefinitionView(
  declaration: LeanDeclaration,
  target: string,
  commandHref: (target: string) => string,
  editorHref: (target: string) => string,
  options: DeclarationRenderOptions = {}
): string {
  const proseStatement =
    declaration.doc?.fields.statement ??
    `See the Lean definition for ${declaration.name}.`;
  const label = declarationLabel("Definition", declaration);
  const metadataControl = renderMetadataEditControl(target, options.editableMetadata === true);

  return compactHtml(`
    <section class="definition-view" id="${escapeHtml(leanDeclarationAnchorId(declaration.name))}" data-target="${escapeHtml(target)}">
      ${metadataControl}
      <div class="definition-statement" data-section="statement" data-mode="text">
        ${renderLabeledProseParagraphs("definition-line", renderDeclarationLabel(label, target, commandHref, editorHref, "Definition view", "", declaration.sourceName, "", options), proseStatement, commandHref)}
        ${renderLeanBlock(declaration.statement)}
      </div>
    </section>
  `);
}

function renderLeanTheoremContextHtml(
  declaration: LeanDeclaration,
  index: HandwaveIndex,
  commandHref: (target: string) => string,
  editorHref: (target: string) => string,
  options: RenderOptions
): string {
  const declarations = theoremContextDeclarations(declaration, index);
  const title = declaration.doc?.fields.name?.trim() || shortLeanName(declaration.sourceName);
  const body = [
    `<h1>${escapeHtml(title)}</h1>`,
    `<p class="lean-file-path">${escapeHtml(declaration.uri)}</p>`,
    declarations.map((item) =>
      renderDeclarationPackage(item, `lean:${item.name}`, commandHref, editorHref, index)
    ).join("\n")
  ].join("\n");

  return renderHtmlShell(title, body, options);
}

function theoremContextDeclarations(
  declaration: LeanDeclaration,
  index: HandwaveIndex
): LeanDeclaration[] {
  const dependencyNames = flattenDependencyTree(dependencyTreeNodes(declaration.name, index, new Set([declaration.name])));
  const dependencies = [...dependencyNames]
    .filter((name) => name !== declaration.name)
    .map((name) => index.leanDeclarations.get(name))
    .filter((item): item is LeanDeclaration => Boolean(item))
    .sort(compareLeanDeclarationsBySource);

  return [...dependencies, declaration];
}

function flattenDependencyTree(nodes: readonly DependencyTreeNode[]): Set<string> {
  const result = new Set<string>();

  const visit = (node: DependencyTreeNode) => {
    for (const child of node.children) {
      visit(child);
    }
    result.add(node.name);
  };

  for (const node of nodes) {
    visit(node);
  }
  return result;
}

function compareLeanDeclarationsBySource(first: LeanDeclaration, second: LeanDeclaration): number {
  return first.uri.localeCompare(second.uri) ||
    first.range.start.line - second.range.start.line ||
    first.range.start.character - second.range.start.character ||
    first.name.localeCompare(second.name);
}

function isTheoremLike(declaration: LeanDeclaration): boolean {
  return declaration.kind === "theorem" || declaration.kind === "lemma";
}

function declarationLabel(baseLabel: string, declaration: LeanDeclaration): string {
  const displayName = declaration.doc?.fields.name?.trim();
  if (!displayName) {
    return `${escapeHtml(baseLabel)}.`;
  }

  return `${escapeHtml(baseLabel)} (${renderInlineMarkdown(displayName, (target) => target, false)}).`;
}

function renderMilestoneTagControl(
  declaration: LeanDeclaration,
  target: string,
  editable: boolean
): string {
  const active = hasHandwaveTag(declaration.doc, "milestone");
  if (!editable) {
    return active
      ? `<span class="milestone-tag" title="Milestone" aria-label="Milestone">★</span>`
      : "";
  }
  const escapedTarget = escapeHtml(target);
  const label = active ? "Remove milestone tag" : "Add milestone tag";
  const symbol = active ? "★" : "☆";
  const cssClass = active ? "milestone-control-active" : "milestone-control-inactive";
  return `<button class="milestone-control ${cssClass}" type="button" data-toggle-tag="milestone" data-handwave-target="${escapedTarget}" aria-pressed="${String(active)}" title="${label}" aria-label="${label}">${symbol}</button>`;
}

function renderMetadataEditControl(target: string, editable: boolean): string {
  if (!editable) {
    return "";
  }
  const escapedTarget = escapeHtml(target);
  return `<button class="declaration-metadata-edit" type="button" data-edit-declaration="${escapedTarget}" title="Edit Handwave metadata" aria-label="Edit Handwave metadata">Edit</button>`;
}

function renderDeclarationLabel(
  label: string,
  target: string,
  commandHref: (target: string) => string,
  editorHref: (target: string) => string,
  controlsLabel: string,
  popoverBodyHtml = "",
  sourceName?: string,
  leadingControlsHtml = "",
  options: DeclarationRenderOptions = {}
): string {
  const href = escapeHtml(commandHref(target));
  const editorLinkHref = escapeHtml(editorHref(target));
  const escapedTarget = escapeHtml(target);
  const sourceLabel = escapeHtml(sourceName ?? declarationSourceLabel(target));
  if (options.popovers === false) {
    return `<span class="declaration-label"><strong><a class="declaration-link" href="${href}" data-handwave-target="${escapedTarget}" title="Open ${escapedTarget}">${label}</a></strong></span>`;
  }
  const sourceHtml = options.sourceLinks === false
    ? `<span class="source-name" title="Lean declaration ${sourceLabel}">${sourceLabel}</span>`
    : `<a href="${editorLinkHref}" title="Open ${sourceLabel} in editor">${sourceLabel}</a>`;
  return `<span class="declaration-label"><strong><a class="declaration-link" href="${href}" data-handwave-target="${escapedTarget}" title="Open ${escapedTarget}">${label}</a></strong><span class="source-popover"><span class="source-popover-row">${leadingControlsHtml}${renderModeControls(controlsLabel)}<span class="source-popover-separator">|</span>${sourceHtml}<button class="copy-control" type="button" data-copy-target="${escapedTarget}" title="Copy ${escapedTarget}" aria-label="Copy ${escapedTarget}"><span class="copy-icon" aria-hidden="true"></span><span class="sr-only">Copy</span></button></span>${popoverBodyHtml}</span></span>`;
}

function renderProofLabel(options: DeclarationRenderOptions = {}): string {
  if (options.popovers === false) {
    return `<span class="declaration-label"><strong>Proof.</strong></span>`;
  }
  return `<span class="declaration-label"><strong>Proof.</strong><span class="source-popover"><span class="source-popover-row">${renderModeControls("Proof view")}</span></span></span>`;
}

function renderDependencyTree(
  name: string,
  index: HandwaveIndex,
  commandHref: (target: string) => string
): string {
  const nodes = dependencyTreeNodes(name, index, new Set([name]));
  if (nodes.length === 0) {
    return "";
  }

  return `<span class="dependency-tree" role="tree" aria-label="Dependency tree">${renderDependencyList(nodes, commandHref, index)}</span>`;
}

function renderStatementDefinitionReferences(
  name: string,
  index: HandwaveIndex,
  commandHref: (target: string) => string
): string {
  const items = index.statementDefinitionsForLean(name).map((definitionName) => {
    const target = `lean:${definitionName}`;
    const href = escapeHtml(commandHref(target));
    const escapedTarget = escapeHtml(target);
    const label = renderTypographicText(dependencyDisplayName(definitionName, index));
    return `<span class="definition-reference-item"><a class="definition-reference-link" href="${href}" data-handwave-target="${escapedTarget}" title="Open ${escapedTarget}">${label}</a></span>`;
  });
  if (items.length === 0) {
    return "";
  }
  return `<span class="definition-references" role="group" aria-label="Definitions referenced in theorem statement"><span class="definition-references-title">Definitions</span><span class="definition-reference-list">${items.join("")}</span></span>`;
}

function dependencyTreeNodes(
  name: string,
  index: HandwaveIndex,
  path: ReadonlySet<string>
): DependencyTreeNode[] {
  return index.dependenciesForLean(name).map((dependencyName) => {
    const status = index.checkStatusForLean(dependencyName);
    const cycle = path.has(dependencyName);
    const nextPath = new Set(path);
    nextPath.add(dependencyName);
    return {
      name: dependencyName,
      status,
      cycle,
      children: !cycle && shouldExpandDependency(status)
        ? dependencyTreeNodes(dependencyName, index, nextPath)
        : []
    };
  });
}

function renderDependencyList(
  nodes: readonly DependencyTreeNode[],
  commandHref: (target: string) => string,
  index: HandwaveIndex
): string {
  return `<span class="dependency-tree-list" role="group">${nodes.map((node) => renderDependencyNode(node, commandHref, index)).join("")}</span>`;
}

function renderDependencyNode(
  node: DependencyTreeNode,
  commandHref: (target: string) => string,
  index: HandwaveIndex
): string {
  const target = `lean:${node.name}`;
  const href = escapeHtml(commandHref(target));
  const escapedTarget = escapeHtml(target);
  const escapedName = escapeHtml(node.name);
  const escapedLabel = renderTypographicText(dependencyDisplayName(node.name, index));
  const statusKind = dependencyStatusKind(node.status);
  const children = node.children.length > 0 ? renderDependencyList(node.children, commandHref, index) : "";
  const cycleAttribute = node.cycle ? ` data-dependency-cycle="true"` : "";
  return `<span class="dependency-tree-item dependency-tree-${statusKind}" role="treeitem" data-dependency-name="${escapedName}" data-dependency-status="${statusKind}"${cycleAttribute}><span class="dependency-node">${renderCheckStatus(node.status)}<a class="dependency-link" href="${href}" data-handwave-target="${escapedTarget}" title="Open ${escapedTarget}">${escapedLabel}</a></span>${children}</span>`;
}

function dependencyDisplayName(name: string, index: HandwaveIndex): string {
  const declaration = index.leanDeclarations.get(name);
  return declaration?.doc?.fields.name?.trim() || shortLeanName(declaration?.sourceName ?? name);
}

function shortLeanName(name: string): string {
  return name.split(".").filter(Boolean).pop() ?? name;
}

function shouldExpandDependency(status: LeanCheckStatus): boolean {
  return Boolean(status && !status.checked);
}

function dependencyStatusKind(status: LeanCheckStatus): string {
  if (!status) {
    return "pending";
  }
  if (status.inconclusive) {
    return "inconclusive";
  }
  if (status.blocked) {
    return "blocked";
  }
  if (status.checked) {
    return "checked";
  }
  if (status.ownChecked) {
    return "dependency-warning";
  }
  return "unchecked";
}

function declarationSourceLabel(target: string): string {
  const parsed = parseTarget(target);
  return parsed.kind === "lean" ? parsed.base : target;
}

function renderModeControls(ariaLabel: string): string {
  return `<span class="view-switch" role="group" aria-label="${escapeHtml(ariaLabel)}"><button class="mode-control" type="button" data-set-mode="text" aria-pressed="true">text</button><button class="mode-control" type="button" data-set-mode="lean" aria-pressed="false">lean</button></span>`;
}

export function renderCheckStatus(status: LeanCheckStatus): string {
  if (!status) {
    return `<span class="check-status check-status-pending" title="Lean status is still being inferred." aria-label="Lean status pending">…</span>`;
  }

  if (status.inconclusive) {
    const mark = status.stale ? "(?)" : "?";
    const staleClass = status.stale ? " check-status-stale" : "";
    const label = status.stale ? "Lean status unavailable, stale" : "Lean status unavailable";
    return `<span class="check-status check-status-inconclusive${staleClass}" title="${escapeHtml(status.reason)}" aria-label="${escapeHtml(label)}">${mark}</span>`;
  }

  if (status.blocked) {
    const mark = status.stale ? "(!)" : "!";
    const staleClass = status.stale ? " check-status-stale" : "";
    const label = status.stale ? "Lean dependency check blocked, stale" : "Lean dependency check blocked";
    return `<span class="check-status check-status-blocked${staleClass}" title="${escapeHtml(status.reason)}" aria-label="${escapeHtml(label)}">${mark}</span>`;
  }

  const hasDependencyWarning = !status.checked && status.ownChecked;
  const baseMark = status.checked || hasDependencyWarning ? "✓" : "✗";
  const mark = status.stale ? `(${baseMark})` : baseMark;
  const cssClass = status.checked
    ? "check-status-checked"
    : hasDependencyWarning
      ? "check-status-dependency-warning"
      : "check-status-unchecked";
  const staleClass = status.stale ? " check-status-stale" : "";
  const baseLabel = status.checked
    ? "Lean checked"
    : hasDependencyWarning
      ? "Lean checked with unchecked dependencies"
      : "Lean unchecked";
  const label = status.stale ? `${baseLabel}, stale` : baseLabel;
  return `<span class="check-status ${cssClass}${staleClass}" title="${escapeHtml(status.reason)}" aria-label="${escapeHtml(label)}">${mark}</span>`;
}

function renderLeanBlock(source: string): string {
  const highlighted = highlightLean(source).replace(/\r?\n/g, "&#10;");
  return `<pre class="lean-content"><code class="lean-source">${highlighted}</code></pre>`;
}

function highlightLean(source: string): string {
  const tokenPattern =
    /--[\s\S]*?-\/|\/-[\s\S]*?-\/|--.*|"(?:\\.|[^"\\])*"|`[^`\n]*`|\b(?:abbrev|axiom|by|calc|class|def|deriving|else|end|example|exact|extends|fun|have|if|import|in|inductive|instance|let|lemma|match|namespace|noncomputable|open|opaque|private|protected|public|rfl|simp|structure|theorem|then|universe|variable|where|with)\b|\b(?:Prop|Sort|Type|True|False|Nat|Int|Rat|Real|Complex|Set|Fin)\b|:=|=>|↦|←|→|∀|∃|≤|≥|≠|∧|∨|¬|⟨|⟩|·/g;
  let html = "";
  let cursor = 0;

  for (const match of source.matchAll(tokenPattern)) {
    const token = match[0];
    const index = match.index ?? 0;
    html += escapeHtml(source.slice(cursor, index));
    html += highlightLeanToken(token);
    cursor = index + token.length;
  }

  html += escapeHtml(source.slice(cursor));
  return html;
}

function highlightLeanToken(token: string): string {
  if (token.startsWith("--") || token.startsWith("/-")) {
    return `<span class="lean-comment">${escapeHtml(token)}</span>`;
  }

  if (token.startsWith("\"")) {
    return `<span class="lean-string">${escapeHtml(token)}</span>`;
  }

  if (/^`[^`\n]*`$/.test(token)) {
    return `<span class="lean-constant">${escapeHtml(token)}</span>`;
  }

  if (/^(Prop|Sort|Type|True|False|Nat|Int|Rat|Real|Complex|Set|Fin)$/.test(token)) {
    return `<span class="lean-constant">${escapeHtml(token)}</span>`;
  }

  if (/^(:=|=>|↦|←|→|∀|∃|≤|≥|≠|∧|∨|¬|⟨|⟩|·)$/.test(token)) {
    return `<span class="lean-operator">${escapeHtml(token)}</span>`;
  }

  return `<span class="lean-keyword">${escapeHtml(token)}</span>`;
}

function slugForHeading(title: string): string {
  return title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "section";
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function compactHtml(value: string): string {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("");
}
