// Global Free Speech — serverless, ephemeral, peer-to-peer chat.
//
// No backend: peers find each other via free public Nostr relays (Trystero,
// vendored) for the encrypted WebRTC handshake only; chat flows directly
// browser-to-browser over end-to-end-encrypted data channels and is never stored.
// Live history hand-off lets newcomers catch up from whoever is currently present.

import {joinRoom, selfId, getRelaySockets} from './vendor/trystero-nostr.bundle.js'

// WebCrypto + reliable WebRTC need a secure context. A plain-http visit (e.g.
// Enforce-HTTPS off after a Pages reset) loads fine but can never connect —
// crypto.subtle doesn't exist there — so upgrade to https before anything runs.
if (location.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)) {
  location.replace('https://' + location.host + location.pathname + location.search + location.hash)
}

// Best-effort clickjacking guard. GitHub Pages can't send frame-ancestors /
// X-Frame-Options headers (and frame-ancestors is ignored in a meta CSP), so
// bust out of any embedding frame; if the framer blocks that, hide the app.
try { if (window.top !== window.self) window.top.location.replace(location.href) } catch { document.documentElement.hidden = true }

/* ------------------------------------------------------------------ *
 * Base path — lets the app run at a domain root AND under a /repo/
 * subpath (GitHub Pages project sites). index.html knows its own
 * directory; the 404.html copy (flagged by the build) serves unknown
 * deep paths, so it falls back to the base remembered from a direct
 * visit, then to the first path segment on *.github.io, then to /.
 * ------------------------------------------------------------------ */
const BASE = (() => {
  if (!window.__C2C_404) {
    const dir = location.pathname.replace(/[^/]*$/, '')
    try { localStorage.setItem('c2c-base', dir) } catch {}
    return dir
  }
  let saved = ''
  try { saved = localStorage.getItem('c2c-base') || '' } catch {}
  if (saved && location.pathname.startsWith(saved)) return saved
  if (/\.github\.io$/i.test(location.hostname)) {
    const seg = location.pathname.split('/').filter(Boolean)
    return seg.length ? '/' + seg[0] + '/' : '/'
  }
  return '/'
})()

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
  const want = BASE + (ROOM_CODE ? '#r=' + ROOM_CODE : '')
  if (location.pathname + location.search + location.hash !== want) history.replaceState(null, '', want)
} catch {}

/* ------------------------------------------------------------------ *
 * Config — safe to edit.
 * ------------------------------------------------------------------ */
const CONFIG = {
  appId: 'chat-to-chat-p2p-v1',
  // Default public room = host (+ subpath on project sites, so each /repo/ is its
  // own room). A share code switches to a private/topical room. A root deployment
  // keeps the bare hostname so existing rooms aren't split by an update.
  roomId: ROOM_CODE ? 'code:' + ROOM_CODE : ((location.hostname || 'localhost') + (BASE === '/' ? '' : BASE)),
  isDefaultRoom: !ROOM_CODE,
  roomCode: ROOM_CODE,
  // Curated high-uptime public Nostr relays (free, not owner-run). Pinning these
  // (vs Trystero's churny ~46-relay default) makes peer discovery deterministic.
  // (Trystero connects to ALL custom urls — redundancy only trims its default
  // list — so every client shares the same relay set and discovery overlaps.)
  relayUrls: [
    'wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.nostr.band',
    'wss://relay.primal.net', 'wss://nostr.mom', 'wss://relay.0xchat.com',
    'wss://nostr.bitcoiner.social', 'wss://relay.nostr.net', 'wss://offchain.pub',
  ],
  relayRedundancy: 10,
  // Free public TURN (Open Relay Project, static credentials — these are the
  // published shared ones, not a secret). STUN alone can't cross symmetric NATs
  // (most mobile carriers), which makes peers on different networks fail AFTER
  // discovery. ICE only uses TURN when a direct path fails; traffic stays E2EE.
  // Swap for your own TURN here if you have one (see README → Connectivity).
  turnConfig: [
    {
      urls: [
        'turn:staticauth.openrelay.metered.ca:80',
        'turn:staticauth.openrelay.metered.ca:443',
        'turn:staticauth.openrelay.metered.ca:443?transport=tcp',
      ],
      username: 'openrelayproject', credential: 'openrelayproject',
    },
    {
      urls: ['turn:openrelay.metered.ca:80', 'turn:openrelay.metered.ca:443?transport=tcp'],
      username: 'openrelayproject', credential: 'openrelayproject',
    },
  ],
  maxNameLen: 24,
  maxMsgLen: 4000,
  minPassLen: 8,   // room passwords become key material — refuse trivially guessable ones
  maxFileBytes: 10 * 1024 * 1024,   // 10 MB cap per file (sent P2P, never stored)
  maxRendered: 400,
  historyShare: 30,
  meshCap: 12,
  idleMs: 60000,
  gapDividerMs: 5 * 60 * 1000,
  // per-channel inbound flood budgets (count within window ms)
  flood: { msg: [20, 2000], name: [6, 4000], typing: [40, 2000], react: [40, 2000], presence: [20, 4000], file: [6, 12000], attq: [4, 10000], atth: [8, 10000] },
  jumpAt: 400,        // px scrolled away from the newest before "jump to latest" appears
  counterAt: 0.85,    // show the character counter past this fraction of maxMsgLen
}

/* ------------------------------------------------------------------ *
 * DOM
 * ------------------------------------------------------------------ */
const $ = s => document.querySelector(s)
const gate = $('#gate'), gateForm = $('#gate-form'), nickInput = $('#nick'), surpriseBtn = $('#surprise'), gateErr = $('#gate-err'), gateGo = $('#gate-go')
const gateAvatar = $('#gate-avatar'), gatePass = $('#gate-pass'), gatePassWrap = $('#gate-pass-wrap'), gateRoomLabel = $('#gate-room')
const app = $('#app'), messagesEl = $('#messages'), typingEl = $('#typing'), jumpBtn = $('#jump'), bannerEl = $('#banner')
const inputEl = $('#input'), sendBtn = $('#send'), emojiBtn = $('#emoji-btn'), emojiPanel = $('#emoji'), emojiSearch = $('#emoji-search'), emojiGrid = $('#emoji-grid')
const attachBtn = $('#attach-btn'), fileInput = $('#file-input'), chatEl = document.querySelector('.chat')
const replyBar = $('#reply-bar'), replyText = $('#reply-text'), replyCancel = $('#reply-cancel')
const statusBtn = $('#status'), statusDot = $('#status-dot'), statusText = $('#status-text'), statusPanel = $('#status-panel')
const onlineCountEl = $('#online-count'), peopleEl = $('#people'), peopleListEl = $('#people-list'), peopleCountEl = $('#people-count')
const rulesEl = $('#rules')
const peopleToggle = $('#people-toggle'), peopleClose = $('#people-close')
const rulesToggle = $('#rules-toggle'), rulesClose = $('#rules-close')
const scrim = $('#scrim'), meName = $('#me-name'), meDot = $('#me-dot')
const roomChip = $('#room-chip'), roomChipName = $('#room-chip-name')
const roomsBtn = $('#rooms-btn'), roomsPanel = $('#rooms'), roomCurrentEl = $('#room-current'), roomsCopyLink = $('#rooms-copy-link'), roomsCopyName = $('#rooms-copy-name'), roomNameInput = $('#room-name'), roomPassInput = $('#room-pass'), roomErrEl = $('#room-err'), roomGoBtn = $('#room-go'), roomPublicBtn = $('#room-public')
const themeBtn = $('#theme-btn'), blurBtn = $('#blur-btn'), liveRegion = $('#live'), liveSys = $('#live-sys')
const soundBtn = $('#sound-btn'), notifyBtn = $('#notify-btn'), relayBtn = $('#relay-btn')
const lightbox = $('#lightbox'), lightboxImg = $('#lightbox-img'), lightboxDl = $('#lightbox-dl'), lightboxName = $('#lightbox-name'), lightboxClose = $('#lightbox-close')
const emptyEl = $('#empty'), emptyH = $('#empty-h'), emptyP = $('#empty-p'), emptyBtn = $('#empty-btn')
const renameModal = $('#rename'), renameForm = $('#rename-form'), renameMsg = $('#rename-msg'), renameInput = $('#rename-input'), renameErr = $('#rename-err')
const counterEl = $('#counter')

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
const entryById = new Map()        // id -> entry (O(1); timeline stays the ordered source)
const nodeCache = new Map()        // id -> {k, el} — rendered rows, reused across re-renders
let unreadMarkerId = null          // first message that arrived while you were away
let seq = 0
let iTyping = false, typingSentAt = 0, typingStopTimer = null
let myPresence = 'active', idleTimer = null
let unread = 0
let replyTo = null                 // {key, name, snippet}
let pendingSys = []                // batched join/leave/rename lines
let pendingSysTimer = null
let entered = false                // true once past the join-screen name check

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
// clamp claimed timestamps to [now − 48h, now + 60s] so a peer can't pin
// messages to the top of the timeline (where they'd evict first) or the future
const validT = t => {
  const now = Date.now()
  return (typeof t === 'number' && isFinite(t)) ? Math.min(Math.max(t, now - 48 * 3600 * 1000), now + 60000) : now
}
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
const distFromBottom = () => messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight
const isNearBottom = () => distFromBottom() < 120
const isMuted = peerId => muted.has(peerId)
// one-line preview of an entry — used by reply quotes for messages AND files
const snippetOf = e => (e && e.kind === 'file') ? '📎 ' + (e.fileName || 'file') : String((e && e.text) || '').slice(0, 120)

