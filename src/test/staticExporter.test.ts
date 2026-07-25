import * as assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import { promises as fs } from "node:fs";
import { test } from "node:test";
import { handwaveMathJaxConfiguration } from "../handwave/mathJax";
import { parseLeanDocument } from "../handwave/parser";
import { loadStaticLeanArtifactMetadata } from "../static/artifacts";
import { buildHandwaveStaticSite, exportHandwaveStaticSite } from "../static/exporter";

const sampleLean = `def StaticSample.zero : Nat := 0

def StaticSample.value : Nat := StaticSample.zero

/--
%%handwave
name:
  Base theorem for $P$
statement:
  The base proposition is true.
proof:
  This is immediate.
-/
theorem StaticSample.base : StaticSample.value = 0 := by
  rfl

/--
%%handwave
name:
  Incomplete theorem
statement:
  The incomplete proposition is true.
proof:
  The formal proof is not yet complete.
-/
theorem StaticSample.incomplete : True := by
  sorry

/--
%%handwave
name:
  Source-inferred theorem
statement:
  The source-inferred proposition is true.
proof:
  This is immediate.
-/
theorem StaticSample.inferred : True := by
  trivial
`;

const shadowLean = `/--
%%handwave
name:
  Shadow copy that must not leak
statement:
  This challenge copy must not replace the indexed theorem.
proof:
  This unfinished proof must not affect the indexed theorem's status.
tags:
  shadow
-/
theorem StaticSample.base : True := by
  sorry
`;

