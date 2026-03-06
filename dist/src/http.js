import { API_BASE_URL } from "./config.js";
export async function request(method, endpoint, options = {}) {
    const headers = new Headers();
    if (options.token)
        headers.set("Authorization", `Bearer ${options.token}`);
    const response = await fetch(`${API_BASE_URL}${endpoint}`, {
        method,
        headers,
        body: options.body ?? null,
    });
    if (!response.ok) {
        const text = await response.text();
        throw new Error(`${method} ${endpoint} → ${response.status}: ${text || "Unknown error"}`);
    }
    return (await response.json());
}
