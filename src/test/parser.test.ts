import * as assert from "node:assert/strict";
import { test } from "node:test";
import { HandwaveIndex, isIndexedLeanDeclaration } from "../handwave/index";
import {
  buildTheoremExplorerPayload,
  theoremExplorerStatusCategory
} from "../handwave/explorer";
import { parseLeanAxiomOutput } from "../handwave/leanAxiom";
import {
  applyLeanIleanArtifacts,
  leanArtifactExtractorInput,
  parseLeanArtifactCache,
  parseLeanArtifactExtractorOutput
} from "../handwave/leanArtifacts";
import { shouldUseLeanServerDiagnostics } from "../handwave/leanCheck";
import { handwaveMathJaxConfiguration } from "../handwave/mathJax";
import { hasHandwaveTag, parseArticleDocument, parseLeanDocument, parseTarget, slugify } from "../handwave/parser";
import { collectDiagnostics } from "../handwave/diagnostics";
import {
  leanDeclarationAnchorId,
  renderArticleHtml,
  renderArticleFragmentHtml,
  renderLeanDeclarationPreviewHtml,
  renderLeanDocumentHtml
} from "../handwave/renderer";
import {
  applyLeanDeclarationMetadataUpdate,
  applySourceTextEdit,
  leanDeclarationTagSetEdit,
  leanDeclarationTagToggleEdit
} from "../handwave/tagEditor";
import { renderTheoremExplorerHtml } from "../web/explorer";

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

test("only the explicit Lean-server backend uses Lean server diagnostics", () => {
  assert.equal(shouldUseLeanServerDiagnostics(true, "subprocess"), false);
  assert.equal(shouldUseLeanServerDiagnostics(false, "subprocess"), false);
  assert.equal(shouldUseLeanServerDiagnostics(false, "leanServer"), false);
  assert.equal(shouldUseLeanServerDiagnostics(true, "leanServer"), true);
});

test("classifies theorem explorer statuses by badge color", () => {
  assert.equal(theoremExplorerStatusCategory(leanStatus(true, "checked")), "green");
  assert.equal(
    theoremExplorerStatusCategory({ ...leanStatus(true, "cached checked"), stale: true }),
    "green"
  );
  assert.equal(
    theoremExplorerStatusCategory(leanStatus(false, "dependency warning", [], ["dependency"])),
    "yellow"
  );
  assert.equal(
    theoremExplorerStatusCategory({
      ...leanStatus(false, "cached dependency warning", [], ["dependency"]),
      stale: true
    }),
    "yellow"
  );
  assert.equal(
    theoremExplorerStatusCategory({ ...leanStatus(false, "blocked"), blocked: true }),
    "unknown"
  );
  assert.equal(theoremExplorerStatusCategory(leanStatus(false, "unchecked")), "red");
  assert.equal(
    theoremExplorerStatusCategory({ ...leanStatus(false, "cached unchecked"), stale: true }),
    "red"
  );
  assert.equal(
    theoremExplorerStatusCategory({ ...leanStatus(false, "unavailable"), inconclusive: true }),
    "unknown"
  );
  assert.equal(theoremExplorerStatusCategory(undefined), "unknown");
});

test("uses ilean declaration identities and parent references for the theorem graph", () => {
  const uri = "/workspace/Demo.lean";
  const declarations = parseLeanDocument(`namespace Demo

theorem sourceDep : True := by trivial

private theorem privateDep : True := by trivial

def wrappedPrivateDep : True := privateDep

def proofDef : Nat := 0

theorem root : True := by
  have _ := proofDef
  exact sourceDep

end Demo
`, uri);
  const sourceDep = declarations.find((declaration) => declaration.sourceName === "Demo.sourceDep")!;
  const privateDep = declarations.find((declaration) => declaration.sourceName === "Demo.privateDep")!;
  const wrappedPrivateDep = declarations.find(
    (declaration) => declaration.sourceName === "Demo.wrappedPrivateDep"
  )!;
  const proofDef = declarations.find((declaration) => declaration.sourceName === "Demo.proofDef")!;
  const root = declarations.find((declaration) => declaration.sourceName === "Demo.root")!;
  const privateArtifactName = "_private.Demo.0.Demo.privateDep";
  const positions = (declaration: typeof root) => [
    declaration.range.start.line,
    declaration.range.start.character,
    declaration.range.end.line,
    declaration.range.end.character,
    declaration.nameRange.start.line,
    declaration.nameRange.start.character,
    declaration.nameRange.end.line,
    declaration.nameRange.end.character
  ];
  const referenceKey = JSON.stringify({ c: { m: "Demo", n: privateArtifactName } });
  const proofDefReferenceKey = JSON.stringify({ c: { m: "Demo", n: "Demo.proofDef" } });
  const ilean = JSON.stringify({
    version: 5,
    module: "Demo",
    directImports: [],
    decls: {
      "Demo.sourceDep": positions(sourceDep),
      [privateArtifactName]: positions(privateDep),
      "Demo.wrappedPrivateDep": positions(wrappedPrivateDep),
      "Demo.proofDef": positions(proofDef),
      "Demo.root": positions(root)
    },
    references: {
      [referenceKey]: {
        definition: positions(privateDep).slice(4),
        usages: [[
          root.nameRange.start.line,
          root.nameRange.start.character,
          root.nameRange.end.line,
          root.nameRange.end.character,
          "Demo.root"
        ], [
          wrappedPrivateDep.nameRange.start.line,
          wrappedPrivateDep.nameRange.start.character,
          wrappedPrivateDep.nameRange.end.line,
          wrappedPrivateDep.nameRange.end.character,
          "Demo.wrappedPrivateDep"
        ]]
      },
      [proofDefReferenceKey]: {
        definition: positions(proofDef).slice(4),
        usages: [[
          root.nameRange.start.line,
          root.nameRange.start.character,
          root.nameRange.end.line,
          root.nameRange.end.character,
          "Demo.root"
        ]]
      }
    }
  });

  const metadata = applyLeanIleanArtifacts(declarations, [{ uri, contents: ilean }]);
  assert.equal(
    metadata.declarations.find((declaration) => declaration.name === privateDep.name)?.artifactName,
    privateArtifactName
  );
  assert.deepEqual(metadata.dependencyGraph.get(root.name), [privateDep.name]);
  assert.deepEqual(
    metadata.definitionTheoremReferenceGraph.get(wrappedPrivateDep.name),
    [privateDep.name]
  );
  assert.deepEqual(metadata.theoremDefinitionReferenceGraph.get(root.name), [proofDef.name]);

  const index = new HandwaveIndex(
    "/workspace",
    metadata.declarations,
    [],
    new Map(),
    metadata.dependencyGraph,
    metadata.definitionTheoremReferenceGraph,
    metadata.theoremDefinitionReferenceGraph
  );
  assert.deepEqual(index.dependenciesForLean(root.name), [privateDep.name]);
  assert.deepEqual(index.proofDefinitionsForLean(root.name), [proofDef.name]);
  assert.deepEqual(index.theoremReferencesForDefinition(wrappedPrivateDep.name), [privateDep.name]);
});

test("generates and parses structured Lean artifact extraction records", () => {
  const input = leanArtifactExtractorInput(
    ["Demo.Module"],
    ["Demo.root", "_private.Demo.Module.0.Demo.privateDep"]
  );
  assert.ok(input);
  assert.match(input, /^import Demo\.Module/m);
  assert.match(input, /Lean\.collectAxioms/);
  assert.match(input, /_private\.Demo\.Module\.0\.Demo\.privateDep/);

  const output = [
    "ordinary Lean output",
    'HANDWAVE_ARTIFACT {"schemaVersion":1,"name":"Demo.root","axioms":["propext"],"typeConstants":[],"valueConstants":["Demo.dep"]}'
  ].join("\n");
  assert.deepEqual(parseLeanArtifactExtractorOutput(output).get("Demo.root"), {
    name: "Demo.root",
    axioms: ["propext"],
    typeConstants: [],
    valueConstants: ["Demo.dep"]
  });

  const cache = parseLeanArtifactCache(JSON.stringify({
    schemaVersion: 1,
    entries: {
      "Demo.root": {
        name: "Demo.root",
        module: "Demo.Module",
        traceFingerprint: "abc",
        axioms: ["propext"],
        typeConstants: [],
        valueConstants: ["Demo.dep"]
      }
    }
  }));
  assert.equal(cache?.entries["Demo.root"].traceFingerprint, "abc");
});

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

const dependencyTreeLeanText = `namespace DependencyTree

/--
%%handwave
name:
  Complete dependency
statement:
  This dependency is complete.
-/
theorem green_dep : True := by
  trivial

/--
%%handwave
name:
  Incomplete dependency
statement:
  This dependency is incomplete.
-/
theorem red_dep : True := by
  sorry

/--
%%handwave
statement:
  This dependency is proved, but it relies on an incomplete theorem.
-/
theorem yellow_dep : True := by
  exact red_dep

structure Wrapper where
  proof : True

namespace Wrapper

theorem method_dep (w : Wrapper) : True := by
  exact w.proof

end Wrapper

theorem method_root (w : Wrapper) : True := by
  exact w.method_dep

/--
%%handwave
statement:
  This theorem depends on both a complete theorem and a theorem with incomplete dependencies.
-/
theorem root_dep : True := by
  have _ := green_dep
  exact yellow_dep

end DependencyTree
`;

const privateDependencyLeanText = `namespace PrivateDependency

private theorem hidden_leaf : True := by
  sorry

private theorem hidden_dep : True := by
  exact hidden_leaf

/--
%%handwave
name:
  Public dependency
statement:
  This theorem uses a private implementation lemma.
-/
theorem public_dep : True := by
  exact hidden_dep

end CompletePrivateDependency
`;

const completePrivateDependencyLeanText = `namespace CompletePrivateDependency

private theorem hidden_dep : True := by
  trivial

/--
%%handwave
statement:
  This theorem uses a private implementation lemma.
-/
theorem public_dep : True := by
  exact hidden_dep

end PrivateDependency
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

function declarationBySourceName(
  declarations: ReturnType<typeof parseLeanDocument>,
  sourceName: string
) {
  return declarations.find((declaration) => declaration.sourceName === sourceName);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const inactiveMilestoneStarPattern =
  /<button class="milestone-control milestone-control-inactive" type="button" data-toggle-tag="milestone" data-handwave-target="lean:[^"]+" aria-pressed="false" title="Add milestone tag" aria-label="Add milestone tag">☆<\/button>/;

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

test("parses Handwave declaration tags", () => {
  const declarations = parseLeanDocument(`/--
