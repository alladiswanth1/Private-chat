// Drives the shipped helpers in src/logic.mjs — the same module app.js imports.
import {describe, it} from 'node:test'
import assert from 'node:assert/strict'
import {
  sanitize,
  normName,
  parseRoomFromHash,
  validateRoomForm,
  validT,
  allowFlood,
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
  DEAD_TRYING,
  DEAD_CLOSED,
} from '../src/logic.mjs'

describe('sanitize / room codes', () => {
  it('strips bidi and zero-width controls but keeps emoji ZWJ', () => {
    assert.equal(sanitize('\u202Ehello\u200B', 32), 'hello')
    const family = '👨\u200D👩\u200D👧'
    assert.equal(sanitize(family, 32), family)
    assert.equal(sanitize('a\n\n\n\nb', 32), 'a\n\nb')
    assert.equal(sanitize(12, 8), '')
    assert.equal(sanitize('toolongname', 4), 'tool')
  })

  it('parses #r= room codes the same way the address bar is normalized', () => {
    assert.equal(parseRoomFromHash('#r=Hello World'), 'hello-world')
    assert.equal(parseRoomFromHash('#r=Ok_Room-1'), 'ok_room-1')
    assert.equal(parseRoomFromHash('#foo&r=Topic'), 'topic')
    assert.equal(parseRoomFromHash('#r=%41%42%43'), 'abc')
    assert.equal(parseRoomFromHash(''), '')
    assert.equal(normName('@@@'), '')
    assert.equal(normName('  Cool  Room!! '), 'cool-room')
  })

  it('rejects empty/sanitized-away room names and short passwords', () => {
    const empty = validateRoomForm('@@@', 'longenough', 8)
    assert.equal(empty.ok, false)
    assert.equal(empty.field, 'name')
    assert.match(empty.error, /letters/i)

    const missing = validateRoomForm('lounge', '   ', 8)
    assert.equal(missing.ok, false)
    assert.equal(missing.field, 'pass')

    const short = validateRoomForm('lounge', 'abc', 8)
    assert.equal(short.ok, false)
    assert.equal(short.field, 'pass')
    assert.match(short.error, /8/)

    const ok = validateRoomForm('Lounge Room', 'correct-horse', 8)
    assert.deepEqual(ok, {ok: true, name: 'lounge-room', pass: 'correct-horse'})
  })
})

