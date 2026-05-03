import { describe, expect, test } from "bun:test"
import { parseGoalCommand } from "../src/index"

describe("parseGoalCommand", () => {
  test("parses empty input as show", () => {
    expect(parseGoalCommand("   ")).toEqual({ kind: "show" })
  })

  test("parses control commands case-insensitively", () => {
    expect(parseGoalCommand("CLEAR")).toEqual({ kind: "clear" })
    expect(parseGoalCommand(" Pause ")).toEqual({ kind: "pause" })
    expect(parseGoalCommand("resume")).toEqual({ kind: "resume" })
  })

  test("preserves objective text", () => {
    expect(parseGoalCommand(" improve benchmark coverage ")).toEqual({ kind: "set", objective: "improve benchmark coverage" })
  })
})
