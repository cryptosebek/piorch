import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_WORKFLOW_NAME = "default";

export function getPackagePiRoot(): string {
  const extensionDir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(extensionDir, "..", "..");
}

export function resolveWorkflowPath(cwd: string, name: string): string {
  const fileName = `${name}.workflow.json`;
  const projectPath = path.join(cwd, ".pi", "workflows", fileName);
  if (fs.existsSync(projectPath)) return projectPath;

  const packagePath = path.join(getPackagePiRoot(), "workflows", fileName);
  if (fs.existsSync(packagePath)) return packagePath;

  throw new Error(`Workflow not found: ${name}`);
}

export function resolveExtensionPath(cwd: string, extensionPath: string): string {
  const normalized = extensionPath.replace(/^\.\//, "");
  const packageRelative = normalized.replace(/^\.pi[\\/]/, "");
  const packageRoot = getPackagePiRoot();
  const candidates = [
    path.resolve(cwd, extensionPath),
    path.resolve(packageRoot, packageRelative),
    path.resolve(packageRoot, "extensions", packageRelative),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  return path.resolve(cwd, extensionPath);
}

export function resolveExtensionPaths(
  cwd: string,
  extensionPaths: string[] | undefined,
): string[] | undefined {
  if (!extensionPaths) return undefined;
  return extensionPaths.map((extensionPath) => resolveExtensionPath(cwd, extensionPath));
}

function copyTreeMissing(src: string, dest: string): boolean {
  if (!fs.existsSync(src)) return false;

  if (!fs.existsSync(dest)) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.cpSync(src, dest, { recursive: true });
    return true;
  }

  let srcStat: fs.Stats;
  let destStat: fs.Stats;
  try {
    srcStat = fs.statSync(src);
    destStat = fs.statSync(dest);
  } catch {
    return false;
  }

  if (!srcStat.isDirectory() || !destStat.isDirectory()) return false;

  let copied = false;
  for (const entry of fs.readdirSync(src)) {
    copied = copyTreeMissing(path.join(src, entry), path.join(dest, entry)) || copied;
  }
  return copied;
}

/** Copy editable defaults into the project without overwriting existing files. */
export function materializeProjectDefaults(cwd: string): string[] {
  const packagePiRoot = getPackagePiRoot();
  const created: string[] = [];
  const copies = [
    { src: path.join(packagePiRoot, "workflows"), dest: path.join(cwd, ".pi", "workflows") },
    { src: path.join(packagePiRoot, "agents"), dest: path.join(cwd, ".pi", "agents") },
  ];

  for (const { src, dest } of copies) {
    if (copyTreeMissing(src, dest)) {
      created.push(path.relative(cwd, dest));
    }
  }

  return created;
}
