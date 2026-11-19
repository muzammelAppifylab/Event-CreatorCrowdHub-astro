/**
 * Tiny RFC 4180 CSV writer and parser (no dependency). Exports open in Excel,
 * Numbers and Google Sheets: UTF-8 with a BOM (so Excel doesn't guess
 * Windows-1252 for "Zoë"), CRLF line ends, and quoting only where needed.
 */

export type CsvValue = string | number | boolean | null | undefined

export const UTF8_BOM = "﻿"

// Spreadsheet apps run a cell starting with one of these as a formula, so a
// guest named "=HYPERLINK(...)" could attack the creator who opens the export.
const FORMULA_START = /^[=+\-@\t\r]/

/** One cell, escaped. Numbers and booleans are never formulas, so they skip the guard. */
export function csvCell(value: CsvValue): string {
  if (value === null || value === undefined) return ""
  let text = typeof value === "string" ? value : String(value)
  if (typeof value === "string" && FORMULA_START.test(text)) text = `'${text}`
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

export function toCsv(rows: CsvValue[][], options: { bom?: boolean } = {}): string {
  const body = rows.map((row) => row.map(csvCell).join(",")).join("\r\n")
  return (options.bom ?? true ? UTF8_BOM : "") + body + "\r\n"
}

/**
 * Parses RFC 4180 text into rows of raw cells. Accepts CRLF or LF, a leading
 * BOM, quoted cells with embedded commas, quotes and newlines. Blank lines are
 * dropped. Lenient on purpose (a stray quote mid-cell is kept as text): Zoom
 * and spreadsheet exports aren't always strict.
 */
export function parseCsv(input: string): string[][] {
  const text = input.startsWith(UTF8_BOM) ? input.slice(1) : input
  const rows: string[][] = []
  let row: string[] = []
  let cell = ""
  let quoted = false
  let i = 0

  const endRow = () => {
    row.push(cell)
    if (row.length > 1 || row[0] !== "") rows.push(row)
    row = []
    cell = ""
  }

  while (i < text.length) {
    const ch = text[i]!
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"'
          i += 2
          continue
        }
        quoted = false
      } else {
        cell += ch
      }
      i += 1
      continue
    }
    if (ch === '"' && cell === "") quoted = true
    else if (ch === ",") {
      row.push(cell)
      cell = ""
    } else if (ch === "\r" || ch === "\n") {
      endRow()
      if (ch === "\r" && text[i + 1] === "\n") i += 1
    } else cell += ch
    i += 1
  }
  if (cell !== "" || row.length > 0) endRow()
  return rows
}

/** Content-Disposition value with an ASCII-safe filename. */
export function attachmentHeader(filename: string): string {
  const safe = filename.replace(/[^A-Za-z0-9._-]+/g, "-")
  return `attachment; filename="${safe}"`
}

export interface CsvExport {
  /** The whole CSV text: BOM, header row, then at most `maxRows` data rows. */
  csv: string
  /** Data rows written. */
  rows: number
  /** True when `pages` had more than `maxRows` rows (`X-Export-Truncated: 1`). */
  truncated: boolean
}

/**
 * A capped CSV export, read page by page (keyset, e.g. 1,000 rows per query) and turned into text
 * one page at a time, so only the text and one page of rows are in memory, never every row object.
 *
 * Every page is read BEFORE the route returns, on purpose: the Site Database client is the
 * request's (`getDb()`, `src/platform/db.ts`), and nothing in the platform promises it may still be
 * used by a response body read after the handler returned (a client that disconnects cancels that
 * work, so an audit row written at the end of a streamed body could be lost, and a database error
 * mid-stream would leave a cut file behind a 200). Let `pages` yield ONE row past the cap when there
 * are more: that row is not written and sets `truncated`. Stopping early ends `pages` (`return()`).
 */
export async function csvExport(
  header: CsvValue[],
  pages: AsyncIterable<CsvValue[][]>,
  maxRows: number,
  options: { bom?: boolean } = {},
): Promise<CsvExport> {
  const chunks = [toCsv([header], options)]
  let rows = 0
  let truncated = false
  for await (const page of pages) {
    const room = maxRows - rows
    const kept = page.length > room ? page.slice(0, room) : page
    if (kept.length > 0) {
      chunks.push(toCsv(kept, { bom: false }))
      rows += kept.length
    }
    if (page.length > room) {
      truncated = true
      break
    }
  }
  return { csv: chunks.join(""), rows, truncated }
}
