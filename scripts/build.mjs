// Builds the profile README and its images from live data.
// No npm packages: Node's own fetch, fs and child_process only.
// Run: GITHUB_TOKEN=... node scripts/build.mjs

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const USER = 'p32929'
const STORE_REPO = 'p32929/p32929_openstore'
const STORE_APP = slug => `https://openstore.pfay.workers.dev/app/${USER}/${slug}`
const STORE_DEV = `https://openstore.pfay.workers.dev/dev/${USER}`
const ROOT = new URL('..', import.meta.url).pathname
const ASSETS = join(ROOT, 'assets')
const TOKEN = process.env.GITHUB_TOKEN
if (!TOKEN) throw new Error('GITHUB_TOKEN is not set')

// Repos that are not "work": templates, tests, examples, this profile.
const NOT_WORK = /p32929\.github\.io|openstore|boilerplate|example|test|counter|template|starter|^p32929$|^hire$|^\.github$|^\.gitignore$|portfolio|SomeHowTos|UniversityCodes|SimpleWidget/i
// Commits that are housekeeping, not real work.
const HOUSEKEEPING = /^(README|docs?[:(]|chore: refresh|Update README|Add files via upload$)/i

// ---------- data ----------

async function gql(query, variables = {}) {
  const res = await fetch('https://api.github.com/graphql', { signal: AbortSignal.timeout(60000),
    method: 'POST',
    headers: { Authorization: `bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  })
  const body = await res.text()
  if (!res.ok) throw new Error(`GitHub GraphQL ${res.status}: ${body.slice(0, 200)}`)
  const json = JSON.parse(body)
  if (json.errors) throw new Error(JSON.stringify(json.errors))
  return json.data
}
// GitHub's GraphQL sometimes answers 502 on big queries: try a few times.
async function gqlRetry(query, variables) {
  for (let i = 0; ; i++) {
    try { return await gql(query, variables) } catch (e) { if (i >= 3) throw e; await new Promise(r => setTimeout(r, 3000 * (i + 1))) }
  }
}

async function github() {
  const repos = []
  let after = null, user
  do {
    const d = await gqlRetry(`query($after: String) { user(login: "${USER}") {
      followers { totalCount }
      all: repositories(privacy: PUBLIC, ownerAffiliations: OWNER) { totalCount }
      repositories(first: 40, after: $after, privacy: PUBLIC, ownerAffiliations: OWNER, isFork: false) {
        pageInfo { hasNextPage endCursor }
        nodes { name description url stargazerCount isArchived pushedAt
          primaryLanguage { name color }
          latestRelease { tagName publishedAt url }
          defaultBranchRef { target { ... on Commit { history(first: 10) { nodes { committedDate messageHeadline } } } } }
        } } } }`, { after })
    user = d.user
    repos.push(...user.repositories.nodes)
    after = user.repositories.pageInfo.hasNextPage ? user.repositories.pageInfo.endCursor : null
  } while (after)
  for (const r of repos) {
    const real = (r.defaultBranchRef?.target?.history?.nodes ?? []).find(c => !HOUSEKEEPING.test(c.messageHeadline))
    r.workedAt = real ? real.committedDate : null
  }
  return { followers: user.followers.totalCount, publicRepos: user.all.totalCount, repos }
}

// Languages over all own non-fork repos, public and private (counts only).
// The daily Action's token only sees public repos, so counts made with a token
// that can see private ones are kept in languages.json and reused then.
// ponytail: cache refreshes only on a local run; add a PAT secret if it should refresh daily.
async function languages() {
  const counts = {}
  let after = null, sawPrivate = false
  do {
    const d = await gqlRetry(`query($after: String) { user(login: "${USER}") {
      repositories(first: 100, after: $after, ownerAffiliations: OWNER, isFork: false) {
        pageInfo { hasNextPage endCursor }
        nodes { isPrivate primaryLanguage { name color } } } } }`, { after })
    const r = d.user.repositories
    for (const n of r.nodes) {
      if (n.isPrivate) sawPrivate = true
      if (n.primaryLanguage) (counts[n.primaryLanguage.name] ??= { name: n.primaryLanguage.name, color: n.primaryLanguage.color ?? '#888', n: 0 }).n++
    }
    after = r.pageInfo.hasNextPage ? r.pageInfo.endCursor : null
  } while (after)
  const file = join(ROOT, 'languages.json')
  const list = Object.values(counts).sort((a, b) => b.n - a.n)
  if (sawPrivate) { writeFileSync(file, JSON.stringify(list, null, 2) + '\n'); return list }
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : list
}

// Who is on OpenStore, and how many apps they list together.

// Minimal front matter reader: the keys we need from an OpenStore listing.
function listing(text) {
  const fm = text.split(/^---$/m)[1] ?? ''
  const get = k => (fm.match(new RegExp(`^${k}:\\s*(.+)$`, 'm')) ?? [])[1]?.trim() ?? ''
  const platforms = {}
  const block = fm.split(/^platforms:\s*$/m)[1] ?? ''
  for (const m of block.matchAll(/^  ([A-Za-z]+):\s*(\S*)/gm)) platforms[m[1]] = m[2]
  return { title: get('title'), summary: get('summary'), icon: get('icon'), source: get('source'), platforms }
}

function openstore() {
  const dir = mkdtempSync(join(tmpdir(), 'openstore-'))
  try {
    // Only the apps/ folder is checked out: the screenshots would make this take minutes.
    execFileSync('git', ['clone', '-q', '--filter=blob:none', '--sparse', `https://github.com/${STORE_REPO}.git`, dir])
    execFileSync('git', ['-C', dir, 'sparse-checkout', 'set', 'apps'])
    // When was each listing added (or renamed into place)? Newest first.
    const log = execFileSync('git', ['-C', dir, 'log', '--diff-filter=AR', '--name-status', '--format=@%ct', '--', 'apps'], { encoding: 'utf8' })
    const added = {}
    let t = 0, order = 0
    for (const line of log.split('\n')) {
      if (line.startsWith('@')) { t = Number(line.slice(1)); continue }
      const path = line.split('\t').pop()
      const slug = path?.match(/^apps\/(.+)\.md$/)?.[1]
      if (slug && !(slug in added)) added[slug] = [t, order++]
    }
    const apps = []
    for (const f of readdirSync(join(dir, 'apps')).filter(f => f.endsWith('.md'))) {
      const slug = f.slice(0, -3)
      const l = listing(readFileSync(join(dir, 'apps', f), 'utf8'))
      const [time, ord] = added[slug] ?? [0, 1e9]
      apps.push({ slug, ...l, time, ord })
    }
    // Newest first; within one commit, keep git's order.
    return apps.sort((a, b) => b.time - a.time || a.ord - b.ord)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// Small PNG of an icon, made by wsrv.nl at build time, embedded as base64
// (GitHub does not load outside images inside an SVG).
const iconCache = {}
const DISK = process.env.ICON_CACHE // local testing only: keep icons on disk between runs
async function iconData(icon) {
  if (icon in iconCache) return iconCache[icon]
  const diskFile = DISK && join(DISK, Buffer.from(icon).toString('base64url'))
  if (diskFile && existsSync(diskFile)) return (iconCache[icon] = readFileSync(diskFile, 'utf8') || null)
  const raw = /^https?:/.test(icon) ? icon.replace(/^https?:\/\//, '') : `raw.githubusercontent.com/${STORE_REPO}/main/${icon}`
  let data = null
  for (const url of [`https://wsrv.nl/?url=${raw}&w=128&h=128&fit=contain&output=png`, `https://${raw}`]) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30000) })
      if (!res.ok) continue
      const type = res.headers.get('content-type') ?? 'image/png'
      data = `data:${type.split(';')[0]};base64,${Buffer.from(await res.arrayBuffer()).toString('base64')}`
      break
    } catch {}
  }
  if (diskFile) { mkdirSync(DISK, { recursive: true }); writeFileSync(diskFile, data ?? '') }
  return (iconCache[icon] = data)
}

// ---------- drawing ----------

const SANS = "system-ui,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif"
const MONO = "ui-monospace,SFMono-Regular,Menlo,Consolas,'Liberation Mono',monospace"
const THEMES = {
  light: { ink: '#1c1917', mute: '#78716c', panel: '#fafaf9', chrome: '#f3f2f1', line: '#e7e5e4', dot: '#d6d3d1', acc: '#1d4ed8', accSoft: '#dbeafe' },
  dark: { ink: '#e6edf3', mute: '#8b949e', panel: '#161b22', chrome: '#1c2128', line: '#30363d', dot: '#484f58', acc: '#58a6ff', accSoft: '#0c2d6b' },
}
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const charW = size => size * 0.602 // monospace advance width

function fit(s, size, maxW) {
  const n = Math.floor(maxW / charW(size))
  return s.length <= n ? s : s.slice(0, Math.max(1, n - 1)).trimEnd() + '…'
}
function wrap(s, size, maxW, lines) {
  const n = Math.floor(maxW / charW(size)), out = []
  let cur = ''
  for (const w of String(s).split(/\s+/).filter(Boolean)) {
    const next = cur ? `${cur} ${w}` : w
    if (next.length > n && cur) { out.push(cur); cur = w } else cur = next
  }
  if (cur) out.push(cur)
  if (out.length > lines) { out.length = lines; out[lines - 1] = fit(out[lines - 1] + ' …', size, maxW) }
  return out.map(l => fit(l, size, maxW))
}
const text = (x, y, s, { size = 14, weight = 400, fill, family = MONO, anchor = 'start' }) =>
  `<text x="${x}" y="${y}" font-family="${family}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}">${esc(s)}</text>`
const rect = (x, y, w, h, r, fill, stroke) =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${fill}"${stroke ? ` stroke="${stroke}" stroke-width="1"` : ''}/>`
let clipId = 0
function image(data, x, y, s) {
  if (!data) return ''
  const id = `c${++clipId}`
  return `<clipPath id="${id}"><rect x="${x}" y="${y}" width="${s}" height="${s}" rx="${s * 0.22}"/></clipPath>` +
    `<image href="${data}" x="${x}" y="${y}" width="${s}" height="${s}" clip-path="url(#${id})" preserveAspectRatio="xMidYMid meet"/>`
}
const svg = (w, h, body) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${body}</svg>`

// A plain rounded box (no window bar). Callers draw as if a 32px bar sat on top,
// so the body is shifted up by that much.
const BAR = 32
function win(t, w, h, title, body) {
  return svg(w, h - BAR, rect(0.5, 0.5, w - 1, h - BAR - 1, 10, t.panel, t.line) + `<g transform="translate(0,-${BAR})">${body}</g>`)
}
const prompt = (t, x, y, cmd, size = 15) =>
  text(x, y, '$', { size, weight: 700, fill: t.acc }) + text(x + charW(size) * 2, y, cmd, { size, weight: 500, fill: t.ink })

function hero(t, d) {
  const W = 880, b = []
  b.push(prompt(t, 28, 70, 'whoami'))
  b.push(text(28, 118, 'Fayaz Bin Salam', { size: 38, weight: 700, fill: t.ink }))
  b.push(text(28, 148, 'software engineer, building apps, tools and libraries people use', { size: 14, fill: t.mute }))
  b.push(prompt(t, 28, 196, 'ls ~/work'))
  // ls-style columns across the full width, same tab stop for every column
  WORK.forEach((w, i) => b.push(text(28 + (i % 5) * 166, 224 + Math.floor(i / 5) * 26, `${w}/`, { size: 15, weight: 600, fill: t.acc })))
  b.push(prompt(t, 28, 298, 'gh stats'))
  d.stats.forEach(([n, label], i) => {
    const x = 28 + i * 208
    b.push(text(x, 338, n, { size: 30, weight: 700, fill: t.ink }), text(x, 360, label, { size: 13, fill: t.mute }))
  })
  // Language bar and legend.
  const total = d.langs.reduce((s, l) => s + l.n, 0), gap = 4, usable = 824 - gap * (d.langs.length - 1)
  let x = 28
  for (const l of d.langs) {
    const w = usable * l.n / total
    b.push(rect(x.toFixed(1), 384, w.toFixed(1), 6, 3, l.color))
    x += w + gap
  }
  let lx = 28, ly = 416
  for (const l of d.langs) {
    const label = `${l.name.toLowerCase()} ${l.n}`, w = 13 + charW(12) * label.length
    if (lx + w > W - 28) { lx = 28; ly += 22 }
    b.push(`<circle cx="${lx + 4}" cy="${ly - 4}" r="4" fill="${l.color}"/>`, text(lx + 13, ly, label, { size: 12, fill: t.mute }))
    lx += w + 18
  }
  return win(t, W, ly + 26, `~/${USER}`, b.join(''))
}

// Cards sit side by side with no space between images (align=top), so each card
// carries its own gap: GAP/2 on the left and right, GAP below. Rows and columns
// then end up exactly GAP apart.
const GAP = 14
const WORK = ['android', 'ios', 'web', 'windows', 'macos', 'linux', 'cli', 'automation', 'extensions', 'plugins']
function cell(card) {
  const [, w, h] = card.match(/^<svg[^>]*width="([\d.]+)" height="([\d.]+)"/)
  const W = +w + GAP, H = +h + GAP
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><g transform="translate(${GAP / 2},0)">${card.replace(/^<svg[^>]*>/, '').replace(/<\/svg>$/, '')}</g></svg>`
}
const ROW = 880 + GAP // a full row of cells, in the same units as the cards

