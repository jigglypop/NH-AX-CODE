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

Implemented (2026-07):
- Per-model capability cache (globalState, working endpoint tried first).
- Failed endpoint blacklist per model (structural mismatches only; never blacklists all).
- `clarusCode.probeEndpoints` command: probes all three endpoints, reports to output channel, seeds the cache.

### 2. Terminal command execution

Status: first implementation done.

Implemented:
- `runCommand` operation in `clarus-actions`.
- Command and args are separated.
- Workspace-relative cwd.
- Approval modal before execution.
- stdout/stderr captured and appended to chat.

Implemented (2026-07):
- Streaming stdout/stderr via spawn → toolEvent messages.
- `clarusCode.commandAllowlist` / `commandDenylist` prefix rules (deny wins).
- Persistent command history (globalState, 100 entries, `clarusCode.showCommandHistory`).
- Integrated terminal mode (`clarusCode.runCommandsInTerminal`).

### 3. Tool-based agent loop

Status: closed-loop controller implemented (2026-07, `src/agentLoop.ts`).

Implemented:
- Closed-loop controller per `docs/7_AGI/17_AgentLoop.md` (Layer F): self-critique
  (F.4 c_pred/c_cons/c_nov) is injected into the next model turn (F.-1.3 closure),
  contraction metric rhoHat halts non-contracting loops (same failing plan 3x),
  dynamic step budget 4→8 stretches only while progressing (F.3 dual-process).
- Apply errors no longer kill the turn — they become critique for self-correction.
- Loop metrics (step, c̄, contraction/divergence) shown in the webview topbar.
- Model output can apply `clarus-actions`, feed tool results back, then continue.
- `runCommand` results can drive the next model step.

Implemented (2026-07):
- Read/search/list tools: `readFile`, `listDir`, `searchText` operations (read-only, plan-mode safe).
- Tool call timeline in the webview (running/done/error/blocked per operation).
- Stop/cancel: 중지 button → chatCancel → AbortSignal on in-flight fetch + loop exit.
- Native function-calling (`clarusCode.toolMode: "native"`): OpenAI chat-completions
  `tools`/`tool_calls` and Anthropic `tool_use`/`tool_result` with protocol-correct
  feedback messages; falls back to `clarus-actions` blocks in `actions-block` mode.
  Native mode disables streaming and per-op partial-accept (assumes auto-apply).

### 4. Diff review UI

Status: preview implementation done.

Implemented:
- Markdown action preview opens before applying actions.
- File operations and command operations are shown before approval.
- Accept/reject confirmation remains modal.

Implemented (2026-07):
- True file-by-file diff preview (vscode.diff with virtual documents, 현재 ↔ 제안).
- Partial accept: per-operation multi-select QuickPick when `autoApplyFileActions` is off.
- Applied vs proposed: rejected operations are reported back to the agent loop.

### 5. Checkpoint / rollback

Status: first implementation done.

Implemented:
- In-memory checkpoint before file edits.
- Tracks existing files and newly created files.
- Command palette command restores the latest checkpoint.

Implemented (2026-07):
- Persistent checkpoints across VS Code reload (workspaceState).
- Checkpoint list UI (`clarusCode.listCheckpoints` QuickPick).
- Diff before restore (현재 ↔ 체크포인트 per file).

## P1 Roadmap

All implemented (2026-07):
- `NH-AX-CODE.md`, `AGENTS.md`, `CLAUDE.md` instruction loading into the system prompt (16k char budget).
- Real plan mode: read-only tools (readFile/listDir/searchText) run, mutations blocked and reported.
- Slash commands: `/clear`, `/compact` (model-summarized context), `/model`, `/plan`, `/permissions`.
- Session persistence and resume (workspaceState; restored on webview mount, saved on each turn).
- Test/build verification loop: `clarusCode.verifyCommand` runs after mutations, output feeds the F.4 critic.

## P2 Roadmap

All implemented (2026-07):
- Permission rule editor: `clarusCode.editPermissionRules` QuickPick add/remove for allow/deny lists.
- Hooks: `clarusCode.hooks` { preAction, postAction, onError } — preAction non-zero exit blocks the plan;
  payload passed via CLARUS_* env vars.
- MCP connectors: `clarusCode.mcpServers` stdio servers (src/mcp.ts, zero-dependency JSON-RPC client);
  tools exposed as `mcpTool` operations and as `mcp__server__tool` native functions;
  `clarusCode.reloadMcpServers` command.
- Skills: `.nhax/skills/*.md` auto-listed in the system prompt (model loads via readFile); `/skills` command.
- Subagents: `subagent {task, context?}` operation — nested read-only analysis loop with its own context.
- Context compact: `/compact` (manual) + `clarusCode.autoCompactThreshold` automatic compaction before each turn.
- Git workflow: `/commit` and `clarusCode.gitCommit` — AI-generated commit message, add -A, commit.

## Remaining Gaps (honest)

- Native tool-calling supports chat-completions and Anthropic only; `responses`/`completions`
  endpoints stay on `clarus-actions` blocks.
- MCP client implements initialize/tools only (no resources/prompts/notifications), stdio transport only.
- Subagents are read-only by design; no parallel subagent execution.
- Hooks run whole-plan (pre/post/error), not per-tool matchers.
- Skills are prompt-listed pointers, not sandboxed executable bundles.
