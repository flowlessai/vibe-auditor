import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { CONFIG_DIR, TOKEN_FILE } from "./config.js";
export async function loadToken() {
    try {
        const raw = await readFile(TOKEN_FILE, "utf8");
        const parsed = JSON.parse(raw);
        return parsed.accessToken ?? null;
    }
    catch {
        return null;
    }
}
export async function saveToken(accessToken) {
    await mkdir(CONFIG_DIR, { recursive: true });
    await writeFile(TOKEN_FILE, JSON.stringify({ accessToken }, null, 2), { mode: 0o600 });
}
export async function deleteToken() {
    await rm(TOKEN_FILE, { force: true });
}
