// chat-to-chat — ephemeral, serverless, peer-to-peer chat.
//
// How it works: there is no backend. Browsers find each other through free public
// Nostr relays (used only for the encrypted WebRTC handshake), then all messages
// flow directly browser-to-browser over end-to-end-encrypted data channels and are
// never stored anywhere. Close the tab and your messages are gone.

import {joinRoom, selfId, getRelaySockets} from './vendor/trystero-nostr.bundle.js'

/* ------------------------------------------------------------------ *
 * Config — safe to edit.
 * ------------------------------------------------------------------ */
const CONFIG = {
  // A unique id for THIS app on the Nostr network. Change it if you fork this so
  // your traffic doesn't share a namespace with the original.
  appId: 'chat-to-chat-p2p-v1',

  // Everyone who opens the SAME site lands in the same room; different sites are
  // automatically isolated. The key is hostname + path, so that separate projects
  // hosted under the same <user>.github.io host (which share one hostname and
  // differ only by /repo/ path) each get their own room.
  roomId: (() => {
    const path = location.pathname
      .replace(/\/[^/]*\.[^/]*$/, '/') // drop a trailing filename like index.html
      .replace(/\/+$/, '')             // drop trailing slash(es)
    return (location.hostname + path) || 'localhost'
  })(),

  // Optional TURN servers for users behind strict/symmetric NATs. STUN (built in)
  // handles most networks; add TURN credentials here if some peers can't connect.
  // See README → "Connectivity & TURN".
  turnConfig: [
    // {urls: 'turn:your-turn-host:3478', username: 'user', credential: 'pass'},
  ],

  maxNameLen: 24,
  maxMsgLen: 4000,
  maxRendered: 400,    // cap message nodes kept in the DOM (memory/perf guard)
  floodWindowMs: 2000, // per-peer flood window
  floodMax: 20,        // max messages per peer per window before dropping extras
}

/* ------------------------------------------------------------------ *
 * DOM
 * ------------------------------------------------------------------ */
const $ = sel => document.querySelector(sel)
const gate = $('#gate')
const gateForm = $('#gate-form')
const nickInput = $('#nick')
const app = $('#app')
const messagesEl = $('#messages')
const typingEl = $('#typing')
const inputEl = $('#input')
const sendBtn = $('#send')
const emojiBtn = $('#emoji-btn')
const emojiPanel = $('#emoji')
const statusDot = $('#status-dot')
const statusText = $('#status-text')
const onlineCountEl = $('#online-count')
const peopleEl = $('#people')
const peopleListEl = $('#people-list')
const peopleCountEl = $('#people-count')
const peopleToggle = $('#people-toggle')
const peopleClose = $('#people-close')
const scrim = $('#scrim')
const meBtn = $('#me')
const meName = $('#me-name')
const meDot = $('#me-dot')

/* ------------------------------------------------------------------ *
 * State
 * ------------------------------------------------------------------ */
let myName = ''
let room = null
let actions = null              // {msg, name, typing}
const peers = new Map()         // peerId -> {name|null}
const typingTimers = new Map()  // peerId -> timeout id (receiver-side auto-clear)
const floodState = new Map()    // peerId -> {count, start} (inbound flood guard)
let lastSenderId = null         // for grouping consecutive messages
let typingSentAt = 0            // throttle clock for outbound "typing: true" pings
let iTyping = false             // whether peers currently believe I'm typing
let typingStopTimer = null

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */
const clampStr = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '')

const shortId = id => 'guest-' + String(id || '').slice(0, 4)

// Deterministic, pleasant color per peer id (for avatars).
function colorOf(id) {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0
  return `hsl(${h % 360} 70% 65%)`
}

const initialOf = name => {
  const c = (name || '?').trim()[0]
  return (c || '?').toUpperCase()
}

function fmtTime(t) {
  const d = new Date(typeof t === 'number' && isFinite(t) ? t : Date.now())
  return d.toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'})
}

const nameOf = peerId => {
  const p = peers.get(peerId)
  return (p && p.name) || shortId(peerId)
}

function isNearBottom() {
  return messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 120
}
function scrollToBottom(force) {
  if (force || isNearBottom()) messagesEl.scrollTop = messagesEl.scrollHeight
}

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */
function addSystem(text) {
  const el = document.createElement('div')
  el.className = 'sys'
  el.textContent = text
  messagesEl.appendChild(el)
  lastSenderId = null
  scrollToBottom()
}

