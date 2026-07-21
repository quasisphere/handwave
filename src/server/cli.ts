import * as path from "node:path";
import { startHandwaveServer } from "./server";

interface ServerArguments {
  rootDirectory: string;
  host: string;
  port: number;
}

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  process.stdout.write(`Indexing ${args.rootDirectory}…\n`);
  const running = await startHandwaveServer({
    rootDirectory: args.rootDirectory,
    host: args.host,
    port: args.port
  });
  process.stdout.write(`Handwave is editing the live repository at ${running.url}\n`);

  let closing = false;
  const close = () => {
    if (closing) {
      return;
    }
    closing = true;
    void running.close().finally(() => process.exit(0));
  };
  process.on("SIGINT", close);
  process.on("SIGTERM", close);
}

function parseArguments(argv: string[]): ServerArguments {
  let rootDirectory = process.cwd();
  let host = "127.0.0.1";
  let port = 8080;

  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === "--root") {
      rootDirectory = requiredValue(argv, ++index, argument);
      continue;
    }
    if (argument === "--host") {
      host = requiredValue(argv, ++index, argument);
      continue;
    }
    if (argument === "--port") {
      const rawPort = requiredValue(argv, ++index, argument);
      port = Number(rawPort);
      if (!Number.isInteger(port) || port < 0 || port > 65535) {
        throw new Error(`Invalid port: ${rawPort}`);
      }
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      process.stdout.write([
        "Usage: npm run serve -- [--root PATH] [--host HOST] [--port PORT]",
        "",
        "The server edits the selected repository's .lean, .hw, and .hw.md files directly.",
        "It binds to 127.0.0.1:8080 by default."
      ].join("\n") + "\n");
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${argument}`);
  }

  return {
    rootDirectory: path.resolve(rootDirectory),
    host,
    port
  };
}

function requiredValue(argv: string[], index: number, option: string): string {
  const value = argv[index];
  if (!value) {
    throw new Error(`Missing value for ${option}`);
  }
  return value;
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`handwave server failed: ${message}\n`);
  process.exitCode = 1;
});
