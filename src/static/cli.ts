import * as path from "node:path";
import { exportHandwaveStaticSite } from "./exporter";

interface StaticExportArguments {
  rootDirectory: string;
  outputFile: string;
}

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  if (!args) {
    process.stdout.write(usage());
    return;
  }

  const result = await exportHandwaveStaticSite(args.rootDirectory, args.outputFile);
  process.stdout.write(
    `Exported ${result.theoremCount} theorems and ${result.articleCount} articles ` +
    `from ${result.declarationCount} declarations to ${result.outputFile}.\n`
  );
}

function parseArguments(argv: readonly string[]): StaticExportArguments | undefined {
  if (argv.includes("--help") || argv.includes("-h")) {
    return undefined;
  }

  let rootDirectory = process.cwd();
  let outputFile: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--root" || argument === "--output") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error(`Missing value for ${argument}.`);
      }
      if (argument === "--root") {
        rootDirectory = path.resolve(value);
      } else {
        outputFile = path.resolve(value);
      }
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }

  return {
    rootDirectory,
    outputFile: outputFile ?? path.join(rootDirectory, "handwave-site", "index.html")
  };
}

function usage(): string {
  return [
    "Usage: npm run export-site -- [--root PATH] [--output FILE]",
    "",
    "Build a single-file, read-only Handwave theorem explorer.",
    "The root defaults to the current directory and the output defaults to",
    "ROOT/handwave-site/index.html.",
    ""
  ].join("\n");
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`handwave static export failed: ${message}\n`);
  process.exitCode = 1;
});
