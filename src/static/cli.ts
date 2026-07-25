import * as path from "node:path";
import { exportHandwaveStaticSite } from "./exporter";

interface StaticExportArguments {
  rootDirectory: string;
  outputDirectory: string;
  singlePage: boolean;
}

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  if (!args) {
    process.stdout.write(usage());
    return;
  }

  const result = await exportHandwaveStaticSite(args.rootDirectory, args.outputDirectory, {
    singlePage: args.singlePage
  });
  const summary =
    `Exported ${result.theoremCount} theorems and ${result.articleCount} articles ` +
    `from ${result.declarationCount} declarations to ${result.outputFile}`;
  process.stdout.write(result.dataFile
    ? `${summary}, with compressed data at ${result.dataFile}.\n`
    : `${summary} as a self-contained page.\n`);
}

function parseArguments(argv: readonly string[]): StaticExportArguments | undefined {
  if (argv.includes("--help") || argv.includes("-h")) {
    return undefined;
  }

  let rootDirectory = process.cwd();
  let outputDirectory: string | undefined;
  let singlePage = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--single-page") {
      singlePage = true;
      continue;
    }
    if (argument === "--root" || argument === "--output") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error(`Missing value for ${argument}.`);
      }
      if (argument === "--root") {
        rootDirectory = path.resolve(value);
      } else {
        outputDirectory = path.resolve(value);
      }
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }

  return {
    rootDirectory,
    outputDirectory: outputDirectory ?? path.join(rootDirectory, "handwave-site"),
    singlePage
  };
}

function usage(): string {
  return [
    "Usage: npm run export-site -- [--root PATH] [--output DIRECTORY] [--single-page]",
    "",
    "Build a compressed, read-only Handwave theorem explorer.",
    "The root defaults to the current directory. The output directory defaults",
    "to ROOT/handwave-site and normally contains index.html plus",
    "handwave-data.json.gz. --single-page embeds the compressed data in",
    "index.html so it can be opened directly without a web server.",
    ""
  ].join("\n");
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`handwave static export failed: ${message}\n`);
  process.exitCode = 1;
});
