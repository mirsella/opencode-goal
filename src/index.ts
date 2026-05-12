import { createHash } from "node:crypto"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { tool, type Plugin } from "@opencode-ai/plugin"
import type { Message, Part, TextPart } from "@opencode-ai/sdk"
import { NO_GOAL, accounted, commandHints, formatElapsed, formatGoalSummary, parseGoalCommand, renderContinuationPrompt, type ContinuationMode, type GoalCommand, type GoalState } from "./core"

const HANDLED = "__GOAL_HANDLED__"
const TRIGGER_TEXT = "Continue working toward the active goal."
const TRIGGER_METADATA = "opencode-goal-continuation-trigger"
const START_DEBOUNCE_MS = 750
const RECOVERY_STAGNANT_CONTINUATIONS = 2
const MAX_STAGNANT_CONTINUATIONS = 3
const STATE_FILE_ENV = "OPENCODE_GOAL_STATE_FILE"

type Model = { providerID: string; modelID: string }
type Info = { agent: string; model?: Model; variant?: string; controls?: string[]; fast?: boolean }
type SessionMessage = { info: Message & Record<string, unknown>; parts: Part[] }
type PendingContinuation = { sessionID: string; startedAt: number; mode: ContinuationMode; messageID?: string }
type MutatingCommand = Exclude<GoalCommand, { kind: "show" }> | { kind: "complete" }
type Result = { ok: boolean; message: string; goal?: GoalState }

const z = tool.schema

const stableID = (prefix: string, seed: string) => `${prefix}_${createHash("sha256").update(seed).digest("hex").slice(0, 16)}`

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)

const isGoalStatus = (value: unknown): value is GoalState["status"] => value === "active" || value === "paused" || value === "complete"

const isNonNegativeNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0

function parseGoalState(sessionID: string, value: unknown): GoalState | undefined {
  const invalid = (reason: string) => {
    console.warn(`GoalPlugin skipped invalid persisted goal: ${reason}`, { sessionID })
    return undefined
  }

  if (!isRecord(value)) return invalid("not an object")

  const { objective, status, createdAt, updatedAt, activeStartedAt, timeUsedSeconds } = value
  if (typeof objective !== "string" || !objective.trim()) return invalid("objective is empty or malformed")
  if (!isGoalStatus(status)) return invalid("status is malformed")
  if (!isNonNegativeNumber(createdAt) || !isNonNegativeNumber(updatedAt) || !isNonNegativeNumber(timeUsedSeconds)) return invalid("timestamps or elapsed time are malformed")
  if (activeStartedAt !== null && !isNonNegativeNumber(activeStartedAt)) return invalid("activeStartedAt is malformed")
  if (status === "active" && activeStartedAt === null) return invalid("active goal has no activeStartedAt")
  if (status !== "active" && activeStartedAt !== null) return invalid("inactive goal has activeStartedAt")

  return { objective, status, createdAt, updatedAt, activeStartedAt, timeUsedSeconds }
}

async function loadGoals(stateFile: string, now = Date.now()): Promise<Map<string, GoalState>> {
  let raw: string
  try {
    raw = await readFile(stateFile, "utf8")
  } catch (error) {
    if ((error as { code?: string }).code !== "ENOENT") console.warn("GoalPlugin could not read persisted goal state", { stateFile, error })
    return new Map()
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    console.warn("GoalPlugin ignored corrupt persisted goal state", { stateFile, error })
    return new Map()
  }

  if (!isRecord(parsed)) {
    console.warn("GoalPlugin ignored unsupported persisted goal state", { stateFile })
    return new Map()
  }

  const goals = new Map<string, GoalState>()
  for (const [sessionID, value] of Object.entries(parsed)) {
    const goal = parseGoalState(sessionID, value)
    if (goal) goals.set(sessionID, goal.status === "active" ? { ...goal, activeStartedAt: now } : goal)
  }
  return goals
}

