// Build the published site: inline src/style.css + src/app.js + the Trystero
// vendor bundle into a single self-contained docs/index.html (and a docs/404.html
// that is the same app plus a 404 flag). No separate .js/.css/vendor files are
// published, so none can be opened by URL — only the page itself (which is the app).
import {readFileSync, writeFileSync, rmSync, existsSync} from 'node:fs'

const SRC = 'src', OUT = 'docs'
const read = f => readFileSync(`${SRC}/${f}`, 'utf8')

const template = read('index.template.html')
const css = read('style.css')
let vendor = read('vendor/trystero-nostr.bundle.js')
let app = read('app.js')

// 1) Turn the vendor's ESM `export{A as b,...}` into a globalThis bridge so the
//    app module can read it (keeps the two modules in separate scopes — no name
//    collisions with the app's own top-level identifiers).
let bridged = false
vendor = vendor.replace(/export\s*\{([^}]*)\}\s*;?/, (_, inner) => {
  bridged = true
  const fields = inner.split(',').map(s => s.trim()).filter(Boolean).map(tok => {
    const [local, exported] = tok.split(/\s+as\s+/).map(s => s.trim())
    return `${exported || local}:${local}`
  })
  return `globalThis.__T={${fields.join(',')}};`
})
if (!bridged) throw new Error('Could not find the vendor export{} to bridge')

// 2) Replace the app's vendor import with a read from the bridge.
const before = app
app = app.replace(
  /^[ \t]*import\s*\{[^}]*\}\s*from\s*['"][^'"]*vendor[^'"]*['"];?[ \t]*$/m,
  'const {joinRoom, selfId, getRelaySockets} = globalThis.__T;'
)
if (app === before) throw new Error('Could not find the app vendor import to replace')

// 3) Neutralise any literal </script> inside inlined JS so it can't close the tag.
const escJs = s => s.replace(/<\/(script)/gi, '<\\/$1')

const styleTag = `<style>\n${css}\n</style>`
const scriptTags =
  `<script type="module">\n${escJs(vendor)}\n</script>\n` +
  `  <script type="module">\n${escJs(app)}\n</script>`

// 3b) Tighten the CSP: connect-src lists exactly the relay origins from
//     CONFIG.relayUrls instead of a blanket `wss:` (TURN/WebRTC traffic is not
//     governed by connect-src, so turnConfig needs nothing here).
const relayMatch = app.match(/relayUrls:\s*\[([^\]]*)\]/)
if (!relayMatch) throw new Error('Could not find CONFIG.relayUrls to build the CSP connect-src')
const relayOrigins = [...relayMatch[1].matchAll(/'(wss:\/\/[^'/]+)\/?'/g)].map(m => m[1])
if (!relayOrigins.length) throw new Error('CONFIG.relayUrls yielded no wss:// origins for the CSP')

// Use function replacements so `$`-sequences inside the inlined code (common in
// minified JS) are NOT treated as special replacement patterns.
const html = template
  .replace('__CSP_CONNECT__', () => relayOrigins.join(' '))
  .replace('<!--INLINE_STYLE-->', () => styleTag)
  .replace('<!--INLINE_SCRIPT-->', () => scriptTags)

if (html.includes('__CSP_CONNECT__') || html.includes('<!--INLINE_STYLE-->') || html.includes('<!--INLINE_SCRIPT-->')) {
  throw new Error('Template placeholders were not replaced')
}

writeFileSync(`${OUT}/index.html`, html)
// The 404 copy is the same app plus a flag: it serves UNKNOWN paths, so the app
// must not trust location.pathname as its base directory there (see BASE in app.js).
const html404 = html.replace('<body>', '<body>\n<script>window.__C2C_404 = 1</script>')
if (html404 === html) throw new Error('Could not inject the 404 flag (no <body> found)')
writeFileSync(`${OUT}/404.html`, html404)

// 4) Make sure no separate runtime files linger in the published folder.
for (const stray of ['app.js', 'style.css', 'vendor']) {
  if (existsSync(`${OUT}/${stray}`)) rmSync(`${OUT}/${stray}`, {recursive: true, force: true})
}

const kb = n => (n / 1024).toFixed(1) + ' KB'
console.log(`built docs/index.html  (${kb(html.length)})`)
console.log(`built docs/404.html    (${kb(html404.length)})  [same app + 404 flag]`)