test("uses available ilean dependencies when the source has a newer mtime", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "handwave-available-ilean-"));
  try {
    const source = [
      "theorem StaleArtifact.dep : True := by trivial",
      "",
      "theorem StaleArtifact.root : True := by",
      "  exact StaleArtifact.dep",
      ""
    ].join("\n");
    const leanFile = path.join(root, "Project", "Stale.lean");
    await fs.mkdir(path.dirname(leanFile), { recursive: true });
    await fs.writeFile(leanFile, source, "utf8");
    const declarations = parseLeanDocument(source, leanFile);
    const dependency = declarations.find((declaration) => declaration.name === "StaleArtifact.dep");
    const parent = declarations.find((declaration) => declaration.name === "StaleArtifact.root");
    assert.ok(dependency);
    assert.ok(parent);

    const positions = (declaration: typeof dependency) => [
      declaration.range.start.line,
      declaration.range.start.character,
      declaration.range.end.line,
      declaration.range.end.character,
      declaration.nameRange.start.line,
      declaration.nameRange.start.character,
      declaration.nameRange.end.line,
      declaration.nameRange.end.character
    ];
    const referenceKey = JSON.stringify({
      c: { m: "Project.Stale", n: dependency.name }
    });
    const artifactBase = path.join(root, ".lake", "build", "lib", "lean", "Project", "Stale");
    await fs.mkdir(path.dirname(artifactBase), { recursive: true });
    await fs.writeFile(`${artifactBase}.ilean`, JSON.stringify({
      version: 1,
      module: "Project.Stale",
      references: {
        [referenceKey]: {
          definition: null,
          usages: [[
            parent.nameRange.start.line,
            parent.nameRange.start.character,
            parent.nameRange.end.line,
            parent.nameRange.end.character,
            parent.name
          ]]
        }
      },
      decls: {
        [dependency.name]: positions(dependency),
        [parent.name]: positions(parent)
      }
    }), "utf8");

    const newer = new Date(Date.now() + 10_000);
    await fs.utimes(leanFile, newer, newer);
    const metadata = await loadStaticLeanArtifactMetadata(root, declarations);
    assert.equal(
      metadata.declarations.find((declaration) => declaration.name === dependency.name)?.artifactName,
      dependency.name
    );
    assert.deepEqual(metadata.dependencyGraph.get(parent.name), [dependency.name]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("builds a self-contained static theorem explorer without workspace path leaks", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "handwave-static-"));
  try {
    await fs.mkdir(path.join(root, "Project"), { recursive: true });
    await fs.mkdir(path.join(root, "handwave"), { recursive: true });
    await fs.mkdir(path.join(root, "handwave", "Alpha", "Nested"), { recursive: true });
    await fs.mkdir(path.join(root, "handwave", "Beta"), { recursive: true });
    await fs.mkdir(path.join(root, "out"), { recursive: true });
    const leanFile = path.join(root, "Project", "Sample.lean");
    await fs.writeFile(leanFile, sampleLean, "utf8");
    await fs.writeFile(path.join(root, "Project", "ZChallenge.lean"), shadowLean, "utf8");
    await writeSampleArtifacts(root, leanFile);
    await fs.writeFile(
      path.join(root, "handwave", "sample.hw.md"),
      [
        "# Sample",
        "",
        "[The base result](lean:StaticSample.base)",
        "",
        "@include{lean:StaticSample.base}",
        "",
        "## Details {#details}",
        "",
        "[Return to details](local:#details)",
        "",
        "### Further details",
        "",
        "A nested section."
      ].join("\n"),
      "utf8"
    );
    await fs.writeFile(
      path.join(root, "handwave", "Alpha", "alpha.hw.md"),
      "# Alpha article\n",
      "utf8"
    );
    await fs.writeFile(
      path.join(root, "handwave", "Alpha", "Nested", "nested.hw.md"),
      "# Nested article\n",
      "utf8"
    );
    await fs.writeFile(
      path.join(root, "handwave", "Beta", "beta.hw.md"),
      "# Beta article\n",
      "utf8"
    );
    await fs.writeFile(
      path.join(root, "out", "Ignored.lean"),
      "theorem ignored : True := by trivial\n",
      "utf8"
    );

    const site = await buildHandwaveStaticSite(root);
    assert.equal(site.declarationCount, 5);
    assert.equal(site.theoremCount, 3);
    assert.equal(site.articleCount, 4);
    assert.doesNotMatch(site.html, new RegExp(escapeRegExp(root)));
    assert.match(site.html, /const previewHtmlByName = new Map\(\[\[/);
    assert.match(site.html, /const articleHtmlByTarget = new Map\(\[\[/);
    assert.match(site.html, /const articleSearchItems = \[\{/);
    assert.match(site.html, /const applicationShellEnabled = true;/);
    assert.ok(site.html.includes(JSON.stringify(handwaveMathJaxConfiguration.tex.macros.fint)));
    assert.match(site.html, /article:handwave\/sample\.hw\.md/);
    assert.match(site.html, /"title":"Sample","relativePath":"handwave\/sample\.hw\.md"/);
    assert.match(site.html, /"relativePath":"handwave\/Alpha\/alpha\.hw\.md"/);
    assert.match(site.html, /"relativePath":"handwave\/Alpha\/Nested\/nested\.hw\.md"/);
    assert.match(site.html, /"relativePath":"handwave\/Beta\/beta\.hw\.md"/);
    assert.match(site.html, /id="navigation-toggle"/);
    assert.match(site.html, /data-view="overview"/);
    assert.match(site.html, /data-switch-view="overview"/);
    assert.match(site.html, /data-switch-view="explorer"/);
    assert.match(site.html, /data-switch-view="article"/);
    assert.match(site.html, /placeholder="Search articles, modules, theorems, or definitions"/);
    assert.match(site.html, /id="overview-articles"/);
    assert.doesNotMatch(site.html, /id="overview-modules"/);
    assert.match(site.html, /id="overview-milestones"/);
    assert.match(site.html, /grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
    assert.match(site.html, /function renderOverview\(\)/);
    assert.match(site.html, /data-overview-type=/);
    assert.match(site.html, /overview\?\.addEventListener\("click"/);
    assert.match(
      site.html,
      /function applySearchSelection\(item\) \{[\s\S]*?renderExplorerGraph\(\);\s*recordApplicationHistory\("push"\);\s*\}/
    );
    const graphClickHandler = site.html.match(
      /graph\.addEventListener\("click",[\s\S]*?(?=graph\.addEventListener\("dblclick")/
    )?.[0];
    assert.ok(graphClickHandler);
    assert.match(graphClickHandler, /updateGraphSelection\(\);/);
    assert.doesNotMatch(graphClickHandler, /recordApplicationHistory/);
    assert.match(
      site.html,
      /function historyRootTheoremName\(\) \{[\s\S]*?searchSelection\?\.type === "theorem"[\s\S]*?searchSelection\?\.type === "definition"/
    );
    assert.match(
      site.html,
      /function openTargetLocally\(target\) \{[\s\S]*?restrictToTheorem\(theorem\);/
    );
    assert.match(site.html, /id="search-rendered"/);
    assert.match(site.html, /Base theorem for \$P\$/);
    assert.match(site.html, /function containsMathDelimiter\(value\)/);
    assert.match(site.html, /data-search-math/);
    assert.match(site.html, /scheduleSearchMathTypeset\(\)/);
    assert.match(site.html, /function updateRenderedSearchValue\(\)/);
    assert.match(site.html, /id="theme-toggle"/);
    assert.equal((site.html.match(/data-status-filter="/g) ?? []).length, 4);
    assert.match(site.html, /aria-label="Theorem status filters"/);
    assert.match(site.html, /statusFilters: statusFilterCategories\.filter/);
    assert.match(site.html, /\.explorer-application\[data-view="article"\] \.graph/);
    assert.match(
      site.html,
      /\.graph-node:hover,\s*\.graph-node-selected \{\s*background: color-mix\(in srgb, currentColor 9%, var\(--page-background\)\);/
    );
    assert.match(site.html, /StaticSample\.base/);
    assert.match(site.html, /StaticSample\.value/);
    assert.doesNotMatch(site.html, /Shadow copy that must not leak/);
    assert.doesNotMatch(site.html, /challenge copy must not replace/);
    assert.match(site.html, /check-status-checked/);
    assert.match(site.html, /check-status-unchecked/);
    const theoremPayload = staticTheoremPayload(site.html);
    assert.match(
      theoremPayload.find((theorem) => theorem.name === "StaticSample.base")?.statusHtml ?? "",
      /check-status-checked/
    );
    assert.equal(
      theoremPayload.find((theorem) => theorem.name === "StaticSample.base")?.statusCategory,
      "green"
    );
    assert.equal(
      theoremPayload.find((theorem) => theorem.name === "StaticSample.incomplete")?.statusCategory,
      "red"
    );
    assert.ok(theoremPayload.every((theorem) => !theorem.statusHtml.includes("check-status-pending")));
    const explorerPayload = staticExplorerPayload(site.html);
    const valueDefinition = explorerPayload.definitions.find(
      (definition) => definition.name === "StaticSample.value"
    );
    assert.deepEqual(
      valueDefinition?.referencingTheorems.map((link) => link.target),
      ["lean:StaticSample.base"]
    );
    assert.deepEqual(
      valueDefinition?.definitions.map((link) => link.target),
      ["lean:StaticSample.zero"]
    );
    assert.deepEqual(
      explorerPayload.definitions.find((definition) => definition.name === "StaticSample.zero")
        ?.referencingDefinitions.map((link) => link.target),
      ["lean:StaticSample.value"]
    );
    assert.match(
      theoremPayload.find((theorem) => theorem.name === "StaticSample.inferred")?.statusHtml ?? "",
      /Static source analysis/
    );
    assert.match(site.html, /previewHtml \+ viewerInfo/);
    assert.match(site.html, /if \(!openTargetLocally\(targetName\)\)/);
    assert.match(site.html, /staticArticleTarget\(target\)/);
    assert.match(site.html, /focusSelectedArticleAnchor\(\)/);
    assert.match(site.html, /class="article-toc" aria-label="Table of contents"/);
    assert.match(site.html, /function renderArticleTableOfContents\(\)/);
    assert.match(site.html, /h1\[id\],h2\[id\],h3\[id\],h4\[id\],h5\[id\],h6\[id\]/);
    assert.match(site.html, /data-toc-fold/);
    assert.match(site.html, /data-toc-target=/);
    assert.match(site.html, /class="article-toc-children"/);
    assert.match(site.html, /isTitle: index === 0 && heading\.tagName === "H1"/);
    assert.match(site.html, /node\.children\.length > 0 && !node\.isTitle/);
    assert.match(site.html, /article-toc-title-link/);
    assert.match(site.html, /article-toc-title-item/);
    assert.match(site.html, /\.article-toc-title-item > \.article-toc-children/);
    assert.match(site.html, /position: sticky/);
    assert.match(site.html, /scrollArticleToAnchor\(anchorId, "smooth"\)/);
    assert.match(site.html, /function updateArticleTocSelectionFromScroll\(\)/);
    assert.match(site.html, /preview\.addEventListener\("scroll", scheduleArticleTocSelectionUpdate/);
    assert.match(site.html, /revealArticleTocLink\(currentLink\)/);
    assert.match(site.html, /selectedArticleTarget = articleBase \+ "#" \+ anchorId/);
    assert.match(site.html, /background: var\(--page-background\)/);
    assert.match(site.html, /\.preview \.source-popover \{/);
    assert.match(site.html, /\.preview \.theorem-line > \.check-status \{/);
    assert.match(site.html, /\.preview \.theorem-view \+ \.theorem-view,/);
    const basePreview = staticPreviewHtml(site.html, "StaticSample.base");
    assert.match(basePreview, /aria-label="Theorem view"/);
    assert.match(basePreview, /aria-label="Proof view"/);
    assert.equal((basePreview.match(/data-set-mode="lean"/g) ?? []).length, 2);
    assert.match(basePreview, /class="source-name" title="Lean declaration StaticSample\.base"/);
    assert.doesNotMatch(basePreview, /title="Open StaticSample\.base in editor"/);
    assert.doesNotMatch(basePreview, /aria-label="Definitions referenced in theorem statement"/);
    assert.match(site.html, /"Definitions used by this definition"/);
    assert.match(
      staticArticleHtml(site.html, "article:handwave/sample.hw.md"),
      /aria-label="Definitions referenced in theorem statement"/
    );
    const definitionPreview = staticPreviewHtml(site.html, "StaticSample.value");
    assert.match(definitionPreview, /class="definition-view"/);
    assert.match(site.html, /applyHandwaveSectionMode\(section, nextMode/);
    assert.match(site.html, /function showArticle\(target, updateSearch = false, recordHistory = true\)/);
    assert.match(
      site.html,
      /const articleLoaded = articleHtmlByTarget\.has\(base\);[\s\S]*?type: "openPreview", target, recordHistory: false/
    );
    assert.match(site.html, /\.preview \.milestone-control-active \{\s*color: var\(--warning\);/);
    assert.match(site.html, /function updateMilestoneControls\(target, active\)/);
    assert.match(
      site.html,
      /if \(applicationShellEnabled && application\?\.dataset\.view === "article"\) \{\s*return true;\s*\}/
    );
    assert.match(site.html, /function switchApplicationView\(view, recordHistory = true\)/);
    assert.match(site.html, /window\.history\.pushState\(state, "", url\)/);
    assert.match(site.html, /window\.addEventListener\("popstate"/);
    assert.match(site.html, /function restoreApplicationHistory\(rawState\)/);
    assert.match(
      site.html,
      /const validArticleTarget = Boolean\(articleBase && articleItemForTarget\(articleTarget\)\)/
    );
    assert.doesNotMatch(
      site.html,
      /if \(articleTarget && articleBase && articleHtmlByTarget\.has\(articleBase\) && article\)/
    );
    assert.match(site.html, /"#article=" \+ encodeURIComponent\(state\.articleTarget\)/);
    assert.match(
      site.html,
      /state\.searchSelection\?\.type === "definition" \? "#definition=" : "#theorem="/
    );
    assert.match(site.html, /decodedHistoryValue\("#definition="\)/);
    assert.match(site.html, /"#module=" \+ encodeURIComponent\(state\.searchSelection\.value\)/);
    assert.match(site.html, /return "#overview"/);
    assert.match(
      site.html,
      /view: window\.location\.hash === "#explorer" \? "explorer" : "overview"/
    );
    assert.match(site.html, /localStorage\.setItem\("handwave-theme", nextTheme\)/);
    assert.match(site.html, /Return to details/);
    assert.doesNotMatch(
      site.html,
      /injectPreviewMilestoneControl\(previewHtml, theorem\) \+ renderViewerInfo\(theorem\)/
    );
    const scripts = [...site.html.matchAll(/<script(?: [^>]*)?>([\s\S]*?)<\/script>/g)];
    for (const script of scripts) {
      assert.doesNotThrow(() => new Function(script[1]));
    }

    const output = path.join(root, "site", "index.html");
    const exported = await exportHandwaveStaticSite(root, output);
    assert.equal(exported.outputFile, output);
    assert.equal(await fs.readFile(output, "utf8"), exported.html);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

async function writeSampleArtifacts(root: string, leanFile: string): Promise<void> {
  const declarations = parseLeanDocument(sampleLean, leanFile);
  const artifactBase = path.join(root, ".lake", "build", "lib", "lean", "Project", "Sample");
  const trace = Buffer.from("sample trace");
  await fs.mkdir(path.dirname(artifactBase), { recursive: true });
  await fs.writeFile(`${artifactBase}.ilean`, JSON.stringify({
    version: 1,
    module: "Project.Sample",
    references: {},
    decls: Object.fromEntries(declarations.map((declaration) => [
      declaration.name,
      [
        0,
        0,
        0,
        0,
        declaration.nameRange.start.line,
        declaration.nameRange.start.character,
        declaration.nameRange.end.line,
        declaration.nameRange.end.character
      ]
    ]))
  }), "utf8");
  await fs.writeFile(`${artifactBase}.trace`, trace);

  const entries = Object.fromEntries(declarations
    .filter((declaration) => declaration.name !== "StaticSample.inferred")
    .map((declaration) => {
      const incomplete = declaration.name.endsWith(".incomplete");
      return [declaration.name, {
        name: declaration.name,
        module: "Project.Sample",
        traceFingerprint: createHash("sha256").update(trace).digest("hex"),
        axioms: incomplete ? ["sorryAx"] : [],
        typeConstants: [],
        valueConstants: incomplete ? ["sorryAx"] : []
      }];
    }));
  const cacheFile = path.join(root, ".lake", "handwave", "artifact-index-v1.json");
  await fs.mkdir(path.dirname(cacheFile), { recursive: true });
  await fs.writeFile(cacheFile, JSON.stringify({ schemaVersion: 1, entries }), "utf8");
}

function staticTheoremPayload(html: string): Array<{
  name: string;
  statusCategory: string;
  statusHtml: string;
}> {
  return staticExplorerPayload(html).theorems;
}

function staticExplorerPayload(html: string): {
  theorems: Array<{ name: string; statusCategory: string; statusHtml: string }>;
  definitions: Array<{
    name: string;
    definitions: Array<{ target: string }>;
    referencingDefinitions: Array<{ target: string }>;
    referencingTheorems: Array<{ target: string }>;
  }>;
} {
  const marker = "let payload = ";
  const start = html.indexOf(marker) + marker.length;
  const end = html.indexOf(";\n    let theoremMap", start);
  return JSON.parse(html.slice(start, end)) as {
    theorems: Array<{ name: string; statusCategory: string; statusHtml: string }>;
    definitions: Array<{
      name: string;
      definitions: Array<{ target: string }>;
      referencingDefinitions: Array<{ target: string }>;
      referencingTheorems: Array<{ target: string }>;
    }>;
  };
}

function staticPreviewHtml(html: string, name: string): string {
  const marker = "const previewHtmlByName = new Map(";
  const start = html.indexOf(marker) + marker.length;
  const end = html.indexOf(");\n    const articleHtmlByTarget", start);
  const entries = JSON.parse(html.slice(start, end)) as Array<[string, string]>;
  return new Map(entries).get(name) ?? "";
}

function staticArticleHtml(html: string, target: string): string {
  const marker = "const articleHtmlByTarget = new Map(";
  const start = html.indexOf(marker) + marker.length;
  const end = html.indexOf(");\n    const articleSearchItems", start);
  const entries = JSON.parse(html.slice(start, end)) as Array<[string, string]>;
  return new Map(entries).get(target) ?? "";
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
