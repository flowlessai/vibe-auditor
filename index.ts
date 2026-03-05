#!/usr/bin/env bun

import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import JSZip from "jszip";
import ignore from "ignore";

type DeviceLoginCreateResponse = {
  authorizationId: string;
  code: string;
  expiresIn: number;
  verificationUrl: string;
};

type DeviceLoginApprovedResponse = {
  status: "approved";
  accessToken: string;
  tokenType: string;
  expiresIn: number;
  userId: string;
};

type DeviceLoginPendingResponse = { status: "pending" };
type DeviceLoginExpiredResponse = { status: "expired" };

type CreateTaskResponse = { taskId: string };

type TaskStatus = "INDEXING" | "GENERATING_ARTIFACTS" | "SYSTEM_CHECK" | "APPLYING_DIFFS" | "DONE" | "FAILED";

type TaskStatusResponse = {
  id: string;
  status: TaskStatus;
  paused: boolean;
  artifacts: unknown[];
  diffs: unknown[];
  analysis: unknown;
  createdAt: number;
  updatedAt: number;
};

const API_BASE_URL = process.env.FLOWLESS_API_URL ?? "https://api.flowlessai.one";
const CONFIG_DIR = path.join(os.homedir(), ".config", "flowlessai");
const TOKEN_FILE = path.join(CONFIG_DIR, "auditor-auth.json");
const POLL_INTERVAL_MS = 2000;

const color = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function clearScreen(): void {
  output.write("\x1b[2J\x1b[H");
}

function printHelp(): void {
  console.log(`${color.bold}Flowless Auditor CLI${color.reset}

Usage:
  auditor login
  auditor logout
  auditor resume <taskId>
  auditor <directory>

Notes:
  - Use "." for the current directory.
  - Press Ctrl+C while running to pause the task and exit.
`);
}

type RequestBody = FormData | string | Uint8Array | null;

async function request<T>(method: string, endpoint: string, options: { token?: string; body?: RequestBody } = {}): Promise<T> {
  const headers = new Headers();
  if (options.token) headers.set("Authorization", `Bearer ${options.token}`);

  const response = await fetch(`${API_BASE_URL}${endpoint}`, {
    method,
    headers,
    body: options.body ?? null,
  });

  if (!response.ok) {
    const maybeJson = await response.text();
    throw new Error(`API ${method} ${endpoint} failed (${response.status}): ${maybeJson || "Unknown error"}`);
  }

  return (await response.json()) as T;
}

async function loadToken(): Promise<string | null> {
  try {
    const raw = await readFile(TOKEN_FILE, "utf8");
    const parsed = JSON.parse(raw) as { accessToken?: string };
    return parsed.accessToken ?? null;
  } catch {
    return null;
  }
}

async function saveToken(accessToken: string): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(TOKEN_FILE, JSON.stringify({ accessToken }, null, 2), { mode: 0o600 });
}

async function deleteToken(): Promise<void> {
  await rm(TOKEN_FILE, { force: true });
}

