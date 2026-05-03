# opencode-goal

OpenCode server plugin that adds Codex-style `/goal` behavior for long-running tasks.

## Commands

- `/goal`: show the current goal or `Usage: /goal <objective>` if none exists.
- `/goal <objective>`: set or replace the active goal.
- `/goal pause`: pause auto-continuation.
- `/goal resume`: resume auto-continuation.
- `/goal clear`: remove the goal.

Active goals auto-continue when the session becomes idle. The continuation prompt is based on Codex's goal prompt with all token and budget handling removed.

## Tool

The plugin exposes `update_goal({ status: "complete" })` so the assistant can stop the loop after it verifies the objective is actually complete.

## State

State is persisted per session in:

```text
${XDG_STATE_HOME:-~/.local/state}/opencode-goal/state.json
```

Only wall-clock active time is tracked. Token usage and token budgets are intentionally not tracked or mentioned.

## Local Install

Add the source plugin path to OpenCode config:

```jsonc
"plugin": [
  "/home/mirsella/dev/opencode-goal/src/index.ts",
]
```

Then restart OpenCode so it reloads the plugin.

## Checks

```sh
bun install
bun test
bunx tsc --noEmit
```

## Known Gaps

- OpenCode server plugins do not expose Codex's replace-confirmation menu, so `/goal <objective>` replaces immediately.
- Plan-mode suppression is best effort because plugin events do not always expose the active mode.
- Continuation prompt injection uses OpenCode's experimental message transform hook.
