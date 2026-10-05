/**
 * Adapted from oh-my-pi packages/agent/src/compaction/shake.ts at
 * 14c97b555b206231290f46882794c8d8c3c024b1.
 * Copyright (c) 2025 Mario Zechner
 * Copyright (c) 2025-2026 Can Bölük
 * Copyright (c) 2026 Stencil Labs, Inc.
 * MIT License; see THIRD_PARTY_LICENSES for the full permission notice.
 */

/** Half-open UTF-16 indices within the single original text block supplied. */
export interface TextBlockRange {
  kind: 'fence' | 'xml'
  start: number
  end: number
}

// Deliberately retain upstream's line grammar, not a general XML parser.
const OPENING_XML = /^<([a-z_-]+)(?:\s+[^>]*)?>$/
const CLOSING_XML = /^<\/([a-z_-]+)>$/

/**
 * Scan one message content block, with no state shared between calls.
 * Includes opening/closing lines (and indentation), excludes the closing LF.
 * Fences close only with the opening marker, at least its run length, and
 * trailing whitespace. XML uses conservative whole-line lowercase tags.
 * Mismatched XML closings invalidate the candidate until its stack drains.
 * Comments and CDATA suppress tag and fence recognition on literal lines.
 * Unclosed structures emit no range. XML is not scanned inside fences.
 */
export function scanTextForBlockRanges(text: string): TextBlockRange[] {
  const ranges: TextBlockRange[] = []
  let fenceMarker = ''
  let fenceLength = 0
  let fenceStart = -1
  const tagStack: string[] = []
  let xmlStart = -1
  let invalidXml = false
  let literalEnd: '-->' | ']]>' | undefined

  let lineStart = 0
  for (let i = 0; i <= text.length; i++) {
    if (i !== text.length && text[i] !== '\n') continue
    const line = text.slice(lineStart, i)
    const trimmedStart = line.trimStart()

    if (fenceMarker) {
      const closing = /^(\`+|~+)\s*$/.exec(trimmedStart)
      if (closing && closing[1]![0] === fenceMarker && closing[1]!.length >= fenceLength) {
        ranges.push({ kind: 'fence', start: fenceStart, end: i })
        fenceMarker = ''
      }
      lineStart = i + 1
      continue
    }

    // Only track literal delimiters, not general XML syntax. A line touching
    // a literal span is conservatively excluded from structural recognition.
    let literalLine = literalEnd !== undefined
    let outsideLiteralContent = false
    let position = 0
    while (position < line.length) {
      if (literalEnd) {
        const end = line.indexOf(literalEnd, position)
        if (end < 0) break
        position = end + literalEnd.length
        literalEnd = undefined
      } else {
        const comment = line.indexOf('<!--', position)
        const cdata = line.indexOf('<![CDATA[', position)
        if (comment < 0 && cdata < 0) {
          outsideLiteralContent ||= line.slice(position).trim().length > 0
          break
        }
        const isComment = comment >= 0 && (cdata < 0 || comment < cdata)
        const start = isComment ? comment : cdata
        outsideLiteralContent ||= line.slice(position, start).trim().length > 0
        position = start + (isComment ? 4 : 9)
        literalEnd = isComment ? '-->' : ']]>'
        literalLine = true
      }
    }
    if (literalLine) {
      // Non-whitespace outside a literal is ambiguous in this whole-line grammar.
      if (tagStack.length > 0 && outsideLiteralContent) {
        invalidXml = true
      }
      lineStart = i + 1
      continue
    }

    const openingFence = /^(\`{3,}|~{3,})/.exec(trimmedStart)
    if (openingFence) {
      fenceMarker = openingFence[1]![0]!
      fenceLength = openingFence[1]!.length
      fenceStart = lineStart
      lineStart = i + 1
      continue
    }

    const openingMatch = line.length === trimmedStart.length ? OPENING_XML.exec(line) : null
    if (openingMatch) {
      if (tagStack.length === 0) {
        xmlStart = lineStart
        invalidXml = false
      }
      tagStack.push(openingMatch[1]!)
    } else {
      const closingMatch = CLOSING_XML.exec(trimmedStart)
      if (closingMatch && tagStack.length > 0) {
        if (tagStack[tagStack.length - 1] !== closingMatch[1]) {
          invalidXml = true
        } else {
          tagStack.pop()
          if (tagStack.length === 0) {
            if (!invalidXml) ranges.push({ kind: 'xml', start: xmlStart, end: i })
            xmlStart = -1
          }
        }
      }
    }

    lineStart = i + 1
  }

  return mergeRanges(ranges)
}

/** Keep earlier-starting outer spans and discard overlapping inner spans. */
function mergeRanges(ranges: TextBlockRange[]): TextBlockRange[] {
  if (ranges.length <= 1) return ranges
  ranges.sort((a, b) => a.start - b.start)
  const kept: TextBlockRange[] = []
  let lastEnd = -1
  for (const range of ranges) {
    if (range.start < lastEnd) continue
    kept.push(range)
    lastEnd = range.end
  }
  return kept
}
