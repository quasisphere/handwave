# Handwave

Handwave is a VS Code extension for turning annotated Lean projects into
readable mathematical overviews. It indexes ordinary `.lean` files, reads
structured `%%handwave` documentation blocks placed next to declarations, and
renders those declarations together with `.hw.md` / `.hw` article files in an
interactive preview.

The goal is to make formalized mathematics easier to browse as mathematics:
the Lean declaration remains the source of truth, while nearby prose explains
the statement, proof idea, and role of the result. Handwave then connects those
annotated declarations into article-style narratives, dependency views,
backlinks, and Lean status badges.

_This version of Handwave is a **vibe-coded prototype** that could later on be replaced by a more robust version._

## Screenshots

![The Handwave theorem explorer showing a dependency tree and theorem details.](screenshots/browser.png)

*The theorem explorer shows a dependency tree and details about a chosen theorem.*

![A Handwave summary article in which every theorem has a green checkmark.](screenshots/preview1.png)

*A summary article rendered by Handwave. Handwave has checked that Lean seems happy, so all theorems have a green checkmark.*

![A Handwave summary article with yellow checkmarks and a dependency tree leading to a sorry.](screenshots/preview2.png)

*This time there are some yellow checkmarks. Hovering over one of the theorems opens a dependency tree showing the path to a sorry (red cross).*

## What Handwave Provides

- An index of Lean declarations, Handwave articles, links, includes, and
  backlinks.
- Rendered previews for annotated Lean files and Handwave article files.
- Human-readable theorem, lemma, definition, and proof views generated from
  Lean declarations plus `%%handwave` prose.
- Article links such as `[the theorem](lean:My.result)` and transclusions such
  as `@include{lean:My.result}`.
- Lean status badges showing whether a theorem is checked, pending, stale,
  blocked, locally unchecked, or checked only modulo incomplete dependencies.
- A dependency popover for theorem badges.
- Diagnostics for malformed Handwave doc blocks and unresolved article links.
- Code lenses on cited Lean declarations showing Handwave citation counts.

Handwave is deliberately lightweight. Lean files remain Lean files, article
files remain Markdown-like text files, and the preview is a read-only view over
the indexed project.

## Annotating Lean Files

Put a structured `%%handwave` block in a Lean doc comment immediately before a
declaration:

```lean
/--
%%handwave
name:
  Addition associativity
statement:
  Addition of natural numbers is associative: $(a + b) + c = a + (b + c)$.
proof:
  This follows from the standard associativity theorem for natural addition.
tags:
  milestone
-/
theorem my_add_assoc (a b c : Nat) :
    (a + b) + c = a + (b + c) := by
  exact Nat.add_assoc a b c
```

Common fields:

- `name`: optional display name used in rendered labels.
- `statement`: mathematical prose for the declaration statement.
- `proof`: mathematical prose for the proof sketch.
- `tags`: comma- or whitespace-separated metadata tags.

Handwave also stores the Lean statement and Lean proof, so previews can toggle
between prose and source views where appropriate.

The special `milestone` tag marks an important theorem in the preview. Hover a
theorem label to open its source popup; a filled or empty star appears before
the text/Lean view toggle buttons. Click the star to toggle the `milestone` tag
in the source block.

The special `shadow` tag excludes a theorem or lemma from Handwave's index.
This is useful for challenge or comparison files that intentionally repeat a
declaration name without replacing the project theorem in previews and status
checks.

## Writing Handwave Articles

Handwave article files use the extensions `.hw.md` or `.hw`. They support
headings, Markdown-style links, and include commands:

```markdown
# Associativity

The central observation is that
[parentheses do not matter for repeated addition](lean:my_add_assoc).

@include{lean:my_add_assoc}
```

Including a theorem or lemma renders the full theorem view, including its proof
section when proof prose is available. Use proof selectors only when you want
to include just the proof sketch or source.

Rendered prose follows LaTeX's text-dash convention: `--` becomes an en dash
and `---` becomes an em dash. Math, inline and fenced code, Lean source, URLs,
and link destinations retain their literal hyphens.

Handwave's MathJax configuration also defines `\fint` as a stroked version of
MathJax's native integral glyph, including support for ordinary integral limits.

Useful target forms:

