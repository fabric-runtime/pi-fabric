// Abort reasons Fabric issues as normal control flow. The brand is a global
// symbol, so the registration-time crash guard (crash-guard.ts) recognizes it
// without importing this module: lazy runtimes import it, the startup graph does not.
const CONTROL_ABORT = Symbol.for("pi-fabric.control-abort");

/** An Error marking an abort that Fabric issued as normal control flow. */
export const fabricControlAbort = (message: string): Error => {
  const error = new Error(message);
  Object.defineProperty(error, CONTROL_ABORT, { value: true });
  return error;
};
