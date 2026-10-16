import fs from "node:fs";

/**
 * A store file exists but could not be read or parsed. Callers must not treat
 * this as empty data: saving after it would erase the records on disk.
 */
export class ActorStoreReadError extends Error {
  readonly filePath: string;

  constructor(filePath: string, detail: string, options?: { cause?: unknown }) {
    super(`Cannot read Fabric actor store ${filePath}: ${detail}`, options);
    this.name = "ActorStoreReadError";
    this.filePath = filePath;
  }
}

/**
 * Read and parse a JSON store file. A missing file returns `undefined`; any
 * other read or parse failure throws ActorStoreReadError.
 */
export const readStoreJson = (filePath: string): unknown => {
  let text: string;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return undefined;
    throw new ActorStoreReadError(
      filePath,
      error instanceof Error ? error.message : String(error),
      { cause: error },
    );
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new ActorStoreReadError(
      filePath,
      `invalid JSON (${error instanceof Error ? error.message : String(error)})`,
      { cause: error },
    );
  }
};
