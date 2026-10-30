import { describe, expect, it } from "vitest"
import { slugify, uniqueSlug } from "./slug"

describe("slugify", () => {
  it("lowercases and hyphenates", () => {
    expect(slugify("Ask Me Anything: Pricing")).toBe("ask-me-anything-pricing")
  })

  it("folds diacritics to ASCII", () => {
    expect(slugify("Café Crème — Ünïcode Night")).toBe("cafe-creme-unicode-night")
  })

  it("trims leading and trailing hyphens", () => {
    expect(slugify("  --Hello, world!--  ")).toBe("hello-world")
  })

  it("caps length at 60 without a trailing hyphen", () => {
    const slug = slugify(`${"a".repeat(59)} bcd`)
    expect(slug.length).toBeLessThanOrEqual(60)
    expect(slug.endsWith("-")).toBe(false)
  })

  it("falls back when nothing is left", () => {
    expect(slugify("★★★")).toBe("event")
    expect(slugify("")).toBe("event")
  })
})

describe("uniqueSlug", () => {
  it("returns the base when free", async () => {
    expect(await uniqueSlug("Pricing Workshop", () => false)).toBe("pricing-workshop")
  })

  it("appends -2, -3… on collision", async () => {
    const taken = new Set(["pricing-workshop", "pricing-workshop-2"])
    expect(await uniqueSlug("Pricing Workshop", (s) => taken.has(s))).toBe("pricing-workshop-3")
  })

  it("accepts an async check and stays within 60 chars", async () => {
    const long = "x".repeat(80)
    const result = await uniqueSlug(long, async (s) => s === "x".repeat(60))
    expect(result).toBe(`${"x".repeat(58)}-2`)
  })
})

describe("slugify length bounds", () => {
  it("suffixes slugs shorter than the 3-char minimum", () => {
    expect(slugify("AI")).toBe("ai-event")
    expect(slugify("Q")).toBe("q-event")
  })
})
