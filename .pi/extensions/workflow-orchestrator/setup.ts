import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export function getPackagePiRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

/** Copy editable defaults without overwriting project files or copying sessions. */
export function materializeProjectDefaults(cwd: string): void {
  for (const directory of ["workflows", "agents"]) {
    const source = path.join(getPackagePiRoot(), directory);
    const destination = path.join(cwd, ".pi", directory);
    const suffix = directory === "workflows" ? ".workflow.json" : ".md";
    for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(suffix)) continue;
      const target = path.join(destination, entry.name);
      if (fs.existsSync(target)) continue;
      fs.mkdirSync(destination, { recursive: true });
      fs.cpSync(path.join(source, entry.name), target, { force: false });
    }
  }
}

export function resolveExtensionPaths(
  cwd: string,
  extensions: string[] | undefined,
): string[] | undefined {
  return extensions?.map((extension) => {
    const projectPath = path.resolve(cwd, extension);
    if (fs.existsSync(projectPath)) return projectPath;
    const packagePath = path.resolve(getPackagePiRoot(), "..", extension);
    return fs.existsSync(packagePath) ? packagePath : projectPath;
  });
}
