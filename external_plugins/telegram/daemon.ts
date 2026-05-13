#!/usr/bin/env bun
/**
 * Telegram daemon — independent bot process.
 *
 * Lives outside the Claude Code lifecycle. Holds the bot token, long-polls
 * Telegram, writes inbound messages to queue/inbox/, watches queue/outbox/
 * for outbound work. Survives Claude Code restarts and /reload-plugins.
 *
 * Designed to be started by Windows Task Scheduler at login, or manually
 * via start-daemon.ps1, or on-demand by the MCP plugin's start_daemon tool.
 *
 * One instance per machine (PID-file lock + Telegram's one-consumer rule).
 */

import { Bot, GrammyError, InlineKeyboard, InputFile, type Context } from 'grammy'
import type { ReactionTypeEmoji } from 'grammy/types'
import { execFileSync } from 'child_process'
import { randomBytes } from 'crypto'
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  appendFileSync,
  readdirSync,
  rmSync,
  statSync,
  renameSync,
  realpathSync,
  watch,
} from 'fs'
import { join, extname, sep } from 'path'
import {
  STATE_DIR,
  ATTACHMENTS_DIR,
  OUTBOX_DIR,
  DAEMON_LOGS_DIR,
  DAEMON_PID_FILE,
  DAEMON_HEARTBEAT_FILE,
  ACCESS_FILE,
  ensureDirs,
  loadEnvFile,
  writeInbox,
  writeJsonAtomic,
  readJsonSafe,
  listQueueFiles,
  moveToProcessed,
  emitEvent,
  loadState,
  saveState,
  type InboundMessage,
  type OutboxItem,
  type OutboxResult,
  type AttachmentMeta,
} from './shared.ts'

// ─── Boot ─────────────────────────────────────────────────────────────────

ensureDirs()
loadEnvFile()

const TOKEN = process.env.TELEGRAM_BOT_TOKEN
const WEB_PORT = parseInt(process.env.TELEGRAM_WEB_PORT ?? '9999', 10)
const WEB_HOST = process.env.TELEGRAM_WEB_HOST ?? '127.0.0.1'

if (!TOKEN) {
  process.stderr.write(
    `telegram daemon: TELEGRAM_BOT_TOKEN required\n` +
    `  set in ${join(STATE_DIR, '.env')}\n`,
  )
  process.exit(1)
}

// ─── Logging ──────────────────────────────────────────────────────────────

