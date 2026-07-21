import { blankLeanCommentsAndStrings } from "./parser";
import { LeanDeclaration, LeanDeclarationCheckStatus } from "./types";

export function collectLeanSourceCheckStatuses(
  declarations: readonly LeanDeclaration[]
): Map<string, LeanDeclarationCheckStatus> {
  const statuses = new Map<string, LeanDeclarationCheckStatus>();
  for (const declaration of declarations) {
    if (!isTheoremLikeDeclaration(declaration)) {
      continue;
    }
    const directIncompleteStatus = directIncompleteProofStatus(declaration);
    if (directIncompleteStatus) {
      statuses.set(declaration.name, directIncompleteStatus);
    }
  }
  return statuses;
}

function directIncompleteProofStatus(
  declaration: LeanDeclaration
): LeanDeclarationCheckStatus | undefined {
  const proof = declaration.leanProof ?? "";
  const searchableProof = blankLeanCommentsAndStrings(proof);
  const match = /\b(?:sorry|admit)\b/i.exec(searchableProof);
  if (!match) {
    return undefined;
  }

  const token = match[0].toLowerCase();
  return {
    checked: false,
    ownChecked: false,
    dependencies: [],
    failedDependencies: [],
    reason: `Lean declaration contains a direct \`${token}\`.`
  };
}

function isTheoremLikeDeclaration(declaration: LeanDeclaration): boolean {
  return declaration.kind === "theorem" || declaration.kind === "lemma";
}
