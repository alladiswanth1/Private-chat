// Global Free Speech — serverless, ephemeral, peer-to-peer chat.
//
// No backend: peers find each other via free public Nostr relays (Trystero,
// vendored) for the encrypted WebRTC handshake only; chat flows directly
// browser-to-browser over end-to-end-encrypted data channels and is never stored.
// Live history hand-off lets newcomers catch up from whoever is currently present.

import {joinRoom, selfId, getRelaySockets} from './vendor/trystero-nostr.bundle.js'

/* ------------------------------------------------------------------ *
 * Room code from URL (#r=<code>) + address-bar normalization
 * ------------------------------------------------------------------ */
const normName = s => String(s || '').trim().replace(/\s+/g, '-').replace(/[^a-zA-Z0-9_-]/g, '').toLowerCase().slice(0, 32)
function parseRoomCode() {
  const m = location.hash.match(/[#&]r=([^&]+)/)
  let c = ''
  if (m) { try { c = decodeURIComponent(m[1]) } catch { c = m[1] } }
  return normName(c)
}
const ROOM_CODE = parseRoomCode()
// Any deep URL or junk is collapsed; a valid #r=code is preserved. replaceState =
// no reload, so a typed "/README.md" silently lands on the app with a clean bar.
try {
  const want = ROOM_CODE ? '/#r=' + ROOM_CODE : '/'
  if (location.pathname + location.search + location.hash !== want) history.replaceState(null, '', want)
} catch {}

/* ------------------------------------------------------------------ *
 * Config — safe to edit.
 * ------------------------------------------------------------------ */
const CONFIG = {
  appId: 'chat-to-chat-p2p-v1',
  // Default public room = the host. A share code switches to a private/topical room.
  roomId: ROOM_CODE ? 'code:' + ROOM_CODE : (location.hostname || 'localhost'),
  isDefaultRoom: !ROOM_CODE,
  roomCode: ROOM_CODE,
  // Curated high-uptime public Nostr relays (free, not owner-run). Pinning these
  // (vs Trystero's churny ~46-relay default) makes peer discovery deterministic.
  relayUrls: [
    'wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.nostr.band',
    'wss://relay.primal.net', 'wss://nostr.mom', 'wss://relay.snort.social',
    'wss://nostr.wine', 'wss://relay.nostr.bg', 'wss://relay.0xchat.com',
    'wss://nostr.bitcoiner.social', 'wss://relay.nostr.net', 'wss://offchain.pub',
  ],
  relayRedundancy: 10,
  turnConfig: [], // see README → Connectivity; left empty to stay dependency-free
  maxNameLen: 24,
  maxMsgLen: 4000,
  maxRendered: 400,
  historyShare: 30,
  meshCap: 12,
  idleMs: 60000,
  gapDividerMs: 5 * 60 * 1000,
  // per-channel inbound flood budgets (count within window ms)
  flood: { msg: [20, 2000], name: [6, 4000], typing: [40, 2000], react: [40, 2000], presence: [20, 4000] },
}

/* ------------------------------------------------------------------ *
 * DOM
 * ------------------------------------------------------------------ */
const $ = s => document.querySelector(s)
const gate = $('#gate'), gateForm = $('#gate-form'), nickInput = $('#nick'), surpriseBtn = $('#surprise')
const gateAvatar = $('#gate-avatar'), gatePass = $('#gate-pass'), gatePassWrap = $('#gate-pass-wrap'), gateRoomLabel = $('#gate-room')
const app = $('#app'), messagesEl = $('#messages'), typingEl = $('#typing'), jumpBtn = $('#jump'), bannerEl = $('#banner')
const inputEl = $('#input'), sendBtn = $('#send'), emojiBtn = $('#emoji-btn'), emojiPanel = $('#emoji'), emojiSearch = $('#emoji-search'), emojiGrid = $('#emoji-grid')
const replyBar = $('#reply-bar'), replyText = $('#reply-text'), replyCancel = $('#reply-cancel')
const statusBtn = $('#status'), statusDot = $('#status-dot'), statusText = $('#status-text'), statusPanel = $('#status-panel')
const onlineCountEl = $('#online-count'), peopleEl = $('#people'), peopleListEl = $('#people-list'), peopleCountEl = $('#people-count')
const rulesEl = $('#rules')
const peopleToggle = $('#people-toggle'), peopleClose = $('#people-close')
const rulesToggle = $('#rules-toggle'), rulesClose = $('#rules-close')
const scrim = $('#scrim'), meName = $('#me-name'), meDot = $('#me-dot')
const roomChip = $('#room-chip'), roomChipName = $('#room-chip-name')
const roomsBtn = $('#rooms-btn'), roomsPanel = $('#rooms'), roomCurrentEl = $('#room-current'), roomsCopyLink = $('#rooms-copy-link'), roomsCopyName = $('#rooms-copy-name'), roomNameInput = $('#room-name'), roomPassInput = $('#room-pass'), roomGoBtn = $('#room-go'), roomPublicBtn = $('#room-public')
const themeBtn = $('#theme-btn'), blurBtn = $('#blur-btn'), liveRegion = $('#live'), liveSys = $('#live-sys')
const emptyEl = $('#empty'), emptyH = $('#empty-h'), emptyP = $('#empty-p'), emptyBtn = $('#empty-btn')

/* ------------------------------------------------------------------ *
 * State
 * ------------------------------------------------------------------ */
let myName = ''
let myPass = ''
let room = null, actions = null
const peers = new Map()            // peerId -> {name|null, presence:'active'|'idle'}
const typingTimers = new Map()
const floodState = new Map()       // `${peerId}:${channel}` -> {count, start}
const histAcceptedFrom = new Set() // peers we already took a history burst from
const muted = new Set()            // peerIds muted this session (ephemeral)
const reactions = new Map()        // msgKey -> Map(emoji -> Set(peerId))
const timeline = []                // sorted by (t, id); {kind:'msg'|'sys', id, t, ...}
const seenIds = new Set()
let seq = 0
let iTyping = false, typingSentAt = 0, typingStopTimer = null
let myPresence = 'active', idleTimer = null
let unread = 0
let replyTo = null                 // {key, name, snippet}
let pendingSys = []                // batched join/leave/rename lines
let pendingSysTimer = null

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */
// Strip bidi-override, zero-width and control chars (anti-spoofing; render is
// already textContent so this is not about XSS), then clamp by visible length.
// U+200D (ZWJ) is intentionally NOT stripped - it glues emoji sequences
// (family/profession/flag emoji). Strip ZWSP/ZWNJ, controls, bidi & BOM.
const BAD_CHARS = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u200B\u200C\u202A-\u202E\u2066-\u2069\uFEFF]/g
function sanitize(v, max) {
  if (typeof v !== 'string') return ''
  let s = v.replace(BAD_CHARS, '')
  // collapse runs of >2 newlines so a peer can't blow up the layout
  s = s.replace(/\n{3,}/g, '\n\n')
  return max ? s.slice(0, max) : s
}
const clampStr = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '')
const shortId = id => 'guest-' + String(id || '').slice(0, 4)
const fp = id => String(id || '').slice(0, 4)

