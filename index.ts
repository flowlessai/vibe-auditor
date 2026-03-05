#!/usr/bin/env bun

import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import JSZip from "jszip";
import ignore from "ignore";

// ─────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────

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

type TaskStatus =
  | "INDEXING"
  | "GENERATING_ARTIFACTS"
  | "SYSTEM_CHECK"
  | "APPLYING_DIFFS"
  | "DONE"
  | "FAILED";

type Artifact = {
  file?: string;
  path?: string;
  filePath?: string;
  filename?: string;
  findings?: string[];
  issues?: string[];
  summary?: string;
  description?: string;
  severity?: string;
  [key: string]: unknown;
};

type RawDiff = {
  patch?: string;
  diff?: string;
  path?: string;
  filePath?: string;
  filename?: string;
  file?: string;
  newContent?: string;
  content?: string;
  after?: string;
  [key: string]: unknown;
};

type TaskStatusResponse = {
  id: string;
  status: TaskStatus;
  paused: boolean;
  artifacts: Artifact[];
  diffs: RawDiff[];
  analysis: unknown;
  createdAt: number;
  updatedAt: number;
};

type ExtractedDiff = {
  path: string;
  patch?: string;
  newContent?: string;
};

// ─────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────

const API_BASE_URL = process.env.FLOWLESS_API_URL ?? "https://api.flowlessai.one";
const CONFIG_DIR = path.join(os.homedir(), ".config", "flowlessai");
const TOKEN_FILE = path.join(CONFIG_DIR, "auditor-auth.json");
const POLL_INTERVAL_MS = 2000;

// ─────────────────────────────────────────────
// TERMINAL UI
// ─────────────────────────────────────────────

const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  italic: "\x1b[3m",
  underline: "\x1b[4m",
  // Foreground
  black: "\x1b[30m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
  gray: "\x1b[90m",
  brightRed: "\x1b[91m",
  brightGreen: "\x1b[92m",
  brightYellow: "\x1b[93m",
  brightBlue: "\x1b[94m",
  brightMagenta: "\x1b[95m",
  brightCyan: "\x1b[96m",
  brightWhite: "\x1b[97m",
  // Background
  bgBlack: "\x1b[40m",
  bgBlue: "\x1b[44m",
  bgCyan: "\x1b[46m",
};

const W = process.stdout.columns || 80;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function cls() {
  output.write("\x1b[2J\x1b[H");
}

function hideCursor() {
  output.write("\x1b[?25l");
}

function showCursor() {
  output.write("\x1b[?25h");
}

function moveTo(row: number, col: number) {
  output.write(`\x1b[${row};${col}H`);
}

function write(text: string) {
  output.write(text);
}

function line(char = "─", color = c.gray) {
  return `${color}${char.repeat(Math.min(W - 2, 76))}${c.reset}`;
}

function box(text: string, borderColor = c.cyan) {
  const inner = text.padEnd(Math.min(W - 4, 74));
  return [
    `${borderColor}┌${"─".repeat(Math.min(W - 2, 76))}┐${c.reset}`,
    `${borderColor}│${c.reset} ${inner} ${borderColor}│${c.reset}`,
    `${borderColor}└${"─".repeat(Math.min(W - 2, 76))}┘${c.reset}`,
  ].join("\n");
}

function badge(text: string, bg: string, fg = c.black) {
  return `${bg}${fg}${c.bold} ${text} ${c.reset}`;
}

function statusBadge(status: TaskStatus | "PAUSED") {
  const map: Record<string, [string, string]> = {
    INDEXING:             [c.bgCyan,                    c.black],
    GENERATING_ARTIFACTS: ["\x1b[45m",                  c.black],
    SYSTEM_CHECK:         ["\x1b[44m",                  c.white],
    APPLYING_DIFFS:       ["\x1b[42m",                  c.black],
    DONE:                 ["\x1b[42m",                  c.black],
    FAILED:               ["\x1b[41m",                  c.white],
    PAUSED:               ["\x1b[43m",                  c.black],
  };
  const [bg, fg] = map[status] ?? [c.gray, c.white];
  return badge(status, bg, fg);
}