function addMessage({peerId, name, text, t, self}) {
  const stick = lastSenderId === peerId
  const row = document.createElement('div')
  row.className = 'msg' + (self ? ' me' : '') + (stick ? ' cont' : '')

  const avatar = document.createElement('div')
  avatar.className = 'avatar'
  avatar.style.background = colorOf(peerId)
  avatar.textContent = initialOf(name)
  row.appendChild(avatar)

  const stack = document.createElement('div')
  stack.className = 'stack'

  const meta = document.createElement('div')
  meta.className = 'meta'
  const who = document.createElement('span')
  who.className = 'who'
  who.style.color = self ? '' : colorOf(peerId)
  who.textContent = self ? 'You' : name
  const time = document.createElement('span')
  time.className = 'time'
  time.textContent = fmtTime(t)
  meta.append(who, time)

  const bubble = document.createElement('div')
  bubble.className = 'bubble'
  bubble.textContent = text   // textContent => no HTML injection, ever

  stack.append(meta, bubble)
  row.appendChild(stack)
  messagesEl.appendChild(row)

  // Keep the DOM bounded so a long-lived or flooded room can't grow without limit.
  while (messagesEl.childElementCount > CONFIG.maxRendered) {
    messagesEl.removeChild(messagesEl.firstChild)
  }

  lastSenderId = peerId
  scrollToBottom(self)
}

function renderRoster() {
  const count = peers.size + 1
  onlineCountEl.textContent = String(count)
  peopleCountEl.textContent = String(count)

  peopleListEl.replaceChildren()

  // You, first.
  peopleListEl.appendChild(personRow(selfId, myName, true))
  // Then peers, names first then pending.
  ;[...peers.entries()]
    .sort((a, b) => Number(!!b[1].name) - Number(!!a[1].name))
    .forEach(([id, p]) => peopleListEl.appendChild(personRow(id, p.name, false)))
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

function renderTyping() {
  const names = [...typingTimers.keys()].map(nameOf)
  if (!names.length) {
    typingEl.hidden = true
    typingEl.replaceChildren()
    return
  }
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
  actions = {msg, name, typing}

  // Incoming chat message.
  msg.onMessage = (data, {peerId}) => {
    if (!data || typeof data.text !== 'string') return
    const text = clampStr(data.text, CONFIG.maxMsgLen)
    if (!text) return
    if (!allowFromPeer(peerId)) return // drop floods
    if (typeof data.name === 'string') setPeerName(peerId, data.name)
    clearPeerTyping(peerId)
    addMessage({
      peerId,
      name: nameOf(peerId),
      text,
      t: typeof data.t === 'number' ? data.t : Date.now(),
      self: false,
    })
  }

  // Peer announces / updates their name.
  name.onMessage = (value, {peerId}) => setPeerName(peerId, value)

  // Peer typing state.
  typing.onMessage = (value, {peerId}) => {
    if (value) markPeerTyping(peerId)
    else clearPeerTyping(peerId)
  }

  room.onPeerJoin = peerId => {
    if (!peers.has(peerId)) peers.set(peerId, {name: null})
    name.send(myName, {target: peerId}) // greet the newcomer with my name
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

// Per-peer inbound rate limit: returns false once a peer exceeds floodMax
// messages within floodWindowMs, so one peer can't freeze everyone's tab.
function allowFromPeer(peerId) {
  const now = Date.now()
  const s = floodState.get(peerId)
  if (!s || now - s.start > CONFIG.floodWindowMs) {
    floodState.set(peerId, {count: 1, start: now})
    return true
  }
  s.count++
  return s.count <= CONFIG.floodMax
}

function setPeerName(peerId, value) {
  const name = clampStr(value, CONFIG.maxNameLen).trim()
  if (!name) return
  // Only update peers Trystero currently considers present. onPeerJoin creates the
  // entry before any of that peer's action messages are delivered, so a missing
  // entry here means the peer already left — don't resurrect them as a ghost.
  if (!peers.has(peerId)) return
  const prev = peers.get(peerId).name
  if (prev === name) return
  peers.set(peerId, {name})
  if (!prev) addSystem(`${name} joined`)
  else addSystem(`${prev} is now ${name}`)
  // A name update should refresh any visible typing label too.
  renderRoster()
  if (typingTimers.has(peerId)) renderTyping()
}

function markPeerTyping(peerId) {
  if (!peers.has(peerId)) return
  if (typingTimers.has(peerId)) clearTimeout(typingTimers.get(peerId))
  // Auto-clear if we stop hearing "typing" pings (covers drops & missed stops).
  typingTimers.set(peerId, setTimeout(() => {
    typingTimers.delete(peerId)
    renderTyping()
  }, 4500))
  renderTyping()
}

function clearPeerTyping(peerId) {
  if (typingTimers.has(peerId)) {
    clearTimeout(typingTimers.get(peerId))
    typingTimers.delete(peerId)
    renderTyping()
  }
}

/* ------------------------------------------------------------------ *
 * Sending
 * ------------------------------------------------------------------ */
function sendMessage() {
  const text = clampStr(inputEl.value, CONFIG.maxMsgLen).trim()
  if (!text || !actions) return
  const payload = {text, name: myName, t: Date.now()}
  actions.msg.send(payload)
  addMessage({peerId: selfId, name: myName, text, t: payload.t, self: true})
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
    if (!iTyping || now - typingSentAt > 1500) {
      actions.typing.send(true)
      iTyping = true
      typingSentAt = now
    }
    clearTimeout(typingStopTimer)
    typingStopTimer = setTimeout(stopTyping, 2500)
  } else {
    stopTyping()
  }
}

function stopTyping() {
  clearTimeout(typingStopTimer)
  typingStopTimer = null
  if (actions && iTyping) actions.typing.send(false)
  iTyping = false
  typingSentAt = 0
}

function updateSendBtn() {
  sendBtn.disabled = !inputEl.value.trim()
}

/* ------------------------------------------------------------------ *
 * Connection status indicator
 * ------------------------------------------------------------------ */
function updateStatusLoop() {
  const tick = () => {
    let relays = 0
    try {
      const sockets = getRelaySockets() || {}
      relays = Object.values(sockets).filter(s => s && s.readyState === 1).length
    } catch { /* ignore */ }

    if (peers.size > 0) {
      statusDot.className = 'dot dot--on'
      statusText.textContent = `${peers.size + 1} online`
    } else if (relays > 0) {
      statusDot.className = 'dot dot--wait'
      statusText.textContent = 'Waiting for people…'
    } else {
      statusDot.className = 'dot dot--off'
      statusText.textContent = 'Connecting…'
    }
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
    b.addEventListener('click', () => {
      insertAtCursor(e)
      emojiPanel.hidden = true
      inputEl.focus()
    })
    emojiPanel.appendChild(b)
  })
}

function insertAtCursor(text) {
  const start = inputEl.selectionStart ?? inputEl.value.length
  const end = inputEl.selectionEnd ?? inputEl.value.length
  const next = (inputEl.value.slice(0, start) + text + inputEl.value.slice(end))
    .slice(0, CONFIG.maxMsgLen) // keep within the same cap send() enforces
  inputEl.value = next
  const pos = Math.min(start + text.length, next.length)
  inputEl.setSelectionRange(pos, pos)
  updateSendBtn()
}

/* ------------------------------------------------------------------ *
 * Name handling
 * ------------------------------------------------------------------ */
function applyMyName(name) {
  myName = clampStr(name, CONFIG.maxNameLen).trim()
  meName.textContent = myName
  meDot.style.background = colorOf(selfId)
  try { localStorage.setItem('c2c-name', myName) } catch { /* private mode */ }
}

function changeName() {
  const next = window.prompt('Your name:', myName)
  if (next === null) return
  const clean = clampStr(next, CONFIG.maxNameLen).trim()
  if (!clean || clean === myName) return
  const old = myName
  applyMyName(clean)
  renderRoster()
  if (actions) actions.name.send(myName) // broadcast to everyone
  addSystem(`You are now "${myName}" (was "${old}")`)
}

/* ------------------------------------------------------------------ *
 * Wire up UI
 * ------------------------------------------------------------------ */
sendBtn.addEventListener('click', sendMessage)
inputEl.addEventListener('input', onLocalInput)
inputEl.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    sendMessage()
  }
})

