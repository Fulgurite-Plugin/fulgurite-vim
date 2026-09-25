// Vim as a fulgurite plugin: the first user of the plugin API. Pure state machine (keys in, edits out),
// no platform code, so the same bundle runs on every shell. Offsets are UTF-16 code units.
import type { EditorStatus, Plugin, PluginContext } from "fulgurite"

type Mode = "normal" | "insert" | "visual" | "visualLine" | "command"
const LABEL: Record<Mode, string> = { normal: "NORMAL", insert: "INSERT", visual: "VISUAL", visualLine: "V-LINE", command: "COMMAND" }

interface Range {
  location: number
  length: number
}
const R = (location: number, length: number): Range => ({ location, length })
const upper = (r: Range) => r.location + r.length

/** View-independent edit instructions. Applied in order to the EditorView. */
type Cmd =
  | { t: "move"; at: number }
  | { t: "select"; range: Range }
  | { t: "replace"; range: Range; text: string }
  | { t: "clipboard"; text: string }
  | { t: "command"; id: string }
  | { t: "notice"; text: string }

interface Ctx {
  text: string
  cursor: number
  clipboard: string
  /** [start, end) of the text on screen. */
  visible: readonly [number, number]
}

/** Applies commands the way the shell does. Used by `.` repeat. */
function applying(ctx: Ctx, cmds: Cmd[]): Ctx {
  const c = { ...ctx }
  for (const cmd of cmds) {
    switch (cmd.t) {
      case "move": c.cursor = cmd.at; break
      case "select": c.cursor = cmd.range.location; break
      case "replace":
        c.text = c.text.slice(0, cmd.range.location) + cmd.text + c.text.slice(upper(cmd.range))
        c.cursor = cmd.range.location + cmd.text.length
        break
      case "clipboard": c.clipboard = cmd.text; break
      case "command": case "notice": break
    }
  }
  return c
}

// MARK: - Buffer geometry (UTF-16 offsets, surrogate-pair aware)
// ponytail: pairs only, no grapheme clusters (ZWJ emoji, combining marks). Add a segmenter when someone types one.

const isLead = (c: number) => c >= 0xd800 && c <= 0xdbff
const isTrail = (c: number) => c >= 0xdc00 && c <= 0xdfff
const WORD = /^[\p{L}\p{N}_]$/u

class Doc {
  constructor(readonly s: string) {}

  get length(): number { return this.s.length }

  char(i: number): number | undefined { return i >= 0 && i < this.s.length ? this.s.charCodeAt(i) : undefined }
  next(i: number): number {
    if (i >= this.length) return this.length
    return isLead(this.s.charCodeAt(i)) && i + 1 < this.length && isTrail(this.s.charCodeAt(i + 1)) ? i + 2 : i + 1
  }
  prev(i: number): number {
    i = Math.min(i, this.length)
    if (i <= 0) return 0
    return i >= 2 && isTrail(this.s.charCodeAt(i - 1)) && isLead(this.s.charCodeAt(i - 2)) ? i - 2 : i - 1
  }
  /** Snaps an offset inside a surrogate pair back to its start. */
  align(i: number): number {
    if (i >= this.length) return this.length
    return i > 0 && isTrail(this.s.charCodeAt(i)) && isLead(this.s.charCodeAt(i - 1)) ? i - 1 : i
  }

  private clamp(i: number): number { return Math.min(Math.max(i, 0), this.length) }
  lineStart(i: number): number {
    i = this.clamp(i)
    return i === 0 ? 0 : this.s.lastIndexOf("\n", i - 1) + 1
  }
  contentsEnd(i: number): number {
    const nl = this.s.indexOf("\n", this.clamp(i))
    return nl < 0 ? this.length : nl
  }
  /** End of the line including its newline. */
  lineEnd(i: number): number {
    const ce = this.contentsEnd(i)
    return ce < this.length ? ce + 1 : ce
  }
  nextLineStart(i: number): number | null {
    const end = this.lineEnd(i)
    return end > this.contentsEnd(i) ? end : null
  }
  prevLineStart(i: number): number | null {
    const start = this.lineStart(i)
    return start > 0 ? this.lineStart(start - 1) : null
  }
  column(i: number): number { return i - this.lineStart(i) }
  isBlankLine(i: number): boolean { return this.lineStart(i) === this.contentsEnd(i) }

  firstNonBlankAt(i: number): number {
    let j = this.lineStart(i)
    const end = this.contentsEnd(j)
    while (j < end) {
      const c = this.s.charCodeAt(j)
      if (c !== 32 && c !== 9) break
      j++
    }
    return j
  }
  /** 1-based, like `:n` and `nG`. */
  firstNonBlankOfLine(n: number): number { return this.firstNonBlankAt(this.lineStartOf(n - 1)) }

  /** 0-based line number of offset `i`. */
  lineOf(i: number): number {
    let n = 0
    for (let nl = this.s.indexOf("\n"); nl >= 0 && nl < i; nl = this.s.indexOf("\n", nl + 1)) n++
    return n
  }
  /** Start of 0-based line `n`, clamped to the first and last lines. */
  lineStartOf(n: number): number {
    let start = 0
    for (let k = 0; k < n; k++) {
      const next = this.nextLineStart(start)
      if (next === null) break
      start = next
    }
    return start
  }

  /** Normal-mode cursor never rests on the newline of a non-empty line. */
  clampNormal(i: number): number {
    const j = this.clamp(i)
    const end = this.contentsEnd(j)
    return j >= end && end > this.lineStart(j) ? this.prev(end) : j
  }

  /** 0 = whitespace, 1 = word (letters, digits, `_`), 2 = punctuation. Vim's `iskeyword` model. A `big` WORD
   *  (`W` `B` `E`) is anything but whitespace. */
  cls(i: number, big = false): 0 | 1 | 2 {
    const c = this.char(i)
    if (c === undefined) return 0
    if (c === 32 || c === 9 || c === 10 || c === 13) return 0
    if (big || c === 95 || isLead(c) || isTrail(c)) return 1
    return WORD.test(String.fromCharCode(c)) ? 1 : 2
  }

