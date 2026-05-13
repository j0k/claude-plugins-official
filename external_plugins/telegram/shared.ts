/**
 * Shared types, paths, and queue utilities used by both daemon.ts and server.ts.
 *
 * Architecture: decoupled daemon (holds Telegram bot, polls Telegram, owns the
 * token) ←→ file-based queue ←→ MCP plugin (Claude Code-facing, pure tools, no
 * claude/channel capability). Built to bypass issue #57372 by avoiding the
 * channel-capable code path in the Claude Code host entirely.
 *
 * Queue protocol (all paths under TELEGRAM_STATE_DIR):
 *
 *   queue/inbox/      — new messages from Telegram (one JSON file each)
 *                       filename: {iso}_{chat_id}_{msg_id}.json
 *   queue/outbox/     — outbound work for daemon (send/react/edit)
 *                       filename: {iso}_{nanos}.json
 *   queue/processed/  — archive of inbox messages already consumed by plugin
 *   state.json        — last_read tracking, daemon info
 *   events.jsonl      — structured event log (both processes append)
 *   daemon.pid        — daemon's PID (advisory lock against double-start)
 *   daemon.heartbeat  — updated every 2s by daemon (epoch ms), liveness probe
 *
 * Atomic writes: every file is written to .tmp and renamed. Readers ignore
 * .tmp files. This way the consumer never sees a half-written JSON.
 */

import { mkdirSync, writeFileSync, renameSync, readFileSync, readdirSync, statSync, appendFileSync, rmSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { randomBytes } from 'crypto'

export const STATE_DIR =
  process.env.TELEGRAM_STATE_DIR ?? join(homedir(), '.claude', 'channels', 'telegram')

export const QUEUE_DIR = join(STATE_DIR, 'queue')
export const INBOX_DIR = join(QUEUE_DIR, 'inbox')
export const OUTBOX_DIR = join(QUEUE_DIR, 'outbox')
export const PROCESSED_DIR = join(QUEUE_DIR, 'processed')
export const PROCESSED_INBOX_DIR = join(PROCESSED_DIR, 'inbox')
export const PROCESSED_OUTBOX_DIR = join(PROCESSED_DIR, 'outbox')
export const ATTACHMENTS_DIR = join(STATE_DIR, 'attachments')

export const STATE_FILE = join(STATE_DIR, 'state.json')
export const EVENTS_FILE = join(STATE_DIR, 'events.jsonl')
export const DAEMON_PID_FILE = join(STATE_DIR, 'daemon.pid')
export const DAEMON_HEARTBEAT_FILE = join(STATE_DIR, 'daemon.heartbeat')
export const ENV_FILE = join(STATE_DIR, '.env')
export const ACCESS_FILE = join(STATE_DIR, 'access.json')

export const LOGS_DIR = join(STATE_DIR, 'logs')
export const DAEMON_LOGS_DIR = join(LOGS_DIR, 'daemon')
export const PLUGIN_LOGS_DIR = join(LOGS_DIR, 'plugin')

// ─── Types ────────────────────────────────────────────────────────────────

export type AttachmentMeta = {
  kind: 'document' | 'voice' | 'audio' | 'video' | 'video_note' | 'sticker'
  file_id: string
  size?: number
  mime?: string
  name?: string
}

export type InboundMessage = {
  /** Schema version. Bump on breaking changes. */
  v: 1
  /** Telegram message_id as a string. */
  id: string
  chat_id: string
  user: string
  user_id: string
  /** ISO 8601 UTC. From Telegram's message.date (converted). */
  ts: string
  content: string
  type: 'text' | 'photo' | 'document' | 'voice' | 'audio' | 'video' | 'video_note' | 'sticker'
  /** Local file path if daemon downloaded an inline image (photos only). */
  image_path?: string
  /** Non-photo attachment meta. Use download_attachment tool to fetch. */
  attachment?: AttachmentMeta
  /** When daemon wrote this to inbox. ISO 8601 UTC. */
  received_at: string
}

export type OutboxItem =
  | {
      v: 1
      id: string
      type: 'send_message'
      chat_id: string
      text: string
      reply_to?: string
      files?: string[]
      format?: 'text' | 'markdownv2'
      queued_at: string
    }
  | {
      v: 1
      id: string
      type: 'react'
      chat_id: string
      message_id: string
      emoji: string
      queued_at: string
    }
  | {
      v: 1
      id: string
      type: 'edit_message'
      chat_id: string
      message_id: string
      text: string
      format?: 'text' | 'markdownv2'
      queued_at: string
    }

export type OutboxResult = {
  v: 1
  /** ID of the outbox item that was processed. */
  outbox_id: string
  ok: boolean
  /** For send_message: message_ids of sent parts. */
  sent_ids?: number[]
  error?: string
  /** When daemon finished processing. */
  completed_at: string
}

export type ChannelState = {
  v: 1
  /** ISO 8601 — when plugin last called read_inbox or wait_for_message. */
  last_read_at?: string
  /** Per-chat last_read timestamp. Lets Claude resume "where I left off in chat X". */
  last_read_per_chat: Record<string, string>
  daemon?: {
    pid: number
    started_at: string
    username?: string
  }
}

export type EventRecord = {
  ts: string
  source: 'daemon' | 'plugin' | 'tool'
  level: 'debug' | 'info' | 'warn' | 'error'
  event: string
  [key: string]: unknown
}

// ─── Setup ────────────────────────────────────────────────────────────────

export function ensureDirs(): void {
  for (const d of [
    STATE_DIR,
    QUEUE_DIR,
    INBOX_DIR,
    OUTBOX_DIR,
    PROCESSED_DIR,
    PROCESSED_INBOX_DIR,
    PROCESSED_OUTBOX_DIR,
    ATTACHMENTS_DIR,
    LOGS_DIR,
    DAEMON_LOGS_DIR,
    PLUGIN_LOGS_DIR,
  ]) {
    try {
      mkdirSync(d, { recursive: true, mode: 0o700 })
    } catch {}
  }
}

// ─── Atomic write helper ──────────────────────────────────────────────────

/**
 * Write JSON to path atomically: write .tmp, then rename. Readers should
 * filter to .json files only so they never see a half-written file.
 */
export function writeJsonAtomic(path: string, data: unknown): void {
  const tmp = `${path}.tmp.${randomBytes(4).toString('hex')}`
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, path)
}

