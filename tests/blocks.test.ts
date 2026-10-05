import { describe, expect, it } from 'vitest'
import { scanTextForBlockRanges, type TextBlockRange } from '../src/blocks.js'

function selected(text: string) {
  return scanTextForBlockRanges(text).map(range => ({ kind: range.kind, text: text.slice(range.start, range.end) }))
}

describe('complete text block scanning', () => {
  it('returns ordered nonoverlapping ranges and permits exact reverse replacement', () => {
    const fence = '```ts\nconst value = 1\n```'
    const xml = '<payload>\nvalue\n</payload>'
    const text = `before\n${fence}\nbetween\n${xml}\nafter`
    const ranges = scanTextForBlockRanges(text)
    expect(ranges).toEqual([
      { kind: 'fence', start: 7, end: 7 + fence.length },
      { kind: 'xml', start: 7 + fence.length + 9, end: 7 + fence.length + 9 + xml.length },
    ])
    let replaced = text
    for (const range of [...ranges].reverse()) {
      replaced = replaced.slice(0, range.start) + `[${range.kind}]` + replaced.slice(range.end)
    }
    expect(replaced).toBe('before\n[fence]\nbetween\n[xml]\nafter')
    expect(scanTextForBlockRanges(text)).toEqual(ranges)
  })

  it.each([
    '````ts\nbody\n```',
    '~~~\nbody\n````` trailing text',
    '  ```ts\nbody\n\t~~~inline',
    '```\nbody ``` inline\n~~~',
    '```\n``` trailing text',
  ])('preserves unclosed fences and their XML-looking contents: %j', text => {
    expect(selected(`${text}\n<root>\nx\n</root>`)).toEqual([])
  })

  it.each([
    '````ts\n```\n~~~\n<root>\nx\n</root>\n`````  ',
    '  ~~~lang\n```\n~~~~ trailing\n\t~~~~\t',
  ])('selects complete matching fences including misleading body markers: %j', fence => {
    const xml = '<root>\nafter fence\n</root>'
    expect(selected(`${fence}\n${xml}`)).toEqual([
      { kind: 'fence', text: fence }, { kind: 'xml', text: xml },
    ])
  })

  it('ignores short or inline markers and unclosed fences', () => {
    expect(scanTextForBlockRanges('``\n~~\nprose ``` inline')).toEqual([])
    expect(scanTextForBlockRanges('```ts\nbody\n<root>\nvalue\n</root>')).toEqual([])
  })

  it('suppresses XML within fences and keeps complete outer XML containing a fence', () => {
    const fence = '```xml\n<inner>\nx\n</inner>\n```'
    expect(selected(fence)).toEqual([{ kind: 'fence', text: fence }])
    const xml = `<outer>\n${fence}\n</outer>`
    expect(selected(xml)).toEqual([{ kind: 'xml', text: xml }])
    expect(selected(`<outer>\n${fence}`)).toEqual([{ kind: 'fence', text: fence }])
  })

  it('rejects mismatched XML without resurrecting it and resumes after its stack drains', () => {
    const malformed = '<outer>\n<inner>\n</outer>\nvalue\n</inner>\n  </outer>'
    expect(selected(malformed)).toEqual([])
    const xml = '<outer>\n<inner>\nvalue\n</inner>\n  </outer>'
    const fence = '```\nindependent\n```'
    expect(selected(`${malformed}\n${xml}\n${fence}`)).toEqual([
      { kind: 'xml', text: xml }, { kind: 'fence', text: fence },
    ])
    expect(scanTextForBlockRanges('<outer>\n<inner>\n</outer>')).toEqual([])
    expect(scanTextForBlockRanges('<outer>\n<inner>\nx\n</inner>')).toEqual([])
    expect(selected('<outer>\n</unrelated>\n</outer>')).toEqual([])
  })


  it.each([
    ['<!--', '-->'],
    ['<![CDATA[', ']]>'],
  ])('preserves tag and fence examples inside %s literal spans', (opening, closing) => {
    const literal = `${opening}\n<root>\nx\n</root>\n\`\`\`\nexample\n\`\`\`\n${closing}`
    expect(selected(literal)).toEqual([])
    expect(selected(`${opening}\n<root>\nx\n</root>\n\`\`\``)).toEqual([])
    const xml = '<root>\nvalue\n</root>'
    const fence = '~~~\nindependent\n~~~'
    expect(selected(`${literal}\n${xml}\n${fence}`)).toEqual([
      { kind: 'xml', text: xml }, { kind: 'fence', text: fence },
    ])
    const outer = `<outer>\n${literal}\n</outer>`
    expect(selected(outer)).toEqual([{ kind: 'xml', text: outer }])
  })

  it.each([
    ['<!--', '-->'],
    ['<![CDATA[', ']]>'],
  ])('rejects outside tags on %s literal boundary lines', (opening, closing) => {
    const malformed = `<outer>\n${opening}\n<inner>\n${closing}</inner>\n</outer>`
    expect(selected(malformed)).toEqual([])
    const valid = `<outer>\n${opening}\n<inner>\n  ${closing}  \nvalue\n</outer>`
    expect(selected(valid)).toEqual([{ kind: 'xml', text: valid }])
    expect(selected(`${malformed}\n${valid}`)).toEqual([{ kind: 'xml', text: valid }])
    expect(selected(`<outer>\n${opening}<inner>${closing}</inner>\n</outer>`)).toEqual([])
    expect(selected(`<outer>\n<inner>${opening}\n${closing}\n</outer>`)).toEqual([])
  })

  it('does not close outer XML using tags inside an unfinished literal', () => {
    for (const opening of ['<!--', '<![CDATA[']) {
      expect(selected(`<outer>\n${opening}\n</outer>\n\`\`\`\nbody\n\`\`\``)).toEqual([])
    }
  })

  it('keeps complete XML with attributes and single-line literal content', () => {
    const xml = '<root a="hello" b=\'world\'>\n<!-- <fake> -->\n<![CDATA[<fake>]]>\n</root>'
    expect(selected(xml)).toEqual([{ kind: 'xml', text: xml }])
  })

  it('does not let fenced literal delimiters suppress later independent XML', () => {
    const fence = '```\n<!--\n<![CDATA[\n```'
    const xml = '<root>\nx\n</root>'
    expect(selected(`${fence}\n${xml}`)).toEqual([
      { kind: 'fence', text: fence }, { kind: 'xml', text: xml },
    ])
  })

  it('includes CRLF fence content without removing surrounding text', () => {
    const fence = '```\r\nvalue\r\n```\r'
    expect(selected(fence + '\n')).toEqual([{ kind: 'fence', text: fence }])
  })

  it('uses UTF-16 offsets without splitting Unicode or altering surrounding text', () => {
    const prefix = '😀𠮷e\u0301\n'
    const fence = '```\n😀𠮷e\u0301\ud800\n```'
    const xml = '<root>\n𠮷😀\n</root>'
    const text = `${prefix}${fence}\n${xml}\n尾😀`
    const expected: TextBlockRange[] = [
      { kind: 'fence', start: prefix.length, end: prefix.length + fence.length },
      { kind: 'xml', start: prefix.length + fence.length + 1, end: prefix.length + fence.length + 1 + xml.length },
    ]
    expect(scanTextForBlockRanges(text)).toEqual(expected)
    expect(selected(text)).toEqual([{ kind: 'fence', text: fence }, { kind: 'xml', text: xml }])
    expect(text.slice(0, expected[0]!.start)).toBe(prefix)
    expect(text.slice(expected[1]!.end)).toBe('\n尾😀')
  })

  it('cannot close structures across separate input blocks or messages', () => {
    expect(scanTextForBlockRanges('```ts\nfirst block')).toEqual([])
    expect(scanTextForBlockRanges('second block\n```')).toEqual([])
    expect(scanTextForBlockRanges('<root>\nfirst message')).toEqual([])
    expect(scanTextForBlockRanges('second message\n</root>')).toEqual([])
    expect(selected('<root>\nfresh call\n</root>')).toEqual([
      { kind: 'xml', text: '<root>\nfresh call\n</root>' },
    ])
  })
})
