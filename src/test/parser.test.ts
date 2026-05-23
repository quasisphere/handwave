import * as assert from "node:assert/strict";
import { test } from "node:test";
import { HandwaveIndex } from "../handwave/index";
import { parseArticleDocument, parseLeanDocument, parseTarget, slugify } from "../handwave/parser";
import { collectDiagnostics } from "../handwave/diagnostics";
import { renderArticleHtml, renderLeanDocumentHtml } from "../handwave/renderer";

const leanText = `/--
%%handwave
name:
  Addition associativity
statement:
  Addition of natural numbers is associative: $(a + b) + c = a + (b + c)$.
proof:
  Use the standard associativity theorem.
-/
theorem my_add_assoc (a b c : Nat) :
    (a + b) + c = a + (b + c) := by
  exact Nat.add_assoc a b c

/--
%%handwave
name:
  Double
statement:
  Doubling a natural number means adding it to itself: $\\operatorname{double}(n) = n + n$.
-/
def double (n : Nat) : Nat := n + n
`;

const articleText = `# Associativity

The central observation is that
[parentheses do not matter](lean:my_add_assoc).

@include{lean:my_add_assoc}
@include{lean:my_add_assoc.proof}

[broken](lean:Missing.add_assoc)
`;

const unnamedLeanText = `/--
%%handwave
statement:
  Multiplication by one leaves a natural number unchanged.
proof:
  Use the identity law for multiplication.
-/
theorem mul_one_right (n : Nat) : n * 1 = n := by
  exact Nat.mul_one n

/--
%%handwave
statement:
  The successor alias returns the next natural number.
-/
def nextNat (n : Nat) : Nat := n + 1
`;

const proofStatusLeanText = `/--
%%handwave
statement:
  This theorem is complete.
-/
theorem checked_theorem : True := by
  trivial

/--
%%handwave
statement:
  This theorem is not complete.
-/
theorem unchecked_theorem : True := by
  sorry

/--
%%handwave
statement:
  This theorem depends on an incomplete theorem.
-/
theorem depends_on_unchecked : True := by
  exact unchecked_theorem
`;

function leanStatus(
  checked: boolean,
  reason: string,
  dependencies: string[] = [],
  failedDependencies: string[] = []
) {
  return {
    checked,
    ownChecked: failedDependencies.length === 0 ? checked : true,
    dependencies,
    failedDependencies,
    reason
  };
}

test("parses Handwave Lean doc comments and declarations", () => {
  const declarations = parseLeanDocument(leanText, "/workspace/Nat.lean");

  assert.equal(declarations.length, 2);
  assert.equal(declarations[0].name, "my_add_assoc");
  assert.equal(declarations[0].doc?.fields.name, "Addition associativity");
  assert.equal(
    declarations[0].doc?.fields.statement,
    "Addition of natural numbers is associative: $(a + b) + c = a + (b + c)$."
  );
  assert.match(declarations[0].statement, /^theorem my_add_assoc/);
  assert.match(declarations[0].leanStatement, /^theorem my_add_assoc/);
  assert.equal(declarations[0].leanProof, "by\n  exact Nat.add_assoc a b c");
});

test("parses namespace-qualified Lean declaration names", () => {
  const declarations = parseLeanDocument(`namespace RelWP

namespace HyperbolicMetric

/--
%%handwave
statement:
  A named theorem in a nested namespace.
-/
theorem sample_theorem : True := by
  trivial

end HyperbolicMetric

end RelWP
`, "/workspace/Namespaced.lean");

  assert.equal(declarations[0].name, "RelWP.HyperbolicMetric.sample_theorem");
});

test("does not parse Lean declarations from comments or strings", () => {
  const declarations = parseLeanDocument(`namespace RelWP

/--
A prose theorem where nothing Lean is being declared.
-/
def real_declaration : Nat := 0

def phrase : String := "lemma imaginary : True := by trivial"

end RelWP
`, "/workspace/Comments.lean");

  assert.deepEqual(declarations.map((declaration) => declaration.name), [
    "RelWP.real_declaration",
    "RelWP.phrase"
  ]);
});