- `lean:My.result`: link to or include a Lean declaration.
- `lean:My.result.statement`: include the prose statement.
- `lean:My.result.proof`: include only the prose proof sketch.
- `lean:My.result.lean.statement`: include the Lean statement source.
- `lean:My.result.lean.proof`: include only the Lean proof source.
- `article:path/to/article#section`: link to an article section.
- `local:#section`: link to a section in the current article.
- `term:...`: mark ordinary mathematical terminology without requiring a
  Handwave target.

## Lean Status Badges

For theorem-like declarations, Handwave combines direct source checks with
optional Lean dependency probes.

Badge meanings:

- Green check: Lean dependency checks found no transitive dependency on
  `sorryAx`.
- Yellow check: the declaration checks, but a transitive dependency still uses
  `sorryAx`.
- Red cross: the declaration is locally unchecked, for example because it has a
  direct `sorry` / `admit`. The experimental Lean-server backend also reports
  overlapping Lean errors this way.
- `...`: status is pending.
- `?`: Handwave attempted a dependency check but could not determine the
  result.
- `!`: the dependency check is blocked, for example because a file cannot be
  probed as a Lean module under the workspace root.
- Parenthesized badges: the displayed status is stale and predates the current
  Lean source or build state.

When dependency checks are enabled, the default `subprocess` backend uses
Lean's own build artifacts. Handwave reads resolved source references and
declaration ranges from `.ilean`, asks Lake to build the required `.olean` and
`.ilean` module facets on demand, and runs one toolchain-matched extractor with
`lake env lean --stdin`. The extractor reads transitive axiom sets and filtered
proof dependencies from `.olean`; its results are cached under
`.lake/handwave/` using the module `.trace` contents as the validity key. A
current cache therefore requires no Lean process when the extension restarts.
The backend does not open hidden Lean documents or start the Lean language
server. Dirty editor buffers and unsupported artifact layouts retain the
source-prefix / `#print axioms` compatibility fallback.

Automatic builds and extraction only run in trusted VS Code workspaces. Source
browsing, article rendering, and direct `sorry` detection remain available in
Restricted Mode.

The explicit experimental `leanServer` backend instead writes a generated probe
under `.lake/handwave/` and reads its informational diagnostics from the Lean
language server. The check queue is priority-based and drains pending or stale
items until there is nothing runnable left.

When dependency checks are disabled, Handwave does not launch Lean in the
background and only reports proof incompleteness that it can detect directly in
source text.

## Installation

### Run From Source

Requirements:

- VS Code 1.90 or newer.
- Node.js and npm.
- Lean and Lake, if you want dependency status checks for Lean declarations.

Steps:

```sh
npm install
npm run compile
```

Open this folder in VS Code and launch an Extension Development Host. In the
development host, open a Lean workspace containing `.lean`, `.hw.md`, or `.hw`
files and run `Handwave: Open Preview`.

### Install as a VSIX

If you use `vsce`, package the extension:

```sh
npx @vscode/vsce package
```

Then install the generated `.vsix` either through VS Code's
`Extensions: Install from VSIX...` command or with:

```sh
code --install-extension handwave-0.0.1.vsix
```

After installation, reload VS Code and open a Lean project.

## Accessing Features in VS Code

Command palette commands:

- `Handwave: Open Preview`: open a rendered preview for the active `.lean`,
  `.hw.md`, or `.hw` file, or pick one from the workspace.
- `Handwave: Rebuild Index`: rescan Lean and Handwave article files.
- `Handwave: Refresh Lean Status`: mark known Lean dependency results stale and
  schedule fresh checks for open previews.
- `Handwave: Show Backlinks`: show articles and includes that cite a target.

Editor UI:

- When viewing `.lean`, `.hw.md`, or `.hw` files, use the Handwave editor-title
  button to open the preview for the current file.
- In Handwave preview tabs, use the back and forward buttons to navigate
  preview history.
- Click declaration labels, dependency tree entries, and article links to
  navigate within the preview.
- Use the source links in declaration popovers to jump back to the Lean source.
- Use the Handwave Activity Bar icon to open the theorem explorer. It defaults
  to milestone-tagged theorems, supports module or theorem search, filters by
  green, yellow, red, or unknown theorem status, and shows a selected theorem
  preview below the dependency graph.

Lean editor features:

- Cited Lean declarations receive a code lens showing their Handwave citation
  count.
- Hovering declaration names shows the Lean statement and any Handwave prose
  attached to the declaration.

Article editor features:

