import { ArticleDocument, LeanDeclaration, ParseIssue } from "./types";
import { HandwaveIndex } from "./index";
import { isSupportedSelector, parseTarget } from "./parser";

export interface DiagnosticIssue {
  uri: string;
  message: string;
  range: ParseIssue["range"];
  severity: "error" | "warning";
}

export function collectDiagnostics(
  index: HandwaveIndex,
  declarations: LeanDeclaration[],
  articles: ArticleDocument[]
): DiagnosticIssue[] {
  const issues: DiagnosticIssue[] = [];

  for (const declaration of declarations) {
    for (const error of declaration.doc?.errors ?? []) {
      issues.push({
        uri: declaration.uri,
        message: error.message,
        range: error.range,
        severity: "error"
      });
    }
  }

  for (const article of articles) {
    for (const error of article.errors) {
      issues.push({
        uri: article.uri,
        message: error.message,
        range: error.range,
        severity: "error"
      });
    }

    for (const link of article.links) {
      addTargetDiagnostic(index, issues, article.uri, link.target, link.targetRange, false);
    }

    for (const include of article.includes) {
      addTargetDiagnostic(index, issues, article.uri, include.target, include.targetRange, true);
    }
  }

  return issues;
}

function addTargetDiagnostic(
  index: HandwaveIndex,
  issues: DiagnosticIssue[],
  fromUri: string,
  rawTarget: string,
  range: ParseIssue["range"],
  isInclude: boolean
): void {
  const target = parseTarget(rawTarget);
  if (target.kind === "term") {
    return;
  }

  if (target.kind === "unknown") {
    issues.push({
      uri: fromUri,
      message: `Unknown Handwave target scheme in '${rawTarget}'.`,
      range,
      severity: "warning"
    });
    return;
  }

  if (!isSupportedSelector(target.selector)) {
    issues.push({
      uri: fromUri,
      message: `Unknown Handwave selector '${target.selector}' in '${rawTarget}'.`,
      range,
      severity: "warning"
    });
    return;
  }

  if (isInclude && !target.selector && (target.kind === "lean" || target.kind === "doc")) {
    issues.push({
      uri: fromUri,
      message: `Transclusion '${rawTarget}' should include a selector such as .statement or .prose.short.`,
      range,
      severity: "warning"
    });
    return;
  }

  if (!index.resolveParsed(target, fromUri)) {
    issues.push({
      uri: fromUri,
      message: `Unresolved Handwave target '${rawTarget}'.`,
      range,
      severity: "warning"
    });
  }
}
