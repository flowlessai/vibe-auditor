import { structuredPatch } from "diff";
import { highlight, supportsLanguage } from "cli-highlight";
const beforeText = `function foo() {
  return "bar";
}
`;
const afterText = `function foo() {
  return "baz";
}
`;
const highlightedBefore = highlight(beforeText, { language: "typescript" }).split("\n");
const highlightedAfter = highlight(afterText, { language: "typescript" }).split("\n");
const patch = structuredPatch("test.ts", "test.ts", beforeText, afterText, "", "", { context: 3 });
for (const hunk of patch.hunks) {
    console.log(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`);
    let oldIdx = hunk.oldStart === 0 ? 0 : hunk.oldStart - 1;
    let newIdx = hunk.newStart === 0 ? 0 : hunk.newStart - 1;
    for (const line of hunk.lines) {
        if (line.startsWith("+")) {
            console.log(`+ ${highlightedAfter[newIdx] ?? ""}`);
            newIdx++;
        }
        else if (line.startsWith("-")) {
            console.log(`- ${highlightedBefore[oldIdx] ?? ""}`);
            oldIdx++;
        }
        else if (line.startsWith("\\")) {
            console.log(`${line}`);
        }
        else {
            console.log(`  ${highlightedAfter[newIdx] ?? ""}`);
            newIdx++;
            oldIdx++;
        }
    }
}
