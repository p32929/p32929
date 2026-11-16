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
  const res = await fetch('https://api.github.com/graphql', {
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

// Minimal front matter reader: the keys we need from an OpenStore listing.
function listing(text) {
  const fm = text.split(/^---$/m)[1] ?? ''
  const get = k => (fm.match(new RegExp(`^${k}:\\s*(.+)$`, 'm')) ?? [])[1]?.trim() ?? ''
  const platforms = {}
  const block = fm.split(/^platforms:\s*$/m)[1] ?? ''
  for (const m of block.matchAll(/^  ([A-Za-z]+):\s*(\S*)/gm)) platforms[m[1]] = m[2]
  return { title: get('title'), summary: get('summary'), icon: get('icon'), platforms }
}

function openstore() {
  const dir = mkdtempSync(join(tmpdir(), 'openstore-'))
  try {
    execFileSync('git', ['clone', '-q', '--filter=blob:none', `https://github.com/${STORE_REPO}.git`, dir])
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
async function iconData(icon) {
  if (icon in iconCache) return iconCache[icon]
  const raw = `raw.githubusercontent.com/${STORE_REPO}/main/${icon}`
  let data = null
  for (const url of [`https://wsrv.nl/?url=${raw}&w=128&h=128&fit=contain&output=png`, `https://${raw}`]) {
    try {
      const res = await fetch(url)
      if (!res.ok) continue
      const type = res.headers.get('content-type') ?? 'image/png'
      data = `data:${type.split(';')[0]};base64,${Buffer.from(await res.arrayBuffer()).toString('base64')}`
      break
    } catch {}
  }
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

// A terminal window: title bar with three dots, then the body.
function win(t, w, h, title, body) {
  return svg(w, h,
    rect(0.5, 0.5, w - 1, h - 1, 10, t.panel, t.line) +
    `<path d="M0.5 10.5a10 10 0 0 1 10-10h${w - 21}a10 10 0 0 1 10 10V32.5H0.5z" fill="${t.chrome}"/>` +
    rect(0.5, 32, w - 1, 1, 0, t.line) +
    [0, 1, 2].map(i => `<circle cx="${18 + i * 16}" cy="17" r="5" fill="${t.dot}"/>`).join('') +
    text(w / 2, 21.5, fit(title, 12, w - 140), { size: 12, weight: 500, fill: t.mute, anchor: 'middle' }) + body)
}
const prompt = (t, x, y, cmd, size = 15) =>
  text(x, y, '$', { size, weight: 700, fill: t.acc }) + text(x + charW(size) * 2, y, cmd, { size, weight: 500, fill: t.ink })

function hero(t, d) {
  const W = 880, b = []
  b.push(prompt(t, 28, 70, 'whoami'))
  b.push(text(28, 118, 'Fayaz Bin Salam', { size: 38, weight: 700, fill: t.ink }))
  b.push(text(28, 148, 'software engineer, building apps, tools and libraries people use', { size: 14, fill: t.mute }))
  b.push(prompt(t, 28, 196, 'ls ~/work'))
  b.push(text(28, 224, 'android/  web/  desktop/  cli/  extensions/', { size: 15, weight: 600, fill: t.acc }))
  b.push(prompt(t, 28, 272, 'gh stats'))
  d.stats.forEach(([n, label], i) => {
    const x = 28 + i * 208
    b.push(text(x, 312, n, { size: 30, weight: 700, fill: t.ink }), text(x, 334, label, { size: 13, fill: t.mute }))
  })
  // Language bar and legend.
  const total = d.langs.reduce((s, l) => s + l.n, 0), gap = 4, usable = 824 - gap * (d.langs.length - 1)
  let x = 28
  for (const l of d.langs) {
    const w = usable * l.n / total
    b.push(rect(x.toFixed(1), 358, w.toFixed(1), 6, 3, l.color))
    x += w + gap
  }
  let lx = 28
  for (const l of d.langs) {
    const label = `${l.name.toLowerCase()} ${l.n}`
    b.push(`<circle cx="${lx + 4}" cy="386" r="4" fill="${l.color}"/>`, text(lx + 13, 390, label, { size: 12, fill: t.mute }))
    lx += 13 + charW(12) * label.length + 18
  }
  return win(t, W, 416, `~/${USER}`, b.join(''))
}

// Section heading: a prompt line on its own.
const heading = (t, cmd) => svg(880, 40, prompt(t, 4, 26, cmd, 16))

async function appCard(t, a) {
  const W = 430, H = 118
  const lines = wrap(a.summary, 12.5, W - 104, 2)
  return win(t, W, H, a.slug,
    image(await iconData(a.icon), 20, 48, 52) +
    text(88, 64, fit(a.title, 15, W - 104), { size: 15, weight: 700, fill: t.ink }) +
    lines.map((l, i) => text(88, 86 + i * 18, l, { size: 12.5, fill: t.mute })).join(''))
}

const ago = iso => {
  const days = Math.floor((Date.now() - Date.parse(iso)) / 864e5)
  return days <= 0 ? 'today' : days === 1 ? 'yesterday' : days < 30 ? `${days} days ago` : days < 365 ? `${Math.floor(days / 30)} months ago` : `${Math.floor(days / 365)} years ago`
}
const date = iso => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })

function repoCard(t, r) {
  const W = 282, H = 150
  const lines = wrap(r.description ?? '', 12, W - 40, 3)
  const lang = r.primaryLanguage
  return win(t, W, H, `~/${r.name}`,
    text(20, 60, fit(r.name, 15, W - 40), { size: 15, weight: 700, fill: t.ink }) +
    lines.map((l, i) => text(20, 82 + i * 17, l, { size: 12, fill: t.mute })).join('') +
    (lang ? `<circle cx="24" cy="134" r="4" fill="${lang.color ?? t.mute}"/>` + text(33, 138, fit(lang.name.toLowerCase(), 12, 90), { size: 12, fill: t.mute }) : '') +
    text(W - 20, 138, ago(r.workedAt), { size: 12, fill: t.mute, anchor: 'end' }))
}

function releaseCard(t, r) {
  const W = 282, H = 104
  const tag = fit(r.latestRelease.tagName, 13, 110), tagW = charW(13) * tag.length + 18
  return win(t, W, H, 'gh release view',
    text(20, 62, fit(r.name, 15, W - 40), { size: 15, weight: 700, fill: t.ink }) +
    rect(20, 74, tagW, 22, 11, t.accSoft) + text(29, 89.5, tag, { size: 13, weight: 700, fill: t.acc }) +
    text(W - 20, 89.5, date(r.latestRelease.publishedAt), { size: 12, fill: t.mute, anchor: 'end' }))
}

async function iconTile(a) {
  const data = await iconData(a.icon)
  return data ? svg(56, 56, image(data, 2, 2, 52)) : null
}

// ---------- page ----------

const KIND = { Android: 'android', iOS: 'ios', Web: 'web', Windows: 'desktop', MacOS: 'desktop', CLI: 'cli', Library: 'libraries', Extension: 'extensions' }
const ORDER = ['android', 'web', 'desktop', 'cli', 'extensions']
const available = a => !Object.values(a.platforms).some(u => u.includes('unavailable'))

async function main() {
  const [gh, apps] = [await github(), openstore()]
  const own = gh.repos.filter(r => !r.isArchived)

  const langCount = {}
  for (const r of own) if (r.primaryLanguage) (langCount[r.primaryLanguage.name] ??= { name: r.primaryLanguage.name, color: r.primaryLanguage.color ?? '#888', n: 0 }).n++
  const data = {
    stats: [
      [String(own.reduce((s, r) => s + r.stargazerCount, 0)), 'stars'],
      [String(gh.publicRepos), 'public repos'],
      [String(gh.followers), 'followers'],
      [String(apps.length), 'apps on OpenStore'],
    ],
    langs: Object.values(langCount).sort((a, b) => b.n - a.n).slice(0, 7),
  }
  const latest = apps.filter(a => available(a) && Object.keys(a.platforms).some(p => p !== 'Library')).slice(0, 4)
  const work = own.filter(r => r.workedAt && r.description && !NOT_WORK.test(r.name))
    .sort((a, b) => Date.parse(b.workedAt) - Date.parse(a.workedAt)).slice(0, 3)
  const releases = own.filter(r => r.latestRelease && !NOT_WORK.test(r.name))
    .sort((a, b) => Date.parse(b.latestRelease.publishedAt) - Date.parse(a.latestRelease.publishedAt)).slice(0, 3)
  const featured = existsSync(join(ROOT, 'featured.json')) ? JSON.parse(readFileSync(join(ROOT, 'featured.json'), 'utf8')) : {}
  const groups = {}
  for (const kind of ORDER) {
    const pinned = (featured[kind] ?? []).map(s => apps.find(a => a.slug === s)).filter(Boolean)
    const rest = apps.filter(a => available(a) && Object.keys(a.platforms).some(p => KIND[p] === kind) && !pinned.includes(a))
    const list = [...pinned, ...rest].slice(0, 6)
    if (list.length) groups[kind] = list
  }

  rmSync(ASSETS, { recursive: true, force: true })
  mkdirSync(join(ASSETS, 'icons'), { recursive: true })
  const write = (name, content) => writeFileSync(join(ASSETS, name), content)
  for (const [mode, t] of Object.entries(THEMES)) {
    clipId = 0
    write(`hero-${mode}.svg`, hero(t, data))
    write(`h-apps-${mode}.svg`, heading(t, `openstore latest --limit ${latest.length}`))
    write(`h-work-${mode}.svg`, heading(t, 'git log --recent'))
    write(`h-releases-${mode}.svg`, heading(t, 'gh release list'))
    write(`h-build-${mode}.svg`, heading(t, 'tree ~/apps'))
    for (const a of latest) write(`app-${a.slug}-${mode}.svg`, await appCard(t, a))
    for (const r of work) write(`repo-${r.name}-${mode}.svg`, repoCard(t, r))
    for (const r of releases) write(`release-${r.name}-${mode}.svg`, releaseCard(t, r))
  }
  const tiles = new Set()
  for (const list of Object.values(groups)) for (const a of list) {
    if (tiles.has(a.slug)) continue
    const tile = await iconTile(a)
    if (tile) { writeFileSync(join(ASSETS, 'icons', `${a.slug}.svg`), tile); tiles.add(a.slug) }
  }

  const pic = (name, alt, width) =>
    `<picture><source media="(prefers-color-scheme: dark)" srcset="assets/${name}-dark.svg"><img src="assets/${name}-light.svg" width="${width}" alt="${esc(alt)}"></picture>`
  const link = (href, inner) => `<a href="${href}">${inner}</a>`
  const rows = (items, perRow, make) => {
    const out = []
    for (let i = 0; i < items.length; i += perRow) out.push(`<p>\n${items.slice(i, i + perRow).map(make).join('\n')}\n</p>`)
    return out.join('\n\n')
  }

  const md = [
    '<!-- This file is made by scripts/build.mjs every day. Edit the script, not this file. -->',
    link('https://p32929.github.io/', pic('hero', 'Fayaz Bin Salam, software engineer', '100%')),
    `<p align="center"><a href="https://p32929.github.io/">Portfolio</a> · <a href="${STORE_DEV}">OpenStore</a> · <a href="https://gist.github.com/${USER}">Gists</a></p>`,
    link(STORE_DEV, pic('h-apps', 'Latest apps', '100%')),
    rows(latest, 2, a => link(STORE_APP(a.slug), pic(`app-${a.slug}`, `${a.title}: ${a.summary}`, '49%'))),
    link(`https://github.com/${USER}?tab=repositories&sort=updated`, pic('h-work', 'Recently working on', '100%')),
    rows(work, 3, r => link(r.url, pic(`repo-${r.name}`, `${r.name}: ${r.description}`, '32.5%'))),
    link(`https://github.com/${USER}?tab=repositories`, pic('h-releases', 'New releases', '100%')),
    rows(releases, 3, r => link(r.latestRelease.url, pic(`release-${r.name}`, `${r.name} ${r.latestRelease.tagName}`, '32.5%'))),
    link(STORE_DEV, pic('h-build', 'What I build', '100%')),
    Object.entries(groups).map(([kind, list]) =>
      `<p><code>${kind}/</code><br>\n${list.filter(a => tiles.has(a.slug)).map(a => link(STORE_APP(a.slug), `<img src="assets/icons/${a.slug}.svg" width="48" height="48" alt="${esc(a.title)}" title="${esc(a.title)}">`)).join('\n')}\n</p>`).join('\n\n'),
    '<p>\n<a href="https://p32929.github.io/share/"><img src="https://p32929.github.io/readme/share.svg" width="49%" alt="Share my profile"></a>\n<a href="https://p32929.github.io/support/"><img src="https://p32929.github.io/readme/support.svg" width="49%" alt="Support my work"></a>\n</p>',
  ].join('\n\n') + '\n'
  writeFileSync(join(ROOT, 'README.md'), md)
  console.log(`latest: ${latest.map(a => a.slug).join(', ')}\nwork: ${work.map(r => r.name).join(', ')}\nreleases: ${releases.map(r => r.name).join(', ')}\ngroups: ${Object.entries(groups).map(([k, l]) => `${k}=${l.length}`).join(' ')}`)
}

await main()
