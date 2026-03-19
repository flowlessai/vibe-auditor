import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import type { ExtractedDiff, RawDiff } from "./types.ts";
import { runCommand, writeDiffContent } from "./project.ts";
import { c, line, write } from "./ui.tsx";

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function toSafePath(raw: unknown): string {
  return String(raw ?? "").trim().replace(/^([ab]\/)+/, "").replace(/^\/+/, "");
}

function detectPathFromPatch(patch: string): string | undefined {
  const plusLine = patch.split("\n").find((line) => line.startsWith("+++ "));
  if (plusLine) {
    const raw = plusLine.replace("+++ ", "").trim();
    if (raw !== "/dev/null") return toSafePath(raw);
  }

  const diffGit = patch.match(/^diff --git a\/(.+?) b\/(.+)$/m);
  if (diffGit) {
    return toSafePath(diffGit[2]);
  }

  return undefined;
}

function splitMultiFilePatch(patch: string): Array<{ path?: string; patch: string }> {
  const lines = patch.split("\n");
  const chunks: Array<{ path?: string; patch: string }> = [];
  let current: string[] = [];

  const flush = () => {
    if (current.length === 0) return;
    const chunkPatch = current.join("\n");
    chunks.push({ path: detectPathFromPatch(chunkPatch), patch: chunkPatch });
    current = [];
  };

  for (const line of lines) {
    if (line.startsWith("diff --git ") && current.length > 0) {
      flush();
    }
    current.push(line);
  }
  flush();

  return chunks.length > 1 ? chunks : [{ path: detectPathFromPatch(patch), patch }];
}

function extractPath(obj: Record<string, unknown>): string | undefined {
  const candidates = [
    obj.path,
    obj.filePath,
    obj.filename,
    obj.file,
    obj.targetPath,
    obj.newPath,
    obj.relativePath,
  ];
  for (const candidate of candidates) {
    const str = asString(candidate);
    if (str) return toSafePath(str);
  }
  return undefined;
}

function extractPatch(obj: Record<string, unknown>): string | undefined {
  const candidates = [
    obj.patch,
    obj.diff,
    obj.unifiedDiff,
    obj.gitDiff,
    obj.rawDiff,
    obj.changes,
  ];
  for (const candidate of candidates) {
    const str = asString(candidate);
    if (str) return str;
  }
  return undefined;
}

function extractNewContent(obj: Record<string, unknown>): string | undefined {
  const candidates = [
    obj.newContent,
    obj.content,
    obj.after,
    obj.updatedContent,
    obj.newText,
    obj.replacement,
  ];
  for (const candidate of candidates) {
    const str = asString(candidate);
    if (str) return str;
  }

  const maybeLines = obj.lines;
  if (Array.isArray(maybeLines) && maybeLines.length > 0) {
    const reconstructed = maybeLines
      .filter((line) => line && typeof line === "object")
      .map((line) => line as Record<string, unknown>)
      .filter((line) => String(line.type ?? "context") !== "del")
      .map((line) => String(line.content ?? ""))
      .join("\n");
    return reconstructed.trim() ? reconstructed : undefined;
  }

  return undefined;
}

function collectDiffObjects(rawDiffs: RawDiff[]): Array<Record<string, unknown>> {
  const queue: unknown[] = [...rawDiffs];
  const result: Array<Record<string, unknown>> = [];

  while (queue.length > 0) {
    const item = queue.shift();
    if (!item) continue;

    if (typeof item === "string") {
      try {
        const parsed = JSON.parse(item) as unknown;
        queue.push(parsed);
      } catch {
        result.push({ diff: item });
      }
      continue;
    }

    if (Array.isArray(item)) {
      queue.push(...item);
      continue;
    }

    if (typeof item === "object") {
      const obj = item as Record<string, unknown>;
      if (Array.isArray(obj.diffs)) {
        queue.push(...obj.diffs);
      }
      result.push(obj);
    }
  }

  return result;
}

export function extractDiffs(rawDiffs: RawDiff[]): ExtractedDiff[] {
  const out: ExtractedDiff[] = [];
  const seen = new Set<string>();

  for (const obj of collectDiffObjects(rawDiffs)) {
    const patch = extractPatch(obj);
    const explicitPath = extractPath(obj);
    const newContent = extractNewContent(obj);

    if (patch) {
      const patchChunks = splitMultiFilePatch(patch);
      for (const chunk of patchChunks) {
        const path = chunk.path ?? explicitPath ?? "unknown-file";
        if (path === "unknown-file") continue;
        const key = `${path}\u0000${chunk.patch}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ path, patch: chunk.patch });
      }
      continue;
    }

    if (explicitPath && newContent) {
      const key = `${explicitPath}\u0000${newContent}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ path: explicitPath, newContent });
    }
  }

  return out;
}