// Case-insensitive, trimmed equality — display names must be unique per room.
const sameName = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase()
// is `name` already used by a currently-present peer?
function nameTakenByPeer(name) {
  for (const p of peers.values()) if (p.name && sameName(p.name, name)) return true
  return false
}
// Deterministic: if a present peer shares my name, the HIGHER selfId yields. Rather
// than auto-renaming, the loser is FORCED to pick a new name via a blocking modal.
let renaming = false
function checkMyNameCollision() {
  if (!entered || !myName) return
  let clash = false
  for (const [id, p] of peers) { if (p.name && sameName(p.name, myName) && selfId > id) { clash = true; break } }
  if (clash) openRenameModal()
  else maybeCloseRename()   // clash cleared (peer left/renamed) → release the modal
}
function setComposerEnabled(on) {
  inputEl.disabled = !on; emojiBtn.disabled = !on; attachBtn.disabled = !on
  sendBtn.disabled = !on || !inputEl.value.trim()
}
function openRenameModal() {
  if (renaming) return
  renaming = true
  renameMsg.textContent = `The name "${myName}" is already taken in this room. Choose a different name to keep chatting.`
  renameInput.value = ''; renameErr.hidden = true
  renameModal.hidden = false
  setComposerEnabled(false)
  setTimeout(() => renameInput.focus(), 0)
}
function closeRenameModal() {
  renaming = false
  renameModal.hidden = true
  setComposerEnabled(true); updateSendBtn(); inputEl.focus()
}
function maybeCloseRename() {
  if (renaming && !nameTakenByPeer(myName)) { addSystem(`The name clash cleared — you kept "${myName}".`); closeRenameModal() }
}
function doRename() {
  const n = sanitize(renameInput.value, CONFIG.maxNameLen).trim()
  if (!n) { renameErr.textContent = 'Please enter a name.'; renameErr.hidden = false; return }
  if (nameTakenByPeer(n)) { renameErr.textContent = `"${n}" is also taken — try another.`; renameErr.hidden = false; return }
  const old = myName
  setMyName(n); if (actions) actions.name.send(myName)
  addSystem(`You renamed from "${old}" to "${myName}".`)
  closeRenameModal()
}
// Names are unauthenticated → still visually flag if two VISIBLE peers share one.
// The duplicate set is recomputed only when the roster changes, so rendering a
// message is an O(1) lookup instead of a scan over every peer.
let dupNames = new Set()
function refreshDupNames() {
  const counts = new Map()
  const add = n => { if (!n) return; const k = String(n).trim().toLowerCase(); counts.set(k, (counts.get(k) || 0) + 1) }
  add(myName)
  for (const [id, p] of peers) if (!isMuted(id)) add(p.name)
  const next = new Set()
  for (const [k, c] of counts) if (c > 1) next.add(k)
  dupNames = next
}
const nameIsDuplicated = name => !!name && dupNames.has(String(name).trim().toLowerCase())

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
  if (entry.id) entryById.set(entry.id, entry)
  const atEnd = i === timeline.length - 1
  let evicted = false
  while (timeline.length > CONFIG.maxRendered) {
    const r = timeline.shift()
    evicted = true
    entryById.delete(r.id); nodeCache.delete(r.id)   // drop the retained DOM row too
    if (r.kind === 'msg' || r.kind === 'file') reactions.delete(r.id)
    if (r.id === unreadMarkerId) unreadMarkerId = null   // its divider can never render again
    if (r.kind === 'file' && r.url) URL.revokeObjectURL(r.url)   // free the blob (ephemeral)
    // Do NOT delete r.id from seenIds — keeping dedup stable stops an evicted
    // message being re-inserted as a duplicate by a late history burst.
  }
  // soft-cap the dedup set so a marathon session can't grow it unbounded
  if (seenIds.size > 4000) { const it = seenIds.values(); for (let k = 0; k < 1000; k++) seenIds.delete(it.next().value) }
  return {atEnd, evicted}
}

function visibleEntries() {
  return timeline.filter(e => e.kind === 'sys' || !isMuted(e.peerId))   // mute hides msg + file
}

// Rows are built once and cached by entry id. A re-render (mute, history burst,
// file event) then reorders existing nodes instead of rebuilding thousands of
// elements — the cache key covers everything a row's markup depends on, so a
// changed row is rebuilt and an unchanged one is reused.
function nodeFor(e, grouped) {
  const dup = e.peerId !== selfId && nameIsDuplicated(e.name)
  const k = `${grouped ? 1 : 0}|${e.name}|${dup ? 1 : 0}|${e.url ? 1 : 0}|${e.progress || 0}`
  const hit = nodeCache.get(e.id)
  if (hit && hit.k === k) return hit.el
  const el = e.kind === 'file' ? fileNode(e, grouped) : msgNode(e, grouped)
  nodeCache.set(e.id, {k, el})
  return el
}
function sysFor(e) {
  const hit = nodeCache.get(e.id)
  if (hit && hit.k === 'sys') return hit.el
  const el = sysNode(e.text)
  nodeCache.set(e.id, {k: 'sys', el})
  return el
}

function renderTimeline({stick} = {}) {
  const atBottom = stick ?? isNearBottom()
  const prevTop = messagesEl.scrollTop
  const frag = document.createDocumentFragment()
  let last = null, lastT = 0
  for (const e of visibleEntries()) {
    if (e.id === unreadMarkerId) frag.appendChild(unreadDivider())
    if (e.kind === 'sys') { frag.appendChild(sysFor(e)); last = null; lastT = e.t; continue }
    if (lastT && e.t - lastT > CONFIG.gapDividerMs) { frag.appendChild(sysNode(timeLabel(e.t))); last = null }
    const grouped = last === e.peerId && !e.emote
    frag.appendChild(nodeFor(e, grouped))
    last = e.emote ? null : e.peerId; lastT = e.t
  }
  messagesEl.replaceChildren(frag)
  messagesEl.scrollTop = atBottom ? messagesEl.scrollHeight : prevTop
  if (atBottom) { hideJump(); keepAtBottom = true }
  refreshEmpty()
}

function unreadDivider() {
  const el = document.createElement('div')
  el.className = 'unread-div'
  el.textContent = 'New messages'
  return el
}

// "14:32" today, "Yesterday · 14:32", "Tuesday · 14:32" within the week —
// friendlier to read than a bare date when catching up
function timeLabel(t) {
  const d = new Date(t), now = new Date()
  const dayStart = x => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const days = Math.round((dayStart(now) - dayStart(d)) / 86400000)
  if (days <= 0) return fmtTime(t)
  if (days === 1) return 'Yesterday · ' + fmtTime(t)
  if (days < 7) return d.toLocaleDateString([], {weekday: 'long'}) + ' · ' + fmtTime(t)
  return d.toLocaleDateString([], {month: 'short', day: 'numeric'}) + ' · ' + fmtTime(t)
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
  if (!self && nameIsDuplicated(e.name)) meta.appendChild(badge(e.peerId))
  const time = document.createElement('span')
  time.className = 'time'
  time.textContent = fmtTime(e.t)
  // the relative label ("3 min ago") is refreshed on hover — baking it in at build
  // time would freeze every message at "just now"
  time.dataset.t = String(e.t)
  time.title = relTime(e.t)
  meta.appendChild(time)
  if (self) {
    const tk = document.createElement('button')
    tk.type = 'button'
    paintTick(tk, e.status)
    tk.addEventListener('click', () => retrySend(e))
    meta.appendChild(tk)
  }
  stack.appendChild(meta)

  if (e.reply) stack.appendChild(replyQuote(e.reply))

  const bubble = document.createElement('div')
  bubble.className = 'bubble'
  renderRichText(bubble, e.text)
  stack.appendChild(bubble)

  const rbar = reactionBar(e.id)
  if (rbar) stack.appendChild(rbar)

  // hover toolbar on pointer devices; long-press / swipe-to-reply on touch
  stack.appendChild(msgTools(e))
  attachTouchGestures(row, e)

  row.appendChild(stack)
  return row
}

// keep the "N min ago" tooltip honest without a timer ticking over every row
messagesEl.addEventListener('pointerover', ev => {
  const t = ev.target && ev.target.closest && ev.target.closest('.time[data-t]')
  if (t) t.title = relTime(Number(t.dataset.t))
}, {passive: true})

/* ----- touch gestures: long-press for tools, swipe right to reply ---- */
const LONG_PRESS_MS = 420, SWIPE_TRIGGER = 52, SWIPE_MAX = 48
const buzz = ms => { try { if (navigator.vibrate) navigator.vibrate(ms) } catch {} }
function openTools(row) {
  const open = messagesEl.querySelector('.msg.tools-open')
  if (open && open !== row) open.classList.remove('tools-open')
  row.classList.add('tools-open')
}
function attachTouchGestures(row, entry) {
  let pressTimer = null, x0 = 0, y0 = 0, dx = 0, tracking = false, swiping = false
  const cancelPress = () => { clearTimeout(pressTimer); pressTimer = null }

  row.addEventListener('pointerdown', ev => {
    if (ev.pointerType === 'mouse' || !isDrawer()) return
    if (ev.target.closest('.msgtools, a, .react, .replyquote, .fdl, .filemsg-img')) return
    x0 = ev.clientX; y0 = ev.clientY; dx = 0; tracking = true; swiping = false
    pressTimer = setTimeout(() => { pressTimer = null; tracking = false; openTools(row); buzz(12) }, LONG_PRESS_MS)
  }, {passive: true})

  row.addEventListener('pointermove', ev => {
    if (!tracking) return
    const mx = ev.clientX - x0, my = ev.clientY - y0
    if (!swiping) {
      // let a mostly-vertical drag be a normal scroll and give up the gesture
      if (Math.abs(my) > 10 && Math.abs(my) >= Math.abs(mx)) { tracking = false; cancelPress(); return }
      if (mx > 10) { swiping = true; cancelPress() } else return
    }
    dx = Math.max(0, Math.min(mx - 10, SWIPE_MAX))
    row.style.transform = 'translateX(' + dx + 'px)'
    row.classList.toggle('swipe-armed', mx > SWIPE_TRIGGER)
  }, {passive: true})

  const release = () => {
    cancelPress()
    if (swiping) {
      if (row.classList.contains('swipe-armed')) { startReply(entry); buzz(10) }
      row.classList.add('swipe-back')
      row.style.transform = ''
      setTimeout(() => row.classList.remove('swipe-back'), 200)
    }
    row.classList.remove('swipe-armed')
    tracking = false; swiping = false; dx = 0
  }
  row.addEventListener('pointerup', release, {passive: true})
  row.addEventListener('pointercancel', release, {passive: true})
}