  wordForward(i: number, big = false): number {
    let j = i
    const c = this.cls(j, big)
    if (c !== 0) while (j < this.length && this.cls(j, big) === c) j = this.next(j)
    while (j < this.length && this.cls(j) === 0) {
      if (this.char(j) === 10 && this.isBlankLine(j + 1) && j + 1 < this.length) return j + 1 // empty line is a word stop
      j = this.next(j)
    }
    return j
  }
  wordEnd(i: number, big = false): number {
    let j = this.next(i)
    while (j < this.length && this.cls(j) === 0) j = this.next(j)
    if (j >= this.length) return this.prev(this.length)
    const c = this.cls(j, big)
    while (this.next(j) < this.length && this.cls(this.next(j), big) === c) j = this.next(j)
    return j
  }
  wordBackward(i: number, big = false): number {
    let j = this.prev(i)
    while (j > 0 && this.cls(j) === 0) j = this.prev(j)
    const c = this.cls(j, big)
    while (j > 0 && this.cls(this.prev(j), big) === c) j = this.prev(j)
    return j
  }
  /** `ge`: the end of the word before the one at `i`. */
  wordEndBackward(i: number, big = false): number {
    let j = i
    const c = this.cls(j, big)
    if (c !== 0) while (j > 0 && this.cls(j, big) === c) j = this.prev(j)
    while (j > 0 && this.cls(j) === 0) j = this.prev(j)
    return j
  }

  /** `%`: the bracket matching the first one at or after `i` on its line. */
  matchPair(i: number): number | null {
    const PAIRS = "()[]{}"
    const end = this.contentsEnd(i)
    let j = i
    while (j < end && !PAIRS.includes(this.s[j]!)) j++
    if (j >= end) return null
    const k = PAIRS.indexOf(this.s[j]!)
    const step = k % 2 === 0 ? 1 : -1
    const same = PAIRS[k]!
    const other = PAIRS[k + step]!
    let depth = 0
    for (let p = j; p >= 0 && p < this.length; p += step) {
      if (this.s[p] === same) depth++
      else if (this.s[p] === other && --depth === 0) return p
    }
    return null
  }

  paragraphForward(i: number): number {
    let ls = this.lineStart(i)
    while (this.isBlankLine(ls)) {
      const n = this.nextLineStart(ls)
      if (n === null) break
      ls = n
    }
    while (!this.isBlankLine(ls)) {
      const n = this.nextLineStart(ls)
      if (n === null) break
      ls = n
    }
    return this.isBlankLine(ls) ? ls : this.contentsEnd(ls)
  }
  paragraphBackward(i: number): number {
    let ls = this.lineStart(i)
    while (this.isBlankLine(ls)) {
      const p = this.prevLineStart(ls)
      if (p === null) break
      ls = p
    }
    while (!this.isBlankLine(ls)) {
      const p = this.prevLineStart(ls)
      if (p === null) break
      ls = p
    }
    return ls
  }

  find(ch: string, from: number, forward: boolean, count: number): number | null {
    const ls = this.lineStart(from)
    const end = this.contentsEnd(from)
    let j = from
    let found: number | null = null
    for (let k = 0; k < count; k++) {
      let idx: number
      if (forward) {
        idx = this.s.indexOf(ch, Math.min(this.next(j), end))
        if (idx < 0 || idx >= end) return null
      } else {
        if (j <= ls) return null
        idx = this.s.lastIndexOf(ch, j - 1)
        if (idx < ls) return null
      }
      found = j = idx
    }
    return found
  }

  /** `count` whole lines starting at the line containing `i`, newline included. */
  linesRangeFrom(i: number, count: number): Range {
    const start = this.lineStart(i)
    let end = this.lineEnd(i)
    for (let k = 1; k < Math.max(count, 1) && end < this.length; k++) end = this.lineEnd(end)
    return R(start, end - start)
  }
  linesRangeCovering(lo: number, hi: number): Range {
    const start = this.lineStart(lo)
    return R(start, this.lineEnd(hi) - start)
  }

  // MARK: Text objects

  textObject(obj: string, around: boolean, cur: number): Range | null {
    switch (obj) {
      case "w": case "W": {
        if (cur >= this.length || this.char(cur) === 10) return null
        const big = obj === "W"
        const c = this.cls(cur, big)
        const ls = this.lineStart(cur)
        const ce = this.contentsEnd(cur)
        let lo = cur
        let hi = this.next(cur)
        while (lo > ls && this.cls(this.prev(lo), big) === c) lo = this.prev(lo)
        while (hi < ce && this.cls(hi, big) === c) hi = this.next(hi)
        if (around) {
          let trailing = hi
          while (trailing < ce && this.cls(trailing) === 0) trailing = this.next(trailing)
          if (trailing > hi) hi = trailing
          else while (lo > ls && this.cls(this.prev(lo)) === 0) lo = this.prev(lo)
        }
        return R(lo, hi - lo)
      }
      case '"': case "'": case "`": {
        const q = obj.charCodeAt(0)
        const ls = this.lineStart(cur)
        const ce = this.contentsEnd(cur)
        const positions: number[] = []
        for (let k = ls; k < ce; k++) if (this.s.charCodeAt(k) === q) positions.push(k)
        for (let k = 0; k + 1 < positions.length; k += 2) {
          const o = positions[k]!
          const c = positions[k + 1]!
          if (cur <= c) return around ? R(o, c - o + 1) : R(o + 1, c - o - 1)
        }
        return null
      }
      case "(": case ")": case "b": return this.bracketObject(40, 41, around, cur)
      case "[": case "]": return this.bracketObject(91, 93, around, cur)
      case "{": case "}": case "B": return this.bracketObject(123, 125, around, cur)
      case "<": case ">": return this.bracketObject(60, 62, around, cur)
      case "p": {
        const blank = this.isBlankLine(cur)
        let lo = this.lineStart(cur)
        let hi = this.lineEnd(cur)
        for (;;) {
          const p = this.prevLineStart(lo)
          if (p === null || this.isBlankLine(p) !== blank) break
          lo = p
        }
        while (hi < this.length && this.isBlankLine(hi) === blank) hi = this.lineEnd(hi)
        if (around) while (hi < this.length && this.isBlankLine(hi) !== blank) hi = this.lineEnd(hi)
        return R(lo, hi - lo)
      }
      default: return null
    }
  }