function severityBadge(sev: string) {
  const s = sev?.toUpperCase() ?? "";
  if (s === "CRITICAL") return badge("CRITICAL", "\x1b[41m", c.white);
  if (s === "HIGH")     return badge("HIGH",     "\x1b[91m", c.black);
  if (s === "MEDIUM")   return badge("MEDIUM",   "\x1b[43m", c.black);
  return badge("LOW", "\x1b[100m", c.white);
}

// SPINNERS & ANIMATIONS
const SPINNER = ["⠋","⠙","⠹","⠸","⠼","⠴","⠦","⠧","⠇","⠏"];
const DOTS    = ["   ","·  ","·· ","···"];
const PULSE   = ["█","▓","▒","░","▒","▓"];

const STATUS_LABEL: Record<TaskStatus, string> = {
  INDEXING:             "Indexing project files",
  GENERATING_ARTIFACTS: "Generating AI artifacts",
  SYSTEM_CHECK:         "Running system check",
  APPLYING_DIFFS:       "Applying diffs",
  DONE:                 "Analysis complete",
  FAILED:               "Analysis failed",
};

// ─────────────────────────────────────────────
// HEADER
// ─────────────────────────────────────────────

function printHeader() {
  console.log("");
  console.log(`  ${c.brightCyan}${c.bold}◆ FlowLessAI${c.reset}  ${c.gray}Vibe Auditor${c.reset}  ${c.dim}v1.0.0${c.reset}`);
  console.log(`  ${line("─", c.gray)}`);
}

// ─────────────────────────────────────────────
// HELP
// ─────────────────────────────────────────────

function printHelp() {
  cls();
  printHeader();
  console.log("");
  console.log(`  ${c.bold}USAGE${c.reset}`);
  console.log("");
  console.log(`  ${c.brightCyan}auditor login${c.reset}                  ${c.gray}Authenticate your device${c.reset}`);
  console.log(`  ${c.brightCyan}auditor logout${c.reset}                 ${c.gray}Revoke your session${c.reset}`);
  console.log(`  ${c.brightCyan}auditor .${c.reset}                      ${c.gray}Audit current directory${c.reset}`);
  console.log(`  ${c.brightCyan}auditor <path>${c.reset}                 ${c.gray}Audit a specific directory${c.reset}`);
  console.log(`  ${c.brightCyan}auditor . -m "message"${c.reset}         ${c.gray}Audit with extra context for AI${c.reset}`);
  console.log(`  ${c.brightCyan}auditor resume <taskId>${c.reset}        ${c.gray}Resume a paused task${c.reset}`);
  console.log(`  ${c.brightCyan}auditor status${c.reset}                 ${c.gray}Show account credits and plan${c.reset}`);
  console.log("");
  console.log(`  ${c.bold}NOTES${c.reset}`);
  console.log("");
  console.log(`  ${c.gray}·${c.reset}  Files in ${c.yellow}.gitignore${c.reset} are automatically excluded`);
  console.log(`  ${c.gray}·${c.reset}  Press ${c.yellow}Ctrl+C${c.reset} during analysis to pause and exit`);
  console.log(`  ${c.gray}·${c.reset}  Analysis history syncs to ${c.brightCyan}flowlessai.one${c.reset}`);
  console.log("");
  console.log(`  ${line()}`);
  console.log(`  ${c.gray}flowlessai.one  ·  sales@flowlessai.one${c.reset}`);
  console.log("");
}

// ─────────────────────────────────────────────
// HTTP
// ─────────────────────────────────────────────

type RequestBody = FormData | string | Uint8Array | null;

