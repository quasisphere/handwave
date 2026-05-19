import { HandwaveIndex } from "./index";
import { parseArticleDocument, parseTarget } from "./parser";
import { LeanDeclaration } from "./types";

export function renderArticleHtml(
  text: string,
  uri: string,
  index: HandwaveIndex,
  commandHref: (target: string) => string,
  options: { indexing?: boolean } = {}
): string {
  const withIncludes = text.replace(/@include\{([^}\s]+)\}/g, (_match, target: string) => {
    const parsedTarget = parseTarget(target);
    if (parsedTarget.kind === "lean" && !parsedTarget.selector) {
      const declaration = index.leanDeclarations.get(parsedTarget.base);
      if (declaration) {
        return renderDeclarationPackage(declaration, target, commandHref, index);
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
    .theorem-line .check-status {
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
    .check-status-pending {
      animation: check-status-pulse 1.2s ease-in-out infinite;
      color: var(--muted);
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
    .source-popover {
      background: var(--vscode-editorHoverWidget-background, var(--vscode-editor-background));
      border: 1px solid var(--vscode-editorHoverWidget-border, var(--border));
      border-radius: 6px;
      box-shadow: 0 6px 18px color-mix(in srgb, black 18%, transparent);
      display: none;
      left: 0;
      min-width: max-content;
      padding: 6px 8px;
      position: absolute;
      top: calc(100% + 2px);
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
      font-family: var(--vscode-editor-font-family);
      font-size: 0.9em;
      white-space: nowrap;
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
      display: block;
    }
    .proof-content {
      display: block;
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
${body}
<script>
  document.addEventListener("click", (event) => {
    const button = event.target.closest("[data-set-mode]");
    if (!button) {
      return;
    }

    const section = button.closest("[data-mode]");
    if (!section) {
      return;
    }

    const nextMode = button.dataset.setMode;
    section.dataset.mode = nextMode;
    for (const control of section.querySelectorAll("[data-set-mode]")) {
      control.setAttribute("aria-pressed", String(control.dataset.setMode === nextMode));
    }
    for (const control of section.querySelectorAll("[data-toggle-collapsed]")) {
      control.setAttribute("aria-expanded", String(nextMode !== "collapsed"));
      control.textContent = nextMode === "collapsed" ? "▸" : "▾";
      control.setAttribute("aria-label", nextMode === "collapsed" ? "Expand proof" : "Collapse proof");
    }
    if (nextMode !== "collapsed") {
      section.dataset.lastMode = nextMode;
    }
  });

  document.addEventListener("click", (event) => {
    const button = event.target.closest("[data-toggle-collapsed]");
    if (!button) {
      return;
    }

    const section = button.closest("[data-mode]");
    if (!section) {
      return;
    }

    const nextMode = section.dataset.mode === "collapsed" ? (section.dataset.lastMode || "text") : "collapsed";
    if (section.dataset.mode !== "collapsed") {
      section.dataset.lastMode = section.dataset.mode || "text";
    }
    section.dataset.mode = nextMode;
    button.setAttribute("aria-expanded", String(nextMode !== "collapsed"));
    button.textContent = nextMode === "collapsed" ? "▸" : "▾";
    button.setAttribute("aria-label", nextMode === "collapsed" ? "Expand proof" : "Collapse proof");
    for (const control of section.querySelectorAll("[data-set-mode]")) {
      control.setAttribute("aria-pressed", String(control.dataset.setMode === nextMode));
    }
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
    return `<a href="${escapeHtml(commandHref(target))}" title="${escapeHtml(target)}">${label}</a>`;
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
  index: HandwaveIndex
): string {
  if (isTheoremLike(declaration)) {
    return renderTheoremView(declaration, target, commandHref, index);
  }

  return renderDefinitionView(declaration, target, commandHref);
}

function renderTheoremView(
  declaration: LeanDeclaration,
  target: string,
  commandHref: (target: string) => string,
  index: HandwaveIndex
): string {
  const proseStatement =
    declaration.doc?.fields.statement ??
    `See the Lean statement for ${declaration.name}.`;
  const proseProof = declaration.doc?.fields.proof ?? "No prose proof has been written yet.";
  const leanProof = declaration.leanProof ?? declaration.statement;
  const label = declarationLabel("Theorem", declaration);
  const status = index.checkStatusForLean(declaration.name);

  return compactHtml(`
    <section class="theorem-view" data-target="${escapeHtml(target)}">
      <div class="theorem-statement" data-section="statement" data-mode="text">
        ${renderLabeledProseParagraphs("theorem-line", `${renderCheckStatus(status)}${renderDeclarationLabel(label, target, commandHref, "Theorem view")}`, proseStatement, commandHref)}
        ${renderLeanBlock(declaration.leanStatement)}
      </div>
      <div class="proof-section" data-section="proof" data-mode="text">
        <div class="proof-line"><button class="collapse-control" type="button" data-toggle-collapsed="proof" aria-expanded="true" aria-label="Collapse proof">▾</button>${renderProofLabel()} <div class="proof-content">
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
  commandHref: (target: string) => string
): string {
  const proseStatement =
    declaration.doc?.fields.statement ??
    `See the Lean definition for ${declaration.name}.`;
  const label = declarationLabel("Definition", declaration);

  return compactHtml(`
    <section class="definition-view" data-target="${escapeHtml(target)}">
      <div class="definition-statement" data-section="statement" data-mode="text">
        ${renderLabeledProseParagraphs("definition-line", renderDeclarationLabel(label, target, commandHref, "Definition view"), proseStatement, commandHref)}
        ${renderLeanBlock(declaration.statement)}
      </div>
    </section>
  `);
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

function renderDeclarationLabel(
  label: string,
  target: string,
  commandHref: (target: string) => string,
  controlsLabel: string
): string {
  return `<span class="declaration-label"><strong>${label}</strong><span class="source-popover"><span class="source-popover-row">${renderModeControls(controlsLabel)}<span class="source-popover-separator">|</span><a href="${escapeHtml(commandHref(target))}" title="Open ${escapeHtml(target)}">${escapeHtml(target)}</a></span></span></span>`;
}

function renderProofLabel(): string {
  return `<span class="declaration-label"><strong>Proof.</strong><span class="source-popover"><span class="source-popover-row">${renderModeControls("Proof view")}</span></span></span>`;
}

function renderModeControls(ariaLabel: string): string {
  return `<span class="view-switch" role="group" aria-label="${escapeHtml(ariaLabel)}"><button class="mode-control" type="button" data-set-mode="text" aria-pressed="true">text</button><button class="mode-control" type="button" data-set-mode="lean" aria-pressed="false">lean</button></span>`;
}

function renderCheckStatus(status: ReturnType<HandwaveIndex["checkStatusForLean"]>): string {
  if (!status) {
    return `<span class="check-status check-status-pending" title="Lean status is still being inferred." aria-label="Lean status pending">…</span>`;
  }

  const mark = status.checked ? "✓" : "✗";
  const cssClass = status.checked ? "check-status-checked" : "check-status-unchecked";
  const label = status.checked ? "Lean checked" : "Lean unchecked";
  return `<span class="check-status ${cssClass}" title="${escapeHtml(status.reason)}" aria-label="${escapeHtml(label)}">${mark}</span>`;
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
