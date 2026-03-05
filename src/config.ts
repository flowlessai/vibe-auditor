import os from "node:os";
import path from "node:path";

export const API_BASE_URL = process.env.FLOWLESS_API_URL ?? "https://api.flowlessai.one";
export const CONFIG_DIR = path.join(os.homedir(), ".config", "flowlessai");
export const TOKEN_FILE = path.join(CONFIG_DIR, "auditor-auth.json");
export const POLL_INTERVAL_MS = 2000;
