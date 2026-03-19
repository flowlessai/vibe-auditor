import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import React, { useState, useEffect } from "react";
import { render, Box, Text, useApp } from "ink";
import Spinner from "ink-spinner";
import { stat } from "node:fs/promises";
import path from "node:path";
import { API_BASE_URL, POLL_INTERVAL_MS } from "./config.js";
import { request } from "./http.js";
import { monitorTask, resetLiveRender } from "./monitor.js";
import { zipProject } from "./project.js";
import { deleteToken, loadToken, saveToken } from "./token.js";
import { Header, c, cls, printHeader, write } from "./ui.js";
function LoginView({ response, onComplete }) {
    const { exit } = useApp();
    const [remaining, setRemaining] = useState(response.expiresIn);
    const [status, setStatus] = useState("pending");
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
                        const body = (await pollRes.json());
                        if ("status" in body && body.status === "approved") {
                            await saveToken(body.accessToken);
                            setStatus("approved");
                            stopped = true;
                            onComplete();
                            exit();
                            return;
                        }
                        else if ("status" in body && body.status === "expired") {
                            setStatus("expired");
                            stopped = true;
                            onComplete();
                            exit();
                            return;
                        }
                    }
                    else if (!pollRes.ok && pollRes.status !== 202) {
                        setErrorMsg(`Poll failed (${pollRes.status})`);
                        stopped = true;
                        onComplete();
                        exit();
                        return;
                    }
                }
                catch (e) {
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
        return (_jsxs(Box, { flexDirection: "column", paddingY: 1, children: [_jsx(Header, {}), _jsxs(Box, { children: [_jsx(Text, { color: "greenBright", children: "\u2713 " }), _jsx(Text, { bold: true, children: "Authenticated successfully" })] }), _jsxs(Text, { color: "gray", children: ["Token saved. You can now run ", _jsx(Text, { color: "cyanBright", children: "auditor ." })] })] }));
    }
    if (status === "expired" || errorMsg) {
        return (_jsxs(Box, { flexDirection: "column", paddingY: 1, children: [_jsx(Header, {}), _jsxs(Box, { children: [_jsx(Text, { color: "redBright", children: "\u2717 " }), _jsx(Text, { bold: true, children: "Login failed" })] }), _jsx(Text, { color: "gray", children: errorMsg || "Code expired. Run auditor login again." })] }));
    }
    return (_jsxs(Box, { flexDirection: "column", paddingY: 1, children: [_jsx(Header, {}), _jsx(Box, { marginY: 1, children: _jsx(Text, { bold: true, children: "Device Authentication" }) }), _jsx(Text, { color: "gray", children: "Open this URL in your browser:" }), _jsx(Text, { color: "cyanBright", underline: true, children: response.verificationUrl }), _jsx(Box, { marginTop: 1, children: _jsx(Text, { color: "gray", children: "Enter this code when prompted:" }) }), _jsx(Box, { marginY: 1, children: _jsxs(Text, { backgroundColor: "black", color: "yellowBright", bold: true, children: ["  ", formatted, "  "] }) }), _jsxs(Box, { children: [_jsxs(Text, { color: "cyan", children: [_jsx(Spinner, {}), " "] }), _jsx(Text, { color: "gray", children: "Waiting for confirmation " }), _jsxs(Text, { dimColor: true, children: [remaining, "s"] })] })] }));
}
function StatusView({ account, error }) {
    if (error) {
        return (_jsxs(Box, { flexDirection: "column", paddingY: 1, children: [_jsx(Header, {}), _jsxs(Box, { marginTop: 1, children: [_jsx(Text, { color: "yellow", children: "\u26A0 " }), _jsx(Text, { children: "Could not fetch account info." })] }), _jsxs(Text, { color: "gray", children: ["Visit ", _jsx(Text, { color: "cyanBright", children: "flowlessai.one/billing" })] })] }));
    }
    return (_jsxs(Box, { flexDirection: "column", paddingY: 1, paddingX: 2, children: [_jsx(Header, {}), _jsx(Box, { marginTop: 1, marginBottom: 1, children: _jsx(Text, { bold: true, children: "Account Status" }) }), _jsxs(Box, { flexDirection: "column", children: [account.email && (_jsxs(Box, { children: [_jsx(Box, { width: 10, children: _jsx(Text, { color: "gray", children: "Email" }) }), _jsx(Text, { color: "whiteBright", children: account.email })] })), _jsxs(Box, { children: [_jsx(Box, { width: 10, children: _jsx(Text, { color: "gray", children: "Plan" }) }), _jsxs(Text, { backgroundColor: "cyan", color: "black", bold: true, children: [" ", account.plan?.toUpperCase() ?? "FREE", " "] })] }), _jsxs(Box, { children: [_jsx(Box, { width: 10, children: _jsx(Text, { color: "gray", children: "Credits" }) }), _jsx(Text, { color: "yellowBright", bold: true, children: account.credits?.toLocaleString() }), _jsx(Text, { color: "gray", children: " available" })] })] })] }));
}
export async function login() {
    const response = await request("POST", "/auth/login");
    const { waitUntilExit } = render(_jsx(LoginView, { response: response, onComplete: () => { } }));
    await waitUntilExit();
}
export async function logout() {
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
        await request("POST", "/auth/revoke", { token });
    }
    catch {
        console.log(`  ${c.yellow}⚠${c.reset}  Could not revoke remotely — removing local token anyway.`);
    }
    await deleteToken();
    console.log(`  ${c.brightGreen}✓${c.reset}  ${c.bold}Logged out.${c.reset}  Local token deleted.`);
    console.log("");
}
export async function createTaskAndMonitor(projectArg, message) {
    const token = await loadToken();
    if (!token)
        throw new Error("Not logged in. Run `auditor login` first.");
    const projectDir = path.resolve(process.cwd(), projectArg === "." ? "." : projectArg);
    const stats = await stat(projectDir).catch(() => null);
    if (!stats?.isDirectory())
        throw new Error(`Directory not found: ${projectDir}`);
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
    if (message)
        form.append("comment", message);
    const created = await request("POST", "/auditor", { token, body: form });
    write(`\r  ${c.brightGreen}✓${c.reset}  Upload complete  ${c.gray}Task ID: ${created.taskId}${c.reset}\n\n`);
    resetLiveRender();
    await monitorTask(created.taskId, token, projectDir, projectName);
}
export async function resumeTask(taskId) {
    const token = await loadToken();
    if (!token)
        throw new Error("Not logged in. Run `auditor login` first.");
    cls();
    await printHeader();
    console.log("");
    write(`  ${c.cyan}⟳${c.reset}  Resuming task ${c.gray}${taskId}${c.reset}...`);
    await request("POST", `/resume/${taskId}`, { token });
    write(`\r  ${c.brightGreen}✓${c.reset}  Task resumed.\n\n`);
    resetLiveRender();
    await monitorTask(taskId, token, process.cwd(), "resumed-task");
}
export async function showStatus() {
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
        account = await request("GET", "/account", { token });
    }
    catch {
        error = true;
    }
    const { waitUntilExit } = render(_jsx(StatusView, { account: account, error: error }));
    await waitUntilExit();
}