// Section heading: a prompt line on its own.
const heading = (t, cmd) => svg(880, 40, prompt(t, 4, 26, cmd, 16))

// A short tag for the best selling point.
function pill(t, xRight, y, label) {
  const w = charW(11.5) * label.length + 16
  return { w, svg: rect(xRight - w, y, w, 20, 10, t.accSoft) + text(xRight - w + 8, y + 14, label, { size: 11.5, weight: 600, fill: t.acc }) }
}

// Monogram when there is no app icon.
const mono = (t, s, x, y, size) =>
  rect(x, y, size, size, size * 0.22, t.accSoft) +
  text(x + size / 2, y + size * 0.66, s.charAt(0).toUpperCase(), { size: size * 0.5, weight: 700, fill: t.acc, anchor: 'middle' })

async function favCard(t, f) {
  const W = ROW / 2 - GAP, H = 92
  const p = pill(t, W - 18, 18, f.pill)
  const lines = wrap(f.summary, 12.5, W - 106, 2)
  return svg(W, H,
    rect(0.5, 0.5, W - 1, H - 1, 10, t.panel, t.line) +
    image(await iconData(f.icon), 18, 20, 52) + p.svg +
    text(86, 34, fit(f.title, 15, W - 106 - p.w - 8), { size: 15, weight: 700, fill: t.ink }) +
    lines.map((l, i) => text(86, 58 + i * 18, l, { size: 12.5, fill: t.mute })).join(''))
}

