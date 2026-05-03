import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "bun:test"
import GoalPlugin from "../src/index"

const dirs: string[] = []
const oldStateHome = process.env.XDG_STATE_HOME

afterEach(async () => {
  process.env.XDG_STATE_HOME = oldStateHome
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe("goal plugin e2e harness", () => {
  test("/goal <objective> starts a fresh-session continuation and injects the prompt", async () => {
    const stateHome = await mkdtemp(join(tmpdir(), "opencode-goal-e2e-"))
    dirs.push(stateHome)
    process.env.XDG_STATE_HOME = stateHome

    const prompts: any[] = []
    const toasts: any[] = []
    const client = {
      tui: { showToast: async (input: any) => void toasts.push(input.body) },
      session: {
        messages: async () => [],
        prompt: async (input: any) => void prompts.push(input),
      },
    }

    const hooks = await GoalPlugin({ client } as any)
    await expect(
      hooks["command.execute.before"]?.(
        { command: "goal", sessionID: "session-1", arguments: "create goal-smoke.txt and verify it exists" },
        { parts: [] },
      ),
    ).rejects.toThrow("__GOAL_HANDLED__")

    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toMatchObject({
      path: { id: "session-1" },
      body: {
        agent: "build",
        parts: [{ type: "text", text: "Continue working toward the active goal.", synthetic: true, ignored: true }],
      },
    })
    expect(toasts.at(-1)?.message).toContain("Goal active")

    const trigger = {
      message: { id: "msg-trigger" },
      parts: [
        {
          id: "prt-trigger",
          sessionID: "session-1",
          messageID: "msg-trigger",
          type: "text",
          text: "Continue working toward the active goal.",
          synthetic: true,
          ignored: true,
          metadata: { goal: "opencode-goal-continuation-trigger" },
        },
      ],
    }

    await hooks["chat.message"]?.({ sessionID: "session-1" }, trigger as any)

    const output = {
      messages: [
        {
          info: {
            id: "msg-trigger",
            sessionID: "session-1",
            role: "user",
            agent: "build",
            model: { providerID: "test", modelID: "test" },
            time: { created: Date.now() },
          },
          parts: trigger.parts,
        },
      ],
    }

    await hooks["experimental.chat.messages.transform"]?.({}, output as any)

    expect(output.messages).toHaveLength(1)
    const injected = output.messages[0]?.parts[0]
    expect(injected).toBeDefined()
    expect(injected?.text).toContain("Continue working toward the active thread goal.")
    expect(injected?.text).toContain("create goal-smoke.txt and verify it exists")
    expect(injected?.text).not.toContain("Token budget")
  })
})
