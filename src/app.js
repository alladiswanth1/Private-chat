// Global Free Speech — serverless, ephemeral, peer-to-peer chat.
//
// No backend: browsers find each other via free public Nostr relays (Trystero,
// vendored) for the encrypted WebRTC handshake only; messages then flow directly
// browser-to-browser over end-to-end-encrypted data channels and are never stored.
//
// Live history hand-off: when you join, peers already in the room send you the
// recent conversation from their own memory. If everyone leaves, history is gone.

import {joinRoom, selfId, getRelaySockets} from './vendor/trystero-nostr.bundle.js'

// Any deep URL (e.g. someone typing /README.md or /app.js) is served this same
// app; silently clean the address bar back to root WITHOUT reloading, so no file
// and no error are ever shown — the visitor just lands in the chat.
try {
  if (location.pathname !== '/' || location.search || location.hash) {
    history.replaceState(null, '', '/')
  }
} catch {}

/* ------------------------------------------------------------------ *
 * Config — safe to edit.
 * ------------------------------------------------------------------ */
const CONFIG = {
  appId: 'chat-to-chat-p2p-v1',
  // One room per host. Every path is served the app and normalized to '/', so
  // everyone on the domain shares the same single room regardless of URL.
  roomId: location.hostname || 'localhost',
  turnConfig: [
    // {urls: 'turn:your-turn-host:3478', username: 'user', credential: 'pass'},
  ],
  maxNameLen: 24,
  maxMsgLen: 4000,
  maxRendered: 400,    // cap timeline entries kept in memory/DOM
  historyShare: 30,    // recent messages handed to a newcomer
  floodWindowMs: 2000, // per-peer flood window
  floodMax: 20,        // max messages per peer per window before dropping
}

/* ------------------------------------------------------------------ *
 * DOM
 * ------------------------------------------------------------------ */
const $ = s => document.querySelector(s)
const gate = $('#gate'), gateForm = $('#gate-form'), nickInput = $('#nick')
const app = $('#app'), messagesEl = $('#messages'), typingEl = $('#typing'), jumpBtn = $('#jump')
const inputEl = $('#input'), sendBtn = $('#send'), emojiBtn = $('#emoji-btn'), emojiPanel = $('#emoji')
const statusDot = $('#status-dot'), statusText = $('#status-text')
const onlineCountEl = $('#online-count'), peopleEl = $('#people'), peopleListEl = $('#people-list'), peopleCountEl = $('#people-count')
const rulesEl = $('#rules')
const peopleToggle = $('#people-toggle'), peopleClose = $('#people-close')
const rulesToggle = $('#rules-toggle'), rulesClose = $('#rules-close')
const scrim = $('#scrim')
const meName = $('#me-name'), meDot = $('#me-dot')

/* ------------------------------------------------------------------ *
 * State
 * ------------------------------------------------------------------ */
let myName = ''
let room = null
let actions = null                 // {msg, name, typing, hist}
const peers = new Map()            // peerId -> {name|null}
const typingTimers = new Map()     // peerId -> timeout id
const floodState = new Map()       // peerId -> {count, start}
const timeline = []                // sorted by (t,id); entries {kind:'msg'|'sys', id, t, ...}
const seenIds = new Set()
let seq = 0                        // local monotonic counter (unique ids + tiebreak)
let newestId = null                // last entry to receive the entrance animation
let typingSentAt = 0, iTyping = false, typingStopTimer = null

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */
const clampStr = (v, m) => (typeof v === 'string' ? v.slice(0, m) : '')
const shortId = id => 'guest-' + String(id || '').slice(0, 4)
function colorOf(id) {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0
  return `hsl(${h % 360} 72% 68%)`
}
const initialOf = name => ((name || '?').trim()[0] || '?').toUpperCase()
function fmtTime(t) {
  const d = new Date(typeof t === 'number' && isFinite(t) ? t : Date.now())
  return d.toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'})
}
const nameOf = peerId => { const p = peers.get(peerId); return (p && p.name) || shortId(peerId) }
const newMsgId = () => `${selfId}-${Date.now()}-${seq++}`
const isNearBottom = () => messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 120

