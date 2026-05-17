import * as assert from "node:assert/strict";
import { test } from "node:test";
import { HandwaveIndex } from "../handwave/index";
import { parseArticleDocument, parseLeanDocument, parseTarget, slugify } from "../handwave/parser";
import { collectDiagnostics } from "../handwave/diagnostics";
import { renderArticleHtml } from "../handwave/renderer";

const leanText = `/--
%%handwave
name:
  Addition associativity
statement:
  Addition of natural numbers is associative.
proof.sketch:
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
  Doubling a natural number means adding it to itself.
-/
def double (n : Nat) : Nat := n + n
`;

const articleText = `# Associativity

The central observation is that
[parentheses do not matter](lean:my_add_assoc).

@include{lean:my_add_assoc}
@include{lean:my_add_assoc.proof.sketch}

[broken](lean:Missing.add_assoc)
`;

const unnamedLeanText = `/--
%%handwave
statement:
  Multiplication by one leaves a natural number unchanged.
proof.sketch:
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

test("parses Handwave Lean doc comments and declarations", () => {
  const declarations = parseLeanDocument(leanText, "/workspace/Nat.lean");

  assert.equal(declarations.length, 2);
  assert.equal(declarations[0].name, "my_add_assoc");
  assert.equal(declarations[0].doc?.fields.name, "Addition associativity");
  assert.equal(
    declarations[0].doc?.fields.statement,
    "Addition of natural numbers is associative."
  );
  assert.match(declarations[0].statement, /^theorem my_add_assoc/);
  assert.match(declarations[0].leanStatement, /^theorem my_add_assoc/);
  assert.equal(declarations[0].leanProof, "by\n  exact Nat.add_assoc a b c");
});

test("parses Handwave definitions", () => {
  const declarations = parseLeanDocument(leanText, "/workspace/Nat.lean");
  const definition = declarations.find((declaration) => declaration.name === "double");

  assert.equal(definition?.kind, "def");
  assert.equal(definition?.doc?.fields.name, "Double");
  assert.equal(definition?.doc?.fields.statement, "Doubling a natural number means adding it to itself.");
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
  assert.equal(article.includes[1].target, "lean:my_add_assoc.proof.sketch");
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
    index.resolve("lean:my_add_assoc.proof.sketch")?.preview,
    "Use the standard associativity theorem."
  );
  assert.equal(
    index.resolve("lean:my_add_assoc.statement")?.preview,
    "Addition of natural numbers is associative."
  );
  assert.match(index.resolve("lean:my_add_assoc.lean.statement")?.preview ?? "", /^theorem my_add_assoc/);
  assert.equal(index.resolve("lean:my_add_assoc.lean.proof")?.preview, "by\n  exact Nat.add_assoc a b c");
  assert.equal(index.resolve("article:natural-numbers#associativity")?.title, "Associativity");
  assert.equal(index.resolve("local:#associativity", "/workspace/natural-numbers.hw.md")?.title, "Associativity");
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
  const index = new HandwaveIndex("/workspace", declarations, [article]);
  const html = renderArticleHtml(articleText, "/workspace/natural-numbers.hw.md", index, (target) => `command:${target}`);

  assert.match(html, /<strong>Theorem \(Addition associativity\)\.<\/strong>/);
  assert.match(html, /<summary><strong>Proof\.<\/strong><\/summary>/);
  assert.match(html, /data-toggle-view="statement"/);
  assert.match(html, /data-toggle-view="proof"/);
  assert.match(html, /Addition of natural numbers is associative\./);
  assert.match(html, /Use the standard associativity theorem\./);
  assert.match(html, /exact Nat\.add_assoc a b c/);
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
  assert.match(html, /<strong>Definition \(Double\)\.<\/strong>/);
  assert.match(html, /Doubling a natural number means adding it to itself\./);
  assert.match(html, /def double \(n : Nat\) : Nat := n \+ n/);
  assert.doesNotMatch(html, /<summary><strong>Proof\.<\/strong><\/summary>/);
});

test("renders unnamed theorem and definition labels plainly", () => {
  const declarations = parseLeanDocument(unnamedLeanText, "/workspace/Unnamed.lean");
  const articleText = "@include{lean:mul_one_right}\n\n@include{lean:nextNat}";
  const article = parseArticleDocument(articleText, "/workspace/unnamed.hw.md");
  const index = new HandwaveIndex("/workspace", declarations, [article]);
  const html = renderArticleHtml(articleText, "/workspace/unnamed.hw.md", index, (target) => `command:${target}`);

  assert.match(html, /<strong>Theorem\.<\/strong>/);
  assert.match(html, /<strong>Definition\.<\/strong>/);
  assert.doesNotMatch(html, /Theorem \(/);
  assert.doesNotMatch(html, /Definition \(/);
});
