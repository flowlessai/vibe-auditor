import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import React, { useEffect, useState } from "react";
import { render, Box, Text, useApp } from "ink";
import Spinner from "ink-spinner";
import { request } from "./http.js";
import { printArtifacts, printGlobalAnalysis } from "./artifacts.js";
import { reviewOutputArchiveAndApply } from "./output-review.js";
import { Header, StatusBadgeInk, Divider, c, line, termWidth, write, cls } from "./ui.js";
import { POLL_INTERVAL_MS } from "./config.js";
export function resetLiveRender() { }
function LiveMonitor({ taskId, token, projectName, onComplete, }) {
    const { exit } = useApp();
    const [task, setTask] = useState(null);
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
                    const status = await request("GET", `/status/${taskId}`, { token });
                    if (stopped)
                        break;
                    setTask(status);
                    if (status.status === "DONE" || status.status === "FAILED" || status.paused) {
                        stopped = true;
                        onComplete(status);
                        exit();
                        break;
                    }
                }
                catch (e) {
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
        return (_jsxs(Box, { flexDirection: "column", paddingY: 1, children: [_jsx(Header, {}), _jsxs(Box, { children: [_jsxs(Text, { color: "cyan", children: [_jsx(Spinner, {}), " "] }), _jsx(Text, { color: "gray", children: "Connecting to FlowlessAI..." })] })] }));
    }
    const mins = Math.floor(elapsed / 60000).toString().padStart(2, "0");
    const secs = Math.floor((elapsed % 60000) / 1000).toString().padStart(2, "0");
    const statusOrder = ["INDEXING", "GENERATING_ARTIFACTS", "SYSTEM_CHECK", "APPLYING_DIFFS", "DONE"];
    const maxW = Math.min(termWidth() - 10, 50);
    const progress = Math.min(Math.floor(((statusOrder.indexOf(task.status) + 1) / statusOrder.length) * maxW), maxW);
    const bar = "█".repeat(progress) + "░".repeat(Math.max(0, maxW - progress));
    return (_jsxs(Box, { flexDirection: "column", paddingY: 1, paddingX: 2, children: [_jsx(Header, {}), _jsxs(Box, { flexDirection: "column", marginY: 1, children: [_jsxs(Box, { children: [_jsx(Box, { width: 12, children: _jsx(Text, { bold: true, children: "Project" }) }), _jsx(Text, { color: "whiteBright", children: projectName })] }), _jsxs(Box, { children: [_jsx(Box, { width: 12, children: _jsx(Text, { bold: true, children: "Task ID" }) }), _jsx(Text, { color: "gray", children: task.id })] }), _jsxs(Box, { children: [_jsx(Box, { width: 12, children: _jsx(Text, { bold: true, children: "Status" }) }), _jsx(StatusBadgeInk, { status: task.paused ? "PAUSED" : task.status })] }), _jsxs(Box, { children: [_jsx(Box, { width: 12, children: _jsx(Text, { bold: true, children: "Elapsed" }) }), _jsxs(Text, { color: "cyan", children: [mins, ":", secs] })] }), _jsxs(Box, { children: [_jsx(Box, { width: 12, children: _jsx(Text, { bold: true, children: "Artifacts" }) }), _jsx(Text, { color: "yellowBright", children: task.artifacts.length }), _jsx(Text, { color: "gray", children: " found" })] }), _jsxs(Box, { children: [_jsx(Box, { width: 12, children: _jsx(Text, { bold: true, children: "Diffs" }) }), _jsx(Text, { color: "greenBright", children: task.diffs.length }), _jsx(Text, { color: "gray", children: " generated" })] })] }), _jsx(Divider, {}), _jsxs(Box, { marginY: 1, children: [_jsxs(Text, { color: "cyan", children: [_jsx(Spinner, { type: "dots" }), " "] }), _jsx(Text, { bold: true, children: task.status })] }), _jsxs(Box, { children: [_jsx(Text, { color: "cyanBright", children: `[${bar.substring(0, progress)}` }), _jsx(Text, { color: "gray", dimColor: true, children: `${bar.substring(progress)}]` })] }), _jsxs(Box, { marginY: 1, children: [_jsx(Text, { color: "gray", children: "AI objects in motion " }), _jsx(Text, { color: "magentaBright", children: _jsx(Spinner, { type: "dots" }) })] }), task.artifacts.map((a, i) => (_jsxs(Box, { children: [_jsx(Text, { color: "gray", children: "Artifact generated: " }), _jsx(Text, { color: "magentaBright", children: a.filename })] }, i))), _jsx(Box, { marginTop: 1, children: _jsx(Text, { color: "gray", dimColor: true, children: "Press Ctrl+C to pause and exit" }) })] }));
}
export async function monitorTask(taskId, token, projectDir, projectName) {
    const startedAt = Date.now();
    let latest = null;
    const { waitUntilExit } = render(_jsx(LiveMonitor, { taskId: taskId, token: token, projectName: projectName, onComplete: (s) => { latest = s; } }));
    await waitUntilExit();
    const finalLatest = latest;
    if (!finalLatest)
        return;
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
    }
    else if (finalLatest.status === "FAILED") {
        cls();
        console.log("");
        console.log(`  ${c.brightRed}✗${c.reset}  ${c.bold}Analysis failed.${c.reset}`);
        if (finalLatest.analysis) {
            const msg = typeof finalLatest.analysis === "string" ? finalLatest.analysis : JSON.stringify(finalLatest.analysis, null, 2);
            console.log(`\n  ${c.gray}${msg}${c.reset}`);
        }
        console.log("");
    }
    else if (finalLatest.paused) {
        write("\n");
        write(`  ${c.yellow}⟳${c.reset}  Task paused.\n`);
        write(`  ${c.gray}Resume with:${c.reset}  ${c.brightCyan}auditor resume ${taskId}${c.reset}\n\n`);
    }
}