/* ----- delivery state for your own messages (patched in place) ---- */
const TICKS = {
  sending: ['◌', 'Sending…'],
  sent: ['✓', 'Sent to everyone here'],
  alone: ['·', 'No one else is here yet — nobody received this'],
  failed: ['⚠', 'Could not send — tap to try again'],
}
function paintTick(el, status) {
  const [glyph, title] = TICKS[status] || TICKS.sending
  el.className = 'tick tick--' + (status || 'sending')
  el.textContent = glyph
  el.title = title
  // only a failed send is actionable; the rest are read-only state
  el.disabled = status !== 'failed'
  el.setAttribute('aria-label', title)
}
function setMsgStatus(entry, status) {
  entry.status = status
  const hit = nodeCache.get(entry.id)
  const el = hit && hit.el.querySelector('.tick')
  if (el) paintTick(el, status)
}
// Re-send a message whose first attempt failed. Peers dedupe on the id, so a
// retry that partially landed the first time can't produce a double.
function retrySend(entry) {
  if (!actions || entry.status !== 'failed') return
  setMsgStatus(entry, 'sending')
  const audience = peers.size
  const payload = {id: rawIdOf(entry.id), t: entry.wt ?? entry.t, name: myName, text: entry.text, prev: entry.prev || []}
  if (entry.emote) payload.emote = true
  if (entry.reply) payload.reply = entry.reply
  Promise.resolve(actions.msg.send(payload)).then(
    () => setMsgStatus(entry, audience ? 'sent' : 'alone'),
    () => setMsgStatus(entry, 'failed'))
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

// `[data-key]` (not `.msg[data-key]`) so a quoted /me line — which renders as
// `.sys.emote` — can still be jumped to
function scrollToKey(key) {
  const el = messagesEl.querySelector(`[data-key="${cssEsc(key)}"]`)
  if (!el) { addSystem('That message is no longer in view.'); return }
  el.scrollIntoView({block: 'center', behavior: 'smooth'})
  el.classList.add('flash')
  setTimeout(() => el.classList.remove('flash'), 1200)
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
// `(?<!\\)` lets a backslash escape the opening `_`, so ¯\_(ツ)_/¯ stays intact
const INLINE_RE = /(\*\*([^*]+)\*\*|`([^`]+)`|(?<!\\)_([^_]+)_)/g
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
// A reaction must actually be emoji — otherwise a peer can pin arbitrary short
// text ("chips") to anyone's message. Allow pictographs + the components that
// glue sequences together (ZWJ, VS16, skin tones, flags), but require at least
// one real pictograph/flag so plain digits or '#' don't pass.
const EMOJI_ONLY_RE = /^[\p{Extended_Pictographic}\p{Emoji_Component}\u200D\uFE0F]+$/u
const HAS_EMOJI_RE = /\p{Extended_Pictographic}|\p{Regional_Indicator}/u
const validEmoji = s => typeof s === 'string' && !!s && s.length <= 8 && EMOJI_ONLY_RE.test(s) && HAS_EMOJI_RE.test(s)
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
  if (e.kind !== 'file') {                        // nothing to put on the clipboard for a transfer
    const copy = document.createElement('button')
    copy.type = 'button'; copy.className = 'mt'; copy.textContent = '⧉'; copy.title = 'Copy text'
    copy.setAttribute('aria-label', 'Copy message text')
    copy.addEventListener('click', ev => {
      ev.stopPropagation()
      writeClipboard(e.text).then(ok => {
        copy.textContent = ok ? '✓' : '✕'
        copy.classList.add('mt--flash')
        setTimeout(() => { copy.textContent = '⧉'; copy.classList.remove('mt--flash') }, 1100)
      })
    })
    t.appendChild(copy)
  }
  return t
}
let reactMenu = null, reactAnchor = null
function placeReactMenu() {
  if (!reactMenu || !reactAnchor) return
  // the anchor scrolled out of the message list → the menu has nothing to point at
  if (!reactAnchor.isConnected) { closeReactMenu(); return }
  const r = reactAnchor.getBoundingClientRect(), m = reactMenu.getBoundingClientRect()
  const top = r.bottom + 6 + m.height > innerHeight ? r.top - m.height - 6 : r.bottom + 6
  reactMenu.style.top = Math.max(8, top) + 'px'
  reactMenu.style.left = Math.max(8, Math.min(r.left, innerWidth - m.width - 8)) + 'px'
}
function openReactMenu(anchor, key) {
  closeReactMenu()
  reactMenu = document.createElement('div')
  reactMenu.className = 'reactmenu'
  reactMenu.setAttribute('role', 'group')
  reactMenu.setAttribute('aria-label', 'Quick reactions')
  QUICK_REACTS.forEach(em => {
    const b = document.createElement('button')
    b.type = 'button'; b.textContent = em; b.setAttribute('aria-label', 'React with ' + em)
    b.addEventListener('click', () => { toggleReaction(key, em); closeReactMenu() })
    reactMenu.appendChild(b)
  })
  // portaled to <body>: a popup nested in a paint-contained row would be clipped
  document.body.appendChild(reactMenu)
  reactAnchor = anchor
  placeReactMenu()
  // a fixed-position popup would otherwise hang in mid-air once the list moves
  messagesEl.addEventListener('scroll', placeReactMenu, {passive: true})
  window.addEventListener('resize', placeReactMenu, {passive: true})
  setTimeout(() => document.addEventListener('click', closeReactMenu, {once: true}), 0)
}
function closeReactMenu() {
  if (!reactMenu) return
  messagesEl.removeEventListener('scroll', placeReactMenu)
  window.removeEventListener('resize', placeReactMenu)
  reactMenu.remove(); reactMenu = null; reactAnchor = null
}

/* ----- replies ---- */
function startReply(e) {
  replyTo = {key: e.id, name: e.peerId === selfId ? 'yourself' : e.name, snippet: snippetOf(e)}
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
  const stick = keepAtBottom
  const entry = {kind: 'sys', id: 'sys-' + seq++, t: Date.now(), text}
  const res = addEntry(entry)
  if (!res) return
  // Same fast path the message hot path uses: a join/leave/status line at the end
  // of an already-rendered timeline is one appendChild, not a full rebuild.
  if (res.atEnd && !res.evicted && messagesEl.firstElementChild) {
    messagesEl.appendChild(sysFor(entry))
    if (stick) stickToBottom()
  } else renderTimeline({stick})
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
  // `keepAtBottom` is maintained by the scroll listener, so the hot path doesn't
  // have to read scrollTop/scrollHeight (a forced layout) for every message
  const stick = fromSelf || keepAtBottom
  const res = addEntry({kind: 'msg', ...entry})
  if (!res) return false
  // fast path only when the entry lands at the end AND nothing was evicted (so the
  // DOM stays in lockstep with the timeline); otherwise do a full, correct render.
  const fast = res.atEnd && !res.evicted && !isMuted(entry.peerId) && messagesEl.firstElementChild && emptyEl.hidden
  // mark where "away" reading should resume, before the row is placed
  if (!fromSelf && !isMuted(entry.peerId) && unreadMarkerId === null && (document.hidden || !stick)) unreadMarkerId = entry.id
  if (fast) appendOne(entry, stick); else renderTimeline({stick})
  if (!fromSelf && !isMuted(entry.peerId)) {
    announceMsg(`${entry.name}: ${entry.text}`)
    chime()
    if (document.hidden) { setUnread(unread + 1); notifyDesktop(entry.name, entry.text) }
  }
  if (!stick && !fromSelf) { awayCount++; showJump() }
  return true
}

function appendOne(entry, stick) {
  // grouping + gap divider derived from the timeline (not the DOM), so it stays
  // correct; the previous visible entry is found by walking back from the end
  // rather than materialising and scanning the whole visible list.
  let prev = null
  for (let i = timeline.length - 2; i >= 0; i--) {
    const e = timeline[i]
    if (e.kind === 'sys' || !isMuted(e.peerId)) { prev = e; break }
  }
  if (entry.id === unreadMarkerId) messagesEl.appendChild(unreadDivider())
  if (prev && prev.kind === 'msg' && entry.t - prev.t > CONFIG.gapDividerMs) messagesEl.appendChild(sysNode(timeLabel(entry.t)))
  const grouped = !!prev && prev.kind === 'msg' && !prev.emote && !entry.emote && prev.peerId === entry.peerId && entry.t - prev.t <= CONFIG.gapDividerMs
  const node = nodeFor(entry, grouped)
  // The class must come back off: cached rows are re-inserted by a later full
  // render, and a re-inserted element replays its animation — so a stale
  // `msg--new` would make old rows pop again every time the list rebuilds.
  node.classList.add('msg--new')
  setTimeout(() => node.classList.remove('msg--new'), 300)
  messagesEl.appendChild(node)
  if (stick) stickToBottom()
}

// Coalesce the scroll-to-bottom into one write per frame: a burst of ten
// messages in a single tick then costs one layout instead of ten.
let stickPending = false
function stickToBottom() {
  if (stickPending) return
  stickPending = true
  requestAnimationFrame(() => { stickPending = false; messagesEl.scrollTop = messagesEl.scrollHeight })
}

/* ------------------------------------------------------------------ *
 * Mobile keyboard — keep the header on screen
 *
 * A software keyboard shrinks the VISUAL viewport but leaves the layout
 * viewport (and 100dvh) alone, so the app ends up taller than what you can
 * see and the browser scrolls the whole page up to reveal the composer —
 * taking the top bar with it. Driving the app's height from
 * visualViewport.height keeps it exactly as tall as the visible area, and
 * undoing any page scroll pins the header at the top. (Android also gets
 * interactive-widget=resizes-content from the viewport meta.)
 * ------------------------------------------------------------------ */
let keepAtBottom = true   // are we pinned to the newest message? (kept fresh on scroll)
function initViewportFit() {
  const vv = window.visualViewport
  if (!vv) return
  let pending = 0
  const fit = () => {
    cancelAnimationFrame(pending)
    pending = requestAnimationFrame(() => {
      document.documentElement.style.setProperty('--app-h', Math.round(vv.height) + 'px')
      // the document itself must never scroll — that is what hides the header
      if (window.scrollY || window.scrollX) window.scrollTo(0, 0)
      // the keyboard shouldn't push the latest message out of view
      if (keepAtBottom && entered) messagesEl.scrollTop = messagesEl.scrollHeight
    })
  }
  vv.addEventListener('resize', fit, {passive: true})
  vv.addEventListener('scroll', fit, {passive: true})
  window.addEventListener('orientationchange', () => setTimeout(fit, 300), {passive: true})
  fit()
}

/* ------------------------------------------------------------------ *
 * Scroll-to-latest
 * ------------------------------------------------------------------ */
let awayCount = 0
function showJump() {
  const label = awayCount ? `↓ ${awayCount} new message${awayCount > 1 ? 's' : ''}` : '↓ Latest'
  if (jumpBtn.textContent !== label) jumpBtn.textContent = label
  jumpBtn.hidden = false
}
function hideJump() { jumpBtn.hidden = true; awayCount = 0 }
// While the smooth scroll to the bottom is still running we are, by definition,
// far from the bottom — without this the button would pop straight back up and
// flicker until the animation landed.
let jumpHold = 0
jumpBtn.addEventListener('click', () => {
  jumpHold = Date.now() + 1500
  hideJump()
  // Dropping the "New messages" line changes the list height, and its re-render
  // pins the view itself — doing it after starting a smooth scroll would cancel
  // that scroll by writing scrollTop directly.
  if (unreadMarkerId !== null) { unreadMarkerId = null; renderTimeline({stick: true}) }
  messagesEl.scrollTo({top: messagesEl.scrollHeight, behavior: 'smooth'})
})
// any deliberate scroll of their own ends the hold early
;['wheel', 'touchstart', 'keydown'].forEach(ev => messagesEl.addEventListener(ev, () => { jumpHold = 0 }, {passive: true}))
// Reading scrollTop/scrollHeight forces layout, so do it once per frame instead
// of once per scroll event — a flicked list fires dozens of those per frame.
let scrollRaf = 0
messagesEl.addEventListener('scroll', () => {
  if (scrollRaf) return
  scrollRaf = requestAnimationFrame(() => {
    scrollRaf = 0
    const dist = distFromBottom()
    keepAtBottom = dist < 120   // remember, so a keyboard resize doesn't yank you around
    if (keepAtBottom) { jumpHold = 0; hideJump() }
    else if (dist > CONFIG.jumpAt && Date.now() > jumpHold) showJump()   // scrolled well back → offer the way down
  })
}, {passive: true})
function clearUnreadMarker() {
  if (unreadMarkerId === null) return
  unreadMarkerId = null
  renderTimeline({stick: isNearBottom()})
}

/* ------------------------------------------------------------------ *
 * Files & images — peer-to-peer, ephemeral (Trystero binary transfer)
 * Bytes flow browser↔browser over the encrypted data channel; never a server.
 * ------------------------------------------------------------------ */
// svg excluded from inline <img> preview out of caution → shown as a download card
const isImageType = t => typeof t === 'string' && t.startsWith('image/') && t !== 'image/svg+xml'
function fmtBytes(n) {
  if (!(n > 0)) return ''
  const u = ['B', 'KB', 'MB', 'GB']; let i = 0
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++ }
  return (i ? n.toFixed(1) : n) + ' ' + u[i]
}
const findEntry = key => entryById.get(key)

function fileNode(e, grouped) {
  const self = e.peerId === selfId
  const row = document.createElement('div')
  row.className = 'msg' + (self ? ' me' : '') + (grouped ? ' cont' : '')
  row.dataset.key = e.id
  const avatar = document.createElement('div')
  avatar.className = 'avatar'; avatar.style.background = colorOf(e.peerId); avatar.textContent = initialOf(e.name)
  const stack = document.createElement('div'); stack.className = 'stack'
  const meta = document.createElement('div'); meta.className = 'meta'
  const who = document.createElement('span'); who.className = 'who'; who.style.color = self ? '' : colorOf(e.peerId); who.textContent = self ? 'You' : e.name
  const time = document.createElement('span'); time.className = 'time'; time.textContent = fmtTime(e.t); time.dataset.t = String(e.t); time.title = relTime(e.t)
  meta.append(who, time); stack.appendChild(meta)
  const bubble = document.createElement('div'); bubble.className = 'bubble file'
  if (!e.url) {                                   // still transferring
    const note = document.createElement('div'); note.className = 'filenote'
    note.textContent = (self ? 'Sending ' : 'Receiving ') + (e.fileName || 'file') + '…'
    const prog = document.createElement('div'); prog.className = 'fileprog'
    const bar = document.createElement('i'); bar.style.width = Math.round((e.progress || 0) * 100) + '%'; prog.appendChild(bar)
    e.bar = bar   // keep a handle so progress updates skip the DOM query
    bubble.append(note, prog)
  } else if (isImageType(e.fileType)) {           // inline image
    const img = document.createElement('img'); img.className = 'filemsg-img'; img.src = e.url; img.alt = e.fileName || 'image'; img.loading = 'lazy'; img.decoding = 'async'
    img.addEventListener('click', () => openLightbox(e.url, e.fileName || 'image'))
    bubble.appendChild(img)
  } else {                                         // download card
    const card = document.createElement('div'); card.className = 'filecard'
    const ic = document.createElement('span'); ic.className = 'fi'; ic.textContent = '📄'
    const fm = document.createElement('div'); fm.className = 'fmeta'
    const fn = document.createElement('span'); fn.className = 'fname'; fn.textContent = e.fileName || 'file'
    const fs = document.createElement('span'); fs.className = 'fsize'; fs.textContent = fmtBytes(e.fileSize)
    fm.append(fn, fs)
    const dl = document.createElement('a'); dl.className = 'fdl'; dl.href = e.url; dl.download = e.fileName || 'file'; dl.textContent = '⬇'; dl.title = 'Download'
    dl.setAttribute('aria-label', 'Download ' + (e.fileName || 'file'))
    card.append(ic, fm, dl); bubble.appendChild(card)
  }
  stack.appendChild(bubble)
  // a shared image is exactly the thing people want to react to, so files get the
  // same reaction bar / toolbar / touch gestures a message row has
  const rbar = reactionBar(e.id)
  if (rbar) stack.appendChild(rbar)
  stack.appendChild(msgTools(e))
  attachTouchGestures(row, e)
  row.append(avatar, stack)
  return row
}

function addFileEntry(entry, fromSelf) {
  const stick = fromSelf || keepAtBottom
  if (!seenIds.has(entry.id)) addEntry(entry)
  renderTimeline({stick})
  if (!fromSelf && !stick) { awayCount++; showJump() }
}
// Update a visible progress bar in place — a 10 MB transfer fires hundreds of
// progress events, and a full renderTimeline() per chunk freezes slow devices.
let progRenderLast = 0
function updateFileProgress(entry, pct) {
  // the bar node is held on the entry, so a 10 MB transfer's hundreds of
  // progress events cost a style write each instead of a DOM query
  const bar = entry && entry.bar
  if (bar && bar.isConnected) { bar.style.width = Math.round(pct * 100) + '%'; return }
  const now = Date.now()   // bar not in the DOM (rare) → throttled full render
  if (now - progRenderLast > 500) { progRenderLast = now; renderTimeline({}) }
}
function onFileProgress(pct, peerId, metadata) {
  if (!metadata || typeof metadata.id !== 'string' || isMuted(peerId)) return
  if (typeof metadata.size === 'number' && metadata.size > CONFIG.maxFileBytes) return
  const key = keyOf(peerId, clampStr(metadata.id, 64))
  const e = findEntry(key)
  if (e) { e.progress = pct; updateFileProgress(e, pct); return }
  // each NEW transfer entry costs one slot in the 'file' flood budget, so a peer
  // can't spam fabricated progress metadata into endless "Receiving…" rows
  if (!allow(peerId, 'file')) return
  addEntry({kind: 'file', id: key, t: validT(metadata.t), peerId, name: nameOf(peerId), fileName: sanitize(metadata.name, 120) || 'file', fileType: clampStr(metadata.type, 80), fileSize: typeof metadata.size === 'number' ? metadata.size : 0, url: null, progress: pct})
  renderTimeline({})
}
function onFileComplete(data, peerId, metadata) {
  if (!metadata || typeof metadata.id !== 'string' || isMuted(peerId)) return
  // judge the size by the bytes actually received, not the peer's claim
  const actual = (data && data.byteLength) || 0
  if (actual > CONFIG.maxFileBytes || (typeof metadata.size === 'number' && metadata.size > CONFIG.maxFileBytes)) return
  const key = keyOf(peerId, clampStr(metadata.id, 64))
  const e = findEntry(key)
  if (e && e.url) return                       // duplicate resend of the same id → ignore (no blob-URL leak)
  if (!e && !allow(peerId, 'file')) return     // unseen transfer still counts against the budget
  const url = URL.createObjectURL(new Blob([data], {type: isImageType(metadata.type) ? metadata.type : 'application/octet-stream'}))
  if (e) { e.url = url; e.progress = 1; e.fileSize = actual || e.fileSize; renderTimeline({stick: isNearBottom()}) }
  else addFileEntry({kind: 'file', id: key, t: validT(metadata.t), peerId, name: nameOf(peerId), fileName: sanitize(metadata.name, 120) || 'file', fileType: clampStr(metadata.type, 80), fileSize: actual, url, progress: 1}, false)
  announceMsg(`${nameOf(peerId)} sent ${isImageType(metadata.type) ? 'an image' : 'a file'}`)
  if (document.hidden) setUnread(unread + 1)
}
// Downscale + re-encode big photos in the browser before they hit the wire.
// A 6 MB phone picture becomes ~300 KB, so it arrives in a moment instead of a
// minute — and pictures that were over the cap now send at all. Pixels never
// leave the device: this is canvas work, no network, no server.
const COMPRESS_OVER = 320 * 1024, MAX_EDGE = 1600
async function maybeCompress(file) {
  if (!file.type.startsWith('image/') || file.type === 'image/svg+xml' || file.type === 'image/gif') return file
  if (file.size < COMPRESS_OVER) return file
  try {
    const bmp = await createImageBitmap(file)
    const scale = Math.min(1, MAX_EDGE / Math.max(bmp.width, bmp.height))
    const w = Math.max(1, Math.round(bmp.width * scale)), h = Math.max(1, Math.round(bmp.height * scale))
    const canvas = document.createElement('canvas')
    canvas.width = w; canvas.height = h
    canvas.getContext('2d', {alpha: false}).drawImage(bmp, 0, 0, w, h)
    if (bmp.close) bmp.close()
    const blob = await new Promise(res => canvas.toBlob(res, 'image/webp', 0.82))
    canvas.width = canvas.height = 0            // release the backing store
    if (!blob || blob.size >= file.size) return file
    return new File([blob], file.name.replace(/\.[^.]*$/, '') + '.webp', {type: 'image/webp'})
  } catch { return file }                        // any failure → send the original
}

async function sendFile(file) {
  if (!file || !actions) return
  if (file.size === 0) { addSystem('That file is empty.'); return }
  const originalSize = file.size
  file = await maybeCompress(file)
  if (file.size > CONFIG.maxFileBytes) { addSystem(`That file is too big (max ${fmtBytes(CONFIG.maxFileBytes)}).`); return }
  if (file.size < originalSize * 0.9) addSystem(`Optimised image before sending: ${fmtBytes(originalSize)} → ${fmtBytes(file.size)}.`)
  const rawId = newRawId()
  const meta = {id: rawId, name: clampStr(file.name, 120) || 'file', type: clampStr(file.type, 80), size: file.size, t: Date.now()}
  // my own copy renders instantly (I already hold the bytes)
  addFileEntry({kind: 'file', id: keyOf(selfId, rawId), t: meta.t, peerId: selfId, name: myName, fileName: meta.name, fileType: meta.type, fileSize: meta.size, url: URL.createObjectURL(file), progress: 1}, true)
  try { actions.file.send(file, {metadata: meta}) } catch { addSystem('Could not send the file.') }
}
function revokeAllFileUrls() { for (const e of timeline) if (e.kind === 'file' && e.url) URL.revokeObjectURL(e.url) }

/* ----- image viewer (local blob, never uploaded anywhere) ---- */
let lastLbTrigger = null
function openLightbox(url, name) {
  lastLbTrigger = document.activeElement
  lightboxImg.src = url; lightboxImg.alt = name
  lightboxDl.href = url; lightboxDl.download = name
  lightboxName.textContent = name
  lightbox.hidden = false
  lightboxClose.focus()
}
function closeLightbox() {
  if (lightbox.hidden) return
  lightbox.hidden = true
  lightboxImg.removeAttribute('src')   // stop decoding, release memory
  if (lastLbTrigger && lastLbTrigger.isConnected) lastLbTrigger.focus()
  lastLbTrigger = null
}

/* ------------------------------------------------------------------ *
 * Verifiable hearsay — tamper-evident history hand-off.
 *
 * Every message carries the SHA-256 hashes of the most recent messages its
 * sender held (`prev`), weaving a causal hash-DAG as the room talks. A
 * newcomer recomputes the hashes of the history burst (so the elected sender
 * can't silently alter or drop anything inside it) and then asks the OTHER
 * peers for their current DAG heads. If an independent witness's head chains
 * down to a message inside the burst, the history is confirmed by someone
 * with no stake in the hand-off. Forging history now requires every present
 * peer to collude, instead of just winning the lowest-id election.
 *
 * Hashes are computed from the wire values (claimed t, sanitized text), so
 * every peer derives identical hashes without trusting each other's clocks.
 * ------------------------------------------------------------------ */
const HASH_RE = /^[0-9a-f]{64}$/
const sha256hex = async s => {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('')
}
const validPrev = p => Array.isArray(p) ? p.filter(x => typeof x === 'string' && HASH_RE.test(x)).slice(0, 3) : []
const validHeads = h => Array.isArray(h) ? h.filter(x => typeof x === 'string' && HASH_RE.test(x)).slice(0, 8) : []
const msgCanon = e => JSON.stringify([e.peerId, rawIdOf(e.id), e.wt, e.text, e.emote ? 1 : 0, (e.reply && e.reply.key) || '', e.prev])

const msgHashByKey = new Map()   // timeline key -> hash
const hashMeta = new Map()       // hash -> {key, prev, inBurst}
const dagReferenced = new Set()  // hashes referenced as someone's prev
const dagHeads = new Set()       // known hashes nothing references yet
const currentHeads = () => [...dagHeads].slice(-6)

async function recordMsgHash(entry, inBurst) {
  const h = await sha256hex(msgCanon(entry))
  const known = hashMeta.get(h)
  if (known) { if (inBurst) known.inBurst = true; return h }
  msgHashByKey.set(entry.id, h)
  hashMeta.set(h, {key: entry.id, prev: entry.prev, inBurst: !!inBurst})
  for (const p of entry.prev) { dagReferenced.add(p); dagHeads.delete(p) }
  if (!dagReferenced.has(h)) dagHeads.add(h)
  if (hashMeta.size > 700) {   // bound the substrate on marathon sessions
    for (const k of hashMeta.keys()) {
      const m = hashMeta.get(k)
      msgHashByKey.delete(m.key); hashMeta.delete(k); dagHeads.delete(k)
      if (hashMeta.size <= 600) break
    }
  }
  evalAttestation()            // a late-arriving link may complete a witness chain
  return h
}
function resetDag() { msgHashByKey.clear(); hashMeta.clear(); dagReferenced.clear(); dagHeads.clear() }

// does this head chain down (via prev links) to a message from the burst?
function connectsToBurst(head) {
  const stack = [head], seen = new Set()
  while (stack.length) {
    const h = stack.pop()
    if (seen.has(h) || seen.size > 400) continue
    seen.add(h)
    const m = hashMeta.get(h)
    if (!m) continue                  // unknown link — may resolve when it arrives live
    if (m.inBurst) return true
    for (const p of m.prev) stack.push(p)
  }
  return false
}

// Ask up to 5 peers who did NOT hand us the history to vouch for it. The burst
// often lands before the rest of the mesh has connected, so give discovery a
// short grace window before deciding nobody else was here.
let attest = null                    // {waiting: Map(peerId -> heads[]|null), timer, settled, t0}
function startAttestation() {
  if (attest || !actions) return
  attest = {waiting: new Map(), settled: false, t0: Date.now()}
  attest.timer = setInterval(() => {
    if (!attest) return
    const witnesses = [...peers.keys()].filter(id => !histAcceptedFrom.has(id)).slice(0, 5)
    if (witnesses.length) {
      clearInterval(attest.timer)
      attest.waiting = new Map(witnesses.map(id => [id, null]))
      for (const id of witnesses) actions.attq.send(1, {target: id})
      attest.timer = setTimeout(settleAttestation, 10000)
    } else if (Date.now() - attest.t0 > 8000) {
      clearInterval(attest.timer)
      attest = null
      addSystem('History came from the only person who could hand it over — no one else was here to cross-check it.')
    }
  }, 400)
}
function evalAttestation() {        // settle early only on a clean positive
  if (!attest || attest.settled) return
  let allReplied = true, confirmed = 0
  for (const hs of attest.waiting.values()) {
    if (hs === null) { allReplied = false; continue }
    if (hs.length && hs.some(connectsToBurst)) confirmed++
  }
  if (confirmed && allReplied) settleAttestation()
}
function settleAttestation() {
  if (!attest || attest.settled) return
  attest.settled = true; clearTimeout(attest.timer)
  let confirmed = 0, replied = 0
  for (const hs of attest.waiting.values()) {
    if (hs === null || !hs.length) continue   // silent, or nothing to vouch with
    replied++
    if (hs.some(connectsToBurst)) confirmed++
  }
  // "connections", not "people": peer ids are free, so one person can be several
  if (confirmed) addSystem(`✓ History verified — independently confirmed by ${confirmed} other ${confirmed === 1 ? 'connection' : 'connections'} here${replied > confirmed ? ` (${replied - confirmed} couldn’t confirm it)` : ''}.`)
  else if (replied) addSystem('⚠ No one else here could confirm the history you were handed — treat it as unconfirmed.')
  else addSystem('History couldn’t be cross-checked — no one else here had anything to vouch with.')
  attest = null
}
// attest.timer is a polling interval before witnesses are picked and a timeout
// after, so clear it both ways rather than guessing which phase we're in
function cancelAttestation() { if (attest) { clearInterval(attest.timer); clearTimeout(attest.timer); attest = null } }

/* ------------------------------------------------------------------ *
 * Networking
 * ------------------------------------------------------------------ */
// Stretch the room password before it becomes key material. Trystero alone
// hashes it once (SHA-256), which a relay eavesdropper can brute-force offline
// at GPU speed; PBKDF2 with a room-bound salt makes each guess ~310k times
// more expensive. Every peer derives the same value, so peers stay compatible.
async function stretchPass(pass) {
  const enc = new TextEncoder()
  const km = await crypto.subtle.importKey('raw', enc.encode(pass), 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits(
    {name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode('c2c-kdf-v1|' + CONFIG.appId + '|' + CONFIG.roomId), iterations: 310000},
    km, 256)
  return [...new Uint8Array(bits)].map(b => b.toString(16).padStart(2, '0')).join('')
}

async function startChat() {
  try {
    // fail loudly, not silently: without WebCrypto the handshake can never work
    if (!window.crypto || !crypto.subtle) throw new Error('WebCrypto unavailable')
    const cfg = {appId: CONFIG.appId, relayConfig: {urls: CONFIG.relayUrls, redundancy: CONFIG.relayRedundancy}}
    if (CONFIG.turnConfig.length) cfg.turnConfig = CONFIG.turnConfig
    // rtcConfig is spread straight into the RTCPeerConnection by Trystero, so
    // this is what actually keeps your address out of the candidate exchange
    if (relayOnly && CONFIG.turnConfig.length) cfg.rtcConfig = {iceTransportPolicy: 'relay'}
    if (myPass) cfg.password = await stretchPass(myPass)
    room = joinRoom(cfg, CONFIG.roomId)
    wireRoom(room)
    updateStatusLoop()
  } catch (err) {
    // A missing WebCrypto is permanent — retrying can't help. Anything else is
    // likely transient (relay hiccup mid-rejoin), so keep trying with backoff
    // rather than stranding an already-joined session on an error line.
    if (entered && window.isSecureContext && window.crypto && crypto.subtle) {
      statusDot.className = 'dot dot--off'
      scheduleReconnect('the last attempt failed')
    } else showFatal(err)
  }
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
function reconnect(why) {
  clearTimeout(reconnectTimer); reconnectTimer = null
  try { if (room) room.leave() } catch {}
  room = null; actions = null
  for (const t of typingTimers.values()) clearTimeout(t)
  typingTimers.clear(); peers.clear(); histAcceptedFrom.clear(); floodState.clear()
  cancelAttestation()   // keep the DAG (timeline survives a reconnect), drop the pending vote
  prevRelays = 0; noPeerSince = 0; lastHealthy = Date.now()
  renderRoster(); renderTyping()
  // an automatic retry says why, so a reconnect nobody asked for isn't mysterious
  addSystem(why ? `Reconnecting — ${why}…` : 'Reconnecting…')
  startChat()
}

// Leave the room and wipe ALL state (incl. the timeline) — used when a join is
// rejected for a duplicate name so the next attempt starts completely fresh.
function leaveAndReset() {
  try { if (room) room.leave() } catch {}
  room = null; actions = null; entered = false
  if (statusTimer) { clearInterval(statusTimer); statusTimer = null }
  for (const t of typingTimers.values()) clearTimeout(t)
  typingTimers.clear(); peers.clear(); floodState.clear(); histAcceptedFrom.clear()
  revokeAllFileUrls()
  reactions.clear(); seenIds.clear(); timeline.length = 0
  entryById.clear(); nodeCache.clear(); unreadMarkerId = null
  cancelAttestation(); resetDag()
  clearTimeout(pendingSysTimer); pendingSysTimer = null; pendingSys = []
  clearTimeout(reconnectTimer); reconnectTimer = null; reconnectTries = 0; lastHealthy = Date.now()
  hideJump(); setUnread(0); keepAtBottom = true
  prevRelays = 0; noPeerSince = 0
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
  const file = room.makeAction('file')
  const attq = room.makeAction('attq')   // "show me your DAG heads"
  const atth = room.makeAction('atth')   // "here they are"
  actions = {msg, name, typing, hist, histReq, react, presence, file, attq, atth}

  attq.onMessage = (_d, {peerId}) => { if (allow(peerId, 'attq')) atth.send({heads: currentHeads()}, {target: peerId}) }
  atth.onMessage = (d, {peerId}) => {
    if (!allow(peerId, 'atth') || !attest || attest.settled || !attest.waiting.has(peerId)) return
    attest.waiting.set(peerId, validHeads(d && d.heads))
    evalAttestation()
  }

  msg.onMessage = (data, {peerId}) => {
    if (!data || typeof data.id !== 'string' || !allow(peerId, 'msg')) return
    const text = sanitize(data.text, CONFIG.maxMsgLen)
    if (!text) return
    if (typeof data.name === 'string') {
      // a RENAME smuggled through the busier msg channel still pays the name budget
      const p = peers.get(peerId), n = sanitize(data.name, CONFIG.maxNameLen).trim()
      if (p && n && (!p.name || p.name === n || allow(peerId, 'name'))) setPeerName(peerId, n)
    }
    clearPeerTyping(peerId)
    // id namespaced by the TRUSTED transport peerId — a peer can't claim another's id-space
    const wt = (typeof data.t === 'number' && isFinite(data.t)) ? data.t : 0   // wire t — what everyone hashes
    const entry = {
      id: keyOf(peerId, clampStr(data.id, 64)),
      t: validT(data.t),
      wt,
      peerId,
      name: nameOf(peerId),
      text,
      emote: !!data.emote,
      reply: parseReply(data.reply),
      prev: validPrev(data.prev),
    }
    if (addMessage(entry, false)) recordMsgHash(entry)
  }

  hist.onMessage = (arr, {peerId}) => {
    if (!Array.isArray(arr) || histAcceptedFrom.has(peerId)) return
    // Only accept a history burst from the elected sender (lowest peer id), so a
    // random peer can't push a forged/censored history to newcomers.
    if (peerId !== lowestPeer()) return
    histAcceptedFrom.add(peerId)            // and only one burst from them
    let added = false
    const hashing = []
    for (const m of arr.slice(0, CONFIG.historyShare)) {
      if (!m || typeof m.id !== 'string' || typeof m.peerId !== 'string') continue
      const text = sanitize(m.text, CONFIG.maxMsgLen)
      if (!text) continue
      const author = clampStr(m.peerId, 64)
      if (author === selfId) continue        // I'd already have my own messages — a "mine" I don't know is forged
      const key = keyOf(author, clampStr(m.id, 64))   // namespaced by claimed AUTHOR for cross-relayer dedupe
      const wt = (typeof m.t === 'number' && isFinite(m.t)) ? m.t : 0
      const entry = {kind: 'msg', id: key, t: validT(m.t), wt, peerId: author, name: sanitize(m.name, CONFIG.maxNameLen) || shortId(author), text, emote: !!m.emote, reply: parseReply(m.reply), prev: validPrev(m.prev)}
      if (addEntry(entry)) added = true
      hashing.push(recordMsgHash(entry, true))   // recompute — the relayer can't alter what's inside the chain
      if (m.reacts && typeof m.reacts === 'object') {  // re-hydrate reaction counts
        for (const em of Object.keys(m.reacts).slice(0, 24)) {
          const list = m.reacts[em], emoji = sanitize(em, 8)
          // never attribute a handed-off reaction to MYSELF — that would be forged
          if (Array.isArray(list) && validEmoji(emoji)) list.slice(0, 60).forEach(pid => { const id = clampStr(pid, 64); if (id !== selfId) applyReaction(key, emoji, id, true) })
        }
      }
    }
    if (added) renderTimeline({stick: true})
    if (hashing.length) Promise.all(hashing).then(startAttestation)   // then ask the others to vouch
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
    const target = findEntry(d.target)
    // only a real, present message or file takes reactions
    if (!target || (target.kind !== 'msg' && target.kind !== 'file')) return
    const em = sanitize(d.emoji, 8)
    if (!validEmoji(em)) return              // emoji only — no text smuggled into chips
    applyReaction(d.target, em, peerId, !!d.on)
  }
  file.onMessage = (data, {peerId, metadata}) => onFileComplete(data, peerId, metadata)
  file.onReceiveProgress = (pct, {peerId, metadata}) => onFileProgress(pct, peerId, metadata)

  room.onPeerJoin = peerId => {
    connectionRecovered()   // a live peer proves the path works — reset the backoff
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
    maybeCloseRename()   // if the peer we clashed with left, release the rename modal
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
  // forward the WIRE values (claimed t, prev links) so the receiver recomputes
  // the exact same hashes the original sender's message produced
  const recent = timeline.filter(e => e.kind === 'msg').slice(-CONFIG.historyShare)
    .map(e => ({id: rawIdOf(e.id), t: e.wt ?? e.t, peerId: e.peerId, name: e.name, text: e.text, emote: e.emote, reply: e.reply, prev: e.prev || [], reacts: serializeReacts(e.id)}))
  if (recent.length && actions) actions.hist.send(recent, {target: peerId})
}
const rawIdOf = key => { const i = key.indexOf('::'); return i < 0 ? key : key.slice(i + 2) }

function parseReply(r) {
  if (!r || typeof r.key !== 'string') return null
  const own = entryById.get(r.key)
  // Never trust a peer's claimed quote author/text. If we can't resolve the
  // referenced message in our own timeline, show a neutral placeholder.
  if (!own) return {key: clampStr(r.key, 130), unresolved: true}
  return {key: clampStr(r.key, 130), name: own.peerId === selfId ? 'You' : own.name, snippet: snippetOf(own)}
}

function setPeerName(peerId, value) {
  const name = sanitize(value, CONFIG.maxNameLen).trim()
  if (!name || !peers.has(peerId)) return
  const p = peers.get(peerId)
  if (p.name === name) return
  const prev = p.name
  p.name = name
  if (!isMuted(peerId)) addPresenceSys(prev ? `${prev} is now ${name}` : `${name} joined`)
  renderRoster()
  if (typingTimers.has(peerId)) renderTyping()
  checkMyNameCollision()   // if this peer now shares my name, the higher selfId yields
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
  refreshDupNames()   // roster changed → recompute the duplicate-name set once
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
  if (!isSelf && name && nameIsDuplicated(name)) li.appendChild(badge(id))
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
  if (renaming) return                 // must resolve a forced rename first
  const raw = inputEl.value
  const text = sanitize(raw, CONFIG.maxMsgLen).trim()
  if (!text || !actions) return
  if (text[0] === '/' && handleSlash(text)) { inputEl.value = ''; stopTyping(); updateSendBtn(); return }
  const rawId = newRawId()
  const prev = currentHeads().slice(-3)   // weave this message into the room's hash-DAG
  const entry = {id: keyOf(selfId, rawId), t: Date.now(), peerId: selfId, name: myName, text, reply: replyTo ? {key: replyTo.key, name: replyTo.name, snippet: replyTo.snippet} : null, prev, status: 'sending'}
  entry.wt = entry.t
  const wire = actions.msg.send({id: rawId, t: entry.t, name: myName, text, reply: replyTo ? {key: replyTo.key, name: replyTo.name, snippet: replyTo.snippet} : null, prev})
  addMessage(entry, true)
  recordMsgHash(entry)
  // honest delivery state: sent to the peers that were connected, or a clear
  // "nobody was here" instead of a tick that implies someone read it
  const audience = peers.size
  Promise.resolve(wire).then(
    () => setMsgStatus(entry, audience ? 'sent' : 'alone'),
    () => setMsgStatus(entry, 'failed'))
  inputEl.value = ''; autoGrow(); cancelReply(); stopTyping(); updateSendBtn(); inputEl.focus()
}

// Single-row composer that grows with the text (capped, then scrolls).
// An EMPTY textarea reports its wrapped placeholder in scrollHeight, so falling
// back to the stylesheet height is what keeps the box one row when cleared.
function autoGrow() {
  inputEl.style.height = 'auto'
  inputEl.style.height = inputEl.value ? Math.min(inputEl.scrollHeight, 132) + 'px' : ''
}

function handleSlash(text) {
  const [cmd, ...rest] = text.slice(1).split(' ')
  const arg = rest.join(' ').trim()
  switch (cmd.toLowerCase()) {
    case 'nick': {
      const n = sanitize(arg, CONFIG.maxNameLen).trim()
      if (!n) { addSystem('Usage: /nick <new name>'); return true }
      if (nameTakenByPeer(n)) { addSystem(`"${n}" is already taken in this room — pick another.`); return true }
      const old = myName; setMyName(n)
      if (actions) actions.name.send(myName)
      addSystem(`You are now "${myName}" (was "${old}")`)
      return true
    }
    case 'me': {
      const text = sanitize(arg, CONFIG.maxMsgLen)
      if (text) {
        const rawId = newRawId(), id = keyOf(selfId, rawId), t = Date.now(), prev = currentHeads().slice(-3)
        const entry = {id, t, wt: t, peerId: selfId, name: myName, text, emote: true, prev}
        actions.msg.send({id: rawId, t, name: myName, text, emote: true, prev})
        addMessage(entry, true); recordMsgHash(entry)
      }
      return true
    }
    case 'who': addSystem('Here now: ' + [myName + ' (you)', ...[...peers.values()].map(p => p.name).filter(Boolean)].join(', ')); return true
    case 'clear': revokeAllFileUrls(); timeline.length = 0; seenIds.clear(); entryById.clear(); nodeCache.clear(); reactions.clear(); unreadMarkerId = null; renderTimeline(); addSystem('Cleared your local view (others are unaffected).'); return true
    case 'shrug': inputEl.value = '¯\\_(ツ)_/¯'; sendMessage(); return true
    case 'help': addSystem('Commands: /nick <name> · /me <action> · /who · /clear · /shrug · /help'); return true
    default: addSystem(`Unknown command: /${cmd} — try /help`); return true
  }
}

function onLocalInput() {
  updateSendBtn(); autoGrow(); bumpActivity()
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
function updateSendBtn() {
  sendBtn.disabled = !inputEl.value.trim()
  updateCounter()
}
// Silent until it matters: the remaining-characters hint only appears near the
// cap, so a normal message never has a number hovering over it.
function updateCounter() {
  const left = CONFIG.maxMsgLen - inputEl.value.length
  const show = inputEl.value.length >= CONFIG.maxMsgLen * CONFIG.counterAt
  counterEl.hidden = !show
  if (!show) return
  counterEl.textContent = String(left)
  counterEl.classList.toggle('counter--tight', left <= 120)
}

/* ------------------------------------------------------------------ *
 * Connection status + relay/ping panel
 * ------------------------------------------------------------------ */
let prevRelays = 0, noPeerSince = 0, statusTimer = null, statusTick = null
// `pending` = still handshaking (readyState 0). The watchdog must not count a
// socket that is mid-connect as dead, or a slow network would have the session
// torn down and restarted right as it was about to come up.
function relayStates() {
  try { return Object.entries(getRelaySockets() || {}).map(([url, s]) => ({url, open: s && s.readyState === 1, pending: s && s.readyState === 0})) } catch { return [] }
}
// Judge the connection by whether the signalling sockets are actually open. No
// relay socket means no discovery and no way back — a dead session that used to
// sit there looking like it was merely "Connecting…".
/* Measure time since the last genuinely healthy signal — an open relay socket or
 * a live peer — rather than trying to interpret each socket's state.
 *
 * The obvious version (treat a mid-handshake socket as alive) does not survive
 * contact with Trystero: it recreates failed sockets continuously, so a URL
 * cycles CONNECTING → CLOSED → CONNECTING several times a second. Any per-socket
 * grace period gets reset by that churn, and a relay set that is failing 100% of
 * the time still looks like it is "about to connect" forever.
 *
 * Time-since-healthy has no such hole: retry churn never touches it, only a
 * working connection does. Sockets still trying earn a longer window than a set
 * that has gone fully closed, so a slow network is not torn down mid-handshake. */
const DEAD_TRYING = 16000, DEAD_CLOSED = 6000
let lastHealthy = Date.now()
function checkHealth(open, online, trying) {
  if (!entered || reconnectTimer) return
  if (open > 0 || online > 0) { lastHealthy = Date.now(); connectionRecovered(); return }
  if (Date.now() - lastHealthy < (trying ? DEAD_TRYING : DEAD_CLOSED)) return
  scheduleReconnect('the connection dropped')
}
function updateStatusLoop() {
  const tick = () => {
    const states = relayStates()
    const relays = states.filter(s => s.open).length
    const online = peers.size
    // health first, and unconditionally: this used to return early whenever the
    // tab was hidden, which on a phone is most of the time — so a session that
    // died in the background stayed dead
    checkHealth(relays, online, states.some(s => s.pending))
    prevRelays = relays
    if (document.hidden) return   // ...but skip the DOM work while nobody can see it
    if (online > 0) { statusDot.className = 'dot dot--on'; setStatus(`${online + 1} online`) }
    else if (relays > 0) {
      if (!noPeerSince) noPeerSince = Date.now()
      const stuck = Date.now() - noPeerSince > 12000
      statusDot.className = 'dot dot--wait'
      // in relay-only mode there is no direct-path fallback, so a busy public
      // TURN is the likeliest reason nothing connects — say so instead of
      // blaming the network
      setStatus(stuck ? (relayOnly ? 'No peers — IP-hiding relay may be busy' : 'Relays up, no peers — strict NAT?') : 'Waiting for people…')
    } else {
      statusDot.className = 'dot dot--off'
      setStatus(navigator.onLine === false ? 'Offline' : reconnectTries ? 'Reconnecting…' : 'Connecting…')
    }
    if (online > 0) noPeerSince = 0
  }
  statusTick = tick
  tick()
  if (statusTimer) clearInterval(statusTimer)   // avoid duplicate timers on reconnect
  statusTimer = setInterval(tick, 2000)
}
function setStatus(t) { if (statusText.textContent !== t) { statusText.textContent = t; announceStatus(t) } }

// Popover open/close in one place, so `aria-expanded` can never drift out of
// sync with what is on screen and Escape always hands focus back to the trigger.
function setPop(panel, btn, open, refocus) {
  panel.hidden = !open
  if (btn) btn.setAttribute('aria-expanded', String(open))
  if (!open && refocus && btn) btn.focus()
}
// only one popover at a time — opening one closes the others
function closeOtherPops(keep) {
  if (keep !== statusPanel) setPop(statusPanel, statusBtn, false)
  if (keep !== roomsPanel) setPop(roomsPanel, roomsBtn, false)
  if (keep !== emojiPanel) setPop(emojiPanel, emojiBtn, false)
}
function openStatusPanel() {
  closeOtherPops(statusPanel)
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
  // a manual retry means "try now" — clear any pending backoff instead of
  // queueing behind it
  rc.addEventListener('click', () => { setPop(statusPanel, statusBtn, false); connectionRecovered(); reconnect() })
  statusPanel.appendChild(rc)
  setPop(statusPanel, statusBtn, true)
}
function toggleStatusPanel() { statusPanel.hidden ? openStatusPanel() : setPop(statusPanel, statusBtn, false) }

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
// The full grid is built once; filtering only flips `hidden` on existing cells,
// so typing in the search box never rebuilds ~90 buttons per keystroke.
let allCells = null, recentWrap = null, allHead = null
function buildEmojiOnce() {
  recentWrap = document.createElement('div'); recentWrap.className = 'emoji-recent'
  allHead = document.createElement('div'); allHead.className = 'emoji-sec'; allHead.textContent = 'All'
  emojiGrid.append(recentWrap, allHead)
  allCells = EMOJI.map(([e, k]) => { const el = emojiCell(e, k); emojiGrid.appendChild(el); return {el, e, k} })
}
function renderRecents() {
  recentWrap.replaceChildren()
  if (!recents.length) return
  const head = document.createElement('div'); head.className = 'emoji-sec'; head.textContent = 'Recent'
  recentWrap.appendChild(head)
  recents.forEach(e => recentWrap.appendChild(emojiCell(e, e)))
}
function buildEmoji(filter) {
  if (!allCells) buildEmojiOnce()
  const f = (filter || '').trim().toLowerCase()
  if (!f) renderRecents()
  recentWrap.hidden = !!f || !recents.length
  allHead.hidden = !!f || !recents.length
  for (const c of allCells) c.el.hidden = !!f && !(c.k.includes(f) || c.e === f)
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
  setPop(emojiPanel, emojiBtn, false); inputEl.focus()
}
function insertAtCursor(text) {
  const s = inputEl.selectionStart ?? inputEl.value.length
  const en = inputEl.selectionEnd ?? inputEl.value.length
  inputEl.value = (inputEl.value.slice(0, s) + text + inputEl.value.slice(en)).slice(0, CONFIG.maxMsgLen)
  const pos = Math.min(s + text.length, inputEl.value.length)
  inputEl.setSelectionRange(pos, pos); updateSendBtn()
}
// roving tabindex over the emoji buttons (visible ones only)
const emojiButtons = () => [...emojiGrid.querySelectorAll('button:not([hidden])')].filter(b => !b.closest('[hidden]'))
function rove() {
  const btns = emojiButtons()
  btns.forEach((b, i) => b.tabIndex = i === 0 ? 0 : -1)
}
emojiGrid.addEventListener('keydown', e => {
  const btns = emojiButtons()
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
function shareUrl(code = CONFIG.roomCode) { return location.origin + BASE + (code ? '#r=' + code : '') }
// Clipboard with a fallback: the async API rejects when the document isn't
// focused or permission is withheld, which used to leave the button silent.
function selectionCopy(text) {
  try {
    const ta = document.createElement('textarea')
    ta.value = text; ta.setAttribute('readonly', '')
    ta.style.cssText = 'position:fixed;top:-1000px;opacity:0'
    document.body.appendChild(ta)
    ta.select(); ta.setSelectionRange(0, text.length)
    const ok = document.execCommand('copy')
    ta.remove()
    return ok
  } catch { return false }
}
async function writeClipboard(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true }
  } catch {}
  return selectionCopy(text)
}
function copyText(text, btn, restore) {
  writeClipboard(text).then(ok => {
    if (!btn) return
    btn.textContent = ok ? '✓ Copied' : 'Copy failed'
    setTimeout(() => { btn.textContent = restore }, 1400)
  })
}
function openRoomsPanel() {
  closeOtherPops(roomsPanel)
  if (CONFIG.isDefaultRoom) {
    roomCurrentEl.textContent = "You're in the public room — open to anyone on this site."
    roomsCopyName.hidden = true; roomPublicBtn.hidden = true
  } else {
    roomCurrentEl.textContent = `Private room: "${CONFIG.roomCode}". Invite by sharing the link, and tell people the password separately.`
    roomsCopyName.hidden = false; roomPublicBtn.hidden = false
  }
  setPop(roomsPanel, roomsBtn, true)
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
  history.replaceState(null, '', BASE + '#r=' + n)
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
  const label = theme === 'light' ? 'Light' : theme === 'dark' ? 'Dark' : 'Match system'
  themeBtn.title = `Theme: ${label} — click to change`
  themeBtn.setAttribute('aria-label', `Theme: ${label}. Click to change.`)
}
let themeAnimTimer = null
function cycleTheme() {
  theme = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length]
  try { localStorage.setItem('c2c-theme', theme) } catch {}
  // cross-fade the swap, then take the transition back off so it isn't paid for
  // on every subsequent style change in the app
  document.documentElement.classList.add('theme-anim')
  clearTimeout(themeAnimTimer)
  themeAnimTimer = setTimeout(() => document.documentElement.classList.remove('theme-anim'), 320)
  applyTheme()
}
/* ----- notification chime (synthesised — no audio asset, no network) ---- */
let soundOn = false, notifyOn = false, actx = null
try { soundOn = localStorage.getItem('c2c-sound') === '1' } catch {}
try { notifyOn = localStorage.getItem('c2c-notify') === '1' } catch {}
function chime() {
  if (!soundOn) return
  try {
    const AC = window.AudioContext || window.webkitAudioContext
    if (!AC) return
    actx = actx || new AC()
    if (actx.state === 'suspended') actx.resume()
    const now = actx.currentTime
    for (const [freq, delay] of [[880, 0], [1318.5, 0.085]]) {
      const osc = actx.createOscillator(), gain = actx.createGain()
      osc.type = 'sine'; osc.frequency.value = freq
      gain.gain.setValueAtTime(0.0001, now + delay)
      gain.gain.exponentialRampToValueAtTime(0.08, now + delay + 0.012)
      gain.gain.exponentialRampToValueAtTime(0.0001, now + delay + 0.19)
      osc.connect(gain); gain.connect(actx.destination)
      osc.start(now + delay); osc.stop(now + delay + 0.2)
    }
  } catch {}
}
function applySound() { soundBtn.setAttribute('aria-pressed', String(soundOn)); soundBtn.classList.toggle('on', soundOn) }
function toggleSound() {
  soundOn = !soundOn
  try { localStorage.setItem('c2c-sound', soundOn ? '1' : '0') } catch {}
  applySound(); if (soundOn) chime()   // audible confirmation (also unlocks audio)
}
// Desktop notifications: opt-in, background-only, and the body is already
// sanitized message text. Nothing leaves the device.
function notifyDesktop(who, text) {
  if (!notifyOn || !document.hidden || !('Notification' in window) || Notification.permission !== 'granted') return
  try {
    const n = new Notification(who, {body: text.slice(0, 140), tag: 'c2c-msg', silent: true, icon: favicon(0)})
    n.onclick = () => { window.focus(); n.close() }
  } catch {}
}
function applyNotify() { notifyBtn.setAttribute('aria-pressed', String(notifyOn)); notifyBtn.classList.toggle('on', notifyOn) }
async function toggleNotify() {
  if (!('Notification' in window)) { addSystem('This browser has no desktop notifications.'); return }
  if (!notifyOn) {
    let perm = Notification.permission
    if (perm === 'default') { try { perm = await Notification.requestPermission() } catch {} }
    if (perm !== 'granted') { addSystem('Notifications are blocked — allow them in your browser’s site settings.'); return }
    notifyOn = true
  } else notifyOn = false
  try { localStorage.setItem('c2c-notify', notifyOn ? '1' : '0') } catch {}
  applyNotify()
}

/* ----- relay-only mode: keep your IP out of the peer handshake ---- *
 * WebRTC has to tell the other side where to send packets, so by default your
 * address list ("ICE candidates") includes your public IP and it is handed to
 * every peer in the room as ordinary text. With iceTransportPolicy:'relay' the
 * browser skips host and server-reflexive gathering altogether and only
 * allocates on the TURN server, so the list peers receive carries the relay's
 * address where yours used to be.
 *
 * The trade is real and it is not a secret: every byte then goes through a free
 * public TURN service, which is slower, and there is no direct-path fallback —
 * if that relay is unreachable the connection simply fails. It also does
 * nothing about the Nostr relays or the TURN operator themselves seeing your
 * IP, because you connect straight to those. Only Tor or a VPN covers that.
 * ------------------------------------------------------------------ */
let relayOnly = false
try { relayOnly = localStorage.getItem('c2c-relayonly') === '1' } catch {}
function applyRelayOnly() {
  relayBtn.setAttribute('aria-pressed', String(relayOnly))
  relayBtn.classList.toggle('on', relayOnly)
  relayBtn.title = relayOnly
    ? 'On — peers see the relay’s address instead of yours (slower; fails if the relay is unreachable)'
    : 'Off — peers can see your IP address'
}
function toggleRelayOnly() {
  if (!relayOnly && !CONFIG.turnConfig.length) {   // no TURN = relay-only can never connect
    addSystem('Can’t hide your IP: no relay server is configured for this deployment.')
    return
  }
  relayOnly = !relayOnly
  try { localStorage.setItem('c2c-relayonly', relayOnly ? '1' : '0') } catch {}
  applyRelayOnly()
  addSystem(relayOnly
    ? '🛡️ Hiding your IP from peers — reconnecting through a relay. Expect it to be slower, and it can fail if the public relay is busy.'
    : 'No longer hiding your IP — reconnecting with direct connections.')
  // the policy is fixed per RTCPeerConnection, so existing links keep the old
  // behaviour until they are torn down and re-made
  if (entered) reconnect()
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
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return
  setUnread(0)
  if (statusTick) statusTick()   // the poll skips work while hidden — refresh on return
  // leave the "New messages" line up briefly so you can see where you left off
  setTimeout(() => { if (!document.hidden && isNearBottom()) clearUnreadMarker() }, 4000)
})

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
// One MediaQueryList, evaluated once. isDrawer() is on the touch hot path
// (every pointerdown on a row), and matchMedia() allocates a new list each call.
const NARROW_MQ = matchMedia('(max-width: 720px)')
const isDrawer = () => NARROW_MQ.matches
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
renameForm.addEventListener('submit', e => { e.preventDefault(); doRename() })

emojiBtn.addEventListener('click', e => {
  e.stopPropagation()
  const open = emojiPanel.hidden
  if (open) closeOtherPops(emojiPanel)
  setPop(emojiPanel, emojiBtn, open)
  if (open) { emojiSearch.value = ''; buildEmoji(''); emojiSearch.focus() }
})
emojiSearch.addEventListener('input', () => buildEmoji(emojiSearch.value))
document.addEventListener('click', e => { if (!emojiPanel.hidden && !emojiPanel.contains(e.target) && e.target !== emojiBtn) setPop(emojiPanel, emojiBtn, false) })

// --- attach / drag-drop / paste files ---
attachBtn.addEventListener('click', () => { if (!attachBtn.disabled) fileInput.click() })
fileInput.addEventListener('change', () => { const f = fileInput.files && fileInput.files[0]; if (f) sendFile(f); fileInput.value = '' })
let dragDepth = 0
chatEl.addEventListener('dragenter', e => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) { e.preventDefault(); dragDepth++; chatEl.classList.add('dragover') } })
chatEl.addEventListener('dragover', e => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy' } })
chatEl.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; chatEl.classList.remove('dragover') } })
chatEl.addEventListener('drop', e => {
  if (!e.dataTransfer || ![...e.dataTransfer.types].includes('Files')) return
  e.preventDefault(); dragDepth = 0; chatEl.classList.remove('dragover')
  if (!entered) return
  for (const f of e.dataTransfer.files) sendFile(f)
})
inputEl.addEventListener('paste', e => {
  const items = e.clipboardData && e.clipboardData.files
  if (!items || !items.length || !entered) return
  // only intercept when an actual file (e.g. pasted image) is on the clipboard
  let sent = false
  for (const f of items) { sendFile(f); sent = true }
  if (sent) e.preventDefault()
})

statusBtn.addEventListener('click', e => { e.stopPropagation(); toggleStatusPanel() })
document.addEventListener('click', e => { if (!statusPanel.hidden && !statusPanel.contains(e.target) && !statusBtn.contains(e.target)) setPop(statusPanel, statusBtn, false) })
// tap-away closes a touch-opened message toolbar
document.addEventListener('click', e => { const open = messagesEl.querySelector('.msg.tools-open'); if (open && !open.contains(e.target)) open.classList.remove('tools-open') })

roomsBtn.addEventListener('click', e => { e.stopPropagation(); roomsPanel.hidden ? openRoomsPanel() : setPop(roomsPanel, roomsBtn, false) })
document.addEventListener('click', e => { if (!roomsPanel.hidden && !roomsPanel.contains(e.target) && !roomsBtn.contains(e.target)) setPop(roomsPanel, roomsBtn, false) })
// the room chip used to be an inert button — it now opens the panel it describes
roomChip.addEventListener('click', e => { e.stopPropagation(); roomsPanel.hidden ? openRoomsPanel() : setPop(roomsPanel, roomsBtn, false) })
roomsCopyLink.addEventListener('click', () => copyText(shareUrl(), roomsCopyLink, '🔗 Copy link'))
roomsCopyName.addEventListener('click', () => { if (!CONFIG.isDefaultRoom) copyText(CONFIG.roomCode, roomsCopyName, '# Copy name') })
roomGoBtn.addEventListener('click', () => {
  const n = normName(roomNameInput.value), pass = roomPassInput.value.trim()
  if (!n) { roomNameInput.focus(); return }
  if (pass.length < CONFIG.minPassLen) {
    roomErrEl.textContent = pass ? `Use at least ${CONFIG.minPassLen} characters — the password becomes the room's encryption key.` : 'A password is required.'
    roomErrEl.hidden = false; roomPassInput.focus(); return
  }
  gotoRoom(n, pass)
})
roomPassInput.addEventListener('input', () => { roomErrEl.hidden = true })
roomNameInput.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); roomPassInput.focus() } })
roomPassInput.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); roomGoBtn.click() } })
roomPublicBtn.addEventListener('click', () => { history.replaceState(null, '', BASE); location.reload() })

