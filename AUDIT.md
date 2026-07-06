# Full repository audit — chat-to-chat (Private-chat)

*Audit date: 2026-07-06 · Scope: entire repository at commit `62e5977` (src/, build.mjs, docs/, README) · Method: full manual source review of `src/app.js` (1,607 lines), `src/index.template.html`, `src/style.css`, `build.mjs`; targeted inspection of the vendored Trystero bundle; reproducible-build verification.*

---

## Summary

**No critical or high-severity vulnerabilities were found.** The application's core
security posture is strong for what it is: rendering is strictly DOM-node /
`textContent` based (no `innerHTML` anywhere), message identity is bound to the
transport peer id, the CSP is tight and generated from config, inputs are
sanitized and flood-limited, and the published site is byte-for-byte reproducible
from `src/` (verified: a fresh `node build.mjs` output is identical to the
committed `docs/`).

The meaningful findings are **trust-model gaps inherent to serverless P2P**
(sybil witnesses, fast password KDF) plus a handful of small hardening and
process items. Ranked list below.

---

## Fix status (2026-07-06, same branch)

Addressed after the audit, in the follow-up hardening/UI commit:

- **M1 — fixed.** Room passwords are now stretched client-side (PBKDF2-SHA-256,
  310k iterations, salted with app + room id) before Trystero derives the channel
  key; a minimum length of 8 is enforced at the gate and in the Rooms panel, and
  the README copy no longer overstates weak-password protection.
- **M2 — addressed (wording).** The in-app verified line and README now say
  "connections" and spell out that one person can run several of them.
- **L1 — fixed.** History reaction re-hydration skips any pid claiming to be you.
- **L2 — fixed.** A rename arriving on the `msg` channel now pays the `name`
  flood budget.
- **L3 — fixed.** Reactions only apply to entries that exist in the timeline
  with `kind === 'msg'`.
- **L4 — fixed.** The prefilled room password is wiped from `sessionStorage`
  immediately after being read at boot.
- **L5 — fixed.** `script-src` now carries build-computed sha256 hashes of the
  three inline scripts instead of `'unsafe-inline'`.
- **L6, P1, P2 — still open** (vendor provenance note, CI sync check, LICENSE).

---

## Findings

### M1 · Private-room passwords are brute-forceable offline (weak KDF)

The vendored Trystero derives the room encryption key as a **single unsalted-by-
password SHA-256**: `SHA-256("appId:roomId:password")` → AES-GCM key (visible in
`src/vendor/trystero-nostr.bundle.js`: `importKey("raw", await
crypto.subtle.digest({name:"SHA-256"}, ue(\`${e}:${n}:${t}\`)))`).

Anyone can watch the public Nostr relays, capture the encrypted signaling for a
room, and grind passwords **offline at GPU speed** (billions of SHA-256/s). A
short or dictionary password falls quickly; success both decrypts the captured
signaling and lets the attacker join the room silently. The UI currently accepts
a 1-character password and the copy says the room is "cryptographically gated,"
which overstates protection for weak passwords.

**Recommendation (cheap, no protocol change):** pre-stretch the password
client-side before handing it to Trystero — e.g. `PBKDF2(password,
salt = appId + roomId, ~300k iterations)` (or scrypt) in `gotoRoom()` / the gate
flow, passing the derived hex string as Trystero's `password`. All peers do the
same derivation, so it stays compatible with itself. Additionally: enforce a
minimum password length (≥ 8–10 chars) at the gate, and soften the "cryptographically
gated" copy to note that room security is only as strong as the passphrase.

### M2 · "Verifiable hearsay" attestation is defeated by trivial sybils

`startAttestation()` counts *distinct peer ids* as independent witnesses. Peer
ids are free — one attacker opening N tabs is N "independent" confirmations, so
"✓ History verified — independently confirmed by N other people here" can be
manufactured by a single party who is also the (id-ground) elected history
sender. The README's framing — "forging history now requires everyone present to
collude" — is technically true but misleading, because *one person can be
everyone present*.

