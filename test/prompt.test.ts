import { describe, expect, test } from "bun:test"
import { escapeXml, renderContinuationPrompt } from "../src/index"

describe("escapeXml", () => {
  test("escapes XML-sensitive characters", () => {
    expect(escapeXml(`<tag a="b">Tom & 'Jerry'</tag>`)).toBe("&lt;tag a=&quot;b&quot;&gt;Tom &amp; &apos;Jerry&apos;&lt;/tag&gt;")
  })
})

describe("renderContinuationPrompt", () => {
  test("renders objective and omits token budget language", () => {
    const prompt = renderContinuationPrompt({ objective: "fix <bug>", timeUsedSeconds: 90 })

    expect(prompt).toContain("Continue working toward the active thread goal.")
    expect(prompt).toContain("fix &lt;bug&gt;")
    expect(prompt).toContain("Time used pursuing goal: 1m.")
    expect(prompt).not.toContain("Tokens")
    expect(prompt).not.toContain("budget")
  })
})