themeBtn.addEventListener('click', cycleTheme)
blurBtn.addEventListener('click', toggleBlur)
soundBtn.addEventListener('click', toggleSound)
notifyBtn.addEventListener('click', toggleNotify)
relayBtn.addEventListener('click', toggleRelayOnly)
lightboxClose.addEventListener('click', closeLightbox)
lightbox.addEventListener('click', e => { if (e.target === lightbox) closeLightbox() })

peopleToggle.addEventListener('click', () => peopleEl.classList.contains('open') ? closeAside(peopleEl) : openAside(peopleEl, peopleToggle))
peopleClose.addEventListener('click', () => closeAside(peopleEl))
rulesToggle.addEventListener('click', () => rulesEl.classList.contains('open') ? closeAside(rulesEl) : openAside(rulesEl, rulesToggle))
rulesClose.addEventListener('click', () => closeAside(rulesEl))
scrim.addEventListener('click', closePanels)
document.addEventListener('keydown', e => {
  if (e.key === 'Tab') trapTab(e)
  if (e.key !== 'Escape') return
  if (!lightbox.hidden) { closeLightbox(); return }
  if (!emojiPanel.hidden) { setPop(emojiPanel, emojiBtn, false, true); return }
  if (!roomsPanel.hidden) { setPop(roomsPanel, roomsBtn, false, true); return }
  if (!statusPanel.hidden) { setPop(statusPanel, statusBtn, false, true); return }
  if (reactMenu) { closeReactMenu(); return }
  if (peopleEl.classList.contains('open') || rulesEl.classList.contains('open')) closePanels()
})
;['mousemove', 'keydown', 'touchstart'].forEach(ev => window.addEventListener(ev, () => { if (myPresence === 'idle') bumpActivity() }, {passive: true}))

