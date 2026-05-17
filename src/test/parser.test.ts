import * as assert from "node:assert/strict";
import { test } from "node:test";
import { HandwaveIndex } from "../handwave/index";
import { parseArticleDocument, parseLeanDocument, parseTarget, slugify } from "../handwave/parser";
import { collectDiagnostics } from "../handwave/diagnostics";

const leanText = `/--
%%handwave
id: algebra.nat.add_assoc
prose.short:
  Addition of natural numbers is associative.
proof.sketch:
  Use the standard associativity theorem.
-/
theorem my_add_assoc (a b c : Nat) :
    (a + b) + c = a + (b + c) := by
  exact Nat.add_assoc a b c
`;

const articleText = `# Associativity

The central observation is that
[parentheses do not matter](lean:my_add_assoc).

@include{lean:my_add_assoc.statement}
@include{doc:algebra.nat.add_assoc.proof.sketch}

[broken](lean:Missing.add_assoc)
`;

test("parses Handwave Lean doc comments and declarations", () => {
  const declarations = parseLeanDocument(leanText, "/workspace/Nat.lean");

  assert.equal(declarations.length, 1);
  assert.equal(declarations[0].name, "my_add_assoc");
  assert.equal(declarations[0].doc?.id, "algebra.nat.add_assoc");
  assert.equal(
    declarations[0].doc?.fields["prose.short"],
    "Addition of natural numbers is associative."
  );
  assert.match(declarations[0].statement, /^theorem my_add_assoc/);
});

test("parses article headings, links, and includes", () => {
  const article = parseArticleDocument(articleText, "/workspace/natural-numbers.hw.md");

  assert.equal(article.anchors[0].id, "associativity");
  assert.equal(article.links.length, 2);
  assert.equal(article.links[0].target, "lean:my_add_assoc");
  assert.equal(article.includes.length, 2);
  assert.equal(article.includes[1].target, "doc:algebra.nat.add_assoc.proof.sketch");
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

test("resolves Lean, doc, article, and local targets", () => {
  const declarations = parseLeanDocument(leanText, "/workspace/Nat.lean");
  const article = parseArticleDocument(articleText, "/workspace/natural-numbers.hw.md");
  const index = new HandwaveIndex("/workspace", declarations, [article]);

  assert.equal(index.resolve("lean:my_add_assoc")?.title, "my_add_assoc");
  assert.equal(
    index.resolve("doc:algebra.nat.add_assoc.proof.sketch")?.preview,
    "Use the standard associativity theorem."
  );
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
