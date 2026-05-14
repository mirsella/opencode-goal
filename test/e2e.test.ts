import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import GoalPlugin from "../src/index"

let previousStateFile: string | undefined
let stateDir: string | undefined
let stateFile = ""

beforeEach(async () => {
  previousStateFile = process.env.OPENCODE_GOAL_STATE_FILE
  stateDir = await mkdtemp(join(tmpdir(), "opencode-goal-"))
  stateFile = join(stateDir, "sessions.json")
  process.env.OPENCODE_GOAL_STATE_FILE = stateFile
})

afterEach(async () => {
  if (previousStateFile === undefined) delete process.env.OPENCODE_GOAL_STATE_FILE
  else process.env.OPENCODE_GOAL_STATE_FILE = previousStateFile

  if (stateDir) await rm(stateDir, { recursive: true, force: true })
  previousStateFile = undefined
  stateDir = undefined
  stateFile = ""
})

describe("goal plugin e2e harness", () => {
  test("package entrypoint only exports plugin functions", async () => {
    expect(Object.keys(await import("../src/index"))).toEqual(["GoalPlugin", "default"])
  })

  test("/goal <objective> starts a fresh-session continuation and injects the prompt", async () => {
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

  test("forwards the selected model variant from user message metadata", async () => {
    const prompts: any[] = []
    const client = {
      tui: { showToast: async () => undefined },
      session: {
        messages: async () => [
          {
            info: {
              id: "msg-user",
              sessionID: "session-variant-message",
              role: "user",
              agent: "build",
              model: { providerID: "test", modelID: "test-model", variant: "thinking" },
              time: { created: Date.now() },
            },
            parts: [],
          },
        ],
        prompt: async (input: any) => void prompts.push(input),
      },
    }

    const hooks = await GoalPlugin({ client } as any)
    await expect(hooks["command.execute.before"]?.({ command: "goal", sessionID: "session-variant-message", arguments: "preserve thinking" }, { parts: [] })).rejects.toThrow(
      "__GOAL_HANDLED__",
    )

    expect(prompts).toHaveLength(1)
    expect(prompts[0]?.body).toMatchObject({
      agent: "build",
      model: { providerID: "test", modelID: "test-model" },
      variant: "thinking",
    })
  })

  test("remembers the selected model variant before the first message", async () => {
    const prompts: any[] = []
    const client = {
      tui: { showToast: async () => undefined },
      session: {
        messages: async () => [],
        prompt: async (input: any) => void prompts.push(input),
      },
    }

    const hooks = await GoalPlugin({ client } as any)
    await hooks.event?.({
      event: {
        type: "session.next.model.switched",
        properties: {
          sessionID: "session-variant-event",
          model: { id: "test-model", providerID: "test", variant: "thinking" },
        },
      },
    } as any)

    await expect(hooks["command.execute.before"]?.({ command: "goal", sessionID: "session-variant-event", arguments: "preserve event thinking" }, { parts: [] })).rejects.toThrow(
      "__GOAL_HANDLED__",
    )

    expect(prompts).toHaveLength(1)
    expect(prompts[0]?.body).toMatchObject({
      agent: "build",
      model: { providerID: "test", modelID: "test-model" },
      variant: "thinking",
    })
  })

  test("assistant aborts are ignored when the session has no goal", async () => {
    const toasts: any[] = []
    const warnings: unknown[][] = []
    const originalWarn = console.warn
    console.warn = (...args: unknown[]) => void warnings.push(args)

    try {
      const client = {
        tui: { showToast: async (input: any) => void toasts.push(input.body) },
        session: {
          messages: async () => [],
          prompt: async () => undefined,
        },
      }

      const hooks = await GoalPlugin({ client } as any)
      await hooks.event?.({
        event: {
          type: "message.updated",
          properties: {
            info: {
              id: "msg-aborted",
              sessionID: "session-without-goal",
              role: "assistant",
              error: { name: "MessageAbortedError" },
            },
          },
        },
      } as any)

      expect(toasts).toHaveLength(0)
      expect(warnings).toHaveLength(0)
    } finally {
      console.warn = originalWarn
    }
  })

  test("keeps using recovery prompts for repeated stop-only continuations", async () => {
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
    const injectPending = async (id: string) => {
      const trigger = {
        message: { id },
        parts: [{ id: `${id}-part`, sessionID: "session-loop", messageID: id, type: "text", text: "Continue working toward the active goal.", synthetic: true, ignored: true }],
      }
      await hooks["chat.message"]?.({ sessionID: "session-loop" }, trigger as any)
      const output = { messages: [{ info: { id, sessionID: "session-loop", role: "user", agent: "build", time: { created: Date.now() } }, parts: trigger.parts }] }
      await hooks["experimental.chat.messages.transform"]?.(
        {},
        output as any,
      )
      return output.messages[0]?.parts[0]?.text ?? ""
    }

    await expect(hooks["command.execute.before"]?.({ command: "goal", sessionID: "session-loop", arguments: "keep improving until complete" }, { parts: [] })).rejects.toThrow(
      "__GOAL_HANDLED__",
    )
    expect(prompts).toHaveLength(1)
    expect(await injectPending("msg-loop-1")).not.toContain("Stagnation recovery")

    await hooks.event?.({ event: { type: "message.updated", properties: { info: { sessionID: "session-loop", role: "assistant", finish: "stop" } } } } as any)
    await hooks.event?.({ event: { type: "session.status", properties: { sessionID: "session-loop", status: { type: "idle" } } } } as any)
    expect(prompts).toHaveLength(2)
    expect(await injectPending("msg-loop-2")).not.toContain("Stagnation recovery")

    await hooks.event?.({ event: { type: "message.updated", properties: { info: { sessionID: "session-loop", role: "assistant", finish: "stop" } } } } as any)
    await hooks.event?.({ event: { type: "session.status", properties: { sessionID: "session-loop", status: { type: "idle" } } } } as any)
    expect(prompts).toHaveLength(3)
    expect(await injectPending("msg-loop-3")).toContain("Stagnation recovery")

    await hooks.event?.({ event: { type: "message.updated", properties: { info: { sessionID: "session-loop", role: "assistant", finish: "stop" } } } } as any)
    await hooks.event?.({ event: { type: "session.status", properties: { sessionID: "session-loop", status: { type: "idle" } } } } as any)
    expect(prompts).toHaveLength(4)
    expect(await injectPending("msg-loop-4")).toContain("Stagnation recovery")
    expect(toasts.some((toast) => toast.message.includes("Goal paused because recovery continuation stopped without taking action"))).toBe(false)

    await expect(hooks["command.execute.before"]?.({ command: "goal", sessionID: "session-loop", arguments: "" }, { parts: [] })).rejects.toThrow("__GOAL_HANDLED__")
    expect(toasts.at(-1)?.message).toContain("Status: active")
  })

  test("persists goals per session and restores them after plugin restart", async () => {
    const firstClient = {
      tui: { showToast: async () => undefined },
      session: {
        messages: async () => [],
        prompt: async () => undefined,
      },
    }

    const firstHooks = await GoalPlugin({ client: firstClient } as any)
    await expect(firstHooks["command.execute.before"]?.({ command: "goal", sessionID: "persisted-session", arguments: "survive restarts" }, { parts: [] })).rejects.toThrow(
      "__GOAL_HANDLED__",
    )

    const saved = JSON.parse(await readFile(stateFile, "utf8"))
    expect(saved["persisted-session"]).toMatchObject({ objective: "survive restarts", status: "active" })
    saved["persisted-session"].activeStartedAt = Date.now() - 3_600_000
    await writeFile(stateFile, `${JSON.stringify(saved)}\n`, "utf8")

    const toasts: any[] = []
    const secondClient = {
      tui: { showToast: async (input: any) => void toasts.push(input.body) },
      session: {
        messages: async () => [],
        prompt: async () => undefined,
      },
    }

    const secondHooks = await GoalPlugin({ client: secondClient } as any)
    await expect(secondHooks["command.execute.before"]?.({ command: "goal", sessionID: "persisted-session", arguments: "" }, { parts: [] })).rejects.toThrow(
      "__GOAL_HANDLED__",
    )

    expect(toasts.at(-1)?.message).toContain("Status: active")
    expect(toasts.at(-1)?.message).toContain("Objective: survive restarts")
    expect(toasts.at(-1)?.message).toContain("Time used: 0s")
  })

  test("/goal clear removes the current goal", async () => {
    const toasts: any[] = []
    const client = {
      tui: { showToast: async (input: any) => void toasts.push(input.body) },
      session: {
        messages: async () => [],
        prompt: async () => undefined,
      },
    }

    const hooks = await GoalPlugin({ client } as any)
    await expect(hooks["command.execute.before"]?.({ command: "goal", sessionID: "clear-session", arguments: "temporary goal" }, { parts: [] })).rejects.toThrow(
      "__GOAL_HANDLED__",
    )
    await expect(hooks["command.execute.before"]?.({ command: "goal", sessionID: "clear-session", arguments: "clear" }, { parts: [] })).rejects.toThrow("__GOAL_HANDLED__")

    expect(JSON.parse(await readFile(stateFile, "utf8"))["clear-session"]).toBeUndefined()
    expect(toasts.at(-1)?.message).toContain("Goal cleared")
    expect(toasts.at(-1)?.message).toContain("No goal is currently set")
  })

  test("updates and appends goals without resetting stats", async () => {
    const prompts: any[] = []
    const toasts: any[] = []
    const startedAt = Date.now()
    await writeFile(
      stateFile,
      `${JSON.stringify({
        "session-stats": {
          objective: "keep existing work",
          status: "active",
          createdAt: 1_000,
          updatedAt: 2_000,
          activeStartedAt: startedAt,
          timeUsedSeconds: 45,
        },
      })}\n`,
      "utf8",
    )

    const client = {
      tui: { showToast: async (input: any) => void toasts.push(input.body) },
      session: {
        messages: async () => [],
        prompt: async (input: any) => void prompts.push(input),
      },
    }

    const hooks = await GoalPlugin({ client } as any)
    await expect(hooks["command.execute.before"]?.({ command: "goal", sessionID: "session-stats", arguments: "replace the words" }, { parts: [] })).rejects.toThrow(
      "__GOAL_HANDLED__",
    )
    const updated = JSON.parse(await readFile(stateFile, "utf8"))["session-stats"]
    await expect(hooks["command.execute.before"]?.({ command: "goal", sessionID: "session-stats", arguments: "append and keep more context" }, { parts: [] })).rejects.toThrow(
      "__GOAL_HANDLED__",
    )

    const saved = JSON.parse(await readFile(stateFile, "utf8"))["session-stats"]
    expect(saved).toMatchObject({ objective: "replace the words\nand keep more context", status: "active", createdAt: 1_000 })
    expect(saved.activeStartedAt).toBeGreaterThanOrEqual(updated.activeStartedAt)
    expect(saved.timeUsedSeconds).toBeGreaterThanOrEqual(45)
    expect(toasts.at(-1)?.message).toContain("Goal appended")
    expect(prompts).toHaveLength(2)
  })

  test("set append and resume restart completed goals", async () => {
    const prompts: any[] = []
    const toasts: any[] = []
    await writeFile(
      stateFile,
      `${JSON.stringify({
        "session-set": {
          objective: "finished set",
          status: "complete",
          createdAt: 1_000,
          updatedAt: 2_000,
          activeStartedAt: null,
          timeUsedSeconds: 45,
        },
        "session-append": {
          objective: "finished append",
          status: "complete",
          createdAt: 1_000,
          updatedAt: 2_000,
          activeStartedAt: null,
          timeUsedSeconds: 45,
        },
        "session-resume": {
          objective: "finished resume",
          status: "complete",
          createdAt: 1_000,
          updatedAt: 2_000,
          activeStartedAt: null,
          timeUsedSeconds: 45,
        },
      })}\n`,
      "utf8",
    )

    const client = {
      tui: { showToast: async (input: any) => void toasts.push(input.body) },
      session: {
        messages: async () => [],
        prompt: async (input: any) => void prompts.push(input),
      },
    }

    const hooks = await GoalPlugin({ client } as any)
    await expect(hooks["command.execute.before"]?.({ command: "goal", sessionID: "session-set", arguments: "new work" }, { parts: [] })).rejects.toThrow("__GOAL_HANDLED__")
    await expect(hooks["command.execute.before"]?.({ command: "goal", sessionID: "session-append", arguments: "append more work" }, { parts: [] })).rejects.toThrow(
      "__GOAL_HANDLED__",
    )
    await expect(hooks["command.execute.before"]?.({ command: "goal", sessionID: "session-resume", arguments: "resume" }, { parts: [] })).rejects.toThrow(
      "__GOAL_HANDLED__",
    )

    const saved = JSON.parse(await readFile(stateFile, "utf8"))
    expect(saved["session-set"]).toMatchObject({ objective: "new work", status: "active", createdAt: 1_000, timeUsedSeconds: 45 })
    expect(saved["session-append"]).toMatchObject({ objective: "finished append\nmore work", status: "active", createdAt: 1_000, timeUsedSeconds: 45 })
    expect(saved["session-resume"]).toMatchObject({ objective: "finished resume", status: "active", createdAt: 1_000, timeUsedSeconds: 45 })
    expect(saved["session-set"].activeStartedAt).toBeNumber()
    expect(saved["session-append"].activeStartedAt).toBeNumber()
    expect(saved["session-resume"].activeStartedAt).toBeNumber()
    expect(prompts).toHaveLength(3)
    expect(toasts.at(-1)?.message).toContain("Goal active")
  })
})
