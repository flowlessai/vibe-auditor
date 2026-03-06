import { createInterface } from "node:readline/promises";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import { API_BASE_URL } from "./config.js";
import { readProjectSnapshot } from "./project.js";
import { c, line } from "./ui.js";
function normalizePath(p) {
    return p.replace(/\\/g, "/").replace(/^\/+/, "");
}
function byteEquals(a, b) {
    if (a.length !== b.length)
        return false;
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i])
            return false;
    }
    return true;
}
function countLines(text) {
    if (text.length === 0)
        return 0;
    return text.split("\n").length;
}
function isProbablyBinary(data) {
    const sample = data.subarray(0, Math.min(data.length, 8000));
    for (const b of sample) {
        if (b === 0)
            return true;
    }
    return false;
}
function decodeUtf8(data) {
    return new TextDecoder().decode(data);
}
function toPatch(change) {
    const before = change.before ?? new Uint8Array();
    const after = change.after ?? new Uint8Array();
    const hasBinary = isProbablyBinary(before) || isProbablyBinary(after);
    const header = [
        `diff --git a/${change.path} b/${change.path}`,
        `--- ${change.kind === "added" ? "/dev/null" : `a/${change.path}`}`,
        `+++ ${change.kind === "removed" ? "/dev/null" : `b/${change.path}`}`,
    ];
    if (hasBinary) {
        return [...header, "Binary files differ"].join("\n");
    }
    const beforeText = decodeUtf8(before);
    const afterText = decodeUtf8(after);
    const beforeLines = beforeText.length > 0 ? beforeText.split("\n") : [];
    const afterLines = afterText.length > 0 ? afterText.split("\n") : [];
    const hunkHeader = `@@ -${beforeLines.length > 0 ? "1" : "0"},${countLines(beforeText)} +${afterLines.length > 0 ? "1" : "0"},${countLines(afterText)} @@`;
    const removed = beforeLines.map((l) => `-${l}`);
    const added = afterLines.map((l) => `+${l}`);
    return [...header, hunkHeader, ...removed, ...added].join("\n");
}
function printPatch(patch) {
    for (const patchLine of patch.split("\n")) {
        if (patchLine.startsWith("+++") || patchLine.startsWith("---") || patchLine.startsWith("diff --git")) {
            console.log(`  ${c.brightCyan}${patchLine}${c.reset}`);
            continue;
        }
        if (patchLine.startsWith("@@")) {
            console.log(`  ${c.brightMagenta}${patchLine}${c.reset}`);
            continue;
        }
        if (patchLine.startsWith("+")) {
            console.log(`  ${c.brightGreen}${patchLine}${c.reset}`);
            continue;
        }
        if (patchLine.startsWith("-")) {
            console.log(`  ${c.brightRed}${patchLine}${c.reset}`);
            continue;
        }
        console.log(`  ${c.gray}${patchLine}${c.reset}`);
    }
}
async function downloadArchive(taskId, token, downloadUrl) {
    const authHeaders = { Authorization: `Bearer ${token}` };
    if (downloadUrl) {
        const direct = await fetch(downloadUrl, { headers: authHeaders });
        if (direct.ok) {
            return new Uint8Array(await direct.arrayBuffer());
        }
        const directNoAuth = await fetch(downloadUrl);
        if (directNoAuth.ok) {
            return new Uint8Array(await directNoAuth.arrayBuffer());
        }
    }
    const fallback = await fetch(`${API_BASE_URL}/download/${taskId}`, { headers: authHeaders });
    if (!fallback.ok) {
        const text = await fallback.text().catch(() => "");
        throw new Error(`Could not download output ZIP (${fallback.status})${text ? `: ${text}` : ""}`);
    }
    return new Uint8Array(await fallback.arrayBuffer());
}
async function extractZipSnapshot(zipBytes) {
    const zip = await JSZip.loadAsync(zipBytes);
    const snapshot = new Map();
    const entries = Object.values(zip.files);
    for (const entry of entries) {
        if (entry.dir)
            continue;
        const normalized = normalizePath(entry.name);
        if (!normalized)
            continue;
        snapshot.set(normalized, await entry.async("uint8array"));
    }
    return snapshot;
}
function buildChanges(localFiles, outputFiles) {
    const changes = [];
    const allPaths = new Set([...localFiles.keys(), ...outputFiles.keys()]);
    for (const filePath of [...allPaths].sort()) {
        const before = localFiles.get(filePath);
        const after = outputFiles.get(filePath);
        if (before && after) {
            if (!byteEquals(before, after)) {
                changes.push({ path: filePath, kind: "modified", before, after });
            }
            continue;
        }
        if (!before && after) {
            changes.push({ path: filePath, kind: "added", after });
            continue;
        }
        if (before && !after) {
            changes.push({ path: filePath, kind: "removed", before });
        }
    }
    return changes;
}
async function applyChanges(projectDir, changes) {
    for (const change of changes) {
        const safePath = normalizePath(change.path);
        const target = path.join(projectDir, safePath);
        if (change.kind === "removed") {
            await rm(target, { force: true });
            continue;
        }
        if (!change.after)
            continue;
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, change.after);
    }
}
export async function reviewOutputArchiveAndApply(taskId, token, projectDir, downloadUrl) {
    console.log(`  ${c.cyan}⟳${c.reset}  Downloading output archive...`);
    const zipBytes = await downloadArchive(taskId, token, downloadUrl);
    console.log(`  ${c.brightGreen}✓${c.reset}  Output downloaded (${(zipBytes.length / 1024).toFixed(1)} KB)`);
    console.log("");
    const [localFiles, outputFiles] = await Promise.all([
        readProjectSnapshot(projectDir),
        extractZipSnapshot(zipBytes),
    ]);
    const changes = buildChanges(localFiles, outputFiles);
    if (changes.length === 0) {
        console.log(`  ${c.brightGreen}✓${c.reset}  No file changes detected.`);
        console.log("");
        return;
    }
    console.log(`  ${c.bold}${c.brightWhite}PROPOSED CHANGES${c.reset}  ${c.gray}(${changes.length} files changed)${c.reset}`);
    console.log(`  ${line()}`);
    console.log("");
    for (const change of changes) {
        const labelColor = change.kind === "added" ? c.brightGreen : change.kind === "removed" ? c.brightRed : c.brightYellow;
        console.log(`  ${labelColor}${change.kind.toUpperCase()}${c.reset}  ${c.bold}${change.path}${c.reset}`);
        printPatch(toPatch(change));
        console.log("");
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
        const answer = await rl.question(`  ${c.bold}Apply these changes and replace local files?${c.reset} ${c.gray}[Y/N]${c.reset} `);
        const normalized = answer.trim().toUpperCase();
        if (normalized === "Y") {
            await applyChanges(projectDir, changes);
            console.log(`\n  ${c.brightGreen}✓${c.reset}  Changes applied to local project.`);
            console.log("");
            return;
        }
        console.log(`\n  ${c.gray}Changes discarded.${c.reset}`);
        console.log("");
    }
    finally {
        rl.close();
    }
}