%%handwave
tags:
  milestone, Draft
  milestone
statement:
  This theorem carries metadata tags.
-/
theorem tagged_result : True := by
  trivial
`, "/workspace/Tagged.lean");

  assert.deepEqual(declarations[0].doc?.tags, ["milestone", "draft"]);
  assert.equal(hasHandwaveTag(declarations[0].doc, "milestone"), true);
  assert.equal(hasHandwaveTag(declarations[0].doc, "draft"), true);
  assert.equal(hasHandwaveTag(declarations[0].doc, "other"), false);
});

test("produces direct source edits when toggling Handwave declaration tags", () => {
  const uri = "/workspace/Tagged.lean";
  const source = `/--\r
%%handwave\r
tags:\r
  draft\r
statement:\r
  A tagged theorem.\r
-/\r
theorem tagged_result : True := by\r
  trivial\r
`;
  const declaration = parseLeanDocument(source, uri)[0];
  const addEdit = leanDeclarationTagToggleEdit(source, uri, declaration.name, "milestone");
  assert.ok(addEdit);
  assert.ok(addEdit.end - addEdit.start < source.length);
  const withMilestone = applySourceTextEdit(source, addEdit);
  assert.deepEqual(parseLeanDocument(withMilestone, uri)[0].doc?.tags, ["draft", "milestone"]);
  assert.match(withMilestone, /tags:\r\n  draft, milestone\r\nstatement:/);

  const removeEdit = leanDeclarationTagToggleEdit(withMilestone, uri, declaration.name, "milestone");
  assert.ok(removeEdit);
  const withoutMilestone = applySourceTextEdit(withMilestone, removeEdit);
  assert.equal(withoutMilestone, source);
});

test("creates a Handwave block when directly tagging an undocumented theorem", () => {
  const uri = "/workspace/Bare.lean";
  const source = `namespace Tagged

  @[simp]
  theorem bare_result : True := by
    trivial

end Tagged
`;
  const declaration = parseLeanDocument(source, uri)[0];
  const edit = leanDeclarationTagToggleEdit(source, uri, declaration.name, "milestone");
  assert.ok(edit);
  const updated = applySourceTextEdit(source, edit);
  assert.match(updated, /  \/--\n  %%handwave\n  tags:\n    milestone\n  -\/\n  @\[simp\]\n  theorem bare_result/);
  assert.deepEqual(parseLeanDocument(updated, uri)[0].doc?.tags, ["milestone"]);
});

test("sets declaration tags idempotently and updates metadata fields in place", () => {
  const uri = "/workspace/Metadata.lean";
  const source = `/--
%%handwave
name:
  Original title
statement:
  Original statement.
custom:
  Preserved value.
tags:
  draft
-/
theorem metadata_result : True := by
  trivial
`;
  const declaration = parseLeanDocument(source, uri)[0];
  const add = leanDeclarationTagSetEdit(source, uri, declaration.name, "milestone", true);
  assert.ok(add);
  const tagged = applySourceTextEdit(source, add);
  const repeated = leanDeclarationTagSetEdit(tagged, uri, declaration.name, "milestone", true);
  assert.deepEqual(repeated, { start: 0, end: 0, text: "" });
  assert.equal(applySourceTextEdit(tagged, repeated), tagged);

  const updated = applyLeanDeclarationMetadataUpdate(tagged, uri, declaration.name, {
    name: "Updated title",
    statement: "First paragraph.\n\nSecond paragraph.",
    proof: "A new proof sketch."
  });
  assert.ok(updated);
  const parsed = parseLeanDocument(updated, uri)[0];
  assert.equal(parsed.doc?.fields.name, "Updated title");
  assert.equal(parsed.doc?.fields.statement, "First paragraph.\n\nSecond paragraph.");
  assert.equal(parsed.doc?.fields.proof, "A new proof sketch.");
  assert.equal(parsed.doc?.fields.custom, "Preserved value.");
  assert.deepEqual(parsed.doc?.tags, ["draft", "milestone"]);
});

test("creates complete Handwave metadata for an undocumented definition", () => {
  const uri = "/workspace/MetadataDefinition.lean";
  const source = `namespace Metadata

/-- Existing Lean documentation that should remain above the Handwave metadata. -/
@[simp]
def undocumented : Nat := 0

end Metadata
`;
  const declaration = parseLeanDocument(source, uri)[0];
  const updated = applyLeanDeclarationMetadataUpdate(source, uri, declaration.name, {
    name: "The zero object",
    statement: "This definition denotes zero."
  });
  assert.ok(updated);
  assert.match(
    updated,
    /\/--\nExisting Lean documentation that should remain above the Handwave metadata\.\n\n%%handwave/
  );
  assert.match(updated, /%%handwave\nname:\n  The zero object\nstatement:\n  This definition denotes zero\./);
  assert.equal((updated.match(/\/--/g) ?? []).length, 1);
  assert.match(updated, /-\/\n@\[simp\]\ndef undocumented : Nat := 0/);
  assert.equal(parseLeanDocument(updated, uri)[0].doc?.fields.name, "The zero object");
});

test("preserves an adjacent ordinary docstring above newly inserted Handwave metadata", () => {
  const uri = "/workspace/DocumentedDefinition.lean";
  const source = `namespace Metadata

  /--
  A documented surface-like class.

  name:
  This line is part of the ordinary Lean documentation.

  Its original prose should be retained.
  -/
  class SurfaceLike (X : Type*) : Prop where
    witness : True

end Metadata
`;
  const declaration = parseLeanDocument(source, uri)[0];
  const updated = applyLeanDeclarationMetadataUpdate(source, uri, declaration.name, {
    name: "Surface-like space",
    statement: ""
  });
  assert.ok(updated);
  assert.equal((updated.match(/\/--/g) ?? []).length, 1);
  assert.match(
    updated,
    /  \/--\n  A documented surface-like class\.\n  \n  name:\n  This line is part of the ordinary Lean documentation\.\n  \n  Its original prose should be retained\.\n\n  %%handwave/
  );
  assert.match(updated, /  %%handwave\n  name:\n    Surface-like space/);
  assert.doesNotMatch(updated, /  statement:/);
  assert.match(updated, /  -\/\n  class SurfaceLike/);
  const parsed = parseLeanDocument(updated, uri)[0];
  assert.equal(parsed.doc?.fields.statement, undefined);
  assert.equal(parsed.doc?.fields.name, "Surface-like space");

  const renamed = applyLeanDeclarationMetadataUpdate(updated, uri, declaration.name, {
    name: "Renamed surface-like space"
  });
  assert.ok(renamed);
  assert.match(
    renamed,
    /  name:\n  This line is part of the ordinary Lean documentation\.\n[\s\S]*  %%handwave\n  name:\n    Renamed surface-like space/
  );
  assert.equal(parseLeanDocument(renamed, uri)[0].doc?.fields.name, "Renamed surface-like space");
});

test("does not index shadow-tagged declarations or let them override ordinary declarations", () => {
  const ordinarySource = `namespace Duplicate

/--
%%handwave
statement:
  The completed project theorem.
-/
theorem result : True := by
  trivial

/--
%%handwave
statement:
  The project value is zero.
-/
def value : Nat := 0

end Duplicate
`;
  const shadowSource = `namespace Duplicate

/--
%%handwave
tags:
  shadow
statement:
  The challenge copy of the theorem.
-/
theorem result : True := by
  sorry

/--
%%handwave
tags:
  shadow
statement:
  The challenge value is one.
-/
def value : Nat := 1

end Duplicate
`;
  const ordinaryDeclarations = parseLeanDocument(ordinarySource, "/workspace/Project.lean");
  const shadowDeclarations = parseLeanDocument(shadowSource, "/workspace/Challenge.lean");
  const ordinary = ordinaryDeclarations[0];
  const shadow = shadowDeclarations[0];
  const ordinaryDefinition = ordinaryDeclarations[1];
  const shadowDefinition = shadowDeclarations[1];
  assert.equal(ordinary.name, shadow.name);
  assert.equal(ordinaryDefinition.name, shadowDefinition.name);
  assert.equal(isIndexedLeanDeclaration(ordinary), true);
  assert.equal(isIndexedLeanDeclaration(shadow), false);
  assert.equal(isIndexedLeanDeclaration(ordinaryDefinition), true);
  assert.equal(isIndexedLeanDeclaration(shadowDefinition), false);

  const declarations = [...ordinaryDeclarations, ...shadowDeclarations];
  const index = new HandwaveIndex("/workspace", declarations, []);
  assert.equal(index.leanDeclarations.get(ordinary.name)?.uri, ordinary.uri);
  assert.equal(index.leanDeclarations.get(ordinaryDefinition.name)?.uri, ordinaryDefinition.uri);
  assert.equal(index.resolve(`lean:${ordinary.name}`)?.preview, ordinary.leanStatement);
  assert.equal(
    index.resolve(`lean:${ordinaryDefinition.name}`)?.preview,
    ordinaryDefinition.leanStatement
  );
  assert.doesNotMatch(index.leanDeclarations.get(ordinary.name)?.leanProof ?? "", /\bsorry\b/);

  const explorer = buildTheoremExplorerPayload(index, declarations, ["/workspace"]);
  assert.equal(explorer.theoremCount, 1);
  assert.equal(explorer.definitionCount, 1);
  assert.deepEqual(explorer.theorems.map((theorem) => theorem.uri), [ordinary.uri]);
  assert.deepEqual(explorer.definitions.map((definition) => definition.uri), [ordinaryDefinition.uri]);

  const shadowOnlyIndex = new HandwaveIndex("/workspace", shadowDeclarations, []);
  assert.equal(shadowOnlyIndex.resolve(`lean:${shadow.name}`), undefined);
  assert.equal(shadowOnlyIndex.resolve(`lean:${shadowDefinition.name}`), undefined);
  assert.equal(shadowOnlyIndex.checkStatusForLean(shadow.name), undefined);
  assert.deepEqual(shadowOnlyIndex.dependenciesForLean(shadow.name), []);
  const shadowPreview = renderLeanDocumentHtml(
    shadowSource,
    shadow.uri,
    shadowOnlyIndex,
    (target) => `command:${target}`
  );
  assert.match(shadowPreview, /No Lean declarations were found in this file\./);
  assert.doesNotMatch(shadowPreview, /<section class="theorem-view"/);
  assert.doesNotMatch(shadowPreview, /<section class="definition-view"/);
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

test("stops a final declaration before namespace end commands", () => {
  const declarations = parseLeanDocument(`namespace Outer

