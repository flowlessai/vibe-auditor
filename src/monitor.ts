import type { TaskStatus, TaskStatusResponse } from "./types";
import { request } from "./http";
import { extractDiffs, reviewDiffsInteractively } from "./diffs";
import { artifactPreviewLines, printArtifacts, printGlobalAnalysis } from "./artifacts";
import { DOTS, PULSE, SPINNER, STATUS_LABEL, c, cls, hideCursor, line, showCursor, sleep, statusBadge, termWidth, write } from "./ui";
import { POLL_INTERVAL_MS } from "./config";

let lastRenderedLines = 0;

export function resetLiveRender() {
  lastRenderedLines = 0;
}

function renderLive(task: TaskStatusResponse, projectName: string, elapsedMs: number, frame: number) {
  const spin = SPINNER[frame % SPINNER.length];
  const pulse = PULSE[frame % PULSE.length];
  const elapsed = Math.floor(elapsedMs / 1000);
  const mins = Math.floor(elapsed / 60).toString().padStart(2, "0");
  const secs = (elapsed % 60).toString().padStart(2, "0");

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

  const barWidth = Math.min(termWidth() - 10, 50);
  const statusOrder: TaskStatus[] = ["INDEXING", "GENERATING_ARTIFACTS", "SYSTEM_CHECK", "APPLYING_DIFFS", "DONE"];
  const progress = Math.min(Math.floor(((statusOrder.indexOf(task.status) + 1) / statusOrder.length) * barWidth), barWidth);
  const bar = c.brightCyan + "█".repeat(progress) + c.reset + c.gray + "░".repeat(barWidth - progress) + c.reset;
  lines.push(`  [${bar}]`);
  lines.push("");

  lines.push(`  ${c.gray}AI objects in motion${c.reset}  ${c.brightMagenta}${pulse}${c.reset}`);
  lines.push("");

  lines.push(...artifactPreviewLines(task.artifacts, 3));
  lines.push(`  ${c.dim}Press Ctrl+C to pause and exit${c.reset}`);
  lines.push("");

  if (lastRenderedLines > 0) {
    process.stdout.write(`\x1b[${lastRenderedLines}A\x1b[0J`);
  }

  process.stdout.write(lines.join("\n") + "\n");
  lastRenderedLines = lines.length;
}

export async function monitorTask(taskId: string, token: string, projectDir: string, projectName: string): Promise<void> {
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

      if (status.paused) {
        stopped = true;
        break;
      }

      if (status.status === "DONE") {
        stopped = true;
        clearInterval(animTimer);
        showCursor();
        process.off("SIGINT", onSigint);

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

        printArtifacts(status.artifacts);
        printGlobalAnalysis(status.analysis);

        const diffs = extractDiffs(status.diffs);

        if (diffs.length === 0 && status.diffs.length > 0) {
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
          const msg = typeof status.analysis === "string" ? status.analysis : JSON.stringify(status.analysis, null, 2);
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
