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

The Trystero library is **vendored** into `docs/vendor/trystero-nostr.bundle.js` (one self-contained file, no runtime CDN dependency).

---

## Project layout

The site is published from **`docs/`** — only the runtime files live there, so repo
files like this README are never reachable on the live site.

```
docs/                            ← the published site (GitHub Pages source)
  index.html                     app shell + the "pick a name" gate
  style.css                      dark, responsive UI (3-column desktop, mobile-friendly)
  app.js                         all the logic (Trystero wiring + history hand-off + UI)
  404.html                       silently redirects any unknown URL back to the app
  CNAME                          custom-domain config
  .nojekyll                      serve files as-is
  vendor/trystero-nostr.bundle.js  bundled Trystero (Nostr strategy), self-contained
README.md  .gitignore            repo-only files (not served)
```

---

## Run it locally

ES-module imports and WebRTC need to be served over `http(s)://` — opening `index.html`
as a `file://` won't work. Serve the **`docs/`** folder:

```bash
cd docs && python3 -m http.server 8080
# then open http://localhost:8080
```

To see the chat in action locally, open it in **two browser windows/tabs** (or two
different browsers). They share the `localhost` room and will connect to each other.

---

## Deploy to GitHub Pages

1. Create a repo and push these files to it:

   ```bash
   git init
   git add .
   git commit -m "chat-to-chat: serverless p2p chat"
   git branch -M main
   git remote add origin https://github.com/<you>/<repo>.git
   git push -u origin main
   ```

2. On GitHub: **Settings → Pages → Build and deployment → Source: "Deploy from a branch"**, pick **`main`** and the **`/docs`** folder, save.

3. After a minute your site is live at `https://<you>.github.io/<repo>/`.

> Publishing from `/docs` is what keeps `README.md` and other repo files off the live
> site, and `docs/404.html` makes any unknown URL silently land on the app.

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

## Connectivity & TURN (optional)

Built-in STUN handles most networks. A small share of users behind strict/symmetric
NATs (some corporate or mobile networks) can't form a direct P2P link. To cover them,
add a **TURN** relay in `docs/app.js` → `CONFIG.turnConfig`:

```js
turnConfig: [
  {urls: 'turn:your-turn-host:3478', username: 'user', credential: 'pass'},
],
```

Free/cheap TURN options: [Cloudflare TURN](https://developers.cloudflare.com/calls/turn/)
(free tier) or [Open Relay](https://www.metered.ca/stun-turn). Traffic only flows
through TURN for peers that can't connect directly, and stays end-to-end encrypted.

---

## Customize

Everything tweakable lives in `CONFIG` at the top of `docs/app.js`:

| Field        | What it does                                                              |
|--------------|--------------------------------------------------------------------------|
| `appId`      | Your app's namespace on the network. **Change it if you fork** this.      |
| `roomId`     | Defaults to `location.hostname` + path (one room per site).               |
| `historyShare` | How many recent messages a newcomer is handed (default 30).            |
| `turnConfig` | Optional TURN servers (see above).                                        |
| `maxNameLen` / `maxMsgLen` | Input length caps.                                          |

Want **separate rooms by URL** instead of one global room? Change `roomId` to read a
hash, e.g. `roomId: location.hash.slice(1) || 'lobby'`, and share links like
`yoursite.com/#team-standup`.

---

## Features

- Pick a nickname (no account, no password) — remembered locally for next time.
- Live messages, end-to-end encrypted, never stored on disk.
- **Live history hand-off** — when you join, peers already in the room send you the
  last ~30 messages so you can catch up on the conversation.
- **Community guidelines** panel (left) + centered **"Global Free Speech"** banner.
- **Who's online** list + count (right).
- **Typing indicators**, **message timestamps**, **emoji picker**, and a
  **scroll-to-latest** button.
- Connection-status indicator and join/leave notices.
- 3-column layout on desktop; on mobile the side panels become slide-in drawers.

## Limitations (honest ones)

- History is **session-only**: a newcomer only sees history if *someone* is still in
  the room to hand it over. Once everyone leaves, the conversation is gone for good.
- WebRTC needs that one-time signaling via public relays; if every public relay were
  down at once, new connections couldn't form (existing P2P links keep working).
- Browsers cap simultaneous WebRTC connections, so this suits small/medium rooms, not
  thousands of concurrent peers in one mesh.
