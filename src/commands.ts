import { stat } from "node:fs/promises";
import path from "node:path";
import { API_BASE_URL, POLL_INTERVAL_MS } from "./config";
import { request } from "./http";
import { monitorTask, resetLiveRender } from "./monitor";
import { zipProject } from "./project";
import { deleteToken, loadToken, saveToken } from "./token";
import type {
  CreateTaskResponse,
  DeviceLoginApprovedResponse,
  DeviceLoginCreateResponse,
  DeviceLoginExpiredResponse,
  DeviceLoginPendingResponse,
} from "./types";
import { DOTS, SPINNER, badge, c, cls, printHeader, sleep, write } from "./ui";

export async function login(): Promise<void> {
  cls();
  await printHeader();
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

  const codeChars = response.code.split("");
  const formatted = codeChars.slice(0, 3).join(" ") + "  " + codeChars.slice(3).join(" ");
  console.log(`  ${c.bgBlack}  ${c.brightYellow}${c.bold}  ${formatted}  ${c.reset}${c.bgBlack}  ${c.reset}`);
  console.log("");

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
        const body = (await poll.json()) as DeviceLoginPendingResponse | DeviceLoginApprovedResponse | DeviceLoginExpiredResponse;

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

export async function logout(): Promise<void> {
  cls();
  await printHeader();
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

export async function createTaskAndMonitor(projectArg: string, message?: string): Promise<void> {
  const token = await loadToken();
  if (!token) throw new Error("Not logged in. Run `auditor login` first.");

  const projectDir = path.resolve(process.cwd(), projectArg === "." ? "." : projectArg);
  const stats = await stat(projectDir).catch(() => null);
  if (!stats?.isDirectory()) throw new Error(`Directory not found: ${projectDir}`);

  const projectName = path.basename(projectDir) || "project";

  cls();
  await printHeader();
  console.log("");
  console.log(`  ${c.bold}Project${c.reset}  ${c.brightWhite}${projectName}${c.reset}`);
  console.log(`  ${c.bold}Path${c.reset}     ${c.gray}${projectDir}${c.reset}`);
  if (message) {
    console.log(`  ${c.bold}Note${c.reset}     ${c.yellow}"${message}"${c.reset}`);
  }
  console.log("");

  write(`  ${c.cyan}⟳${c.reset}  Scanning files...`);
  const { data: zipped, fileCount } = await zipProject(projectDir);
  write(`\r  ${c.brightGreen}✓${c.reset}  ${c.bold}${fileCount} files${c.reset} found  ${c.gray}(${(zipped.length / 1024).toFixed(1)} KB compressed)${c.reset}\n`);

  write(`  ${c.cyan}⟳${c.reset}  Uploading to FlowLessAI...`);

  const form = new FormData();
  form.append("zip", new File([zipped], `${projectName}.zip`, { type: "application/zip" }));
  form.append("name", projectName);
  if (message) form.append("comment", message);

  const created = await request<CreateTaskResponse>("POST", "/auditor", { token, body: form });
  write(`\r  ${c.brightGreen}✓${c.reset}  Upload complete  ${c.gray}Task ID: ${created.taskId}${c.reset}\n\n`);

  resetLiveRender();
  await monitorTask(created.taskId, token, projectDir, projectName);
}

export async function resumeTask(taskId: string): Promise<void> {
  const token = await loadToken();
  if (!token) throw new Error("Not logged in. Run `auditor login` first.");

  cls();
  await printHeader();
  console.log("");
  write(`  ${c.cyan}⟳${c.reset}  Resuming task ${c.gray}${taskId}${c.reset}...`);

  await request<{ ok: boolean; message: string }>("POST", `/resume/${taskId}`, { token });

  write(`\r  ${c.brightGreen}✓${c.reset}  Task resumed.\n\n`);

  resetLiveRender();
  await monitorTask(taskId, token, process.cwd(), "resumed-task");
}

export async function showStatus(): Promise<void> {
  const token = await loadToken();
  cls();
  await printHeader();
  console.log("");

  if (!token) {
    console.log(`  ${c.yellow}⚠${c.reset}  Not logged in.  Run ${c.brightCyan}auditor login${c.reset}`);
    console.log("");
    return;
  }

  try {
    const account = await request<{ credits: number; plan: string; email?: string }>("GET", "/account", { token });
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