  private bracketObject(open: number, close: number, around: boolean, cur: number): Range | null {
    let opener: number | null = null
    if (this.char(cur) === open) opener = cur
    else {
      let depth = 0
      for (let j = cur - 1; j >= 0; j--) {
        const c = this.s.charCodeAt(j)
        if (c === close) depth++
        else if (c === open) {
          if (depth === 0) { opener = j; break }
          depth--
        }
      }
    }
    if (opener === null) return null
    let depth = 0
    let closer: number | null = null
    for (let j = opener + 1; j < this.length; j++) {
      const c = this.s.charCodeAt(j)
      if (c === open) depth++
      else if (c === close) {
        if (depth === 0) { closer = j; break }
        depth--
      }
    }
    if (closer === null) return null
    return around ? R(opener, closer - opener + 1) : R(opener + 1, closer - opener - 1)
  }
}

// MARK: - Key mappings (vimrc)

/** A normal-mode mapping from a key sequence to an ex command, e.g. `nnoremap gd :goto<CR>`. */
interface Mapping {
  lhs: string[]
  ex: string
}

/** Normal-mode keys that reach app features. `<Space>` is the leader; a lone `<Space>` still moves right. */
export const DEFAULT_MAPPINGS: Mapping[] = [
  { lhs: ["g", "f"], ex: "goto" },
  { lhs: ["/"], ex: "find" },
  { lhs: ["n"], ex: "findnext" },
  { lhs: ["N"], ex: "findprev" },
  { lhs: ["<Space>", "f"], ex: "search" },
  { lhs: ["<Space>", "o"], ex: "open" },
  { lhs: ["<Space>", "n"], ex: "new" },
  { lhs: ["<Space>", "p"], ex: "commands" },
]

/** Splits `<Space>g` into keys the way the shell sends them: `<Name>` tokens or single characters. */
function keyTokens(text: string): string[] {
  const out: string[] = []
  for (let i = 0; i < text.length; ) {
    if (text[i] === "<") {
      const close = text.indexOf(">", i)
      if (close > i) {
        out.push(text.slice(i, close + 1))
        i = close + 1
        continue
      }
    }
    out.push(text[i]!)
    i++
  }
  return out
}

/** The vimrc subset the plugin honours: comments, `let mapleader = "…"`, `nmap`/`nnoremap <lhs> :<ex><CR>`, `nunmap <lhs>`.
 *  Defaults stay unless unmapped. ponytail: no key-to-key mappings or other modes; add when a config needs them. */
export function parseVimrc(text: string): Mapping[] {
  let leader = "<Space>"
  const mappings = DEFAULT_MAPPINGS.map((m) => ({ ...m }))
  const remove = (lhs: string[]) => {
    const i = mappings.findIndex((m) => m.lhs.join("") === lhs.join(""))
    if (i >= 0) mappings.splice(i, 1)
  }
  for (const raw of text.split("\n")) {
    const line = raw.trim()
    if (!line || line.startsWith('"')) continue
    const leaderMatch = line.match(/^let\s+mapleader\s*=\s*"(.*)"$/)
    if (leaderMatch) {
      leader = leaderMatch[1] === " " ? "<Space>" : leaderMatch[1]!.replace(/\\<Space>/i, "<Space>")
      continue
    }
    const [cmd, lhsText, ...rest] = line.split(/\s+/)
    if (!lhsText) continue
    const lhs = keyTokens(lhsText.replace(/<leader>/gi, leader))
    if (cmd === "nunmap") remove(lhs)
    else if (cmd === "nmap" || cmd === "nnoremap") {
      const ex = rest.join(" ").match(/^:(.+?)<CR>$/i)
      if (!ex) continue
      remove(lhs)
      mappings.push({ lhs, ex: ex[1]! })
    }
  }
  return mappings
}

// MARK: - Engine

type Motion =
  | { kind: "left" | "right" | "up" | "down" | "lineStart" | "firstNonBlank" | "lineEnd" | "column" | "paragraphForward" | "paragraphBackward" | "matchPair" }
  | { kind: "wordForward" | "wordBackward" | "wordEnd" | "wordEndBackward"; big?: boolean }
  /** `+` `-` `_`: lines down (1) or up (-1) to the first non-blank; `_` (0) is `+` one line short. */
  | { kind: "nonBlankLine"; delta: 1 | -1 | 0 }
  | { kind: "screen"; at: "H" | "M" | "L" }
  | { kind: "gotoLine"; defaultLast: boolean }
  /** `repeat`: `;` or `,`, which don't stop at the character a `t` already stands before. */
  | { kind: "findChar"; ch: string; find: string; repeat?: boolean }

