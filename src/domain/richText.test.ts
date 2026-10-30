import { describe, expect, it } from "vitest"
import { descriptionExcerpt, renderDescription, safeUrl } from "./richText"

describe("renderDescription", () => {
  it("escapes any HTML the creator types", () => {
    const html = renderDescription(`<script>alert(1)</script> <img src=x onerror=alert(1)>`)
    expect(html).not.toContain("<script")
    expect(html).not.toContain("<img")
    expect(html).toContain("&lt;script&gt;")
  })

  it("renders paragraphs and line breaks", () => {
    expect(renderDescription("One\ntwo\n\nThree")).toBe("<p>One<br>two</p><p>Three</p>")
  })

  it("renders bold, italic and lists", () => {
    expect(renderDescription("**Bring** a *laptop*")).toBe("<p><strong>Bring</strong> a <em>laptop</em></p>")
    expect(renderDescription("- one\n- two")).toBe("<ul><li>one</li><li>two</li></ul>")
    expect(renderDescription("1. one\n2. two")).toBe("<ol><li>one</li><li>two</li></ol>")
  })

  it("links only safe protocols", () => {
    expect(renderDescription("[Zoom](https://zoom.us/j/1?a=1&b=2)")).toContain('href="https://zoom.us/j/1?a=1&amp;b=2"')
    const evil = renderDescription("[click](javascript:alert(1))")
    expect(evil).not.toContain("<a ")
    expect(renderDescription("See https://example.com/x")).toContain('<a href="https://example.com/x"')
  })

  it("cannot break out of an attribute", () => {
    const html = renderDescription('[x](https://a.com/"onmouseover="alert(1))')
    expect(html).not.toMatch(/"onmouseover=/)
  })

  it("returns empty string for empty input", () => {
    expect(renderDescription("  \n\n ")).toBe("")
  })
})

describe("safeUrl", () => {
  it("allows http(s) and mailto only", () => {
    expect(safeUrl("https://a.com")).toBe("https://a.com/")
    expect(safeUrl("mailto:a@b.com")).toBe("mailto:a@b.com")
    expect(safeUrl("javascript:alert(1)")).toBeNull()
    expect(safeUrl("data:text/html,x")).toBeNull()
    expect(safeUrl("not a url")).toBeNull()
  })
})

describe("descriptionExcerpt", () => {
  it("strips markup and truncates", () => {
    expect(descriptionExcerpt("**Bring** a [laptop](https://a.com)")).toBe("Bring a laptop")
    expect(descriptionExcerpt("a".repeat(200), 10)).toBe(`${"a".repeat(9)}…`)
  })
})