test("parses Handwave definitions", () => {
  const declarations = parseLeanDocument(leanText, "/workspace/Nat.lean");
  const definition = declarations.find((declaration) => declaration.name === "double");

  assert.equal(definition?.kind, "def");
  assert.equal(definition?.doc?.fields.name, "Double");
  assert.equal(definition?.doc?.fields.statement, "Doubling a natural number means adding it to itself: $\\operatorname{double}(n) = n + n$.");
  assert.equal(definition?.leanStatement, "def double (n : Nat) : Nat");
  assert.equal(definition?.leanProof, "n + n");
});

test("parses article headings, links, and includes", () => {
  const article = parseArticleDocument(articleText, "/workspace/natural-numbers.hw.md");

  assert.equal(article.anchors[0].id, "associativity");
  assert.equal(article.links.length, 2);
  assert.equal(article.links[0].target, "lean:my_add_assoc");
  assert.equal(article.includes.length, 2);
  assert.equal(article.includes[0].target, "lean:my_add_assoc");
  assert.equal(article.includes[1].target, "lean:my_add_assoc.proof");
});

test("parses targets and selectors", () => {
  assert.deepEqual(parseTarget("lean:my_add_assoc.statement"), {
    raw: "lean:my_add_assoc.statement",
    kind: "lean",
    body: "my_add_assoc.statement",
    base: "my_add_assoc",
    selector: "statement"
  });

  assert.deepEqual(parseTarget("local:#triple_sum_assoc"), {
    raw: "local:#triple_sum_assoc",
    kind: "local",
    body: "#triple_sum_assoc",
    base: "#triple_sum_assoc",
    anchor: "triple_sum_assoc"
  });
});

test("resolves Lean selectors, article targets, and local targets", () => {
  const declarations = parseLeanDocument(leanText, "/workspace/Nat.lean");
  const article = parseArticleDocument(articleText, "/workspace/natural-numbers.hw.md");
  const index = new HandwaveIndex("/workspace", declarations, [article]);

  assert.equal(index.resolve("lean:my_add_assoc")?.title, "my_add_assoc");
  assert.equal(
    index.resolve("lean:my_add_assoc.proof")?.preview,
    "Use the standard associativity theorem."
  );
  assert.equal(
    index.resolve("lean:my_add_assoc.statement")?.preview,
    "Addition of natural numbers is associative: $(a + b) + c = a + (b + c)$."
  );
  assert.match(index.resolve("lean:my_add_assoc.lean.statement")?.preview ?? "", /^theorem my_add_assoc/);
  assert.equal(index.resolve("lean:my_add_assoc.lean.proof")?.preview, "by\n  exact Nat.add_assoc a b c");
  assert.equal(index.resolve("article:natural-numbers#associativity")?.title, "Associativity");
  assert.equal(index.resolve("local:#associativity", "/workspace/natural-numbers.hw.md")?.title, "Associativity");
});

test("resolves article keys relative to any workspace folder", () => {
  const article = parseArticleDocument("# Hyperbolic Metrics", "/workspace/relativewp/handwave/hyperbolic.hw.md");
  const index = new HandwaveIndex(["/workspace/relativewp", "/workspace/relativewp/handwave"], [], [article]);

  assert.equal(index.resolve("article:handwave/hyperbolic")?.title, "Hyperbolic Metrics");
  assert.equal(index.resolve("article:hyperbolic")?.title, "Hyperbolic Metrics");
});

test("reports unresolved links but leaves term links alone", () => {
  const declarations = parseLeanDocument(leanText, "/workspace/Nat.lean");
  const article = parseArticleDocument(`${articleText}\n[monoid](term:monoid)\n`, "/workspace/natural-numbers.hw.md");
  const index = new HandwaveIndex("/workspace", declarations, [article]);
  const diagnostics = collectDiagnostics(index, declarations, [article]);

  assert.equal(diagnostics.some((issue) => issue.message.includes("Missing.add_assoc")), true);
  assert.equal(diagnostics.some((issue) => issue.message.includes("term:monoid")), false);
});

test("slugifies section titles", () => {
  assert.equal(slugify("Repeated Addition!"), "repeated-addition");
});