/* ------------------------------------------------------------------ *
 * Timeline (single source of truth for what's rendered)
 * ------------------------------------------------------------------ */
const cmp = (a, b) => a.t - b.t || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

function addEntry(entry) {
  if (entry.id && seenIds.has(entry.id)) return false
  if (entry.id) seenIds.add(entry.id)
  let i = timeline.length
  while (i > 0 && cmp(timeline[i - 1], entry) > 0) i--
  timeline.splice(i, 0, entry)
  while (timeline.length > CONFIG.maxRendered) {
    const r = timeline.shift()
    if (r.id) seenIds.delete(r.id)
  }
  return true
}

function renderTimeline({stick} = {}) {
  const atBottom = stick ?? isNearBottom()
  const prevTop = messagesEl.scrollTop
  const frag = document.createDocumentFragment()
  let last = null
  for (const e of timeline) {
    if (e.kind === 'sys') { frag.appendChild(sysNode(e.text)); last = null }
    else { frag.appendChild(msgNode(e, last === e.peerId)); last = e.peerId }
  }
  messagesEl.replaceChildren(frag)
  messagesEl.scrollTop = atBottom ? messagesEl.scrollHeight : prevTop
  if (atBottom) hideJump()
}

function sysNode(text) {
  const el = document.createElement('div')
  el.className = 'sys'
  el.textContent = text
  return el
}

function msgNode(e, grouped) {
  const self = e.peerId === selfId
  const row = document.createElement('div')
  row.className = 'msg' + (self ? ' me' : '') + (grouped ? ' cont' : '') + (e.id === newestId ? ' msg--new' : '')

  const avatar = document.createElement('div')
  avatar.className = 'avatar'
  avatar.style.background = colorOf(e.peerId)
  avatar.textContent = initialOf(e.name)

  const stack = document.createElement('div')
  stack.className = 'stack'
  const meta = document.createElement('div')
  meta.className = 'meta'
  const who = document.createElement('span')
  who.className = 'who'
  who.style.color = self ? '' : colorOf(e.peerId)
  who.textContent = self ? 'You' : e.name
  const time = document.createElement('span')
  time.className = 'time'
  time.textContent = fmtTime(e.t)
  meta.append(who, time)
  const bubble = document.createElement('div')
  bubble.className = 'bubble'
  bubble.textContent = e.text   // textContent => no HTML injection, ever
  stack.append(meta, bubble)
  row.append(avatar, stack)
  return row
}

function addSystem(text) {
  const stick = isNearBottom()
  addEntry({kind: 'sys', id: 'sys-' + seq++, t: Date.now(), text})
  renderTimeline({stick})
}

function addMessage(entry, fromSelf) {
  const stick = fromSelf || isNearBottom()
  const added = addEntry({kind: 'msg', ...entry})
  if (!added) return false
  newestId = entry.id
  renderTimeline({stick})
  if (!stick) showJump()
  return true
}