const ago = iso => {
  const days = Math.floor((Date.now() - Date.parse(iso)) / 864e5)
  return days <= 0 ? 'today' : days === 1 ? 'yesterday' : days < 30 ? `${days} days ago` : days < 365 ? `${Math.floor(days / 30)} months ago` : `${Math.floor(days / 365)} years ago`
}
const date = iso => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
const shortAgo = iso => ago(iso).replace(/ days ago$/, 'd ago').replace(/ months ago$/, 'mo ago').replace(/ years ago$/, 'y ago')

// A small linked card: title bar, bold name, one line, an arrow button.
function linkCard(t, W, title, name, line) {
  const H = 100
  return win(t, W, H, title,
    text(20, 62, fit(name, 15, W - 96), { size: 15, weight: 700, fill: t.ink }) +
    text(20, 84, fit(line, 12, W - 96), { size: 12, fill: t.mute }) +
    rect(W - 64, 52, 44, 30, 8, t.acc) +
    `<path d="M${W - 50} 67h16m-6-6 6 6-6 6" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>`)
}

function joinPanel(t) {
  const W = 880, H = 132 + BAR, b = []
  b.push(text(28, 70, 'Put your own apps on OpenStore', { size: 16, weight: 700, fill: t.ink }))
  b.push(text(28, 92, 'free, your listing lives in your own repo. just 4 simple steps:', { size: 12.5, fill: t.mute }))
  const steps = ['copy the template', 'add one .md per app', 'run node validate.mjs', 'open one pull request']
  steps.forEach((s, i) => {
    const x = 28 + (i % 2) * 280, y = 124 + Math.floor(i / 2) * 26
    b.push(text(x, y, `[${i + 1}]`, { size: 13.5, weight: 700, fill: t.acc }), text(x + 38, y, s, { size: 13.5, fill: t.ink }))
  })
  const bw = 210, bx = W - 28 - bw, by = BAR + (H - BAR) / 2 - 24
  b.push(rect(bx, by, bw, 48, 10, t.acc),
    text(bx + 22, by + 30, 'read the guide', { size: 15, weight: 700, fill: t.panel }),
    `<path d="M${bx + bw - 44} ${by + 24}h18m-7-7 7 7-7 7" fill="none" stroke="${t.panel}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>`)
  return win(t, W, H, '~/openstore', b.join(''))
}

