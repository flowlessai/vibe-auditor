# vibe-auditor

FlowlessAI Vibe Auditor CLI.

## Install

```bash
npm i -g vibe-auditor
```

## Usage

```bash
auditor --help
auditor login
auditor logout
auditor status
auditor .
auditor <directory>
auditor resume <taskId>
```

## Behavior

- `login`: starts device authentication and stores a token at `~/.config/flowlessai/auditor-auth.json`.
- `logout`: revokes the remote session and removes the local token.
- `auditor <directory>`: uploads your project and shows a live status UI.
- When the task is done, the CLI downloads the output ZIP in memory, compares it with your local project, shows GitHub-style diffs for changed files, and asks for `Y/N` to apply or discard.
- `Ctrl+C` during processing pauses the task and prints the resume command.
