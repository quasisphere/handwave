import * as assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";
import { promises as fs } from "node:fs";
import { test } from "node:test";
import { startHandwaveServer } from "../server/server";

const leanSource = `/--
%%handwave
name:
  Initial theorem
statement:
  The initial statement.
proof:
  The initial proof.
-/
theorem LiveSample.result : True := by
  trivial

/--
%%handwave
name:
  Initial definition
statement:
  The distinguished value is zero.
-/
def LiveSample.value : Nat := 0
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
    const token = /const mutationToken = "([^"]+)";/.exec(page)?.[1];
    assert.ok(token);

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
    assert.match(updatedLean, /theorem LiveSample\.result : True := by/);

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