const colorCache = new Map()
function colorOf(id) {
  let c = colorCache.get(id)
  if (c) return c
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0
  c = `hsl(${h % 360} 72% 62%)`
  if (colorCache.size > 2000) colorCache.clear()   // bound the cache on marathon sessions
  colorCache.set(id, c)
  return c
}
const initialOf = name => ((name || '?').trim()[0] || '?').toUpperCase()
const validT = t => (typeof t === 'number' && isFinite(t)) ? Math.min(Math.max(t, 0), Date.now() + 60000) : Date.now()
function fmtTime(t) { return new Date(t).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'}) }
function relTime(t) {
  const s = Math.floor((Date.now() - t) / 1000)
  if (s < 45) return 'just now'
  if (s < 90) return '1 min ago'
  if (s < 3600) return Math.round(s / 60) + ' min ago'
  if (s < 7200) return '1 hr ago'
  if (s < 86400) return Math.round(s / 3600) + ' hr ago'
  return fmtTime(t)
}
const nameOf = peerId => { const p = peers.get(peerId); return (p && p.name) || shortId(peerId) }
const keyOf = (author, rawId) => author + '::' + rawId
const newRawId = () => Date.now().toString(36) + '-' + (seq++).toString(36)
const isNearBottom = () => messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 120
const isMuted = peerId => muted.has(peerId)

// names are unauthenticated → flag when two VISIBLE peers share one
function nameIsDuplicated(peerId, name) {
  if (!name) return false
  let n = 0
  if (myName === name) n++
  for (const [id, p] of peers) { if (!isMuted(id) && p.name === name) n++ }
  return n > 1
}

/* ------------------------------------------------------------------ *
 * Timeline (single source of truth)
 * ------------------------------------------------------------------ */
const cmp = (a, b) => a.t - b.t || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
function addEntry(entry) {
  if (entry.id && seenIds.has(entry.id)) return null
  if (entry.id) seenIds.add(entry.id)
  let i = timeline.length
  while (i > 0 && cmp(timeline[i - 1], entry) > 0) i--
  timeline.splice(i, 0, entry)
  const atEnd = i === timeline.length - 1
  let evicted = false
  while (timeline.length > CONFIG.maxRendered) {
    const r = timeline.shift()
    evicted = true
    if (r.kind === 'msg') reactions.delete(r.id)
    // Do NOT delete r.id from seenIds — keeping dedup stable stops an evicted
    // message being re-inserted as a duplicate by a late history burst.
  }
  // soft-cap the dedup set so a marathon session can't grow it unbounded
  if (seenIds.size > 4000) { const it = seenIds.values(); for (let k = 0; k < 1000; k++) seenIds.delete(it.next().value) }
  return {atEnd, evicted}
}

function visibleEntries() {
  return timeline.filter(e => e.kind !== 'msg' || !isMuted(e.peerId))
}

function renderTimeline({stick} = {}) {
  const atBottom = stick ?? isNearBottom()
  const prevTop = messagesEl.scrollTop
  const frag = document.createDocumentFragment()
  let last = null, lastT = 0
  for (const e of visibleEntries()) {
    if (e.kind === 'sys') { frag.appendChild(sysNode(e.text)); last = null; lastT = e.t; continue }
    if (lastT && e.t - lastT > CONFIG.gapDividerMs) { frag.appendChild(sysNode(timeLabel(e.t))); last = null }
    frag.appendChild(msgNode(e, last === e.peerId && !e.emote))
    last = e.emote ? null : e.peerId; lastT = e.t
  }
  messagesEl.replaceChildren(frag)
  messagesEl.scrollTop = atBottom ? messagesEl.scrollHeight : prevTop
  if (atBottom) hideJump()
  refreshEmpty()
}

function timeLabel(t) {
  const d = new Date(t), now = new Date()
  const same = d.toDateString() === now.toDateString()
  return same ? fmtTime(t) : d.toLocaleDateString([], {month: 'short', day: 'numeric'}) + ' · ' + fmtTime(t)
}

function sysNode(text) {
  const el = document.createElement('div')
  el.className = 'sys'
  el.textContent = text
  return el
}

function msgNode(e, grouped) {
  if (e.emote) {   // /me action line
    const el = document.createElement('div')
    el.className = 'sys emote'; el.dataset.key = e.id
    el.textContent = '✦ ' + (e.peerId === selfId ? 'You' : e.name) + ' ' + e.text
    return el
  }
  const self = e.peerId === selfId
  const row = document.createElement('div')
  row.className = 'msg' + (self ? ' me' : '') + (grouped ? ' cont' : '')
  row.dataset.key = e.id

  const avatar = document.createElement('div')
  avatar.className = 'avatar'
  avatar.style.background = colorOf(e.peerId)
  avatar.textContent = initialOf(e.name)
  row.appendChild(avatar)

  const stack = document.createElement('div')
  stack.className = 'stack'

  const meta = document.createElement('div')
  meta.className = 'meta'
  const who = document.createElement('span')
  who.className = 'who'
  who.style.color = self ? '' : colorOf(e.peerId)
  who.textContent = self ? 'You' : e.name
  meta.appendChild(who)
  if (!self && nameIsDuplicated(e.peerId, e.name)) meta.appendChild(badge(e.peerId))
  const time = document.createElement('span')
  time.className = 'time'
  time.textContent = fmtTime(e.t)
  time.title = relTime(e.t)
  meta.appendChild(time)
  stack.appendChild(meta)

  if (e.reply) stack.appendChild(replyQuote(e.reply))

  const bubble = document.createElement('div')
  bubble.className = 'bubble'
  renderRichText(bubble, e.text)
  stack.appendChild(bubble)

  const rbar = reactionBar(e.id)
  if (rbar) stack.appendChild(rbar)

  // hover/long-press toolbar (react + reply)
  stack.appendChild(msgTools(e))

  row.appendChild(stack)
  return row
}

function badge(peerId) {
  const b = document.createElement('span')
  b.className = 'fp'
  b.textContent = '#' + fp(peerId)
  b.title = 'Names aren’t verified — this id distinguishes same-named people'
  return b
}

function replyQuote(reply) {
  const q = document.createElement('button')
  q.type = 'button'; q.className = 'replyquote'
  if (reply.unresolved) {
    const tx = document.createElement('span'); tx.className = 'rq-text'; tx.textContent = '↩ replying to an earlier message'
    q.appendChild(tx)
  } else {
    const who = document.createElement('span'); who.className = 'rq-who'; who.textContent = reply.name || 'unknown'
    const tx = document.createElement('span'); tx.className = 'rq-text'; tx.textContent = reply.snippet || ''
    q.append(who, tx)
  }
  q.addEventListener('click', () => scrollToKey(reply.key))
  return q
}

function scrollToKey(key) {
  const el = messagesEl.querySelector(`.msg[data-key="${cssEsc(key)}"]`)
  if (el) { el.scrollIntoView({block: 'center', behavior: 'smooth'}); el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 1200) }
}
const cssEsc = s => (window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/["\\]/g, '\\$&')

/* ----- rich text: linkify + minimal markdown, DOM nodes only (no innerHTML) ---- */
const URL_RE = /(https?:\/\/[^\s<]+[^\s<.,;:!?)\]}'"])/g
function renderRichText(el, text) {
  // split into URL / non-URL segments; format inline markdown in non-URL parts
  let last = 0, m
  URL_RE.lastIndex = 0
  while ((m = URL_RE.exec(text))) {
    if (m.index > last) appendInline(el, text.slice(last, m.index))
    el.appendChild(linkNode(m[0]))
    last = m.index + m[0].length
  }
  if (last < text.length) appendInline(el, text.slice(last))
}
function linkNode(url) {
  const a = document.createElement('a')
  a.className = 'link'
  // scheme is guaranteed http(s) by the regex; set via property (no HTML parsing)
  a.href = url
  a.textContent = url
  a.target = '_blank'
  a.rel = 'noopener noreferrer nofollow'
  return a
}
const INLINE_RE = /(\*\*([^*]+)\*\*|`([^`]+)`|_([^_]+)_)/g
function appendInline(el, text) {
  let last = 0, m
  INLINE_RE.lastIndex = 0
  while ((m = INLINE_RE.exec(text))) {
    if (m.index > last) el.appendChild(document.createTextNode(text.slice(last, m.index)))
    let tag = 'span'
    if (m[2] != null) tag = 'strong'
    else if (m[3] != null) tag = 'code'
    else if (m[4] != null) tag = 'em'
    const node = document.createElement(tag)
    node.textContent = m[2] ?? m[3] ?? m[4]
    el.appendChild(node)
    last = m.index + m[0].length
  }
  if (last < text.length) el.appendChild(document.createTextNode(text.slice(last)))
}

/* ----- reactions ---- */
function reactionBar(key) {
  const map = reactions.get(key)
  if (!map || !map.size) return null
  const bar = document.createElement('div')
  bar.className = 'reacts'
  for (const [emoji, set] of map) {
    if (!set.size) continue
    const chip = document.createElement('button')
    chip.type = 'button'
    chip.className = 'react' + (set.has(selfId) ? ' mine' : '')
    chip.textContent = emoji + ' ' + set.size
    chip.title = 'React'
    chip.addEventListener('click', () => toggleReaction(key, emoji))
    bar.appendChild(chip)
  }
  return bar.children.length ? bar : null
}
function updateReactionBar(key) {
  const row = messagesEl.querySelector(`.msg[data-key="${cssEsc(key)}"] .stack`)
  if (!row) return
  const existing = row.querySelector(':scope > .reacts')
  const fresh = reactionBar(key)
  if (existing && fresh) existing.replaceWith(fresh)
  else if (existing && !fresh) existing.remove()
  else if (fresh) {
    const tools = row.querySelector(':scope > .msgtools')
    row.insertBefore(fresh, tools || null)
  }
}
function applyReaction(key, emoji, peerId, on) {
  if (!emoji) return
  let map = reactions.get(key)
  if (!map) { map = new Map(); reactions.set(key, map) }
  let set = map.get(emoji)
  if (!set) { set = new Set(); map.set(emoji, set) }
  if (on) set.add(peerId); else set.delete(peerId)
  if (!set.size) map.delete(emoji)
  updateReactionBar(key)
}
function toggleReaction(key, emoji) {
  const map = reactions.get(key)
  const on = !(map && map.get(emoji) && map.get(emoji).has(selfId))
  applyReaction(key, emoji, selfId, on)
  if (actions) actions.react.send({target: key, emoji, on})
}

const QUICK_REACTS = ['👍', '❤️', '😂', '🎉', '🔥', '👀']
function msgTools(e) {
  const t = document.createElement('div')
  t.className = 'msgtools'
  const react = document.createElement('button')
  react.type = 'button'; react.className = 'mt'; react.textContent = '😀'; react.title = 'React'
  react.setAttribute('aria-label', 'React to message')
  react.addEventListener('click', ev => { ev.stopPropagation(); openReactMenu(react, e.id) })
  const reply = document.createElement('button')
  reply.type = 'button'; reply.className = 'mt'; reply.textContent = '↩'; reply.title = 'Reply'
  reply.setAttribute('aria-label', 'Reply to message')
  reply.addEventListener('click', ev => { ev.stopPropagation(); startReply(e) })
  t.append(react, reply)
  return t
}
let reactMenu = null
function openReactMenu(anchor, key) {
  closeReactMenu()
  reactMenu = document.createElement('div')
  reactMenu.className = 'reactmenu'
  QUICK_REACTS.forEach(em => {
    const b = document.createElement('button')
    b.type = 'button'; b.textContent = em
    b.addEventListener('click', () => { toggleReaction(key, em); closeReactMenu() })
    reactMenu.appendChild(b)
  })
  anchor.appendChild(reactMenu)
  setTimeout(() => document.addEventListener('click', closeReactMenu, {once: true}), 0)
}
function closeReactMenu() { if (reactMenu) { reactMenu.remove(); reactMenu = null } }

/* ----- replies ---- */
function startReply(e) {
  replyTo = {key: e.id, name: e.peerId === selfId ? 'yourself' : e.name, snippet: e.text.slice(0, 120)}
  replyText.textContent = (replyTo.name) + ': ' + replyTo.snippet
  replyBar.hidden = false
  inputEl.focus()
}
function cancelReply() { replyTo = null; replyBar.hidden = true }

/* ----- empty state (overlay element, toggled — never overlaps system lines) ---- */
function refreshEmpty() {
  const has = timeline.some(e => e.kind === 'msg')
  emptyEl.hidden = has
  if (has) return
  emptyH.textContent = peers.size ? 'No messages yet' : 'You’re the first one here'
  emptyP.textContent = peers.size
    ? 'Say hi 👋 — messages are live, peer-to-peer, and never stored.'
    : 'Share the link and whoever opens it can talk — live, peer-to-peer, nothing stored.'
}

/* ------------------------------------------------------------------ *
 * Adding entries
 * ------------------------------------------------------------------ */
function addSystem(text) {
  const stick = isNearBottom()
  addEntry({kind: 'sys', id: 'sys-' + seq++, t: Date.now(), text})
  renderTimeline({stick})
}

// batched join/leave/rename lines (rostercap)
function addPresenceSys(text) {
  pendingSys.push(text)
  clearTimeout(pendingSysTimer)
  pendingSysTimer = setTimeout(flushPresenceSys, 900)
}
function flushPresenceSys() {
  pendingSysTimer = null
  if (!pendingSys.length) return
  const lines = pendingSys; pendingSys = []
  addSystem(lines.length <= 2 ? lines.join(' · ') : `${lines.slice(0, 2).join(' · ')} · +${lines.length - 2} more`)
}

function addMessage(entry, fromSelf) {
  const stick = fromSelf || isNearBottom()
  const res = addEntry({kind: 'msg', ...entry})
  if (!res) return false
  // fast path only when the entry lands at the end AND nothing was evicted (so the
  // DOM stays in lockstep with the timeline); otherwise do a full, correct render.
  const fast = res.atEnd && !res.evicted && !isMuted(entry.peerId) && messagesEl.firstElementChild && emptyEl.hidden
  if (fast) appendOne(entry, stick); else renderTimeline({stick})
  if (!fromSelf && !isMuted(entry.peerId)) {
    announceMsg(`${entry.name}: ${entry.text}`)
    if (document.hidden) setUnread(unread + 1)
  }
  if (!stick && !fromSelf) showJump()
  return true
}

function appendOne(entry, stick) {
  // grouping + gap divider derived from the timeline (not the DOM), so it stays correct
  const vis = visibleEntries()
  const idx = vis.findIndex(e => e.id === entry.id)
  const prev = idx > 0 ? vis[idx - 1] : null
  if (prev && prev.kind === 'msg' && entry.t - prev.t > CONFIG.gapDividerMs) messagesEl.appendChild(sysNode(timeLabel(entry.t)))
  const grouped = !!prev && prev.kind === 'msg' && !prev.emote && !entry.emote && prev.peerId === entry.peerId && entry.t - prev.t <= CONFIG.gapDividerMs
  const node = msgNode(entry, grouped)
  node.classList.add('msg--new')
  messagesEl.appendChild(node)
  if (stick) messagesEl.scrollTop = messagesEl.scrollHeight
}

/* ------------------------------------------------------------------ *
 * Scroll-to-latest
 * ------------------------------------------------------------------ */
function showJump() { jumpBtn.hidden = false }
function hideJump() { jumpBtn.hidden = true }
jumpBtn.addEventListener('click', () => { messagesEl.scrollTop = messagesEl.scrollHeight; hideJump() })
messagesEl.addEventListener('scroll', () => { if (isNearBottom()) hideJump() })

/* ------------------------------------------------------------------ *
 * Networking
 * ------------------------------------------------------------------ */
function startChat() {
  try {
    const cfg = {appId: CONFIG.appId, relayConfig: {urls: CONFIG.relayUrls, redundancy: CONFIG.relayRedundancy}}
    if (CONFIG.turnConfig.length) cfg.turnConfig = CONFIG.turnConfig
    if (myPass) cfg.password = myPass
    room = joinRoom(cfg, CONFIG.roomId)
    wireRoom(room)
    updateStatusLoop()
  } catch (err) { showFatal(err) }
}
function showFatal(err) {
  statusDot.className = 'dot dot--off'
  statusText.textContent = 'Connection failed'
  addSystem(!window.isSecureContext
    ? 'Could not start: serve this over HTTPS (or http://localhost) and reload.'
    : `Could not connect: ${(err && err.message) || 'unknown error'}. Try reloading.`)
}

// Manual reconnect: leave the room, reset peer/connection state (keep the chat
// timeline), and re-join. Used by the status panel's Reconnect button.
function reconnect() {
  try { if (room) room.leave() } catch {}
  room = null; actions = null
  for (const t of typingTimers.values()) clearTimeout(t)
  typingTimers.clear(); peers.clear(); histAcceptedFrom.clear(); floodState.clear()
  prevRelays = 0; noPeerSince = 0
  renderRoster(); renderTyping(); addSystem('Reconnecting…')
  startChat()
}

function allow(peerId, channel) {
  const [n, ms] = CONFIG.flood[channel] || CONFIG.flood.msg
  const k = peerId + ':' + channel
  const now = Date.now()
  const s = floodState.get(k)
  if (!s || now - s.start > ms) { floodState.set(k, {count: 1, start: now}); return true }
  s.count++
  return s.count <= n
}

function wireRoom(room) {
  const msg = room.makeAction('msg')
  const name = room.makeAction('name')
  const typing = room.makeAction('typing')
  const hist = room.makeAction('hist')
  const histReq = room.makeAction('histreq')
  const react = room.makeAction('react')
  const presence = room.makeAction('presence')
  actions = {msg, name, typing, hist, histReq, react, presence}

  msg.onMessage = (data, {peerId}) => {
    if (!data || typeof data.id !== 'string' || !allow(peerId, 'msg')) return
    const text = sanitize(data.text, CONFIG.maxMsgLen)
    if (!text) return
    if (typeof data.name === 'string') setPeerName(peerId, data.name, true)
    clearPeerTyping(peerId)
    // id namespaced by the TRUSTED transport peerId — a peer can't claim another's id-space
    addMessage({
      id: keyOf(peerId, clampStr(data.id, 64)),
      t: validT(data.t),
      peerId,
      name: nameOf(peerId),
      text,
      emote: !!data.emote,
      reply: parseReply(data.reply),
    }, false)
  }

  hist.onMessage = (arr, {peerId}) => {
    if (!Array.isArray(arr) || histAcceptedFrom.has(peerId)) return
    // Only accept a history burst from the elected sender (lowest peer id), so a
    // random peer can't push a forged/censored history to newcomers.
    if (peerId !== lowestPeer()) return
    histAcceptedFrom.add(peerId)            // and only one burst from them
    let added = false
    for (const m of arr.slice(0, CONFIG.historyShare)) {
      if (!m || typeof m.id !== 'string' || typeof m.peerId !== 'string') continue
      const text = sanitize(m.text, CONFIG.maxMsgLen)
      if (!text) continue
      const author = clampStr(m.peerId, 64)
      const key = keyOf(author, clampStr(m.id, 64))   // namespaced by claimed AUTHOR for cross-relayer dedupe
      if (addEntry({kind: 'msg', id: key, t: validT(m.t), peerId: author, name: sanitize(m.name, CONFIG.maxNameLen) || shortId(author), text, emote: !!m.emote, reply: parseReply(m.reply)})) added = true
      if (m.reacts && typeof m.reacts === 'object') {  // re-hydrate reaction counts
        for (const em of Object.keys(m.reacts).slice(0, 24)) {
          const list = m.reacts[em]
          if (Array.isArray(list)) list.slice(0, 60).forEach(pid => applyReaction(key, sanitize(em, 8), clampStr(pid, 64), true))
        }
      }
    }
    if (added) renderTimeline({stick: true})
  }

  // a newcomer who got no history asks for it; the next-lowest peer answers
  histReq.onMessage = (_d, {peerId}) => {
    if (!allow(peerId, 'presence')) return
    if (electedHistSender(peerId)) sendHistoryTo(peerId)
  }

  name.onMessage = (value, {peerId}) => { if (allow(peerId, 'name')) setPeerName(peerId, value) }
  typing.onMessage = (value, {peerId}) => { if (!allow(peerId, 'typing')) return; value ? markPeerTyping(peerId) : clearPeerTyping(peerId) }
  presence.onMessage = (value, {peerId}) => {
    if (!allow(peerId, 'presence')) return
    const p = peers.get(peerId); if (!p) return
    p.presence = value === 'idle' ? 'idle' : 'active'
    renderRoster()
  }
  react.onMessage = (d, {peerId}) => {
    if (!d || typeof d.target !== 'string' || !allow(peerId, 'react')) return
    if (isMuted(peerId)) return              // muted peers' reactions don't register
    if (!seenIds.has(d.target)) return       // ignore reactions to messages we don't have
    applyReaction(d.target, sanitize(d.emoji, 8), peerId, !!d.on)
  }

  room.onPeerJoin = peerId => {
    if (!peers.has(peerId)) peers.set(peerId, {name: null, presence: 'active'})
    name.send(myName, {target: peerId})
    presence.send(myPresence, {target: peerId})
    if (electedHistSender(peerId)) sendHistoryTo(peerId)   // only the lowest-id peer hands off
    renderRoster()
    if (!timeline.some(e => e.kind === 'msg')) refreshEmpty()  // "No messages yet"
    maybeMeshWarn()
  }
  room.onPeerLeave = peerId => {
    const left = nameOf(peerId)
    const existed = peers.delete(peerId)
    clearPeerTyping(peerId); histAcceptedFrom.delete(peerId)
    for (const ch in CONFIG.flood) floodState.delete(peerId + ':' + ch)   // clear all channels
    renderRoster()
    if (existed && !isMuted(peerId)) addPresenceSys(`${left} left`)
    if (!timeline.some(e => e.kind === 'msg')) refreshEmpty()
  }

  // if nobody hands us history shortly after joining, ask for it
  setTimeout(() => { if (actions && peers.size > 0 && !timeline.some(e => e.kind === 'msg')) actions.histReq.send(1) }, 2500)
}

// elect a single history sender: the lowest selfId among peers I know (excluding the newcomer)
function electedHistSender(newcomerId) {
  let lowest = selfId
  for (const id of peers.keys()) { if (id !== newcomerId && id < lowest) lowest = id }
  return lowest === selfId
}
function lowestPeer() { let lo = null; for (const id of peers.keys()) if (lo === null || id < lo) lo = id; return lo }
function serializeReacts(key) {
  const m = reactions.get(key); if (!m || !m.size) return null
  const o = {}; for (const [em, set] of m) if (set.size) o[em] = [...set]
  return Object.keys(o).length ? o : null
}
function sendHistoryTo(peerId) {
  const recent = timeline.filter(e => e.kind === 'msg').slice(-CONFIG.historyShare)
    .map(e => ({id: rawIdOf(e.id), t: e.t, peerId: e.peerId, name: e.name, text: e.text, emote: e.emote, reply: e.reply, reacts: serializeReacts(e.id)}))
  if (recent.length && actions) actions.hist.send(recent, {target: peerId})
}
const rawIdOf = key => { const i = key.indexOf('::'); return i < 0 ? key : key.slice(i + 2) }

function parseReply(r) {
  if (!r || typeof r.key !== 'string') return null
  const own = timeline.find(e => e.id === r.key)
  // Never trust a peer's claimed quote author/text. If we can't resolve the
  // referenced message in our own timeline, show a neutral placeholder.
  if (!own) return {key: clampStr(r.key, 130), unresolved: true}
  return {key: clampStr(r.key, 130), name: own.peerId === selfId ? 'You' : own.name, snippet: own.text.slice(0, 120)}
}

function setPeerName(peerId, value, fromMsg) {
  const name = sanitize(value, CONFIG.maxNameLen).trim()
  if (!name || !peers.has(peerId)) return
  const p = peers.get(peerId)
  if (p.name === name) return
  const prev = p.name
  p.name = name
  if (!isMuted(peerId)) addPresenceSys(prev ? `${prev} is now ${name}` : `${name} joined`)
  renderRoster()
  if (typingTimers.has(peerId)) renderTyping()
}

function maybeMeshWarn() {
  if (peers.size + 1 > CONFIG.meshCap && CONFIG.isDefaultRoom) showMeshBanner()
}

/* ------------------------------------------------------------------ *
 * Typing + presence
 * ------------------------------------------------------------------ */
function markPeerTyping(peerId) {
  if (!peers.has(peerId)) return
  if (typingTimers.has(peerId)) clearTimeout(typingTimers.get(peerId))
  typingTimers.set(peerId, setTimeout(() => { typingTimers.delete(peerId); renderTyping() }, 4500))
  renderTyping()
}
function clearPeerTyping(peerId) {
  if (typingTimers.has(peerId)) { clearTimeout(typingTimers.get(peerId)); typingTimers.delete(peerId); renderTyping() }
}
function renderTyping() {
  const names = [...typingTimers.keys()].filter(id => !isMuted(id)).map(nameOf)
  let label = ''
  if (names.length === 1) label = `${names[0]} is typing`
  else if (names.length === 2) label = `${names[0]} and ${names[1]} are typing`
  else if (names.length > 2) label = 'Several people are typing'
  if (!label) { typingEl.hidden = true; typingEl.replaceChildren(); return }
  const dots = document.createElement('span'); dots.className = 'dots'
  dots.append(document.createElement('i'), document.createElement('i'), document.createElement('i'))
  const txt = document.createElement('span'); txt.textContent = label
  typingEl.replaceChildren(txt, dots)
  typingEl.hidden = false
}

function setMyPresence(p) {
  if (myPresence === p) return
  myPresence = p
  if (actions) actions.presence.send(p)
}
function bumpActivity() {
  setMyPresence('active')
  clearTimeout(idleTimer)
  idleTimer = setTimeout(() => setMyPresence('idle'), CONFIG.idleMs)
}

/* ------------------------------------------------------------------ *
 * Roster
 * ------------------------------------------------------------------ */
function renderRoster() {
  const count = peers.size + 1
  onlineCountEl.textContent = String(count)
  peopleCountEl.textContent = String(count)
  const frag = document.createDocumentFragment()
  frag.appendChild(personRow(selfId, myName, true, 'active'))
  ;[...peers.entries()]
    .sort((a, b) => Number(!!b[1].name) - Number(!!a[1].name))
    .forEach(([id, p]) => frag.appendChild(personRow(id, p.name, false, p.presence)))
  peopleListEl.replaceChildren(frag)
}
function personRow(id, name, isSelf, presence) {
  const li = document.createElement('li')
  li.className = 'person' + (!isSelf && !name ? ' pending' : '') + (presence === 'idle' ? ' idle' : '')
  const av = document.createElement('div')
  av.className = 'avatar'; av.style.background = colorOf(id); av.textContent = initialOf(name || '?')
  const nm = document.createElement('span')
  nm.className = 'pname'; nm.textContent = name || 'connecting…'
  li.append(av, nm)
  if (!isSelf && name && nameIsDuplicated(id, name)) li.appendChild(badge(id))
  if (isSelf) { const tag = document.createElement('span'); tag.className = 'tag'; tag.textContent = 'you'; li.appendChild(tag) }
  else {
    const mb = document.createElement('button')
    mb.type = 'button'; mb.className = 'mutebtn'; mb.textContent = isMuted(id) ? 'unmute' : 'mute'
    mb.title = isMuted(id) ? 'Unmute (this session)' : 'Mute (this session only)'
    mb.addEventListener('click', () => toggleMute(id))
    li.appendChild(mb)
  }
  return li
}
function toggleMute(peerId) {
  if (muted.has(peerId)) muted.delete(peerId); else muted.add(peerId)
  clearPeerTyping(peerId)
  renderRoster(); renderTimeline()
}

/* ------------------------------------------------------------------ *
 * Sending + slash commands
 * ------------------------------------------------------------------ */
function sendMessage() {
  const raw = inputEl.value
  const text = sanitize(raw, CONFIG.maxMsgLen).trim()
  if (!text || !actions) return
  if (text[0] === '/' && handleSlash(text)) { inputEl.value = ''; stopTyping(); updateSendBtn(); return }
  const rawId = newRawId()
  const entry = {id: keyOf(selfId, rawId), t: Date.now(), peerId: selfId, name: myName, text, reply: replyTo ? {key: replyTo.key, name: replyTo.name, snippet: replyTo.snippet} : null}
  actions.msg.send({id: rawId, t: entry.t, name: myName, text, reply: replyTo ? {key: replyTo.key, name: replyTo.name, snippet: replyTo.snippet} : null})
  addMessage(entry, true)
  inputEl.value = ''; cancelReply(); stopTyping(); updateSendBtn(); inputEl.focus()
}

function handleSlash(text) {
  const [cmd, ...rest] = text.slice(1).split(' ')
  const arg = rest.join(' ').trim()
  switch (cmd.toLowerCase()) {
    case 'nick': {
      const n = sanitize(arg, CONFIG.maxNameLen).trim()
      if (!n) { addSystem('Usage: /nick <new name>'); return true }
      const old = myName; setMyName(n)
      if (actions) actions.name.send(myName)
      addSystem(`You are now "${myName}" (was "${old}")`)
      return true
    }
    case 'me': {
      const text = sanitize(arg, CONFIG.maxMsgLen)
      if (text) { const rawId = newRawId(), id = keyOf(selfId, rawId), t = Date.now(); actions.msg.send({id: rawId, t, name: myName, text, emote: true}); addMessage({id, t, peerId: selfId, name: myName, text, emote: true}, true) }
      return true
    }
    case 'who': addSystem('Here now: ' + [myName + ' (you)', ...[...peers.values()].map(p => p.name).filter(Boolean)].join(', ')); return true
    case 'clear': timeline.length = 0; seenIds.clear(); reactions.clear(); renderTimeline(); addSystem('Cleared your local view (others are unaffected).'); return true
    case 'shrug': inputEl.value = '¯\\_(ツ)_/¯'; sendMessage(); return true
    case 'help': addSystem('Commands: /nick <name> · /me <action> · /who · /clear · /shrug · /help'); return true
    default: addSystem(`Unknown command: /${cmd} — try /help`); return true
  }
}

function onLocalInput() {
  updateSendBtn(); bumpActivity()
  if (!actions) return
  if (inputEl.value.trim()) {
    const now = Date.now()
    if (!iTyping || now - typingSentAt > 1500) { actions.typing.send(true); iTyping = true; typingSentAt = now }
    clearTimeout(typingStopTimer); typingStopTimer = setTimeout(stopTyping, 2500)
  } else stopTyping()
}
function stopTyping() {
  clearTimeout(typingStopTimer); typingStopTimer = null
  if (actions && iTyping) actions.typing.send(false)
  iTyping = false; typingSentAt = 0
}
function updateSendBtn() { sendBtn.disabled = !inputEl.value.trim() }

/* ------------------------------------------------------------------ *
 * Connection status + relay/ping panel
 * ------------------------------------------------------------------ */
let prevRelays = 0, noPeerSince = 0, statusTimer = null
function relayStates() {
  try { return Object.entries(getRelaySockets() || {}).map(([url, s]) => ({url, open: s && s.readyState === 1})) } catch { return [] }
}
function updateStatusLoop() {
  const tick = () => {
    const states = relayStates()
    const relays = states.filter(s => s.open).length
    const online = peers.size
    if (online > 0) { statusDot.className = 'dot dot--on'; setStatus(`${online + 1} online`) }
    else if (relays > 0 && prevRelays > 0 && relays < prevRelays && noPeerSince) { statusDot.className = 'dot dot--wait'; setStatus('Reconnecting…') }
    else if (relays > 0) {
      if (!noPeerSince) noPeerSince = Date.now()
      const stuck = Date.now() - noPeerSince > 12000
      statusDot.className = 'dot dot--wait'
      setStatus(stuck ? 'Relays up, no peers — strict NAT?' : 'Waiting for people…')
    } else { statusDot.className = 'dot dot--off'; setStatus(navigator.onLine === false ? 'Offline' : 'Connecting…') }
    if (online > 0) noPeerSince = 0
    prevRelays = relays
  }
  tick()
  if (statusTimer) clearInterval(statusTimer)   // avoid duplicate timers on reconnect
  statusTimer = setInterval(tick, 2000)
}
function setStatus(t) { if (statusText.textContent !== t) { statusText.textContent = t; announceStatus(t) } }

async function openStatusPanel() {
  statusPanel.replaceChildren()
  const h = document.createElement('div'); h.className = 'sp-h'; h.textContent = 'Relays'; statusPanel.appendChild(h)
  for (const s of relayStates()) {
    const r = document.createElement('div'); r.className = 'sp-row'
    const d = document.createElement('span'); d.className = 'dot ' + (s.open ? 'dot--on' : 'dot--off')
    const u = document.createElement('span'); u.className = 'sp-url'; u.textContent = s.url.replace('wss://', '')
    r.append(d, u); statusPanel.appendChild(r)
  }
  const ph = document.createElement('div'); ph.className = 'sp-h'; ph.textContent = 'Peers'; statusPanel.appendChild(ph)
  if (!peers.size) { const e = document.createElement('div'); e.className = 'sp-row'; e.textContent = 'none yet'; statusPanel.appendChild(e) }
  for (const id of peers.keys()) {
    const r = document.createElement('div'); r.className = 'sp-row'
    const u = document.createElement('span'); u.className = 'sp-url'; u.textContent = nameOf(id)
    const ms = document.createElement('span'); ms.className = 'sp-ms'; ms.textContent = '…'
    r.append(u, ms); statusPanel.appendChild(r)
    if (room && room.ping) room.ping(id).then(v => { ms.textContent = Math.round(v) + 'ms' }).catch(() => { ms.textContent = '—' })
  }
  const rc = document.createElement('button')
  rc.type = 'button'; rc.className = 'share-b'; rc.textContent = '↻ Reconnect'; rc.style.marginTop = '10px'; rc.style.width = '100%'
  rc.addEventListener('click', () => { statusPanel.hidden = true; reconnect() })
  statusPanel.appendChild(rc)
  statusPanel.hidden = false
}
function toggleStatusPanel() { statusPanel.hidden ? openStatusPanel() : (statusPanel.hidden = true) }

/* ------------------------------------------------------------------ *
 * Emoji picker (search + recents + keyboard)
 * ------------------------------------------------------------------ */
const EMOJI = [
  ['😀','grin happy'],['😁','beam'],['😂','laugh tears'],['🤣','rofl'],['😊','blush smile'],['😍','love heart eyes'],['😘','kiss'],['😎','cool sunglasses'],['🤩','star struck'],['🥳','party'],
  ['😉','wink'],['🙂','slight smile'],['🙃','upside down'],['😇','angel'],['🤔','thinking'],['🤨','raised brow'],['😴','sleep'],['😭','cry sob'],['😢','tear sad'],['😅','sweat grin'],
  ['😤','huff'],['😠','angry'],['😡','rage mad'],['🥺','pleading'],['😱','scream shock'],['🤯','mind blown'],['🤗','hug'],['🤭','giggle oops'],['🫡','salute'],['🫠','melt'],
  ['👍','thumbs up yes'],['👎','thumbs down no'],['👏','clap'],['🙌','praise raise'],['🙏','pray thanks'],['💪','muscle strong'],['🤝','handshake deal'],['👋','wave hi bye'],['✌️','peace'],['🤞','fingers crossed'],
  ['❤️','heart love red'],['🧡','orange heart'],['💛','yellow heart'],['💚','green heart'],['💙','blue heart'],['💜','purple heart'],['🖤','black heart'],['🤍','white heart'],['💔','broken heart'],['💯','hundred perfect'],
  ['🔥','fire lit'],['✨','sparkle'],['🎉','party tada'],['🎊','confetti'],['⭐','star'],['🌟','glow star'],['⚡','zap lightning'],['💥','boom'],['☀️','sun'],['🌙','moon night'],
  ['🍕','pizza'],['🍔','burger'],['🍟','fries'],['🍰','cake'],['🍺','beer'],['☕','coffee'],['🎮','game'],['🎵','music note'],['⚽','soccer ball'],['🏆','trophy win'],
  ['🚀','rocket launch'],['💻','laptop code'],['📱','phone'],['💡','idea bulb'],['✅','check done'],['❌','cross no'],['❓','question'],['❗','exclaim'],['👀','eyes look'],['💬','chat speech'],
]
let recents = []
try { recents = JSON.parse(localStorage.getItem('c2c-emoji') || '[]').filter(x => typeof x === 'string').slice(0, 16) } catch {}
function buildEmoji(filter) {
  emojiGrid.replaceChildren()
  const f = (filter || '').trim().toLowerCase()
  if (!f && recents.length) {
    const head = document.createElement('div'); head.className = 'emoji-sec'; head.textContent = 'Recent'; emojiGrid.appendChild(head)
    recents.forEach(e => emojiGrid.appendChild(emojiCell(e, e)))
    const head2 = document.createElement('div'); head2.className = 'emoji-sec'; head2.textContent = 'All'; emojiGrid.appendChild(head2)
  }
  EMOJI.filter(([e, k]) => !f || k.includes(f) || e === f).forEach(([e, k]) => emojiGrid.appendChild(emojiCell(e, k)))
  rove()
}
function emojiCell(e, label) {
  const b = document.createElement('button')
  b.type = 'button'; b.textContent = e; b.tabIndex = -1
  b.setAttribute('aria-label', label.split(' ')[0])
  b.addEventListener('click', () => pickEmoji(e))
  return b
}
function pickEmoji(e) {
  insertAtCursor(e)
  recents = [e, ...recents.filter(x => x !== e)].slice(0, 16)
  try { localStorage.setItem('c2c-emoji', JSON.stringify(recents)) } catch {}
  emojiPanel.hidden = true; inputEl.focus()
}
function insertAtCursor(text) {
  const s = inputEl.selectionStart ?? inputEl.value.length
  const en = inputEl.selectionEnd ?? inputEl.value.length
  inputEl.value = (inputEl.value.slice(0, s) + text + inputEl.value.slice(en)).slice(0, CONFIG.maxMsgLen)
  const pos = Math.min(s + text.length, inputEl.value.length)
  inputEl.setSelectionRange(pos, pos); updateSendBtn()
}
// roving tabindex over the emoji buttons
function rove() {
  const btns = [...emojiGrid.querySelectorAll('button')]
  btns.forEach((b, i) => b.tabIndex = i === 0 ? 0 : -1)
}
emojiGrid.addEventListener('keydown', e => {
  const btns = [...emojiGrid.querySelectorAll('button')]
  let i = btns.indexOf(document.activeElement)
  if (i < 0) return
  const cols = Math.max(1, Math.floor(emojiGrid.clientWidth / 40))
  if (e.key === 'ArrowRight') i++; else if (e.key === 'ArrowLeft') i--
  else if (e.key === 'ArrowDown') i += cols; else if (e.key === 'ArrowUp') i -= cols
  else return
  e.preventDefault()
  const t = btns[Math.max(0, Math.min(btns.length - 1, i))]
  if (t) { btns.forEach(b => b.tabIndex = -1); t.tabIndex = 0; t.focus() }
})

/* ------------------------------------------------------------------ *
 * Rooms / share code
 * ------------------------------------------------------------------ */
function shareUrl(code = CONFIG.roomCode) { return location.origin + (code ? '/#r=' + code : '/') }
function copyText(text, btn, restore) {
  const done = ok => { if (btn) { btn.textContent = ok ? '✓ Copied' : 'Copy failed'; setTimeout(() => { btn.textContent = restore }, 1400) } }
  try { navigator.clipboard.writeText(text).then(() => done(true), () => done(false)) } catch { done(false) }
}
function openRoomsPanel() {
  if (CONFIG.isDefaultRoom) {
    roomCurrentEl.textContent = "You're in the public room — open to anyone on this site."
    roomsCopyName.hidden = true; roomPublicBtn.hidden = true
  } else {
    roomCurrentEl.textContent = `Private room: "${CONFIG.roomCode}". Invite by sharing the link, and tell people the password separately.`
    roomsCopyName.hidden = false; roomPublicBtn.hidden = false
  }
  roomsPanel.hidden = false
  setTimeout(() => roomNameInput.focus(), 0)
}
// Navigate (full load) into a named private room. The password rides in
// sessionStorage (never the URL) and gates the room cryptographically: only
// peers with the same name AND password derive the same channel key.
function gotoRoom(name, pass) {
  const n = normName(name)
  if (!n || !pass) return
  try { sessionStorage.setItem('c2c-pass-' + n, pass) } catch {}
  // a hash-only change does NOT reload the SPA, so force a reload into the new room
  history.replaceState(null, '', '/#r=' + n)
  location.reload()
}
function showMeshBanner() {
  if (!bannerEl.hidden) return
  bannerEl.replaceChildren()
  const t = document.createElement('span'); t.textContent = `Busy room (${peers.size + 1} here). Big meshes get heavy — `
  const b = document.createElement('button'); b.type = 'button'; b.className = 'banner-btn'; b.textContent = 'make a private room'
  b.addEventListener('click', () => { bannerEl.hidden = true; openRoomsPanel() })
  const x = document.createElement('button'); x.type = 'button'; x.className = 'banner-x'; x.textContent = '✕'; x.setAttribute('aria-label', 'Dismiss')
  x.addEventListener('click', () => { bannerEl.hidden = true })
  bannerEl.append(t, b, x); bannerEl.hidden = false
}

/* ------------------------------------------------------------------ *
 * Theme + safe-view blur
 * ------------------------------------------------------------------ */
const THEMES = ['system', 'dark', 'light']
let theme = 'system'
try { theme = localStorage.getItem('c2c-theme') || 'system' } catch {}
function applyTheme() {
  document.documentElement.dataset.theme = theme
  themeBtn.textContent = theme === 'light' ? '☀️' : theme === 'dark' ? '🌙' : '🌗'
  themeBtn.title = 'Theme: ' + theme
}
function cycleTheme() {
  theme = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length]
  try { localStorage.setItem('c2c-theme', theme) } catch {}
  applyTheme()
}
let safeView = false
try { safeView = localStorage.getItem('c2c-safe') === '1' } catch {}
function applyBlur() {
  document.body.classList.toggle('safe-view', safeView)
  blurBtn.setAttribute('aria-pressed', String(safeView))
  blurBtn.title = safeView ? 'Safe view on (messages blurred until hover)' : 'Safe view off'
}
function toggleBlur() { safeView = !safeView; try { localStorage.setItem('c2c-safe', safeView ? '1' : '0') } catch {}; applyBlur() }

/* ------------------------------------------------------------------ *
 * Unread badge
 * ------------------------------------------------------------------ */
const BASE_TITLE = 'Global Free Speech'
function favicon(count) {
  const c = count > 0 ? `<circle cx='74' cy='26' r='24' fill='%23ff5b7f'/><text x='74' y='35' font-size='34' text-anchor='middle' fill='white'>${count > 9 ? '9+' : count}</text>` : ''
  return `data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>💬</text>${c}</svg>`
}
function setUnread(n) {
  unread = n
  document.title = n > 0 ? `(${n}) ${BASE_TITLE}` : BASE_TITLE
  let link = document.querySelector('link[rel=icon]')
  if (link) link.href = favicon(n)
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) setUnread(0) })

/* ------------------------------------------------------------------ *
 * a11y live region
 * ------------------------------------------------------------------ */
// Two separate polite regions so status/typing and new messages don't clobber
// each other (and #messages itself is aria-live=off to avoid re-announce spam on
// full re-renders). Transient "typing" is intentionally NOT announced (noise).
let msgAnnTimer = null, sysAnnTimer = null
function announceMsg(text) { if (!liveRegion) return; clearTimeout(msgAnnTimer); msgAnnTimer = setTimeout(() => { liveRegion.textContent = text }, 200) }
function announceStatus(text) { if (!liveSys) return; clearTimeout(sysAnnTimer); sysAnnTimer = setTimeout(() => { liveSys.textContent = text }, 350) }

/* ------------------------------------------------------------------ *
 * Panels (focus-trap on mobile drawers) + Escape
 * ------------------------------------------------------------------ */
let lastTrigger = null
// The sidebars are off-canvas drawers ONLY at <=720px; on desktop they're static
// columns. Modal/focus-trap behavior must apply to the drawer case only, else the
// always-visible desktop sidebar becomes a keyboard trap (WCAG 2.1.2).
const isDrawer = () => matchMedia('(max-width: 720px)').matches
function syncScrim() { scrim.hidden = !(peopleEl.classList.contains('open') || rulesEl.classList.contains('open')) }
function openAside(el, toggle) {
  ;(el === peopleEl ? rulesEl : peopleEl).classList.remove('open')
  el.classList.add('open')
  toggle.setAttribute('aria-expanded', 'true'); syncScrim()
  if (isDrawer()) {
    el.setAttribute('aria-modal', 'true'); el.setAttribute('role', 'dialog')
    lastTrigger = toggle
    const f = el.querySelector('.side-close'); if (f && f.offsetParent !== null) f.focus()
  }
}
function closeAside(el) {
  el.classList.remove('open'); el.removeAttribute('aria-modal'); el.removeAttribute('role')
  peopleToggle.setAttribute('aria-expanded', String(peopleEl.classList.contains('open')))
  rulesToggle.setAttribute('aria-expanded', String(rulesEl.classList.contains('open')))
  syncScrim()
  if (lastTrigger) { lastTrigger.focus(); lastTrigger = null }
}
function closePanels() { for (const el of [peopleEl, rulesEl]) if (el.classList.contains('open')) closeAside(el) }
function trapTab(e) {
  if (e.key !== 'Tab' || !isDrawer()) return
  const open = peopleEl.classList.contains('open') ? peopleEl : rulesEl.classList.contains('open') ? rulesEl : null
  if (!open) return
  const f = [...open.querySelectorAll('button, [href], input, [tabindex]:not([tabindex="-1"])')].filter(x => x.offsetParent !== null)
  if (!f.length) return
  const first = f[0], last = f[f.length - 1]
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
}

/* ------------------------------------------------------------------ *
 * Wire up UI
 * ------------------------------------------------------------------ */
sendBtn.addEventListener('click', sendMessage)
inputEl.addEventListener('input', onLocalInput)
inputEl.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage() }
  else if (e.key === 'Escape' && replyTo) cancelReply()
})
replyCancel.addEventListener('click', cancelReply)

emojiBtn.addEventListener('click', e => { e.stopPropagation(); emojiPanel.hidden = !emojiPanel.hidden; if (!emojiPanel.hidden) { emojiSearch.value = ''; buildEmoji(''); emojiSearch.focus() } })
emojiSearch.addEventListener('input', () => buildEmoji(emojiSearch.value))
document.addEventListener('click', e => { if (!emojiPanel.hidden && !emojiPanel.contains(e.target) && e.target !== emojiBtn) emojiPanel.hidden = true })

statusBtn.addEventListener('click', e => { e.stopPropagation(); toggleStatusPanel() })
document.addEventListener('click', e => { if (!statusPanel.hidden && !statusPanel.contains(e.target) && !statusBtn.contains(e.target)) statusPanel.hidden = true })

roomsBtn.addEventListener('click', e => { e.stopPropagation(); roomsPanel.hidden ? openRoomsPanel() : (roomsPanel.hidden = true) })
document.addEventListener('click', e => { if (!roomsPanel.hidden && !roomsPanel.contains(e.target) && !roomsBtn.contains(e.target)) roomsPanel.hidden = true })
roomsCopyLink.addEventListener('click', () => copyText(shareUrl(), roomsCopyLink, '🔗 Copy link'))
roomsCopyName.addEventListener('click', () => { if (!CONFIG.isDefaultRoom) copyText(CONFIG.roomCode, roomsCopyName, '# Copy name') })
roomGoBtn.addEventListener('click', () => {
  const n = normName(roomNameInput.value), pass = roomPassInput.value.trim()
  if (!n) { roomNameInput.focus(); return }
  if (!pass) { roomPassInput.focus(); return }
  gotoRoom(n, pass)
})
roomNameInput.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); roomPassInput.focus() } })
roomPassInput.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); roomGoBtn.click() } })
roomPublicBtn.addEventListener('click', () => { history.replaceState(null, '', '/'); location.reload() })

themeBtn.addEventListener('click', cycleTheme)
blurBtn.addEventListener('click', toggleBlur)

peopleToggle.addEventListener('click', () => peopleEl.classList.contains('open') ? closeAside(peopleEl) : openAside(peopleEl, peopleToggle))
peopleClose.addEventListener('click', () => closeAside(peopleEl))
rulesToggle.addEventListener('click', () => rulesEl.classList.contains('open') ? closeAside(rulesEl) : openAside(rulesEl, rulesToggle))
rulesClose.addEventListener('click', () => closeAside(rulesEl))
scrim.addEventListener('click', closePanels)
document.addEventListener('keydown', e => {
  if (e.key === 'Tab') trapTab(e)
  if (e.key !== 'Escape') return
  if (!emojiPanel.hidden) { emojiPanel.hidden = true; emojiBtn.focus(); return }
  if (!roomsPanel.hidden) { roomsPanel.hidden = true; return }
  if (!statusPanel.hidden) { statusPanel.hidden = true; return }
  if (reactMenu) { closeReactMenu(); return }
  if (peopleEl.classList.contains('open') || rulesEl.classList.contains('open')) closePanels()
})
;['mousemove', 'keydown', 'touchstart'].forEach(ev => window.addEventListener(ev, () => { if (myPresence === 'idle') bumpActivity() }, {passive: true}))

const leaveRoom = () => { try { if (room) room.leave() } catch {} }
window.addEventListener('pagehide', leaveRoom)
window.addEventListener('beforeunload', leaveRoom)
window.addEventListener('online', () => setStatus('Reconnecting…'))
window.addEventListener('offline', () => { statusDot.className = 'dot dot--off'; setStatus('Offline') })
window.addEventListener('error', e => addSystem('⚠️ ' + (e.message || 'a script error occurred')))
window.addEventListener('unhandledrejection', e => addSystem('⚠️ ' + ((e.reason && e.reason.message) || 'an async error occurred')))

/* ------------------------------------------------------------------ *
 * Name handling
 * ------------------------------------------------------------------ */
function setMyName(n) {
  myName = sanitize(n, CONFIG.maxNameLen).trim()
  meName.textContent = myName
  meDot.style.background = colorOf(selfId)
  try { localStorage.setItem('c2c-name', myName) } catch {}
  renderRoster()
}
const ADJ = ['Quiet', 'Brave', 'Lunar', 'Swift', 'Vivid', 'Mellow', 'Cosmic', 'Crimson', 'Golden', 'Hidden', 'Wild', 'Calm']
const ANI = ['Otter', 'Fox', 'Heron', 'Lynx', 'Raven', 'Moth', 'Koi', 'Wren', 'Ibex', 'Falcon', 'Comet', 'Maple']
const surprise = () => ADJ[Math.floor(Math.random() * ADJ.length)] + ANI[Math.floor(Math.random() * ANI.length)]

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */
function boot() {
  applyTheme(); applyBlur()
  nickInput.maxLength = CONFIG.maxNameLen
  inputEl.maxLength = CONFIG.maxMsgLen
  buildEmoji('')
  updateSendBtn()
  emptyBtn.addEventListener('click', () => copyText(shareUrl(), emptyBtn, '🔗 Copy invite link'))

  // room chip + gate room label
  if (CONFIG.isDefaultRoom) { roomChip.hidden = true; gateRoomLabel.textContent = 'the public room' }
  else { roomChipName.textContent = '#' + CONFIG.roomCode; roomChip.hidden = false; gateRoomLabel.textContent = 'private room #' + CONFIG.roomCode; gatePassWrap.hidden = false }

  // prefilled password (set when navigating from "new room")
  try { const p = sessionStorage.getItem('c2c-pass-' + CONFIG.roomCode); if (p) { myPass = p; gatePass.value = p } } catch {}

  let saved = ''
  try { saved = localStorage.getItem('c2c-name') || '' } catch {}
  if (saved) nickInput.value = saved
  const refreshAvatar = () => {
    const n = nickInput.value.trim()
    gateAvatar.style.background = colorOf(selfId)
    gateAvatar.textContent = initialOf(n || '?')
  }
  refreshAvatar()
  nickInput.addEventListener('input', refreshAvatar)
  surpriseBtn.addEventListener('click', () => { nickInput.value = surprise(); refreshAvatar(); nickInput.focus() })
  nickInput.focus()

  gateForm.addEventListener('submit', e => {
    e.preventDefault()
    const n = sanitize(nickInput.value, CONFIG.maxNameLen).trim()
    if (!n) { nickInput.focus(); return }
    if (!CONFIG.isDefaultRoom) {
      myPass = gatePass.value.trim()
      if (!myPass) { gatePass.focus(); gatePass.placeholder = '⚠ password required to enter this private room'; return }
    }
    setMyName(n)
    gate.hidden = true; app.hidden = false; inputEl.focus()
    renderRoster(); refreshEmpty(); bumpActivity(); startChat()
  })
}

boot()
