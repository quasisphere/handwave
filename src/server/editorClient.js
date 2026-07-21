import { autocompletion } from "@codemirror/autocomplete";
import { markdown } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { basicSetup } from "codemirror";

(() => {
  const live = window.handwaveLiveServer;
  if (!live) {
    return;
  }
  window.handwaveCodeMirrorEditorLoaded = true;

  let completionCatalogPromise;

  document.addEventListener("click", async (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const articleButton = target?.closest("[data-edit-article]");
    if (articleButton) {
      event.preventDefault();
      const owner = articleButton.closest("[data-article-target]");
      const articleTarget = owner?.dataset.articleTarget;
      if (articleTarget) {
        const offset = Number(articleButton.dataset.editOffset || 0);
        await openArticleEditor(articleTarget, Number.isFinite(offset) ? offset : 0);
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

  async function openArticleEditor(target, offset) {
    try {
      const data = await live.request("/api/article?target=" + encodeURIComponent(target));
      const article = document.querySelector(".article-view");
      if (!article) {
        return;
      }
      const editor = document.createElement("section");
      editor.className = "handwave-inline-editor";
      editor.dataset.editorTarget = data.target;

      const header = editorHeader("h1", "Edit " + data.title);
      const message = editorMessage();
      const markdownHost = markdownEditorHost("Article Markdown", true);
      editor.append(header.element, markdownHost);
      const sourceEditor = createMarkdownEditor(markdownHost, data.source, offset, () => header.save.click());
      editor.append(message);
      article.replaceChildren(editor);

      header.cancel.addEventListener("click", () => {
        sourceEditor.destroy();
        live.sendToApplication({
          type: "setArticle",
          target: data.target,
          html: data.html,
          recordHistory: false
        });
      });
      header.save.addEventListener("click", () => saveArticle(data, sourceEditor, header.save, message));
      focusEditorAt(sourceEditor, offset);
    } catch (error) {
      window.handwaveServerNotice(error instanceof Error ? error.message : String(error), true);
    }
  }

  async function saveArticle(data, sourceEditor, button, message) {
    setBusy(button, true);
    setEditorMessage(message, "Saving…");
    try {
      const updated = await live.request("/api/article", {
        method: "PUT",
        body: JSON.stringify({
          target: data.target,
          source: sourceEditor.state.doc.toString(),
          revision: data.revision
        })
      });
      sourceEditor.destroy();
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
      const header = editorHeader("h2", "Edit " + data.sourceName);
      const name = textField("Name", data.fields.name);
      const statement = markdownField("Statement", data.fields.statement, () => header.save.click());
      const theoremLike = data.kind === "theorem" || data.kind === "lemma";
      const proof = theoremLike
        ? markdownField("Proof", data.fields.proof, () => header.save.click())
        : undefined;
      const message = editorMessage();
      editor.append(header.element, name.label, statement.label);
      if (proof) {
        editor.append(proof.label);
      }
      editor.append(message);
      section.hidden = true;
      section.before(editor);
      name.control.focus();

      header.cancel.addEventListener("click", () => {
        statement.editor.destroy();
        proof?.editor.destroy();
        editor.remove();
        section.hidden = false;
      });
      header.save.addEventListener("click", async () => {
        setBusy(header.save, true);
        setEditorMessage(message, "Saving…");
        try {
          const fields = {
            name: name.control.value,
            statement: statement.editor.state.doc.toString()
          };
          if (proof) {
            fields.proof = proof.editor.state.doc.toString();
          }
          await live.request("/api/declaration", {
            method: "PATCH",
            body: JSON.stringify({
              target: data.target,
              revision: data.revision,
              fields
            })
          });
          statement.editor.destroy();
          proof?.editor.destroy();
          editor.remove();
          section.hidden = false;
          window.handwaveServerNotice("Handwave metadata saved.");
          await live.refreshWorkspace();
        } catch (error) {
          setEditorMessage(message, error instanceof Error ? error.message : String(error), true);
        } finally {
          setBusy(header.save, false);
        }
      });
    } catch (error) {
      window.handwaveServerNotice(error instanceof Error ? error.message : String(error), true);
    }
  }

  function editorHeader(level, titleText) {
    const element = document.createElement("header");
    element.className = "handwave-inline-editor-header";
    const title = document.createElement(level);
    title.textContent = titleText;
    const actions = document.createElement("div");
    actions.className = "handwave-inline-editor-actions";
    const cancel = actionButton("Cancel", "cancel");
    const save = actionButton("Save", "save");
    actions.append(cancel, save);
    element.append(title, actions);
    return { element, cancel, save };
  }

  function textField(labelText, value) {
    const label = document.createElement("label");
    label.className = "handwave-editor-field handwave-name-field";
    label.append(editorFieldLabel(labelText));
    const control = document.createElement("input");
    control.value = value || "";
    label.append(control);
    return { label, control };
  }

  function markdownField(labelText, value, save) {
    const label = document.createElement("label");
    label.className = "handwave-editor-field";
    label.append(editorFieldLabel(labelText));
    const host = markdownEditorHost(labelText, false);
    label.append(host);
    return { label, editor: createMarkdownEditor(host, value || "", 0, save) };
  }

  function editorFieldLabel(labelText) {
    const fieldLabel = document.createElement("span");
    fieldLabel.className = "handwave-field-label";
    fieldLabel.textContent = labelText;
    return fieldLabel;
  }

  function markdownEditorHost(label, article) {
    const host = document.createElement("div");
    host.className = "handwave-markdown-editor" + (article ? " handwave-article-source" : "");
    host.setAttribute("aria-label", label);
    return host;
  }

  function createMarkdownEditor(host, source, offset, save) {
    const position = Math.max(0, Math.min(source.length, offset));
    host.dataset.initialOffset = String(position);
    return new EditorView({
      parent: host,
      state: EditorState.create({
        doc: source,
        selection: { anchor: position },
        extensions: [
          basicSetup,
          markdown(),
          EditorView.lineWrapping,
          autocompletion({ override: [handwaveCompletionSource] }),
          keymap.of([{
            key: "Mod-s",
            preventDefault: true,
            run() {
              save();
              return true;
            }
          }]),
          EditorView.theme({
            "&": {
              backgroundColor: "var(--vscode-input-background, var(--page-background))",
              color: "inherit",
              fontSize: "0.95em"
            },
            ".cm-content": {
              caretColor: "var(--accent)",
              fontFamily: "var(--vscode-editor-font-family, ui-monospace, monospace)",
              lineHeight: "1.5",
              padding: "9px 2px"
            },
            ".cm-gutters": {
              backgroundColor: "var(--vscode-input-background, var(--page-background))",
              borderRight: "1px solid var(--border)",
              color: "var(--muted)"
            },
            ".cm-activeLine, .cm-activeLineGutter": {
              backgroundColor: "color-mix(in srgb, var(--accent) 7%, transparent)"
            },
            "&.cm-focused": {
              outline: "1px solid var(--accent)"
            }
          })
        ]
      })
    });
  }

  function focusEditorAt(editor, offset) {
    const position = Math.max(0, Math.min(editor.state.doc.length, offset));
    editor.focus();
    editor.dispatch({
      selection: { anchor: position },
      effects: EditorView.scrollIntoView(position, { y: "center" })
    });
  }

  async function handwaveCompletionSource(context) {
    const include = context.matchBefore(/@include\{[^}\s]*/);
    const link = context.matchBefore(/\]\([^\s)]*/);
    const direct = context.matchBefore(/(?:lean|article):[^\s)}]*/);
    let match;
    let kinds;
    if (include) {
      match = include;
      kinds = "include";
    } else if (link) {
      match = link;
      kinds = "link";
    } else if (direct) {
      match = direct;
      kinds = "link";
    } else {
      return null;
    }
    const catalog = await completionCatalog();
    const prefixLength = include
      ? "@include{".length
      : link
        ? "](".length
        : 0;
    return {
      from: match.from + prefixLength,
      options: kinds === "include" ? catalog.includes : catalog.links,
      validFor: /^(?:(?:lean|article):)?[^\s)}]*$/
    };
  }

  function completionCatalog() {
    if (!completionCatalogPromise) {
      completionCatalogPromise = live.request("/api/bootstrap").then((data) => {
        const theoremLinks = [];
        const theoremIncludes = [];
        for (const theorem of data.payload.theorems) {
          if (theorem.isPrivate) {
            continue;
          }
          const target = "lean:" + theorem.name;
          const detail = theorem.displayName || theorem.moduleName || theorem.sourceName;
          theoremLinks.push({ label: target, detail, type: "function" });
          theoremIncludes.push(
            { label: target, detail: "Theorem · " + detail, type: "function", boost: 2 },
            { label: target + ".statement", detail: "Statement · " + detail, type: "property" },
            { label: target + ".proof", detail: "Proof · " + detail, type: "property" }
          );
        }
        const articles = data.articleItems.map((article) => ({
          label: article.target,
          detail: article.title + " · " + article.relativePath,
          type: "text"
        }));
        return {
          includes: [...theoremIncludes, ...articles],
          links: [...theoremLinks, ...articles]
        };
      }).catch((error) => {
        completionCatalogPromise = undefined;
        throw error;
      });
    }
    return completionCatalogPromise;
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