describe('timeline / flood', () => {
  const flood = {msg: [3, 1000], name: [2, 4000]}

  it('enforces a fixed window per peer+channel', () => {
    const st = new Map()
    assert.equal(allowFlood(st, 'p1', 'msg', flood, 0), true)
    assert.equal(allowFlood(st, 'p1', 'msg', flood, 10), true)
    assert.equal(allowFlood(st, 'p1', 'msg', flood, 20), true)
    assert.equal(allowFlood(st, 'p1', 'msg', flood, 30), false)
    assert.equal(allowFlood(st, 'p2', 'msg', flood, 30), true)
    assert.equal(allowFlood(st, 'p1', 'name', flood, 30), true)
    // window elapsed → new bucket
    assert.equal(allowFlood(st, 'p1', 'msg', flood, 1001), true)
  })

  it('dedupes by id, reports atEnd, and evicts the oldest past the cap', () => {
    const tl = []
    const seen = new Set()
    const a = addTimelineEntry(tl, seen, {id: 'a', t: 10, text: 'one'}, 2)
    assert.equal(a.added, true)
    assert.equal(a.atEnd, true)
    assert.equal(a.index, 0)

    const dup = addTimelineEntry(tl, seen, {id: 'a', t: 99, text: 'nope'}, 2)
    assert.equal(dup.added, false)
    assert.equal(tl.length, 1)

    const c = addTimelineEntry(tl, seen, {id: 'c', t: 5, text: 'older'}, 2)
    assert.equal(c.added, true)
    assert.equal(c.atEnd, false)
    assert.equal(c.index, 0)
    assert.equal(tl.map(e => e.id).join(','), 'c,a')

    const b = addTimelineEntry(tl, seen, {id: 'b', t: 20, text: 'newer'}, 2)
    assert.equal(b.added, true)
    assert.equal(b.atEnd, true, 'atEnd is computed before eviction so a capped append stays a fast-path append')
    assert.equal(b.index, 1)
    assert.equal(b.evicted.map(e => e.id).join(','), 'c')
    assert.equal(tl.map(e => e.id).join(','), 'a,b')
    assert.ok(seen.has('c'), 'evicted ids stay in the dedup set')
  })

  it('prunes the oldest seen ids once the soft cap is crossed', () => {
    const seen = new Set(['a', 'b', 'c', 'd'])
    assert.equal(pruneSeenIds(seen, 3, 2), 2)
    assert.deepEqual([...seen], ['c', 'd'])
    assert.equal(pruneSeenIds(seen, 10, 2), 0)
  })

  it('clamps claimed timestamps so they cannot pin the top or the future', () => {
    const now = 1_700_000_000_000
    assert.equal(validT(now - 1000, now), now - 1000)
    assert.equal(validT(now - 49 * 3600 * 1000, now), now - 48 * 3600 * 1000)
    assert.equal(validT(now + 120000, now), now + 60000)
    assert.equal(validT('nope', now), now)
  })

  it('only incrementally inserts when the DOM can take a neighbor splice', () => {
    assert.equal(canIncrementalInsert({evicted: false, muted: false, hasDom: true, emptyHidden: true}), true)
    assert.equal(canIncrementalInsert({evicted: true, muted: false, hasDom: true, emptyHidden: true}), false)
    assert.equal(canIncrementalInsert({evicted: false, muted: true, hasDom: true, emptyHidden: true}), false)
    assert.equal(canIncrementalInsert({evicted: false, muted: false, hasDom: false, emptyHidden: true}), false)
    assert.equal(canIncrementalInsert({evicted: false, muted: false, hasDom: true, emptyHidden: false}), false)

    const prev = {kind: 'msg', t: 1000}
    const entry = {kind: 'msg', t: 1100}
    const next = {kind: 'msg', t: 1200}
    assert.equal(insertNeedsFullRender(prev, entry, next, 5 * 60 * 1000), false)
    assert.equal(insertNeedsFullRender(prev, entry, null, 5 * 60 * 1000), false)
    assert.equal(insertNeedsFullRender(prev, entry, {kind: 'sys', t: 1200}, 300000), true)
    assert.equal(insertNeedsFullRender(prev, {kind: 'msg', t: 1000 + 400000}, next, 300000), true)
  })

  it('skips the mute-filter copy when nobody is muted', () => {
    const tl = [{kind: 'msg', peerId: 'a'}, {kind: 'sys', peerId: 'x'}, {kind: 'msg', peerId: 'b'}]
    assert.equal(visibleEntries(tl, null), tl)
    const muted = id => id === 'b'
    assert.deepEqual(visibleEntries(tl, muted).map(e => e.peerId || e.kind), ['a', 'x'])
  })

  it('walks to the previous/next non-skipped neighbor', () => {
    const tl = [{id: 'a'}, {id: 'b'}, {id: 'c'}]
    assert.equal(timelineNeighbor(tl, 1, -1).id, 'a')
    assert.equal(timelineNeighbor(tl, 1, 1).id, 'c')
    assert.equal(timelineNeighbor(tl, 1, -1, e => e.id === 'a'), null)
  })
})