const pad = (n: number, w = 2) => String(n).padStart(w, '0')
const tsLocal = () => {
  const d = new Date()
  const off = -d.getTimezoneOffset()
  const sign = off >= 0 ? '+' : '-'
  const oh = pad(Math.floor(Math.abs(off) / 60))
  const om = pad(Math.abs(off) % 60)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}${sign}${oh}:${om}`
}

const startTime = new Date()
const LOG_FILE = join(
  DAEMON_LOGS_DIR,
  `daemon_${startTime.getFullYear()}_${pad(startTime.getMonth() + 1)}_${pad(startTime.getDate())}__${pad(startTime.getHours())}_${pad(startTime.getMinutes())}_${process.pid}.log`,
)

const origStderr = process.stderr.write.bind(process.stderr)
;(process.stderr as any).write = (chunk: any, ...rest: any[]) => {
  try {
    const text = typeof chunk === 'string' ? chunk : chunk.toString()
    appendFileSync(LOG_FILE, `[${tsLocal()}] ${text}`)
  } catch {}
  return (origStderr as any)(chunk, ...rest)
}

function log(msg: string): void {
  process.stderr.write(`telegram daemon: ${msg}\n`)
}

// ─── PID lock ─────────────────────────────────────────────────────────────

// Telegram allows exactly one getUpdates consumer per token. Try to take
// the slot. If another daemon holds the PID file and is alive, exit.
try {
  const existing = readFileSync(DAEMON_PID_FILE, 'utf8').trim()
  const stalePid = parseInt(existing, 10)
  if (Number.isFinite(stalePid) && stalePid > 1 && stalePid !== process.pid) {
    try {
      process.kill(stalePid, 0)
      // Process is alive. Refuse to start.
      log(`another daemon is running (pid=${stalePid}). Exiting.`)
      process.exit(2)
    } catch {
      log(`stale PID file (pid=${stalePid} is dead), claiming slot`)
    }
  }
} catch {
  // No PID file — first start.
}
writeFileSync(DAEMON_PID_FILE, String(process.pid))
log(`started, pid=${process.pid}, log=${LOG_FILE}`)
emitEvent('daemon', 'info', 'started', { pid: process.pid, log_file: LOG_FILE })

// ─── Heartbeat ────────────────────────────────────────────────────────────

setInterval(() => {
  try {
    writeFileSync(DAEMON_HEARTBEAT_FILE, String(Date.now()))
  } catch {}
}, 2000).unref()

// ─── Shutdown handling ────────────────────────────────────────────────────

let shuttingDown = false
function shutdown(reason: string): void {
  if (shuttingDown) return
  shuttingDown = true
  log(`shutting down (${reason})`)
  emitEvent('daemon', 'info', 'shutting_down', { reason })
  try {
    const cur = parseInt(readFileSync(DAEMON_PID_FILE, 'utf8'), 10)
    if (cur === process.pid) rmSync(DAEMON_PID_FILE, { force: true })
  } catch {}
  setTimeout(() => process.exit(0), 2000)
  void Promise.resolve(bot.stop()).finally(() => process.exit(0))
}
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGBREAK'] as const) {
  try {
    process.on(sig as any, () => shutdown(sig))
  } catch {}
}
process.on('uncaughtException', err => {
  log(`uncaught exception: ${err}`)
  emitEvent('daemon', 'error', 'uncaught_exception', { error: String(err) })
})
process.on('unhandledRejection', err => {
  log(`unhandled rejection: ${err}`)
  emitEvent('daemon', 'error', 'unhandled_rejection', { error: String(err) })
})

// ─── Access control (ported from old server.ts) ──────────────────────────

type PendingEntry = {
  senderId: string
  chatId: string
  createdAt: number
  expiresAt: number
  replies: number
}

type GroupPolicy = {
  requireMention: boolean
  allowFrom: string[]
}

type Access = {
  dmPolicy: 'pairing' | 'allowlist' | 'disabled'
  allowFrom: string[]
  groups: Record<string, GroupPolicy>
  pending: Record<string, PendingEntry>
  mentionPatterns?: string[]
  ackReaction?: string
}

function defaultAccess(): Access {
  return { dmPolicy: 'pairing', allowFrom: [], groups: {}, pending: {} }
}

function readAccessFile(): Access {
  try {
    const raw = readFileSync(ACCESS_FILE, 'utf8')
    const parsed = JSON.parse(raw) as Partial<Access>
    return {
      dmPolicy: parsed.dmPolicy ?? 'pairing',
      allowFrom: parsed.allowFrom ?? [],
      groups: parsed.groups ?? {},
      pending: parsed.pending ?? {},
      mentionPatterns: parsed.mentionPatterns,
      ackReaction: parsed.ackReaction,
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return defaultAccess()
    try {
      renameSync(ACCESS_FILE, `${ACCESS_FILE}.corrupt-${Date.now()}`)
    } catch {}
    log('access.json is corrupt, moved aside. Starting fresh.')
    return defaultAccess()
  }
}

function saveAccess(a: Access): void {
  writeJsonAtomic(ACCESS_FILE, a)
}

function pruneExpired(a: Access): boolean {
  const now = Date.now()
  let changed = false
  for (const [code, p] of Object.entries(a.pending)) {
    if (p.expiresAt < now) {
      delete a.pending[code]
      changed = true
    }
  }
  return changed
}

type GateResult =
  | { action: 'deliver'; access: Access }
  | { action: 'drop' }
  | { action: 'pair'; code: string; isResend: boolean }

function gate(ctx: Context): GateResult {
  const access = readAccessFile()
  if (pruneExpired(access)) saveAccess(access)
  if (access.dmPolicy === 'disabled') return { action: 'drop' }

  const from = ctx.from
  if (!from) return { action: 'drop' }
  const senderId = String(from.id)
  const chatType = ctx.chat?.type

  if (chatType === 'private') {
    if (access.allowFrom.includes(senderId)) return { action: 'deliver', access }
    if (access.dmPolicy === 'allowlist') return { action: 'drop' }

    for (const [code, p] of Object.entries(access.pending)) {
      if (p.senderId === senderId) {
        if ((p.replies ?? 1) >= 2) return { action: 'drop' }
        p.replies = (p.replies ?? 1) + 1
        saveAccess(access)
        return { action: 'pair', code, isResend: true }
      }
    }
    if (Object.keys(access.pending).length >= 3) return { action: 'drop' }
    const code = randomBytes(3).toString('hex')
    const now = Date.now()
    access.pending[code] = {
      senderId,
      chatId: String(ctx.chat!.id),
      createdAt: now,
      expiresAt: now + 60 * 60 * 1000,
      replies: 1,
    }
    saveAccess(access)
    return { action: 'pair', code, isResend: false }
  }

  if (chatType === 'group' || chatType === 'supergroup') {
    const groupId = String(ctx.chat!.id)
    const policy = access.groups[groupId]
    if (!policy) return { action: 'drop' }
    const groupAllowFrom = policy.allowFrom ?? []
    const requireMention = policy.requireMention ?? true
    if (groupAllowFrom.length > 0 && !groupAllowFrom.includes(senderId)) {
      return { action: 'drop' }
    }
    if (requireMention && !isMentioned(ctx, access.mentionPatterns)) {
      return { action: 'drop' }
    }
    return { action: 'deliver', access }
  }

  return { action: 'drop' }
}

function isMentioned(ctx: Context, extraPatterns?: string[]): boolean {
  const entities = ctx.message?.entities ?? ctx.message?.caption_entities ?? []
  const text = ctx.message?.text ?? ctx.message?.caption ?? ''
  for (const e of entities) {
    if (e.type === 'mention') {
      const m = text.slice(e.offset, e.offset + e.length)
      if (m.toLowerCase() === `@${botUsername}`.toLowerCase()) return true
    }
    if (e.type === 'text_mention' && e.user?.is_bot && e.user.username === botUsername) {
      return true
    }
  }
  if (ctx.message?.reply_to_message?.from?.username === botUsername) return true
  for (const pat of extraPatterns ?? []) {
    try {
      if (new RegExp(pat, 'i').test(text)) return true
    } catch {}
  }
  return false
}

// ─── Bot ──────────────────────────────────────────────────────────────────

const bot = new Bot(TOKEN)
let botUsername = ''

function safeName(s: string | undefined): string | undefined {
  return s?.replace(/[<>\[\]\r\n;]/g, '_')
}

async function downloadAttachment(file_id: string, ext: string, uniqueId?: string): Promise<string | undefined> {
  try {
    const file = await bot.api.getFile(file_id)
    if (!file.file_path) return undefined
    const url = `https://api.telegram.org/file/bot${TOKEN}/${file.file_path}`
    const res = await fetch(url)
    if (!res.ok) return undefined
    const buf = Buffer.from(await res.arrayBuffer())
    const safeExt = (ext || 'bin').replace(/[^a-zA-Z0-9]/g, '') || 'bin'
    const safeUid = (uniqueId ?? randomBytes(4).toString('hex')).replace(/[^a-zA-Z0-9_-]/g, '')
    const path = join(ATTACHMENTS_DIR, `${Date.now()}-${safeUid}.${safeExt}`)
    writeFileSync(path, buf)
    return path
  } catch (err) {
    log(`attachment download failed: ${err}`)
    return undefined
  }
}

