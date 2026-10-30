import { describe, expect, it } from "vitest"
import { escapeHtml, listTags, renderTemplate, type MergeContext } from "./mergeTags"

const ctx: MergeContext = {
  guest: { name: "Sam  Rivera" },
  event: {
    title: "Creator Office Hours",
    startLocal: "Thu 12 Nov 2026, 18:00 GMT",
    joinUrl: "https://zoom.us/j/123",
    venue: "The Studio",
  },
  rsvp: { status: "confirmed", manageUrl: "https://app.example/r/tok" },
  poll: { joinUrl: "https://app.example/p/ABC123" },
}

describe("renderTemplate (US-20)", () => {
  it("renders every supported tag", () => {
    const template = listTags()
      .map((t) => t.token)
      .join("|")
    expect(renderTemplate(template, ctx)).toEqual({
      output:
        "Sam|Sam  Rivera|Creator Office Hours|Thu 12 Nov 2026, 18:00 GMT|https://zoom.us/j/123|The Studio|https://app.example/r/tok|https://app.example/p/ABC123",
      unknownTags: [],
    })
  })

  it("tolerates whitespace inside the braces", () => {
    expect(renderTemplate("Hi {{ guest.first_name }}, {{event.title   }}", ctx).output).toBe("Hi Sam, Creator Office Hours")
  })

  it("renders unknown tags as empty and reports each once", () => {
    const result = renderTemplate("A{{guest.email}}B{{ nope }}C{{guest.email}}D{{}}", ctx)
    expect(result.output).toBe("ABCD")
    expect(result.unknownTags).toEqual(["guest.email", "nope", ""])
  })

  it("is case-sensitive: near-misses are unknown, not guessed", () => {
    expect(renderTemplate("{{Guest.First_Name}}", ctx).unknownTags).toEqual(["Guest.First_Name"])
  })

  it("never throws on odd input", () => {
    expect(renderTemplate("{{ {{guest.name}} }} {single} }}{{", ctx).output).toBe("{{ Sam  Rivera }} {single} }}{{")
    expect(renderTemplate("", ctx)).toEqual({ output: "", unknownTags: [] })
    expect(renderTemplate("{{guest.first_name}}", {}).output).toBe("")
  })

  it("hides the join link unless the guest is confirmed (US-2)", () => {
    for (const status of ["pending", "waitlisted", "declined", "cancelled", "awaiting_payment", null]) {
      expect(renderTemplate("[{{event.join_url}}]", { ...ctx, rsvp: { status } }).output).toBe("[]")
    }
    expect(renderTemplate("[{{event.join_url}}]", { event: ctx.event }).output).toBe("[]")
  })

  it("uses the first word of the name for first_name", () => {
    expect(renderTemplate("{{guest.first_name}}", { guest: { name: "  Ada Lovelace " } }).output).toBe("Ada")
    expect(renderTemplate("{{guest.first_name}}", { guest: { name: "" } }).output).toBe("")
    expect(renderTemplate("{{guest.first_name}}", { guest: { name: null } }).output).toBe("")
  })

  it("escapes values in html mode but leaves the template's own markup", () => {
    const evil: MergeContext = { ...ctx, guest: { name: `<script>alert("x")</script>` }, event: { title: "Tom & Jerry's" } }
    const result = renderTemplate("<p>Hi {{guest.name}}, {{event.title}}</p>", evil, { mode: "html" })
    expect(result.output).toBe("<p>Hi &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;, Tom &amp; Jerry&#39;s</p>")
  })

  it("does not escape in text mode", () => {
    expect(renderTemplate("{{event.title}}", { event: { title: "Tom & Jerry" } }).output).toBe("Tom & Jerry")
  })

  it("does not re-expand tags that appear inside values", () => {
    expect(renderTemplate("{{guest.name}}", { ...ctx, guest: { name: "{{event.join_url}}" } }).output).toBe("{{event.join_url}}")
  })
})

describe("listTags", () => {
  it("lists exactly the PRD tags with tokens for the editor", () => {
    expect(listTags().map((t) => t.token)).toEqual([
      "{{guest.first_name}}",
      "{{guest.name}}",
      "{{event.title}}",
      "{{event.start_local}}",
      "{{event.join_url}}",
      "{{event.venue}}",
      "{{rsvp.manage_url}}",
      "{{poll.join_url}}",
    ])
  })

  it("returns copies the caller can't mutate", () => {
    listTags()[0].label = "x"
    expect(listTags()[0].label).toBe("Guest first name")
  })

  it("escapes all five HTML-significant characters", () => {
    expect(escapeHtml(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#39;")
  })
})
