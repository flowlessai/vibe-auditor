import { createInterface } from "node:readline/promises";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import { structuredPatch } from "diff";
import { highlight, supportsLanguage } from "cli-highlight";
import { API_BASE_URL } from "./config.ts";
import { readProjectSnapshot } from "./project.ts";
import { c, line, termWidth } from "./ui.tsx";

type ChangeKind = "added" | "modified" | "removed";

type FileChange = {
  path: string;
  kind: ChangeKind;
  before?: Uint8Array;
  after?: Uint8Array;
};

function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\/+/, "");
}

function byteEquals(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function countLines(text: string): number {
  if (text.length === 0) return 0;
  return text.split("\n").length;
}

function isProbablyBinary(data: Uint8Array): boolean {
  const sample = data.subarray(0, Math.min(data.length, 8000));
  for (const b of sample) {
    if (b === 0) return true;
  }
  return false;
}

function decodeUtf8(data: Uint8Array): string {
  return new TextDecoder().decode(data);
}

function printFileDiff(change: FileChange) {
  const before = change.before ?? new Uint8Array();
  const after = change.after ?? new Uint8Array();
  const hasBinary = isProbablyBinary(before) || isProbablyBinary(after);

  if (hasBinary) {
    console.log(`  ${c.gray}Binary files differ${c.reset}`);
    return;
  }

  const beforeText = decodeUtf8(before);
  const afterText = decodeUtf8(after);
  
  const ext = path.extname(change.path).slice(1);
  const lang = supportsLanguage(ext) ? ext : "txt";

  const highlightedBefore = highlight(beforeText, { language: lang }).split("\n");
  const highlightedAfter = highlight(afterText, { language: lang }).split("\n");

  const patch = structuredPatch(change.path, change.path, beforeText, afterText, "", "", { context: 3 });

  if (patch.hunks.length === 0) {
    // Handle empty file changes gracefully when hunks are empty
    if (change.kind === "added" && afterText.length === 0) {
      console.log(`  ${c.gray}(empty file created)${c.reset}`);
    } else if (change.kind === "removed" && beforeText.length === 0) {
      console.log(`  ${c.gray}(empty file removed)${c.reset}`);
    }
    return;
  }

  for (const hunk of patch.hunks) {
    console.log(`  ${c.brightMagenta}@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@${c.reset}`);
    let oldIdx = hunk.oldStart === 0 ? 0 : hunk.oldStart - 1;
    let newIdx = hunk.newStart === 0 ? 0 : hunk.newStart - 1;

    const w = termWidth();
    for (const line of hunk.lines) {
      if (line.startsWith("+")) {
        const text = `  + ${highlightedAfter[newIdx] ?? ""}`;
        const rawLength = `  + ${afterText.split("\n")[newIdx] ?? ""}`.length;
        const padding = " ".repeat(Math.max(0, w - rawLength));
        console.log(`\x1b[102m${text}${padding}\x1b[0m`);
        newIdx++;
      } else if (line.startsWith("-")) {
        const text = `  - ${highlightedBefore[oldIdx] ?? ""}`;
        const rawLength = `  - ${beforeText.split("\n")[oldIdx] ?? ""}`.length;
        const padding = " ".repeat(Math.max(0, w - rawLength));
        console.log(`\x1b[41m${text}${padding}\x1b[0m`);
        oldIdx++;
      } else if (line.startsWith("\\")) {
        console.log(`  ${c.gray}${line}${c.reset}`);
      } else {
        console.log(`    ${highlightedAfter[newIdx] ?? ""}`);
        newIdx++;
        oldIdx++;
      }
    }
  }
}

async function downloadArchive(taskId: string, token: string, downloadUrl: string | null | undefined): Promise<Uint8Array> {
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

async function extractZipSnapshot(zipBytes: Uint8Array): Promise<Map<string, Uint8Array>> {
  const zip = await JSZip.loadAsync(zipBytes);
  const snapshot = new Map<string, Uint8Array>();

  const entries = Object.values(zip.files);
  for (const entry of entries) {
    if (entry.dir) continue;
    const normalized = normalizePath(entry.name);
    if (!normalized) continue;
    snapshot.set(normalized, await entry.async("uint8array"));
  }

  return snapshot;
}

function buildChanges(localFiles: Map<string, Uint8Array>, outputFiles: Map<string, Uint8Array>): FileChange[] {
  const changes: FileChange[] = [];
  const allPaths = new Set<string>([...localFiles.keys(), ...outputFiles.keys()]);

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

async function applyChanges(projectDir: string, changes: FileChange[]) {
  for (const change of changes) {
    const safePath = normalizePath(change.path);
    const target = path.join(projectDir, safePath);

    if (change.kind === "removed") {
      await rm(target, { force: true });
      continue;
    }

    if (!change.after) continue;
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, change.after);
  }
}

export async function reviewOutputArchiveAndApply(
  taskId: string,
  token: string,
  projectDir: string,
  downloadUrl: string | null | undefined
): Promise<void> {
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
    printFileDiff(change);
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
  } finally {
    rl.close();
  }
}