function printPatch(patch: string) {
  const lines = patch.split("\n");
  for (const line of lines) {
    if (line.startsWith("+++") || line.startsWith("---")) {
      write(`  ${c.brightCyan}${line}${c.reset}\n`);
    } else if (line.startsWith("@@")) {
      write(`  ${c.brightMagenta}${line}${c.reset}\n`);
    } else if (line.startsWith("+")) {
      write(`  ${c.brightGreen}${line}${c.reset}\n`);
    } else if (line.startsWith("-")) {
      write(`  ${c.brightRed}${line}${c.reset}\n`);
    } else {
      write(`  ${c.gray}${line}${c.reset}\n`);
    }
  }
}

async function applyDiffs(projectDir: string, diffs: ExtractedDiff[]): Promise<void> {
  const patches = diffs.map((d) => d.patch).filter((v): v is string => Boolean(v));

  if (patches.length > 0) {
    const patchText = patches.join("\n");
    const apply = await runCommand(["git", "-C", projectDir, "apply", "--whitespace=nowarn", "-"], undefined, patchText);
    if (apply.code !== 0) {
      let applied = false;
      for (const diff of diffs) {
        if (diff.newContent) {
          await writeDiffContent(projectDir, diff.path, diff.newContent);
          applied = true;
        }
      }
      if (!applied) {
        throw new Error(`git apply failed: ${apply.stderr}`);
      }
    }
    return;
  }

  for (const diff of diffs) {
    if (!diff.newContent || diff.path === "unknown-file") continue;
    await writeDiffContent(projectDir, diff.path, diff.newContent);
  }
}

export async function reviewDiffsInteractively(projectDir: string, diffs: ExtractedDiff[]): Promise<void> {
  if (diffs.length === 0) {
    console.log(`  ${c.yellow}⚠${c.reset}  No diffs available to apply.`);
    console.log("");
    return;
  }

  console.log(`  ${c.bold}${c.brightWhite}PROPOSED FIXES${c.reset}  ${c.gray}(${diffs.length} files)${c.reset}`);
  console.log(`  ${line()}`);
  console.log("");

  const toApply: ExtractedDiff[] = [];
  const rl = createInterface({ input, output });

  try {
    for (let i = 0; i < diffs.length; i++) {
      const diff = diffs[i];
      if (!diff) continue;
      const num = `${i + 1}/${diffs.length}`;

      console.log(`  ${c.gray}[${num}]${c.reset}  ${c.bold}${c.brightCyan}${diff.path}${c.reset}`);
      console.log("");

      if (diff.patch) {
        printPatch(diff.patch);
      } else if (diff.newContent) {
        const contentLines = diff.newContent.split("\n");
        const preview = contentLines.slice(0, 20);
        for (const l of preview) {
          write(`  ${c.brightGreen}+ ${l}${c.reset}\n`);
        }
        if (contentLines.length > 20) {
          write(`  ${c.gray}  ... (${contentLines.length - 20} more lines)${c.reset}\n`);
        }
      }

      console.log("");

      const answer = await rl.question(
        `  ${c.bold}Apply this fix?${c.reset}  ${c.gray}[${c.reset}${c.brightGreen}y${c.reset}${c.gray}/${c.reset}${c.brightRed}n${c.reset}${c.gray}/${c.reset}${c.yellow}q${c.reset}${c.gray}]${c.reset}  `
      );

      const a = answer.trim().toLowerCase();
      if (a === "q" || a === "quit") {
        console.log(`\n  ${c.yellow}⚠${c.reset}  Review cancelled. No further fixes applied.`);
        break;
      }
      if (a === "y" || a === "yes") {
        toApply.push(diff);
        console.log(`  ${c.brightGreen}✓${c.reset}  Queued for application.`);
      } else {
        console.log(`  ${c.gray}–${c.reset}  Skipped.`);
      }

      console.log("");
    }
  } finally {
    rl.close();
  }

  if (toApply.length === 0) {
    console.log(`  ${c.gray}No fixes were selected.${c.reset}`);
    console.log("");
    return;
  }

  console.log(`  ${c.cyan}⟳${c.reset}  Applying ${toApply.length} fix${toApply.length === 1 ? "" : "es"}...`);
  console.log("");

  await applyDiffs(projectDir, toApply);

  for (const d of toApply) {
    console.log(`  ${c.brightGreen}✓${c.reset}  ${d.path}`);
  }

  console.log("");
  console.log(`  ${c.brightGreen}${c.bold}Done.${c.reset}  ${toApply.length} fix${toApply.length === 1 ? "" : "es"} applied locally.`);
  console.log("");
}
