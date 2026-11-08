/**
 * Variables a developer sets on purpose to opt a test into a live or external
 * dependency. Everything else under PI_FABRIC_ describes the Fabric run that
 * started the suite and would leak into hosts the tests build.
 */
const TEST_OPT_INS = new Set(["PI_FABRIC_JEV_LIVE", "PI_FABRIC_JEV_LOCALTERM", "PI_FABRIC_JEV_FABRIC_BIN", "PI_FABRIC_TEST_PI_BINARY"]);

/** Remove inherited Fabric run variables in place; returns the removed names. */
export function clearInheritedFabricEnv(env: NodeJS.ProcessEnv): string[] {
  const removed = Object.keys(env).filter((name) => name.startsWith("PI_FABRIC_") && !TEST_OPT_INS.has(name));
  for (const name of removed) delete env[name];
  return removed;
}