async function handleInbound(
  ctx: Context,
  content: string,
  type: InboundMessage['type'],
  imagePath?: string,
  attachment?: AttachmentMeta,
): Promise<void> {
  const from = ctx.from
  const chatId = String(ctx.chat?.id ?? '?')
  emitEvent('daemon', 'info', 'tg.received', {
    chat_id: chatId,
    user: from?.username ?? String(from?.id ?? '?'),
    type,
    preview: content.slice(0, 80),
  })

  const result = gate(ctx)

  if (result.action === 'drop') {
    emitEvent('daemon', 'debug', 'tg.dropped', { chat_id: chatId, reason: 'gate' })
    return
  }

  if (result.action === 'pair') {
    const lead = result.isResend ? 'Still pending' : 'Pairing required'
    await ctx.reply(
      `${lead} — run in Claude Code:\n\n/telegram:access pair ${result.code}`,
    )
    return
  }

  // Optional ack reaction (configurable in access.json).
  if (result.access.ackReaction && ctx.message?.message_id != null) {
    void bot.api
      .setMessageReaction(chatId, ctx.message.message_id, [
        { type: 'emoji', emoji: result.access.ackReaction as ReactionTypeEmoji['emoji'] },
      ])
      .catch(() => {})
  }

  const msg: InboundMessage = {
    v: 1,
    id: String(ctx.message?.message_id ?? Date.now()),
    chat_id: chatId,
    user: from?.username ?? String(from?.id ?? 'unknown'),
    user_id: String(from?.id ?? ''),
    ts: new Date((ctx.message?.date ?? 0) * 1000).toISOString(),
    content,
    type,
    received_at: new Date().toISOString(),
    ...(imagePath ? { image_path: imagePath } : {}),
    ...(attachment ? { attachment } : {}),
  }

  writeInbox(msg)
}

