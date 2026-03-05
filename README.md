# vibe-auditor

Flowless Auditor CLI based on `openapi.json`.

## Setup

```bash
bun install
```

## Run

```bash
bun run index.ts --help
```

## Commands

```bash
auditor login
auditor logout
auditor resume <taskId>
auditor <directory>    # use "." for current directory
```

## Behavior

- `login`: starts device login polling and saves token globally at `~/.config/flowlessai/auditor-auth.json`.
- `logout`: revokes remote token and removes local token.
- `auditor <directory>`: zips the project in memory (ignoring `.gitignore` files when Git metadata is available), starts an audit task, and shows a real-time animated processing UI.
- `Ctrl+C` during live task: pauses the task, exits, and prints the `auditor resume <taskId>` command.
- end of task: previews diffs in colored GitHub-style terminal output and asks whether to apply them locally.