const MOTIONS: Record<string, Motion> = {
  h: { kind: "left" }, "<Left>": { kind: "left" }, "<BS>": { kind: "left" },
  l: { kind: "right" }, "<Right>": { kind: "right" }, "<Space>": { kind: "right" },
  j: { kind: "down" }, "<Down>": { kind: "down" }, "<C-j>": { kind: "down" }, "<C-n>": { kind: "down" },
  k: { kind: "up" }, "<Up>": { kind: "up" }, "<C-p>": { kind: "up" },
  w: { kind: "wordForward" }, b: { kind: "wordBackward" }, e: { kind: "wordEnd" },
  W: { kind: "wordForward", big: true }, B: { kind: "wordBackward", big: true }, E: { kind: "wordEnd", big: true },
  "0": { kind: "lineStart" }, "^": { kind: "firstNonBlank" }, "$": { kind: "lineEnd" }, "|": { kind: "column" },
  "+": { kind: "nonBlankLine", delta: 1 }, "<CR>": { kind: "nonBlankLine", delta: 1 },
  "-": { kind: "nonBlankLine", delta: -1 }, _: { kind: "nonBlankLine", delta: 0 },
  "}": { kind: "paragraphForward" }, "{": { kind: "paragraphBackward" }, "%": { kind: "matchPair" },
  H: { kind: "screen", at: "H" }, M: { kind: "screen", at: "M" }, L: { kind: "screen", at: "L" },
  G: { kind: "gotoLine", defaultLast: true },
}

const REVERSE: Record<string, string> = { f: "F", F: "f", t: "T", T: "t" }

/** Pure Vim state machine: keys in, `Cmd`s out. Keys are single characters or `<Esc> <CR> <BS> <Space> <Tab> <C-x> <Left>…`.
 *  In insert mode only `<Esc>` is handled; typing goes to the shell natively (IME-safe).
 *  ponytail: one register = the system clipboard; named registers/macros when someone misses them. */
class VimEngine {
  mode: Mode = "normal"
  commandLine = ""
  mappings: Mapping[] = DEFAULT_MAPPINGS
  /** Keys typed so far that may still complete a mapping. */
  private mapPending: string[] = []
  private count: number | null = null
  private op: string | null = null
  private prefix: string | null = null
  private anchor = 0
  private vcursor = 0
  /** The last `f` `t` `F` `T`, for `;` and `,`. */
  private lastFind: { ch: string; find: string } | null = null
  /** Vim's 'scroll': lines CTRL-D and CTRL-U move, set by their count; half the screen until then. */
  private scrollLines: number | null = null
  private stickyColumn: number | null = null
  private insertStart: number | null = null
  private recording: string[] | null = null
  private pendingInsertKeys: string[] | null = null
  private lastChange: { keys: string[]; inserted: string } | null = null
  private replaying = false

  get status(): EditorStatus {
    return {
      mode: this.mode,
      label: LABEL[this.mode],
      pending: (this.count?.toString() ?? "") + (this.op ?? "") + (this.prefix ?? "") + this.mapPending.join(""),
      commandLine: this.commandLine,
    }
  }
  private get pendingEmpty(): boolean { return this.count === null && this.op === null && this.prefix === null }
  private get isVisual(): boolean { return this.mode === "visual" || this.mode === "visualLine" }

  handle(key: string, ctx: Ctx): Cmd[] {
    if (this.mode === "insert") return this.handleInsert(key, ctx)
    if (this.mode === "command") return this.handleCommandLine(key, ctx)
    if (!this.replaying) {
      if (this.mode === "normal" && this.pendingEmpty && key !== ".") this.recording = []
      this.recording?.push(key)
    }
    const cmds = this.handleMapped(key, ctx)
    const mode = this.mode as Mode // handleMapped may have switched modes; the cast undoes the early-return narrowing
    if (!this.replaying && this.recording) {
      const rec = this.recording
      if (mode === "insert") {
        this.pendingInsertKeys = rec
        this.recording = null
      } else if (cmds.some((c) => c.t === "replace")) {
        this.lastChange = { keys: rec, inserted: "" }
        this.recording = null
      } else if (mode === "normal" && this.pendingEmpty) {
        this.recording = null
      }
    }
    return cmds
  }

  /** Mouse selection while in normal mode becomes a visual selection. */
  adoptSelection(range: readonly [number, number], text: string) {
    if (this.mode !== "normal" || range[1] <= range[0]) return
    this.mode = "visual"
    this.anchor = range[0]
    this.vcursor = new Doc(text).prev(range[1])
  }

  // MARK: Insert / command-line

  private handleInsert(key: string, ctx: Ctx): Cmd[] {
    if (key !== "<Esc>") return []
    this.mode = "normal"
    const doc = new Doc(ctx.text)
    if (this.pendingInsertKeys) {
      const start = Math.min(this.insertStart ?? ctx.cursor, doc.length)
      const end = Math.min(Math.max(ctx.cursor, start), doc.length)
      this.lastChange = { keys: this.pendingInsertKeys, inserted: ctx.text.slice(start, end) }
      this.pendingInsertKeys = null
    }
    this.insertStart = null
    const back = ctx.cursor > doc.lineStart(ctx.cursor) ? doc.prev(ctx.cursor) : ctx.cursor
    return [{ t: "move", at: doc.clampNormal(back) }]
  }

  private handleCommandLine(key: string, ctx: Ctx): Cmd[] {
    switch (key) {
      case "<Esc>":
        this.mode = "normal"
        this.commandLine = ""
        break
      case "<BS>":
        if (this.commandLine === "") this.mode = "normal"
        else this.commandLine = this.commandLine.slice(0, -1)
        break
      case "<CR>": {
        const line = this.commandLine
        this.commandLine = ""
        this.mode = "normal"
        return this.execute(line, ctx)
      }
      case "<Space>": this.commandLine += " "; break
      default: if (isChar(key)) this.commandLine += key
    }
    return []
  }