bot.command('start', async ctx => {
  if (ctx.chat?.type !== 'private') return
  await ctx.reply(
    `This bot bridges Telegram to a Claude Code session.\n\n` +
    `To pair:\n` +
    `1. DM me anything — you'll get a 6-char code\n` +
    `2. In Claude Code: /telegram:access pair <code>\n\n` +
    `After that, DMs here reach that session.`,
  )
})

bot.command('help', async ctx => {
  if (ctx.chat?.type !== 'private') return
  const access = readAccessFile()
  const isPaired = ctx.from && access.allowFrom.includes(String(ctx.from.id))
  let extra = ''
  if (isPaired) {
    extra =
      `\n\n/status — pairing state\n` +
      `/queue — show queue counts\n` +
      `/daemon — daemon status\n` +
      `/web — show web UI URL`
  }
  await ctx.reply(
    `Messages here route to a paired Claude Code session through a local daemon.${extra}`,
  )
})

bot.command('status', async ctx => {
  if (ctx.chat?.type !== 'private') return
  const access = readAccessFile()
  const senderId = String(ctx.from?.id ?? '')
  if (access.allowFrom.includes(senderId)) {
    const name = ctx.from!.username ? `@${ctx.from!.username}` : senderId
    await ctx.reply(`Paired as ${name}.`)
    return
  }
  for (const [code, p] of Object.entries(access.pending)) {
    if (p.senderId === senderId) {
      await ctx.reply(`Pending — run in Claude Code:\n\n/telegram:access pair ${code}`)
      return
    }
  }
  await ctx.reply('Not paired. Send me a message to get a pairing code.')
})

bot.command('queue', async ctx => {
  if (ctx.chat?.type !== 'private') return
  const access = readAccessFile()
  if (!access.allowFrom.includes(String(ctx.from?.id ?? ''))) return
  const inbox = listQueueFiles(join(STATE_DIR, 'queue', 'inbox')).length
  const outbox = listQueueFiles(OUTBOX_DIR).length
  const state = loadState()
  const lastRead = state.last_read_at ?? 'never'
  await ctx.reply(
    `📊 Queue\n\n` +
    `inbox: ${inbox} pending\n` +
    `outbox: ${outbox} pending\n` +
    `last_read: ${lastRead}\n`,
  )
})

bot.command('daemon', async ctx => {
  if (ctx.chat?.type !== 'private') return
  const access = readAccessFile()
  if (!access.allowFrom.includes(String(ctx.from?.id ?? ''))) return
  const uptime = process.uptime()
  await ctx.reply(
    `🤖 Daemon\n\n` +
    `pid: ${process.pid}\n` +
    `uptime: ${Math.floor(uptime / 60)}m ${Math.floor(uptime % 60)}s\n` +
    `bot: @${botUsername}\n` +
    `web: http://${WEB_HOST}:${WEB_PORT}\n` +
    `log: ${LOG_FILE}\n`,
  )
})

bot.command('web', async ctx => {
  if (ctx.chat?.type !== 'private') return
  const access = readAccessFile()
  if (!access.allowFrom.includes(String(ctx.from?.id ?? ''))) return
  await ctx.reply(`Web UI: http://${WEB_HOST}:${WEB_PORT}`)
})