describe('connections', () => {
  const base = {
    entered: true,
    reconnectPending: false,
    openRelays: 0,
    rosterPeers: 0,
    livePeerPaths: 0,
    trying: false,
    lastHealthy: 0,
    now: 10_000,
    deadTrying: DEAD_TRYING,
    deadClosed: DEAD_CLOSED,
  }

  it('stays put while joining or a retry is already queued', () => {
    assert.equal(healthDecision({...base, entered: false}), 'skip')
    assert.equal(healthDecision({...base, reconnectPending: true}), 'skip')
  })

  it('treats a live data path or an empty room with relays as healthy', () => {
    assert.equal(healthDecision({...base, livePeerPaths: 1, rosterPeers: 1}), 'healthy')
    assert.equal(healthDecision({...base, openRelays: 2, rosterPeers: 0, livePeerPaths: 0}), 'healthy')
  })

  it('does not let a zombie roster keep the session healthy', () => {
    // Relays still open, two names in the roster, zero RTC paths — old code
    // refreshed lastHealthy forever and never rejoined.
    const zombie = {...base, openRelays: 3, rosterPeers: 2, livePeerPaths: 0, lastHealthy: 0, now: DEAD_CLOSED + 1}
    assert.equal(healthDecision(zombie), 'reconnect')
    assert.equal(healthDecision({...zombie, now: DEAD_CLOSED - 1}), 'wait')
    assert.equal(healthDecision({...zombie, trying: true, now: DEAD_TRYING - 1}), 'wait')
    assert.equal(healthDecision({...zombie, trying: true, now: DEAD_TRYING + 1}), 'reconnect')
  })

  it('falls back to roster count when live paths are unknown', () => {
    assert.equal(healthDecision({...base, livePeerPaths: null, rosterPeers: 2, openRelays: 0}), 'healthy')
  })

  it('classifies RTC / ICE states into live, trying, dead', () => {
    assert.equal(classifyPeerConnectionState('connected'), 'live')
    assert.equal(classifyPeerConnectionState('completed'), 'live')
    assert.equal(classifyPeerConnectionState('connecting'), 'trying')
    assert.equal(classifyPeerConnectionState('disconnected'), 'trying')
    assert.equal(classifyPeerConnectionState('failed'), 'dead')
    assert.equal(classifyPeerConnectionState('closed'), 'dead')
    assert.deepEqual(countPeerPaths(['connected', 'connecting', 'failed']), {live: 1, trying: 1, dead: 1})
    assert.equal(peerConnectionState({connectionState: 'connected', iceConnectionState: 'checking'}), 'connected')
    assert.equal(peerConnectionState({iceConnectionState: 'checking'}), 'checking')
  })

  it('reconnects on network-type change, not rtt flicker', () => {
    const wifi = networkFingerprint({type: 'wifi', effectiveType: '4g', rtt: 40, downlink: 10})
    const wifiWorse = networkFingerprint({type: 'wifi', effectiveType: '4g', rtt: 400, downlink: 1})
    const cell = networkFingerprint({type: 'cellular', effectiveType: '3g', rtt: 200})
    assert.equal(wifi, wifiWorse)
    assert.notEqual(wifi, cell)
    assert.equal(shouldReconnectOnNetworkEvent({entered: true, prevFp: wifi, nextFp: wifiWorse}), false)
    assert.equal(shouldReconnectOnNetworkEvent({entered: true, prevFp: wifi, nextFp: cell}), true)
    assert.equal(shouldReconnectOnNetworkEvent({entered: false, prevFp: wifi, nextFp: cell}), false)
    assert.equal(shouldReconnectOnNetworkEvent({entered: true, prevFp: '', nextFp: ''}), false)
  })

  it('backs off exponentially and caps', () => {
    assert.equal(backoffMs(1), 1000)
    assert.equal(backoffMs(2), 2000)
    assert.equal(backoffMs(5), 16000)
    assert.equal(backoffMs(8), 20000)
    assert.equal(backoffMs(0), 1000)
  })

  it('paints handshaking relays as waiting, not dead', () => {
    assert.equal(relayDotClass({open: true, pending: false}), 'dot dot--on')
    assert.equal(relayDotClass({open: false, pending: true}), 'dot dot--wait')
    assert.equal(relayDotClass({open: false, pending: false}), 'dot dot--off')
  })

  it('classifies Trystero join errors', () => {
    assert.equal(classifyJoinError('incorrect room password when decrypting offer'), 'password')
    assert.equal(classifyJoinError({message: 'incorrect room password when decrypting answer'}), 'password')
    assert.equal(classifyJoinError('check that your TURN server URLs and credentials are reachable'), 'turn')
    assert.equal(classifyJoinError('could not connect to peer abc'), 'peer')
  })

  it('asks for a reconnect after consecutive send failures', () => {
    assert.deepEqual(noteSendResult(true, 4), {consecutiveFails: 0, reconnect: false})
    assert.deepEqual(noteSendResult(false, 0), {consecutiveFails: 1, reconnect: false})
    assert.deepEqual(noteSendResult(false, 1), {consecutiveFails: 2, reconnect: true})
  })

  it('disables the composer unless we have joined, are not renaming, and have actions', () => {
    assert.equal(composerReady({entered: true, renaming: false, hasActions: true}), true)
    assert.equal(composerReady({entered: true, renaming: false, hasActions: false}), false)
    assert.equal(composerReady({entered: true, renaming: true, hasActions: true}), false)
    assert.equal(composerReady({entered: false, renaming: false, hasActions: true}), false)
  })

  it('builds a roster signature that changes on name, presence, or mute', () => {
    const peers = new Map([['p1', {name: 'Ada', presence: 'active'}]])
    const muted = new Set()
    const a = rosterSignature('me', 'Sam', peers, muted)
    assert.equal(rosterSignature('me', 'Sam', peers, muted), a)
    peers.get('p1').presence = 'idle'
    assert.notEqual(rosterSignature('me', 'Sam', peers, muted), a)
    peers.get('p1').presence = 'active'
    muted.add('p1')
    assert.notEqual(rosterSignature('me', 'Sam', peers, muted), a)
  })
})