- Handwave links are clickable and open preview targets.
- Hovering links shows the resolved target preview.
- Unresolved links and malformed include targets are reported as diagnostics
  when diagnostics are enabled.

## Configuration

Settings are under the `handwave` namespace:

- `handwave.articleGlobs`: article files to index. Defaults to
  `**/*.hw.md` and `**/*.hw`.
- `handwave.leanGlobs`: Lean files to index. Defaults to `**/*.lean`.
- `handwave.excludeGlob`: files excluded from indexing. Defaults to
  `**/{node_modules,out,.git,.jj,.lake}/**`.
- `handwave.enableDiagnostics`: enable diagnostics for malformed Handwave
  syntax and unresolved targets.
- `handwave.enableLeanDependencyChecks`: enable artifact extraction and the
  source-probe fallback for theorem dependency status. Checks run in preview
  priority order and batch compatible declarations. When disabled,
  Handwave performs source-only checks and does not launch Lean in the
  background.
- `handwave.leanDependencyCheckBackend`: choose `subprocess` or `leanServer` for
  dependency checks. The default is `subprocess`, which runs optimized
  `lake env lean` probes without opening hidden Lean documents. `leanServer`
  remains available as an explicit experimental backend.
- `handwave.leanDependencyCheckDelayMs`: debounce before running dependency
  checks.
- `handwave.autoBuildLeanArtifacts`: automatically run a targeted `lake build`
  when a demanded module needs fresh `.olean` and `.ilean` artifacts. Enabled
  by default and ignored in untrusted workspaces.
- `handwave.leanArtifactBuildTimeoutMs`: timeout for an automatic Lake build.
- `handwave.leanDependencyCheckTimeoutMs`: timeout for each Lean probe.
- `handwave.leanDependencyCheckBatchSize`: maximum compatible declarations
  extracted in one Lean process. The default is 1024 to keep generated Lean
  probes within the elaborator's recursion limit.

## Development

```sh
npm install
npm run compile
npm test
```

The tests compile the TypeScript sources and run the parser/renderer test suite
with Node's built-in test runner.

### Source boundaries

Handwave keeps its shared indexing and rendering code separate from host
integration:

- `src/handwave/` contains the host-neutral project model, parsers, index,
  artifact readers, preview renderer, and theorem-explorer payload builder.
- `src/web/` contains the browser application rendered into a webview. It does
  not load the VS Code API at runtime.
- `src/vscode/` contains the adapters that connect browser messages and shared
  Handwave data to VS Code.
- `src/extension.ts` is the VS Code composition root.

This boundary allows another read-only host, such as a static-site exporter, to
reuse the same payload builder and browser application without depending on
the VS Code adapter.

### Static theorem explorer

An initial static exporter builds the theorem explorer, all theorem preview
fragments, and all Handwave article fragments into one HTML file:

```sh
npm run export-site -- \
  --root /path/to/lean/workspace \
  --output /path/to/site/index.html
```

If `--root` is omitted, it defaults to the current directory. If `--output` is
omitted, the exporter writes `handwave-site/index.html` below the selected
root. The exported data uses repository-relative paths and needs no VS Code
process, AJAX request, or server-side computation at runtime.

This first static slice provides theorem search, milestone and theorem-status
filtering, dependency graphs, backlinks, preloaded theorem/proof previews, and in-place
Handwave article reading. Article links, theorem links, includes, and local
anchors navigate without network requests. Its front-page Overview lists all
articles, theorem modules, and milestone theorems in three columns, with each
entry opening the corresponding reader or explorer view. Its top bar provides
unified article/module/theorem search, a menu for switching between the
article reader and theorem explorer, MathJax-rendered search results and selected
values, a persisted light/dark theme control, and browser Back/Forward history
for article, theorem-to-theorem, and theorem-explorer navigation. Article and selected-theorem views
also receive reloadable hash URLs. The article reader has a permanently visible,
nested table of contents whose sections can be folded and used as scroll targets.
The article title heads the contents tree, and the active entry follows the reader's
scroll position without adding history entries.
Theorem-explorer previews provide the same
hover text/Lean switches for theorem statements and proofs as article includes.
Search text remains plain while it is being edited. At export time it uses fresh
`.ilean` metadata and valid Handwave artifact-cache entries when available.
Remaining badges are inferred from the source snapshot by propagating direct
`sorry` and `admit` uses through indexed dependencies; a source-inferred green
badge is therefore not a substitute for rebuilding Lean artifacts.