  private execute(line: string, ctx: Ctx): Cmd[] {
    const cmd = line.trim()
    switch (cmd) {
      case "w": return [{ t: "command", id: "note.save" }]
      case "q": return [{ t: "command", id: "note.close" }]
      case "wq": case "x": return [{ t: "command", id: "note.save" }, { t: "command", id: "note.close" }]
      case "goto": return [{ t: "command", id: "note.goto" }] // GOTO: the shell opens the [[link]] under the cursor
      case "find": return [{ t: "command", id: "find.inNote" }] // the shell's find bar
      case "findnext": return [{ t: "command", id: "find.next" }]
      case "findprev": return [{ t: "command", id: "find.previous" }]
      case "search": return [{ t: "command", id: "search.all" }] // full-text search across notes
      case "open": return [{ t: "command", id: "search.titles" }] // open a note by title
      case "new": return [{ t: "command", id: "note.new" }]
      case "workspace": return [{ t: "command", id: "workspace.new" }]
      case "commands": return [{ t: "command", id: "palette.open" }] // the command palette (⌘P / Ctrl+P)
      default:
        if (/^\d+$/.test(cmd)) return [{ t: "move", at: new Doc(ctx.text).firstNonBlankOfLine(parseInt(cmd, 10)) }]
        // Any command by id, the app's (`note.new`) or a plugin's (`fulgurite.math:insert-inline`): what makes every
        // palette command mappable from the vimrc.
        if (/^[\w-]+(\.[\w-]+)+(:[\w-]+)?$/.test(cmd)) return [{ t: "command", id: cmd }]
        return cmd ? [{ t: "notice", text: `E492: Not an editor command: ${cmd}` }] : []
    }
  }

  // MARK: Normal / visual

  /** Mappings take a whole key sequence; keys that stop matching are replayed as ordinary normal-mode keys. */
  private handleMapped(key: string, ctx: Ctx): Cmd[] {
    const collecting = this.mapPending.length > 0
    if (this.mode !== "normal" || !this.pendingEmpty || (!collecting && !this.mappings.some((m) => m.lhs[0] === key))) {
      return this.handleNormal(key, ctx)
    }
    this.mapPending.push(key)
    const seq = this.mapPending
    const exact = this.mappings.find((m) => m.lhs.length === seq.length && m.lhs.every((k, i) => k === seq[i]))
    if (exact) {
      this.mapPending = []
      return this.execute(exact.ex, ctx)
    }
    if (this.mappings.some((m) => m.lhs.length > seq.length && seq.every((k, i) => m.lhs[i] === k))) return [] // wait for more
    this.mapPending = []
    let cmds: Cmd[] = []
    let c = ctx
    for (const k of seq) {
      const out = this.handleNormal(k, c)
      cmds = cmds.concat(out)
      c = applying(c, out)
    }
    return cmds
  }

  private handleNormal(key: string, ctx: Ctx): Cmd[] {
    const doc = new Doc(ctx.text)
    const cur = this.isVisual ? this.vcursor : ctx.cursor

    if (this.prefix !== null) {
      const p = this.prefix
      this.prefix = null
      return this.completePrefix(p, key, cur, doc, ctx)
    }
    if (key.length === 1 && key >= "0" && key <= "9" && !(key === "0" && this.count === null)) {
      this.count = (this.count ?? 0) * 10 + Number(key)
      return []
    }
    const n = this.count ?? 1

    switch (key) {
      case "<Esc>": {
        const wasVisual = this.isVisual
        this.reset()
        this.mode = "normal"
        return wasVisual ? [{ t: "move", at: doc.clampNormal(cur) }] : []
      }
      case "i": case "a":
        if (this.op === null && !this.isVisual) {
          return this.enterInsert(key === "i" ? cur : cur < doc.contentsEnd(cur) ? doc.next(cur) : cur)
        }
        this.prefix = key // text object
        return []
      case "I": return this.enterInsert(doc.firstNonBlankAt(cur))
      case "A": return this.enterInsert(doc.contentsEnd(cur))
      case "o": {
        const e = doc.contentsEnd(cur)
        return [{ t: "replace", range: R(e, 0), text: "\n" }, ...this.enterInsert(e + 1)]
      }
      case "O": {
        const s = doc.lineStart(cur)
        return [{ t: "replace", range: R(s, 0), text: "\n" }, ...this.enterInsert(s)]
      }
      case "v": case "V": {
        const target: Mode = key === "v" ? "visual" : "visualLine"
        if (this.mode === target) {
          this.mode = "normal"
          this.reset()
          return [{ t: "move", at: doc.clampNormal(cur) }]
        }
        if (!this.isVisual) {
          this.anchor = cur
          this.vcursor = cur
        }
        this.mode = target
        this.count = null
        return [this.selection(doc)]
      }
      case "x": case "X": {
        if (this.isVisual) return this.operate("d", this.selectionRange(doc), this.mode === "visualLine", ctx)
        let lo = cur
        let hi = cur
        for (let k = 0; k < n; k++) {
          if (key === "x" && hi < doc.contentsEnd(cur)) hi = doc.next(hi)
          if (key === "X" && lo > doc.lineStart(cur)) lo = doc.prev(lo)
        }
        if (hi <= lo) {
          this.reset()
          return []
        }
        return this.operate("d", R(lo, hi - lo), false, ctx)
      }
      case "D": case "C":
        return this.operate(key === "D" ? "d" : "c", R(cur, doc.contentsEnd(cur) - cur), false, ctx)
      case "d": case "c": case "y": {
        if (this.isVisual) return this.operate(key, this.selectionRange(doc), this.mode === "visualLine", ctx)
        if (this.op !== null) {
          if (this.op !== key) {
            this.reset()
            return []
          }
          return this.operate(key, doc.linesRangeFrom(cur, n), true, ctx)
        }
        this.op = key
        return []
      }
      case "p": case "P": return this.paste(key === "P", n, cur, doc, ctx)
      case "u": this.reset(); return [{ t: "command", id: "edit.undo" }]
      case "<C-r>": this.reset(); return [{ t: "command", id: "edit.redo" }]
      case ".": return this.repeatLast(ctx)
      case ":":
        this.reset()
        this.mode = "command"
        this.commandLine = ""
        return []
      case "g": case "f": case "t": case "F": case "T": case "r": case "z":
        this.prefix = key
        return []
      case ";": case ",": {
        const last = this.lastFind
        if (!last) break
        return this.move({ kind: "findChar", ch: last.ch, find: key === ";" ? last.find : REVERSE[last.find]!, repeat: true }, cur, doc, ctx)
      }
      case "<C-d>": case "<C-u>": { // half a screen: the cursor and the view move the same number of lines
        if (this.op !== null) break
        const { top, bottom } = this.screen(doc, ctx)
        if (this.count !== null) this.scrollLines = this.count
        const h = this.scrollLines ?? Math.max(1, Math.floor((bottom - top + 1) / 2))
        const down = key === "<C-d>"
        this.count = h
        return [...this.move({ kind: down ? "down" : "up" }, cur, doc, ctx), this.scrollTo(doc, top + (down ? h : -h))]
      }
      case "<C-f>": case "<C-b>": { // a screen, two lines kept
        if (this.op !== null) break
        const { top, bottom } = this.screen(doc, ctx)
        const page = Math.max(1, bottom - top - 1) * n
        return this.scrollKeepingCursor(top + (key === "<C-f>" ? page : -page), bottom - top, cur, doc, ctx)
      }
      case "<C-e>": case "<C-y>": { // the view by lines, the cursor only when it would leave the screen
        if (this.op !== null) break
        const { top, bottom } = this.screen(doc, ctx)
        return this.scrollKeepingCursor(top + (key === "<C-e>" ? n : -n), bottom - top, cur, doc, ctx)
      }
      default: {
        const m = MOTIONS[key]
        if (m) return this.move(m, cur, doc, ctx)
      }
    }
    this.reset()
    return []
  }

