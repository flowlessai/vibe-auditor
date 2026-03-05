import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import type { ExtractedDiff, RawDiff } from "./types";
import { runCommand, writeDiffContent } from "./project";
import { c, line, write } from "./ui";

export function extractDiffs(rawDiffs: RawDiff[]): ExtractedDiff[] {
  return rawDiffs
    .filter((entry) => entry && typeof entry === "object")
    .map((obj) => {
      const filePath = obj.path ?? obj.filePath ?? obj.filename ?? obj.file ?? "unknown-file";

      const patch =
        typeof obj.patch === "string"
          ? obj.patch
          : typeof obj.diff === "string"
            ? obj.diff
            : undefined;

      const newContent =
        typeof obj.newContent === "string"
          ? obj.newContent
          : typeof obj.content === "string"
            ? obj.content
            : typeof obj.after === "string"
              ? obj.after
              : undefined;

      return { path: String(filePath), patch, newContent };
    })
    .filter((d) => d.path !== "unknown-file" && (d.patch || d.newContent));
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