/* ------------------------------------------------------------------ *
 * Scroll-to-latest affordance
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
    const joinCfg = {appId: CONFIG.appId}
    if (CONFIG.turnConfig && CONFIG.turnConfig.length) joinCfg.turnConfig = CONFIG.turnConfig
    room = joinRoom(joinCfg, CONFIG.roomId)
    wireRoom(room)
    updateStatusLoop()
  } catch (err) {
    showFatal(err)
  }
}

function showFatal(err) {
  statusDot.className = 'dot dot--off'
  statusText.textContent = 'Connection failed'
  addSystem(!window.isSecureContext
    ? 'Could not start: this page must be served over HTTPS (or http://localhost). Open it from a secure URL and reload.'
    : `Could not connect: ${(err && err.message) || 'unknown error'}. Try reloading.`)
}

function wireRoom(room) {
  const msg = room.makeAction('msg')
  const name = room.makeAction('name')
  const typing = room.makeAction('typing')
  const hist = room.makeAction('hist')
  actions = {msg, name, typing, hist}

  // Live chat message.
  msg.onMessage = (data, {peerId}) => {
    if (!data || typeof data.text !== 'string') return
    const text = clampStr(data.text, CONFIG.maxMsgLen)
    if (!text) return
    if (!allowFromPeer(peerId)) return
    if (typeof data.name === 'string') setPeerName(peerId, data.name)
    clearPeerTyping(peerId)
    addMessage({
      id: typeof data.id === 'string' ? data.id : `${peerId}-${data.t || Date.now()}-r${seq++}`,
      t: typeof data.t === 'number' ? data.t : Date.now(),
      peerId,
      name: nameOf(peerId),
      text,
    }, false)
  }

  // History hand-off: an existing peer sends a newcomer the recent conversation.
  hist.onMessage = (data, {peerId}) => {
    if (!Array.isArray(data)) return
    let added = false
    for (const m of data.slice(0, CONFIG.historyShare * 3)) {
      if (!m || typeof m.id !== 'string' || typeof m.text !== 'string') continue
      const text = clampStr(m.text, CONFIG.maxMsgLen)
      if (!text) continue
      if (addEntry({
        kind: 'msg',
        id: m.id,
        t: typeof m.t === 'number' ? m.t : Date.now(),
        peerId: typeof m.peerId === 'string' ? m.peerId : peerId,
        name: clampStr(m.name, CONFIG.maxNameLen) || shortId(m.peerId || peerId),
        text,
      })) added = true
    }
    if (added) renderTimeline({stick: true})
  }

  // Peer announces / updates their name.
  name.onMessage = (value, {peerId}) => setPeerName(peerId, value)

  // Typing state.
  typing.onMessage = (value, {peerId}) => { value ? markPeerTyping(peerId) : clearPeerTyping(peerId) }

  room.onPeerJoin = peerId => {
    if (!peers.has(peerId)) peers.set(peerId, {name: null})
    name.send(myName, {target: peerId}) // greet the newcomer with my name
    // Hand off my recent history so they can see the ongoing conversation.
    const recent = timeline
      .filter(e => e.kind === 'msg')
      .slice(-CONFIG.historyShare)
      .map(e => ({id: e.id, t: e.t, peerId: e.peerId, name: e.name, text: e.text}))
    if (recent.length) hist.send(recent, {target: peerId})
    renderRoster()
  }

  room.onPeerLeave = peerId => {
    const left = nameOf(peerId)
    const existed = peers.delete(peerId)
    clearPeerTyping(peerId)
    floodState.delete(peerId)
    renderRoster()
    if (existed) addSystem(`${left} left`)
  }
}

function allowFromPeer(peerId) {
  const now = Date.now()
  const s = floodState.get(peerId)
  if (!s || now - s.start > CONFIG.floodWindowMs) { floodState.set(peerId, {count: 1, start: now}); return true }
  s.count++
  return s.count <= CONFIG.floodMax
}

function setPeerName(peerId, value) {
  const name = clampStr(value, CONFIG.maxNameLen).trim()
  if (!name) return
  if (!peers.has(peerId)) return // don't resurrect a peer that already left
  const prev = peers.get(peerId).name
  if (prev === name) return
  peers.set(peerId, {name})
  if (!prev) addSystem(`${name} joined`)
  else addSystem(`${prev} is now ${name}`)
  renderRoster()
  if (typingTimers.has(peerId)) renderTyping()
}

/* ------------------------------------------------------------------ *
 * Typing indicators
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
  const names = [...typingTimers.keys()].map(nameOf)
  if (!names.length) { typingEl.hidden = true; typingEl.replaceChildren(); return }
  let label
  if (names.length === 1) label = `${names[0]} is typing`
  else if (names.length === 2) label = `${names[0]} and ${names[1]} are typing`
  else label = 'Several people are typing'
  const dots = document.createElement('span')
  dots.className = 'dots'
  dots.append(document.createElement('i'), document.createElement('i'), document.createElement('i'))
  const txt = document.createElement('span')
  txt.textContent = label
  typingEl.replaceChildren(txt, dots)
  typingEl.hidden = false
}

/* ------------------------------------------------------------------ *
 * Roster
 * ------------------------------------------------------------------ */
