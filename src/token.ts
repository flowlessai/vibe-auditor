import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { CONFIG_DIR, TOKEN_FILE } from "./config.ts";

export async function loadToken(): Promise<string | null> {
  try {
    const raw = await readFile(TOKEN_FILE, "utf8");
    const parsed = JSON.parse(raw) as { accessToken?: string };
    const token = parsed.accessToken;
    return typeof token === "string" && token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

export async function saveToken(accessToken: string): Promise<void> {
  if (!accessToken || typeof accessToken !== "string") {
    throw new Error("Invalid access token: must be a non-empty string");
  }
  await mkdir(CONFIG_DIR, { recursive: true });
  // Note: mode 0o600 restricts access on Unix-like systems; Windows ACLs may differ
  await writeFile(TOKEN_FILE, JSON.stringify({ accessToken }, null, 2), { mode: 0o600 });
}

export async function deleteToken(): Promise<void> {
  await rm(TOKEN_FILE, { force: true });
}
