import { createHash } from "node:crypto"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { tool, type Plugin } from "@opencode-ai/plugin"
import type { Message, Part, TextPart } from "@opencode-ai/sdk"
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse"
import { NO_GOAL, accounted, commandHints, formatElapsed, formatGoalSummary, parseGoalCommand, renderContinuationPrompt, type ContinuationMode, type GoalCommand, type GoalState } from "./core"

const TRIGGER_TEXT = "Continue working toward the active goal."
const TRIGGER_METADATA = "opencode-goal-continuation-trigger"
const START_DEBOUNCE_MS = 750
const RECOVERY_STAGNANT_CONTINUATIONS = 2
const STATE_FILE_ENV = "OPENCODE_GOAL_STATE_FILE"

type Model = { providerID: string; modelID: string }
type PromptInfo = { agent?: string; model?: Model; variant?: string; controls?: string[]; fast?: boolean }
type PromptInfoUpdate = Omit<PromptInfo, "variant"> & { variant?: string | null }
type SessionMessage = { info: Message & Record<string, unknown>; parts: Part[] }
type PendingContinuation = { sessionID: string; startedAt: number; mode: ContinuationMode; messageID?: string }
type MutatingCommand = Exclude<GoalCommand, { kind: "show" }> | { kind: "complete" }
type ContinuationEffect = "keep" | "clear" | "restart"
type Result = ({ ok: true; message: string; goal?: GoalState } | { ok: false; message: string }) & { continuation: ContinuationEffect }

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

function planLike(info: PromptInfo | undefined): boolean {
  if (!info) return false
  if (info.agent?.toLowerCase() === "plan") return true
  if (info.variant?.toLowerCase().includes("plan")) return true
  return info.controls?.some((control) => control.toLowerCase().includes("plan")) ?? false
}

function promptInfoFromModel(value: unknown): PromptInfoUpdate {
  if (!isRecord(value)) return {}

  const providerID = typeof value.providerID === "string" ? value.providerID : undefined
  const modelID = typeof value.modelID === "string" ? value.modelID : typeof value.id === "string" ? value.id : undefined
  if (!providerID || !modelID) return {}

  return {
    model: { providerID, modelID },
    ...(typeof value.variant === "string" ? { variant: value.variant || null } : {}),
  }
}

