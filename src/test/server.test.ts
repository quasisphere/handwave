import * as assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import { promises as fs } from "node:fs";
import { test } from "node:test";
import { parseLeanDocument } from "../handwave/parser";
import { startHandwaveServer } from "../server/server";

const leanSource = `/-- The foundational value is zero. -/
def LiveSample.zero : Nat := 0

/--
%%handwave
name:
  Initial definition
statement:
  The distinguished value is zero.
-/
def LiveSample.value : Nat := LiveSample.zero

/--
%%handwave
name:
  Initial theorem
statement:
  The initial statement.
proof:
  The initial proof.
-/
theorem LiveSample.result : LiveSample.value = 0 := by
  rfl
`;

const articleSource = `# Live article

This paragraph is editable.

@include{lean:LiveSample.result}

@include{lean:LiveSample.value}
`;

test("serves and directly edits a live Handwave repository", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "handwave-server-"));
  const leanFile = path.join(root, "Live.lean");
  const articleFile = path.join(root, "live.hw.md");
  await fs.writeFile(leanFile, leanSource, "utf8");
  await fs.writeFile(articleFile, articleSource, "utf8");
  const running = await startHandwaveServer({ rootDirectory: root, watch: false });
  try {
    const pageResponse = await fetch(running.url);
    assert.equal(pageResponse.status, 200);
    const page = await pageResponse.text();
    assert.match(page, /window\.acquireVsCodeApi/);
    assert.match(page, /handwave-inline-editor/);
    assert.match(page, /handwave-name-field/);
    assert.match(page, /handwave-field-label/);
    assert.match(page, /\.handwave-declaration-editor \{\s*align-content: start;/);
    assert.match(page, /left: calc\(100% \+ 12px\)/);
    assert.match(page, /right: calc\(100% \+ 12px\)/);
    assert.match(page, /overflow-wrap: anywhere/);
    assert.match(page, /\.preview > \.handwave-declaration-editor/);
    assert.match(page, /\.preview > \.theorem-view/);
    assert.match(page, /field\("Name", "input"/);
    assert.doesNotMatch(page, /Display name/);
    assert.match(page, /src="\/assets\/server-editor\.js"/);
    assert.match(page, /article:live\.hw\.md/);
    assert.match(page, /preserveScroll: message\.preserveScroll === true/);
    const token = /const mutationToken = "([^"]+)";/.exec(page)?.[1];
    assert.ok(token);

    const bootstrap = await (await fetch(`${running.url}/api/bootstrap`)).json() as {
      payload: {
        definitionCount: number;
        theorems: Array<{ name: string; definitions: Array<{ target: string }> }>;
        definitions: Array<{
          name: string;
          definitions: Array<{ target: string }>;
          referencingDefinitions: Array<{ target: string }>;
          referencingTheorems: Array<{ target: string }>;
        }>;
      };
    };
    assert.equal(bootstrap.payload.definitionCount, 2);
    assert.deepEqual(
      bootstrap.payload.theorems.find((theorem) => theorem.name === "LiveSample.result")
        ?.definitions.map((link) => link.target),
      ["lean:LiveSample.value"]
    );
    assert.deepEqual(
      bootstrap.payload.definitions.find((definition) => definition.name === "LiveSample.value")
        ?.definitions.map((link) => link.target),
      ["lean:LiveSample.zero"]
    );
    assert.deepEqual(
      bootstrap.payload.definitions.find((definition) => definition.name === "LiveSample.value")
        ?.referencingTheorems.map((link) => link.target),
      ["lean:LiveSample.result"]
    );
    assert.deepEqual(
      bootstrap.payload.definitions.find((definition) => definition.name === "LiveSample.zero")
        ?.referencingDefinitions.map((link) => link.target),
      ["lean:LiveSample.value"]
    );

    const articleResponse = await fetch(
      `${running.url}/api/article?target=${encodeURIComponent("article:live.hw.md")}`
    );
    assert.equal(articleResponse.status, 200);
    const article = await articleResponse.json() as {
      source: string;
      revision: string;
      html: string;
    };
    assert.equal(article.source, articleSource);
    assert.match(article.html, /data-edit-article/);
    assert.match(article.html, /data-edit-offset="2"/);
    assert.match(article.html, /data-edit-declaration="lean:LiveSample\.result"/);

    const theoremPreviewResponse = await fetch(
      `${running.url}/api/preview?name=${encodeURIComponent("LiveSample.result")}`
    );
    assert.equal(theoremPreviewResponse.status, 200);
    const theoremPreview = await theoremPreviewResponse.json() as { html: string };
    assert.match(theoremPreview.html, /data-edit-declaration="lean:LiveSample\.result"/);
    assert.doesNotMatch(theoremPreview.html, /data-handwave-target="lean:LiveSample\.value"/);
    assert.match(page, /"Definitions used by this definition"/);

    const definitionPreviewResponse = await fetch(
      `${running.url}/api/preview?name=${encodeURIComponent("LiveSample.value")}`
    );
    assert.equal(definitionPreviewResponse.status, 200);
    const definitionPreview = await definitionPreviewResponse.json() as { html: string };
    assert.match(definitionPreview.html, /class="definition-view"/);
    assert.match(definitionPreview.html, /data-edit-declaration="lean:LiveSample\.value"/);

    const editorAssetResponse = await fetch(`${running.url}/assets/server-editor.js`);
    assert.equal(editorAssetResponse.status, 200);
    assert.match(editorAssetResponse.headers.get("content-type") ?? "", /text\/javascript/);
    assert.ok((await editorAssetResponse.text()).length > 100_000);

    const definitionResponse = await fetch(
      `${running.url}/api/declaration?target=${encodeURIComponent("lean:LiveSample.value")}`
    );
    assert.equal(definitionResponse.status, 200);
    const definition = await definitionResponse.json() as { kind: string; fields: { proof: string } };
    assert.equal(definition.kind, "def");
    assert.equal(definition.fields.proof, "");

    const undocumentedDefinitionResponse = await fetch(
      `${running.url}/api/declaration?target=${encodeURIComponent("lean:LiveSample.zero")}`
    );
    const undocumentedDefinition = await undocumentedDefinitionResponse.json() as {
      revision: string;
    };
    const savedUndocumentedDefinition = await mutation(
      running.url,
      token,
      "/api/declaration",
      "PATCH",
      {
        target: "lean:LiveSample.zero",
        revision: undocumentedDefinition.revision,
        fields: {
          name: "Foundational zero",
          statement: ""
        }
      }
    );
    assert.equal(savedUndocumentedDefinition.status, 200);
    const documentedLean = await fs.readFile(leanFile, "utf8");
    assert.equal((documentedLean.match(/The foundational value is zero\./g) ?? []).length, 1);
    assert.match(
      documentedLean,
      /\/--\nThe foundational value is zero\.\n\n%%handwave\nname:\n  Foundational zero\n-\/\ndef LiveSample\.zero/
    );
    assert.doesNotMatch(documentedLean, /-\/\n\/--\n%%handwave/);

    const denied = await fetch(`${running.url}/api/article`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        target: "article:live.hw.md",
        source: articleSource,
        revision: article.revision
      })
    });
    assert.equal(denied.status, 403);

    const updatedArticleSource = articleSource.replace("editable", "edited in place");
    const savedArticle = await mutation(running.url, token, "/api/article", "PUT", {
      target: "article:live.hw.md",
      source: updatedArticleSource,
      revision: article.revision
    });
    assert.equal(savedArticle.status, 200);
    assert.equal(await fs.readFile(articleFile, "utf8"), updatedArticleSource);

    const declarationResponse = await fetch(
      `${running.url}/api/declaration?target=${encodeURIComponent("lean:LiveSample.result")}`
    );
    const declaration = await declarationResponse.json() as { revision: string };
    const savedDeclaration = await mutation(running.url, token, "/api/declaration", "PATCH", {
      target: "lean:LiveSample.result",
      revision: declaration.revision,
      fields: {
        name: "Updated theorem",
        statement: "The updated statement.",
        proof: "The updated proof."
      }
    });
    assert.equal(savedDeclaration.status, 200);
    const updatedLean = await fs.readFile(leanFile, "utf8");
    assert.match(updatedLean, /name:\n  Updated theorem/);
    assert.match(updatedLean, /statement:\n  The updated statement\./);
    assert.match(updatedLean, /proof:\n  The updated proof\./);
    assert.match(updatedLean, /theorem LiveSample\.result : LiveSample\.value = 0 := by/);

    const firstTag = await mutation(running.url, token, "/api/tag", "PUT", {
      target: "lean:LiveSample.result",
      tag: "milestone",
      active: true
    });
    const secondTag = await mutation(running.url, token, "/api/tag", "PUT", {
      target: "lean:LiveSample.result",
      tag: "milestone",
      active: true
    });
    assert.deepEqual(await firstTag.json(), { active: true });
    assert.deepEqual(await secondTag.json(), { active: true });
    assert.equal((await fs.readFile(leanFile, "utf8")).match(/milestone/g)?.length, 1);

    const freshArticle = await (await fetch(
      `${running.url}/api/article?target=${encodeURIComponent("article:live.hw.md")}`
    )).json() as { revision: string };
    await fs.writeFile(articleFile, `${updatedArticleSource}\nExternal edit.\n`, "utf8");
    const conflict = await mutation(running.url, token, "/api/article", "PUT", {
      target: "article:live.hw.md",
      source: `${updatedArticleSource}\nBrowser edit.\n`,
      revision: freshArticle.revision
    });
    assert.equal(conflict.status, 409);
    assert.match(await fs.readFile(articleFile, "utf8"), /External edit/);
  } finally {
    await running.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("refreshes theorem badges when Lean build artifacts change", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "handwave-artifact-watch-"));
  const leanFile = path.join(root, "ArtifactSample.lean");
  const source = `namespace ArtifactSample

/--
%%handwave
name:
  Artifact-watched theorem
statement:
  The proposition is true.
-/
theorem result : True := by
  trivial

end ArtifactSample
`;
  await fs.writeFile(leanFile, source, "utf8");
  const artifacts = await writeWatchedArtifacts(root, leanFile, source, {
    module: "ArtifactSample",
    trace: "initial trace",
    checked: false
  });
  const running = await startHandwaveServer({ rootDirectory: root });
  try {
    assert.equal(
      await theoremStatusCategory(running.url, "ArtifactSample.result"),
      "red"
    );

    await fs.writeFile(artifacts.traceFile, "rebuilt trace", "utf8");
    await waitForTheoremStatusCategory(running.url, "ArtifactSample.result", "green");

    await writeWatchedArtifactCache(root, {
      module: "ArtifactSample",
      trace: "rebuilt trace",
      checked: false
    });
    await waitForTheoremStatusCategory(running.url, "ArtifactSample.result", "red");

    await fs.writeFile(
      artifacts.ileanFile,
      watchedIlean(source, leanFile, "ArtifactSample.Rebuilt"),
      "utf8"
    );
    await waitForTheoremStatusCategory(running.url, "ArtifactSample.result", "green");

    await writeWatchedArtifactCache(root, {
      module: "ArtifactSample.Rebuilt",
      trace: "rebuilt trace",
      checked: false
    });
    await waitForTheoremStatusCategory(running.url, "ArtifactSample.result", "red");

    await writeWatchedArtifactCache(root, {
      module: "ArtifactSample.Rebuilt",
      trace: "rebuilt trace",
      checked: true
    });
    await waitForTheoremStatusCategory(running.url, "ArtifactSample.result", "green");
  } finally {
    await running.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

interface WatchedArtifactState {
  module: string;
  trace: string;
  checked: boolean;
}

async function writeWatchedArtifacts(
  root: string,
  leanFile: string,
  source: string,
  state: WatchedArtifactState
): Promise<{ ileanFile: string; traceFile: string }> {
  const artifactBase = path.join(root, ".lake", "build", "lib", "lean", "ArtifactSample");
  const ileanFile = `${artifactBase}.ilean`;
  const traceFile = `${artifactBase}.trace`;
  await fs.mkdir(path.dirname(artifactBase), { recursive: true });
  await fs.writeFile(ileanFile, watchedIlean(source, leanFile, state.module), "utf8");
  await fs.writeFile(traceFile, state.trace, "utf8");
  await writeWatchedArtifactCache(root, state);
  return { ileanFile, traceFile };
}

function watchedIlean(source: string, leanFile: string, moduleName: string): string {
  const declaration = parseLeanDocument(source, leanFile)[0];
  return JSON.stringify({
    version: 1,
    module: moduleName,
    references: {},
    decls: {
      [declaration.name]: [
        0,
        0,
        0,
        0,
        declaration.nameRange.start.line,
        declaration.nameRange.start.character,
        declaration.nameRange.end.line,
        declaration.nameRange.end.character
      ]
    }
  });
}

async function writeWatchedArtifactCache(
  root: string,
  state: WatchedArtifactState
): Promise<void> {
  const cacheFile = path.join(root, ".lake", "handwave", "artifact-index-v1.json");
  const temporaryFile = `${cacheFile}.test.tmp`;
  await fs.mkdir(path.dirname(cacheFile), { recursive: true });
  await fs.writeFile(temporaryFile, JSON.stringify({
    schemaVersion: 1,
    entries: {
      "ArtifactSample.result": {
        name: "ArtifactSample.result",
        module: state.module,
        traceFingerprint: createHash("sha256").update(state.trace).digest("hex"),
        axioms: state.checked ? [] : ["sorryAx"],
        typeConstants: [],
        valueConstants: state.checked ? [] : ["sorryAx"]
      }
    }
  }), "utf8");
  await fs.rename(temporaryFile, cacheFile);
}

async function theoremStatusCategory(url: string, name: string): Promise<string | undefined> {
  const bootstrap = await (await fetch(`${url}/api/bootstrap`)).json() as {
    payload: { theorems: Array<{ name: string; statusCategory: string }> };
  };
  return bootstrap.payload.theorems.find((theorem) => theorem.name === name)?.statusCategory;
}

async function waitForTheoremStatusCategory(
  url: string,
  name: string,
  expected: string
): Promise<void> {
  const deadline = Date.now() + 5_000;
  let actual: string | undefined;
  while (Date.now() < deadline) {
    actual = await theoremStatusCategory(url, name);
    if (actual === expected) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  assert.equal(actual, expected);
}

function mutation(
  url: string,
  token: string,
  pathname: string,
  method: string,
  body: unknown
): Promise<Response> {
  return fetch(`${url}${pathname}`, {
    method,
    headers: {
      "content-type": "application/json",
      "x-handwave-token": token
    },
    body: JSON.stringify(body)
  });
}