// tree ~/apps: one panel built from strips, so every icon can be its own link.
// The pieces line up because they are placed with align=top and no gaps.
const TREE = { label: 232, slot: 81, slots: 8, rowH: 62 }
// Window top and bottom as strips of any width (sides drawn by each row strip).
function stripTop(t, W, title, H = 18) {
  return svg(W, H,
    `<path d="M0.5 ${H}V10.5a10 10 0 0 1 10-10h${W - 21}a10 10 0 0 1 10 10V${H}z" fill="${t.panel}"/>` +
    `<path d="M0.5 ${H}V10.5a10 10 0 0 1 10-10h${W - 21}a10 10 0 0 1 10 10V${H}" fill="none" stroke="${t.line}"/>`)
}
function stripBottom(t, W, H = 16, body = '') {
  return svg(W, H, `<path d="M0.5 0V${H - 10.5}a10 10 0 0 0 10 10h${W - 21}a10 10 0 0 0 10-10V0" fill="${t.panel}" stroke="${t.line}"/>` + body)
}
// A body strip: panel colour, left and/or right border.
const strip = (t, W, H, body, left = true, right = true) =>
  svg(W, H, rect(0, 0, W, H, 0, t.panel) + (left ? rect(0, 0, 1, H, 0, t.line) : '') + (right ? rect(W - 1, 0, 1, H, 0, t.line) : '') + body)