/* ----- page lifecycle -----
 * `pagehide` fires for a real unload AND when the page goes into the back/forward
 * cache — which on mobile is what happens every time you switch apps. Leaving the
 * room there meant backgrounding the browser silently dropped you out of the chat,
 * and coming back restored a dead page that never re-joined. Only leave when the
 * page is actually going away (`persisted === false`), and re-join on restore. */
const leaveRoom = () => { try { if (room) room.leave() } catch {} }
window.addEventListener('pagehide', e => { if (!e.persisted) leaveRoom() })
window.addEventListener('beforeunload', leaveRoom)
window.addEventListener('pageshow', e => {
  if (!e.persisted || !entered) return
  setStatus('Reconnecting…')
  scheduleReconnect('returning to the page', 0)
})
/* ------------------------------------------------------------------ *
 * Staying connected
 *
 * Three separate things can strand a session, and only one of them is a
 * clean "offline" event:
 *
 *  1. The device really loses the network      → online/offline fires.
 *  2. It SWITCHES network (wifi ↔ cellular)    → nothing fires at all.
 *     navigator.onLine stays true the whole time because there is still a
 *     network — just a different one, with a different address. Every relay
 *     socket and every peer connection is dead, and the old code sat there
 *     waiting for an "online" event that was never coming. This is the case
 *     people actually hit, walking out of the house with the app open.
 *  3. Sockets die quietly (sleep, NAT timeout, relay restart) → no event.
 *
 * So: treat online/offline as a hint, take navigator.connection's change
 * event as the fast signal for a switch, and back both with a watchdog that
 * judges the connection by whether the relay sockets are actually open.
 * ------------------------------------------------------------------ */
