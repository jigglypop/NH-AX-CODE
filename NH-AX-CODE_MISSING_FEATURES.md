# NH-AX-CODE Missing Features

This document tracks the gap between NH-AX-CODE and tools such as Claude Code / Codex.

References:
- Codex IDE extension: https://developers.openai.com/codex/ide
- Codex AGENTS.md: https://developers.openai.com/codex/guides/agents-md
- Claude Code permissions: https://code.claude.com/docs/en/permissions
- Claude Code slash commands: https://code.claude.com/docs/en/agent-sdk/slash-commands
- Claude Code checkpointing: https://code.claude.com/docs/en/checkpointing

## Current State

- VS Code Webview chat UI exists.
- OpenAI, Anthropic, and OpenAI-compatible providers exist.
- Model list and custom model input exist.
- Endpoint mode exists: `auto`, `chat-completions`, `responses`, `completions`.
- Optional SSE response parsing exists.
- `@` mention can attach workspace files/folders and absolute folder paths.
- `clarus-actions` can create, replace, edit ranges, delete files, and run approved commands.
- Scope is always context selection. Permission menu is now only `workspace edits` or `plan only`.

## P0 Roadmap

### 1. Provider / endpoint capability

Status: mostly implemented.

Implemented:
- Auto endpoint fallback: chat completions -> responses -> completions.
- Custom model input.
- Optional SSE parsing.
- Endpoint mode UI.

Still needed:
- Per-model capability cache.
- Failed endpoint blacklist per model.
- Probe button and diagnostics view.

### 2. Terminal command execution

Status: first implementation done.

Implemented:
- `runCommand` operation in `clarus-actions`.
- Command and args are separated.
- Workspace-relative cwd.
- Approval modal before execution.
- stdout/stderr captured and appended to chat.

Still needed:
- Streaming stdout/stderr events.
- Command allow/deny rules.
- Persistent command history.
- Integrated terminal mode.

### 3. Tool-based agent loop

Status: first implementation done.

Implemented:
- Multi-step loop up to 4 model/action rounds.
- Model output can apply `clarus-actions`, feed tool results back, then continue.
- `runCommand` results can drive the next model step.

Still needed:
- Explicit tool schema separate from `clarus-actions`.
- Read/search/list tools.
- Tool call timeline in UI.
- Stop/cancel support.

### 4. Diff review UI

Status: preview implementation done.

Implemented:
- Markdown action preview opens before applying actions.
- File operations and command operations are shown before approval.
- Accept/reject confirmation remains modal.

Still needed:
- True file-by-file diff preview.
- Partial accept.
- Applied vs proposed changes.

### 5. Checkpoint / rollback

Status: first implementation done.

Implemented:
- In-memory checkpoint before file edits.
- Tracks existing files and newly created files.
- Command palette command restores the latest checkpoint.

Still needed:
- Persistent checkpoints across VS Code reload.
- Checkpoint list UI.
- Diff before restore.

## P1 Roadmap

- `AGENTS.md`, `CLAUDE.md`, `NH-AX-CODE.md` instruction loading.
- Real plan mode with read-only tool access.
- Slash commands: `/clear`, `/compact`, `/model`, `/plan`, `/permissions`.
- Session persistence and resume.
- Test/build verification loop.

## P2 Roadmap

- Permission rule editor.
- Hooks.
- MCP connectors.
- Skills and subagents.
- Context compact.
- Git workflow.

## Next Recommended Step

Build the tool-based agent loop. The current implementation can apply model-generated actions, but a Codex-like agent needs iterative tool calls and visible timeline events.