namespace Inner

/--
%%handwave
statement:
  The final theorem in a nested namespace is true.
proof:
  This is immediate.
-/
theorem final_theorem : True := by
  trivial

end Inner

end Outer
`, "/workspace/FinalDeclaration.lean");

  assert.equal(declarations[0].name, "Outer.Inner.final_theorem");
  assert.equal(declarations[0].leanProof, "by\n  trivial");
  assert.doesNotMatch(declarations[0].statement, /end Inner|end Outer/);
  assert.deepEqual(declarations[0].range.end, { line: 14, character: 0 });
});

test("indexes and renders includes for Unicode Lean declaration names", () => {
  const unicodeName =
    "JJMath.Cohomology.openSingularCochainTop_homologyπ_zero_eq_zero_of_sheafified_boundary_subdivision";
  const lean = `namespace JJMath.Cohomology

/--
%%handwave
name:
  Degree-zero sheafified boundaries vanish
statement:
  A degree-zero singular cocycle whose sheafified class vanishes has zero class.
proof:
  Use local vanishing of locally constant zero-cochains.
-/
theorem openSingularCochainTop_homologyπ_zero_eq_zero_of_sheafified_boundary_subdivision :
    True := by
  trivial

namespace Unicodeπ

theorem theorem₂ : True := by
  trivial

end Unicodeπ

end JJMath.Cohomology
`;
  const articleText = `@include{lean:${unicodeName}}`;
  const declarations = parseLeanDocument(lean, "/workspace/Unicode.lean");
  const article = parseArticleDocument(articleText, "/workspace/unicode.hw.md");
  const index = new HandwaveIndex("/workspace", declarations, [article]);

  assert.equal(declarations[0]?.name, unicodeName);
  assert.equal(
    declarations.find((declaration) => declaration.sourceName.endsWith("theorem₂"))?.name,
    "JJMath.Cohomology.Unicodeπ.theorem₂"
  );
  assert.equal(index.resolve(`lean:${unicodeName}`)?.title, unicodeName);
  assert.equal(article.includes[0]?.target, `lean:${unicodeName}`);

  const html = renderArticleHtml(
    articleText,
    "/workspace/unicode.hw.md",
    index,
    (target) => `command:${target}`
  );
  assert.doesNotMatch(html, /Unresolved include/);
  assert.match(html, new RegExp(`data-handwave-target="lean:${unicodeName}"`));
});

test("ignores comment prose while tracking Lean namespaces", () => {
  const declarations = parseLeanDocument(`namespace RelWP

namespace Uniformization

/--
%%handwave
statement:
  An end-growth sentence in prose should not close the current namespace.
-/
theorem after_end_growth_prose : True := by
  trivial

end Uniformization

end RelWP
`, "/workspace/Namespaced.lean");

  assert.equal(declarations[0].name, "RelWP.Uniformization.after_end_growth_prose");
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

test("keeps let assignments inside Lean theorem statements", () => {
  const declarations = parseLeanDocument(`/--
%%handwave
statement:
  A theorem statement can contain a let expression.
-/
theorem let_statement :
    (let x := 1; x = 1) := by
  rfl
`, "/workspace/LetStatement.lean");

  assert.match(declarations[0].leanStatement, /let x := 1; x = 1/);
  assert.equal(declarations[0].leanProof, "by\n  rfl");
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

test("derives article navigation from the shared Markdown tree", () => {
  const text = [
    "# Real *title* {#chosen}",
    "",
    "```md",
    "# Fake heading",
    "[fake](lean:fake)",
    "@include{lean:fake}",
    "```",
    "",
    "- [real](lean:real)",
    "  @include{lean:real}",
    "",
    "[proof link][proof]",
    "",
    "[proof]: lean:real.proof",
    "",
    "Paragraph anchor {#spot}."
  ].join("\n");
  const article = parseArticleDocument(text, "/workspace/shared-tree.hw.md");

  assert.deepEqual(
    article.anchors.map(({ id, title }) => ({ id, title })),
    [
      { id: "chosen", title: "Real *title*" },
      { id: "spot", title: "spot" }
    ]
  );
  assert.deepEqual(
    article.links.map(({ label, target }) => ({ label, target })),
    [
      { label: "real", target: "lean:real" },
      { label: "proof link", target: "lean:real.proof" }
    ]
  );
  assert.deepEqual(article.includes.map(({ target }) => target), ["lean:real"]);
  assert.deepEqual(article.links[1].targetRange, {
    start: { line: 13, character: 9 },
    end: { line: 13, character: 24 }
  });
  assert.deepEqual(article.includes[0].targetRange, {
    start: { line: 9, character: 11 },
    end: { line: 9, character: 20 }
  });

  const index = new HandwaveIndex("/workspace", [], [article]);
  const html = renderArticleFragmentHtml(text, article.uri, index, (target) => `command:${target}`);
  assert.match(html, /<h1 id="chosen">Real <em>title<\/em><\/h1>/);
  assert.match(html, /Paragraph anchor <span id="spot"><\/span>\.<\/p>/);
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

test("diagnoses Handwave links but leaves ordinary Markdown destinations alone", () => {
  const declarations = parseLeanDocument(leanText, "/workspace/Nat.lean");
  const ordinaryTargets = [
    "https://willierushrush.github.io/posts/2020/05/second-countability/",
    "ftp://example.com/paper.txt",
    "file:///tmp/notes.pdf",
    "future-scheme:resource",
    "../references/local-note.md"
  ];
  const article = parseArticleDocument(
    `${articleText}\n[monoid](term:monoid)\n` +
      ordinaryTargets.map((target, index) => `[source ${index}](${target})`).join("\n"),
    "/workspace/natural-numbers.hw.md"
  );
  const index = new HandwaveIndex("/workspace", declarations, [article]);
  const diagnostics = collectDiagnostics(index, declarations, [article]);

  assert.equal(diagnostics.some((issue) => issue.message.includes("Missing.add_assoc")), true);
  assert.equal(diagnostics.some((issue) => issue.message.includes("term:monoid")), false);
  for (const target of ordinaryTargets) {
    assert.equal(diagnostics.some((issue) => issue.message.includes(target)), false);
  }
});

test("only rewrites known Handwave navigation links", () => {
  const ordinaryTargets = [
    "https://willierushrush.github.io/posts/2020/05/second-countability/",
    "ftp://example.com/paper.txt",
    "file:///tmp/notes.pdf",
    "future-scheme:resource",
    "../references/local-note.md"
  ];
  const articleText = [
    ...ordinaryTargets.map((target, index) => `[source ${index}](${target})`),
    "[theorem](lean:my_add_assoc)"
  ].join("\n");
  const article = parseArticleDocument(articleText, "/workspace/rado.hw.md");
  const index = new HandwaveIndex("/workspace", [], [article]);
  const html = renderArticleHtml(
    articleText,
    "/workspace/rado.hw.md",
    index,
    (target) => `command:${target}`
  );

  for (const target of ordinaryTargets) {
    assert.match(html, new RegExp(`href="${escapeRegExp(target)}"`));
    assert.doesNotMatch(html, new RegExp(`href="command:${escapeRegExp(target)}"`));
    assert.doesNotMatch(html, new RegExp(`data-handwave-target="${escapeRegExp(target)}"`));
  }
  assert.match(html, /href="command:lean:my_add_assoc"/);
  assert.match(html, /data-handwave-target="lean:my_add_assoc"/);
});

test("keeps includes strict when their target is not a Handwave resource", () => {
  const articleText = "@include{ftp://example.com/paper.txt}";
  const article = parseArticleDocument(articleText, "/workspace/include.hw.md");
  const index = new HandwaveIndex("/workspace", [], [article]);
  const diagnostics = collectDiagnostics(index, [], [article]);

  assert.equal(
    diagnostics.some((issue) => issue.message.includes("Unsupported Handwave include target")),
    true
  );
});

test("slugifies section titles", () => {
  assert.equal(slugify("Repeated Addition!"), "repeated-addition");
});

test("renders article edit controls with original source offsets", () => {
  const source = [
    "# Article title",
    "",
    "Intro paragraph on two",
    "source lines.",
    "",
    "## Detailed section {#details}",
    "",
    "Final paragraph."
  ].join("\n");
  const article = parseArticleDocument(source, "/workspace/editable.hw.md");
  const index = new HandwaveIndex("/workspace", [], [article]);
  const editable = renderArticleFragmentHtml(
    source,
    article.uri,
    index,
    () => "#",
    { editableArticles: true }
  );
  const readOnly = renderArticleFragmentHtml(source, article.uri, index, () => "#");

  assert.match(
    editable,
    new RegExp(`class="article-heading-edit"[^>]*data-edit-offset="${source.indexOf("Article title")}"[^>]*aria-label="Edit this title"`)
  );
  assert.match(
    editable,
    new RegExp(`class="article-block-edit"[^>]*data-edit-offset="${source.indexOf("Intro paragraph")}"[^>]*aria-label="Edit this paragraph"`)
  );
  assert.match(
    editable,
    new RegExp(`class="article-heading-edit"[^>]*data-edit-offset="${source.indexOf("Detailed section")}"[^>]*aria-label="Edit this heading"`)
  );
  assert.doesNotMatch(readOnly, /data-edit-article/);
});