async function saveGoals(stateFile: string, goals: Map<string, GoalState>): Promise<void> {
  const state = Object.fromEntries([...goals.entries()].sort(([a], [b]) => a.localeCompare(b)))
  await mkdir(dirname(stateFile), { recursive: true })
  const tmp = `${stateFile}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8")
  await rename(tmp, stateFile)
}

function defaultStateFile(scope: string): string {
  const root = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state")
  return join(root, "opencode-goal", stableID("scope", scope), "sessions.json")
}

const isTextPart = (part: Part): part is TextPart => part.type === "text"

const sessionIDOf = (message: SessionMessage) => message.info.sessionID

const messageIDOf = (message: SessionMessage) => message.info.id

const roleOf = (message: SessionMessage) => message.info.role

const partMetadata = (part: Part) => (part as { metadata?: Record<string, unknown> }).metadata

const isGoalTriggerPart = (part: Part) => {
  if (!isTextPart(part)) return false
  return part.text === TRIGGER_TEXT || partMetadata(part)?.goal === TRIGGER_METADATA
}

const hasUsableContent = (message: SessionMessage) => message.parts.some((part) => isTextPart(part) && !part.ignored)

function createSyntheticTextPart(message: SessionMessage, text: string, seed: string): TextPart {
  return {
    id: stableID("prt_goal", seed),
    sessionID: sessionIDOf(message),
    messageID: messageIDOf(message),
    type: "text",
    text,
    synthetic: true,
    metadata: { goal: "continuation-prompt" },
  }
}

function appendToLastTextPart(message: SessionMessage, text: string, seed: string): boolean {
  for (let i = message.parts.length - 1; i >= 0; i--) {
    const part = message.parts[i]
    if (!part || !isTextPart(part) || part.ignored) continue

    const base = part.text.replace(/\n*$/, "")
    part.text = base ? `${base}\n\n${text}` : text
    part.synthetic = true
    part.metadata = { ...(part.metadata ?? {}), goal: "continuation-prompt" }
    return true
  }

  message.parts.push(createSyntheticTextPart(message, text, seed))
  return true
}

function replaceTriggerWithPrompt(message: SessionMessage, text: string, seed: string): void {
  const existing = message.parts.find(isTextPart)
  if (!existing) {
    message.parts.push(createSyntheticTextPart(message, text, seed))
    return
  }

  existing.text = text
  existing.synthetic = true
  existing.ignored = false
  existing.metadata = { ...(existing.metadata ?? {}), goal: "continuation-prompt" }
}

function findTriggerMessage(messages: SessionMessage[], pending: PendingContinuation, triggerMessages: Map<string, string>) {
  return messages.find((message) => {
    if (sessionIDOf(message) !== pending.sessionID) return false
    const id = messageIDOf(message)
    return id === pending.messageID || triggerMessages.get(id) === pending.sessionID || message.parts.some(isGoalTriggerPart)
  })
}

function findAnchorMessage(messages: SessionMessage[], sessionID: string, hidden: Set<string>) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (!message || sessionIDOf(message) !== sessionID || hidden.has(messageIDOf(message))) continue
    if (roleOf(message) !== "user" || !hasUsableContent(message)) continue
    return message
  }
  return undefined
}

function planLike(info: Info | undefined): boolean {
  if (!info) return false
  if (info.agent.toLowerCase() === "plan") return true
  if (info.variant?.toLowerCase().includes("plan")) return true
  return info.controls?.some((control) => control.toLowerCase().includes("plan")) ?? false
}

function makeInfo(input: { agent: string; model?: Model | undefined; variant?: string | undefined; controls?: string[] | undefined; fast?: boolean | undefined }): Info {
  return {
    agent: input.agent,
    ...(input.model ? { model: input.model } : {}),
    ...(input.variant ? { variant: input.variant } : {}),
    ...(input.controls ? { controls: input.controls } : {}),
    ...(input.fast !== undefined ? { fast: input.fast } : {}),
  }
}

function commandResult(message: string, goal?: GoalState) {
  return goal ? `${message}\n\n${formatGoalSummary(goal)}` : message
}

export const GoalPlugin: Plugin = async ({ client, directory, worktree }) => {
  const stateFile = process.env[STATE_FILE_ENV] || defaultStateFile(String(worktree ?? directory ?? process.cwd()))
  const goals = await loadGoals(stateFile)
  const hidden = new Set<string>()
  const inFlight = new Set<string>()
  const pending = new Map<string, PendingContinuation>()
  const triggerMessages = new Map<string, string>()
  const lastStarted = new Map<string, number>()
  const lastAssistantFinish = new Map<string, string>()
  const stagnantStops = new Map<string, number>()

  const toast = (message: string, variant: "info" | "error" = "info", duration = 5000) =>
    client.tui.showToast({ body: { message, variant, duration } }).catch(() => undefined)

  const stop = async (message: string, variant: "info" | "error" = "info"): Promise<never> => {
    await toast(message, variant)
    throw new Error(HANDLED)
  }

  const getGoal = (sessionID: string) => goals.get(sessionID)
  const putGoal = (sessionID: string, goal: GoalState | null) => (goal ? goals.set(sessionID, goal) : goals.delete(sessionID))
  const clearContinuation = (sessionID: string) => {
    pending.delete(sessionID)
    inFlight.delete(sessionID)
  }
  const resetContinuationState = (sessionID: string) => {
    clearContinuation(sessionID)
    stagnantStops.delete(sessionID)
  }

  let persistQueue = Promise.resolve()
  const persistGoals = async () => {
    const snapshot = new Map(goals)
    persistQueue = persistQueue.catch(() => undefined).then(() => saveGoals(stateFile, snapshot))
    try {
      await persistQueue
    } catch (error) {
      console.error("GoalPlugin failed to persist goal state", { stateFile, error })
      await toast(`Goal state could not be saved: ${error instanceof Error ? error.message : String(error)}`, "error", 8000)
    }
  }

  const mutate = async (sessionID: string, op: MutatingCommand, now = Date.now()): Promise<Result> => {
    const goal = getGoal(sessionID)
    const fail = (message: string) => ({ ok: false, message })
    const save = async (message: string, nextGoal: GoalState | null): Promise<Result> => {
      putGoal(sessionID, nextGoal)
      await persistGoals()
      return nextGoal ? { ok: true, message, goal: nextGoal } : { ok: true, message }
    }
    const emptyObjective = () => {
      console.warn(`GoalPlugin refused to ${op.kind} an empty objective`, { sessionID })
      return fail(op.kind === "append" ? "Usage: /goal append <text>" : "Usage: /goal <objective>")
    }
    const missingGoal = (message: string) => {
      console.warn(`GoalPlugin cannot ${op.kind} a missing goal`, { sessionID })
      return fail(message)
    }

    switch (op.kind) {
      case "set": {
        const objective = op.objective.trim()
        if (!objective) return emptyObjective()
        return save(
          goal ? "Goal updated" : "Goal active",
          goal ? { ...goal, objective, updatedAt: now } : { objective, status: "active", createdAt: now, updatedAt: now, activeStartedAt: now, timeUsedSeconds: 0 },
        )
      }

      case "append": {
        const addition = op.objective.trim()
        if (!addition) return emptyObjective()
        if (!goal) return missingGoal("No goal to append")
        return save("Goal appended", { ...goal, objective: `${goal.objective}\n${addition}`, updatedAt: now })
      }

      case "clear":
        if (!goal) return missingGoal("No goal to clear")
        return save("Goal cleared", null)

      case "pause":
        if (!goal) return missingGoal("No goal to pause")
        if (goal.status !== "active") {
          console.warn("GoalPlugin cannot pause a non-active goal", { sessionID, status: goal.status })
          return fail(`Goal is ${goal.status}`)
        }
        return save("Goal paused", { ...accounted(goal, now), status: "paused", activeStartedAt: null, updatedAt: now })

      case "resume":
        if (!goal) return missingGoal("No goal to resume")
        if (goal.status !== "paused") {
          console.warn("GoalPlugin cannot resume a non-paused goal", { sessionID, status: goal.status })
          return fail(`Goal is ${goal.status}`)
        }
        return save("Goal active", { ...goal, status: "active", activeStartedAt: now, updatedAt: now })

      case "complete":
        if (!goal) return missingGoal("No active goal to complete")
        return goal.status === "complete" ? save("Goal already complete", goal) : save("Goal complete", { ...accounted(goal, now), status: "complete", activeStartedAt: null, updatedAt: now })
      }
  }

  const latest = async (sessionID: string): Promise<Info | undefined> => {
    const result = await client.session.messages({ path: { id: sessionID }, query: { limit: 100 } }).catch((error) => {
      console.warn("GoalPlugin could not inspect session messages for continuation metadata", error)
      return []
    })

    const messages = (Array.isArray(result) ? result : ((result as { data?: unknown[] }).data ?? [])) as Array<{ info?: Record<string, unknown> }>
    return [...messages].reverse().flatMap((message): Info[] => {
      const info = message.info
      if (!info) return []

      const controls = Array.isArray(info.controls) ? info.controls.filter((item): item is string => typeof item === "string") : undefined
      const variant = typeof info.variant === "string" ? info.variant : undefined
      const fast = typeof info.fast === "boolean" ? info.fast : undefined

      if (info.role === "user" && typeof info.agent === "string") {
        const model = info.model as Model | undefined
        return [makeInfo({ agent: info.agent, model, variant, controls, fast })]
      }

      if (info.role === "assistant" && (typeof info.agent === "string" || typeof info.mode === "string") && typeof info.providerID === "string" && typeof info.modelID === "string") {
        return [makeInfo({ agent: (info.agent as string | undefined) ?? (info.mode as string), model: { providerID: info.providerID, modelID: info.modelID }, variant, controls, fast })]
      }

      return []
    })[0]
  }

  const startContinuation = async (sessionID: string, options?: { ignoreDebounce?: boolean; mode?: ContinuationMode }) => {
    const now = Date.now()
    if (pending.has(sessionID)) return
    if (!options?.ignoreDebounce && now - (lastStarted.get(sessionID) ?? 0) < START_DEBOUNCE_MS) return

    const goal = getGoal(sessionID)
    if (!goal || goal.status !== "active") return
    putGoal(sessionID, accounted(goal, now))
    await persistGoals()

    const info = await latest(sessionID)
    if (planLike(info)) {
      pending.delete(sessionID)
      await toast("Goal continuation skipped in plan mode")
      return
    }

    if (!info) console.warn("GoalPlugin fell back to the build agent because the session has no message metadata", { sessionID })

    pending.set(sessionID, { sessionID, startedAt: now, mode: options?.mode ?? "normal" })
    inFlight.add(sessionID)
    lastStarted.set(sessionID, now)

    const body = {
      agent: info?.agent ?? "build",
      ...(info?.model ? { model: info.model } : {}),
      ...(info?.variant ? { variant: info.variant } : {}),
      ...(info?.controls ? { controls: info.controls } : {}),
      ...(info?.fast !== undefined ? { fast: info.fast } : {}),
      parts: [
        {
          type: "text",
          text: TRIGGER_TEXT,
          synthetic: true,
          ignored: true,
          metadata: { goal: TRIGGER_METADATA },
        },
      ],
    }

    await client.session.prompt({ path: { id: sessionID }, body: body as any }).catch(async (error) => {
      console.error("GoalPlugin failed to start goal continuation", error)
      pending.delete(sessionID)
      inFlight.delete(sessionID)
      await toast(`Goal continuation failed: ${error instanceof Error ? error.message : String(error)}`, "error")
    })
  }

  const injectContinuation = async (messages: SessionMessage[], continuation: PendingContinuation, injectedMessages: Set<string>) => {
    const goal = getGoal(continuation.sessionID)
    if (!goal || goal.status !== "active") {
      console.warn("GoalPlugin skipped continuation injection because no active goal exists", { sessionID: continuation.sessionID })
      pending.delete(continuation.sessionID)
      inFlight.delete(continuation.sessionID)
      return
    }

    const current = accounted(goal)
    const rendered = renderContinuationPrompt({ objective: current.objective, timeUsedSeconds: current.timeUsedSeconds, mode: continuation.mode })
    const seed = `${continuation.sessionID}:${continuation.startedAt}`
    const trigger = findTriggerMessage(messages, continuation, triggerMessages)

    if (trigger) {
      replaceTriggerWithPrompt(trigger, rendered, seed)
      injectedMessages.add(messageIDOf(trigger))
      pending.delete(continuation.sessionID)
      return
    }

    const anchor = findAnchorMessage(messages, continuation.sessionID, hidden)
    if (anchor) {
      appendToLastTextPart(anchor, rendered, seed)
      pending.delete(continuation.sessionID)
      return
    }

    console.warn("GoalPlugin skipped continuation because no safe message anchor was found", { sessionID: continuation.sessionID })
    pending.delete(continuation.sessionID)
    inFlight.delete(continuation.sessionID)
  }

  return {
    config: async (cfg) => {
      cfg.command ??= {}
      cfg.command.goal = { template: "", description: "set or view the goal for a long-running task" }
    },

    tool: {
      update_goal: tool({
        description: "Mark the active /goal objective complete after verifying every requirement is satisfied.",
        args: {
          status: z.literal("complete"),
        },
        execute: async (_args, context) => {
          const result = await mutate(context.sessionID, { kind: "complete" })
          resetContinuationState(context.sessionID)

          if (!result.ok || !result.goal) return result.message
          return `${result.message}. Final elapsed time: ${formatElapsed(result.goal.timeUsedSeconds)}. ${commandHints(result.goal.status)}`
        },
      }),
    },

    event: async ({ event }) => {
      if (event.type === "message.updated") {
        const info = (event.properties as { info?: Message }).info
        if (info?.role === "assistant" && typeof info.finish === "string") {
          lastAssistantFinish.set(info.sessionID, info.finish)
          if (info.finish !== "stop") stagnantStops.delete(info.sessionID)
        }

        if (info?.role === "assistant" && info.error?.name === "MessageAbortedError") {
          const sessionID = info.sessionID
          const goal = getGoal(sessionID)
          if (goal?.status !== "active") return

          const result = await mutate(sessionID, { kind: "pause" })
          clearContinuation(sessionID)
          if (result.ok) {
            await toast(commandResult("Goal paused after interrupt", result.goal))
          }
        }
        return
      }

      if (event.type !== "session.status") return

      const properties = event.properties as { sessionID?: string; status?: { type?: string } }
      const sessionID = properties.sessionID
      if (!sessionID) {
        console.warn("GoalPlugin received session.status without a sessionID")
        return
      }

      if (properties.status?.type !== "idle") {
        return
      }

      if (pending.has(sessionID)) return
      const wasInFlight = inFlight.delete(sessionID)

      const goal = getGoal(sessionID)
      if (!goal || goal.status !== "active") return

      if (wasInFlight && lastAssistantFinish.get(sessionID) === "stop") {
        const stops = (stagnantStops.get(sessionID) ?? 0) + 1
        stagnantStops.set(sessionID, stops)
        if (stops >= MAX_STAGNANT_CONTINUATIONS) {
          const result = await mutate(sessionID, { kind: "pause" })
          clearContinuation(sessionID)
          if (result.ok) {
            await toast(commandResult("Goal paused because recovery continuation stopped without taking action", result.goal), "error", 8000)
          }
          return
        }
      }

      await startContinuation(sessionID, { ignoreDebounce: wasInFlight, mode: (stagnantStops.get(sessionID) ?? 0) >= RECOVERY_STAGNANT_CONTINUATIONS ? "recovery" : "normal" })
    },

    "command.execute.before": async (input) => {
      if (input.command !== "goal") return

      const sessionID = input.sessionID
      const op = parseGoalCommand(input.arguments ?? "")

      if (op.kind === "show") {
        const goal = getGoal(sessionID)
        return stop(goal ? formatGoalSummary(goal) : NO_GOAL)
      }

      const editsObjective = op.kind === "set" || op.kind === "append"
      const startsNewGoal = op.kind === "set" && !getGoal(sessionID)
      const result = await mutate(sessionID, op)
      if (!editsObjective) resetContinuationState(sessionID)
      if (result.ok && (op.kind === "resume" || startsNewGoal)) await startContinuation(sessionID, { ignoreDebounce: true })

      const message = op.kind === "clear" ? `${result.message}\n${NO_GOAL}` : result.ok && result.goal ? commandResult(result.message, result.goal) : result.message
      return stop(message, result.ok ? "info" : "error")
    },

    "chat.message": async (input, output) => {
      const text = output.parts.find(isTextPart)
      if (!text || !isGoalTriggerPart(text)) return

      hidden.add(output.message.id)
      triggerMessages.set(output.message.id, input.sessionID)
      const continuation = pending.get(input.sessionID)
      if (continuation) continuation.messageID = output.message.id
      Object.assign(text, { text: "", synthetic: true, ignored: true })
    },

    "experimental.chat.messages.transform": async (_, output) => {
      const messages = output.messages as SessionMessage[]
      const injectedMessages = new Set<string>()
      const sessionIDs = new Set(messages.map(sessionIDOf))

      for (const continuation of [...pending.values()]) {
        if (!sessionIDs.has(continuation.sessionID)) continue
        await injectContinuation(messages, continuation, injectedMessages)
      }

      output.messages = messages.filter((message) => !hidden.has(messageIDOf(message)) || injectedMessages.has(messageIDOf(message)))
    },
  }
}

export default GoalPlugin
