import { describe, expect, test } from "bun:test"
import { accounted, commandHints, formatElapsed, formatGoalSummary } from "../src/core"
import type { GoalState } from "../src/core"

describe("formatElapsed", () => {
  test.each([
    [0, "0s"],
    [59, "59s"],
    [60, "1m"],
    [30 * 60, "30m"],
    [90 * 60, "1h 30m"],
    [2 * 60 * 60, "2h"],
    [23 * 60 * 60 + 59 * 60, "23h 59m"],
    [24 * 60 * 60, "1d 0h 0m"],
    [2 * 24 * 60 * 60 + 23 * 60 * 60 + 42 * 60, "2d 23h 42m"],
  ])("formats %p seconds", (seconds, expected) => {
    expect(formatElapsed(seconds)).toBe(expected)
  })
})

describe("goal summary", () => {
  test("formats active goal summary", () => {
    const goal: GoalState = {
      objective: "ship it",
      status: "active",
      createdAt: 1_000,
      updatedAt: 1_000,
      activeStartedAt: 1_000,
      timeUsedSeconds: 60,
    }

    expect(formatGoalSummary(goal, 62_000)).toBe(["Goal", "Status: active", "Objective: ship it", "Time used: 2m", "", "Commands: /goal append <text>, /goal pause, /goal clear"].join("\n"))
  })

  test("formats command hints", () => {
    expect(commandHints("active")).toBe("Commands: /goal append <text>, /goal pause, /goal clear")
    expect(commandHints("paused")).toBe("Commands: /goal append <text>, /goal resume, /goal clear")
    expect(commandHints("complete")).toBe("Commands: /goal append <text>, /goal resume, /goal clear")
  })
})

describe("accounted", () => {
  test("adds active elapsed time", () => {
    const goal: GoalState = { objective: "ship it", status: "active", createdAt: 1_000, updatedAt: 1_000, activeStartedAt: 1_000, timeUsedSeconds: 10 }
    expect(accounted(goal, 61_000)).toMatchObject({ activeStartedAt: 61_000, timeUsedSeconds: 70, updatedAt: 61_000 })
  })
})