  private completePrefix(p: string, key: string, cur: number, doc: Doc, ctx: Ctx): Cmd[] {
    const ch: string | null = key === "<Space>" ? " " : isChar(key) ? key : null
    switch (p) {
      case "g":
        if (key === "g") return this.move({ kind: "gotoLine", defaultLast: false }, cur, doc, ctx)
        if (key === "e" || key === "E") return this.move({ kind: "wordEndBackward", big: key === "E" }, cur, doc, ctx)
        break
      case "f": case "t": case "F": case "T":
        if (ch === null) break
        this.lastFind = { ch, find: p }
        return this.move({ kind: "findChar", ch, find: p }, cur, doc, ctx)
      case "z": { // the cursor line to the top, middle or bottom of the screen
        if (this.op !== null) break
        const at = key === "t" ? doc.lineStart(cur) : key === "z" ? cur : key === "b" ? doc.contentsEnd(cur) : null
        if (at === null) break
        this.reset()
        return [this.scrollCmd(at, key === "t" ? "top" : key === "z" ? "center" : "bottom")]
      }
      case "r": {
        if (ch === null) break
        const n = this.count ?? 1
        let hi = cur
        for (let k = 0; k < n; k++) {
          if (hi >= doc.contentsEnd(cur)) {
            this.reset()
            return []
          }
          hi = doc.next(hi)
        }
        this.reset()
        return [{ t: "replace", range: R(cur, hi - cur), text: ch.repeat(n) }, { t: "move", at: cur + (n - 1) * ch.length }]
      }
      case "i": case "a": {
        if (ch === null) break
        const r = doc.textObject(ch, p === "a", cur)
        if (!r) break
        if (this.op !== null) return this.operate(this.op, r, false, ctx)
        if (this.isVisual) {
          this.anchor = r.location
          this.vcursor = doc.prev(upper(r))
          this.count = null
          return [this.selection(doc)]
        }
        break
      }
    }
    this.reset()
    return []
  }

