import { randomBytes } from "node:crypto";
import { promises as fs, watch, FSWatcher } from "node:fs";
import { createServer, IncomingMessage, Server, ServerResponse } from "node:http";
import * as path from "node:path";
import { AddressInfo } from "node:net";
import { parseTarget } from "../handwave/parser";
import { renderTheoremExplorerHtml } from "../web/explorer";
import { renderLiveServerHtml } from "./client";
import {
  HandwaveLiveWorkspace,
  WorkspaceConflictError,
  WorkspaceTargetError
} from "./workspace";

export interface HandwaveServerOptions {
  rootDirectory: string;
  host?: string;
  port?: number;
  watch?: boolean;
}

export interface RunningHandwaveServer {
  server: Server;
  workspace: HandwaveLiveWorkspace;
  url: string;
  close(): Promise<void>;
}

export async function startHandwaveServer(
  options: HandwaveServerOptions
): Promise<RunningHandwaveServer> {
  const host = options.host ?? "127.0.0.1";
  const workspace = new HandwaveLiveWorkspace(options.rootDirectory);
  await workspace.initialize();
  const token = randomBytes(24).toString("base64url");
  const eventClients = new Set<ServerResponse>();
  let watcher: FSWatcher | undefined;
  const pendingWatchers = new Map<string, NodeJS.Timeout>();

  const broadcastWorkspace = () => {
    for (const response of eventClients) {
      response.write(`event: workspace\ndata: {}\n\n`);
    }
  };

  const server = createServer((request, response) => {
    void handleRequest(request, response, workspace, token, eventClients, broadcastWorkspace);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  if (options.watch !== false) {
    watcher = watch(workspace.root, { recursive: true }, (_event, rawFile) => {
      if (!rawFile) {
        return;
      }
      const relative = rawFile.toString();
      if (!isRelevantSource(relative)) {
        return;
      }
      const file = path.join(workspace.root, relative);
      const currentTimer = pendingWatchers.get(file);
      if (currentTimer) {
        clearTimeout(currentTimer);
      }
      pendingWatchers.set(file, setTimeout(() => {
        pendingWatchers.delete(file);
        void workspace.refreshFile(file).then((changed) => {
          if (changed) {
            broadcastWorkspace();
          }
        }).catch(() => undefined);
      }, 180));
    });
  }

  const address = server.address() as AddressInfo;
  const url = `http://${formatHost(host)}:${address.port}`;
  return {
    server,
    workspace,
    url,
    async close(): Promise<void> {
      watcher?.close();
      for (const timer of pendingWatchers.values()) {
        clearTimeout(timer);
      }
      pendingWatchers.clear();
      for (const response of eventClients) {
        response.end();
      }
      eventClients.clear();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }
  };
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  workspace: HandwaveLiveWorkspace,
  token: string,
  eventClients: Set<ServerResponse>,
  broadcastWorkspace: () => void
): Promise<void> {
  try {
    const origin = `http://${request.headers.host ?? "127.0.0.1"}`;
    const url = new URL(request.url ?? "/", origin);

    if (request.method === "GET" && url.pathname === "/") {
      const bootstrap = workspace.bootstrap();
      const html = renderTheoremExplorerHtml(bootstrap.payload, {
        articleItems: bootstrap.articleItems,
        milestoneControls: true,
        localNavigation: true,
        applicationShell: true
      });
      sendText(response, 200, renderLiveServerHtml(html, token), "text/html; charset=utf-8");
      return;
    }

    if (request.method === "GET" && url.pathname === "/assets/server-editor.js") {
      const editorClient = await fs.readFile(path.join(__dirname, "editorClient.js"), "utf8");
      sendText(response, 200, editorClient, "text/javascript; charset=utf-8");
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/bootstrap") {
      sendJson(response, 200, workspace.bootstrap());
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/preview") {
      const name = url.searchParams.get("name") ?? "";
      const html = workspace.previewHtml(name);
      if (html === undefined) {
        throw new WorkspaceTargetError(`Declaration not found: ${name}`);
      }
      sendJson(response, 200, { html });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/article") {
      const target = url.searchParams.get("target") ?? "";
      const article = workspace.article(target);
      if (!article) {
        throw new WorkspaceTargetError(`Article not found: ${target}`);
      }
      sendJson(response, 200, article);
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/declaration") {
      const target = parseTarget(url.searchParams.get("target") ?? "");
      const declaration = target.kind === "lean" ? workspace.declaration(target.base) : undefined;
      if (!declaration) {
        throw new WorkspaceTargetError(`Declaration not found: ${target.raw}`);
      }
      sendJson(response, 200, declaration);
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/events") {
      response.writeHead(200, {
        "cache-control": "no-cache",
        "connection": "keep-alive",
        "content-type": "text/event-stream; charset=utf-8",
        "x-accel-buffering": "no"
      });
      response.write(": connected\n\n");
      eventClients.add(response);
      request.on("close", () => eventClients.delete(response));
      return;
    }

    requireMutationToken(request, token);

    if (request.method === "PUT" && url.pathname === "/api/article") {
      const body = await readJsonBody(request);
      const target = stringField(body, "target");
      const source = stringField(body, "source");
      const revision = stringField(body, "revision");
      const article = await workspace.saveArticle(target, source, revision);
      sendJson(response, 200, article);
      broadcastWorkspace();
      return;
    }

    if (request.method === "PATCH" && url.pathname === "/api/declaration") {
      const body = await readJsonBody(request);
      const target = parseTarget(stringField(body, "target"));
      const revision = stringField(body, "revision");
      if (target.kind !== "lean") {
        throw new WorkspaceTargetError(`Not a Lean declaration target: ${target.raw}`);
      }
      const fields = objectField(body, "fields");
      const declaration = await workspace.saveDeclaration(target.base, {
        name: optionalStringField(fields, "name"),
        statement: optionalStringField(fields, "statement"),
        proof: optionalStringField(fields, "proof")
      }, revision);
      sendJson(response, 200, declaration);
      broadcastWorkspace();
      return;
    }

    if (request.method === "PUT" && url.pathname === "/api/tag") {
      const body = await readJsonBody(request);
      const target = parseTarget(stringField(body, "target"));
      const tag = stringField(body, "tag");
      const active = booleanField(body, "active");
      if (target.kind !== "lean") {
        throw new WorkspaceTargetError(`Not a Lean declaration target: ${target.raw}`);
      }
      const updatedActive = await workspace.setDeclarationTag(target.base, tag, active);
      sendJson(response, 200, { active: updatedActive });
      broadcastWorkspace();
      return;
    }

    sendJson(response, 404, { error: "Not found." });
  } catch (error) {
    if (error instanceof WorkspaceConflictError) {
      sendJson(response, 409, { error: error.message });
      return;
    }
    if (error instanceof WorkspaceTargetError || error instanceof RequestError) {
      sendJson(response, error instanceof RequestError ? error.status : 404, { error: error.message });
      return;
    }
    sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
  }
}

class RequestError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "RequestError";
  }
}

