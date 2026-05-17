import { HandwaveIndex } from "./index";
import { parseArticleDocument, parseTarget } from "./parser";
import { LeanDeclaration } from "./types";

export function renderArticleHtml(
  text: string,
  uri: string,
  index: HandwaveIndex,
  commandHref: (target: string) => string
): string {
  const withIncludes = text.replace(/@include\{([^}\s]+)\}/g, (_match, target: string) => {
    const parsedTarget = parseTarget(target);
    if (parsedTarget.kind === "lean" && !parsedTarget.selector) {
      const declaration = index.leanDeclarations.get(parsedTarget.base);
      if (declaration) {
        return renderTheoremView(declaration, target, commandHref);
      }
    }

    const resolved = index.resolve(target, uri);
    if (!resolved) {
      return `<div class="include unresolved">Unresolved include: <code>${escapeHtml(target)}</code></div>`;
    }

    const preview = renderInlineMarkdown(resolved.preview, commandHref).replace(/\r?\n/g, "<br>");
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
      --surface: color-mix(in srgb, currentColor 4%, transparent);
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
    .theorem-view {
      border: 1px solid var(--border);
      border-radius: 6px;
      background: var(--surface);
      margin: 1.25em 0;
      padding: 16px;
    }
    .theorem-statement {
      margin: 0 0 1em;
    }
    .theorem-line {
      margin: 0;
    }
    .section-heading {
      align-items: center;
      display: flex;
      gap: 12px;
      justify-content: space-between;
      margin-bottom: 0.5em;
    }
    .section-heading strong {
      font-size: 1em;
    }
    .toggle-view {
      background: var(--vscode-button-secondaryBackground, transparent);
      border: 1px solid var(--border);
      border-radius: 4px;
      color: var(--vscode-button-secondaryForeground, currentColor);
      cursor: pointer;
      font: inherit;
      line-height: 1.2;
      padding: 3px 8px;
    }
    .toggle-view:hover {
      background: var(--vscode-button-secondaryHoverBackground, var(--surface));
    }
    .theorem-view pre {
      margin: 0;
      white-space: pre-wrap;
    }
    [data-mode="prose"] .lean-content,
    [data-mode="lean"] .prose-content {
      display: none;
    }
    .proof-section {
      border-top: 1px solid var(--border);
      padding-top: 0.9em;
    }
    .proof-section summary {
      cursor: pointer;
      list-style-position: outside;
      margin-bottom: 0.5em;
    }
    .proof-section summary::marker {
      color: var(--muted);
    }
    .proof-body {
      margin-left: 1.25em;
    }
    .unresolved {
      border-color: color-mix(in srgb, var(--danger) 45%, transparent);
      color: var(--vscode-errorForeground, var(--danger));
    }
    blockquote {
      border-left: 3px solid var(--border);
      color: var(--muted);
      margin-left: 0;
      padding-left: 1em;
    }
  </style>
</head>
<body>
${body}
<script>
  document.addEventListener("click", (event) => {
    const button = event.target.closest("[data-toggle-view]");
    if (!button) {
      return;
    }

    const section = button.closest("[data-mode]");
    if (!section) {
      return;
    }

    const nextMode = section.dataset.mode === "lean" ? "prose" : "lean";
    section.dataset.mode = nextMode;
    button.textContent = nextMode === "lean" ? "Prose" : "Lean";
    button.setAttribute("aria-pressed", String(nextMode === "lean"));
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

    if (line.startsWith("<div class=\"include\"") || line.startsWith("<section class=\"theorem-view\"")) {
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

function renderTheoremView(
  declaration: LeanDeclaration,
  target: string,
  commandHref: (target: string) => string
): string {
  const proseStatement =
    declaration.doc?.fields.statement ??
    `See the Lean statement for ${declaration.name}.`;
  const proseProof = declaration.doc?.fields["proof.sketch"] ?? "No prose proof sketch has been written yet.";
  const leanProof = declaration.leanProof ?? declaration.statement;

  return compactHtml(`
    <section class="theorem-view" data-target="${escapeHtml(target)}">
      <div class="theorem-statement" data-section="statement" data-mode="prose">
        <div class="section-heading">
          <p class="theorem-line"><strong>Theorem.</strong> <span class="prose-content">${renderInlineMarkdown(proseStatement, commandHref).replace(/\r?\n/g, "<br>")}</span></p>
          <button class="toggle-view" type="button" data-toggle-view="statement" aria-pressed="false">Lean</button>
        </div>
        <pre class="lean-content"><code>${escapeHtml(declaration.leanStatement)}</code></pre>
      </div>
      <details class="proof-section" open>
        <summary><strong>Proof.</strong></summary>
        <div class="proof-body" data-section="proof" data-mode="prose">
          <div class="section-heading">
            <div class="prose-content">${renderInlineMarkdown(proseProof, commandHref).replace(/\r?\n/g, "<br>")}</div>
            <button class="toggle-view" type="button" data-toggle-view="proof" aria-pressed="false">Lean</button>
          </div>
          <pre class="lean-content"><code>${escapeHtml(leanProof)}</code></pre>
        </div>
      </details>
    </section>
  `);
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