let reconnectTimer = null, reconnectTries = 0
function scheduleReconnect(why, delay) {
  if (!entered || reconnectTimer) return
  reconnectTries++
  // back off so a genuinely dead network doesn't become a rejoin loop
  const wait = delay ?? Math.min(20000, 1000 * 2 ** (reconnectTries - 1))
  statusDot.className = 'dot dot--wait'
  setStatus('Reconnecting…')
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    if (!entered) return
    reconnect(why)
  }, wait)
}
function connectionRecovered() { reconnectTries = 0 }

window.addEventListener('offline', () => { statusDot.className = 'dot dot--off'; setStatus('Offline') })
window.addEventListener('online', () => { if (entered) scheduleReconnect('the network came back', 600) })

// Network Information API: fires when the device moves between wifi and
// cellular, which is the one transition that produces no online/offline pair.
const netInfo = navigator.connection || navigator.mozConnection || navigator.webkitConnection
if (netInfo && netInfo.addEventListener) {
  netInfo.addEventListener('change', () => {
    if (!entered) return
    reconnectTries = 0          // a deliberate network change deserves a prompt retry
    scheduleReconnect('the network changed', 600)
  })
}
// Surface script errors in the chat, but cap it: a fault inside the render path
// would otherwise have each report trigger another render and flood the room.
let errShown = 0
function reportError(msg) {
  if (errShown >= 3) return
  errShown++
  addSystem('⚠️ ' + msg + (errShown === 3 ? ' (further errors hidden)' : ''))
}
window.addEventListener('error', e => reportError(e.message || 'a script error occurred'))
window.addEventListener('unhandledrejection', e => reportError((e.reason && e.reason.message) || 'an async error occurred'))

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
 * Join flow — connect, verify the name is free, then reveal the chat
 * ------------------------------------------------------------------ */
