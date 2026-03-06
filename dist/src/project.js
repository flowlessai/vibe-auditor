import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import ignore from "ignore";
export async function runCommand(args, cwd, stdinContent) {
    const [command, ...commandArgs] = args;
    if (!command)
        throw new Error("No command provided");
    const proc = spawn(command, commandArgs, {
        cwd,
        stdio: ["pipe", "pipe", "pipe"],
    });
    const stdoutChunks = [];
    const stderrChunks = [];
    proc.stdout.on("data", (chunk) => {
        stdoutChunks.push(chunk);
    });
    proc.stderr.on("data", (chunk) => {
        stderrChunks.push(chunk);
    });
    if (stdinContent) {
        const data = typeof stdinContent === "string" ? Buffer.from(stdinContent, "utf8") : Buffer.from(stdinContent);
        proc.stdin.write(data);
    }
    proc.stdin.end();
    const code = await new Promise((resolve, reject) => {
        proc.on("error", reject);
        proc.on("close", (exitCode) => resolve(exitCode ?? 1));
    });
    return {
        stdout: new Uint8Array(Buffer.concat(stdoutChunks)),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        code,
    };
}
async function collectFilesWithGit(projectDir) {
    const check = await runCommand(["git", "-C", projectDir, "rev-parse", "--is-inside-work-tree"]);
    if (check.code !== 0)
        return null;
    const res = await runCommand(["git", "-C", projectDir, "ls-files", "--cached", "--others", "--exclude-standard", "-z"]);
    if (res.code !== 0)
        return null;
    return new TextDecoder()
        .decode(res.stdout)
        .split("\0")
        .map((e) => e.trim())
        .filter(Boolean);
}
async function collectFilesFallback(projectDir) {
    const result = [];
    const ignoredDirs = new Set([".git", "node_modules", ".next", ".turbo", "dist", "build", "coverage", "__pycache__", ".venv"]);
    const ig = ignore();
    try {
        const gitignore = await readFile(path.join(projectDir, ".gitignore"), "utf8");
        ig.add(gitignore);
    }
    catch {
        // no .gitignore
    }
    async function walk(current) {
        const entries = await readdir(current, { withFileTypes: true });
        for (const entry of entries) {
            if (entry.name.startsWith(".DS_Store"))
                continue;
            if (entry.isDirectory() && ignoredDirs.has(entry.name))
                continue;
            const abs = path.join(current, entry.name);
            const rel = path.relative(projectDir, abs).split(path.sep).join("/");
            const relForMatch = entry.isDirectory() ? `${rel}/` : rel;
            if (ig.ignores(relForMatch))
                continue;
            if (entry.isDirectory())
                await walk(abs);
            else if (entry.isFile())
                result.push(rel);
        }
    }
    await walk(projectDir);
    return result;
}
export async function listProjectFiles(projectDir) {
    return (await collectFilesWithGit(projectDir)) ?? (await collectFilesFallback(projectDir));
}
export async function readProjectSnapshot(projectDir) {
    const fileList = await listProjectFiles(projectDir);
    const snapshot = new Map();
    for (const relPath of fileList) {
        const content = await readFile(path.join(projectDir, relPath));
        snapshot.set(relPath, content);
    }
    return snapshot;
}
export async function zipProject(projectDir) {
    const fileList = await listProjectFiles(projectDir);
    if (fileList.length === 0)
        throw new Error("No files found to upload.");
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
export async function writeDiffContent(projectDir, relPath, newContent) {
    const safePath = relPath.replace(/^\/+/, "");
    const target = path.join(projectDir, safePath);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, newContent, "utf8");
}
