# 💬 chat-to-chat

A **live, ephemeral, peer-to-peer chat** that runs as a plain static website.

- **No backend.** No database, no server, no API of yours, no WebSocket server you run.
- **No history.** Messages are never stored anywhere. Open the page, talk to whoever is there *right now*, close the tab — gone.
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

The Trystero library is **vendored** into `vendor/trystero-nostr.bundle.js` (one self-contained file, no runtime CDN dependency).

---

## Project layout

```
index.html                      app shell + the "pick a name" gate
style.css                       dark, responsive UI
app.js                          all the logic (Trystero wiring + UI)
vendor/trystero-nostr.bundle.js bundled Trystero (Nostr strategy), self-contained
.nojekyll                       tells GitHub Pages to serve files as-is
```

---

## Run it locally

ES-module imports and WebRTC need to be served over `http(s)://` — opening `index.html`
as a `file://` won't work. From this folder:

```bash
python3 -m http.server 8080
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

2. On GitHub: **Settings → Pages → Build and deployment → Source: "Deploy from a branch"**, pick **`main`** and **`/ (root)`**, save.

3. After a minute your site is live at `https://<you>.github.io/<repo>/`.

### Custom domain (e.g. `chat-to-chat.com`)

1. In **Settings → Pages → Custom domain**, enter your domain and save (GitHub will
   commit a `CNAME` file for you).
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
add a **TURN** relay in `app.js` → `CONFIG.turnConfig`:

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

Everything tweakable lives in `CONFIG` at the top of `app.js`:

| Field        | What it does                                                              |
|--------------|--------------------------------------------------------------------------|
| `appId`      | Your app's namespace on the network. **Change it if you fork** this.      |
| `roomId`     | Defaults to `location.hostname` + path (one room per site).               |
| `turnConfig` | Optional TURN servers (see above).                                        |
| `maxNameLen` / `maxMsgLen` | Input length caps.                                          |

Want **separate rooms by URL** instead of one global room? Change `roomId` to read a
hash, e.g. `roomId: location.hash.slice(1) || 'lobby'`, and share links like
`yoursite.com/#team-standup`.

---

## Features

- Pick a nickname (no account, no password) — remembered locally for next time.
- Live messages, end-to-end encrypted, never stored.
- **Who's online** list + count.
- **Typing indicators**.
- **Message timestamps**.
- **Emoji picker**.
- Connection-status indicator and join/leave notices.
- Click your name (top-right) to rename yourself on the fly.

## Limitations (honest ones)

- It's **live-only**: if nobody else is in the room, there's no one to talk to, and
  there's no history to scroll. That's by design.
- WebRTC needs that one-time signaling via public relays; if every public relay were
  down at once, new connections couldn't form (existing P2P links keep working).
- Browsers cap simultaneous WebRTC connections, so this suits small/medium rooms, not
  thousands of concurrent peers in one mesh.
