https://chat-to-chat-publicvm.com
# 💬 chat-to-chat · Global Free Speech

A **live, ephemeral, peer-to-peer chat** that runs as a plain static website.

- **No backend.** No database, no server, no API of yours, no WebSocket server you run.
- **Session-only history.** Nothing is ever written to disk. New joiners are handed the recent conversation *by the people currently in the room* (peer-to-peer); when the last person leaves, the history is gone for good.
- **One room per site.** Everyone who opens the same site (same host **and** path) lands in the same global chat. A different site — a different domain, or even a different `/repo/` on the same `*.github.io` host — is automatically its own separate room.
- **Direct & private.** Messages travel **browser-to-browser over end-to-end-encrypted WebRTC**. They never pass through any relay or server.

Just static files → drop them on **GitHub Pages** (or any static host) and it works.

---

## How can there be no server?

Two browsers on different devices can't find each other on the internet by themselves — something has to introduce them once (this is called *signaling*). GitHub Pages can't do that (it only serves files).

This app uses **[Trystero](https://github.com/dmotz/trystero)** over the public **Nostr** network to do that one introduction. You run and pay for **nothing** — the handshake rides on free public Nostr relays that other people operate.

After the introduction, every message goes **directly peer-to-peer** over an encrypted WebRTC data channel. The relays only ever see the encrypted connection setup, never your messages.

```
Browser A  ──(encrypted handshake via free public Nostr relays)──  Browser B
    │                                                                   │
    └──────────── direct, end-to-end-encrypted P2P messages ───────────┘
                         (no server in the middle, nothing stored)
```

The Trystero library is **vendored** into `src/vendor/trystero-nostr.bundle.js` (one self-contained file, no runtime CDN dependency).

---

## Project layout

Editable sources live in **`src/`** (never published). A tiny build inlines them into a
single self-contained page in **`docs/`**, which is what GitHub Pages serves — so the
only thing reachable on the live site is the page itself (the app). No `app.js`,
`style.css`, or `vendor/` exist as separate URLs to open.

```
src/                             ← editable sources (repo-only, NOT served)
  index.template.html            page markup (gate, 3-column layout, composer)
  style.css                      dark, responsive UI
  app.js                         all logic (Trystero wiring + history hand-off + UI)
  vendor/trystero-nostr.bundle.js  bundled Trystero (Nostr strategy)
build.mjs                        inlines src/* → docs/index.html (+ docs/404.html)
docs/                            ← the published site (GitHub Pages source = /docs)
  index.html                     single self-contained page (CSS + JS all inlined)
  404.html                       same app + a 404 flag; any unknown URL serves the app
  CNAME  .nojekyll               GitHub Pages config (the only other served files)
README.md  .gitignore            repo-only files (not served)
```

---

## Build

After editing anything in `src/`, regenerate the published page:

```bash
node build.mjs
```

This inlines the CSS + JS + vendor bundle into `docs/index.html` and writes an
identical `docs/404.html`.

## Run it locally

WebRTC needs `http(s)://` — `file://` won't work. Build, then serve `docs/`:

```bash
node build.mjs && cd docs && python3 -m http.server 8080
# then open http://localhost:8080
```

Open it in **two browser windows/tabs** (or two browsers). They share the `localhost`
room and connect to each other.

---

## Deploy to GitHub Pages

1. Build and push:

   ```bash
   node build.mjs
   git add . && git commit -m "deploy"
   git push origin main
   ```

2. On GitHub: **Settings → Pages → Build and deployment → Source: "Deploy from a branch"**, pick **`main`** and the **`/docs`** folder, save.

3. After a minute your site is live at `https://<you>.github.io/<repo>/`.

> Publishing from `/docs` (which contains only the inlined page) is what keeps the
> sources and `README.md` off the live site; `docs/404.html` makes any unknown URL —
> including `/README.md`, `/app.js`, etc. — silently land on the app, which cleans the
> address bar back to `/` with no reload and no error.

### Custom domain (e.g. `chat-to-chat.com`)

1. In **Settings → Pages → Custom domain**, enter your domain and save (GitHub keeps
   the `docs/CNAME` file in sync).
2. At your DNS provider, point the domain at GitHub Pages:
   - apex domain `chat-to-chat.com` → four `A` records:
     `185.199.108.153`, `185.199.109.153`, `185.199.110.153`, `185.199.111.153`
   - and/or `www` → `CNAME` to `<you>.github.io`.
3. Enable **Enforce HTTPS** once the certificate is issued.

> Because the room is keyed to host + path, your custom domain (served at the root)
> gets its own dedicated room — separate from the `https://<you>.github.io/<repo>/`
> URL it was reachable at before.

---

## Connectivity & TURN

Built-in STUN handles most networks, but users behind strict/symmetric NATs (most
mobile carriers, some corporate networks) can't form a direct P2P link with STUN
alone — they discover each other and then the connection fails. To cover them,
`CONFIG.turnConfig` ships with the **Open Relay Project's free public TURN**
(static shared credentials, made for serverless sites). ICE only routes through
TURN when a direct path is impossible, and the traffic stays end-to-end encrypted
either way.

For heavier traffic or more reliability, swap in your own TURN relay in
`src/app.js` → `CONFIG.turnConfig` (then rebuild):

```js
turnConfig: [
  {urls: 'turn:your-turn-host:3478', username: 'user', credential: 'pass'},
],
```

Options: [Open Relay / Metered](https://www.metered.ca/stun-turn) (bigger free
tier with an account) or any self-hosted [coturn](https://github.com/coturn/coturn).
Note: Cloudflare TURN issues short-lived credentials via API, which needs a server —
not usable from a purely static site.

---

## Customize

Everything tweakable lives in `CONFIG` at the top of `src/app.js` (run `node build.mjs` after):

| Field        | What it does                                                              |
|--------------|--------------------------------------------------------------------------|
| `appId`      | Your app's namespace on the network. **Change it if you fork** this.      |
| `roomId`     | Default = host (+ `/repo/` subpath on project sites); a `#r=<name>` (name + required password) makes a private room. |
| `relayUrls` / `relayRedundancy` | Curated public Nostr relays + how many to use (pinned for reliable discovery). |
| `historyShare` | How many recent messages a newcomer is handed (default 30).            |
| `meshCap`    | Soft cap before suggesting an overflow room (default 12).                  |
| `flood`      | Per-channel inbound rate limits (msg/name/typing/react/presence).          |
| `turnConfig` | Optional TURN servers (see above).                                        |
| `maxNameLen` / `maxMsgLen` | Input length caps.                                          |
| `minPassLen` | Minimum private-room password length (default 8 — it's key material).     |
| `maxFileBytes` | Largest file/image a peer may send (default 10 MB).                     |

**Rooms & sharing:** the default room is the whole domain (public). Click the **Rooms**
button (top-right) to **create or join a private room by name** — pick any name/number
plus a **required password (min 8 characters)**. Only people who enter the *same name
**and** password* connect: the password is first **stretched with PBKDF2 (SHA-256,
310k iterations, salted with the room id)** and the result becomes the channel's
encryption key, so a wrong password reaches no one and a captured handshake can't be
brute-forced offline at raw-hash speed (the password never goes in the URL, and is
wiped from `sessionStorage` right after it's read). Still: the room is only as strong
as the passphrase — prefer a few random words over `password1`. Invite by sharing the
link (`#r=<name>`) and giving people the password **separately**. Rooms are just
room-ids over the free relays — nothing is stored, and a room vanishes the moment its
last person leaves. No server, no database.

---

## Features

- Pick a nickname (no account, no password) — remembered locally; live avatar + a
  "🎲 surprise me" generator on the join screen.
- Live messages, end-to-end encrypted, never stored on disk, with **safe linkify +
  minimal markdown** (`**bold**`, `_italic_`, `` `code` ``) rendered as DOM nodes only.
- **Live history hand-off** — a newcomer is handed the last ~30 messages (and their
  reactions) by the single elected peer already in the room.
- **Verifiable hearsay** — every message carries SHA-256 links to the messages before
  it, weaving a causal hash-DAG as the room talks. A newcomer recomputes the hashes of
  the handed-off history (the relayer can't silently alter or drop anything inside the
  chain) and then asks the *other* people present to vouch: if an independent peer's
  latest hashes chain down into the burst, the room shows
  *"✓ History verified — independently confirmed by N other people here."*
  Forging history now requires everyone present to collude, not just one elected peer.
- **Private rooms by custom name + required password** (`#r=<name>`, cryptographically gated), and an
  overflow-room suggestion when a mesh gets large.
- **Peer-to-peer file & image sharing** — attach (📎), drag-and-drop onto the chat, or
  paste an image; it streams **directly browser-to-browser over the encrypted WebRTC
  channel** (chunked, with a live progress bar), never through any server. Images render
  inline; other files arrive as a download card. Up to 10 MB; **live-only** (not stored,
  not part of the history hand-off) and the in-memory blob is freed when it scrolls off,
  on `/clear`, or when you leave.
- **Emoji reactions**, **reply / quote**, **slash commands** (`/nick /me /who /clear
  /help /shrug`), and a searchable **emoji picker** with recents.
- **Unique display names per room** — case-insensitive; a taken name is blocked at the
  join screen (and `/nick` refuses it). If a duplicate ever slips through (a rare race),
  the later peer gets a **forced-rename popup** and must pick a free name to keep
  chatting — no silent auto-numbering. Best-effort (no server; deliberate spoofing still
  shows the `#id` fingerprint badge).
- **Per-user mute** (session-only), **idle/away presence**,
  **typing indicators**, **timestamps + time-gap dividers**, and a **scroll-to-latest** /
  **unread tab badge**.
- **Light / dark / system theme**, **safe-view blur**, **who's-online** list, community
  guidelines, connection + relay/latency panel, and an honest IP-exposure notice.
- Built for keyboards & screen readers: focus rings, focus-trapped mobile drawers,
  keyboard-navigable emoji grid, live regions, skip link, and forced-colors support.
- 3-column layout on desktop; slide-in drawers on mobile.
- **Security/abuse hardening:** transport-namespaced message ids (no silent
  suppression), sanitization of bidi/zero-width/control chars, per-channel flood
  limits, and reply/reaction/history that never trust claimed identity.

## Limitations (honest ones)

- History is **session-only**: a newcomer only sees history if *someone* is still in
  the room to hand it over. Once everyone leaves, the conversation is gone for good.
- WebRTC needs that one-time signaling via public relays; if every public relay were
  down at once, new connections couldn't form (existing P2P links keep working).
- Browsers cap simultaneous WebRTC connections, so this suits small/medium rooms, not
  thousands of concurrent peers in one mesh.
- **No server means no referee.** Two mechanisms trust the random per-session peer
  id ordering: name-collision resolution (higher id yields) and history-sender
  election (lowest id sends). A determined attacker could regenerate ids until
  they hold a very low one, letting them win name clashes or get elected to hand
  newcomers history. The hash-DAG cross-check (see *Verifiable hearsay*) means a
  forged history is only believed if **every** other connection present colludes (or
  nobody else is there to vouch — the room tells you which). Note the word
  *connection*: peer ids are free, so one person running several tabs counts as
  several "independent" witnesses — treat the confirmation count as connections,
  not people. Self-impersonation is rejected, reply quotes and live messages never
  trust claimed identity, and the `#id` badge always exposes same-named peers.
- The **10 MB file cap is enforced on what gets kept/shown**, not on the wire: a
  hostile peer could still stream you junk bytes before the cap rejects it. Mute
  (or leave) cuts them off.