const TX = 34 // x of the tree trunk
function treeTop(t) {
  const W = 880, H = 40
  return svg(W, H, stripTop(t, W, '~/apps', H).replace(/^<svg[^>]*>|<\/svg>$/g, '') +
    text(TX - 6, 30, '~/apps', { size: 14, weight: 700, fill: t.ink }) + rect(TX, 34, 1.5, H - 34, 0, t.dot))
}
function treeLabel(t, kind, last) {
  const { label: W, rowH: H } = TREE, mid = H / 2
  const name = `${kind}/`
  return strip(t, W, H,
    rect(TX, 0, 1.5, last ? mid : H, 0, t.dot) + rect(TX, mid - 0.75, 18, 1.5, 0, t.dot) +
    text(TX + 26, mid + 5, name, { size: 14, weight: 700, fill: t.acc }) +
    // a faint dotted leader from the folder name to its icons
    `<path d="M${(TX + 26 + charW(14) * name.length + 10).toFixed(1)} ${mid}H${W - 10}" stroke="${t.dot}" stroke-width="1.5" stroke-dasharray="1.5 5" stroke-linecap="round"/>`, true, false)
}
// One icon on a soft tile, so icons of different styles look like one set.
// The last slot becomes a "+N" chip when a folder has more apps than fit.
async function treeSlot(t, a, isLast, more = 0) {
  const { slot: W, rowH: H } = TREE, tile = 50, s = 36
  const tx = (W - tile) / 2, ty = (H - tile) / 2
  let body = ''
  if (more > 0) {
    body = rect(tx, ty, tile, tile, 13, t.accSoft) + text(W / 2, H / 2 + 5, `+${more}`, { size: 14, weight: 700, fill: t.acc, anchor: 'middle' })
  } else if (a) {
    const data = await iconData(a.icon)
    body = rect(tx + 0.5, ty + 0.5, tile - 1, tile - 1, 13, t.chrome, t.line) +
      (data ? image(data, (W - s) / 2, (H - s) / 2, s) : mono(t, a.title, (W - s) / 2, (H - s) / 2, s))
  }
  return strip(t, W, H, body, false, isLast)
}
const treeBottom = t => stripBottom(t, 880, 18)

// ---------- what's new: three layouts ----------

// Badge colours per kind of news.
const KINDS = {
  light: { new: ['#1a7f37', '#dafbe1'], release: ['#1d4ed8', '#dbeafe'], wip: ['#9a6700', '#fff8c5'] },
  dark: { new: ['#3fb950', '#0f2e1a'], release: ['#58a6ff', '#0c2d6b'], wip: ['#d29922', '#3b2a05'] },
}
const KIND_LABEL = { new: 'new', release: 'release', wip: 'wip' }
function badge(t, mode, kind, x, y, w) {
  const [fg, bg] = KINDS[mode][kind]
  return rect(x, y, w, 20, 5, bg) + text(x + w / 2, y + 14, KIND_LABEL[kind], { size: 11.5, weight: 700, fill: fg, anchor: 'middle' })
}
const short = iso => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })
async function icon(t, item, x, y, s) {
  const data = item.icon ? await iconData(item.icon) : null
  return data ? image(data, x, y, s) : mono(t, item.name, x, y, s)
}

