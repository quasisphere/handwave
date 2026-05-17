# Handwave: Seed Design Note

Handwave is a working name for a system for explaining, browsing, and reusing formalized mathematics. The motivating idea is to make Lean libraries and mathematical exposition feel like one connected knowledge base: formal statements and proofs remain checkable, while human-readable descriptions, proof sketches, article narratives, and cross-links stay close enough to the code to remain useful and in sync.

## Goals

- Support readable explanations of formalized definitions, theorems, and proofs.
- Let articles refer to existing formal results without copying statements, proofs, or prose.
- Make prose links attach to natural phrases, not only visible theorem names.
- Keep ordinary Lean library files usable with standard Lean tooling.
- Make the codebase friendly to AI agents editing formal code and prose together.
- Provide an interactive VS Code experience for browsing, toggling, and jumping between formal and informal views.

## Basic Shape

Handwave should treat the project as a semantic graph of mathematical objects rather than only as a collection of files. The graph contains Lean declarations, expository blocks, article sections, prose descriptions, proof sketches, local claims, and links between them.

The first version can keep the formal library as ordinary Lean:

```text
Library files:
  Mathlib-style .lean files
  Optional structured documentation blocks near declarations

Article files:
  Literate Lean / Verso-like documents
  Expository prose
  Checked Lean snippets where useful
  Links and transclusions into library declarations or other articles
```

This split keeps the formal substrate stable while allowing articles to become rich mathematical hypertext.

## File Format Direction

The library side should probably remain valid Lean. For declarations that need local prose, use structured doc comments or attributes near the declaration:

```lean
/--
%%handwave
name:
  Addition associativity
statement:
  Addition of natural numbers is associative: $(a + b) + c = a + (b + c)$.
proof.sketch:
  This follows from the standard associativity theorem for natural addition.
-/
theorem my_add_assoc (a b c : Nat) :
    (a + b) + c = a + (b + c) := by
  exact Nat.add_assoc a b c
```

The article side can use a Verso-like syntax with extra Handwave commands:

```text
#import Mathlib.Data.Nat.Basic
#import Handwave.Article.NaturalNumbers

#section "Associativity"

The central observation is that
[parentheses do not matter for repeated addition](lean:Nat.add_assoc).

@include{lean:Nat.add_assoc}
```

When a `name` field is present, rendered declarations show it in the label,
such as **Theorem (Addition associativity).** or **Definition (Riemann surface).**
Without a `name`, the label remains **Theorem.** or **Definition.**
Rendered prose supports LaTeX math delimiters such as `$...$`, `\(...\)`,
`$$...$$`, and `\[...\]`.

The exact syntax is less important than the model:

- every reusable declaration-specific item is identified by its Lean name;
- inclusions are live references, not copies;
- links can target Lean declarations, local article blocks, or blocks in other articles;
- rendered text can hide formal names when the prose reads better without them.

## Links

Links should attach to prose spans:

```text
[reassociating the sum](lean:Nat.add_assoc)
[the cancellation argument](article:NaturalNumbers/Add#cancellation)
[the previous lemma](local:#triple_sum_assoc)
```

Target kinds may include:

- `lean:Nat.add_assoc`
- `lean:Nat.add_assoc.statement`
- `lean:Nat.add_assoc.proof.sketch`
- `article:NaturalNumbers/Add#associativity`
- `local:#triple_sum_assoc`
- `term:monoid`

The extension should provide validation, completion, hover previews, backlink discovery, and rename/update support where possible.

## Transclusion

Articles should be able to import theorem statements, proof sketches, explanations, examples, and other reusable blocks without copying:

```text
@include{lean:Nat.add_assoc}
@include{lean:Nat.add_assoc.statement}
@include{lean:Nat.add_assoc.proof.sketch}
```

Rendered articles show the resolved content inline, but source files keep only references. This should make summaries and survey articles easier to maintain as the formal library evolves.

Useful selectors may include:

```text
.statement
.lean.statement
.lean.proof
.proof.sketch
.examples
.dependencies(depth=1)
```

## AI Agent Friendliness

Handwave should be designed so an AI agent can edit formal code and matching explanations in one pass.

Helpful constraints:

- keep declaration-specific prose physically near the declaration when possible;
- use explicit stable ids;
- prefer simple, parseable markup over clever implicit conventions;
- make stale links and stale prose detectable by tooling;
- keep article references concrete after resolution, even if authoring commands allow fuzzy search;
- avoid workflows where an agent must discover many disconnected metadata files before making a local edit.

For formal library work, colocated structured doc blocks are likely better than a separate prose database. For expository writing, article files can remain separate but should transclude from the same indexed graph.

## VS Code Extension Ideas

The VS Code extension can provide two complementary experiences:

- ordinary Lean editor augmentation through decorations, hovers, CodeLens, document links, and go-to-definition;
- a custom rendered reading view for articles and documented declarations.

Potential features:

- toggle between Lean statement, prose explanation, and proof sketch;
- jump from a phrase link to a Lean declaration or article section;
- hover a linked phrase to preview the theorem statement;
- show all articles that cite a theorem;
- warn when a transcluded theorem statement changed since a prose block was last reviewed;
- edit short prose blocks in place from the rendered view;
- ask an AI agent to update prose after a Lean proof or statement changes.

The custom editor does not need to replace the standard Lean editor. Most editing can remain in Lean files, articles, and agent workflows. The custom view is primarily for reading, browsing, navigation, and lightweight edits.

## Open Questions

- Should Handwave be implemented as an extension of Verso, or as a separate layer that can emit/use Verso?
- How should declaration renames update prose and article links when Lean names are the stable ids?
- How should source maps work if article files contain checked Lean snippets or generated Lean?
- How much prose should live in library files versus article files?
- How should stale prose be detected: timestamps, hashes of theorem statements, elaborated signatures, or manual review markers?
- Can article-local claims be promoted into library declarations smoothly?
- What should the first prototype target: static HTML generation, VS Code browsing, or agent-friendly file format experiments?

## Prototype Bias

The safest first prototype is probably:

1. ordinary Lean files with optional `%%handwave` structured doc comments;
2. article files with phrase links and `@include` transclusion commands;
3. an indexer that resolves Lean names and article anchors;
4. a simple renderer that turns articles into HTML;
5. a VS Code extension that validates links and provides hover/jump support.

This lets Handwave begin as a lightweight explanatory layer over existing Lean projects while preserving a path toward richer literate Lean or Verso integration later.
