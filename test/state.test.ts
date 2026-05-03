import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, describe, expect, test } from "bun:test"
import { accounted, GoalStore, type GoalState } from "../src/state"

const dirs: string[] = []

async function store() {
  const dir = await mkdtemp(join(tmpdir(), "opencode-goal-test-"))
  dirs.push(dir)
  return new GoalStore(join(dir, "state.json"))
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe("GoalStore", () => {
  test("updates and accounts elapsed active time", async () => {
    const goals = await store()
    const active: GoalState = { objective: "finish task", status: "active", createdAt: 1_000, updatedAt: 1_000, activeStartedAt: 1_000, timeUsedSeconds: 0 }

    await goals.update("s1", () => ({ goal: active, result: undefined }))
    await goals.update("s1", (goal) => ({ goal: goal ? { ...accounted(goal, 61_000), status: "paused", activeStartedAt: null } : null, result: undefined }))

    expect(await goals.get("s1")).toMatchObject({ status: "paused", timeUsedSeconds: 60, activeStartedAt: null })
  })

  test("persists state", async () => {
    const first = await store()
    await first.update("s1", () => ({ goal: { objective: "persist me", status: "active", createdAt: 1_000, updatedAt: 1_000, activeStartedAt: 1_000, timeUsedSeconds: 0 }, result: undefined }))

    const second = new GoalStore(first.file)
    expect((await second.get("s1"))?.objective).toBe("persist me")
  })

  test("removes goals", async () => {
    const goals = await store()
    await goals.update("s1", () => ({ goal: { objective: "remove me", status: "paused", createdAt: 1, updatedAt: 1, activeStartedAt: null, timeUsedSeconds: 0 }, result: undefined }))
    await goals.update("s1", () => ({ goal: null, result: undefined }))
    expect(await goals.get("s1")).toBeUndefined()
  })
})
