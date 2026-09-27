import path from "node:path";
import fs from "node:fs/promises";
import { constants } from "node:fs";
import { createHash, timingSafeEqual, randomUUID } from "node:crypto";

export function isLoopback(host: string): boolean {
  return ["127.0.0.1", "localhost", "::1", "[::1]"].includes(host);
}

export function requireApiToken(host: string, insightsConfigured: boolean, token: string): void {
  if ((!isLoopback(host) || insightsConfigured) && !token.trim()) {
    throw new Error("CVP_TOKEN is required when HOST is not loopback or Insights is configured");
  }
}

export function tokenMatches(header: string | undefined, token: string): boolean {
  const provided = header?.startsWith("Bearer ") ? header.slice(7) : "";
  const actual = createHash("sha256").update(provided).digest();
  const expected = createHash("sha256").update(token).digest();
  return Boolean(provided) && timingSafeEqual(actual, expected);
}

function within(root: string, target: string): boolean {
  return target !== root && target.startsWith(root + path.sep);
}

export async function secureRoot(root: string): Promise<string> {
  const absolute = path.resolve(root);
  if ((await fs.lstat(absolute)).isSymbolicLink()) throw new Error("Symlink root rejected");
  return fs.realpath(absolute);
}

export async function secureDirectory(root: string, relative: string, create = false): Promise<string> {
  const base = await secureRoot(root);
  const target = path.resolve(base, relative);
  if (target !== base && !within(base, target)) throw new Error("Path outside root");
  if (create) {
    // Create one component at a time; never recurse through an existing link.
    let current = base;
    for (const part of path.relative(base, target).split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      try { await fs.mkdir(current); } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      }
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Unsafe directory");
    }
  }
  const stat = await fs.lstat(target);
  if (stat.isSymbolicLink() || !stat.isDirectory() || await fs.realpath(target) !== target) {
    throw new Error("Unsafe directory");
  }
  return target;
}

export async function readContained(root: string, relative: string, extensions: string[]): Promise<string> {
  const base = await secureRoot(root);
  const target = path.resolve(base, relative);
  if (!within(base, target) || !extensions.includes(path.extname(target))) throw new Error("Unsafe file path");
  const parent = await secureDirectory(base, path.relative(base, path.dirname(target)));
  if (parent !== path.dirname(target)) throw new Error("Unsafe parent");
  const stat = await fs.lstat(target);
  if (stat.isSymbolicLink() || !stat.isFile() || !within(base, await fs.realpath(target))) {
    throw new Error("Unsafe file");
  }
  const handle = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!(await handle.stat()).isFile()) throw new Error("Unsafe file");
    return await handle.readFile({ encoding: "utf-8" });
  } finally { await handle.close(); }
}

export async function readOptional(root: string, relative: string, extensions: string[]): Promise<string | null> {
  try { return await readContained(root, relative, extensions); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export async function writeContained(root: string, relative: string, content: string): Promise<void> {
  const base = await secureRoot(root);
  const target = path.resolve(base, relative);
  if (!within(base, target) || path.extname(target) !== ".json") throw new Error("Unsafe write path");
  await secureDirectory(base, path.relative(base, path.dirname(target)), true);
  const existing = await fs.lstat(target).catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") return null;
    throw err;
  });
  if (existing && (!existing.isFile() || existing.isSymbolicLink())) throw new Error("Unsafe output file");
  const temp = path.join(path.dirname(target), `.cvp-${randomUUID()}.tmp`);
  const handle = await fs.open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(content);
    await secureDirectory(base, path.relative(base, path.dirname(target)));
    const latest = await fs.lstat(target).catch((err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") return null;
      throw err;
    });
    if (latest && (!latest.isFile() || latest.isSymbolicLink())) throw new Error("Unsafe output file");
    await fs.rename(temp, target);
  } finally {
    await handle.close();
    await fs.rm(temp, { force: true });
  }
}

export function requireRelative(value: string, extension?: string): string {
  if (!value || path.isAbsolute(value) || path.win32.isAbsolute(value) || value.split(/[\\/]/).includes("..") ||
      (extension && path.extname(value) !== extension)) throw new Error("Insights path must be relative to CVP_INSIGHTS_ROOT");
  return value;
}