function renderRoster() {
  const count = peers.size + 1
  onlineCountEl.textContent = String(count)
  peopleCountEl.textContent = String(count)
  const frag = document.createDocumentFragment()
  frag.appendChild(personRow(selfId, myName, true))
  ;[...peers.entries()]
    .sort((a, b) => Number(!!b[1].name) - Number(!!a[1].name))
    .forEach(([id, p]) => frag.appendChild(personRow(id, p.name, false)))
  peopleListEl.replaceChildren(frag)
}
function personRow(id, name, isSelf) {
  const li = document.createElement('li')
  li.className = 'person' + (!isSelf && !name ? ' pending' : '')
  const av = document.createElement('div')
  av.className = 'avatar'
  av.style.background = colorOf(id)
  av.textContent = initialOf(name || '?')
  const nm = document.createElement('span')
  nm.className = 'pname'
  nm.textContent = name || 'connecting…'
  li.append(av, nm)
  if (isSelf) {
    const tag = document.createElement('span')
    tag.className = 'tag'
    tag.textContent = 'you'
    li.appendChild(tag)
  }
  return li
}

/* ------------------------------------------------------------------ *
 * Sending
 * ------------------------------------------------------------------ */
function sendMessage() {
  const text = clampStr(inputEl.value, CONFIG.maxMsgLen).trim()
  if (!text || !actions) return
  const entry = {id: newMsgId(), t: Date.now(), peerId: selfId, name: myName, text}
  actions.msg.send({id: entry.id, t: entry.t, name: myName, text})
  addMessage(entry, true)
  inputEl.value = ''
  stopTyping()
  updateSendBtn()
  inputEl.focus()
}

function onLocalInput() {
  updateSendBtn()
  if (!actions) return
  if (inputEl.value.trim()) {
    const now = Date.now()
    if (!iTyping || now - typingSentAt > 1500) { actions.typing.send(true); iTyping = true; typingSentAt = now }
    clearTimeout(typingStopTimer)
    typingStopTimer = setTimeout(stopTyping, 2500)
  } else {
    stopTyping()
  }
}
function stopTyping() {
  clearTimeout(typingStopTimer); typingStopTimer = null
  if (actions && iTyping) actions.typing.send(false)
  iTyping = false; typingSentAt = 0
}
function updateSendBtn() { sendBtn.disabled = !inputEl.value.trim() }

/* ------------------------------------------------------------------ *
 * Connection status
 * ------------------------------------------------------------------ */
function updateStatusLoop() {
  const tick = () => {
    let relays = 0
    try { relays = Object.values(getRelaySockets() || {}).filter(s => s && s.readyState === 1).length } catch {}
    if (peers.size > 0) { statusDot.className = 'dot dot--on'; statusText.textContent = `${peers.size + 1} online` }
    else if (relays > 0) { statusDot.className = 'dot dot--wait'; statusText.textContent = 'Waiting for people…' }
    else { statusDot.className = 'dot dot--off'; statusText.textContent = 'Connecting…' }
  }
  tick()
  setInterval(tick, 2000)
}

/* ------------------------------------------------------------------ *
 * Emoji picker
 * ------------------------------------------------------------------ */
const EMOJI = ('😀 😁 😂 🤣 😊 😍 😘 😎 🤩 🥳 😉 🙂 🙃 😇 🤔 🤨 😴 😭 😢 😅 ' +
  '😤 😠 😡 🥺 😱 🤯 🤗 🤭 🫡 🫠 👍 👎 👏 🙌 🙏 💪 🤝 👋 ✌️ 🤞 ' +
  '❤️ 🧡 💛 💚 💙 💜 🖤 🤍 💔 💯 🔥 ✨ 🎉 🎊 ⭐ 🌟 ⚡ 💥 ☀️ 🌙 ' +
  '🍕 🍔 🍟 🍰 🍺 ☕ 🎮 🎵 ⚽ 🏆 🚀 💻 📱 💡 ✅ ❌ ❓ ❗ 👀 💬').split(' ')

