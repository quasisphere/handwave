import * as vscode from "vscode";
import type {
  TheoremExplorerPayload,
  TheoremExplorerStatusUpdate
} from "../handwave/explorer";
import { renderTheoremExplorerHtml } from "../web/explorer";

export class HandwaveTheoremExplorerProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private view: vscode.WebviewView | undefined;

  constructor(
    private readonly payloadProvider: () => TheoremExplorerPayload,
    private readonly previewProvider: (name: string) => string | undefined,
    private readonly openPreviewTarget: (target: string) => Promise<void>,
    private readonly toggleTag: (target: string, tag: string) => Promise<void>,
    private readonly updateVisibleTheorems: (names: string[]) => Promise<void>
  ) {}

  dispose(): void {
    this.view = undefined;
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = renderTheoremExplorerHtml(this.payloadProvider());
    view.webview.onDidReceiveMessage((message: unknown) => {
      void this.handleMessage(message);
    });
    view.onDidChangeVisibility(() => {
      if (view.visible) {
        this.refresh();
      } else {
        void this.updateVisibleTheorems([]);
      }
    });
  }

  refresh(): void {
    if (!this.view?.visible) {
      return;
    }
    const payload = this.payloadProvider();
    void this.view?.webview.postMessage({ type: "setData", payload });
  }

  setTag(target: string, tag: string, active: boolean): void {
    if (!this.view?.visible) {
      return;
    }
    void this.view.webview.postMessage({ type: "setTag", target, tag, active });
  }

  setStatuses(updates: readonly TheoremExplorerStatusUpdate[]): void {
    if (!this.view?.visible || updates.length === 0) {
      return;
    }
    void this.view.webview.postMessage({ type: "setStatuses", updates });
  }

  private async handleMessage(message: unknown): Promise<void> {
    if (!message || typeof message !== "object") {
      return;
    }
    const data = message as {
      type?: unknown;
      target?: unknown;
      tag?: unknown;
      names?: unknown;
      name?: unknown;
      requestId?: unknown;
    };
    if (
      data.type === "requestPreview" &&
      typeof data.name === "string" &&
      typeof data.requestId === "number"
    ) {
      const html = this.previewProvider(data.name);
      if (html !== undefined) {
        void this.view?.webview.postMessage({
          type: "setPreview",
          name: data.name,
          requestId: data.requestId,
          html
        });
      }
      return;
    }
    if (data.type === "openPreview" && typeof data.target === "string") {
      void this.openPreviewTarget(data.target);
      return;
    }
    if (data.type === "toggleTag" && typeof data.target === "string" && typeof data.tag === "string") {
      void this.toggleTag(data.target, data.tag);
      return;
    }
    if (
      data.type === "visibleTheorems" &&
      Array.isArray(data.names) &&
      data.names.every((name) => typeof name === "string")
    ) {
      void this.updateVisibleTheorems(data.names);
    }
  }
}
