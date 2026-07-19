export type LeanDependencyCheckBackend = "leanServer" | "subprocess";

export function shouldUseLeanServerDiagnostics(
  dependencyChecksEnabled: boolean,
  backend: LeanDependencyCheckBackend
): boolean {
  return dependencyChecksEnabled && backend === "leanServer";
}
