# vibe-auditor

> **Public Beta** — [flowlessai.one](https://flowlessai.one)

AI-powered code auditor for your local projects. Finds what compilers and tests miss. No prompts. No setup.

Built for developers shipping AI-generated code who need a second pair of eyes before production.

---

## Install

```bash
npm i -g vibe-auditor
```

Requires **Node.js 18+** or **Bun 1.0+**.

---

## Authentication

```bash
auditor login
```

Generates a 6-digit code and opens a verification URL. Authenticate once in your browser — your session is stored locally and reused across projects.

```bash
auditor logout
```

Revokes your session remotely and removes the local token.

---

## Auditing a Project

```bash
# Audit the current directory
auditor .

# Audit a specific path
auditor <directory>

# Audit with additional context for the AI
auditor . -m "Focus on the payment flow"
auditor . -m "We just migrated from JWT to sessions"
```

Files listed in `.gitignore` are automatically excluded. No configuration required.

---

## How It Works

1. **Scan** — the CLI collects your project files, respecting `.gitignore`
2. **Upload** — files are compressed and sent securely to FlowLessAI
3. **Analysis** — the AI audits your entire codebase with full cross-file context
4. **Review** — findings and proposed fixes appear in your terminal as they arrive
5. **Apply** — review each fix individually and choose to apply or discard

Your analysis history is saved automatically and accessible at [flowlessai.one](https://flowlessai.one).

---

## Pause & Resume

Press `Ctrl+C` at any point during analysis to pause the task gracefully.

```bash
# Resume a paused task
auditor resume <taskId>
```

The task ID is printed when you pause and is also available in your history at [flowlessai.one](https://flowlessai.one).

---

## Commands

| Command | Description |
|---|---|
| `auditor login` | Authenticate your device |
| `auditor logout` | Revoke your session |
| `auditor .` | Audit current directory |
| `auditor <path>` | Audit a specific directory |
| `auditor . -m "<note>"` | Audit with extra context for the AI |
| `auditor resume <taskId>` | Resume a paused task |
| `auditor --help` | Show usage guide |

---

## Beta

vibe-auditor is currently in **public beta**. Functionality may change between releases.

Found a bug or have feedback? Reach us at [sales@flowlessai.one](mailto:sales@flowlessai.one)

---

[flowlessai.one](https://flowlessai.one) · [@flowlessai](https://x.com/flowlessai)
