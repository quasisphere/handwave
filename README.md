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
-/
theorem my_add_assoc (a b c : Nat) :
    (a + b) + c = a + (b + c) := by
  exact Nat.add_assoc a b c
```

Common fields:

- `name`: optional display name used in rendered labels.
- `statement`: mathematical prose for the declaration statement.
- `proof`: mathematical prose for the proof sketch.

Handwave also stores the Lean statement and Lean proof, so previews can toggle
between prose and source views where appropriate.

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

For theorem-like declarations, Handwave combines local Lean diagnostics with
optional dependency checks.

Badge meanings:

- Green check: Lean dependency checks found no transitive dependency on
  `sorryAx`.
- Yellow check: the declaration checks, but a transitive dependency still uses
  `sorryAx`.
- Red cross: the declaration is locally unchecked, for example because it has a
  direct `sorry` / `admit` or overlapping Lean errors.
- `...`: status is pending.
- `?`: Handwave attempted a dependency check but could not determine the
  result.
- `!`: the dependency check is blocked, for example by file-wide Lean errors or
  by a file that cannot be probed as a Lean module under the workspace root.
- Parenthesized badges: the displayed status is stale and predates the current
  Lean source or build state.

When dependency checks are enabled, Handwave runs Lean probes with
`lake env lean --stdin` and `#print axioms` for declarations demanded by open
previews. The check queue is priority-based and drains pending or stale items
until there is nothing runnable left.

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
- `handwave.enableLeanDependencyChecks`: enable `#print axioms` probes for
  theorem dependency status.
- `handwave.leanDependencyCheckDelayMs`: debounce before running dependency
  checks.
- `handwave.leanDependencyCheckTimeoutMs`: timeout for each Lean probe process.
- `handwave.leanDependencyCheckBatchSize`: maximum declarations checked in one
  Lean probe process.

## Development

```sh
npm install
npm run compile
npm test
```

The tests compile the TypeScript sources and run the parser/renderer test suite
with Node's built-in test runner.