bot.on('message:text', async ctx => {
  await handleInbound(ctx, ctx.message.text, 'text')
})

bot.on('message:photo', async ctx => {
  const photos = ctx.message.photo
  const best = photos[photos.length - 1]
  const caption = ctx.message.caption ?? '(photo)'
  const ext = 'jpg'
  const imagePath = await downloadAttachment(best.file_id, ext, best.file_unique_id)
  await handleInbound(ctx, caption, 'photo', imagePath)
})

bot.on('message:document', async ctx => {
  const doc = ctx.message.document
  await handleInbound(ctx, ctx.message.caption ?? `(document: ${safeName(doc.file_name) ?? 'file'})`, 'document', undefined, {
    kind: 'document',
    file_id: doc.file_id,
    size: doc.file_size,
    mime: doc.mime_type,
    name: safeName(doc.file_name),
  })
})

bot.on('message:voice', async ctx => {
  const voice = ctx.message.voice
  await handleInbound(ctx, ctx.message.caption ?? '(voice)', 'voice', undefined, {
    kind: 'voice',
    file_id: voice.file_id,
    size: voice.file_size,
    mime: voice.mime_type,
  })
})

bot.on('message:audio', async ctx => {
  const audio = ctx.message.audio
  await handleInbound(ctx, ctx.message.caption ?? `(audio: ${safeName(audio.title) ?? safeName(audio.file_name) ?? 'audio'})`, 'audio', undefined, {
    kind: 'audio',
    file_id: audio.file_id,
    size: audio.file_size,
    mime: audio.mime_type,
    name: safeName(audio.file_name),
  })
})

bot.on('message:video', async ctx => {
  const video = ctx.message.video
  await handleInbound(ctx, ctx.message.caption ?? '(video)', 'video', undefined, {
    kind: 'video',
    file_id: video.file_id,
    size: video.file_size,
    mime: video.mime_type,
    name: safeName(video.file_name),
  })
})

bot.on('message:video_note', async ctx => {
  const vn = ctx.message.video_note
  await handleInbound(ctx, '(video note)', 'video_note', undefined, {
    kind: 'video_note',
    file_id: vn.file_id,
    size: vn.file_size,
  })
})

bot.on('message:sticker', async ctx => {
  const sticker = ctx.message.sticker
  const emoji = sticker.emoji ? ` ${sticker.emoji}` : ''
  await handleInbound(ctx, `(sticker${emoji})`, 'sticker', undefined, {
    kind: 'sticker',
    file_id: sticker.file_id,
    size: sticker.file_size,
  })
})

bot.catch(err => {
  log(`bot handler error (polling continues): ${err.error}`)
  emitEvent('daemon', 'error', 'bot.handler_error', { error: String(err.error) })
})

// ─── Outbox processor ─────────────────────────────────────────────────────

const PHOTO_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp'])
const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024

function assertSendable(f: string): void {
  let real: string
  let stateReal: string
  try {
    real = realpathSync(f)
    stateReal = realpathSync(STATE_DIR)
  } catch {
    return
  }
  const inbox = join(stateReal, 'queue', 'inbox')
  if (real.startsWith(stateReal + sep) && !real.startsWith(inbox + sep)) {
    throw new Error(`refusing to send channel state: ${f}`)
  }
}

