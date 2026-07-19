import { HandwaveIndex, isIndexedLeanDeclaration } from "./index";
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
}

interface DeclarationRenderOptions {
  popovers?: boolean;
  milestoneControls?: boolean;
  dependencyTree?: boolean;
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
  const editorHref = options.editorHref ?? commandHref;
  const withIncludes = text.replace(/@include\{([^}\s]+)\}/g, (_match, target: string) => {
    const parsedTarget = parseTarget(target);
    if (parsedTarget.kind === "lean" && !parsedTarget.selector) {
      const declaration = index.leanDeclarations.get(parsedTarget.base);
      if (declaration) {
        return renderDeclarationPackage(declaration, target, commandHref, editorHref, index);
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
  });

  const body = renderBlocks(withIncludes, commandHref);
  const article = parseArticleDocument(text, uri);
  const title = article.anchors[0]?.title ?? "Handwave Article";

  return renderHtmlShell(title, body, options);
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
  editorHref: (target: string) => string
): string {
  return renderDeclarationPackage(
    declaration,
    `lean:${declaration.name}`,
    commandHref,
    editorHref,
    index,
    {
      dependencyTree: false,
      milestoneControls: false,
      popovers: false
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
      text-decoration-thickness: 1px;
      text-underline-offset: 3px;
    }
    .declaration-link {
      color: inherit;
      text-decoration: none;
    }
    .declaration-link:hover {
      color: var(--vscode-textLink-foreground, var(--accent));
      text-decoration: underline;
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
    .check-status-inconclusive {
      color: var(--muted);
    }
    .check-status-blocked {
      color: var(--warning);
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
    .source-popover a {
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
    mjx-container {
      overflow-x: auto;
      overflow-y: hidden;
      max-width: 100%;
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

function renderBlocks(text: string, commandHref: (target: string) => string): string {
  const lines = text.split(/\r?\n/);
  const blocks: string[] = [];
  let paragraph: string[] = [];
  let inFence = false;
  let fenceLines: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length > 0) {
      blocks.push(`<p>${renderInlineMarkdown(paragraph.join(" "), commandHref)}</p>`);
      paragraph = [];
    }
  };

  for (const line of lines) {
    if (line.startsWith("```")) {
      if (inFence) {
        blocks.push(`<pre><code>${escapeHtml(fenceLines.join("\n"))}</code></pre>`);
        fenceLines = [];
        inFence = false;
      } else {
        flushParagraph();
        inFence = true;
      }
      continue;
    }

    if (inFence) {
      fenceLines.push(line);
      continue;
    }

    if (!line.trim()) {
      flushParagraph();
      continue;
    }

    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      flushParagraph();
      const level = heading[1].length;
      const text = heading[2].replace(/\s+\{#[^}]+\}\s*$/, "");
      const id = slugForHeading(text);
      blocks.push(`<h${level} id="${escapeHtml(id)}">${renderInlineMarkdown(text, commandHref)}</h${level}>`);
      continue;
    }

    if (
      line.startsWith("<div class=\"include") ||
      line.startsWith("<section class=\"theorem-view\"") ||
      line.startsWith("<section class=\"definition-view\"")
    ) {
      flushParagraph();
      blocks.push(line);
      continue;
    }

    paragraph.push(line.trim());
  }

  flushParagraph();
  if (inFence) {
    blocks.push(`<pre><code>${escapeHtml(fenceLines.join("\n"))}</code></pre>`);
  }

  return blocks.join("\n");
}

function renderInlineMarkdown(text: string, commandHref: (target: string) => string): string {
  const escaped = escapeHtml(text);
  return escaped.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_match, label: string, target: string) => {
    const handwaveNavigation = isHandwaveNavigationTarget(target);
    const navigationAttribute = handwaveNavigation
      ? ` data-handwave-target="${escapeHtml(target)}"`
      : "";
    const href = handwaveNavigation ? commandHref(target) : target;
    return `<a href="${escapeHtml(href)}"${navigationAttribute} title="${escapeHtml(target)}">${label}</a>`;
  });
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
  const milestoneControl = options.milestoneControls === false
    ? ""
    : renderMilestoneTagControl(declaration, target);

  return compactHtml(`
    <section class="theorem-view" id="${escapeHtml(leanDeclarationAnchorId(declaration.name))}" data-target="${escapeHtml(target)}">
      <div class="theorem-statement" data-section="statement" data-mode="text">
        ${renderLabeledProseParagraphs("theorem-line", `${renderCheckStatus(status)}${renderDeclarationLabel(label, target, commandHref, editorHref, "Theorem view", dependencyTree, declaration.sourceName, milestoneControl, options)}`, proseStatement, commandHref)}
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

  return compactHtml(`
    <section class="definition-view" id="${escapeHtml(leanDeclarationAnchorId(declaration.name))}" data-target="${escapeHtml(target)}">
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

  return `${escapeHtml(baseLabel)} (${escapeHtml(displayName)}).`;
}

function renderMilestoneTagControl(declaration: LeanDeclaration, target: string): string {
  const active = hasHandwaveTag(declaration.doc, "milestone");
  const escapedTarget = escapeHtml(target);
  const label = active ? "Remove milestone tag" : "Add milestone tag";
  const symbol = active ? "★" : "☆";
  const cssClass = active ? "milestone-control-active" : "milestone-control-inactive";
  return `<button class="milestone-control ${cssClass}" type="button" data-toggle-tag="milestone" data-handwave-target="${escapedTarget}" aria-pressed="${String(active)}" title="${label}" aria-label="${label}">${symbol}</button>`;
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
  return `<span class="declaration-label"><strong><a class="declaration-link" href="${href}" data-handwave-target="${escapedTarget}" title="Open ${escapedTarget}">${label}</a></strong><span class="source-popover"><span class="source-popover-row">${leadingControlsHtml}${renderModeControls(controlsLabel)}<span class="source-popover-separator">|</span><a href="${editorLinkHref}" title="Open ${sourceLabel} in editor">${sourceLabel}</a><button class="copy-control" type="button" data-copy-target="${escapedTarget}" title="Copy ${escapedTarget}" aria-label="Copy ${escapedTarget}"><span class="copy-icon" aria-hidden="true"></span><span class="sr-only">Copy</span></button></span>${popoverBodyHtml}</span></span>`;
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
  const escapedLabel = escapeHtml(dependencyDisplayName(node.name, index));
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
