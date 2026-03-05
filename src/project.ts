import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import ignore from "ignore";

export async function runCommand(
  args: string[],
  cwd?: string,
  stdinContent?: string | Uint8Array
): Promise<{ stdout: Uint8Array; stderr: string; code: number }> {
  const proc = Bun.spawn({
    cmd: args,
    cwd,
    stdin: stdinContent ? "pipe" : "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  if (stdinContent) {
    const data = typeof stdinContent === "string" ? new TextEncoder().encode(stdinContent) : stdinContent;
    proc.stdin?.write(data);
    proc.stdin?.end();
  }

  const [stdoutBuf, stderrBuf, code] = await Promise.all([
    new Response(proc.stdout).arrayBuffer(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return { stdout: new Uint8Array(stdoutBuf), stderr: stderrBuf, code };
}

async function collectFilesWithGit(projectDir: string): Promise<string[] | null> {
  const check = await runCommand(["git", "-C", projectDir, "rev-parse", "--is-inside-work-tree"]);
  if (check.code !== 0) return null;
  const res = await runCommand(["git", "-C", projectDir, "ls-files", "--cached", "--others", "--exclude-standard", "-z"]);
  if (res.code !== 0) return null;
  return new TextDecoder()
    .decode(res.stdout)
    .split("\0")
    .map((e) => e.trim())
    .filter(Boolean);
}

async function collectFilesFallback(projectDir: string): Promise<string[]> {
  const result: string[] = [];
  const ignoredDirs = new Set([".git", "node_modules", ".next", ".turbo", "dist", "build", "coverage", "__pycache__", ".venv"]);
  const ig = ignore();

  try {
    const gitignore = await readFile(path.join(projectDir, ".gitignore"), "utf8");
    ig.add(gitignore);
  } catch {
    // no .gitignore
  }

  async function walk(current: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".DS_Store")) continue;
      if (entry.isDirectory() && ignoredDirs.has(entry.name)) continue;
      const abs = path.join(current, entry.name);
      const rel = path.relative(projectDir, abs).split(path.sep).join("/");
      const relForMatch = entry.isDirectory() ? `${rel}/` : rel;
      if (ig.ignores(relForMatch)) continue;
      if (entry.isDirectory()) await walk(abs);
      else if (entry.isFile()) result.push(rel);
    }
  }

  await walk(projectDir);
  return result;
}

export async function listProjectFiles(projectDir: string): Promise<string[]> {
  return (await collectFilesWithGit(projectDir)) ?? (await collectFilesFallback(projectDir));
}

export async function readProjectSnapshot(projectDir: string): Promise<Map<string, Uint8Array>> {
  const fileList = await listProjectFiles(projectDir);
  const snapshot = new Map<string, Uint8Array>();
  for (const relPath of fileList) {
    const content = await readFile(path.join(projectDir, relPath));
    snapshot.set(relPath, content);
  }
  return snapshot;
}

export async function zipProject(projectDir: string): Promise<{ data: Uint8Array; fileCount: number }> {
  const fileList = await listProjectFiles(projectDir);
  if (fileList.length === 0) throw new Error("No files found to upload.");

  const zip = new JSZip();
  for (const relPath of fileList) {
    const content = await readFile(path.join(projectDir, relPath));
    zip.file(relPath, content);
  }

  const data = await zip.generateAsync({
    type: "uint8array",
    compression: "DEFLATE",
    compressionOptions: { level: 9 },
  });

  return { data, fileCount: fileList.length };
}

export async function writeDiffContent(projectDir: string, relPath: string, newContent: string) {
  const safePath = relPath.replace(/^\/+/, "");
  const target = path.join(projectDir, safePath);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, newContent, "utf8");
}
