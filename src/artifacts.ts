import type { Artifact } from "./types.ts";
import { c, line, severityBadge, write } from "./ui.ts";

export type NormalizedArtifact = {
  file: string;
  severity?: string;
  risks: string[];
  suggestions: string[];
  summary?: string;
};

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : [];
  }
  return [];
}

function pickFirstArray(obj: Artifact, keys: string[]): string[] {
  for (const key of keys) {
    const arr = asStringArray(obj[key]);
    if (arr.length > 0) return arr;
  }
  return [];
}

export function normalizeArtifact(artifact: Artifact): NormalizedArtifact {
  const file = String(artifact.file ?? artifact.path ?? artifact.filePath ?? artifact.filename ?? "unknown");
  const severity = typeof artifact.severity === "string" ? artifact.severity : undefined;
  const summaryRaw = artifact.summary ?? artifact.description;
  const summary = typeof summaryRaw === "string" ? summaryRaw : undefined;

  const risks = pickFirstArray(artifact, ["risks", "findings", "issues"]);
  const suggestions = pickFirstArray(artifact, ["suggestions", "recommendations", "actions"]);

  return { file, severity, risks, suggestions, summary };
}

export function artifactPreviewLines(artifacts: Artifact[], limit = 3): string[] {
  if (artifacts.length === 0) return [];

  const lines: string[] = [];
  const selected = artifacts.slice(-limit).map(normalizeArtifact);

  lines.push(`  ${c.bold}${c.brightWhite}Live Artifacts${c.reset}  ${c.gray}(file, risks, suggestions)${c.reset}`);
  lines.push("");

  for (const art of selected) {
    lines.push(`  ${c.brightCyan}◆${c.reset} ${c.bold}${art.file}${c.reset}${art.severity ? ` ${severityBadge(art.severity)}` : ""}`);

    const riskText = art.risks.length > 0 ? art.risks.slice(0, 2).join(" | ") : art.summary ?? "No risks detected yet";
    const suggestionText = art.suggestions.length > 0 ? art.suggestions.slice(0, 2).join(" | ") : "Waiting for suggestions";

    lines.push(`    ${c.yellow}Risks:${c.reset} ${c.dim}${riskText}${c.reset}`);
    lines.push(`    ${c.green}Suggestions:${c.reset} ${c.dim}${suggestionText}${c.reset}`);
    lines.push("");
  }

  return lines;
}

export function printArtifacts(artifacts: Artifact[]) {
  if (artifacts.length === 0) return;

  console.log("");
  console.log(`  ${c.bold}${c.brightWhite}FINDINGS${c.reset}  ${c.gray}(${artifacts.length} files analyzed)${c.reset}`);
  console.log(`  ${line()}`);
  console.log("");

  for (const artifact of artifacts.map(normalizeArtifact)) {
    write(`  ${c.brightCyan}◆${c.reset} ${c.bold}${artifact.file}${c.reset}`);
    if (artifact.severity) write(`  ${severityBadge(artifact.severity)}`);
    write("\n");

    if (artifact.risks.length > 0) {
      for (const risk of artifact.risks) {
        write(`    ${c.yellow}Risk:${c.reset} ${c.dim}${risk}${c.reset}\n`);
      }
    }

    if (artifact.suggestions.length > 0) {
      for (const suggestion of artifact.suggestions) {
        write(`    ${c.green}Suggestion:${c.reset} ${c.dim}${suggestion}${c.reset}\n`);
      }
    } else if (artifact.summary) {
      write(`    ${c.gray}${artifact.summary}${c.reset}\n`);
    }

    console.log("");
  }
}

export function printGlobalAnalysis(analysis: unknown) {
  if (!analysis) return;

  console.log(`  ${c.bold}${c.brightWhite}GLOBAL ANALYSIS${c.reset}`);
  console.log(`  ${line()}`);
  console.log("");

  const maybeObject = typeof analysis === "object" ? (analysis as Record<string, unknown>) : null;
  const maybeIssues = maybeObject?.issues;

  if (Array.isArray(maybeIssues)) {
    for (const rawIssue of maybeIssues) {
      if (!rawIssue || typeof rawIssue !== "object") continue;
      const issue = rawIssue as Record<string, unknown>;
      const severity = typeof issue.severity === "string" ? issue.severity.toUpperCase() : "UNKNOWN";
      const description = typeof issue.description === "string" ? issue.description : "Issue description unavailable.";
      const files = Array.isArray(issue.affectedFiles)
        ? issue.affectedFiles.map((f) => String(f)).filter(Boolean)
        : [];

      write(`  ${c.brightCyan}Issue${c.reset} ${severityBadge(severity)}\n`);
      write(`    ${c.gray}${description}${c.reset}\n`);
      write(`    ${c.yellow}Files affected:${c.reset} ${c.dim}${files.length > 0 ? files.join(", ") : "N/A"}${c.reset}\n\n`);
    }

    if (maybeIssues.length === 0) {
      write(`  ${c.gray}No issues found.${c.reset}\n`);
    }
  } else if (typeof analysis === "string") {
    write(`  ${c.gray}${analysis}${c.reset}\n`);
  } else {
    write(`  ${c.gray}No structured issues found in analysis.${c.reset}\n`);
  }

  console.log("");
}
