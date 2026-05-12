import { describe, expect, test } from "bun:test"
import { parseGoalCommand } from "../src/core"

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

  test("parses append commands", () => {
    expect(parseGoalCommand("append document the edge case")).toEqual({ kind: "append", objective: "document the edge case" })
    expect(parseGoalCommand(" APPEND   keep the stats ")).toEqual({ kind: "append", objective: "keep the stats" })
    expect(parseGoalCommand("append")).toEqual({ kind: "append", objective: "" })
  })
})