  private move(m: Motion, cur: number, doc: Doc, ctx: Ctx): Cmd[] {
    const n = this.count ?? 1
    let target = cur
    let inclusive = false
    let linewise = false
    let newSticky: number | null = null

    switch (m.kind) {
      case "left":
        for (let k = 0; k < n; k++) if (target > doc.lineStart(cur)) target = doc.prev(target)
        break
      case "right":
        for (let k = 0; k < n; k++) if (target < doc.contentsEnd(cur)) target = doc.next(target)
        break
      case "up": case "down": {
        const col = this.stickyColumn ?? doc.column(cur)
        let ls = doc.lineStart(cur)
        for (let k = 0; k < n; k++) {
          const next = m.kind === "down" ? doc.nextLineStart(ls) : doc.prevLineStart(ls)
          if (next === null) break
          ls = next
        }
        target = doc.align(Math.min(ls + col, doc.contentsEnd(ls)))
        linewise = true
        newSticky = col
        break
      }
      case "wordForward":
        for (let k = 0; k < n; k++) target = doc.wordForward(target, m.big)
        if (this.op === "c" && doc.cls(cur) !== 0) { // Vim quirk: cw behaves like ce
          target = cur
          for (let k = 0; k < n; k++) target = doc.wordEnd(target, m.big)
          inclusive = true
        } else if (this.op !== null && n === 1 && target > doc.contentsEnd(cur)) { // dw on the last word stops at line end
          target = doc.contentsEnd(cur)
        }
        break
      case "wordBackward":
        for (let k = 0; k < n; k++) target = doc.wordBackward(target, m.big)
        break
      case "wordEnd":
        for (let k = 0; k < n; k++) target = doc.wordEnd(target, m.big)
        inclusive = true
        break
      case "wordEndBackward":
        for (let k = 0; k < n; k++) target = doc.wordEndBackward(target, m.big)
        inclusive = true
        break
      case "column": target = doc.align(Math.min(doc.lineStart(cur) + n - 1, doc.contentsEnd(cur))); break
      case "nonBlankLine": {
        const lines = m.delta === 0 ? n - 1 : n * m.delta
        target = doc.firstNonBlankAt(doc.lineStartOf(Math.max(0, doc.lineOf(cur) + lines)))
        linewise = true
        break
      }
      case "screen": {
        const { top, bottom } = this.screen(doc, ctx)
        const line = m.at === "H" ? Math.min(top + n - 1, bottom) : m.at === "L" ? Math.max(bottom - n + 1, top) : Math.floor((top + bottom) / 2)
        target = doc.firstNonBlankAt(doc.lineStartOf(line))
        linewise = true
        break
      }
      case "matchPair": {
        if (this.count !== null) { // N%: that far into the note
          target = doc.firstNonBlankOfLine(Math.ceil((this.count * (doc.lineOf(doc.length) + 1)) / 100))
          linewise = true
          break
        }
        const match = doc.matchPair(cur)
        if (match === null) {
          this.reset()
          return []
        }
        target = match
        inclusive = true
        break
      }
      case "lineStart": target = doc.lineStart(cur); break
      case "firstNonBlank": target = doc.firstNonBlankAt(cur); break
      case "lineEnd": {
        let ls = doc.lineStart(cur)
        for (let k = 1; k < Math.max(n, 1); k++) {
          const next = doc.nextLineStart(ls)
          if (next !== null) ls = next
        }
        target = doc.contentsEnd(ls)
        break
      }
      case "paragraphForward":
        for (let k = 0; k < n; k++) target = doc.paragraphForward(target)
        break
      case "paragraphBackward":
        for (let k = 0; k < n; k++) target = doc.paragraphBackward(target)
        break
      case "gotoLine":
        if (this.count !== null) target = doc.firstNonBlankOfLine(this.count)
        else target = m.defaultLast ? doc.firstNonBlankAt(doc.length) : doc.firstNonBlankAt(0)
        linewise = true
        break
      case "findChar": {
        let from = cur
        if (m.repeat && m.find === "t" && cur < doc.contentsEnd(cur)) from = doc.next(cur)
        if (m.repeat && m.find === "T" && cur > doc.lineStart(cur)) from = doc.prev(cur)
        const found = doc.find(m.ch, from, m.find === "f" || m.find === "t", n)
        if (found === null) {
          this.reset()
          return []
        }
        switch (m.find) {
          case "f": target = found; inclusive = true; break
          case "t": target = doc.prev(found); inclusive = true; break
          case "F": target = found; break
          default: target = doc.next(found)
        }
        break
      }
    }

    this.stickyColumn = newSticky
    if (this.op !== null) {
      let range: Range
      if (linewise) {
        range = doc.linesRangeCovering(Math.min(cur, target), Math.max(cur, target))
      } else {
        const lo = Math.min(cur, target)
        let hi = Math.max(cur, target)
        if (inclusive) hi = Math.min(doc.next(hi), doc.length)
        range = R(lo, hi - lo)
      }
      return this.operate(this.op, range, linewise, ctx)
    }
    this.count = null
    if (this.isVisual) {
      this.vcursor = doc.clampNormal(target)
      return [this.selection(doc)]
    }
    return [{ t: "move", at: doc.clampNormal(target) }]
  }

  // MARK: Operators

  private operate(o: string, range: Range, linewise: boolean, ctx: Ctx): Cmd[] {
    const doc = new Doc(ctx.text)
    let r = range
    let yanked = ctx.text.slice(r.location, upper(r))
    if (linewise && !yanked.endsWith("\n")) yanked += "\n"
    const cmds: Cmd[] = [{ t: "clipboard", text: yanked }]
    this.reset()
    this.mode = "normal"

    switch (o) {
      case "y":
        cmds.push({ t: "move", at: doc.clampNormal(r.location) })
        break
      case "d": {
        if (linewise && upper(r) === doc.length && r.location > 0) r = R(r.location - 1, r.length + 1) // deleting the last line eats the newline before it
        cmds.push({ t: "replace", range: r, text: "" })
        const after = new Doc(applying(ctx, cmds).text)
        const at = Math.min(r.location, Math.max(after.length, 0))
        cmds.push({ t: "move", at: linewise ? after.firstNonBlankAt(at) : after.clampNormal(at) })
        break
      }
      case "c": {
        if (linewise) { // cc keeps the line: clear its contents, insert at line start
          const last = Math.max(r.location, doc.prev(upper(r)))
          const ls = doc.lineStart(r.location)
          r = R(ls, doc.contentsEnd(last) - ls)
        }
        cmds.push({ t: "replace", range: r, text: "" })
        cmds.push(...this.enterInsert(r.location))
        break
      }
    }
    return cmds
  }

  private paste(before: boolean, n: number, cur: number, doc: Doc, ctx: Ctx): Cmd[] {
    this.reset()
    if (ctx.clipboard === "") return []
    const text = ctx.clipboard.repeat(n)
    if (text.endsWith("\n")) { // linewise
      if (before) {
        const at = doc.lineStart(cur)
        const cmds: Cmd[] = [{ t: "replace", range: R(at, 0), text }]
        return [...cmds, { t: "move", at: new Doc(applying(ctx, cmds).text).firstNonBlankAt(at) }]
      }
      let at = doc.lineEnd(cur)
      let insert = text
      if (at === doc.length && (doc.length === 0 || doc.char(doc.length - 1) !== 10)) {
        insert = "\n" + text.slice(0, -1)
        at = doc.length
      }
      const cmds: Cmd[] = [{ t: "replace", range: R(at, 0), text: insert }]
      const lineStart = insert.startsWith("\n") ? at + 1 : at
      return [...cmds, { t: "move", at: new Doc(applying(ctx, cmds).text).firstNonBlankAt(lineStart) }]
    }
    const at = before || cur >= doc.contentsEnd(cur) ? cur : doc.next(cur)
    const cmds: Cmd[] = [{ t: "replace", range: R(at, 0), text }]
    return [...cmds, { t: "move", at: new Doc(applying(ctx, cmds).text).prev(at + text.length) }]
  }