There is no clean fix without identity, which the design deliberately avoids.
**Recommendation:** treat this as a documentation-honesty fix — state in the
README limitation section and in the in-app verified line that witnesses are
unauthenticated peers and a sybil can simulate them (e.g. "confirmed by N other
connections here"). Optionally require witnesses to have been present *before*
the newcomer joined, which at least raises the bar from "spawn tabs on demand."

### L1 · History reaction re-hydration trusts claimed peer ids (incl. yours)

In `hist.onMessage` (src/app.js:925-930), the `reacts` payload attributes
reactions to arbitrary claimed pids via `applyReaction(key, emoji,
clampStr(pid, 64), true)`. Unlike messages — where `author === selfId` is
rejected as forged — a malicious elected history sender can attribute reactions
to **your own selfId** (you see "your" reaction highlighted as `mine`) or to any
present peer. This contradicts the README claim that "reply/reaction/history …
never trust claimed identity."

**Recommendation:** skip `pid === selfId` during re-hydration, and consider
skipping pids not currently present. One-line fix for the self case.

### L2 · Name changes via the `msg` channel bypass the `name` flood budget

`msg.onMessage` calls `setPeerName(peerId, data.name, true)` gated only by the
`msg` budget (20 per 2 s), while the dedicated `name` channel is limited to
6 per 4 s. A peer can therefore rename on every message — churning the roster
and emitting a stream of "X is now Y" system lines (batching caps the noise but
it's continuous).

**Recommendation:** when a rename arrives piggybacked on `msg`, also charge the
`name` budget (or only accept the piggybacked name when the peer is still
unnamed).

### L3 · Reactions can target non-message ids

`react.onMessage` accepts any id present in `seenIds`, which also contains local
system-line ids (`sys-0`, `sys-1`, … — guessable) and file-entry keys. These
reactions are stored in the `reactions` map but never rendered (and never
cleaned for sys ids, since eviction only deletes `kind === 'msg'` reaction
entries). Impact is a small unbounded-ish memory nibble and a semantic oddity.

**Recommendation:** resolve the target via `findEntry` and require
`kind === 'msg'` before `applyReaction`.

### L4 · Room password lingers in `sessionStorage` for the tab lifetime

`gotoRoom()` stores the plaintext password at `c2c-pass-<room>`; `boot()` reads
it but never removes it, so it survives in `sessionStorage` for as long as the
tab lives. Anyone with the unlocked device (or a same-tab XSS, currently
non-existent) can read it.

**Recommendation:** `sessionStorage.removeItem` after reading it into memory at
boot (trade-off: F5 re-prompts for the password — arguably correct for a privacy
tool), or document the retention.

### L5 · CSP allows `script-src 'unsafe-inline'` — hashes would be stronger

Because everything is inlined, the CSP grants `'unsafe-inline'` for scripts. The
build already knows the exact bytes of both inline module scripts, so
`build.mjs` can emit `script-src 'sha256-…' 'sha256-…'` instead (meta-CSP
supports hashes; `docs/404.html` adds a third tiny flag script that needs its
own hash). This turns "we never insert HTML" from a code convention into a
platform-enforced guarantee: even a future HTML-injection bug could not execute
script. `style-src` can stay `'unsafe-inline'` (element styles are set via the
`style` property).

### L6 · Vendored crypto bundle has no documented provenance

`src/vendor/trystero-nostr.bundle.js` is ~183 KB of minified WebRTC + secp256k1 +
Nostr code with no recorded version, source commit, build command, or checksum.
A reviewer (or future you) cannot verify it against upstream Trystero, and a
tampered bundle would be invisible in diffs.

**Recommendation:** add `src/vendor/README.md` recording the exact Trystero
version/commit, the bundling command used to produce the file, and its SHA-256 —
so the bundle can be independently regenerated and compared.

### P1 · No CI guard that `docs/` matches `src/` (process)

The published site is a build artifact committed to git. Today it is in sync
(verified), but an edit to `src/` pushed without rebuilding would silently
deploy a stale site. A minimal GitHub Action fixes this:
`node build.mjs && git diff --exit-code docs/`.

### P2 · No LICENSE file (process)

The repository has no license, which legally means "all rights reserved" — at
odds with the project's free-speech framing. Add one (MIT/Apache-2.0/AGPL as
preferred).

### Nits (cosmetic / defensive)

- **Keycap emoji rejected:** `validEmoji` requires `\p{Extended_Pictographic}`
  or a regional indicator; keycap sequences like 1️⃣ (digit + VS16 + U+20E3) fail
  and can't be used as reactions.
- **Fast-path gap divider drift:** `appendOne` only considers a previous
  `msg` for the time-gap divider, while `renderTimeline` tracks system lines
  too — divider placement can differ between the fast path and a full re-render.
- **`build.mjs` escaping:** inline JS neutralizes `</script` but not `<!--`;
  per the HTML spec an unbalanced `<!--` in script data can shift parser state.
  Currently harmless (no such literal in the sources); escaping it too costs one
  regex.
- **Gate password field** could use `autocomplete="new-password"` to more
  reliably suppress password-manager save prompts than `autocomplete="off"`.

---

## What holds up well (verified)

- **XSS surface:** every render path uses `createElement` / `textContent`;
  there is no `innerHTML`/`insertAdjacentHTML`/`outerHTML` in the codebase.
  Links are restricted to `http(s)` by regex and created with
  `rel="noopener noreferrer nofollow"`, `target="_blank"`.
- **CSP baseline:** `default-src 'none'`, exact relay-origin `connect-src`
  generated from config at build time, `base-uri 'none'`, `form-action 'none'`,
  `img-src` limited to `self data: blob:`.
- **Identity binding:** message/file/reaction keys are namespaced by the
  *transport* peer id, so peers can't write into each other's id-space;
  history bursts reject messages claiming to be from the receiver; reply
  quotes are resolved from the local timeline, never from claimed text.
- **Input hygiene:** bidi/zero-width/control-char stripping (keeping ZWJ for
  emoji), length clamps everywhere, timestamp clamping to [now−48 h, now+60 s],
  per-channel flood budgets, emoji-only reaction validation, SVG excluded from
  inline image rendering, non-image blobs forced to `application/octet-stream`.
- **File transfer:** size enforced on actual received bytes (not the claim),
  duplicate-id resend can't leak blob URLs, blob URLs revoked on eviction,
  `/clear`, and leave. The wire-level cap gap is honestly documented.
- **Memory bounds:** timeline cap (400), `seenIds` trim, hash-DAG substrate cap
  (700), color cache cap, flood-state cleanup on leave.
- **Build integrity:** `docs/index.html` and `docs/404.html` are byte-identical
  to a fresh build of `src/` (checked during this audit); placeholder and
  bridge replacements fail loudly if they don't match.
- **Honesty:** README's Limitations section and the in-app IP-exposure notice
  accurately describe the residual risks (id grinding, live-only cap
  enforcement, session-only history).
- **Accessibility:** live regions split for status vs messages, focus traps
  scoped to actual mobile drawers, roving tabindex in the emoji grid, forced-
  colors support, skip link.

## Suggested priority order

1. M1 — stretch the room password (PBKDF2 client-side) + minimum length.
2. L1/L2/L3 — small protocol-hygiene fixes (one guard each).
3. L5 — hash-based `script-src` in the build.
4. M2 — README/UI wording for the sybil limitation.
5. L6, P1, P2 — provenance note, CI sync check, LICENSE.
