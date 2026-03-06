import { createTaskAndMonitor, login, logout, resumeTask, showStatus } from "./commands.ts";
import { c, printHelp, showCursor } from "./ui.ts";

export async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === "--help" || args[0] === "-h" || args[0] === "help") {
    await printHelp();
    return;
  }

  const command = args[0];
  if (!command) {
    await printHelp();
    return;
  }

  if (command === "login") {
    await login();
    return;
  }
  if (command === "logout") {
    await logout();
    return;
  }
  if (command === "status") {
    await showStatus();
    return;
  }

  if (command === "resume") {
    const taskId = args[1];
    if (!taskId) throw new Error("Usage: auditor resume <taskId>");
    await resumeTask(taskId);
    return;
  }

  // Check if command is a valid directory path before treating as task name
  try {
    const projectPath = command === "." ? process.cwd() : path.resolve(process.cwd(), command);
    const stats = await stat(projectPath);
    if (!stats.isDirectory()) {
      throw new Error(`Invalid command: ${command}`);
    }
  } catch {
    throw new Error(`Unknown command: ${command}. Run 'auditor --help' for usage.`);
  }

  const mFlag = args.indexOf("-m");
  const message = mFlag !== -1 && args[mFlag + 1] ? args[mFlag + 1] : undefined;
  await createTaskAndMonitor(command, message);
}

export async function runCli() {
  try {
    await main();
  } catch (err) {
    showCursor();
    console.error("");
    console.error(`  ${c.brightRed}✗${c.reset}  ${c.bold}${err instanceof Error ? err.message : String(err)}${c.reset}`);
    console.error("");
    process.exit(1);
  }
}
