import { config as loadDotenv } from "dotenv";
import * as fs from "node:fs";
import * as path from "node:path";

type ProcessEnv = Record<string, string | undefined>;

/** Walk upward from cwd to find the pi project root (has .pi/agents or pi package.json). */
export function findProjectRoot(startDir: string): string | null {
  let current = path.resolve(startDir);
  while (true) {
    if (fs.existsSync(path.join(current, ".pi", "agents"))) return current;

    const pkgPath = path.join(current, "package.json");
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as {
          pi?: { extensions?: unknown };
        };
        if (pkg.pi?.extensions) return current;
      } catch {
        /* ignore malformed package.json */
      }
    }

    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

const loadedRoots = new Set<string>();

/** Load `.env` from the project root into `process.env` (does not override existing vars). */
export function loadProjectEnv(cwd: string): void {
  const root = findProjectRoot(cwd) ?? path.resolve(cwd);
  if (loadedRoots.has(root)) return;

  const envPath = path.join(root, ".env");
  if (fs.existsSync(envPath)) {
    loadDotenv({ path: envPath });
  }
  loadedRoots.add(root);
}

/** Environment for spawned `pi` subagents: parent env plus project `.env`. */
export function getSubagentEnv(cwd: string): ProcessEnv {
  loadProjectEnv(cwd);
  return { ...process.env };
}
