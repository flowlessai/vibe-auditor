import React, { useEffect, useState } from "react";
import { render, Box, Text, useApp } from "ink";
import Spinner from "ink-spinner";
import type { TaskStatusResponse } from "./types.ts";
import { request } from "./http.ts";
import { printArtifacts, printGlobalAnalysis } from "./artifacts.ts";
import { reviewOutputArchiveAndApply } from "./output-review.ts";
import { Header, StatusBadgeInk, Divider, c, line, termWidth, write, cls } from "./ui.tsx";
import { POLL_INTERVAL_MS } from "./config.ts";

export function resetLiveRender() {}

function LiveMonitor({
  taskId,
  token,
  projectName,
  onComplete,
}: {
  taskId: string;
  token: string;
  projectName: string;
  onComplete: (status: TaskStatusResponse | null) => void;
}) {
  const { exit } = useApp();
  const [task, setTask] = useState<TaskStatusResponse | null>(null);
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const startedAt = Date.now();
    const timer = setInterval(() => {
      setElapsed(Date.now() - startedAt);
    }, 100);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    let stopped = false;

    const poll = async () => {
      while (!stopped) {
        try {
          const status = await request<TaskStatusResponse>("GET", `/status/${taskId}`, { token });
          if (stopped) break;
          setTask(status);

          if (status.status === "DONE" || status.status === "FAILED" || status.paused) {
            stopped = true;
            onComplete(status);
            exit();
            break;
          }
        } catch (e) {
          // ignore or handle
        }
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      }
    };

    poll();

    return () => {
      stopped = true;
    };
  }, [taskId, token, onComplete, exit]);

  if (!task) {
    return (
      <Box flexDirection="column" paddingY={1}>
        <Header />
        <Box>
          <Text color="cyan"><Spinner /> </Text>
          <Text color="gray">Connecting to FlowlessAI...</Text>
        </Box>
      </Box>
    );
  }

  const mins = Math.floor(elapsed / 60000).toString().padStart(2, "0");
  const secs = Math.floor((elapsed % 60000) / 1000).toString().padStart(2, "0");

  const statusOrder = ["INDEXING", "GENERATING_ARTIFACTS", "SYSTEM_CHECK", "APPLYING_DIFFS", "DONE"];
  const maxW = Math.min(termWidth() - 10, 50);
  const progress = Math.min(Math.floor(((statusOrder.indexOf(task.status) + 1) / statusOrder.length) * maxW), maxW);
  const bar = "█".repeat(progress) + "░".repeat(Math.max(0, maxW - progress));

  return (
    <Box flexDirection="column" paddingY={1} paddingX={2}>
      <Header />
      
      <Box flexDirection="column" marginY={1}>
        <Box>
          <Box width={12}><Text bold>Project</Text></Box>
          <Text color="whiteBright">{projectName}</Text>
        </Box>
        <Box>
          <Box width={12}><Text bold>Task ID</Text></Box>
          <Text color="gray">{task.id}</Text>
        </Box>
        <Box>
          <Box width={12}><Text bold>Status</Text></Box>
          <StatusBadgeInk status={task.paused ? "PAUSED" : task.status} />
        </Box>
        <Box>
          <Box width={12}><Text bold>Elapsed</Text></Box>
          <Text color="cyan">{mins}:{secs}</Text>
        </Box>
        <Box>
          <Box width={12}><Text bold>Artifacts</Text></Box>
          <Text color="yellowBright">{task.artifacts.length}</Text>
          <Text color="gray"> found</Text>
        </Box>
        <Box>
          <Box width={12}><Text bold>Diffs</Text></Box>
          <Text color="greenBright">{task.diffs.length}</Text>
          <Text color="gray"> generated</Text>
        </Box>
      </Box>

      <Divider />

      <Box marginY={1}>
        <Text color="cyan"><Spinner type="dots" /> </Text>
        <Text bold>{task.status}</Text>
      </Box>

      <Box>
        <Text color="cyanBright">{`[${bar.substring(0, progress)}`}</Text>
        <Text color="gray" dimColor>{`${bar.substring(progress)}]`}</Text>
      </Box>

      <Box marginY={1}>
        <Text color="gray">AI objects in motion </Text>
        <Text color="magentaBright"><Spinner type="dots" /></Text>
      </Box>

      {task.artifacts.map((a, i) => (
        <Box key={i}>
          <Text color="gray">Artifact generated: </Text>
          <Text color="magentaBright">{a.filename}</Text>
        </Box>
      ))}

      <Box marginTop={1}>
        <Text color="gray" dimColor>Press Ctrl+C to pause and exit</Text>
      </Box>
    </Box>
  );
}

export async function monitorTask(taskId: string, token: string, projectDir: string, projectName: string): Promise<void> {
  const startedAt = Date.now();
  let latest: TaskStatusResponse | null = null;
  
  const { waitUntilExit } = render(
    <LiveMonitor 
       taskId={taskId} 
       token={token} 
       projectName={projectName} 
       onComplete={(s) => { latest = s; }} 
    />
  );
  
  await waitUntilExit();

  const finalLatest = latest as TaskStatusResponse | null;
  if (!finalLatest) return;

  if (finalLatest.status === "DONE") {
    cls();
    console.log("");
    console.log(`  ${c.brightCyan}${c.bold}◆ FlowLessAI${c.reset}  ${c.gray}Analysis Complete${c.reset}`);
    console.log(`  ${line()}`);
    console.log("");
    console.log(`  ${c.brightGreen}✓${c.reset}  ${c.bold}Task finished${c.reset}`);
    console.log(`  ${c.gray}Task ID:${c.reset}    ${taskId}`);
    console.log(`  ${c.gray}Duration:${c.reset}   ${Math.floor((Date.now() - startedAt) / 1000)}s`);
    console.log(`  ${c.gray}Artifacts:${c.reset}  ${c.brightYellow}${finalLatest.artifacts.length}${c.reset}`);
    console.log(`  ${c.gray}Diffs:${c.reset}      ${c.brightGreen}${finalLatest.diffs.length}${c.reset}`);
    console.log(`  ${c.gray}History:${c.reset}    ${c.brightCyan}flowlessai.one/history/${taskId}${c.reset}`);
    console.log("");

    printArtifacts(finalLatest.artifacts);
    printGlobalAnalysis(finalLatest.analysis);

    await reviewOutputArchiveAndApply(taskId, token, projectDir, finalLatest.downloadUrl ?? finalLatest.output ?? null);
  } else if (finalLatest.status === "FAILED") {
    cls();
    console.log("");
    console.log(`  ${c.brightRed}✗${c.reset}  ${c.bold}Analysis failed.${c.reset}`);
    if (finalLatest.analysis) {
      const msg = typeof finalLatest.analysis === "string" ? finalLatest.analysis : JSON.stringify(finalLatest.analysis, null, 2);
      console.log(`\n  ${c.gray}${msg}${c.reset}`);
    }
    console.log("");
  } else if (finalLatest.paused) {
    write("\n");
    write(`  ${c.yellow}⟳${c.reset}  Task paused.\n`);
    write(`  ${c.gray}Resume with:${c.reset}  ${c.brightCyan}auditor resume ${taskId}${c.reset}\n\n`);
  }
}