test("renders Lean statement includes as theorem views", () => {
  const declarations = parseLeanDocument(leanText, "/workspace/Nat.lean");
  const article = parseArticleDocument(articleText, "/workspace/natural-numbers.hw.md");
  const index = new HandwaveIndex("/workspace", declarations, [article], new Map([
    ["my_add_assoc", leanStatus(true, "Lean LSP diagnostics report no errors.")]
  ]));
  const html = renderArticleHtml(
    articleText,
    "/workspace/natural-numbers.hw.md",
    index,
    (target) => `command:${target}`,
    { editorHref: (target) => `editor:${target}` }
  );
  const fragment = renderArticleFragmentHtml(
    articleText,
    "/workspace/natural-numbers.hw.md",
    index,
    (target) => `command:${target}`,
    { editorHref: (target) => `editor:${target}` }
  );
  const staticFragment = renderArticleFragmentHtml(
    articleText,
    "/workspace/natural-numbers.hw.md",
    index,
    () => "#",
    { sourceLinks: false }
  );

  assert.equal(html.includes(fragment), true);
  assert.match(html, /a \{\s*color: [^;]+;\s*text-decoration: none;/);
  assert.doesNotMatch(html, /text-decoration:\s*underline/);
  assert.match(html, /<a href="command:lean:my_add_assoc" data-handwave-target="lean:my_add_assoc" title="lean:my_add_assoc">parentheses do not matter<\/a>/);
  assert.match(html, /<strong><a class="declaration-link" href="command:lean:my_add_assoc" data-handwave-target="lean:my_add_assoc" title="Open lean:my_add_assoc">Theorem \(Addition associativity\)\.<\/a><\/strong>/);
  assert.match(html, /class="check-status check-status-checked"[^>]*aria-label="Lean checked">✓<\/span><span class="declaration-label"><strong><a class="declaration-link" href="command:lean:my_add_assoc" data-handwave-target="lean:my_add_assoc" title="Open lean:my_add_assoc">Theorem \(Addition associativity\)\.<\/a><\/strong>/);
  assert.match(html, /class="source-popover"><span class="source-popover-row"><button class="milestone-control milestone-control-inactive" type="button" data-toggle-tag="milestone" data-handwave-target="lean:my_add_assoc" aria-pressed="false" title="Add milestone tag" aria-label="Add milestone tag">☆<\/button><span class="view-switch" role="group" aria-label="Theorem view".*<span class="source-popover-separator">\|<\/span><a href="editor:lean:my_add_assoc" title="Open my_add_assoc in editor">my_add_assoc<\/a><button class="copy-control" type="button" data-copy-target="lean:my_add_assoc" title="Copy lean:my_add_assoc" aria-label="Copy lean:my_add_assoc"><span class="copy-icon" aria-hidden="true"><\/span><span class="sr-only">Copy<\/span><\/button>/);
  assert.match(staticFragment, /<span class="source-name" title="Lean declaration my_add_assoc">my_add_assoc<\/span>/);
  assert.doesNotMatch(staticFragment, /title="Open my_add_assoc in editor"/);
  assert.match(html, /<div class="proof-line"><button class="collapse-control" type="button" data-toggle-collapsed="proof" aria-expanded="true" aria-label="Collapse proof">▾<\/button><span class="declaration-label"><strong>Proof\.<\/strong>.*<div class="proof-content">/);
  assert.match(html, /\.proof-content \{\s*display: inline;/);
  assert.match(html, /\[data-mode="text"\] \.proof-body > \.prose-content \{\s*display: inline;/);
  assert.match(html, /\.proof-body > \.prose-content > \.prose-paragraph:first-child \{\s*display: inline;/);
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

test("renders milestone theorem tags as star toggles", () => {
  const source = `/--
%%handwave
name:
  Tagged theorem
tags:
  milestone, draft
statement:
  This theorem is a milestone.
-/
theorem tagged_theorem : True := by
  trivial

/--
%%handwave
statement:
  This theorem is not yet marked as a milestone.
-/
theorem untagged_theorem : True := by
  trivial
`;
  const declarations = parseLeanDocument(source, "/workspace/Tagged.lean");
  const index = new HandwaveIndex("/workspace", declarations, []);
  const html = renderLeanDocumentHtml(source, "/workspace/Tagged.lean", index, (target) => `command:${target}`);
  const readOnlyFragment = renderArticleFragmentHtml(
    [
      "@include{lean:tagged_theorem}",
      "",
      "@include{lean:untagged_theorem}"
    ].join("\n"),
    "/workspace/milestones.hw.md",
    index,
    () => "#",
    { editableTags: false }
  );

  assert.match(html, /Theorem \(Tagged theorem\)\./);
  assert.match(html, /<button class="milestone-control milestone-control-active" type="button" data-toggle-tag="milestone" data-handwave-target="lean:tagged_theorem" aria-pressed="true" title="Remove milestone tag" aria-label="Remove milestone tag">★<\/button><span class="view-switch" role="group" aria-label="Theorem view">/);
  assert.match(html, inactiveMilestoneStarPattern);
  assert.match(html, /<button class="milestone-control milestone-control-inactive" type="button" data-toggle-tag="milestone" data-handwave-target="lean:untagged_theorem" aria-pressed="false" title="Add milestone tag" aria-label="Add milestone tag">☆<\/button><span class="view-switch" role="group" aria-label="Theorem view">/);
  assert.match(html, /postMessage\(\{ type: "toggleTag", target: handwaveTarget, tag \}\)/);
  assert.match(readOnlyFragment, /<span class="milestone-tag" title="Milestone" aria-label="Milestone">★<\/span>/);
  assert.doesNotMatch(readOnlyFragment, /data-toggle-tag="milestone"/);
  assert.doesNotMatch(readOnlyFragment, />☆<\/button>/);
});

test("renders theorem and proof hover controls for explorer previews", () => {
  const declarations = parseLeanDocument(leanText, "/workspace/Nat.lean");
  const index = new HandwaveIndex("/workspace", declarations, []);
  const html = renderLeanDeclarationPreviewHtml(
    declarations[0],
    index,
    (target) => `command:${target}`,
    (target) => `editor:${target}`
  );

  assert.match(html, /<section class="theorem-view"/);
  assert.match(html, /data-handwave-target="lean:my_add_assoc"/);
  assert.match(html, /Addition of natural numbers is associative/);
  assert.match(html, /class="source-popover"/);
  assert.match(html, /aria-label="Theorem view"/);
  assert.match(html, /aria-label="Proof view"/);
  assert.equal((html.match(/data-set-mode="lean"/g) ?? []).length, 2);
  assert.match(html, /<a href="editor:lean:my_add_assoc" title="Open my_add_assoc in editor">my_add_assoc<\/a>/);
  assert.doesNotMatch(html, /milestone-control/);
});

test("builds theorem explorer relation links and status badges", () => {
  const declarations = parseLeanDocument(`/--
%%handwave
name:
  Base theorem with a deliberately long display name
statement:
  The base theorem is true.
proof:
  It is immediate.
-/
theorem base_theorem : True := by
  trivial

def theorem_backed_definition : True :=
  base_theorem

/--
%%handwave
name:
  Derived theorem
statement:
  The derived theorem follows from the base theorem.
proof:
  Apply the base theorem.
-/
theorem derived_theorem : True := by
  exact base_theorem
`, "/workspace/Explorer.lean");
  const article = parseArticleDocument([
    "# Explorer Notes",
    "",
    "[the base theorem](lean:base_theorem)",
    "",
    "[the theorem-backed definition](lean:theorem_backed_definition)",
    "",
    "@include{lean:base_theorem.statement}"
  ].join("\n"), "/workspace/notes/explorer.hw.md");
  const index = new HandwaveIndex("/workspace", declarations, [article], new Map([
    ["base_theorem", leanStatus(true, "Lean checked for explorer test.")]
  ]));
  const payload = buildTheoremExplorerPayload(index, declarations, ["/workspace"]);
  const base = payload.theorems.find((theorem) => theorem.name === "base_theorem");
  const theoremBackedDefinition = payload.definitions.find(
    (definition) => definition.name === "theorem_backed_definition"
  );

  assert.deepEqual(base?.dependents.map((link) => link.target), ["lean:derived_theorem"]);
  assert.deepEqual(
    base?.referencingDefinitions.map((link) => link.target),
    ["lean:theorem_backed_definition"]
  );
  assert.deepEqual(
    theoremBackedDefinition?.theorems.map((link) => link.target),
    ["lean:base_theorem"]
  );
  assert.deepEqual(
    theoremBackedDefinition?.references.map((link) => link.target),
    ["article:notes/explorer.hw.md"]
  );
  assert.equal(theoremBackedDefinition?.references[0]?.label, "notes/explorer.hw.md");
  assert.deepEqual(base?.references.map((link) => link.target), ["article:notes/explorer.hw.md"]);
  assert.equal(base?.references[0]?.label, "notes/explorer.hw.md");
  assert.match(base?.statusHtml ?? "", /class="check-status check-status-checked"[^>]*>✓<\/span>/);
  assert.equal(base?.statusCategory, "green");
  assert.equal(Object.hasOwn(base ?? {}, "previewHtml"), false);

  const html = renderTheoremExplorerHtml(payload);
  assert.match(html, /a \{\s*color: [^;]+;\s*text-decoration: none;/);
  assert.doesNotMatch(html, /text-decoration:\s*underline/);
  assert.match(html, /const previewHtmlByName = new Map\(\);/);
  assert.match(html, /const articleHtmlByTarget = new Map\(\);/);
  assert.match(html, /const articleSearchItems = \[\];/);
  assert.match(html, /const applicationShellEnabled = false;/);
  assert.doesNotMatch(html, /id="navigation-toggle"/);
  assert.doesNotMatch(html, /id="overview"/);
  assert.doesNotMatch(html, /id="search-rendered"/);
  assert.doesNotMatch(html, /id="theme-toggle"/);
  assert.match(
    html,
    /\(theorem \? injectPreviewMilestoneControl\(previewHtml, theorem\) : previewHtml\) \+ viewerInfo/
  );
  assert.equal(html, renderTheoremExplorerHtml(payload, {}));
  assert.match(
    html,
    /!link\.closest\("\.viewer-info"\) \|\| !openTargetLocally\(targetName\)/
  );
  assert.match(html, /type: "requestPreview"/);
  assert.match(html, /\.viewer-info-item-proof \{\s*font-style: italic;/);
  assert.match(html, /const itemClass = link\.proofOnly \? ' class="viewer-info-item-proof"'/);
  assert.match(html, /function createDefinitionMap\(sourcePayload\)/);
  assert.match(html, /function restrictToDefinition\(definition\)/);
  assert.match(html, /searchSelection\?\.type === "definition"/);
  assert.match(html, /Definitions using this definition/);
  assert.match(html, /Definitions using this theorem/);
  assert.match(html, /Definitions used in the statement of this theorem/);
  assert.match(html, /Definitions used in the proof of this theorem/);
  assert.match(html, /Theorems used by this definition/);
  assert.match(html, /Definitions used by this definition/);
  assert.match(
    html,
    /function renderDefinitionViewerInfo\(definition\) \{[\s\S]*?"Handwave articles referencing this definition",[\s\S]*?definition\?\.references[\s\S]*?"Definitions using this definition"/
  );
  assert.match(
    html,
    /definition\.referencingTheorems[\s\S]*?theoremPassesExplorerFilters\(theorem\)/
  );
  assert.match(html, /function graphTheoremMap\(\)/);
  assert.match(
    html,
    /searchSelection\?\.type !== "definition"[\s\S]*?return new Map\(theorems\.map\(\(theorem\) => \[theorem\.name, theorem\]\)\);/
  );
  assert.match(html, /const theoremMap = graphTheoremMap\(\);/);
  assert.match(html, /const layout = layoutGraph\(roots, theoremMap\);/);
  assert.doesNotMatch(html, /searchSelection\?\.type !== "definition"\);/);
  assert.match(
    html,
    /function renderDefinitionViewerInfo\(definition\) \{[\s\S]*?"Handwave articles referencing this definition",[\s\S]*?"Definitions using this definition",[\s\S]*?"Theorems used by this definition",[\s\S]*?"Definitions used by this definition",/
  );
  assert.match(
    html,
    /function renderViewerInfo\(theorem\) \{[\s\S]*?"Handwave articles referencing this theorem",[\s\S]*?"Theorems using this theorem",[\s\S]*?"Definitions using this theorem",[\s\S]*?"Definitions used in the statement of this theorem",[\s\S]*?"Definitions used in the proof of this theorem",/
  );
  assert.match(html, /No Handwave article cites this theorem\./);
  assert.match(html, /No other theorem uses this theorem\./);
  assert.match(html, /No definition uses this theorem\./);
  assert.match(
    html,
    /The statement of the theorem does not reference indexed definitions\./
  );
  assert.match(
    html,
    /The proof of the theorem does not reference indexed definitions\./
  );
  assert.match(html, /No Handwave article cites this definition\./);
  assert.match(html, /No other definition uses this definition\./);
  assert.match(html, /This definition does not use indexed theorems\./);
  assert.match(html, /This definition does not use other indexed definitions\./);
  assert.match(
    html,
    /suggestion-group-title">Theorems[\s\S]*?suggestion-group-title">Definitions[\s\S]*?suggestion-group-title">Modules/
  );
  assert.match(html, /\.preview \.definition-references \{\s*border-top: 1px solid var\(--border\);/);
  assert.match(html, /\.preview \.definition-reference-list \{\s*display: grid;\s*gap: 4px;/);
  assert.match(
    html,
    /const definition = definitionForTarget\(targetName\);[\s\S]*?restrictToDefinition\(definition\);/
  );
  assert.match(html, /message\.type === "setPreview"/);
  assert.match(html, /const handwaveViewModes = new Map\(\);/);
  assert.match(html, /const viewerInfoSectionExpansion = new Map\(\);/);
  assert.match(html, /function handwaveSectionKey\(section\)/);
  assert.match(html, /function rememberHandwaveViewModes\(root\)/);
  assert.match(html, /function restoreHandwaveViewModes\(root\)/);
  assert.match(html, /function captureArticleScrollPosition\(\)/);
  assert.match(html, /function restoreArticleScrollPosition\(position\)/);
  assert.match(html, /function articleHeadingThreshold\(previewTop\)/);
  assert.equal((html.match(/articleHeadingThreshold\(previewTop\)/g) ?? []).length, 3);
  assert.match(html, /function captureExplorerScrollPosition\(\)/);
  assert.match(html, /function restoreExplorerGraphScrollPosition\(position\)/);
  assert.match(html, /function retainExplorerPreviewScrollPosition\(position\)/);
  assert.match(html, /function restoreExplorerPreviewScrollPosition\(position\)/);
  assert.match(html, /renderExplorerGraph\(explorerScrollPosition\)/);
  assert.match(html, /restoreExplorerGraphScrollPosition\(layout\.scrollPosition\);/);
  assert.match(
    html,
    /restoreExplorerPreviewScrollPosition\(explorerScrollPosition\);[\s\S]*?queueMathTypeset\([\s\S]*?restoreExplorerPreviewScrollPosition\(explorerScrollPosition\)/
  );
  assert.match(html, /function overviewArticlePathParts\(relativePath\)/);
  assert.match(html, /parts\[0\]\?\.toLowerCase\(\) === "handwave"/);
  assert.match(html, /function buildOverviewArticleTree\(items\)/);
  assert.match(html, /function renderOverviewArticleFolder\(node\)/);
  assert.match(html, /sortedOverviewArticleFolders\(node\)\.map\(renderOverviewArticleFolder\)/);
  assert.match(html, /sortedOverviewFolderArticles\(node\)\.map\(renderOverviewItem\)/);
  assert.match(html, /data-overview-folder-toggle/);
  assert.match(html, /overviewArticleFolderExpansion\.set\(folderPath, !expanded\)/);
  assert.match(
    html,
    /function focusSelectedArticleAnchor\(\) \{[\s\S]*?if \(hashIndex < 0\) \{\s*preview\.scrollTop = 0;\s*updateArticleTocSelectionFromScroll\(\);/
  );
  assert.match(html, /pendingArticleScrollPosition = message\.preserveScroll === true/);
  assert.match(html, /preserveScroll: true/);
  assert.match(html, /\.preview \{[\s\S]*?overflow-anchor: none;/);
  assert.doesNotMatch(html, /restoredScrollTop/);
  assert.match(
    html,
    /queueMathTypeset\([\s\S]*?if \(scrollPosition\) \{\s*restoreArticleScrollPosition\(scrollPosition\);\s*\} else \{\s*focusSelectedArticleAnchor\(\);/
  );
  assert.match(
    html,
    /function replacePreviewContent\(htmlContent\) \{\s*rememberHandwaveViewModes\(preview\);\s*rememberViewerInfoSectionExpansion\(preview\);\s*replaceTypesetContent\(preview, htmlContent\);\s*restoreHandwaveViewModes\(preview\);\s*restoreViewerInfoSectionExpansion\(preview\);/
  );
  assert.match(html, /function viewerInfoSectionKey\(section\)/);
  assert.match(html, /function rememberViewerInfoSectionExpansion\(root\)/);
  assert.match(html, /function restoreViewerInfoSectionExpansion\(root\)/);
  assert.match(
    html,
    /'<details class="viewer-info-section" data-viewer-info-section="' \+ html\(title\) \+ '" open>'/
  );
  assert.match(
    html,
    /'<summary class="viewer-info-title">' \+ html\(title\) \+ '<\/summary>'/
  );
  assert.match(html, /applyHandwaveSectionMode\(section, nextMode, lastMode\)[\s\S]*?rememberHandwaveViewMode\(section\);/);
  assert.match(
    html,
    /replacePreviewContent\(\s*\(theorem \? injectPreviewMilestoneControl\(previewHtml, theorem\) : previewHtml\) \+ viewerInfo/
  );
  assert.match(html, /message\.type === "setStatuses"/);
  assert.equal((html.match(/data-status-filter="/g) ?? []).length, 4);
  assert.match(html, /data-status-filter="green"[^>]*>✓<\/button>/);
  assert.match(html, /data-status-filter="yellow"[^>]*>✓<\/button>/);
  assert.match(html, /data-status-filter="red"[^>]*>✗<\/button>/);
  assert.match(html, /data-status-filter="unknown"[^>]*>\?<\/button>/);
  assert.match(html, /let enabledStatusFilters = new Set\(statusFilterCategories\);/);
  assert.match(html, /enabledStatusFilters\.has\(theoremStatusCategory\(theorem\)\)/);
  assert.match(html, /theorem\.statusCategory = nextCategory;/);
  assert.match(html, /graph-node-status/);
  assert.match(html, /\.preview \.theorem-line > \.check-status \{\s*left: -1\.55em;/);
  assert.match(html, /padding: 10px 12px 16px 30px;/);
  assert.match(
    html,
    /\.preview \.theorem-view \+ \.theorem-view,[\s\S]*margin-top: 1\.25em;/
  );
  const scripts = [...html.matchAll(/<script(?: [^>]*)?>([\s\S]*?)<\/script>/g)];
  assert.doesNotThrow(() => new Function(scripts.at(-1)?.[1] ?? ""));
});

test("indexes theorem statement and proof definition references separately", () => {
  const declarations = parseLeanDocument(`namespace Other

def used (value : Nat) : Nat := value

end Other

namespace Demo

def seed : Nat := 0

def used (value : Nat) : Nat := seed + value

def proofOnly : True := True.intro

theorem proof_only_statement : proofOnly = True.intro := by
  rfl

structure Box where
  value : Nat

def Box.measure (box : Box) : Nat := box.value

namespace Box

variable (system : Box)

def HasLocalTransitions : Prop := True

structure SingleValuedContinuation where
  value : Nat

theorem section_variable_refs
    (htransitions : system.HasLocalTransitions) :
    Nonempty system.SingleValuedContinuation := by
  exact ⟨{ value := system.value }⟩

end Box

theorem statement_helper : True := True.intro

/--
%%handwave
name:
  A theorem using definitions
statement:
  The theorem compares the two values.
proof:
  The result follows immediately.
-/
theorem statement_refs (x : Nat) (box : Box) : used x = box.measure := by
  have _ := proofOnly
  have _ := used x
  exact statement_helper

end Demo
`, "/workspace/Definitions.lean");
  const index = new HandwaveIndex("/workspace", declarations, []);
  const theorem = declarations.find((declaration) => declaration.sourceName === "Demo.statement_refs");
  const sectionVariableTheorem = declarations.find(
    (declaration) => declaration.sourceName === "Demo.Box.section_variable_refs"
  );
  assert.ok(theorem);
  assert.ok(sectionVariableTheorem);
  assert.ok(sectionVariableTheorem.contextNames?.includes("system"));
  assert.doesNotMatch((theorem.contextNames ?? []).join(" "), /\bsystem\b/);

  assert.deepEqual(index.statementDefinitionsForLean(theorem.name), [
    "Demo.Box",
    "Demo.used",
    "Demo.Box.measure"
  ]);
  assert.doesNotMatch(
    index.statementDefinitionsForLean(theorem.name).join(" "),
    /proofOnly|Other\.used/
  );
  assert.deepEqual(index.proofDefinitionsForLean(theorem.name), ["Demo.proofOnly"]);
  assert.deepEqual(index.definitionReferencesForLean("Demo.used"), ["Demo.seed"]);
  assert.deepEqual(index.definitionReferencesForLean("Demo.seed"), []);
  assert.deepEqual(index.definitionReferencesForLean(theorem.name), []);
  assert.deepEqual(
    index.statementDefinitionsForLean(sectionVariableTheorem.name),
    [
      "Demo.Box.HasLocalTransitions",
      "Demo.Box.SingleValuedContinuation"
    ]
  );

  const preview = renderLeanDeclarationPreviewHtml(
    theorem,
    index,
    (target) => `command:${target}`,
    (target) => `editor:${target}`
  );
  assert.doesNotMatch(preview, /aria-label="Definitions referenced in theorem statement"/);
  const hover = renderArticleHtml(
    "@include{lean:Demo.statement_refs}",
    "/workspace/definition-references.hw.md",
    index,
    (target) => `command:${target}`
  );
  const dependencyTreeIndex = hover.indexOf('aria-label="Dependency tree"');
  const definitionReferencesIndex = hover.indexOf(
    'aria-label="Definitions referenced in theorem statement"'
  );
  assert.ok(dependencyTreeIndex >= 0);
  assert.ok(definitionReferencesIndex > dependencyTreeIndex);
  assert.match(hover, />Definitions</);
  assert.match(hover, /font-variant-caps: all-small-caps;/);
  assert.match(hover, /\.definition-reference-list \{\s*display: grid;\s*gap: 4px;/);
  assert.match(hover, /data-handwave-target="lean:Demo\.Box"/);
  assert.match(hover, /data-handwave-target="lean:Demo\.used"/);
  assert.match(hover, /data-handwave-target="lean:Demo\.Box\.measure"/);
  assert.doesNotMatch(preview, /data-handwave-target="lean:Demo\.proofOnly"/);
  assert.doesNotMatch(preview, /data-handwave-target="lean:Other\.used"/);

  const payload = buildTheoremExplorerPayload(index, declarations, ["/workspace"]);
  const explorerTheorem = payload.theorems.find((item) => item.name === theorem.name);
  const usedDefinition = payload.definitions.find((item) => item.name === "Demo.used");
  const proofOnlyDefinition = payload.definitions.find(
    (item) => item.name === "Demo.proofOnly"
  );
  const seedDefinition = payload.definitions.find((item) => item.name === "Demo.seed");
  assert.deepEqual(
    explorerTheorem?.definitions.map((link) => link.target),
    ["lean:Demo.Box", "lean:Demo.used", "lean:Demo.Box.measure", "lean:Demo.proofOnly"]
  );
  assert.deepEqual(
    explorerTheorem?.definitions.map((link) => link.proofOnly ?? false),
    [false, false, false, true]
  );
  assert.deepEqual(
    usedDefinition?.definitions.map((link) => link.target),
    ["lean:Demo.seed"]
  );
  assert.deepEqual(
    usedDefinition?.referencingTheorems.map((link) => link.target),
    ["lean:Demo.statement_refs"]
  );
  assert.equal(usedDefinition?.referencingTheorems[0]?.proofOnly, undefined);
  assert.deepEqual(
    proofOnlyDefinition?.referencingTheorems.map((link) => ({
      target: link.target,
      proofOnly: link.proofOnly ?? false
    })),
    [
      { target: "lean:Demo.proof_only_statement", proofOnly: false },
      { target: "lean:Demo.statement_refs", proofOnly: true }
    ]
  );
  assert.deepEqual(
    seedDefinition?.referencingDefinitions.map((link) => link.target),
    ["lean:Demo.used"]
  );
});

test("typesets only theorem explorer graph titles that contain math", () => {
  const declarations = parseLeanDocument(`/--
%%handwave
name:
  A space \\(X\\)
statement:
  The space $X$ has the required property.
-/
theorem legacy_graph_math : True := by
  trivial

/--
%%handwave
name:
  A map $f$
statement:
  The map $f$ has the required property.
-/
theorem dollar_graph_math : True := by
  trivial

/--
%%handwave
name:
  A plain graph title
statement:
  This title contains no formula.
-/
theorem plain_graph_title : True := by
  trivial
`, "/workspace/GraphMath.lean");
  const index = new HandwaveIndex("/workspace", declarations, []);
  const payload = buildTheoremExplorerPayload(index, declarations, ["/workspace"]);

  assert.equal(
    payload.theorems.find((theorem) => theorem.name === "legacy_graph_math")?.displayNameHasMath,
    true
  );
  assert.equal(
    payload.theorems.find((theorem) => theorem.name === "dollar_graph_math")?.displayNameHasMath,
    true
  );
  assert.equal(
    payload.theorems.find((theorem) => theorem.name === "plain_graph_title")?.displayNameHasMath,
    false
  );

  const html = renderTheoremExplorerHtml(payload);
  assert.match(html, /data-graph-math/);
  assert.match(html, /graph\.querySelectorAll\("\[data-graph-math\]"\)/);
  assert.match(html, /if \(graphMathTypesetScheduled\) \{\s*return;/);
  assert.match(html, /mathTypesetPromise = mathTypesetPromise/);
  assert.match(html, /mathJax\.typesetClear\(\[element\]\)/);
  const scripts = [...html.matchAll(/<script(?: [^>]*)?>([\s\S]*?)<\/script>/g)];
  assert.doesNotThrow(() => new Function(scripts.at(-1)?.[1] ?? ""));
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

test("renders theorem hover dependency tree with recursive incomplete dependencies", () => {
  const declarations = parseLeanDocument(dependencyTreeLeanText, "/workspace/DependencyTree.lean");
  const articleText = "@include{lean:DependencyTree.root_dep}";
  const article = parseArticleDocument(articleText, "/workspace/dependency-tree.hw.md");
  const index = new HandwaveIndex("/workspace", declarations, [article], new Map([
    ["DependencyTree.green_dep", leanStatus(true, "Lean axiom check reports no transitive dependency on sorryAx.")],
    ["DependencyTree.red_dep", leanStatus(false, "Lean declaration contains a direct `sorry`.")],
    [
      "DependencyTree.yellow_dep",
      leanStatus(
        false,
        "Unchecked dependencies: DependencyTree.red_dep.",
        ["DependencyTree.red_dep"],
        ["DependencyTree.red_dep"]
      )
    ],
    [
      "DependencyTree.root_dep",
      leanStatus(
        false,
        "Unchecked dependencies: DependencyTree.yellow_dep.",
        ["DependencyTree.yellow_dep"],
        ["DependencyTree.yellow_dep"]
      )
    ]
  ]));
  const html = renderArticleHtml(articleText, "/workspace/dependency-tree.hw.md", index, (target) => `command:${target}`);

  assert.deepEqual(index.dependenciesForLean("DependencyTree.root_dep"), ["DependencyTree.green_dep", "DependencyTree.yellow_dep"]);
  assert.deepEqual(index.dependenciesForLean("DependencyTree.yellow_dep"), ["DependencyTree.red_dep"]);
  assert.match(html, /\.theorem-line > \.check-status \{/);
  assert.match(html, /<span class="source-popover"><span class="source-popover-row">[\s\S]*<\/span><span class="dependency-tree" role="tree" aria-label="Dependency tree">/);
  assert.doesNotMatch(html, /<div class="dependency-tree"/);
  assert.match(html, /data-dependency-name="DependencyTree\.green_dep" data-dependency-status="checked"[\s\S]*aria-label="Lean checked">✓<\/span><a class="dependency-link" href="command:lean:DependencyTree\.green_dep" data-handwave-target="lean:DependencyTree\.green_dep" title="Open lean:DependencyTree\.green_dep">Complete dependency<\/a>/);
  assert.match(html, /data-dependency-name="DependencyTree\.yellow_dep" data-dependency-status="dependency-warning"[\s\S]*aria-label="Lean checked with unchecked dependencies">✓<\/span><a class="dependency-link" href="command:lean:DependencyTree\.yellow_dep" data-handwave-target="lean:DependencyTree\.yellow_dep" title="Open lean:DependencyTree\.yellow_dep">yellow_dep<\/a>[\s\S]*data-dependency-name="DependencyTree\.red_dep" data-dependency-status="unchecked"[\s\S]*aria-label="Lean unchecked">✗<\/span><a class="dependency-link" href="command:lean:DependencyTree\.red_dep" data-handwave-target="lean:DependencyTree\.red_dep" title="Open lean:DependencyTree\.red_dep">Incomplete dependency<\/a>/);

  const greenIndex = html.indexOf('data-dependency-name="DependencyTree.green_dep"');
  const yellowIndex = html.indexOf('data-dependency-name="DependencyTree.yellow_dep"');
  const redIndex = html.indexOf('data-dependency-name="DependencyTree.red_dep"');
  assert.ok(greenIndex >= 0 && yellowIndex > greenIndex && redIndex > yellowIndex);
});

test("resolves theorem dependencies used through local method notation", () => {
  const declarations = parseLeanDocument(dependencyTreeLeanText, "/workspace/DependencyTree.lean");
  const index = new HandwaveIndex("/workspace", declarations, []);

  assert.deepEqual(index.dependenciesForLean("DependencyTree.method_root"), ["DependencyTree.Wrapper.method_dep"]);
});

test("indexes private Lean declarations as dependency tree nodes", () => {
  const declarations = parseLeanDocument(privateDependencyLeanText, "/workspace/PrivateDependency.lean");
  const hiddenLeaf = declarationBySourceName(declarations, "PrivateDependency.hidden_leaf");
  const hiddenDep = declarationBySourceName(declarations, "PrivateDependency.hidden_dep");
  const articleText = "@include{lean:PrivateDependency.public_dep}";
  const article = parseArticleDocument(articleText, "/workspace/private-dependency.hw.md");

  assert.ok(hiddenLeaf);
  assert.ok(hiddenDep);
  assert.equal(hiddenLeaf.isPrivate, true);
  assert.equal(hiddenDep.isPrivate, true);
  assert.match(hiddenDep.name, /^PrivateDependency\.hidden_dep\._handwavePrivate_/);

  const index = new HandwaveIndex("/workspace", declarations, [article], new Map([
    [hiddenLeaf.name, leanStatus(false, "Lean declaration contains a direct `sorry`.")],
    [
      hiddenDep.name,
      leanStatus(
        false,
        `Unchecked dependencies: ${hiddenLeaf.name}.`,
        [hiddenLeaf.name],
        [hiddenLeaf.name]
      )
    ],
    [
      "PrivateDependency.public_dep",
      leanStatus(
        false,
        `Unchecked dependencies: ${hiddenDep.name}.`,
        [hiddenDep.name],
        [hiddenDep.name]
      )
    ]
  ]));
  const html = renderArticleHtml(articleText, "/workspace/private-dependency.hw.md", index, (target) => `command:${target}`);

  assert.ok(index.leanDeclarations.has("PrivateDependency.public_dep"));
  assert.ok(index.leanDeclarations.has(hiddenDep.name));
  assert.deepEqual(index.dependenciesForLean("PrivateDependency.public_dep"), [hiddenDep.name]);
  assert.deepEqual(index.dependenciesForLean(hiddenDep.name), [hiddenLeaf.name]);
  assert.match(
    html,
    new RegExp(
      `data-dependency-name="${escapeRegExp(hiddenDep.name)}" data-dependency-status="dependency-warning"[\\s\\S]*` +
      `title="Open lean:${escapeRegExp(hiddenDep.name)}">hidden_dep</a>[\\s\\S]*` +
      `data-dependency-name="${escapeRegExp(hiddenLeaf.name)}" data-dependency-status="unchecked"[\\s\\S]*` +
      `title="Open lean:${escapeRegExp(hiddenLeaf.name)}">hidden_leaf</a>`
    )
  );
});

test("keeps private Lean declarations out of full-file previews", () => {
  const declarations = parseLeanDocument(completePrivateDependencyLeanText, "/workspace/CompletePrivateDependency.lean");
  const hiddenDep = declarationBySourceName(declarations, "CompletePrivateDependency.hidden_dep");
  const index = new HandwaveIndex("/workspace", declarations, []);
  const html = renderLeanDocumentHtml(
    completePrivateDependencyLeanText,
    "/workspace/CompletePrivateDependency.lean",
    index,
    (target) => `command:${target}`
  );

  assert.ok(hiddenDep);
  assert.match(html, /CompletePrivateDependency\.public_dep/);
  assert.doesNotMatch(html, new RegExp(`<section class="theorem-view" id="${escapeRegExp(leanDeclarationAnchorId(hiddenDep.name))}"`));
});

test("renders pending theorem status while Lean status is unavailable", () => {
  const declarations = parseLeanDocument(unnamedLeanText, "/workspace/Unnamed.lean");
  const articleText = "@include{lean:mul_one_right}";
  const article = parseArticleDocument(articleText, "/workspace/unnamed.hw.md");
  const index = new HandwaveIndex("/workspace", declarations, [article]);
  const html = renderArticleHtml(articleText, "/workspace/unnamed.hw.md", index, (target) => `command:${target}`);

  assert.match(html, /class="check-status check-status-pending"[^>]*aria-label="Lean status pending">…<\/span><span class="declaration-label"><strong><a class="declaration-link"[^>]*>Theorem\.<\/a><\/strong>/);
});

test("renders inconclusive theorem status without pending animation", () => {
  const declarations = parseLeanDocument(unnamedLeanText, "/workspace/Unnamed.lean");
  const articleText = "@include{lean:mul_one_right}";
  const article = parseArticleDocument(articleText, "/workspace/unnamed.hw.md");
  const index = new HandwaveIndex("/workspace", declarations, [article], new Map([
    ["mul_one_right", {
      checked: false,
      ownChecked: false,
      dependencies: [],
      failedDependencies: [],
      inconclusive: true,
      reason: "Handwave could not finish the Lean dependency check for this declaration."
    }]
  ]));
  const html = renderArticleHtml(articleText, "/workspace/unnamed.hw.md", index, (target) => `command:${target}`);

  assert.match(html, /class="check-status check-status-inconclusive"[^>]*aria-label="Lean status unavailable">\?<\/span><span class="declaration-label"><strong><a class="declaration-link"[^>]*>Theorem\.<\/a><\/strong>/);
  assert.doesNotMatch(html, /aria-label="Lean status pending"/);
});

test("renders blocked theorem status without pending animation", () => {
  const declarations = parseLeanDocument(unnamedLeanText, "/workspace/Unnamed.lean");
  const articleText = "@include{lean:mul_one_right}";
  const article = parseArticleDocument(articleText, "/workspace/unnamed.hw.md");
  const index = new HandwaveIndex("/workspace", declarations, [article], new Map([
    ["mul_one_right", {
      checked: false,
      ownChecked: false,
      dependencies: [],
      failedDependencies: [],
      blocked: true,
      reason: "Handwave cannot run the Lean dependency check while this Lean file has errors."
    }]
  ]));
  const html = renderArticleHtml(articleText, "/workspace/unnamed.hw.md", index, (target) => `command:${target}`);

  assert.match(html, /class="check-status check-status-blocked"[^>]*aria-label="Lean dependency check blocked">!<\/span><span class="declaration-label"><strong><a class="declaration-link"[^>]*>Theorem\.<\/a><\/strong>/);
  assert.doesNotMatch(html, /aria-label="Lean status pending"/);
});

test("parses Lean axiom output for declarations with and without axioms", () => {
  const parsed = parseLeanAxiomOutput([
    "'clean_theorem' does not depend on any axioms",
    "'classical_theorem' depends on axioms: [propext, Classical.choice, Quot.sound]"
  ].join("\n"));

  assert.deepEqual(parsed.get("clean_theorem"), []);
  assert.deepEqual(parsed.get("classical_theorem"), ["propext", "Classical.choice", "Quot.sound"]);
});

test("renders stale theorem check status with parenthesized marks", () => {
  const declarations = parseLeanDocument(proofStatusLeanText, "/workspace/ProofStatus.lean");
  const articleText = [
    "@include{lean:checked_theorem}",
    "@include{lean:unchecked_theorem}",
    "@include{lean:depends_on_unchecked}"
  ].join("\n\n");
  const article = parseArticleDocument(articleText, "/workspace/proof-status.hw.md");
  const index = new HandwaveIndex("/workspace", declarations, [article], new Map([
    ["checked_theorem", { ...leanStatus(true, "previously checked"), stale: true, generation: 1 }],
    ["unchecked_theorem", { ...leanStatus(false, "previously unchecked"), stale: true, generation: 1 }],
    [
      "depends_on_unchecked",
      {
        ...leanStatus(false, "previously checked with sorry dependencies", ["sorryAx"], ["sorryAx"]),
        stale: true,
        generation: 1
      }
    ]
  ]));
  const html = renderArticleHtml(articleText, "/workspace/proof-status.hw.md", index, (target) => `command:${target}`);

  assert.match(html, /class="check-status check-status-checked check-status-stale"[^>]*aria-label="Lean checked, stale">\(✓\)<\/span>/);
  assert.match(html, /class="check-status check-status-unchecked check-status-stale"[^>]*aria-label="Lean unchecked, stale">\(✗\)<\/span>/);
  assert.match(html, /class="check-status check-status-dependency-warning check-status-stale"[^>]*aria-label="Lean checked with unchecked dependencies, stale">\(✓\)<\/span>/);
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
  const html = renderArticleHtml(
    "@include{lean:double}",
    "/workspace/natural-numbers.hw.md",
    index,
    (target) => `command:${target}`,
    { editorHref: (target) => `editor:${target}` }
  );

  assert.match(html, /class="definition-view"/);
  assert.match(html, /<strong><a class="declaration-link" href="command:lean:double" data-handwave-target="lean:double" title="Open lean:double">Definition \(Double\)\.<\/a><\/strong>/);
  assert.match(html, /class="source-popover"><span class="source-popover-row"><span class="view-switch" role="group" aria-label="Definition view".*<span class="source-popover-separator">\|<\/span><a href="editor:lean:double" title="Open double in editor">double<\/a><button class="copy-control" type="button" data-copy-target="lean:double" title="Copy lean:double" aria-label="Copy lean:double"><span class="copy-icon" aria-hidden="true"><\/span><span class="sr-only">Copy<\/span><\/button>/);
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
  const article = parseArticleDocument("Inline math $x^2 + y^2 = z^2$ and $\\fint_A^B f(x)\\,dx$.", "/workspace/math.hw.md");
  const index = new HandwaveIndex("/workspace", declarations, [article]);
  const html = renderArticleHtml("Inline math $x^2 + y^2 = z^2$ and $\\fint_A^B f(x)\\,dx$.", "/workspace/math.hw.md", index, (target) => `command:${target}`);

  assert.match(html, /window\.MathJax/);
  assert.match(html, /tex-chtml\.js/);
  assert.match(html, /\$x\^2 \+ y\^2 = z\^2\$/);
  assert.match(html, /\$\\fint_A\^B f\(x\)\\,dx\$/);
  assert.equal(handwaveMathJaxConfiguration.tex.macros.fint, "\\rlap{\\mkern2mu-}\\!\\int");
  assert.ok(html.includes(JSON.stringify(handwaveMathJaxConfiguration.tex.macros.fint)));
});

test("does not interpret square brackets in formulas as Markdown links", () => {
  const declarations = parseLeanDocument(leanText, "/workspace/Nat.lean");
  const articleText = [
    "Inline $F[x](y)$, display $$G[x](y)$$, TeX inline \\(H[x](y)\\), and TeX display \\[K[x](y)\\].",
    "",
    "A real [linked formula $F[x](y)$](lean:my_add_assoc) still works, while `code[x](y)` stays code."
  ].join("\n");
  const article = parseArticleDocument(articleText, "/workspace/brackets.hw.md");
  const index = new HandwaveIndex("/workspace", declarations, [article]);
  const html = renderArticleHtml(articleText, "/workspace/brackets.hw.md", index, (target) => `command:${target}`);

  assert.match(html, /\$F\[x\]\(y\)\$/);
  assert.match(html, /\$\$G\[x\]\(y\)\$\$/);
  assert.match(html, /\\\(H\[x\]\(y\)\\\)/);
  assert.match(html, /\\\[K\[x\]\(y\)\\\]/);
  assert.doesNotMatch(html, /href="y"/);
  assert.match(html, /href="command:lean:my_add_assoc"[^>]*>linked formula \$F\[x\]\(y\)\$<\/a>/);
  assert.match(html, /<code>code\[x\]\(y\)<\/code>/);
});

test("renders LaTeX-style text dashes without changing code, math, or link targets", () => {
  const declarations = parseLeanDocument(`/--
%%handwave
name:
  Range -- theorem
statement:
  The range is 1--5.
proof:
  This follows --- directly.
-/
theorem dashRange : True := by
  -- keep--lean
  trivial
`, "/workspace/Dashes.lean");
  const articleText = [
    "# Dashes -- in prose",
    "",
    "Pages 1--5 --- a range; [linked -- label](https://example.com/a--b).",
    "",
    "Keep `$x--y$`, `code--flag`, and https://example.com/a--b unchanged.",
    "",
    "@include{lean:dashRange}"
  ].join("\n");
  const article = parseArticleDocument(articleText, "/workspace/dashes.hw.md");
  const index = new HandwaveIndex("/workspace", declarations, [article]);
  const html = renderArticleHtml(articleText, "/workspace/dashes.hw.md", index, (target) => `command:${target}`);

  assert.match(html, /<h1 id="dashes-in-prose">Dashes – in prose<\/h1>/);
  assert.match(html, /Pages 1–5 — a range/);
  assert.match(html, /href="https:\/\/example\.com\/a--b"[^>]*>linked – label<\/a>/);
  assert.match(html, /\$x--y\$/);
  assert.match(html, /<code>code--flag<\/code>/);
  assert.match(html, /https:\/\/example\.com\/a--b unchanged/);
  assert.match(html, /Theorem \(Range – theorem\)\./);
  assert.match(html, /The range is 1–5\./);
  assert.match(html, /This follows — directly\./);
  assert.match(html, /<span class="lean-comment">-- keep--lean<\/span>/);
});

test("renders Markdown emphasis in articles and declaration prose", () => {
  const declarations = parseLeanDocument(`/--
%%handwave
name:
  An **important** definition
statement:
  This is *italic*, **bold**, and ***both***.
-/
def emphasizedDefinition : Nat := 0
`, "/workspace/Emphasis.lean");
  const articleText = [
    "# *Emphasized* article",
    "",
    "Text with *asterisk italics*, _underscore italics_, **asterisk bold**, and __underscore bold__.",
    "",
    "A [**bold** and *italic* link](lean:emphasizedDefinition), plus **[a bold link](lean:emphasizedDefinition)**.",
    "",
    "Keep `$x_*not emphasis*$`, `**not bold**`, and https://example.com/a--b unchanged.",
    "",
    "@include{lean:emphasizedDefinition}"
  ].join("\n");
  const article = parseArticleDocument(articleText, "/workspace/emphasis.hw.md");
  const index = new HandwaveIndex("/workspace", declarations, [article]);
  const html = renderArticleHtml(articleText, article.uri, index, (target) => `command:${target}`);

  assert.match(html, /<h1 id="emphasized-article"><em>Emphasized<\/em> article<\/h1>/);
  assert.match(html, /Text with <em>asterisk italics<\/em>, <em>underscore italics<\/em>, <strong>asterisk bold<\/strong>, and <strong>underscore bold<\/strong>\./);
  assert.match(html, /<a href="command:lean:emphasizedDefinition"[^>]*><strong>bold<\/strong> and <em>italic<\/em> link<\/a>/);
  assert.match(html, /<strong><a href="command:lean:emphasizedDefinition"[^>]*>a bold link<\/a><\/strong>/);
  assert.match(html, /Keep <code>\$x_\*not emphasis\*\$<\/code>, <code>\*\*not bold\*\*<\/code>, and https:\/\/example\.com\/a--b unchanged\./);
  assert.match(html, /Definition \(An <strong>important<\/strong> definition\)\./);
  assert.match(html, /This is <em>italic<\/em>, <strong>bold<\/strong>, and <em><strong>both<\/strong><\/em>\./);
});

test("renders quoted article lines as blockquotes", () => {
  const articleText = [
    "Before.",
    "",
    "> A **bold quotation**",
    "> continued with *italics*.",
    ">",
    "> A second paragraph with a [term](term:quotation).",
    "",
    "After."
  ].join("\n");
  const article = parseArticleDocument(articleText, "/workspace/quotes.hw.md");
  const index = new HandwaveIndex("/workspace", [], [article]);
  const html = renderArticleFragmentHtml(articleText, article.uri, index, (target) => `command:${target}`, {
    editableArticles: true
  });

  assert.match(html, /<blockquote class="article-editable-block"><button class="article-block-edit"[^>]*aria-label="Edit this quote">Edit<\/button><p>A <strong>bold quotation<\/strong> continued with <em>italics<\/em>\.<\/p>\s*<p>A second paragraph with a <a href="term:quotation"[^>]*>term<\/a>\.<\/p><\/blockquote>/);
  assert.doesNotMatch(html, /> A \*\*bold quotation/);
  assert.match(html, /<p class="article-editable-block"><button[^>]*>Edit<\/button>After\.<\/p>/);
});

test("renders CommonMark lists and nested blocks from the shared syntax tree", () => {
  const articleText = [
    "- **first** item",
    "  - nested *item* with a [link](article:next)",
    "  - math `$a_*b*$`",
    "  @include{lean:listItem}",
    "- second item",
    "",
    "3. third item",
    "4. fourth item",
    "",
    "- loose first paragraph",
    "",
    "  second paragraph",
    "",
    "> Quoted list:",
    ">",
    "> - one",
    "> - two"
  ].join("\n");
  const article = parseArticleDocument(articleText, "/workspace/lists.hw.md");
  const index = new HandwaveIndex("/workspace", [], [article]);
  const html = renderArticleFragmentHtml(
    articleText,
    article.uri,
    index,
    (target) => `command:${target}`,
    { editableArticles: true }
  );

  assert.match(html, /<div class="article-editable-block article-editable-list"><button class="article-block-edit"[^>]*data-edit-offset="2"[^>]*aria-label="Edit this list">Edit<\/button><ul>/);
  assert.match(html, /<li><strong>first<\/strong> item\s*<ul><li>nested <em>item<\/em> with a <a href="command:article:next"[^>]*>link<\/a><\/li>/);
  assert.match(html, /<li>math <code>\$a_\*b\*\$<\/code><\/li><\/ul>/);
  assert.match(html, /<div class="include unresolved">Unresolved include: <code>lean:listItem<\/code><\/div>/);
  assert.match(html, /<ol start="3"><li>third item<\/li>\s*<li>fourth item<\/li><\/ol>/);
  assert.match(html, /<ul><li><p>loose first paragraph<\/p>\s*<p>second paragraph<\/p><\/li><\/ul>/);
  assert.match(html, /<blockquote class="article-editable-block">[\s\S]*?<p>Quoted list:<\/p>\s*<ul><li>one<\/li>\s*<li>two<\/li><\/ul><\/blockquote>/);
});

test("renders standard code, images, reference links, and unsafe HTML safely", () => {
  const articleText = [
    "Reference [documentation][docs], inline `x < y`, and ![an *image*](diagram.svg \"Diagram\").",
    "",
    "~~~ts",
    "const marker = '**not bold**';",
    "~~~",
    "",
    "<script>",
    "alert('not executable')",
    "</script>",
    "",
    "[unsafe](javascript:alert(1))",
    "",
    "[docs]: article:guide"
  ].join("\n");
  const article = parseArticleDocument(articleText, "/workspace/standard-markdown.hw.md");
  const index = new HandwaveIndex("/workspace", [], [article]);
  const html = renderArticleFragmentHtml(articleText, article.uri, index, (target) => `command:${target}`);

  assert.deepEqual(article.links.map(({ target }) => target), [
    "article:guide",
    "javascript:alert(1)"
  ]);
  assert.match(html, /<a href="command:article:guide"[^>]*>documentation<\/a>/);
  assert.match(html, /<code>x &lt; y<\/code>/);
  assert.match(html, /<img src="diagram\.svg" alt="an image" title="Diagram">/);
  assert.match(html, /<pre><code class="language-ts">const marker = '\*\*not bold\*\*';<\/code><\/pre>/);
  assert.match(html, /<pre><code>&lt;script&gt;[\s\S]*?&lt;\/script&gt;<\/code><\/pre>/);
  assert.doesNotMatch(html, /<script>\s*alert\('not executable'\)/);
  assert.doesNotMatch(html, /href="javascript:/);
  assert.match(html, /<p>unsafe<\/p>/);
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
  assert.match(html, /const viewModes = collectHandwaveViewModes\(content\)/);
  assert.match(html, /restoreHandwaveViewModes\(content, viewModes\)/);
});

test("renders theorem targets as reduced dependency views", () => {
  const source = `namespace LocalContext

/--
%%handwave
name:
  Complete dependency
statement:
  This dependency is complete.
-/
theorem green_dep : True := by
  trivial

/--
%%handwave
name:
  Incomplete dependency
statement:
  This dependency is incomplete.
-/
theorem red_dep : True := by
  sorry

/--
%%handwave
statement:
  This dependency is proved, but it relies on an incomplete theorem.
-/
theorem yellow_dep : True := by
  exact red_dep

/--
%%handwave
statement:
  This theorem is not needed for the target theorem.
-/
theorem unrelated_dep : True := by
  trivial

/--
%%handwave
statement:
  This theorem depends on both a complete theorem and a theorem with incomplete dependencies.
-/
theorem root_dep : True := by
  have _ := green_dep
  exact yellow_dep

end LocalContext
`;
  const declarations = parseLeanDocument(source, "/workspace/LocalContext.lean");
  const index = new HandwaveIndex("/workspace", declarations, [], new Map([
    ["LocalContext.green_dep", leanStatus(true, "Lean axiom check reports no transitive dependency on sorryAx.")],
    ["LocalContext.red_dep", leanStatus(false, "Lean declaration contains a direct `sorry`.")],
    [
      "LocalContext.yellow_dep",
      leanStatus(
        false,
        "Unchecked dependencies: LocalContext.red_dep.",
        ["LocalContext.red_dep"],
        ["LocalContext.red_dep"]
      )
    ],
    [
      "LocalContext.root_dep",
      leanStatus(
        false,
        "Unchecked dependencies: LocalContext.yellow_dep.",
        ["LocalContext.yellow_dep"],
        ["LocalContext.yellow_dep"]
      )
    ]
  ]));
  const html = renderLeanDocumentHtml(
    source,
    "/workspace/LocalContext.lean",
    index,
    (target) => `command:${target}`,
    { currentTarget: "lean:LocalContext.root_dep", focusId: "lean-LocalContext-root_dep" }
  );

  assert.match(html, /<h1>root_dep<\/h1>/);
  assert.match(html, /<section class="theorem-view" id="lean-LocalContext-green_dep" data-target="lean:LocalContext\.green_dep">/);
  assert.match(html, /<section class="theorem-view" id="lean-LocalContext-red_dep" data-target="lean:LocalContext\.red_dep">/);
  assert.match(html, /<section class="theorem-view" id="lean-LocalContext-yellow_dep" data-target="lean:LocalContext\.yellow_dep">/);
  assert.match(html, /<section class="theorem-view" id="lean-LocalContext-root_dep" data-target="lean:LocalContext\.root_dep">/);
  assert.doesNotMatch(html, /lean:LocalContext\.unrelated_dep/);

  const greenIndex = html.indexOf('data-target="lean:LocalContext.green_dep"');
  const redIndex = html.indexOf('data-target="lean:LocalContext.red_dep"');
  const yellowIndex = html.indexOf('data-target="lean:LocalContext.yellow_dep"');
  const rootIndex = html.indexOf('data-target="lean:LocalContext.root_dep"');
  assert.ok(greenIndex >= 0 && redIndex > greenIndex && yellowIndex > redIndex && rootIndex > yellowIndex);
});