function promptInfoFromMessage(info: Record<string, unknown>): PromptInfo | undefined {
  const controls = Array.isArray(info.controls) ? info.controls.filter((item): item is string => typeof item === "string") : undefined
  const fast = typeof info.fast === "boolean" ? info.fast : undefined
  const variant = typeof info.variant === "string" && info.variant ? info.variant : undefined
  const common = {
    ...(controls ? { controls } : {}),
    ...(fast !== undefined ? { fast } : {}),
  }

  if (info.role === "user" && typeof info.agent === "string") {
    const modelInfo = promptInfoFromModel(info.model)
    const selectedVariant = variant ?? (modelInfo.variant || undefined)
    return {
      ...common,
      agent: info.agent,
      ...(modelInfo.model ? { model: modelInfo.model } : {}),
      ...(selectedVariant ? { variant: selectedVariant } : {}),
    }
  }

  if (info.role === "assistant" && (typeof info.agent === "string" || typeof info.mode === "string") && typeof info.providerID === "string" && typeof info.modelID === "string") {
    return {
      ...common,
      agent: (info.agent as string | undefined) ?? (info.mode as string),
      model: { providerID: info.providerID, modelID: info.modelID },
      ...(variant ? { variant } : {}),
    }
  }

  return undefined
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
  const rememberedInfo = new Map<string, PromptInfo>()
  const lastStarted = new Map<string, number>()
  const lastAssistantFinish = new Map<string, string>()
  const stagnantStops = new Map<string, number>()

  const toast = (message: string, variant: "info" | "error" = "info", duration = 5000) =>
    client.tui.showToast({ body: { message, variant, duration } }).catch(() => undefined)

  const stop = async (message: string, variant: "info" | "error" = "info"): Promise<never> => {
    await toast(message, variant)
    // OpenCode command hooks cannot cancel the downstream LLM call directly.
    // Throwing this Effect response makes the command endpoint return a clean 204.
    throw HttpServerResponse.empty()
  }

  const getGoal = (sessionID: string) => goals.get(sessionID)
  const putGoal = (sessionID: string, goal: GoalState | null) => (goal ? goals.set(sessionID, goal) : goals.delete(sessionID))
  const rememberInfo = (sessionID: string, patch: PromptInfoUpdate) => {
    if (!Object.keys(patch).length) return

    const next = { ...(rememberedInfo.get(sessionID) ?? {}) }

    if (patch.agent !== undefined) {
      next.agent = patch.agent
    }
    if (patch.model !== undefined) {
      next.model = patch.model
    }
    if (patch.variant !== undefined) {
      if (patch.variant) next.variant = patch.variant
      else delete next.variant
    }
    if (patch.controls !== undefined) {
      next.controls = patch.controls
    }
    if (patch.fast !== undefined) {
      next.fast = patch.fast
    }

    rememberedInfo.set(sessionID, next)
  }
  const clearContinuation = (sessionID: string) => {
    pending.delete(sessionID)
    inFlight.delete(sessionID)
  }
  const resetContinuationState = (sessionID: string) => {
    clearContinuation(sessionID)
    stagnantStops.delete(sessionID)
  }

  const applyContinuationEffect = async (sessionID: string, effect: ContinuationEffect) => {
    if (effect === "keep") return
    resetContinuationState(sessionID)
    if (effect === "restart") await startContinuation(sessionID, { ignoreDebounce: true })
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
    const fail = (message: string, continuation: ContinuationEffect = "keep"): Result => ({ ok: false, message, continuation })
    const activate = (current: GoalState, objective = current.objective): GoalState => ({
      ...current,
      objective,
      status: "active",
      activeStartedAt: current.status === "active" ? current.activeStartedAt : now,
      updatedAt: now,
    })
    const save = async (message: string, nextGoal: GoalState | null, continuation: ContinuationEffect): Promise<Result> => {
      putGoal(sessionID, nextGoal)
      await persistGoals()
      return nextGoal ? { ok: true, message, goal: nextGoal, continuation } : { ok: true, message, continuation }
    }
    const emptyObjective = () => {
      console.warn(`GoalPlugin refused to ${op.kind} an empty objective`, { sessionID })
      return fail(op.kind === "append" ? "Usage: /goal append <text>" : "Usage: /goal <objective>")
    }
    const missingGoal = (message: string, continuation: ContinuationEffect = "keep") => {
      console.warn(`GoalPlugin cannot ${op.kind} a missing goal`, { sessionID })
      return fail(message, continuation)
    }

    switch (op.kind) {
      case "set": {
        const objective = op.objective.trim()
        if (!objective) return emptyObjective()
        return save(
          goal ? "Goal updated" : "Goal active",
          goal ? activate(goal, objective) : { objective, status: "active", createdAt: now, updatedAt: now, activeStartedAt: now, timeUsedSeconds: 0 },
          "restart",
        )
      }

      case "append": {
        const addition = op.objective.trim()
        if (!addition) return emptyObjective()
        if (!goal) return missingGoal("No goal to append")
        return save("Goal appended", activate(goal, `${goal.objective}\n${addition}`), "restart")
      }

      case "clear":
        if (!goal) return missingGoal("No goal to clear", "clear")
        return save("Goal cleared", null, "clear")

      case "pause":
        if (!goal) return missingGoal("No goal to pause", "clear")
        if (goal.status !== "active") {
          console.warn("GoalPlugin cannot pause a non-active goal", { sessionID, status: goal.status })
          return fail(`Goal is ${goal.status}`, "clear")
        }
        return save("Goal paused", { ...accounted(goal, now), status: "paused", activeStartedAt: null, updatedAt: now }, "clear")

      case "resume":
        if (!goal) return missingGoal("No goal to resume")
        if (goal.status === "active") {
          console.warn("GoalPlugin cannot resume an already-active goal", { sessionID, status: goal.status })
          return fail(`Goal is ${goal.status}`)
        }
        return save("Goal active", activate(goal), "restart")

      case "complete":
        if (!goal) return missingGoal("No active goal to complete", "clear")
        return goal.status === "complete"
          ? save("Goal already complete", goal, "clear")
          : save("Goal complete", { ...accounted(goal, now), status: "complete", activeStartedAt: null, updatedAt: now }, "clear")
      }
  }

  const latest = async (sessionID: string): Promise<PromptInfo | undefined> => {
    const result = await client.session.messages({ path: { id: sessionID }, query: { limit: 100 } }).catch((error) => {
      console.warn("GoalPlugin could not inspect session messages for continuation metadata", error)
      return []
    })

    const messages = (Array.isArray(result) ? result : ((result as { data?: unknown[] }).data ?? [])) as Array<{ info?: unknown }>
    return [...messages].reverse().flatMap((message): PromptInfo[] => {
      const info = message.info
      if (!isRecord(info)) return []
      const parsed = promptInfoFromMessage(info)
      return parsed ? [parsed] : []
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

    const info = (await latest(sessionID)) ?? rememberedInfo.get(sessionID)
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
          await applyContinuationEffect(context.sessionID, result.continuation)

          if (!result.ok || !result.goal) return result.message
          return `${result.message}. Final elapsed time: ${formatElapsed(result.goal.timeUsedSeconds)}. ${commandHints(result.goal.status)}`
        },
      }),
    },

    event: async ({ event }) => {
      const eventRecord = event as { type?: string; properties?: unknown; data?: unknown }
      const eventType = eventRecord.type
      const payload = isRecord(eventRecord.properties) ? eventRecord.properties : isRecord(eventRecord.data) ? eventRecord.data : undefined

      if (eventType === "session.next.agent.switched" || eventType === "session.next.model.switched" || eventType === "session.next.step.started") {
        if (!payload) {
          console.warn("GoalPlugin ignored prompt metadata event without object payload", { eventType })
          return
        }

        const sessionID = typeof payload.sessionID === "string" ? payload.sessionID : undefined
        if (!sessionID) {
          console.warn("GoalPlugin ignored prompt metadata event without a sessionID", { eventType })
          return
        }

        const modelInfo = promptInfoFromModel(payload.model)
        if (payload.model !== undefined && !modelInfo.model) console.warn("GoalPlugin ignored malformed prompt model metadata", { eventType, sessionID })

        rememberInfo(sessionID, {
          ...(typeof payload.agent === "string" ? { agent: payload.agent } : {}),
          ...modelInfo,
        })
        return
      }

      if (eventType === "message.updated") {
        const info = payload?.info
        if (!isRecord(info)) {
          console.warn("GoalPlugin ignored message.updated without message info")
          return
        }

        const sessionID = typeof info.sessionID === "string" ? info.sessionID : undefined
        if (sessionID) {
          const parsed = promptInfoFromMessage(info)
          if (parsed) rememberInfo(sessionID, parsed)
        }

        if (info.role === "assistant" && typeof info.finish === "string" && sessionID) {
          lastAssistantFinish.set(sessionID, info.finish)
          if (info.finish !== "stop") stagnantStops.delete(sessionID)
        }

        const error = isRecord(info.error) ? info.error : undefined
        if (info.role === "assistant" && error?.name === "MessageAbortedError" && sessionID) {
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

      if (eventType !== "session.status") return

      const sessionID = typeof payload?.sessionID === "string" ? payload.sessionID : undefined
      if (!sessionID) {
        console.warn("GoalPlugin received session.status without a sessionID")
        return
      }

      const status = isRecord(payload?.status) ? payload.status : undefined
      if (status?.type !== "idle") {
        return
      }

      if (pending.has(sessionID)) return
      const wasInFlight = inFlight.delete(sessionID)

      const goal = getGoal(sessionID)
      if (!goal || goal.status !== "active") return

      if (wasInFlight && lastAssistantFinish.get(sessionID) === "stop") {
        const stops = (stagnantStops.get(sessionID) ?? 0) + 1
        stagnantStops.set(sessionID, stops)
        if (stops >= RECOVERY_STAGNANT_CONTINUATIONS) {
          console.warn("GoalPlugin continuing active goal after stop-only continuation", { sessionID, stagnantStops: stops })
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

      const result = await mutate(sessionID, op)
      await applyContinuationEffect(sessionID, result.continuation)

      const message = op.kind === "clear" ? `${result.message}\n${NO_GOAL}` : result.ok && result.goal ? commandResult(result.message, result.goal) : result.message
      return stop(message, result.ok ? "info" : "error")
    },

    "chat.message": async (input, output) => {
      rememberInfo(input.sessionID, {
        ...(typeof input.agent === "string" ? { agent: input.agent } : {}),
        ...promptInfoFromModel(input.model),
        ...(typeof input.variant === "string" ? { variant: input.variant || null } : {}),
      })

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