async function executeOutbox(item: OutboxItem): Promise<OutboxResult> {
  try {
    if (item.type === 'send_message') {
      const sentIds: number[] = []
      const parseMode = item.format === 'markdownv2' ? 'MarkdownV2' as const : undefined
      const replyTo = item.reply_to != null ? Number(item.reply_to) : undefined

      const sent = await bot.api.sendMessage(item.chat_id, item.text, {
        ...(replyTo ? { reply_parameters: { message_id: replyTo } } : {}),
        ...(parseMode ? { parse_mode: parseMode } : {}),
      })
      sentIds.push(sent.message_id)

      for (const f of item.files ?? []) {
        assertSendable(f)
        const st = statSync(f)
        if (st.size > MAX_ATTACHMENT_BYTES) {
          throw new Error(`file too large: ${f}`)
        }
        const ext = extname(f).toLowerCase()
        const input = new InputFile(f)
        const opts = replyTo ? { reply_parameters: { message_id: replyTo } } : undefined
        if (PHOTO_EXTS.has(ext)) {
          const r = await bot.api.sendPhoto(item.chat_id, input, opts)
          sentIds.push(r.message_id)
        } else {
          const r = await bot.api.sendDocument(item.chat_id, input, opts)
          sentIds.push(r.message_id)
        }
      }

      return {
        v: 1,
        outbox_id: item.id,
        ok: true,
        sent_ids: sentIds,
        completed_at: new Date().toISOString(),
      }
    }

    if (item.type === 'react') {
      await bot.api.setMessageReaction(item.chat_id, Number(item.message_id), [
        { type: 'emoji', emoji: item.emoji as ReactionTypeEmoji['emoji'] },
      ])
      return { v: 1, outbox_id: item.id, ok: true, completed_at: new Date().toISOString() }
    }

    if (item.type === 'edit_message') {
      const parseMode = item.format === 'markdownv2' ? 'MarkdownV2' as const : undefined
      await bot.api.editMessageText(
        item.chat_id,
        Number(item.message_id),
        item.text,
        ...(parseMode ? [{ parse_mode: parseMode }] : []),
      )
      return { v: 1, outbox_id: item.id, ok: true, completed_at: new Date().toISOString() }
    }

    return {
      v: 1,
      outbox_id: (item as any).id ?? 'unknown',
      ok: false,
      error: `unknown outbox type: ${(item as any).type}`,
      completed_at: new Date().toISOString(),
    }
  } catch (err) {
    return {
      v: 1,
      outbox_id: item.id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      completed_at: new Date().toISOString(),
    }
  }
}

async function drainOutbox(): Promise<void> {
  const files = listQueueFiles(OUTBOX_DIR)
  for (const f of files) {
    const path = join(OUTBOX_DIR, f)
    const item = readJsonSafe<OutboxItem>(path)
    if (!item) {
      // Bad JSON — move aside so we don't loop.
      try {
        renameSync(path, path + '.corrupt')
      } catch {}
      continue
    }
    emitEvent('daemon', 'info', 'outbox.execute', {
      outbox_id: item.id,
      type: item.type,
    })
    const result = await executeOutbox(item)
    // Write result alongside processed/outbox/
    try {
      const resPath = path + '.result.json'
      writeJsonAtomic(resPath, result)
      moveToProcessed(resPath, 'outbox')
    } catch {}
    moveToProcessed(path, 'outbox')
    emitEvent('daemon', result.ok ? 'info' : 'warn', 'outbox.done', {
      outbox_id: item.id,
      ok: result.ok,
      sent_ids: result.sent_ids,
      error: result.error,
    })
  }
}

// Watch the outbox directory for new files. fs.watch fires for any change in
// the dir. We then scan the dir (cheap, usually 0–1 file). Also a fallback
// poll every 2s in case watch misses an event on some filesystems.
let draining = false
async function maybeDrain(): Promise<void> {
  if (draining) return
  draining = true
  try {
    await drainOutbox()
  } finally {
    draining = false
  }
}

try {
  watch(OUTBOX_DIR, () => {
    void maybeDrain()
  })
} catch {}
setInterval(() => {
  void maybeDrain()
}, 2000).unref()

// ─── Approvals (from /telegram:access skill) ──────────────────────────────

const APPROVED_DIR = join(STATE_DIR, 'approved')
function checkApprovals(): void {
  let files: string[]
  try {
    files = readdirSync(APPROVED_DIR)
  } catch {
    return
  }
  for (const senderId of files) {
    const file = join(APPROVED_DIR, senderId)
    void bot.api.sendMessage(senderId, 'Paired! Send me a message — it will reach Claude.').then(
      () => rmSync(file, { force: true }),
      err => {
        log(`approval confirm failed: ${err}`)
        rmSync(file, { force: true })
      },
    )
  }
}
setInterval(checkApprovals, 5000).unref()

// ─── Bot start (with retry) ──────────────────────────────────────────────

