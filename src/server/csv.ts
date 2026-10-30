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
