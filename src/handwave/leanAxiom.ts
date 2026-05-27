export function parseLeanAxiomOutput(output: string): Map<string, string[]> {
  const axiomsByName = new Map<string, string[]>();
  const dependsPattern = /'([^']+)'\s+depends on axioms:\s+\[([^\]]*)\]/g;
  for (const match of output.matchAll(dependsPattern)) {
    axiomsByName.set(
      match[1],
      match[2].split(",").map((axiom) => axiom.trim()).filter(Boolean)
    );
  }

  const noAxiomsPattern = /'([^']+)'\s+does not depend on any axioms/g;
  for (const match of output.matchAll(noAxiomsPattern)) {
    if (!axiomsByName.has(match[1])) {
      axiomsByName.set(match[1], []);
    }
  }

  return axiomsByName;
}
