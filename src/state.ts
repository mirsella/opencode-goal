import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

export type GoalStatus = "active" | "paused" | "complete"

export type GoalState = {
  objective: string
  status: GoalStatus
  createdAt: number
  updatedAt: number
  activeStartedAt: number | null
  timeUsedSeconds: number
  pendingContinuation?: boolean
}

type StateFile = {
  version: 1
  sessions: Record<string, GoalState>
}

const emptyState = (): StateFile => ({ version: 1, sessions: {} })
const cloneGoal = (goal: GoalState): GoalState => ({ ...goal })

export function defaultStateFile(): string {
  return join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "opencode-goal", "state.json")
}

export function accounted(goal: GoalState, now = Date.now()): GoalState {
  if (goal.status !== "active" || goal.activeStartedAt === null) return cloneGoal(goal)

  const elapsed = Math.max(0, Math.floor((now - goal.activeStartedAt) / 1000))
  return {
    ...goal,
    activeStartedAt: now,
    timeUsedSeconds: goal.timeUsedSeconds + elapsed,
    updatedAt: now,
  }
}

function validGoal(value: unknown): value is GoalState {
  if (!value || typeof value !== "object") return false
  const goal = value as GoalState
  return (
    typeof goal.objective === "string" &&
    (goal.status === "active" || goal.status === "paused" || goal.status === "complete") &&
    typeof goal.createdAt === "number" &&
    typeof goal.updatedAt === "number" &&
    (typeof goal.activeStartedAt === "number" || goal.activeStartedAt === null) &&
    typeof goal.timeUsedSeconds === "number" &&
    (goal.pendingContinuation === undefined || typeof goal.pendingContinuation === "boolean")
  )
}

function parseState(raw: string): StateFile {
  const parsed = JSON.parse(raw) as Partial<StateFile>
  if (parsed.version !== 1 || !parsed.sessions || typeof parsed.sessions !== "object") {
    console.warn("GoalPlugin state file has unexpected shape; starting with empty state")
    return emptyState()
  }

  const sessions: Record<string, GoalState> = {}
  for (const [sessionID, goal] of Object.entries(parsed.sessions)) {
    if (validGoal(goal)) {
      sessions[sessionID] = cloneGoal(goal)
      continue
    }
    console.warn("GoalPlugin skipped invalid persisted goal state", { sessionID })
  }
  return { version: 1, sessions }
}

export class GoalStore {
  #state: StateFile | undefined
  #writeQueue = Promise.resolve()

  constructor(readonly file = defaultStateFile()) {}

  async load(): Promise<StateFile> {
    if (this.#state) return this.#state
    try {
      this.#state = parseState(await readFile(this.file, "utf8"))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn("GoalPlugin failed to read state file; starting with empty state", error)
      }
      this.#state = emptyState()
    }
    return this.#state
  }

  async get(sessionID: string): Promise<GoalState | undefined> {
    const goal = (await this.load()).sessions[sessionID]
    return goal ? cloneGoal(goal) : undefined
  }

  async update<T>(sessionID: string, updater: (goal: GoalState | undefined) => { goal?: GoalState | null; result: T }): Promise<T> {
    const run = async () => {
      const state = await this.load()
      const { goal, result } = updater(state.sessions[sessionID] ? cloneGoal(state.sessions[sessionID]) : undefined)
      if (goal === null) delete state.sessions[sessionID]
      else if (goal) state.sessions[sessionID] = cloneGoal(goal)

      await this.#save(state)
      return result
    }

    const next = this.#writeQueue.then(run, run)
    this.#writeQueue = next.then(() => undefined, () => undefined)
    return next
  }

  async #save(state: StateFile): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true })
    const temp = `${this.file}.${process.pid}.${Date.now()}.tmp`
    await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, "utf8")
    await rename(temp, this.file)
  }
}