// What's new as a timeline: a line with a dot per item, newest first.
const WN_C = { row: 66, lineX: 118 }
async function wnRowC(t, mode, it, i, n) {
  const W = 880, H = WN_C.row, mid = H / 2, X = WN_C.lineX
  const [fg] = KINDS[mode][it.kind]
  const bw = charW(11.5) * KIND_LABEL[it.kind].length + 18
  const name = fit(it.name, 14, 260), nw = charW(14) * name.length
  const rw = charW(12) * it.right.length
  return strip(t, W, H,
    rect(X, i === 0 ? mid : 0, 1.5, i === 0 && i === n - 1 ? 0 : i === n - 1 ? mid : i === 0 ? H - mid : H, 0, t.dot) +
    `<circle cx="${X + 0.75}" cy="${mid}" r="7" fill="${t.panel}" stroke="${fg}" stroke-width="2.5"/>` +
    `<circle cx="${X + 0.75}" cy="${mid}" r="3" fill="${fg}"/>` +
    text(28, mid - 2, short(it.when), { size: 13, weight: 700, fill: t.ink }) +
    text(28, mid + 15, new Date(it.when).getUTCFullYear(), { size: 11.5, fill: t.mute }) +
    await icon(t, it, X + 26, mid - 19, 38) +
    text(X + 78, mid - 3, name, { size: 14, weight: 700, fill: t.ink }) +
    badge(t, mode, it.kind, X + 78 + nw + 10, mid - 17.5, bw) +
    text(X + 78, mid + 16, fit(it.sub, 12.5, W - 28 - rw - 16 - X - 78), { size: 12.5, fill: t.mute }) +
    text(W - 28, mid + 5, it.right, { size: 12, weight: it.kind === 'release' ? 700 : 400, fill: it.kind === 'release' ? KINDS[mode].release[0] : t.mute, anchor: 'end' }))
}


// ---------- page ----------

const KIND = { Android: 'android', iOS: 'ios', Web: 'web', Windows: 'desktop', MacOS: 'desktop', Linux: 'desktop', CLI: 'cli', Automation: 'automation', Library: 'libraries', Extension: 'extensions' }
const ORDER = ['android', 'ios', 'web', 'desktop', 'cli', 'automation', 'extensions', 'plugins']
// An Extension listing that calls itself a plugin (Obsidian and the like) goes under plugins/.
const kindsOf = a => new Set(Object.keys(a.platforms).map(p => p === 'Extension' && /plugin/i.test(`${a.title} ${a.summary}`) ? 'plugins' : KIND[p]).filter(Boolean))
// Selling points we have checked; anything else shows where it runs.
const PILLS = { rotato: 'zero deps', opencc: 'zero deps', hopper: 'zero deps', HeartCode: 'zero deps', cccsss: 'zero deps', lantern: 'self-hosted', ghcdn: 'self-hosted', notes: 'offline', roxaruu: 'keyboard-first', oaifai: 'ubuntu server' }
function platformPill(a) {
  const keys = Object.keys(a.platforms), kinds = [...new Set(keys.map(p => KIND[p]).filter(Boolean))]
  if (kinds.length >= 3) return 'cross-platform'
  if (keys.length === 1 && keys[0] === 'MacOS') return 'macOS'
  return kinds.join(' · ')
}
const OPENSTORE_FAV = { title: 'OpenStore', summary: 'The open app store where your listing lives in your own repo. No fees, no review queue.', icon: 'https://openstore.pfay.workers.dev/favicon.svg', href: 'https://openstore.pfay.workers.dev', pill: 'free' }
const bySource = (apps, repo) => apps.find(a => a.source.replace(/\/$/, '').toLowerCase() === `https://github.com/${USER}/${repo}`.toLowerCase())
const available = a => !Object.values(a.platforms).some(u => u.includes('unavailable'))

// [file name, window title, label, line, link]
// Footer: share and support, drawn like the other cards.
const FOOTER = [
  ['share', '', 'share my profile', 'facebook, x, linkedin, whatsapp and more', 'https://p32929.github.io/share/'],
  ['support', '', 'support my work', 'if you like my work, feel free. thank you!', 'https://p32929.github.io/support/'],
]
const LINKS = [
  ['portfolio', '~/portfolio', 'portfolio', 'everything I have built', 'https://p32929.github.io/'],
  ['openstore', '~/openstore', 'openstore', 'download my apps', STORE_DEV],
]