test("renders Lean statement includes as theorem views", () => {
  const declarations = parseLeanDocument(leanText, "/workspace/Nat.lean");
  const article = parseArticleDocument(articleText, "/workspace/natural-numbers.hw.md");
  const index = new HandwaveIndex("/workspace", declarations, [article], new Map([
    ["my_add_assoc", leanStatus(true, "Lean LSP diagnostics report no errors.")]
  ]));
  const html = renderArticleHtml(articleText, "/workspace/natural-numbers.hw.md", index, (target) => `command:${target}`);

  assert.match(html, /<a href="command:lean:my_add_assoc" data-handwave-target="lean:my_add_assoc" title="lean:my_add_assoc">parentheses do not matter<\/a>/);
  assert.match(html, /<strong><a class="declaration-link" href="command:lean:my_add_assoc" data-handwave-target="lean:my_add_assoc" title="Open lean:my_add_assoc">Theorem \(Addition associativity\)\.<\/a><\/strong>/);
  assert.match(html, /class="check-status check-status-checked"[^>]*aria-label="Lean checked">✓<\/span><span class="declaration-label"><strong><a class="declaration-link" href="command:lean:my_add_assoc" data-handwave-target="lean:my_add_assoc" title="Open lean:my_add_assoc">Theorem \(Addition associativity\)\.<\/a><\/strong>/);
  assert.match(html, /class="source-popover"><span class="source-popover-row"><span class="view-switch" role="group" aria-label="Theorem view".*<span class="source-popover-separator">\|<\/span><a href="command:lean:my_add_assoc" data-handwave-target="lean:my_add_assoc" title="Open lean:my_add_assoc">lean:my_add_assoc<\/a><button class="copy-control" type="button" data-copy-target="lean:my_add_assoc" title="Copy lean:my_add_assoc" aria-label="Copy lean:my_add_assoc"><span class="copy-icon" aria-hidden="true"><\/span><span class="sr-only">Copy<\/span><\/button>/);
  assert.match(html, /<div class="proof-line"><button class="collapse-control" type="button" data-toggle-collapsed="proof" aria-expanded="true" aria-label="Collapse proof">▾<\/button><span class="declaration-label"><strong>Proof\.<\/strong>.*<div class="proof-content">/);
  assert.match(html, /Use the standard associativity theorem\.<span class="qed" aria-label="QED">□<\/span>/);
  assert.match(html, /aria-label="Theorem view"/);
  assert.match(html, /aria-label="Proof view"/);
  assert.match(html, /data-set-mode="text"/);
  assert.match(html, /data-set-mode="lean"/);
  assert.doesNotMatch(html, /data-set-mode="prose"/);
  assert.doesNotMatch(html, /data-set-mode="collapsed"/);
  assert.match(html, /Addition of natural numbers is associative: \$\(a \+ b\) \+ c = a \+ \(b \+ c\)\$\./);
  assert.match(html, /Use the standard associativity theorem\./);
  assert.match(html, /class="lean-source"/);
  assert.match(html, /<span class="lean-keyword">exact<\/span> <span class="lean-constant">Nat<\/span>\.add_assoc a b c/);
  assert.match(html, /<span class="lean-keyword">by<\/span>&#10;  <span class="lean-keyword">exact<\/span>/);
});

test("renders theorem check status supplied by Lean diagnostics", () => {
  const declarations = parseLeanDocument(proofStatusLeanText, "/workspace/ProofStatus.lean");
  const articleText = [
    "@include{lean:checked_theorem}",
    "@include{lean:unchecked_theorem}",
    "@include{lean:depends_on_unchecked}"
  ].join("\n\n");
  const article = parseArticleDocument(articleText, "/workspace/proof-status.hw.md");
  const index = new HandwaveIndex("/workspace", declarations, [article], new Map([
    ["checked_theorem", leanStatus(true, "Lean LSP diagnostics report no errors.")],
    ["unchecked_theorem", leanStatus(false, "declaration uses 'sorry'")],
    [
      "depends_on_unchecked",
      leanStatus(
        false,
        "Unchecked dependencies: unchecked_theorem.",
        ["unchecked_theorem"],
        ["unchecked_theorem"]
      )
    ]
  ]));
  const html = renderArticleHtml(articleText, "/workspace/proof-status.hw.md", index, (target) => `command:${target}`);

  assert.equal(index.checkStatusForLean("checked_theorem")?.checked, true);
  assert.equal(index.checkStatusForLean("unchecked_theorem")?.checked, false);
  assert.equal(index.checkStatusForLean("depends_on_unchecked")?.checked, false);
  assert.deepEqual(index.checkStatusForLean("depends_on_unchecked")?.failedDependencies, ["unchecked_theorem"]);
  assert.match(html, /aria-label="Lean checked">✓<\/span><span class="declaration-label"><strong><a class="declaration-link"[^>]*>Theorem\.<\/a><\/strong>/);
  assert.match(html, /title="declaration uses 'sorry'" aria-label="Lean unchecked">✗<\/span><span class="declaration-label"><strong><a class="declaration-link"[^>]*>Theorem\.<\/a><\/strong>/);
  assert.match(html, /title="Unchecked dependencies: unchecked_theorem\." aria-label="Lean checked with unchecked dependencies">✓<\/span><span class="declaration-label"><strong><a class="declaration-link"[^>]*>Theorem\.<\/a><\/strong>/);
});

test("renders pending theorem status while Lean status is unavailable", () => {
  const declarations = parseLeanDocument(unnamedLeanText, "/workspace/Unnamed.lean");
  const articleText = "@include{lean:mul_one_right}";
  const article = parseArticleDocument(articleText, "/workspace/unnamed.hw.md");
  const index = new HandwaveIndex("/workspace", declarations, [article]);
  const html = renderArticleHtml(articleText, "/workspace/unnamed.hw.md", index, (target) => `command:${target}`);

  assert.match(html, /class="check-status check-status-pending"[^>]*aria-label="Lean status pending">…<\/span><span class="declaration-label"><strong><a class="declaration-link"[^>]*>Theorem\.<\/a><\/strong>/);
});

test("renders unresolved includes as loading while the index is warming up", () => {
  const index = new HandwaveIndex("/workspace", [], []);
  const html = renderArticleHtml(
    "@include{lean:my_add_assoc}",
    "/workspace/natural-numbers.hw.md",
    index,
    (target) => `command:${target}`,
    { indexing: true }
  );

  assert.match(html, /class="include include-pending"/);
  assert.match(html, /Loading include: <code>lean:my_add_assoc<\/code>/);
  assert.doesNotMatch(html, /Unresolved include/);
});

test("renders explicit Lean statement selectors as plain includes", () => {
  const declarations = parseLeanDocument(leanText, "/workspace/Nat.lean");
  const article = parseArticleDocument("@include{lean:my_add_assoc.lean.statement}", "/workspace/natural-numbers.hw.md");
  const index = new HandwaveIndex("/workspace", declarations, [article]);
  const html = renderArticleHtml("@include{lean:my_add_assoc.lean.statement}", "/workspace/natural-numbers.hw.md", index, (target) => `command:${target}`);

  assert.doesNotMatch(html, /class="theorem-view"/);
  assert.match(html, /<div class="include"/);
});

test("renders definition includes as definition views", () => {
  const declarations = parseLeanDocument(leanText, "/workspace/Nat.lean");
  const article = parseArticleDocument("@include{lean:double}", "/workspace/natural-numbers.hw.md");
  const index = new HandwaveIndex("/workspace", declarations, [article]);
  const html = renderArticleHtml("@include{lean:double}", "/workspace/natural-numbers.hw.md", index, (target) => `command:${target}`);

  assert.match(html, /class="definition-view"/);
  assert.match(html, /<strong><a class="declaration-link" href="command:lean:double" data-handwave-target="lean:double" title="Open lean:double">Definition \(Double\)\.<\/a><\/strong>/);
  assert.match(html, /class="source-popover"><span class="source-popover-row"><span class="view-switch" role="group" aria-label="Definition view".*<span class="source-popover-separator">\|<\/span><a href="command:lean:double" data-handwave-target="lean:double" title="Open lean:double">lean:double<\/a><button class="copy-control" type="button" data-copy-target="lean:double" title="Copy lean:double" aria-label="Copy lean:double"><span class="copy-icon" aria-hidden="true"><\/span><span class="sr-only">Copy<\/span><\/button>/);
  assert.match(html, /aria-label="Definition view"/);
  assert.match(html, /Doubling a natural number means adding it to itself: \$\\operatorname\{double\}\(n\) = n \+ n\$\./);
  assert.match(html, /<span class="lean-keyword">def<\/span> double \(n : <span class="lean-constant">Nat<\/span>\) : <span class="lean-constant">Nat<\/span> <span class="lean-operator">:=<\/span> n \+ n/);
  assert.doesNotMatch(html, /<div class="proof-line">/);
});

test("folds prose line breaks but preserves paragraph breaks", () => {
  const declarations = parseLeanDocument(`/--
%%handwave
name:
  Folded prose
statement:
  A hyperbolic metric is
  everywhere curved.

  This is a second paragraph.
-/
def foldedProse : Nat := 0
`, "/workspace/Folded.lean");
  const index = new HandwaveIndex("/workspace", declarations, []);
  const html = renderArticleHtml("@include{lean:foldedProse}", "/workspace/folded.hw.md", index, (target) => `command:${target}`);

  assert.match(html, /A hyperbolic metric is everywhere curved\./);
  assert.doesNotMatch(html, /is<br>everywhere/);
  assert.match(html, /<p class="prose-paragraph prose-content">This is a second paragraph\.<\/p>/);
});

test("enables MathJax for LaTeX formulas in rendered articles", () => {
  const declarations = parseLeanDocument(leanText, "/workspace/Nat.lean");
  const article = parseArticleDocument("Inline math $x^2 + y^2 = z^2$.", "/workspace/math.hw.md");
  const index = new HandwaveIndex("/workspace", declarations, [article]);
  const html = renderArticleHtml("Inline math $x^2 + y^2 = z^2$.", "/workspace/math.hw.md", index, (target) => `command:${target}`);

  assert.match(html, /window\.MathJax/);
  assert.match(html, /tex-chtml\.js/);
  assert.match(html, /\$x\^2 \+ y\^2 = z\^2\$/);
});

test("renders unnamed theorem and definition labels plainly", () => {
  const declarations = parseLeanDocument(unnamedLeanText, "/workspace/Unnamed.lean");
  const articleText = "@include{lean:mul_one_right}\n\n@include{lean:nextNat}";
  const article = parseArticleDocument(articleText, "/workspace/unnamed.hw.md");
  const index = new HandwaveIndex("/workspace", declarations, [article]);
  const html = renderArticleHtml(articleText, "/workspace/unnamed.hw.md", index, (target) => `command:${target}`);

  assert.match(html, /<strong><a class="declaration-link"[^>]*>Theorem\.<\/a><\/strong>/);
  assert.match(html, /<strong><a class="declaration-link"[^>]*>Definition\.<\/a><\/strong>/);
  assert.doesNotMatch(html, /Theorem \(/);
  assert.doesNotMatch(html, /Definition \(/);
});

test("renders Lean files as navigable declaration previews", () => {
  const declarations = parseLeanDocument(leanText, "/workspace/Nat.lean");
  const index = new HandwaveIndex("/workspace", declarations, []);
  const html = renderLeanDocumentHtml(
    leanText,
    "/workspace/Nat.lean",
    index,
    (target) => `command:${target}`,
    { focusId: "lean-my_add_assoc" }
  );

  assert.match(html, /<h1>Nat\.lean<\/h1>/);
  assert.match(html, /<main id="handwave-content">/);
  assert.match(html, /class="lean-file-path">\/workspace\/Nat\.lean<\/p>/);
  assert.match(html, /<section class="theorem-view" id="lean-my_add_assoc" data-target="lean:my_add_assoc">/);
  assert.match(html, /<section class="definition-view" id="lean-double" data-target="lean:double">/);
  assert.match(html, /focusHandwaveTarget\("lean-my_add_assoc"\)/);
  assert.match(html, /message\.type !== "replaceContent"/);
});
