/**
 * Reading the repository, once, for every contract test in this directory.
 *
 * The file lists are DERIVED, not written down: the server modules come from the
 * entry point's imports, the client modules from the web/ directory itself. A new
 * router or a new client file is therefore covered the moment it exists — adding
 * a name to a list here would be the exact failure mode these tests exist to
 * prevent.
 */
import { importedModules } from "./route_contract.ts";

const url = (path: string) => new URL(`../../${path}`, import.meta.url);

/** The repository root, as a path (for spawning the server). */
export const ROOT_PATH = new URL("../../", import.meta.url).pathname;

export const ENTRY = "api/main.ts";

export function read(path: string): Promise<string> {
  return Deno.readTextFile(url(path));
}

/** Every .js file under web/, in a stable order. */
export async function clientFiles(): Promise<string[]> {
  const files: string[] = [];
  for await (const entry of Deno.readDir(url("web"))) {
    if (entry.isFile && entry.name.endsWith(".js")) files.push(`web/${entry.name}`);
  }
  return files.sort();
}

/** Every .html file under web/, in a stable order. */
export async function htmlFiles(): Promise<string[]> {
  const files: string[] = [];
  for await (const entry of Deno.readDir(url("web"))) {
    if (entry.isFile && entry.name.endsWith(".html")) files.push(`web/${entry.name}`);
  }
  return files.sort();
}

/**
 * The entry point plus every module it imports that exists on disk (the imports
 * are all relative, so this needs no resolution rules beyond the path join).
 */
export async function serverSources(): Promise<Array<{ file: string; source: string }>> {
  const entrySource = await read(ENTRY);
  const sources = [{ file: ENTRY, source: entrySource }];
  for (const [, file] of importedModules(ENTRY, entrySource)) {
    try {
      sources.push({ file, source: await read(file) });
    } catch {
      // An import that is not a local file (a URL, or a permission problem):
      // nothing here can be read, and the tests assert the counts they expect.
    }
  }
  return sources;
}