async function main() {
  const [gh, apps] = [await github(), openstore()]
  const own = gh.repos.filter(r => !r.isArchived)

  const data = {
    stats: [
      [String(own.reduce((s, r) => s + r.stargazerCount, 0)), 'stars'],
      [String(gh.publicRepos), 'public repos'],
      [String(gh.followers), 'followers'],
      [String(apps.length), 'apps on OpenStore'],
    ],
    langs: await languages(),
  }
  const latest = apps.filter(a => available(a) && Object.keys(a.platforms).some(p => p !== 'Library')).slice(0, 4)
  const work = own.filter(r => r.workedAt && r.description && !NOT_WORK.test(r.name))
    .sort((a, b) => Date.parse(b.workedAt) - Date.parse(a.workedAt)).slice(0, 3)
  const releases = own.filter(r => r.latestRelease && !NOT_WORK.test(r.name))
    .sort((a, b) => Date.parse(b.latestRelease.publishedAt) - Date.parse(a.latestRelease.publishedAt)).slice(0, 3)
  const favRepos = existsSync(join(ROOT, 'favourites.json')) ? JSON.parse(readFileSync(join(ROOT, 'favourites.json'), 'utf8')) : []
  const favs = favRepos.map(repo => {
    if (repo === 'p32929_openstore') return { repo, ...OPENSTORE_FAV }
    const a = bySource(apps, repo)
    if (!a) { console.warn(`favourite ${repo} is not on OpenStore, skipped`); return null }
    return { repo, title: a.title, summary: a.summary, icon: a.icon, href: STORE_APP(a.slug), pill: PILLS[repo] ?? platformPill(a) }
  }).filter(Boolean).sort((x, y) => x.title.localeCompare(y.title, 'en', { sensitivity: 'base', numeric: true }))
  const newApps = latest.slice(0, 3)
  const featured = existsSync(join(ROOT, 'featured.json')) ? JSON.parse(readFileSync(join(ROOT, 'featured.json'), 'utf8')) : {}
  const groups = {}
  for (const kind of ORDER) {
    const pinned = (featured[kind] ?? []).map(s => apps.find(a => a.slug === s)).filter(Boolean)
    const rest = apps.filter(a => available(a) && kindsOf(a).has(kind) && !pinned.includes(a))
    const all = [...pinned, ...rest]
    if (all.length) groups[kind] = { n: all.length, list: all }
  }

  // Everything new in one timeline, newest first.
  const iconOfRepo = repo => bySource(apps, repo)?.icon
  const news = {
    new: newApps.map(a => ({ kind: 'new', icon: a.icon, name: a.title, sub: a.summary, when: new Date(a.time * 1000).toISOString(), right: shortAgo(new Date(a.time * 1000).toISOString()), href: STORE_APP(a.slug) })),
    release: releases.map(r => ({ kind: 'release', icon: iconOfRepo(r.name), name: r.name, sub: r.description ?? '', when: r.latestRelease.publishedAt, right: fit(r.latestRelease.tagName, 12, 90), href: r.latestRelease.url })),
    wip: work.map(r => ({ kind: 'wip', icon: iconOfRepo(r.name), name: r.name, sub: r.description ?? '', when: r.workedAt, right: shortAgo(r.workedAt), href: r.url })),
  }
  // A repo with a new release is not listed again as "working on" in the mixed lists.
  const released = new Set(news.release.map(r => r.name))
  const allNews = [...news.new, ...news.release, ...news.wip.filter(w => !released.has(w.name))].sort((a, b) => Date.parse(b.when) - Date.parse(a.when))
  const timeline = allNews.slice(0, 6)

  rmSync(ASSETS, { recursive: true, force: true })
  mkdirSync(join(ASSETS, 'icons'), { recursive: true })
  const write = (name, content) => writeFileSync(join(ASSETS, name), content)
  for (const [mode, t] of Object.entries(THEMES)) {
    clipId = 0
    write(`hero-${mode}.svg`, hero(t, data))
    write(`h-fav-${mode}.svg`, heading(t, 'ls ~/favourites'))
    write(`h-new-${mode}.svg`, heading(t, 'whatsnew'))
    write(`h-build-${mode}.svg`, heading(t, 'tree ~/apps'))
    for (const [name, title, label, line] of [...LINKS, ...FOOTER]) write(`link-${name}-${mode}.svg`, cell(linkCard(t, ROW / 2 - GAP, title, label, line)))
    write(`h-links-${mode}.svg`, heading(t, 'ls ~/links'))
    write(`h-join-${mode}.svg`, heading(t, 'openstore join'))
    write(`join-${mode}.svg`, joinPanel(t))
    for (const f of favs) write(`fav-${f.repo}-${mode}.svg`, cell(await favCard(t, f)))
    write(`tree-top-${mode}.svg`, treeTop(t))
    const kinds = Object.keys(groups)
    write(`tree-bottom-${mode}.svg`, treeBottom(t))
    for (const [i, kind] of kinds.entries()) {
      const { n, list } = groups[kind]
      write(`tree-${kind}-${mode}.svg`, treeLabel(t, kind, i === kinds.length - 1))
      const more = n > TREE.slots ? n - (TREE.slots - 1) : 0
      for (let k = 0; k < TREE.slots; k++) write(`tree-${kind}-${k}-${mode}.svg`, await treeSlot(t, list[k], k === TREE.slots - 1, more && k === TREE.slots - 1 ? more : 0))
    }
      write(`wn-top-${mode}.svg`, stripTop(t, 880, '', 18))
      for (const [i, it] of timeline.entries()) write(`wn-${i}-${mode}.svg`, await wnRowC(t, mode, it, i, timeline.length))
      write(`wn-bottom-${mode}.svg`, stripBottom(t, 880, 18))
  }
  const pic = (name, alt, width, align = '') =>
    `<picture><source media="(prefers-color-scheme: dark)" srcset="assets/${name}-dark.svg"><img src="assets/${name}-light.svg" width="${width}"${align && ` align="${align}"`} alt="${esc(alt)}"></picture>`
  // Images placed edge to edge on one line, a new line every perRow.
  const tight = (items, perRow, make) => items.map((x, i) => make(x) + ((i + 1) % perRow === 0 && i < items.length - 1 ? '<br>' : '')).join('')
  const pct = (part, whole) => `${+(part / whole * 100).toFixed(4)}%`
  const link = (href, inner) => `<a href="${href}">${inner}</a>`
  const rows = (items, perRow, make) => {
    const out = []
    for (let i = 0; i < items.length; i += perRow) out.push(`<p>\n${items.slice(i, i + perRow).map(make).join('\n')}\n</p>`)
    return out.join('\n\n')
  }

  const kinds = Object.keys(groups)
  const full = (name, alt) => pic(name, alt, '100%', 'top')
  const whatsNewMd = () =>
    `<p>${full('wn-top', "What's new")}<br>${timeline.map((it, i) => link(it.href, full(`wn-${i}`, `${it.kind}: ${it.name}, ${it.sub}`))).join('<br>')}<br>${full('wn-bottom', '')}</p>`
  const treeRow = kind => `<a href="${STORE_DEV}">${pic(`tree-${kind}`, `${kind}`, pct(TREE.label, 880), 'top')}</a>` +
    Array.from({ length: TREE.slots }, (_, k) => {
      const { n, list } = groups[kind], chip = n > TREE.slots && k === TREE.slots - 1
      const a = list[k], img = pic(`tree-${kind}-${k}`, chip ? `${n - k} more ${kind} apps` : a ? a.title : '', pct(TREE.slot, 880), 'top')
      return chip ? `<a href="${STORE_DEV}">${img}</a>` : a ? `<a href="${STORE_APP(a.slug)}">${img}</a>` : img
    }).join('')
  const md = [
    '<!-- This file is made by scripts/build.mjs every day. Edit the script, not this file. -->',
    link('https://p32929.github.io/', pic('hero', 'Fayaz Bin Salam, software engineer', '100%')),
    link('https://p32929.github.io/', pic('h-links', 'Links', '100%')),
    `<p>${tight(LINKS, 2, ([n, , label, , href]) => link(href, pic(`link-${n}`, label, '50%', 'top')))}</p>`,
    link(STORE_DEV, pic('h-fav', 'My favourite projects', '100%')),
    `<p>${tight(favs, 2, f => link(f.href, pic(`fav-${f.repo}`, `${f.title}: ${f.summary}`, '50%', 'top')))}</p>`,
    link(STORE_DEV, pic('h-build', 'What I build', '100%')),
    `<p>${pic('tree-top', 'apps', '100%', 'top')}<br>${kinds.map(treeRow).join('<br>')}<br>${pic('tree-bottom', '', '100%', 'top')}</p>`,
    link(`https://github.com/${USER}?tab=repositories&sort=updated`, pic('h-new', "What's new", '100%')),
    whatsNewMd(),
    link('https://openstore.pfay.workers.dev/add', pic('h-join', 'Put your own apps on OpenStore', '100%')),
    link('https://openstore.pfay.workers.dev/add', pic('join', 'How to put your apps on OpenStore: 4 steps', '100%')),
    `<p>${tight(FOOTER, 2, ([n, , label, , href]) => link(href, pic(`link-${n}`, label, '50%', 'top')))}</p>`,
  ].join('\n\n') + '\n'
  writeFileSync(join(ROOT, 'README.md'), md)
  console.log(`favourites: ${favs.map(f => f.title).join(', ')}\nlatest: ${latest.map(a => a.slug).join(', ')}\nwork: ${work.map(r => r.name).join(', ')}\nreleases: ${releases.map(r => r.name).join(', ')}\ngroups: ${Object.entries(groups).map(([k, g]) => `${k}=${g.n}`).join(' ')}`)
}

await main()