function setGateChecking(on) {
  gateGo.disabled = on
  gateGo.textContent = on ? 'Checking name…' : 'Join the chat →'
}
function showGateError(msg) { gateErr.textContent = msg; gateErr.hidden = false; nickInput.focus(); nickInput.select() }
function revealApp() {
  entered = true
  gate.hidden = true; app.hidden = false; inputEl.focus()
  refreshEmpty(); bumpActivity()
}
// Best-effort pre-entry uniqueness: join, discover present peers for a short
// window (bailing early on a clash), reject if the name is taken.
async function joinWithNameCheck() {
  await startChat()
  if (!room) { revealApp(); return true }   // connection failed → let them in to see the error
  // Block instantly on a clash. Otherwise decide "free" as soon as we're confident:
  // connected peers are all named & clean, or relays are up with no peers after a
  // grace (empty room). Hard cap accounts for slow public-relay discovery; anything
  // that slips past is caught by the live auto-rename fallback.
  const taken = await new Promise(resolve => {
    const t0 = Date.now()
    const iv = setInterval(() => {
      if (nameTakenByPeer(myName)) { clearInterval(iv); resolve(true); return }   // clash → block
      const el = Date.now() - t0
      const relays = relayStates().filter(s => s.open).length
      // empty room: relays up but nobody connected after a grace → free, fast.
      // Otherwise wait a fixed window (don't early-exit on partial discovery, or a
      // peer still connecting could be missed); slow-tail slips are auto-renamed.
      if ((relays > 0 && peers.size === 0 && el > 2500) || el > 5000) { clearInterval(iv); resolve(false) }
    }, 150)
  })
  if (taken) { leaveAndReset(); renderRoster(); renderTimeline(); return false }
  revealApp()
  return true
}

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */
function boot() {
  applyTheme(); applyBlur(); applySound(); applyNotify(); applyRelayOnly(); initViewportFit()
  nickInput.maxLength = CONFIG.maxNameLen
  inputEl.maxLength = CONFIG.maxMsgLen
  // the keyboard hint only fits on wide screens. Driven by the media query, not
  // `resize` — an opening mobile keyboard fires resize repeatedly and none of
  // those events can change the answer.
  const setPlaceholder = () => {
    inputEl.placeholder = isDrawer() ? 'Say something…' : 'Say something…  (Shift+Enter for a new line, /help for commands)'
  }
  setPlaceholder()
  NARROW_MQ.addEventListener('change', setPlaceholder)
  buildEmoji('')
  updateSendBtn()
  emptyBtn.addEventListener('click', () => copyText(shareUrl(), emptyBtn, '🔗 Copy invite link'))

  // room chip + gate room label
  if (CONFIG.isDefaultRoom) { roomChip.hidden = true; gateRoomLabel.textContent = 'the public room' }
  // the chip's markup already carries its own "#" span — prefixing another here
  // rendered the room as "##name"
  else { roomChipName.textContent = CONFIG.roomCode; roomChip.hidden = false; gateRoomLabel.textContent = 'private room #' + CONFIG.roomCode; gatePassWrap.hidden = false }

  // prefilled password (set when navigating from "new room") — consumed once,
  // then wiped so the plaintext doesn't linger in sessionStorage for the tab's life
  try {
    const k = 'c2c-pass-' + CONFIG.roomCode, p = sessionStorage.getItem(k)
    if (p) { myPass = p; gatePass.value = p; sessionStorage.removeItem(k) }
  } catch {}

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

  gateForm.addEventListener('submit', async e => {
    e.preventDefault()
    if (gateGo.disabled) return    // a check is already running
    const n = sanitize(nickInput.value, CONFIG.maxNameLen).trim()
    if (!n) { nickInput.focus(); return }
    if (!CONFIG.isDefaultRoom) {
      myPass = gatePass.value.trim()
      if (!myPass) { gatePass.focus(); gatePass.placeholder = '⚠ password required to enter this private room'; return }
      if (myPass.length < CONFIG.minPassLen) {
        gateErr.textContent = `Room passwords are at least ${CONFIG.minPassLen} characters — check it and try again.`
        gateErr.hidden = false; gatePass.focus(); return
      }
    }
    gateErr.hidden = true
    setMyName(n); renderRoster()
    setGateChecking(true)
    const ok = await joinWithNameCheck()
    setGateChecking(false)
    if (!ok) showGateError(`"${n}" is already taken in this room — choose a different name.`)
  })
}

boot()
