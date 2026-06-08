// Build the published site: inline src/style.css + src/app.js + the Trystero
// vendor bundle into a single self-contained docs/index.html (and an identical
// docs/404.html). No separate .js/.css/vendor files are published, so none can be
// opened by URL — only the page itself (which is the app).
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

// Use function replacements so `$`-sequences inside the inlined code (common in
// minified JS) are NOT treated as special replacement patterns.
const html = template
  .replace('<!--INLINE_STYLE-->', () => styleTag)
  .replace('<!--INLINE_SCRIPT-->', () => scriptTags)

if (html.includes('<!--INLINE_STYLE-->') || html.includes('<!--INLINE_SCRIPT-->')) {
  throw new Error('Template placeholders were not replaced')
}

writeFileSync(`${OUT}/index.html`, html)
writeFileSync(`${OUT}/404.html`, html)   // any unknown path serves the same app

// 4) Make sure no separate runtime files linger in the published folder.
for (const stray of ['app.js', 'style.css', 'vendor']) {
  if (existsSync(`${OUT}/${stray}`)) rmSync(`${OUT}/${stray}`, {recursive: true, force: true})
}

const kb = n => (n / 1024).toFixed(1) + ' KB'
console.log(`built docs/index.html  (${kb(html.length)})`)
console.log(`built docs/404.html    (${kb(html.length)})  [identical app]`)
