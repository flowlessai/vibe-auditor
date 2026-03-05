import { stdout as output } from "node:process";
import type { TaskStatus } from "./types.ts";

export const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  italic: "\x1b[3m",
  underline: "\x1b[4m",
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
  bgBlack: "\x1b[40m",
  bgBlue: "\x1b[44m",
  bgCyan: "\x1b[46m",
};

export const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
export const DOTS = ["   ", "·  ", "·· ", "···"];
export const PULSE = ["█", "▓", "▒", "░", "▒", "▓"];

export const STATUS_LABEL: Record<TaskStatus, string> = {
  INDEXING: "Indexing project files",
  GENERATING_ARTIFACTS: "Generating AI artifacts",
  SYSTEM_CHECK: "Running system check",
  APPLYING_DIFFS: "Applying diffs",
  DONE: "Analysis complete",
  FAILED: "Analysis failed",
};

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function termWidth() {
  return process.stdout.columns || 80;
}

export function cls() {
  output.write("\x1b[2J\x1b[H");
}

export function hideCursor() {
  output.write("\x1b[?25l");
}

export function showCursor() {
  output.write("\x1b[?25h");
}

export function write(text: string) {
  output.write(text);
}

export function line(char = "─", color = c.gray) {
  return `${color}${char.repeat(Math.min(termWidth() - 2, 76))}${c.reset}`;
}

export function badge(text: string, bg: string, fg = c.black) {
  return `${bg}${fg}${c.bold} ${text} ${c.reset}`;
}

export function statusBadge(status: TaskStatus | "PAUSED") {
  const map: Record<string, [string, string]> = {
    INDEXING: [c.bgCyan, c.black],
    GENERATING_ARTIFACTS: ["\x1b[45m", c.black],
    SYSTEM_CHECK: ["\x1b[44m", c.white],
    APPLYING_DIFFS: ["\x1b[42m", c.black],
    DONE: ["\x1b[42m", c.black],
    FAILED: ["\x1b[41m", c.white],
    PAUSED: ["\x1b[43m", c.black],
  };
  const [bg, fg] = map[status] ?? [c.gray, c.white];
  return badge(status, bg, fg);
}

export function severityBadge(sev: string) {
  const s = sev?.toUpperCase() ?? "";
  if (s === "CRITICAL") return badge("CRITICAL", "\x1b[41m", c.white);
  if (s === "HIGH") return badge("HIGH", "\x1b[91m", c.black);
  if (s === "MEDIUM") return badge("MEDIUM", "\x1b[43m", c.black);
  return badge("LOW", "\x1b[100m", c.white);
}

export async function printHeader() {
  console.log("");
  console.log(`  ${c.bold}FlowlessAI - Vibe Auditor${c.reset}`);
  console.log(`  ${line("─", c.gray)}`);
}

export async function printHelp() {
  cls();
  await printHeader();
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
