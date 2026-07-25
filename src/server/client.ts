export function renderLiveServerHtml(html: string, mutationToken: string): string {
  const bootstrap = `<script>
  (() => {
    const mutationToken = ${jsonForScript(mutationToken)};

    async function request(path, options = {}) {
      const headers = new Headers(options.headers || {});
      if (options.body !== undefined) {
        headers.set("content-type", "application/json");
        headers.set("x-handwave-token", mutationToken);
      }
      const response = await fetch(path, { ...options, headers });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        const error = new Error(data.error || response.statusText || "Handwave request failed");
        error.status = response.status;
        throw error;
      }
      return data;
    }

    function sendToApplication(message) {
      window.dispatchEvent(new MessageEvent("message", { data: message }));
    }

    async function refreshWorkspace() {
      const data = await request("/api/bootstrap");
      sendToApplication({
        type: "setData",
        payload: data.payload,
        articleItems: data.articleItems
      });
    }

    window.handwaveLiveServer = { request, sendToApplication, refreshWorkspace };
    window.acquireVsCodeApi = () => ({
      postMessage(message) {
        window.dispatchEvent(new CustomEvent("handwave-host-message", { detail: message }));
      }
    });

    window.addEventListener("handwave-host-message", async (event) => {
      const message = event.detail || {};
      try {
        if (message.type === "requestPreview") {
          const data = await request("/api/preview?name=" + encodeURIComponent(message.name));
          sendToApplication({
            type: "setPreview",
            name: message.name,
            requestId: message.requestId,
            html: data.html
          });
          return;
        }
        if (message.type === "openPreview") {
          if (typeof message.target === "string" && message.target.startsWith("article:")) {
            const data = await request("/api/article?target=" + encodeURIComponent(message.target));
            sendToApplication({
              type: "setArticle",
              target: message.target,
              html: data.html,
              recordHistory: message.recordHistory !== false,
              preserveScroll: message.preserveScroll === true
            });
          }
          return;
        }
        if (message.type === "toggleTag") {
          const data = await request("/api/tag", {
            method: "PUT",
            body: JSON.stringify({
              target: message.target,
              tag: message.tag,
              active: message.active
            })
          });
          sendToApplication({
            type: "setTag",
            target: message.target,
            tag: message.tag,
            active: data.active
          });
          return;
        }
        if (message.type === "copy" && navigator.clipboard) {
          await navigator.clipboard.writeText(String(message.text || ""));
        }
      } catch (error) {
        showNotice(error instanceof Error ? error.message : String(error), true);
        if (message.type === "toggleTag") {
          await refreshWorkspace().catch(() => undefined);
        }
      }
    });

    function showNotice(message, error = false) {
      let notice = document.getElementById("handwave-server-notice");
      if (!notice) {
        notice = document.createElement("div");
        notice.id = "handwave-server-notice";
        notice.setAttribute("role", "status");
        document.body.append(notice);
      }
      notice.textContent = message;
      notice.classList.toggle("handwave-server-notice-error", error);
      notice.hidden = false;
      window.clearTimeout(Number(notice.dataset.timer || 0));
      notice.dataset.timer = String(window.setTimeout(() => { notice.hidden = true; }, 4500));
    }

    window.handwaveServerNotice = showNotice;
  })();
  </script>`;

  const editor = `<style>
    #handwave-server-notice {
      position: fixed;
      z-index: 10000;
      right: 18px;
      bottom: 18px;
      max-width: min(520px, calc(100vw - 36px));
      padding: 10px 14px;
      border: 1px solid var(--border);
      border-radius: 7px;
      background: var(--popover-background);
      box-shadow: 0 8px 28px color-mix(in srgb, black 22%, transparent);
    }
    #handwave-server-notice.handwave-server-notice-error {
      border-color: var(--danger, #d1242f);
    }
    .article-editable-block,
    .article-editable-heading,
    .theorem-view,
    .definition-view {
      position: relative;
    }
    .preview > .theorem-view,
    .preview > .definition-view {
      margin-right: 50px;
    }
    .article-block-edit,
    .article-heading-edit,
    .declaration-metadata-edit {
      position: absolute;
      z-index: 3;
      top: 2px;
      right: -50px;
      padding: 2px 7px;
      border: 1px solid var(--border);
      border-radius: 5px;
      background: var(--page-background);
      color: var(--accent);
      font: inherit;
      font-size: 0.76rem;
      cursor: pointer;
      opacity: 0;
      transition: opacity 100ms ease;
    }
    .article-editable-block:hover > .article-block-edit,
    .article-editable-heading:hover > .article-heading-edit,
    .article-block-edit:focus-visible,
    .article-heading-edit:focus-visible,
    .theorem-view:hover > .declaration-metadata-edit,
    .definition-view:hover > .declaration-metadata-edit,
    .declaration-metadata-edit:focus-visible {
      opacity: 1;
    }
    .handwave-inline-editor {
      display: grid;
      gap: 12px;
      min-height: calc(100vh - 150px);
      padding: 4px 2px 36px;
    }
    .handwave-declaration-editor {
      align-content: start;
    }
    .handwave-inline-editor-header,
    .handwave-inline-editor-actions {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .handwave-inline-editor-header {
      justify-content: space-between;
    }
    .handwave-declaration-editor .handwave-inline-editor-header {
      display: block;
      margin-bottom: 12px;
      position: relative;
    }
    .handwave-declaration-editor .handwave-inline-editor-header h2 {
      max-width: 100%;
      overflow-wrap: anywhere;
      word-break: normal;
    }
    .handwave-declaration-editor .handwave-inline-editor-actions {
      align-items: stretch;
      flex-direction: column;
      left: calc(100% + 12px);
      position: absolute;
      top: 0;
      width: 74px;
    }
    .preview > .handwave-declaration-editor {
      margin-left: 88px;
      margin-right: 86px;
    }
    .handwave-inline-editor h1,
    .handwave-inline-editor h2 {
      margin: 0;
    }
    .handwave-inline-editor input,
    .handwave-inline-editor textarea {
      box-sizing: border-box;
      width: 100%;
      border: 1px solid var(--border);
      border-radius: 6px;
      background: var(--vscode-input-background, var(--page-background));
      color: inherit;
      font: inherit;
      font-weight: 400;
      padding: 9px 10px;
    }
    .handwave-inline-editor textarea {
      font-family: var(--vscode-editor-font-family, ui-monospace, monospace);
      line-height: 1.5;
      min-height: 9em;
      resize: vertical;
    }
    .handwave-markdown-editor {
      border: 1px solid var(--border);
      border-radius: 6px;
      font-weight: 400;
      min-height: 9em;
      overflow: hidden;
    }
    .handwave-article-source {
      min-height: calc(100vh - 235px);
    }
    .handwave-markdown-editor > .cm-editor {
      height: 100%;
      min-height: inherit;
    }
    .handwave-markdown-editor .cm-scroller {
      overflow: auto;
    }
    .handwave-inline-editor .handwave-editor-field {
      display: block;
      font-weight: 600;
      position: relative;
    }
    .handwave-declaration-editor .handwave-field-label {
      box-sizing: border-box;
      position: absolute;
      right: calc(100% + 12px);
      text-align: right;
      top: 9px;
      width: 76px;
    }
    .handwave-inline-editor button {
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 7px 13px;
      background: var(--surface);
      color: inherit;
      font: inherit;
      cursor: pointer;
    }
    .handwave-inline-editor button[data-save] {
      border-color: var(--accent);
      background: var(--accent);
      color: white;
    }
    .handwave-editor-message {
      min-height: 1.4em;
      color: var(--muted);
    }
    .handwave-declaration-editor .handwave-editor-message {
      margin-top: 12px;
    }
    .handwave-editor-message-error {
      color: var(--danger, #d1242f);
    }
    @media (max-width: 900px) {
      .article-editable-block,
      .article-editable-heading,
      .theorem-view,
      .definition-view {
        padding-right: 44px;
      }
      .article-block-edit,
      .article-heading-edit,
      .declaration-metadata-edit {
        right: 2px;
      }
      .handwave-declaration-editor .handwave-inline-editor-header {
        display: grid;
        gap: 10px;
      }
      .handwave-declaration-editor .handwave-inline-editor-actions {
        flex-direction: row;
        justify-content: flex-end;
        position: static;
        width: auto;
      }
      .handwave-declaration-editor .handwave-field-label {
        display: block;
        margin-bottom: 5px;
        position: static;
        text-align: left;
        width: auto;
      }
      .preview > .handwave-declaration-editor {
        margin-left: 0;
        margin-right: 0;
      }
      .preview > .theorem-view,
      .preview > .definition-view {
        margin-right: 0;
      }
    }
  </style>
  <script src="/assets/server-editor.js"></script>
  <script>
  (() => {
    if (window.handwaveCodeMirrorEditorLoaded) {
      return;
    }
    const live = window.handwaveLiveServer;
    if (!live) {
      return;
    }

    document.addEventListener("click", async (event) => {
      const target = event.target instanceof Element ? event.target : null;
      const articleButton = target?.closest("[data-edit-article]");
      if (articleButton) {
        event.preventDefault();
        const owner = articleButton.closest("[data-article-target]");
        const articleTarget = owner?.dataset.articleTarget;
        if (articleTarget) {
          await openArticleEditor(articleTarget);
        }
        return;
      }

      const declarationButton = target?.closest("[data-edit-declaration]");
      if (declarationButton) {
        event.preventDefault();
        const declarationTarget = declarationButton.dataset.editDeclaration;
        const section = declarationButton.closest(".theorem-view,.definition-view");
        if (declarationTarget && section) {
          await openDeclarationEditor(declarationTarget, section);
        }
      }
    });

    async function openArticleEditor(target) {
      try {
        const data = await live.request("/api/article?target=" + encodeURIComponent(target));
        const article = document.querySelector(".article-view");
        if (!article) {
          return;
        }
        const editor = document.createElement("section");
        editor.className = "handwave-inline-editor";
        editor.dataset.editorTarget = data.target;

        const header = document.createElement("header");
        header.className = "handwave-inline-editor-header";
        const title = document.createElement("h1");
        title.textContent = "Edit " + data.title;
        header.append(title);

        const actions = document.createElement("div");
        actions.className = "handwave-inline-editor-actions";
        const cancel = actionButton("Cancel", "cancel");
        const save = actionButton("Save", "save");
        actions.append(cancel, save);
        header.append(actions);

        const textarea = document.createElement("textarea");
        textarea.className = "handwave-article-source";
        textarea.value = data.source;
        textarea.setAttribute("aria-label", "Article Markdown");
        textarea.spellcheck = false;
        const message = editorMessage();
        editor.append(header, textarea, message);
        article.replaceChildren(editor);
        textarea.focus();

        cancel.addEventListener("click", () => {
          live.sendToApplication({
            type: "setArticle",
            target: data.target,
            html: data.html,
            recordHistory: false
          });
        });
        save.addEventListener("click", () => saveArticle(data, textarea, save, message));
        textarea.addEventListener("keydown", (keyboardEvent) => {
          if ((keyboardEvent.metaKey || keyboardEvent.ctrlKey) && keyboardEvent.key.toLowerCase() === "s") {
            keyboardEvent.preventDefault();
            save.click();
          }
        });
      } catch (error) {
        window.handwaveServerNotice(error instanceof Error ? error.message : String(error), true);
      }
    }

    async function saveArticle(data, textarea, button, message) {
      setBusy(button, true);
      setEditorMessage(message, "Saving…");
      try {
        const updated = await live.request("/api/article", {
          method: "PUT",
          body: JSON.stringify({
            target: data.target,
            source: textarea.value,
            revision: data.revision
          })
        });
        live.sendToApplication({
          type: "setArticle",
          target: updated.target,
          html: updated.html,
          recordHistory: false
        });
        window.handwaveServerNotice("Article saved.");
      } catch (error) {
        setEditorMessage(message, error instanceof Error ? error.message : String(error), true);
      } finally {
        setBusy(button, false);
      }
    }

    async function openDeclarationEditor(target, section) {
      try {
        const data = await live.request("/api/declaration?target=" + encodeURIComponent(target));
        const editor = document.createElement("section");
        editor.className = "handwave-inline-editor handwave-declaration-editor";
        const header = document.createElement("header");
        header.className = "handwave-inline-editor-header";
        const title = document.createElement("h2");
        title.textContent = "Edit " + data.sourceName;
        const actions = document.createElement("div");
        actions.className = "handwave-inline-editor-actions";
        const cancel = actionButton("Cancel", "cancel");
        const save = actionButton("Save", "save");
        actions.append(cancel, save);
        header.append(title, actions);

        const name = field("Name", "input", data.fields.name);
        name.label.classList.add("handwave-name-field");
        const statement = field("Statement", "textarea", data.fields.statement);
        const theoremLike = data.kind === "theorem" || data.kind === "lemma";
        const proof = theoremLike ? field("Proof", "textarea", data.fields.proof) : undefined;
        const message = editorMessage();
        editor.append(header, name.label, statement.label);
        if (proof) {
          editor.append(proof.label);
        }
        editor.append(message);
        section.hidden = true;
        section.before(editor);
        name.control.focus();

        cancel.addEventListener("click", () => {
          editor.remove();
          section.hidden = false;
        });
        save.addEventListener("click", async () => {
          setBusy(save, true);
          setEditorMessage(message, "Saving…");
          try {
            const fields = {
              name: name.control.value,
              statement: statement.control.value
            };
            if (proof) {
              fields.proof = proof.control.value;
            }
            await live.request("/api/declaration", {
              method: "PATCH",
              body: JSON.stringify({
                target: data.target,
                revision: data.revision,
                fields
              })
            });
            editor.remove();
            section.hidden = false;
            window.handwaveServerNotice("Handwave metadata saved.");
            await live.refreshWorkspace();
          } catch (error) {
            setEditorMessage(message, error instanceof Error ? error.message : String(error), true);
          } finally {
            setBusy(save, false);
          }
        });
      } catch (error) {
        window.handwaveServerNotice(error instanceof Error ? error.message : String(error), true);
      }
    }

    function field(labelText, type, value) {
      const label = document.createElement("label");
      label.className = "handwave-editor-field";
      const fieldLabel = document.createElement("span");
      fieldLabel.className = "handwave-field-label";
      fieldLabel.textContent = labelText;
      label.append(fieldLabel);
      const control = document.createElement(type);
      control.value = value || "";
      if (control instanceof HTMLTextAreaElement) {
        control.spellcheck = true;
      }
      label.append(control);
      return { label, control };
    }

    function actionButton(label, action) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = label;
      button.dataset[action] = "true";
      return button;
    }

    function editorMessage() {
      const message = document.createElement("div");
      message.className = "handwave-editor-message";
      message.setAttribute("role", "status");
      return message;
    }

    function setEditorMessage(element, text, error = false) {
      element.textContent = text;
      element.classList.toggle("handwave-editor-message-error", error);
    }

    function setBusy(button, busy) {
      button.disabled = busy;
      button.textContent = busy ? "Saving…" : "Save";
    }

    const events = new EventSource("/api/events");
    let refreshTimer = 0;
    events.addEventListener("workspace", () => {
      window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => {
        live.refreshWorkspace().catch((error) => {
          window.handwaveServerNotice(error instanceof Error ? error.message : String(error), true);
        });
      }, 80);
    });
  })();
  </script>`;

  return html
    .replace("<body>", `<body>${bootstrap}`)
    .replace("</body>", `${editor}</body>`);
}

function jsonForScript(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}