async function request<T>(
  method: string,
  endpoint: string,
  options: { token?: string; body?: RequestBody } = {}
): Promise<T> {
  const headers = new Headers();
  if (options.token) headers.set("Authorization", `Bearer ${options.token}`);

  const response = await fetch(`${API_BASE_URL}${endpoint}`, {
    method,
    headers,
    body: options.body ?? null,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${method} ${endpoint} → ${response.status}: ${text || "Unknown error"}`);
  }

  return (await response.json()) as T;
}

// ─────────────────────────────────────────────
// TOKEN STORAGE
// ─────────────────────────────────────────────

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

// ─────────────────────────────────────────────
// GIT / FILE COLLECTION
// ─────────────────────────────────────────────

async function runCommand(
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
  } catch { /* no .gitignore */ }

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

async function zipProject(projectDir: string): Promise<{ data: Uint8Array; fileCount: number }> {
  const fileList = (await collectFilesWithGit(projectDir)) ?? (await collectFilesFallback(projectDir));
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

// ─────────────────────────────────────────────
// LOGIN
// ─────────────────────────────────────────────

async function login(): Promise<void> {
  cls();
  printHeader();
  console.log("");
  console.log(`  ${c.bold}Device Authentication${c.reset}`);
  console.log("");

  const response = await request<DeviceLoginCreateResponse>("POST", "/auth/login");
  const expiresAt = Date.now() + response.expiresIn * 1000;

  console.log(`  ${c.gray}Open this URL in your browser:${c.reset}`);
  console.log("");
  console.log(`  ${c.brightCyan}${c.underline}${response.verificationUrl}${c.reset}`);
  console.log("");
  console.log(`  ${c.gray}Enter this code when prompted:${c.reset}`);
  console.log("");

  // Big code display
  const codeChars = response.code.split("");
  const formatted = codeChars.slice(0, 3).join(" ") + "  " + codeChars.slice(3).join(" ");
  console.log(`  ${c.bgBlack}  ${c.brightYellow}${c.bold}  ${formatted}  ${c.reset}${c.bgBlack}  ${c.reset}`);
  console.log("");

  // Waiting animation
  let frame = 0;
  const interval = setInterval(() => {
    const spin = SPINNER[frame % SPINNER.length];
    const remaining = Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));
    process.stdout.write(`\r  ${c.cyan}${spin}${c.reset}  ${c.gray}Waiting for confirmation${c.reset}  ${DOTS[frame % DOTS.length]}  ${c.dim}${remaining}s${c.reset}  `);
    frame++;
  }, 100);

  try {
    while (Date.now() < expiresAt) {
      const poll = await fetch(`${API_BASE_URL}/auth/login/${response.authorizationId}`);

      if (poll.status === 202 || poll.status === 200) {
        const body = await poll.json() as DeviceLoginPendingResponse | DeviceLoginApprovedResponse | DeviceLoginExpiredResponse;

        if ("status" in body && body.status === "approved") {
          clearInterval(interval);
          process.stdout.write("\r" + " ".repeat(60) + "\r");
          await saveToken((body as DeviceLoginApprovedResponse).accessToken);
          console.log(`  ${c.brightGreen}✓${c.reset}  ${c.bold}Authenticated successfully${c.reset}`);
          console.log(`  ${c.gray}Token saved. You can now run ${c.reset}${c.brightCyan}auditor .${c.reset}`);
          console.log("");
          return;
        }

        if ("status" in body && body.status === "expired") {
          clearInterval(interval);
          throw new Error("Code expired. Run `auditor login` again.");
        }
      }

      if (!poll.ok && poll.status !== 202) {
        clearInterval(interval);
        throw new Error(`Poll failed (${poll.status})`);
      }

      await sleep(POLL_INTERVAL_MS);
    }
  } finally {
    clearInterval(interval);
  }

  throw new Error("Login timeout. Run `auditor login` again.");
}

// ─────────────────────────────────────────────
// LOGOUT
// ─────────────────────────────────────────────

async function logout(): Promise<void> {
  cls();
  printHeader();
  console.log("");

  const token = await loadToken();
  if (!token) {
    console.log(`  ${c.yellow}⚠${c.reset}  No active session found.`);
    console.log("");
    return;
  }

  try {
    await request<{ ok: boolean }>("POST", "/auth/revoke", { token });
  } catch {
    console.log(`  ${c.yellow}⚠${c.reset}  Could not revoke remotely — removing local token anyway.`);
  }

  await deleteToken();
  console.log(`  ${c.brightGreen}✓${c.reset}  ${c.bold}Logged out.${c.reset}  Local token deleted.`);
  console.log("");
}

// ─────────────────────────────────────────────
// DIFFS — EXTRACTION & DISPLAY
// ─────────────────────────────────────────────

function extractDiffs(rawDiffs: RawDiff[]): ExtractedDiff[] {
  return rawDiffs
    .filter((entry) => entry && typeof entry === "object")
    .map((obj) => {
      const filePath =
        obj.path ?? obj.filePath ?? obj.filename ?? obj.file ?? "unknown-file";

      const patch =
        typeof obj.patch === "string" ? obj.patch :
        typeof obj.diff  === "string" ? obj.diff  :
        undefined;

      const newContent =
        typeof obj.newContent === "string" ? obj.newContent :
        typeof obj.content    === "string" ? obj.content    :
        typeof obj.after      === "string" ? obj.after      :
        undefined;

      return { path: String(filePath), patch, newContent };
    })
    .filter((d) => d.path !== "unknown-file" && (d.patch || d.newContent));
}

function printPatch(patch: string) {
  const lines = patch.split("\n");
  for (const line of lines) {
    if (line.startsWith("+++") || line.startsWith("---")) {
      write(`  ${c.brightCyan}${line}${c.reset}\n`);
    } else if (line.startsWith("@@")) {
      write(`  ${c.brightMagenta}${line}${c.reset}\n`);
    } else if (line.startsWith("+")) {
      write(`  ${c.brightGreen}${line}${c.reset}\n`);
    } else if (line.startsWith("-")) {
      write(`  ${c.brightRed}${line}${c.reset}\n`);
    } else {
      write(`  ${c.gray}${line}${c.reset}\n`);
    }
  }
}

// ─────────────────────────────────────────────
// ARTIFACTS DISPLAY
// ─────────────────────────────────────────────

function printArtifacts(artifacts: Artifact[]) {
  if (artifacts.length === 0) return;

  console.log("");
  console.log(`  ${c.bold}${c.brightWhite}FINDINGS${c.reset}  ${c.gray}(${artifacts.length} files analysed)${c.reset}`);
  console.log(`  ${line()}`);
  console.log("");

  for (const artifact of artifacts) {
    const filePath = artifact.file ?? artifact.path ?? artifact.filePath ?? artifact.filename ?? "unknown";
    const severity = artifact.severity as string | undefined;
    const findings = (artifact.findings ?? artifact.issues ?? []) as string[];
    const summary = artifact.summary ?? artifact.description;

    write(`  ${c.brightCyan}◆${c.reset} ${c.bold}${filePath}${c.reset}`);
    if (severity) write(`  ${severityBadge(severity)}`);
    write("\n");

    if (summary && typeof summary === "string") {
      write(`    ${c.gray}${summary}${c.reset}\n`);
    }

    if (findings.length > 0) {
      for (const finding of findings) {
        write(`    ${c.yellow}·${c.reset} ${c.dim}${finding}${c.reset}\n`);
      }
    }

    console.log("");
  }
}

// ─────────────────────────────────────────────
// ANALYSIS DISPLAY
// ─────────────────────────────────────────────

function printGlobalAnalysis(analysis: unknown) {
  if (!analysis) return;

  console.log(`  ${c.bold}${c.brightWhite}GLOBAL ANALYSIS${c.reset}`);
  console.log(`  ${line()}`);
  console.log("");

  if (typeof analysis === "string") {
    const lines = analysis.split("\n");
    for (const l of lines) {
      console.log(`  ${c.gray}${l}${c.reset}`);
    }
  } else if (typeof analysis === "object") {
    const obj = analysis as Record<string, unknown>;
    for (const [key, val] of Object.entries(obj)) {
      write(`  ${c.cyan}${key}${c.reset}  `);
      if (typeof val === "string") {
        write(`${c.gray}${val}${c.reset}\n`);
      } else {
        write(`${c.gray}${JSON.stringify(val)}${c.reset}\n`);
      }
    }
  }

  console.log("");
}

// ─────────────────────────────────────────────
// INTERACTIVE DIFF REVIEW
// ─────────────────────────────────────────────

async function reviewDiffsInteractively(
  projectDir: string,
  diffs: ExtractedDiff[]
): Promise<void> {
  if (diffs.length === 0) {
    console.log(`  ${c.yellow}⚠${c.reset}  No diffs available to apply.`);
    console.log("");
    return;
  }

  console.log(`  ${c.bold}${c.brightWhite}PROPOSED FIXES${c.reset}  ${c.gray}(${diffs.length} files)${c.reset}`);
  console.log(`  ${line()}`);
  console.log("");

  const toApply: ExtractedDiff[] = [];
  const rl = createInterface({ input, output });

  try {
    for (let i = 0; i < diffs.length; i++) {
      const diff = diffs[i];
      const num = `${i + 1}/${diffs.length}`;

      console.log(`  ${c.gray}[${num}]${c.reset}  ${c.bold}${c.brightCyan}${diff.path}${c.reset}`);
      console.log("");

      if (diff.patch) {
        printPatch(diff.patch);
      } else if (diff.newContent) {
        const preview = diff.newContent.split("\n").slice(0, 20);
        for (const l of preview) {
          write(`  ${c.brightGreen}+ ${l}${c.reset}\n`);
        }
        if (diff.newContent.split("\n").length > 20) {
          write(`  ${c.gray}  ... (${diff.newContent.split("\n").length - 20} more lines)${c.reset}\n`);
        }
      }

      console.log("");

      const answer = await rl.question(
        `  ${c.bold}Apply this fix?${c.reset}  ${c.gray}[${c.reset}${c.brightGreen}y${c.reset}${c.gray}/${c.reset}${c.brightRed}n${c.reset}${c.gray}/${c.reset}${c.yellow}q${c.reset}${c.gray}]${c.reset}  `
      );

      const a = answer.trim().toLowerCase();
      if (a === "q" || a === "quit") {
        console.log(`\n  ${c.yellow}⚠${c.reset}  Review cancelled. No further fixes applied.`);
        break;
      }
      if (a === "y" || a === "yes") {
        toApply.push(diff);
        console.log(`  ${c.brightGreen}✓${c.reset}  Queued for application.`);
      } else {
        console.log(`  ${c.gray}–${c.reset}  Skipped.`);
      }

      console.log("");
    }
  } finally {
    rl.close();
  }

  if (toApply.length === 0) {
    console.log(`  ${c.gray}No fixes were selected.${c.reset}`);
    console.log("");
    return;
  }

  // Apply
  console.log(`  ${c.cyan}⟳${c.reset}  Applying ${toApply.length} fix${toApply.length === 1 ? "" : "es"}...`);
  console.log("");

  await applyDiffs(projectDir, toApply);

  for (const d of toApply) {
    console.log(`  ${c.brightGreen}✓${c.reset}  ${d.path}`);
  }

  console.log("");
  console.log(`  ${c.brightGreen}${c.bold}Done.${c.reset}  ${toApply.length} fix${toApply.length === 1 ? "" : "es"} applied locally.`);
  console.log("");
}

// ─────────────────────────────────────────────
// APPLY DIFFS
// ─────────────────────────────────────────────

async function applyDiffs(projectDir: string, diffs: ExtractedDiff[]): Promise<void> {
  const patches = diffs.map((d) => d.patch).filter((v): v is string => Boolean(v));

  if (patches.length > 0) {
    const patchText = patches.join("\n");
    const apply = await runCommand(
      ["git", "-C", projectDir, "apply", "--whitespace=nowarn", "-"],
      undefined,
      patchText
    );
    if (apply.code !== 0) {
      // Fallback: write newContent for failed patches
      let applied = false;
      for (const diff of diffs) {
        if (diff.newContent) {
          const safePath = diff.path.replace(/^\/+/, "");
          const target = path.join(projectDir, safePath);
          await mkdir(path.dirname(target), { recursive: true });
          await writeFile(target, diff.newContent, "utf8");
          applied = true;
        }
      }
      if (!applied) {
        throw new Error(`git apply failed: ${apply.stderr}`);
      }
    }
    return;
  }

  // No patches — use newContent
  for (const diff of diffs) {
    if (!diff.newContent || diff.path === "unknown-file") continue;
    const safePath = diff.path.replace(/^\/+/, "");
    const target = path.join(projectDir, safePath);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, diff.newContent, "utf8");
  }
}

// ─────────────────────────────────────────────
// LIVE MONITOR SCREEN
// ─────────────────────────────────────────────

let lastRenderedLines = 0;

function renderLive(
  task: TaskStatusResponse,
  projectName: string,
  elapsedMs: number,
  frame: number
) {
  const spin    = SPINNER[frame % SPINNER.length];
  const pulse   = PULSE[frame % PULSE.length];
  const elapsed = Math.floor(elapsedMs / 1000);
  const mins    = Math.floor(elapsed / 60).toString().padStart(2, "0");
  const secs    = (elapsed % 60).toString().padStart(2, "0");

  const lines: string[] = [];

  lines.push("");
  lines.push(`  ${c.brightCyan}${c.bold}◆ FlowLessAI${c.reset}  ${c.gray}Vibe Auditor${c.reset}`);
  lines.push(`  ${line()}`);
  lines.push("");
  lines.push(`  ${c.bold}Project${c.reset}    ${c.brightWhite}${projectName}${c.reset}`);
  lines.push(`  ${c.bold}Task ID${c.reset}    ${c.gray}${task.id}${c.reset}`);
  lines.push(`  ${c.bold}Status${c.reset}     ${statusBadge(task.paused ? "PAUSED" : task.status)}`);
  lines.push(`  ${c.bold}Elapsed${c.reset}    ${c.cyan}${mins}:${secs}${c.reset}`);
  lines.push(`  ${c.bold}Artifacts${c.reset}  ${c.brightYellow}${task.artifacts.length}${c.reset}  ${c.gray}found${c.reset}`);
  lines.push(`  ${c.bold}Diffs${c.reset}      ${c.brightGreen}${task.diffs.length}${c.reset}  ${c.gray}generated${c.reset}`);
  lines.push("");
  lines.push(`  ${line()}`);
  lines.push("");

  const label = STATUS_LABEL[task.status] ?? task.status;
  lines.push(`  ${c.cyan}${spin}${c.reset}  ${c.bold}${label}${c.reset}  ${c.gray}${DOTS[frame % DOTS.length]}${c.reset}`);
  lines.push("");

  // Progress bar
  const barWidth = Math.min(W - 10, 50);
  const statusOrder: TaskStatus[] = ["INDEXING","GENERATING_ARTIFACTS","SYSTEM_CHECK","APPLYING_DIFFS","DONE"];
  const progress = Math.min(
    Math.floor(((statusOrder.indexOf(task.status) + 1) / statusOrder.length) * barWidth),
    barWidth
  );
  const bar = c.brightCyan + "█".repeat(progress) + c.reset + c.gray + "░".repeat(barWidth - progress) + c.reset;
  lines.push(`  [${bar}]`);
  lines.push("");

  // Pulse animation
  lines.push(`  ${c.gray}AI objects in motion${c.reset}  ${c.brightMagenta}${pulse}${c.reset}`);
  lines.push("");
  lines.push(`  ${c.dim}Press Ctrl+C to pause and exit${c.reset}`);
  lines.push("");

  // Clear previous render
  if (lastRenderedLines > 0) {
    output.write(`\x1b[${lastRenderedLines}A\x1b[0J`);
  }

  output.write(lines.join("\n") + "\n");
  lastRenderedLines = lines.length;
}

// ─────────────────────────────────────────────
// TASK MONITOR
// ─────────────────────────────────────────────

async function monitorTask(
  taskId: string,
  token: string,
  projectDir: string,
  projectName: string
): Promise<void> {
  const startedAt = Date.now();
  let frame = 0;
  let latest: TaskStatusResponse | null = null;
  let stopped = false;
  let pauseRequested = false;

  hideCursor();

  const animTimer = setInterval(() => {
    if (latest && !stopped) {
      renderLive(latest, projectName, Date.now() - startedAt, frame++);
    }
  }, 100);

  const onSigint = async () => {
    if (pauseRequested) return;
    pauseRequested = true;
    stopped = true;
    clearInterval(animTimer);
    showCursor();

    write("\n");
    write(`  ${c.yellow}⟳${c.reset}  Pausing task...\n`);

    try {
      await request<{ ok: boolean; message: string }>("POST", `/pause/${taskId}`, { token });
      write(`  ${c.brightGreen}✓${c.reset}  Task paused.\n`);
      write(`  ${c.gray}Resume with:${c.reset}  ${c.brightCyan}auditor resume ${taskId}${c.reset}\n\n`);
    } catch {
      write(`  ${c.yellow}⚠${c.reset}  Could not pause remotely.\n`);
      write(`  ${c.gray}Try:${c.reset}  ${c.brightCyan}auditor resume ${taskId}${c.reset}\n\n`);
    }

    process.off("SIGINT", onSigint);
    process.exit(130);
  };

  process.on("SIGINT", onSigint);

  try {
    while (!stopped) {
      const status = await request<TaskStatusResponse>("GET", `/status/${taskId}`, { token });
      latest = status;

      if (status.paused) { stopped = true; break; }

      if (status.status === "DONE") {
        stopped = true;
        clearInterval(animTimer);
        showCursor();
        process.off("SIGINT", onSigint);

        // Final screen
        cls();
        console.log("");
        console.log(`  ${c.brightCyan}${c.bold}◆ FlowLessAI${c.reset}  ${c.gray}Analysis Complete${c.reset}`);
        console.log(`  ${line()}`);
        console.log("");
        console.log(`  ${c.brightGreen}✓${c.reset}  ${c.bold}Task finished${c.reset}`);
        console.log(`  ${c.gray}Task ID:${c.reset}    ${taskId}`);
        console.log(`  ${c.gray}Duration:${c.reset}   ${Math.floor((Date.now() - startedAt) / 1000)}s`);
        console.log(`  ${c.gray}Artifacts:${c.reset}  ${c.brightYellow}${status.artifacts.length}${c.reset}`);
        console.log(`  ${c.gray}Diffs:${c.reset}      ${c.brightGreen}${status.diffs.length}${c.reset}`);
        console.log(`  ${c.gray}History:${c.reset}    ${c.brightCyan}flowlessai.one/history/${taskId}${c.reset}`);
        console.log("");

        // Print artifacts
        printArtifacts(status.artifacts);

        // Print global analysis
        printGlobalAnalysis(status.analysis);

        // Extract and review diffs
        const diffs = extractDiffs(status.diffs);

        if (diffs.length === 0 && status.diffs.length > 0) {
          // Debug: show raw structure so user can report
          console.log(`  ${c.yellow}⚠${c.reset}  Diffs received but could not be parsed.`);
          console.log(`  ${c.gray}Raw structure (first entry):${c.reset}`);
          console.log(`  ${c.dim}${JSON.stringify(status.diffs[0], null, 2).split("\n").join("\n  ")}${c.reset}`);
          console.log("");
        } else {
          await reviewDiffsInteractively(projectDir, diffs);
        }

        return;
      }

      if (status.status === "FAILED") {
        stopped = true;
        clearInterval(animTimer);
        showCursor();
        process.off("SIGINT", onSigint);
        cls();
        console.log("");
        console.log(`  ${c.brightRed}✗${c.reset}  ${c.bold}Analysis failed.${c.reset}`);
        if (status.analysis) {
          const msg = typeof status.analysis === "string"
            ? status.analysis
            : JSON.stringify(status.analysis, null, 2);
          console.log(`\n  ${c.gray}${msg}${c.reset}`);
        }
        console.log("");
        return;
      }

      await sleep(POLL_INTERVAL_MS);
    }
  } finally {
    clearInterval(animTimer);
    showCursor();
    process.off("SIGINT", onSigint);
  }
}

// ─────────────────────────────────────────────
// CREATE TASK & MONITOR
// ─────────────────────────────────────────────

async function createTaskAndMonitor(projectArg: string, message?: string): Promise<void> {
  const token = await loadToken();
  if (!token) throw new Error("Not logged in. Run `auditor login` first.");

  const projectDir = path.resolve(process.cwd(), projectArg === "." ? "." : projectArg);
  const stats = await stat(projectDir).catch(() => null);
  if (!stats?.isDirectory()) throw new Error(`Directory not found: ${projectDir}`);

  const projectName = path.basename(projectDir) || "project";

  cls();
  printHeader();
  console.log("");
  console.log(`  ${c.bold}Project${c.reset}  ${c.brightWhite}${projectName}${c.reset}`);
  console.log(`  ${c.bold}Path${c.reset}     ${c.gray}${projectDir}${c.reset}`);
  if (message) {
    console.log(`  ${c.bold}Note${c.reset}     ${c.yellow}"${message}"${c.reset}`);
  }
  console.log("");

  // Scan files
  write(`  ${c.cyan}⟳${c.reset}  Scanning files...`);
  const { data: zipped, fileCount } = await zipProject(projectDir);
  write(`\r  ${c.brightGreen}✓${c.reset}  ${c.bold}${fileCount} files${c.reset} found  ${c.gray}(${(zipped.length / 1024).toFixed(1)} KB compressed)${c.reset}\n`);

  // Upload
  write(`  ${c.cyan}⟳${c.reset}  Uploading to FlowLessAI...`);

  const form = new FormData();
  form.append("zip", new File([zipped], `${projectName}.zip`, { type: "application/zip" }));
  form.append("name", projectName);
  if (message) form.append("comment", message);

  const created = await request<CreateTaskResponse>("POST", "/auditor", { token, body: form });
  write(`\r  ${c.brightGreen}✓${c.reset}  Upload complete  ${c.gray}Task ID: ${created.taskId}${c.reset}\n\n`);

  lastRenderedLines = 0;
  await monitorTask(created.taskId, token, projectDir, projectName);
}

// ─────────────────────────────────────────────
// RESUME
// ─────────────────────────────────────────────

async function resumeTask(taskId: string): Promise<void> {
  const token = await loadToken();
  if (!token) throw new Error("Not logged in. Run `auditor login` first.");

  cls();
  printHeader();
  console.log("");
  write(`  ${c.cyan}⟳${c.reset}  Resuming task ${c.gray}${taskId}${c.reset}...`);

  await request<{ ok: boolean; message: string }>("POST", `/resume/${taskId}`, { token });

  write(`\r  ${c.brightGreen}✓${c.reset}  Task resumed.\n\n`);

  lastRenderedLines = 0;
  await monitorTask(taskId, token, process.cwd(), "resumed-task");
}

// ─────────────────────────────────────────────
// STATUS
// ─────────────────────────────────────────────

async function showStatus(): Promise<void> {
  const token = await loadToken();
  cls();
  printHeader();
  console.log("");

  if (!token) {
    console.log(`  ${c.yellow}⚠${c.reset}  Not logged in.  Run ${c.brightCyan}auditor login${c.reset}`);
    console.log("");
    return;
  }

  try {
    const account = await request<{ credits: number; plan: string; email?: string }>(
      "GET", "/account", { token }
    );
    console.log(`  ${c.bold}Account Status${c.reset}`);
    console.log("");
    if (account.email) {
      console.log(`  ${c.gray}Email${c.reset}    ${c.brightWhite}${account.email}${c.reset}`);
    }
    console.log(`  ${c.gray}Plan${c.reset}     ${badge(account.plan?.toUpperCase() ?? "FREE", c.bgCyan, c.black)}`);
    console.log(`  ${c.gray}Credits${c.reset}  ${c.brightYellow}${c.bold}${account.credits.toLocaleString()}${c.reset}  ${c.gray}available${c.reset}`);
    console.log("");
  } catch {
    console.log(`  ${c.yellow}⚠${c.reset}  Could not fetch account info.`);
    console.log(`  ${c.gray}Visit${c.reset}  ${c.brightCyan}flowlessai.one/billing${c.reset}`);
    console.log("");
  }
}

// ─────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === "--help" || args[0] === "-h" || args[0] === "help") {
    printHelp();
    return;
  }

  const command = args[0];

  if (command === "login")  { await login();  return; }
  if (command === "logout") { await logout(); return; }
  if (command === "status") { await showStatus(); return; }

  if (command === "resume") {
    const taskId = args[1];
    if (!taskId) throw new Error("Usage: auditor resume <taskId>");
    await resumeTask(taskId);
    return;
  }

  // auditor . [-m "message"]
  const mFlag = args.indexOf("-m");
  const message = mFlag !== -1 && args[mFlag + 1] ? args[mFlag + 1] : undefined;
  await createTaskAndMonitor(command, message);
}

main().catch((err) => {
  showCursor();
  console.error("");
  console.error(`  ${c.brightRed}✗${c.reset}  ${c.bold}${err instanceof Error ? err.message : String(err)}${c.reset}`);
  console.error("");
  process.exit(1);
});