async function runCommand(args: string[], cwd?: string, stdinContent?: string | Uint8Array): Promise<{ stdout: Uint8Array; stderr: string; code: number }> {
  const proc = Bun.spawn({
    cmd: args,
    cwd,
    stdin: stdinContent ? "pipe" : "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  if (stdinContent) {
    if (typeof stdinContent === "string") {
      proc.stdin?.write(new TextEncoder().encode(stdinContent));
    } else {
      proc.stdin?.write(stdinContent);
    }
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
  if (res.code !== 0) {
    throw new Error(`Failed to list files with git: ${res.stderr}`);
  }
  const decoded = new TextDecoder().decode(res.stdout);
  return decoded
    .split("\0")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

async function collectFilesFallback(projectDir: string): Promise<string[]> {
  const result: string[] = [];
  const ignoredDirs = new Set([".git", "node_modules", ".next", ".turbo", "dist", "build", "coverage"]);
  const ig = ignore();

  try {
    const gitignore = await readFile(path.join(projectDir, ".gitignore"), "utf8");
    ig.add(gitignore);
  } catch {
    // No .gitignore file; continue with default ignores only.
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

      if (entry.isDirectory()) {
        await walk(abs);
      } else if (entry.isFile()) {
        result.push(rel);
      }
    }
  }

  await walk(projectDir);
  return result;
}

async function zipDirectoryInMemory(projectDir: string): Promise<Uint8Array> {
  const fileList = (await collectFilesWithGit(projectDir)) ?? (await collectFilesFallback(projectDir));
  if (fileList.length === 0) throw new Error("No files found to upload.");

  const zip = new JSZip();
  for (const relPath of fileList) {
    const absPath = path.join(projectDir, relPath);
    const content = await readFile(absPath);
    zip.file(relPath, content);
  }

  const data = await zip.generateAsync({
    type: "uint8array",
    compression: "DEFLATE",
    compressionOptions: { level: 9 },
  });

  return data;
}

async function login(): Promise<void> {
  const response = await request<DeviceLoginCreateResponse>("POST", "/auth/login");
  const expiresAt = Date.now() + response.expiresIn * 1000;

  console.log(`${color.bold}Device Login${color.reset}`);
  console.log(`Open: ${color.cyan}${response.verificationUrl}${color.reset}`);
  console.log(`Code: ${color.bold}${response.code}${color.reset}`);
  console.log("Waiting for approval...");

  while (Date.now() < expiresAt) {
    const pollResponse = await fetch(`${API_BASE_URL}/auth/login/${response.authorizationId}`, {
      method: "GET",
    });

    if (pollResponse.status === 202) {
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    if (pollResponse.status === 410) {
      const body = (await pollResponse.json()) as DeviceLoginExpiredResponse;
      if (body.status === "expired") {
        throw new Error("Device login expired. Run `auditor login` again.");
      }
    }

    if (pollResponse.status === 200) {
      const body = (await pollResponse.json()) as DeviceLoginApprovedResponse;
      await saveToken(body.accessToken);
      console.log(`${color.green}Login successful.${color.reset} Token saved globally.`);
      return;
    }

    if (!pollResponse.ok) {
      const text = await pollResponse.text();
      throw new Error(`Login polling failed (${pollResponse.status}): ${text}`);
    }

    const pending = (await pollResponse.json()) as DeviceLoginPendingResponse;
    if (pending.status === "pending") {
      await sleep(POLL_INTERVAL_MS);
      continue;
    }
  }

  throw new Error("Login timeout reached.");
}

async function logout(): Promise<void> {
  const token = await loadToken();
  if (!token) {
    console.log("No active session.");
    return;
  }

  try {
    await request<{ ok: boolean }>("POST", "/auth/revoke", { token });
  } catch (error) {
    console.error(`${color.yellow}Warning:${color.reset} Failed to revoke token remotely. Removing local token anyway.`);
    console.error(String(error));
  }

  await deleteToken();
  console.log(`${color.green}Logged out.${color.reset} Local token deleted.`);
}

type ExtractedDiff = {
  path: string;
  patch?: string;
  newContent?: string;
};

function extractDiffs(rawDiffs: unknown[]): ExtractedDiff[] {
  const extracted: ExtractedDiff[] = [];

  for (const entry of rawDiffs) {
    if (!entry || typeof entry !== "object") continue;
    const obj = entry as Record<string, unknown>;

    const patch = typeof obj.patch === "string" ? obj.patch : typeof obj.diff === "string" ? obj.diff : undefined;
    const pathValue =
      typeof obj.path === "string"
        ? obj.path
        : typeof obj.filePath === "string"
          ? obj.filePath
          : typeof obj.filename === "string"
            ? obj.filename
            : typeof obj.file === "string"
              ? obj.file
              : "unknown-file";
    const newContent =
      typeof obj.newContent === "string"
        ? obj.newContent
        : typeof obj.content === "string"
          ? obj.content
          : typeof obj.after === "string"
            ? obj.after
            : undefined;

    extracted.push({ path: pathValue, patch, newContent });
  }

  return extracted;
}

function printPatch(patch: string): void {
  const lines = patch.split("\n");
  for (const line of lines) {
    if (line.startsWith("+++ ") || line.startsWith("--- ") || line.startsWith("@@")) {
      console.log(`${color.cyan}${line}${color.reset}`);
      continue;
    }
    if (line.startsWith("+")) {
      console.log(`${color.green}${line}${color.reset}`);
      continue;
    }
    if (line.startsWith("-")) {
      console.log(`${color.red}${line}${color.reset}`);
      continue;
    }
    console.log(line);
  }
}

async function promptApplyDiffs(): Promise<boolean> {
  const rl = createInterface({ input, output });
  try {
    const answer = (await rl.question("Apply these diffs locally? (y/N): ")).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

async function applyDiffs(projectDir: string, diffs: ExtractedDiff[]): Promise<void> {
  const patchChunks = diffs.map((d) => d.patch).filter((v): v is string => Boolean(v));
  if (patchChunks.length > 0) {
    const patchText = patchChunks.join("\n");
    const apply = await runCommand(["git", "-C", projectDir, "apply", "--whitespace=nowarn", "-"], undefined, patchText);
    if (apply.code !== 0) {
      throw new Error(`Failed to apply patch with git apply: ${apply.stderr}`);
    }
    return;
  }

  let appliedAny = false;
  for (const diff of diffs) {
    if (!diff.newContent || !diff.path || diff.path === "unknown-file") continue;
    const safePath = diff.path.replace(/^\/+/, "");
    const target = path.join(projectDir, safePath);
    const targetDir = path.dirname(target);
    await mkdir(targetDir, { recursive: true });
    await writeFile(target, diff.newContent, "utf8");
    appliedAny = true;
  }

  if (!appliedAny) {
    throw new Error("Unsupported diff format. Could not apply locally.");
  }
}

function renderLiveScreen(task: TaskStatusResponse, elapsedMs: number, animFrame: number): void {
  const spinnerFrames = ["[=   ]", "[==  ]", "[=== ]", "[ ===]", "[  ===]", "[   ==]", "[    =]"];
  const orbitFrames = ["(o   O   o)", "( o   O   )", "(  o   O  )", "(   o   O )", "(    o   O)", "(O    o   )", "( O    o  )"];

  clearScreen();
  console.log(`${color.bold}Flowless Auditor${color.reset}`);
  console.log(`${color.gray}${new Date().toISOString()}${color.reset}`);
  console.log("");
  console.log(`Task ID : ${task.id}`);
  console.log(`Status  : ${color.blue}${task.status}${color.reset}${task.paused ? ` ${color.yellow}(PAUSED)${color.reset}` : ""}`);
  console.log(`Uptime  : ${Math.floor(elapsedMs / 1000)}s`);
  console.log(`Items   : ${task.artifacts.length} artifacts, ${task.diffs.length} diffs`);
  console.log("");
  console.log(`${spinnerFrames[animFrame % spinnerFrames.length]}  Processing project`);
  console.log(`${orbitFrames[animFrame % orbitFrames.length]}  AI objects in motion`);
  console.log("");
  console.log(`${color.dim}Press Ctrl+C to pause and exit.${color.reset}`);
}

async function monitorTask(taskId: string, token: string, projectDir: string): Promise<void> {
  const startedAt = Date.now();
  let animFrame = 0;
  let latestStatus: TaskStatusResponse | null = null;
  let stopped = false;
  let pauseRequested = false;

  const animationTimer = setInterval(() => {
    if (latestStatus && !stopped) renderLiveScreen(latestStatus, Date.now() - startedAt, animFrame++);
  }, 120);

  const onSigint = async () => {
    if (pauseRequested) return;
    pauseRequested = true;
    console.log(`\n${color.yellow}Pausing task...${color.reset}`);
    try {
      await request<{ ok: boolean; message: string }>("POST", `/pause/${taskId}`, { token });
      console.log(`${color.green}Task paused.${color.reset}`);
      console.log(`Resume later with: ${color.bold}auditor resume ${taskId}${color.reset}`);
    } catch (error) {
      console.error(`${color.red}Failed to pause task:${color.reset} ${String(error)}`);
      console.log(`Try later with: ${color.bold}auditor resume ${taskId}${color.reset}`);
    } finally {
      stopped = true;
      clearInterval(animationTimer);
      process.off("SIGINT", onSigint);
      process.exit(130);
    }
  };

  process.on("SIGINT", onSigint);

  try {
    while (!stopped) {
      const status = await request<TaskStatusResponse>("GET", `/status/${taskId}`, { token });
      latestStatus = status;

      if (status.paused) {
        stopped = true;
        break;
      }

      if (status.status === "DONE") {
        stopped = true;
        clearInterval(animationTimer);
        process.off("SIGINT", onSigint);
        clearScreen();
        console.log(`${color.green}${color.bold}Task completed.${color.reset}`);
        console.log(`Task ID: ${status.id}`);
        console.log(`Diff count: ${status.diffs.length}`);
        console.log("");

        const diffs = extractDiffs(status.diffs);
        if (diffs.length === 0) {
          console.log("No diffs to apply.");
          return;
        }

        console.log(`${color.bold}Proposed diffs${color.reset}`);
        for (const diff of diffs) {
          console.log(`\n${color.bold}${diff.path}${color.reset}`);
          if (diff.patch) {
            printPatch(diff.patch);
          } else if (diff.newContent) {
            console.log(`${color.green}+ full file content available (${diff.newContent.length} chars)${color.reset}`);
          } else {
            console.log(`${color.yellow}No preview available for this diff entry.${color.reset}`);
          }
        }

        const shouldApply = await promptApplyDiffs();
        if (!shouldApply) {
          console.log("Diffs were not applied.");
          return;
        }

        await applyDiffs(projectDir, diffs);
        console.log(`${color.green}Diffs applied locally.${color.reset}`);
        return;
      }

      if (status.status === "FAILED") {
        stopped = true;
        clearInterval(animationTimer);
        process.off("SIGINT", onSigint);
        clearScreen();
        console.error(`${color.red}${color.bold}Task failed.${color.reset}`);
        if (status.analysis) {
          console.error(typeof status.analysis === "string" ? status.analysis : JSON.stringify(status.analysis, null, 2));
        }
        return;
      }

      await sleep(POLL_INTERVAL_MS);
    }
  } finally {
    clearInterval(animationTimer);
    process.off("SIGINT", onSigint);
  }
}

async function createTaskAndMonitor(projectArg: string): Promise<void> {
  const token = await loadToken();
  if (!token) {
    throw new Error("Not logged in. Run `auditor login` first.");
  }

  const projectDir = path.resolve(process.cwd(), projectArg === "." ? "." : projectArg);
  const stats = await stat(projectDir).catch(() => null);
  if (!stats || !stats.isDirectory()) {
    throw new Error(`Directory does not exist: ${projectDir}`);
  }

  console.log(`Preparing project zip from ${projectDir}...`);
  const zipped = await zipDirectoryInMemory(projectDir);
  console.log(`Archive created in memory (${zipped.length} bytes).`);

  const form = new FormData();
  form.append("zip", new File([zipped], `${path.basename(projectDir) || "project"}.zip`, { type: "application/zip" }));
  form.append("name", path.basename(projectDir) || "project");

  const created = await request<CreateTaskResponse>("POST", "/auditor", { token, body: form });
  console.log(`Task created: ${created.taskId}`);
  await monitorTask(created.taskId, token, projectDir);
}

async function resumeTask(taskId: string): Promise<void> {
  const token = await loadToken();
  if (!token) {
    throw new Error("Not logged in. Run `auditor login` first.");
  }

  const projectDir = process.cwd();
  await request<{ ok: boolean; message: string }>("POST", `/resume/${taskId}`, { token });
  await monitorTask(taskId, token, projectDir);
}

async function main(): Promise<void> {
  const [, , ...args] = process.argv;
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    printHelp();
    return;
  }

  const command = args[0];
  if (!command) {
    printHelp();
    return;
  }

  if (command === "login") {
    await login();
    return;
  }

  if (command === "logout") {
    await logout();
    return;
  }

  if (command === "resume") {
    const taskId = args[1];
    if (!taskId) {
      throw new Error("Missing task id. Usage: auditor resume <taskId>");
    }
    await resumeTask(taskId);
    return;
  }

  await createTaskAndMonitor(command);
}

main().catch((error) => {
  console.error(`${color.red}Error:${color.reset} ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