function buildEmoji() {
  EMOJI.forEach(e => {
    const b = document.createElement('button')
    b.type = 'button'
    b.textContent = e
    b.addEventListener('click', () => { insertAtCursor(e); emojiPanel.hidden = true; inputEl.focus() })
    emojiPanel.appendChild(b)
  })
}
function insertAtCursor(text) {
  const start = inputEl.selectionStart ?? inputEl.value.length
  const end = inputEl.selectionEnd ?? inputEl.value.length
  const next = (inputEl.value.slice(0, start) + text + inputEl.value.slice(end)).slice(0, CONFIG.maxMsgLen)
  inputEl.value = next
  const pos = Math.min(start + text.length, next.length)
  inputEl.setSelectionRange(pos, pos)
  updateSendBtn()
}

/* ------------------------------------------------------------------ *
 * Side panels (rules + people) — slide-in overlays on mobile
 * ------------------------------------------------------------------ */
function syncScrim() {
  scrim.hidden = !(peopleEl.classList.contains('open') || rulesEl.classList.contains('open'))
}
function showPeople(open) {
  peopleEl.classList.toggle('open', open)
  if (open) rulesEl.classList.remove('open')
  peopleToggle.setAttribute('aria-expanded', String(open))
  rulesToggle.setAttribute('aria-expanded', String(rulesEl.classList.contains('open')))
  syncScrim()
}
function showRules(open) {
  rulesEl.classList.toggle('open', open)
  if (open) peopleEl.classList.remove('open')
  rulesToggle.setAttribute('aria-expanded', String(open))
  peopleToggle.setAttribute('aria-expanded', String(peopleEl.classList.contains('open')))
  syncScrim()
}
function closePanels() { showPeople(false); showRules(false) }

/* ------------------------------------------------------------------ *
 * Wire up UI
 * ------------------------------------------------------------------ */
sendBtn.addEventListener('click', sendMessage)
inputEl.addEventListener('input', onLocalInput)
inputEl.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage() } })

emojiBtn.addEventListener('click', e => { e.stopPropagation(); emojiPanel.hidden = !emojiPanel.hidden })
document.addEventListener('click', e => {
  if (!emojiPanel.hidden && !emojiPanel.contains(e.target) && e.target !== emojiBtn) emojiPanel.hidden = true
})

peopleToggle.addEventListener('click', () => showPeople(!peopleEl.classList.contains('open')))
peopleClose.addEventListener('click', () => showPeople(false))
rulesToggle.addEventListener('click', () => showRules(!rulesEl.classList.contains('open')))
rulesClose.addEventListener('click', () => showRules(false))
scrim.addEventListener('click', closePanels)
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return
  if (!emojiPanel.hidden) { emojiPanel.hidden = true; inputEl.focus(); return }
  if (peopleEl.classList.contains('open') || rulesEl.classList.contains('open')) closePanels()
})

const leaveRoom = () => { try { if (room) room.leave() } catch {} }
window.addEventListener('pagehide', leaveRoom)
window.addEventListener('beforeunload', leaveRoom)

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */
function boot() {
  buildEmoji()
  updateSendBtn()
  let saved = ''
  try { saved = localStorage.getItem('c2c-name') || '' } catch {}
  if (saved) nickInput.value = saved
  nickInput.focus()

  gateForm.addEventListener('submit', e => {
    e.preventDefault()
    const name = clampStr(nickInput.value, CONFIG.maxNameLen).trim()
    if (!name) { nickInput.focus(); return }
    myName = name
    meName.textContent = myName
    meDot.style.background = colorOf(selfId)
    try { localStorage.setItem('c2c-name', myName) } catch {}

    gate.hidden = true
    app.hidden = false
    inputEl.focus()
    addSystem(`You joined "${CONFIG.roomId}". Messages are live & peer-to-peer — say hi 👋`)
    renderRoster()
    startChat()
  })
}

boot()
