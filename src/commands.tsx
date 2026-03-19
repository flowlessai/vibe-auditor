import React, { useState, useEffect } from "react";
import { render, Box, Text, useApp } from "ink";
import Spinner from "ink-spinner";
import { stat } from "node:fs/promises";
import path from "node:path";
import { API_BASE_URL, POLL_INTERVAL_MS } from "./config.ts";
import { request } from "./http.ts";
import { monitorTask, resetLiveRender } from "./monitor.tsx";
import { zipProject } from "./project.ts";
import { deleteToken, loadToken, saveToken } from "./token.ts";
import type {
  CreateTaskResponse,
  DeviceLoginApprovedResponse,
  DeviceLoginCreateResponse,
  DeviceLoginPendingResponse,
  DeviceLoginExpiredResponse,
} from "./types.ts";
import { Header, c, cls, printHeader, write } from "./ui.tsx";

function LoginView({ response, onComplete }: { response: DeviceLoginCreateResponse, onComplete: () => void }) {
  const { exit } = useApp();
  const [remaining, setRemaining] = useState(response.expiresIn);
  const [status, setStatus] = useState<"pending" | "approved" | "expired">("pending");
  const [errorMsg, setErrorMsg] = useState("");

  const expiresAt = Date.now() + response.expiresIn * 1000;

  useEffect(() => {
    const timer = setInterval(() => {
      setRemaining(Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000)));
    }, 100);
    return () => clearInterval(timer);
  }, [expiresAt]);

  useEffect(() => {
    let stopped = false;
    const poll = async () => {
      while (!stopped && Date.now() < expiresAt) {
        try {
          const pollRes = await fetch(`${API_BASE_URL}/auth/login/${response.authorizationId}`);
          if (pollRes.status === 202 || pollRes.status === 200) {
            const body = (await pollRes.json()) as DeviceLoginPendingResponse | DeviceLoginApprovedResponse | DeviceLoginExpiredResponse;
            if ("status" in body && body.status === "approved") {
              await saveToken(body.accessToken);
              setStatus("approved");
              stopped = true;
              onComplete();
              exit();
              return;
            } else if ("status" in body && body.status === "expired") {
              setStatus("expired");
              stopped = true;
              onComplete();
              exit();
              return;
            }
          } else if (!pollRes.ok && pollRes.status !== 202) {
            setErrorMsg(`Poll failed (${pollRes.status})`);
            stopped = true;
            onComplete();
            exit();
            return;
          }
        } catch (e) {
          // ignore
        }
        await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
      }
      if (!stopped) {
        setStatus("expired");
        onComplete();
        exit();
      }
    };
    poll();
    return () => { stopped = true; };
  }, [expiresAt, response.authorizationId, onComplete, exit]);

  const codeChars = response.code.split("");
  const formatted = codeChars.slice(0, 3).join(" ") + "  " + codeChars.slice(3).join(" ");

  if (status === "approved") {
    return (
      <Box flexDirection="column" paddingY={1}>
        <Header />
        <Box>
          <Text color="greenBright">✓ </Text>
          <Text bold>Authenticated successfully</Text>
        </Box>
        <Text color="gray">Token saved. You can now run <Text color="cyanBright">auditor .</Text></Text>
      </Box>
    );
  }

  if (status === "expired" || errorMsg) {
    return (
      <Box flexDirection="column" paddingY={1}>
        <Header />
        <Box>
          <Text color="redBright">✗ </Text>
          <Text bold>Login failed</Text>
        </Box>
        <Text color="gray">{errorMsg || "Code expired. Run auditor login again."}</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingY={1}>
      <Header />
      <Box marginY={1}>
        <Text bold>Device Authentication</Text>
      </Box>
      <Text color="gray">Open this URL in your browser:</Text>
      <Text color="cyanBright" underline>{response.verificationUrl}</Text>
      
      <Box marginTop={1}>
        <Text color="gray">Enter this code when prompted:</Text>
      </Box>
      <Box marginY={1}>
        <Text backgroundColor="black" color="yellowBright" bold>  {formatted}  </Text>
      </Box>

      <Box>
        <Text color="cyan"><Spinner /> </Text>
        <Text color="gray">Waiting for confirmation </Text>
        <Text dimColor>{remaining}s</Text>
      </Box>
    </Box>
  );
}

function StatusView({ account, error }: { account: any, error: boolean }) {
  if (error) {
    return (
      <Box flexDirection="column" paddingY={1}>
        <Header />
        <Box marginTop={1}>
          <Text color="yellow">⚠ </Text>
          <Text>Could not fetch account info.</Text>
        </Box>
        <Text color="gray">Visit <Text color="cyanBright">flowlessai.one/billing</Text></Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingY={1} paddingX={2}>
      <Header />
      <Box marginTop={1} marginBottom={1}>
        <Text bold>Account Status</Text>
      </Box>
      <Box flexDirection="column">
        {account.email && (
          <Box>
            <Box width={10}><Text color="gray">Email</Text></Box>
            <Text color="whiteBright">{account.email}</Text>
          </Box>
        )}
        <Box>
          <Box width={10}><Text color="gray">Plan</Text></Box>
          <Text backgroundColor="cyan" color="black" bold> {account.plan?.toUpperCase() ?? "FREE"} </Text>
        </Box>
        <Box>
          <Box width={10}><Text color="gray">Credits</Text></Box>
          <Text color="yellowBright" bold>{account.credits?.toLocaleString()}</Text>
          <Text color="gray"> available</Text>
        </Box>
      </Box>
    </Box>
  );
}

export async function login(): Promise<void> {
  const response = await request<DeviceLoginCreateResponse>("POST", "/auth/login");
  
  const { waitUntilExit } = render(
     <LoginView response={response} onComplete={() => {}} />
  );
  
  await waitUntilExit();
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
  if (!token) {
    cls();
    await printHeader();
    console.log(`\n  ${c.yellow}⚠${c.reset}  Not logged in.  Run ${c.brightCyan}auditor login${c.reset}\n`);
    return;
  }

  let account = null;
  let error = false;
  try {
    account = await request<{ credits: number; plan: string; email?: string }>("GET", "/account", { token });
  } catch {
    error = true;
  }

  const { waitUntilExit } = render(<StatusView account={account} error={error} />);
  await waitUntilExit();
}