  private repeatLast(ctx: Ctx): Cmd[] {
    this.reset()
    const last = this.lastChange
    if (!last) return []
    this.replaying = true
    try {
      let c = ctx
      let cmds: Cmd[] = []
      for (const key of last.keys) {
        const out = this.mode === "insert" ? this.handleInsert(key, c) : this.handleNormal(key, c)
        cmds = cmds.concat(out)
        c = applying(c, out)
      }
      if (this.mode === "insert") {
        const typed: Cmd[] = [{ t: "replace", range: R(c.cursor, 0), text: last.inserted }]
        cmds = cmds.concat(typed)
        c = applying(c, typed)
        cmds = cmds.concat(this.handleInsert("<Esc>", c))
      }
      return cmds
    } finally {
      this.replaying = false
    }
  }

  // MARK: Helpers

  private enterInsert(at: number): Cmd[] {
    this.reset()
    this.mode = "insert"
    this.insertStart = at
    return [{ t: "move", at }]
  }

  private reset() {
    this.count = null
    this.op = null
    this.prefix = null
  }

  private selectionRange(doc: Doc): Range {
    const lo = Math.min(this.anchor, this.vcursor)
    const hi = Math.max(this.anchor, this.vcursor)
    if (this.mode === "visualLine") {
      const s = doc.lineStart(lo)
      return R(s, doc.lineEnd(hi) - s)
    }
    return R(lo, Math.min(doc.next(hi), doc.length) - lo)
  }

  private selection(doc: Doc): Cmd { return { t: "select", range: this.selectionRange(doc) } }

  /** Lines on screen (0-based): the first that starts on it (a wrapped line cut at the top doesn't) and the last. */
  private screen(doc: Doc, ctx: Ctx): { top: number; bottom: number } {
    const [start, end] = ctx.visible
    const bottom = doc.lineOf(Math.max(start, end - 1))
    const first = doc.lineOf(start)
    return { top: start > doc.lineStart(start) && first < bottom ? first + 1 : first, bottom }
  }

  private scrollCmd(offset: number, at: "top" | "center" | "bottom"): Cmd { return { t: "command", id: `edit.scroll ${offset} ${at}` } }
  private scrollTo(doc: Doc, top: number): Cmd { return this.scrollCmd(doc.lineStartOf(Math.max(0, top)), "top") }

  /** Line `top` to the top of the screen; the cursor moves only as far as it takes to stay within `rows` below it. */
  private scrollKeepingCursor(top: number, rows: number, cur: number, doc: Doc, ctx: Ctx): Cmd[] {
    top = Math.min(Math.max(0, top), doc.lineOf(doc.length))
    const line = doc.lineOf(cur)
    const off = line < top ? top - line : line > top + rows ? top + rows - line : 0
    if (off === 0) this.reset()
    else this.count = Math.abs(off)
    return [...(off === 0 ? [] : this.move({ kind: off > 0 ? "down" : "up" }, cur, doc, ctx)), this.scrollTo(doc, top)]
  }
}

/** A printable key is one code point; everything else is a `<Name>` token. */
function isChar(key: string): boolean { return [...key].length === 1 }

// MARK: - Plugin

/** What a new vimrc starts as: a commented reference, like `:help` in a file. */
const VIMRC_TEMPLATE = `" fulgurite Vim config. Saved changes apply immediately.
" Normal-mode mappings to ex commands:  nmap / nnoremap <keys> :<command><CR>   and   nunmap <keys>
" Keys: single characters, <Space>, <CR>, <leader> (set with: let mapleader = " ")
"
" Ex commands and their default keys:
"   :find      /          find in this note (the find bar; ⌘F / Ctrl+F does the same)
"   :findnext  n          next match             :findprev  N          previous match
"   :search    <Space>f   search all notes (⌘⇧F / Ctrl+E)
"   :open      <Space>o   open a note by title (⌘⇧O / Ctrl+O)
"   :new       <Space>n   new note (⌘N / Ctrl+N)
"   :workspace            new workspace (⌘⇧N / Ctrl+Shift+N)
"   :commands  <Space>p   the command palette (⌘P / Ctrl+P)
"   :goto      gf         open the [[link]] under the cursor (⌘-click / Ctrl+click does the same)
"   :w  :q  :wq           save / close / both
" Any command in the palette by its id, e.g.  :fulgurite.math:insert-inline  or  :view.toggleSidebar
"
" Example: nnoremap <leader>g :goto<CR>
`

const plugin: Plugin = {
  configFile: { name: "vimrc", template: VIMRC_TEMPLATE },
  onLoad(ctx: PluginContext) {
    let mappings = DEFAULT_MAPPINGS
    const fresh = () => {
      const e = new VimEngine()
      e.mappings = mappings
      return e
    }
    let engine = fresh()
    ctx.events.on("buffer.opened", () => { engine = fresh() }) // new buffer: fresh state, like switching Vim buffers
    plugin.onConfig = (text) => {
      mappings = parseVimrc(text)
      engine.mappings = mappings
    }
    ctx.editor.registerExtension({
      priority: 100, // normal mode takes keys before Tables or Emoji see them
      onKey(key, view) {
        if (engine.mode === "insert" && key !== "<Esc>") return false
        if (engine.mode === "normal" && view.selection) engine.adoptSelection(view.selection, view.text)
        const visible = view.visible ?? [0, view.text.length] // an app from before `visible`
        const cmds = engine.handle(key, { text: view.text, cursor: view.cursor, clipboard: view.clipboard, visible })
        for (const c of cmds) {
          switch (c.t) {
            case "move": view.moveCursor(c.at); break
            case "select": view.select(c.range.location, upper(c.range)); break
            case "replace": view.replace(c.range.location, upper(c.range), c.text); break
            case "clipboard": view.setClipboard(c.text); break
            case "command": ctx.commands.execute(c.id); break
            case "notice": ctx.notice(c.text); break
          }
        }
        return true
      },
      status: () => engine.status,
    })
  },
}

export default plugin