export function readJsonSafe<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch {
    return null
  }
}

// ─── Filename utilities ───────────────────────────────────────────────────

/** ISO timestamp, file-system-safe (colons → dashes). */
function fileSafeIso(d: Date = new Date()): string {
  return d.toISOString().replace(/[:.]/g, '-')
}

export function inboxFilename(chat_id: string, msg_id: string): string {
  return `${fileSafeIso()}_${chat_id}_${msg_id}.json`
}

export function outboxFilename(): string {
  const nanos = process.hrtime.bigint().toString().slice(-9)
  return `${fileSafeIso()}_${nanos}.json`
}

// ─── State file ───────────────────────────────────────────────────────────

export function loadState(): ChannelState {
  const existing = readJsonSafe<ChannelState>(STATE_FILE)
  if (existing && existing.v === 1) return existing
  return { v: 1, last_read_per_chat: {} }
}

export function saveState(s: ChannelState): void {
  ensureDirs()
  writeJsonAtomic(STATE_FILE, s)
}

export function markChatRead(chat_id: string, ts: string = new Date().toISOString()): void {
  const s = loadState()
  s.last_read_at = ts
  s.last_read_per_chat[chat_id] = ts
  saveState(s)
}

// ─── Events log ───────────────────────────────────────────────────────────

export function emitEvent(
  source: 'daemon' | 'plugin' | 'tool',
  level: 'debug' | 'info' | 'warn' | 'error',
  event: string,
  extra: Record<string, unknown> = {},
): void {
  ensureDirs()
  const rec: EventRecord = {
    ts: new Date().toISOString(),
    source,
    level,
    event,
    ...extra,
  }
  try {
    appendFileSync(EVENTS_FILE, JSON.stringify(rec) + '\n')
  } catch {
    // Events log is best-effort; never crash the producer on log failures.
  }
}

// ─── Queue operations ─────────────────────────────────────────────────────

/** List queue files, sorted oldest-first by filename (filenames are timestamped). */
export function listQueueFiles(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter(f => f.endsWith('.json'))
      .sort()
  } catch {
    return []
  }
}

export function writeInbox(msg: InboundMessage): void {
  ensureDirs()
  const path = join(INBOX_DIR, inboxFilename(msg.chat_id, msg.id))
  writeJsonAtomic(path, msg)
  emitEvent('daemon', 'info', 'inbox.write', {
    chat_id: msg.chat_id,
    msg_id: msg.id,
    user: msg.user,
    type: msg.type,
  })
}

export function writeOutbox(item: OutboxItem): string {
  ensureDirs()
  const fname = outboxFilename()
  const path = join(OUTBOX_DIR, fname)
  writeJsonAtomic(path, item)
  emitEvent('plugin', 'info', 'outbox.write', {
    outbox_id: item.id,
    type: item.type,
    chat_id: item.chat_id,
  })
  return path
}

export function moveToProcessed(srcPath: string, kind: 'inbox' | 'outbox'): void {
  const dest = kind === 'inbox' ? PROCESSED_INBOX_DIR : PROCESSED_OUTBOX_DIR
  try {
    const base = srcPath.split(/[\\/]/).pop()!
    renameSync(srcPath, join(dest, base))
  } catch {
    // Best-effort archival. If rename fails, just unlink.
    try {
      rmSync(srcPath, { force: true })
    } catch {}
  }
}

// ─── Daemon liveness ──────────────────────────────────────────────────────

export function daemonHeartbeatAgeMs(): number | null {
  try {
    const st = statSync(DAEMON_HEARTBEAT_FILE)
    return Date.now() - st.mtimeMs
  } catch {
    return null
  }
}

export function isDaemonAlive(maxAgeMs: number = 10_000): boolean {
  const age = daemonHeartbeatAgeMs()
  if (age == null) return false
  return age < maxAgeMs
}

export function getDaemonPid(): number | null {
  try {
    const n = parseInt(readFileSync(DAEMON_PID_FILE, 'utf8').trim(), 10)
    return Number.isFinite(n) && n > 1 ? n : null
  } catch {
    return null
  }
}

// ─── Env loading ──────────────────────────────────────────────────────────

export function loadEnvFile(): void {
  try {
    for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
      const m = line.match(/^(\w+)=(.*)$/)
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2]
    }
  } catch {}
}

// ─── Outbound ID generator ────────────────────────────────────────────────

let outboxCounter = 0
export function genOutboxId(): string {
  outboxCounter++
  return `out_${Date.now()}_${outboxCounter}_${randomBytes(2).toString('hex')}`
}