void (async () => {
  for (let attempt = 1; ; attempt++) {
    try {
      await bot.start({
        onStart: info => {
          attempt = 0
          botUsername = info.username
          log(`polling as @${info.username}`)
          emitEvent('daemon', 'info', 'bot.polling', { username: info.username })
          // Record daemon info in state.
          const s = loadState()
          s.daemon = {
            pid: process.pid,
            started_at: startTime.toISOString(),
            username: info.username,
          }
          saveState(s)
          void bot.api.setMyCommands(
            [
              { command: 'start', description: 'Welcome and setup guide' },
              { command: 'help', description: 'What this bot can do' },
              { command: 'status', description: 'Check your pairing status' },
              { command: 'queue', description: 'Queue counts (paired only)' },
              { command: 'daemon', description: 'Daemon status (paired only)' },
              { command: 'web', description: 'Web UI URL (paired only)' },
            ],
            { scope: { type: 'all_private_chats' } },
          ).catch(() => {})
        },
      })
      return
    } catch (err) {
      if (shuttingDown) return
      if (err instanceof Error && err.message === 'Aborted delay') return
      const is409 = err instanceof GrammyError && err.error_code === 409
      if (is409 && attempt >= 8) {
        log(`409 Conflict persists after ${attempt} attempts — exiting.`)
        emitEvent('daemon', 'error', 'bot.start_failed', { attempts: attempt })
        return
      }
      const delay = Math.min(1000 * attempt, 15000)
      log(`bot.start failed (attempt ${attempt}): ${err}, retrying in ${delay / 1000}s`)
      emitEvent('daemon', 'warn', 'bot.start_retry', { attempt, error: String(err) })
      await new Promise(r => setTimeout(r, delay))
    }
  }
})()

// ─── Web UI ───────────────────────────────────────────────────────────────

import { webUIHtml } from './web-ui-html.ts'

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

function readJsonFiles(dir: string, max: number = 100): unknown[] {
  const files = listQueueFiles(dir).slice(0, max)
  return files.map(f => {
    const item = readJsonSafe<unknown>(join(dir, f))
    return { file: f, content: item }
  })
}

try {
  ;(globalThis as any).Bun?.serve?.({
    port: WEB_PORT,
    hostname: WEB_HOST,
    fetch: async (req: Request) => {
      const url = new URL(req.url)
      if (url.pathname === '/') {
        return new Response(webUIHtml, { headers: { 'content-type': 'text/html; charset=utf-8' } })
      }
      if (url.pathname === '/api/state') {
        return jsonResponse(loadState())
      }
      if (url.pathname === '/api/daemon') {
        return jsonResponse({
          pid: process.pid,
          uptime_sec: Math.floor(process.uptime()),
          bot_username: botUsername,
          started_at: startTime.toISOString(),
          log_file: LOG_FILE,
        })
      }
      if (url.pathname === '/api/inbox') {
        return jsonResponse(readJsonFiles(join(STATE_DIR, 'queue', 'inbox')))
      }
      if (url.pathname === '/api/outbox') {
        return jsonResponse(readJsonFiles(OUTBOX_DIR))
      }
      if (url.pathname === '/api/events') {
        const since = parseInt(url.searchParams.get('since') ?? '0', 10)
        const lim = parseInt(url.searchParams.get('limit') ?? '200', 10)
        try {
          const raw = readFileSync(join(STATE_DIR, 'events.jsonl'), 'utf8')
          const lines = raw.split('\n').filter(Boolean)
          const recs = lines.map(l => {
            try { return JSON.parse(l) } catch { return null }
          }).filter(Boolean) as Array<{ ts: string; [k: string]: any }>
          const filtered = recs.filter(r => {
            if (!since) return true
            try { return new Date(r.ts).getTime() > since } catch { return false }
          })
          return jsonResponse(filtered.slice(-lim))
        } catch {
          return jsonResponse([])
        }
      }
      if (url.pathname === '/api/access') {
        return jsonResponse(readAccessFile())
      }
      return new Response('Not Found', { status: 404 })
    },
  })
  log(`web UI listening on http://${WEB_HOST}:${WEB_PORT}`)
  emitEvent('daemon', 'info', 'web.started', { url: `http://${WEB_HOST}:${WEB_PORT}` })
} catch (err) {
  log(`web UI start failed: ${err}`)
  emitEvent('daemon', 'warn', 'web.start_failed', { error: String(err) })
}