function requireMutationToken(request: IncomingMessage, token: string): void {
  if (request.headers["x-handwave-token"] !== token) {
    throw new RequestError(403, "Missing or invalid Handwave mutation token.");
  }
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 8 * 1024 * 1024) {
      throw new RequestError(413, "Request body is too large.");
    }
    chunks.push(buffer);
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("JSON object expected");
    }
    return value as Record<string, unknown>;
  } catch {
    throw new RequestError(400, "Malformed JSON request body.");
  }
}

function stringField(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  if (typeof field !== "string") {
    throw new RequestError(400, `Expected string field: ${key}`);
  }
  return field;
}

function optionalStringField(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key];
  if (field === undefined) {
    return undefined;
  }
  if (typeof field !== "string") {
    throw new RequestError(400, `Expected string field: ${key}`);
  }
  return field;
}

function booleanField(value: Record<string, unknown>, key: string): boolean {
  const field = value[key];
  if (typeof field !== "boolean") {
    throw new RequestError(400, `Expected boolean field: ${key}`);
  }
  return field;
}

function objectField(value: Record<string, unknown>, key: string): Record<string, unknown> {
  const field = value[key];
  if (!field || typeof field !== "object" || Array.isArray(field)) {
    throw new RequestError(400, `Expected object field: ${key}`);
  }
  return field as Record<string, unknown>;
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  sendText(response, status, JSON.stringify(value), "application/json; charset=utf-8");
}

function sendText(response: ServerResponse, status: number, value: string, contentType: string): void {
  if (response.headersSent) {
    response.end();
    return;
  }
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(value),
    "content-type": contentType,
    "x-content-type-options": "nosniff"
  });
  response.end(value);
}

function isRelevantSource(relative: string): boolean {
  return relative.endsWith(".lean") || relative.endsWith(".hw") || relative.endsWith(".hw.md");
}

function formatHost(host: string): string {
  return host.includes(":") ? `[${host}]` : host;
}
