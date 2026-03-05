import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { CONFIG_DIR, TOKEN_FILE } from "./config.ts";

export async function loadToken(): Promise<string | null> {
  try {
    const raw = await readFile(TOKEN_FILE, "utf8");
    const parsed = JSON.parse(raw) as { accessToken?: string };
    return parsed.accessToken ?? null;
  } catch {
    return null;
  }
}

export async function saveToken(accessToken: string): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(TOKEN_FILE, JSON.stringify({ accessToken }, null, 2), { mode: 0o600 });
}

export async function deleteToken(): Promise<void> {
  await rm(TOKEN_FILE, { force: true });
}
