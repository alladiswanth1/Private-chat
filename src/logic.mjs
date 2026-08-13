// Pure helpers for Global Free Speech — no DOM, no WebRTC, no Trystero.
// App I/O stays in app.js; these are the decisions tests can drive.

export const DEAD_TRYING = 16000
export const DEAD_CLOSED = 6000

// Strip bidi-override, zero-width and control chars (anti-spoofing).
// U+200D (ZWJ) is intentionally kept so family/profession/flag emoji stay intact.
const BAD_CHARS = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u200B\u200C\u202A-\u202E\u2066-\u2069\uFEFF]/g

function sanitize(v, max) {
  if (typeof v !== 'string') return ''
  let s = v.replace(BAD_CHARS, '')
  s = s.replace(/\n{3,}/g, '\n\n')
  return max ? s.slice(0, max) : s
}

function normName(s) {
  return String(s || '').trim().replace(/\s+/g, '-').replace(/[^a-zA-Z0-9_-]/g, '').toLowerCase().slice(0, 32)
}

function parseRoomFromHash(hash) {
  const m = String(hash || '').match(/[#&]r=([^&]+)/)
  let c = ''
  if (m) { try { c = decodeURIComponent(m[1]) } catch { c = m[1] } }
  return normName(c)
}

function validateRoomForm(rawName, rawPass, minPassLen) {
  const name = normName(rawName)
  const pass = String(rawPass || '').trim()
  if (!name) {
    return {ok: false, field: 'name', error: 'Use letters, numbers, dashes or underscores for the room name.'}
  }
  if (!pass) return {ok: false, field: 'pass', error: 'A password is required.'}
  if (pass.length < minPassLen) {
    return {ok: false, field: 'pass', error: `Use at least ${minPassLen} characters — the password becomes the room's encryption key.`}
  }
  return {ok: true, name, pass}
}

function validT(t, now = Date.now()) {
  return (typeof t === 'number' && isFinite(t))
    ? Math.min(Math.max(t, now - 48 * 3600 * 1000), now + 60000)
    : now
}

function allowFlood(floodState, peerId, channel, floodConfig, now = Date.now()) {
  const [n, ms] = floodConfig[channel] || floodConfig.msg
  const k = peerId + ':' + channel
  const s = floodState.get(k)
  if (!s || now - s.start > ms) { floodState.set(k, {count: 1, start: now}); return true }
  s.count++
  return s.count <= n
}

function cmpEntry(a, b) {
  return a.t - b.t || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
}

function addTimelineEntry(timeline, seenIds, entry, maxRendered) {
  if (entry.id && seenIds.has(entry.id)) {
    return {added: false, atEnd: false, evicted: [], index: -1}
  }
  if (entry.id) seenIds.add(entry.id)
  let i = timeline.length
  while (i > 0 && cmpEntry(timeline[i - 1], entry) > 0) i--
  timeline.splice(i, 0, entry)
  const atEnd = i === timeline.length - 1
  const evicted = []
  while (timeline.length > maxRendered) evicted.push(timeline.shift())
  return {added: true, atEnd, evicted, index: Math.max(0, i - evicted.length)}
}

function pruneSeenIds(seenIds, cap = 4000, drop = 1000) {
  if (seenIds.size <= cap) return 0
  const it = seenIds.values()
  let n = 0
  for (; n < drop; n++) seenIds.delete(it.next().value)
  return n
}

function canIncrementalInsert({evicted, muted, hasDom, emptyHidden}) {
  return !evicted && !muted && !!hasDom && !!emptyHidden
}

// Mid-list inserts that would need a time-gap divider (or sit next to a
// system line) cannot reuse neighbor DOM safely — fall back to a full render.
// The append path (no `next`) already paints its own gap / unread nodes.
function insertNeedsFullRender(prev, entry, next, gapMs) {
  if (!next) return false
  if (next.kind === 'sys') return true
  if (prev && prev.kind === 'msg' && entry.t - prev.t > gapMs) return true
  if (next.kind === 'msg' && next.t - entry.t > gapMs) return true
  return false
}

function visibleEntries(timeline, isMutedPeer) {
  if (!isMutedPeer) return timeline
  return timeline.filter(e => e.kind === 'sys' || !isMutedPeer(e.peerId))
}

function timelineNeighbor(timeline, index, dir, skipFn) {
  for (let i = index + dir; i >= 0 && i < timeline.length; i += dir) {
    if (!skipFn || !skipFn(timeline[i])) return timeline[i]
  }
  return null
}

// --- connection / reconnect ------------------------------------------------

function healthDecision({
  entered,
  reconnectPending,
  openRelays,
  rosterPeers,
  livePeerPaths,
  trying,
  lastHealthy,
  now,
  deadTrying = DEAD_TRYING,
  deadClosed = DEAD_CLOSED,
}) {
  if (!entered || reconnectPending) return 'skip'
  const live = livePeerPaths == null ? rosterPeers : livePeerPaths
  const signalingOk = openRelays > 0
  const alone = rosterPeers === 0
  if (live > 0) return 'healthy'
  // Empty room with relays up is a valid idle session.
  if (alone && signalingOk) return 'healthy'
  // Roster claims peers but no live RTC path (or no signaling at all):
  // do not refresh lastHealthy — grace, then reconnect.
  const grace = trying ? deadTrying : deadClosed
  if (now - lastHealthy < grace) return 'wait'
  return 'reconnect'
}

function classifyPeerConnectionState(state) {
  const st = String(state || '')
  if (st === 'connected' || st === 'completed') return 'live'
  if (st === 'connecting' || st === 'checking' || st === 'new' || st === 'disconnected') return 'trying'
  return 'dead'
}

function countPeerPaths(states) {
  let live = 0, trying = 0, dead = 0
  for (const st of states) {
    const k = classifyPeerConnectionState(st)
    if (k === 'live') live++
    else if (k === 'trying') trying++
    else dead++
  }
  return {live, trying, dead}
}

function peerConnectionState(pc) {
  return (pc && (pc.connectionState || pc.iceConnectionState)) || ''
}

function networkFingerprint(conn) {
  if (!conn) return ''
  return String(conn.type || '') + '|' + String(conn.effectiveType || '')
}

function shouldReconnectOnNetworkEvent({entered, prevFp, nextFp}) {
  return !!(entered && nextFp && prevFp !== nextFp)
}

function backoffMs(tries, base = 1000, cap = 20000) {
  const n = Math.max(1, tries)
  return Math.min(cap, base * (2 ** (n - 1)))
}

function relayDotClass({open, pending}) {
  if (open) return 'dot dot--on'
  if (pending) return 'dot dot--wait'
  return 'dot dot--off'
}

function classifyJoinError(error) {
  const msg = String((error && error.message) || error || '')
  if (/password/i.test(msg)) return 'password'
  if (/TURN|turn server/i.test(msg)) return 'turn'
  return 'peer'
}

function noteSendResult(ok, consecutiveFails, threshold = 2) {
  if (ok) return {consecutiveFails: 0, reconnect: false}
  const n = consecutiveFails + 1
  return {consecutiveFails: n, reconnect: n >= threshold}
}

function composerReady({entered, renaming, hasActions}) {
  return !!(entered && hasActions && !renaming)
}

function rosterSignature(selfId, myName, peerEntries, muted) {
  let s = String(selfId) + '\t' + String(myName || '')
  for (const [id, p] of peerEntries) {
    s += '\n' + id + '\t' + ((p && p.name) || '') + '\t' + ((p && p.presence) || '') + '\t' + (muted && muted.has(id) ? '1' : '0')
  }
  return s
}

export {
  sanitize,
  normName,
  parseRoomFromHash,
  validateRoomForm,
  validT,
  allowFlood,
  cmpEntry,
  addTimelineEntry,
  pruneSeenIds,
  canIncrementalInsert,
  insertNeedsFullRender,
  visibleEntries,
  timelineNeighbor,
  healthDecision,
  classifyPeerConnectionState,
  countPeerPaths,
  peerConnectionState,
  networkFingerprint,
  shouldReconnectOnNetworkEvent,
  backoffMs,
  relayDotClass,
  classifyJoinError,
  noteSendResult,
  composerReady,
  rosterSignature,
}