emojiBtn.addEventListener('click', e => {
  e.stopPropagation()
  emojiPanel.hidden = !emojiPanel.hidden
})
document.addEventListener('click', e => {
  if (!emojiPanel.hidden && !emojiPanel.contains(e.target) && e.target !== emojiBtn) {
    emojiPanel.hidden = true
  }
})

function setPeople(open) {
  peopleEl.classList.toggle('open', open)
  peopleToggle.setAttribute('aria-expanded', String(open))
  scrim.hidden = !open // scrim only renders on mobile (CSS-gated)
}
peopleToggle.addEventListener('click', () => setPeople(!peopleEl.classList.contains('open')))
peopleClose.addEventListener('click', () => setPeople(false))
scrim.addEventListener('click', () => setPeople(false))
meBtn.addEventListener('click', changeName)

// Escape closes whichever overlay is open (emoji first, then the mobile roster).
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return
  if (!emojiPanel.hidden) { emojiPanel.hidden = true; inputEl.focus(); return }
  if (peopleEl.classList.contains('open')) setPeople(false)
})

// Best-effort "leave" so peers see you go when you close/hide the tab.
const leaveRoom = () => { try { if (room) room.leave() } catch {} }
window.addEventListener('pagehide', leaveRoom)
window.addEventListener('beforeunload', leaveRoom)

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */
function boot() {
  buildEmoji()
  updateSendBtn()

  // Prefill last-used name (your own name only — no messages are ever stored).
  let saved = ''
  try { saved = localStorage.getItem('c2c-name') || '' } catch {}
  if (saved) nickInput.value = saved
  nickInput.focus()

  gateForm.addEventListener('submit', e => {
    e.preventDefault()
    const name = clampStr(nickInput.value, CONFIG.maxNameLen).trim()
    if (!name) { nickInput.focus(); return }
    applyMyName(name)

    gate.hidden = true
    app.hidden = false
    inputEl.focus()

    addSystem(`Welcome, ${myName}. You're in the room for "${CONFIG.roomId}". Say hi 👋`)
    renderRoster()
    startChat()
  })
}

boot()
