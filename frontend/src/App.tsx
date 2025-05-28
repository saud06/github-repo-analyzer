import { useEffect, useMemo, useRef, useState, lazy, Suspense, type ChangeEvent } from 'react'
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer, BarChart, Bar, XAxis, YAxis, RadarChart, Radar, PolarGrid, PolarAngleAxis, PolarRadiusAxis } from 'recharts'
// Lazy-loaded heavy components
const ReadmeVisuals = lazy(() => import('./components/ReadmeVisuals'))
const ArchGraphView = lazy(() => import('./components/ArchGraphView'))

type Metadata = {
  full_name: string
  description?: string
  stars: number
  forks: number
  open_issues: number
  license?: string | null
  default_branch: string
  last_commit_sha?: string | null
  last_pushed_at?: string | null
  homepage?: string | null
  topics: string[]
}

type RepoSummary = {
  full_name: string
  description?: string | null
  stars: number
  language?: string | null
  html_url?: string | null
}

type StackDetect = {
  languages: string[]
  runtime: string[]
  frameworks: string[]
  packaging: string[]
  containers: string[]
  ci: string[]
  tests: string[]
}

type StaticAnalysis = {
  mi_avg?: number | null
  worst_files: { path: string; mi?: number | null; cc_avg?: number | null }[]
  flake8: { total?: number; by_code?: Record<string, number> }
  advice: string[]
  analyzed_commit?: string | null
  by_severity?: Record<string, number>
  coverage_pct?: number | null
  grade?: string | null
}

type Community = {
  contributing: boolean
  code_of_conduct: boolean
  security: boolean
  support: boolean
  funding: boolean
  codeowners: boolean
  issue_templates: boolean
  pr_template: boolean
  docs_dir: boolean
  discussions_enabled?: boolean | null
  score: number
  missing: string[]
}

type Security = {
  dependabot_config: boolean
  codeql_workflow: boolean
  branch_protection_enabled?: boolean | null
  risk_score: number
  findings: string[]
}

type ArchGraph = {
  nodes: { id: string; label: string; type: 'internal' | 'external' }[]
  edges: { source: string; target: string; weight: number }[]
  stats: { node_count: number; edge_count: number; internal_nodes: number; external_nodes: number }
}

type TechRadar = {
  languages: Record<string, number>
  runtime: Record<string, number>
  frameworks: Record<string, number>
  packaging: Record<string, number>
  containers: Record<string, number>
  ci: Record<string, number>
  tests: Record<string, number>
}

const API_BASE = (import.meta as any).env?.VITE_API_BASE?.replace(/\/$/, '') || 'http://localhost:8000'

function formatDateTime(ts?: string | null): string {
  if (!ts) return '—'
  const d = new Date(ts)
  if (isNaN(d.getTime())) return '—'
  const pad = (n: number) => n.toString().padStart(2, '0')
  const yyyy = d.getFullYear()
  const mm = pad(d.getMonth() + 1)
  const dd = pad(d.getDate())
  const hh = pad(d.getHours())
  const mi = pad(d.getMinutes())
  const ss = pad(d.getSeconds())
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}`
}

const IconBranch = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
    <path d="M3.5 2.75a1.75 1.75 0 1 1 1.5 1.723v5.057a3.25 3.25 0 0 0 3.25 3.25h2.0a1.25 1.25 0 1 1 0 2.5h-2a5.75 5.75 0 0 1-5.75-5.75V4.473A1.75 1.75 0 0 1 3.5 2.75Zm0 0a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8-1a1.75 1.75 0 1 1 0 3.5 1.75 1.75 0 0 1 0-3.5Z"/>
  </svg>
)

const IconFork = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
    <path d="M5 3.25a1.75 1.75 0 1 1-3.5 0 1.75 1.75 0 0 1 3.5 0Zm9.5 0a1.75 1.75 0 1 1-3.5 0 1.75 1.75 0 0 1 3.5 0ZM3.25 6h2.5c1.517 0 2.75 1.233 2.75 2.75v.25a2 2 0 0 0 2 2h1.25V9.75a1.75 1.75 0 1 1 1.5 0V11a2.5 2.5 0 0 1-2.5 2.5H10.5a3.5 3.5 0 0 1-3.5-3.5V8.75c0-.69-.56-1.25-1.25-1.25h-2.5V6Z"/>
  </svg>
)

function App() {
  const [repo, setRepo] = useState<string>('markedjs/marked')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>('')
  const [meta, setMeta] = useState<Metadata | null>(null)
  const [langs, setLangs] = useState<Record<string, number>>({})
  const [langDetail, setLangDetail] = useState<Record<string, {files: number; lines: number}>>({})
  
  const [readmeTree, setReadmeTree] = useState<any | null>(null)
  const [contributors, setContributors] = useState<{login: string, contributions: number, avatar_url?: string, profile_url?: string}[]>([])
  const [weekly, setWeekly] = useState<number[]>([])
  const [healthScore, setHealthScore] = useState<{score: number, level: string, reasons: string[]} | null>(null)
  const [sectionErrors, setSectionErrors] = useState<Record<string, string>>({})
  const [stack, setStack] = useState<StackDetect | null>(null)
  const [analysis, setAnalysis] = useState<StaticAnalysis | null>(null)
  const [hotspots, setHotspots] = useState<{ items: { path: string; changes: number; last_modified?: string | null; top_authors?: { login?: string | null; commits: number }[] }[] } | null>(null)
  const [community, setCommunity] = useState<any | null>(null)
  const [security, setSecurity] = useState<any | null>(null)
  const [arch, setArch] = useState<ArchGraph | null>(null)
  const [sectionMs, setSectionMs] = useState<Record<string, number>>({})
  const [autoDisabled, setAutoDisabled] = useState<Record<string, boolean>>({})
  const [archLang, setArchLang] = useState<'all'|'python'|'js'|'npm'|'go'|'java'|'csharp'|'php'|'ruby'>('all')
  const [hasAnalyzed, setHasAnalyzed] = useState(false)
  const [hotspotsCount, setHotspotsCount] = useState(5)
  const [contributorsCount, setContributorsCount] = useState(5)
  const [readmeCount, setReadmeCount] = useState(5)
  const [showRadar, setShowRadar] = useState(false)
  // Tech Radar state (multi-repo)
  const [radarRepos, setRadarRepos] = useState<string>('vercel/next.js, facebook/react, vitejs/vite, django/django, fastapi/fastapi')
  const [techRadar, setTechRadar] = useState<TechRadar | null>(null)
  const [loadingRadar, setLoadingRadar] = useState(false)
  const [radarError, setRadarError] = useState<string>('')
  const [radarSets, setRadarSets] = useState<Array<{ name: string; repos: string }>>([])
  const [newSetName, setNewSetName] = useState<string>('')
  // Loading flag for the slower languages detail (files/lines)
  const [loadingLangDetail, setLoadingLangDetail] = useState(false)
  const [related, setRelated] = useState<RepoSummary[] | null>(null)
  const [authorRepos, setAuthorRepos] = useState<RepoSummary[] | null>(null)
  const [reportOpts, setReportOpts] = useState<{[k:string]: boolean}>({
    summary: true,
    metadata: true,
    languages: true,
    readme: true,
    techstack: true,
    quality: true,
    contributors: true,
    activity: true,
    hotspots: false,
    community: true,
    security: true,
    architecture: false,
    related: true,
    author_repos: true,
  })
  const [perfMode, setPerfMode] = useState<'fast'|'thorough'>('fast')
  const prevReportOpts = useRef(reportOpts)

  useEffect(() => {
    // load report options
    try {
      const saved = localStorage.getItem('gra_report_opts')
      if (saved) {
        const obj = JSON.parse(saved)
        setReportOpts((prev) => ({ ...prev, ...obj }))
      }
      // Load Tech Radar sets and initial repos from localStorage or URL
      try {
        const setsJson = localStorage.getItem('gra_radar_sets')
        if (setsJson) setRadarSets(JSON.parse(setsJson) || [])
      } catch {}
      try {
        const storedRepos = localStorage.getItem('gra_radar_repos')
        if (storedRepos) setRadarRepos(storedRepos)
      } catch {}
      try {
        const url = new URL(window.location.href)
        const q = url.searchParams.get('radar')
        if (q) {
          // radar param: comma-separated owner/name list
          const dec = decodeURIComponent(q)
          if (dec.trim()) setRadarRepos(dec)
        }
      } catch {}
      // Optionally auto-disable historically slow sections on fresh start (no user prefs)
      if (!saved) {
        const msSaved = localStorage.getItem('gra_section_ms')
        if (msSaved) {
          const m = JSON.parse(msSaved || '{}')
          const next = { ...reportOpts }
          const SLOW_MS = 5000
          const autoMap: Record<string, boolean> = {}
          for (const [k, v] of Object.entries(m || {})) {
            if (typeof v === 'number' && v > SLOW_MS) {
              if (k !== 'metadata') next[k as keyof typeof next] = false as any
              if (k !== 'metadata') autoMap[k] = true
            }
          }
          setReportOpts(next)
          setAutoDisabled(autoMap)
        }
      }
      const savedPerf = localStorage.getItem('gra_perf_mode')
      if (savedPerf === 'fast' || savedPerf === 'thorough') {
        setPerfMode(savedPerf as 'fast'|'thorough')
      }
    } catch {}
  }, [])

  // Persist Tech Radar repos and sets
  useEffect(() => {
    try { localStorage.setItem('gra_radar_repos', radarRepos) } catch {}
  }, [radarRepos])
  useEffect(() => {
    try { localStorage.setItem('gra_radar_sets', JSON.stringify(radarSets)) } catch {}
  }, [radarSets])

  // Code Quality thresholds (tweakable)
  const Q_TOTAL_OK = 10
  const Q_TOTAL_WARN = 50
  const Q_ERRORS_OK = 0
  const Q_ERRORS_WARN = 5

  function qualityStatus(a: StaticAnalysis | null): {label: string, color: 'success'|'warning'|'error'} | null {
    if (!a) return null
    const total = a.flake8?.total ?? 0
    const errors = a.by_severity?.error ?? 0
    if (total <= Q_TOTAL_OK && errors <= Q_ERRORS_OK) return { label: 'Good', color: 'success' }
    if (total <= Q_TOTAL_WARN || errors <= Q_ERRORS_WARN) return { label: 'Attention', color: 'warning' }
    return { label: 'Needs Work', color: 'error' }
  }

  // Compute a simple bus factor approximation from contributor distribution
  function busFactorInfo(): { topShare: number, busFactor: number } | null {
    if (!contributors || contributors.length === 0) return null
    try {
      const total = contributors.reduce((s, c) => s + (c.contributions || 0), 0)
      if (total <= 0) return null
      const sorted = [...contributors].sort((a,b)=> (b.contributions||0) - (a.contributions||0))
      const top = sorted[0]
      const topShare = (top.contributions || 0) / total
      // naive bus factor: min number of top contributors accounting for >=50% of commits
      let acc = 0
      let k = 0
      for (const c of sorted) {
        acc += (c.contributions || 0)
        k++
        if (acc / total >= 0.5) break
      }
      return { topShare, busFactor: k }
    } catch {
      return null
    }
  }

  // Aggregate overall health score across signals (for UI badge)
  function overallHealth(): { score: number, level: 'green'|'yellow'|'red' } | null {
    if (!meta) return null
    try {
      const h = healthScore?.score ?? null
      const comm = community?.score ?? null
      const sec = security?.risk_score ?? null
      const cov = analysis?.coverage_pct ?? null
      const lint = analysis?.flake8?.total ?? null
      // weights: health 0.4, community 0.2, security 0.2, quality 0.2 (coverage up, lint down)
      let score = 0
      let w = 0
      if (h != null) { score += 0.4 * h; w += 0.4 }
      if (comm != null) { score += 0.2 * comm; w += 0.2 }
      if (sec != null) { score += 0.2 * sec; w += 0.2 }
      if (cov != null || lint != null) {
        const covPart = (cov != null ? Math.max(0, Math.min(100, cov)) : 60)
        const lp = Math.min(300, Math.max(0, Number(lint || 0)))
        const lintScore = lp >= 300 ? 20 : (lp >= 200 ? 40 : (lp >= 100 ? 60 : (lp >= 50 ? 80 : 100)))
        const quality = (0.6 * covPart + 0.4 * lintScore)
        score += 0.2 * quality; w += 0.2
      }
      if (w === 0) return null
      const s = Math.round(score / w)
      const level: 'green'|'yellow'|'red' = s >= 70 ? 'green' : (s >= 40 ? 'yellow' : 'red')
      return { score: s, level }
    } catch {
      return null
    }
  }

  useEffect(() => {
    try { localStorage.setItem('gra_perf_mode', perfMode) } catch {}
  }, [perfMode])

  useEffect(() => {
    try { localStorage.setItem('gra_report_opts', JSON.stringify(reportOpts)) } catch {}
  }, [reportOpts])

  // Persist section timings
  useEffect(() => {
    try { localStorage.setItem('gra_section_ms', JSON.stringify(sectionMs)) } catch {}
  }, [sectionMs])

  function resetUI() {
    try { window.scrollTo({ top: 0, behavior: 'smooth' }) } catch {}
    try { localStorage.removeItem('gra_report_opts') } catch {}
    try { localStorage.removeItem('gra_perf_mode') } catch {}
    // Restore recommended defaults
    setReportOpts({
      summary: true,
      metadata: true,
      languages: true,
      readme: true,
      techstack: true,
      quality: true,
      contributors: true,
      activity: true,
      hotspots: false,
      community: true,
      security: true,
      architecture: false,
    })
    setPerfMode('fast')
    setHasAnalyzed(false)
    setRepo('markedjs/marked')
    setLoading(false)
    setError('')
    setMeta(null)
    setLangs({})
    setLangDetail({})
    
    setReadmeTree(null)
    setContributors([])
    setWeekly([])
    setHealthScore(null)
    setSectionErrors({})
    setStack(null)
    setAnalysis(null)
    setHotspots(null)
    setCommunity(null)
    setSecurity(null)
    setArch(null)
    setArchLang('all')
    setHotspotsCount(5)
    setContributorsCount(5)
    setReadmeCount(5)
    setReportOpts({
      summary: true,
      metadata: true,
      languages: true,
      readme: true,
      techstack: true,
      quality: true,
      contributors: true,
      activity: true,
      hotspots: false,
      community: true,
      security: true,
      architecture: false,
      related: true,
      author_repos: true,
    })
    setPerfMode('fast')
  }

  function analyzeSelectedRepo(fullName: string) {
    // Behave like Reset, then set the chosen repo into the input field
    resetUI()
    setRepo(fullName)
    try { window.scrollTo({ top: 0, behavior: 'smooth' }) } catch {}
  }

  async function analyzeTechRadar() {
    try {
      setLoadingRadar(true)
      setRadarError('')
      setTechRadar(null)
      const list = (radarRepos || '')
        .split(/[\n,]/)
        .map(s => s.trim())
        .filter(Boolean)
        .slice(0, 25)
      if (list.length === 0) {
        setRadarError('Enter at least one repo in owner/name form')
        setLoadingRadar(false)
        return
      }
      const r = await fetch(`${API_BASE}/api/tech-radar`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repos: list })
      })
      if (!r.ok) {
        setRadarError(`HTTP ${r.status}`)
        return
      }
      const data = await r.json()
      setTechRadar(data as TechRadar)
    } catch (e: any) {
      setRadarError(e?.message || 'Failed to analyze tech radar')
    } finally {
      setLoadingRadar(false)
    }
  }

  // Tech Radar helpers: save/load/delete sets and copy a shareable link
  function saveRadarSet() {
    try {
      const name = (newSetName || '').trim()
      const repos = (radarRepos || '').trim()
      if (!name || !repos) return
      setRadarSets((prev) => {
        const others = (prev || []).filter((s) => s.name !== name)
        return [...others, { name, repos }]
      })
      setNewSetName('')
    } catch {}
  }

  function loadRadarSet(name: string) {
    try {
      const s = (radarSets || []).find((x) => x.name === name)
      if (s) setRadarRepos(s.repos)
    } catch {}
  }

  function deleteRadarSet(name: string) {
    try {
      setRadarSets((prev) => (prev || []).filter((s) => s.name !== name))
    } catch {}
  }

  function copyRadarLink() {
    try {
      const url = new URL(window.location.href)
      // Do NOT pre-encode here; URLSearchParams will encode automatically.
      url.searchParams.set('radar', (radarRepos || '').trim())
      const share = url.toString()
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        navigator.clipboard.writeText(share)
      } else {
        // Fallback: open a prompt for manual copy
        window.prompt('Copy this link', share)
      }
    } catch {}
  }

  // Count README sections (level > 0) to decide whether to show "See more"
  function countReadmeSections(tree: any | null): number {
    if (!tree) return 0
    let cnt = 0
    const dfs = (n: any) => {
      if (!n) return
      if (typeof n.level === 'number' && n.level > 0) cnt++
      const children = n.children || []
      for (const c of children) dfs(c)
    }
    dfs(tree)
    return cnt
  }

  function downloadReport() {
    const title = meta?.full_name || repo
    const badgeHealth = meta ? `${API_BASE}/api/repo/${meta.full_name}/health-badge.svg`.replace('/api/repo//', '/api/repo/') : ''
    const badgeCommunity = meta ? `${API_BASE}/api/repo/${meta.full_name}/community-badge.svg`.replace('/api/repo//', '/api/repo/') : ''
    const badgeSecurity = meta ? `${API_BASE}/api/repo/${meta.full_name}/security-badge.svg`.replace('/api/repo//', '/api/repo/') : ''
    const langRows = Object.entries(langs).map(([k, v]) => `<tr><td>${k}</td><td style="text-align:right">${v}</td></tr>`).join('')
    const stackBadges = stack ? [
      ...(stack.languages||[]),
      ...(stack.runtime||[]),
      ...(stack.frameworks||[]),
      ...(stack.tests||[]),
      ...(stack.packaging||[]),
      ...(stack.containers||[]),
      ...(stack.ci||[]),
    ].map(t=>`<span style="border:1px solid #ddd;border-radius:12px;padding:2px 8px;margin:2px;display:inline-block;">${t}</span>`).join('') : ''
    const analysisRows = analysis?.worst_files?.map(w=>`<tr><td>${w.path}</td><td>${w.mi!=null?Number(w.mi).toFixed(1):'—'}</td><td>${w.cc_avg!=null?Number(w.cc_avg).toFixed(1):'—'}</td></tr>`).join('') || ''
    const contribRows = contributors?.map(c=>`<tr><td>${c.login}</td><td style="text-align:right">${c.contributions}</td></tr>`).join('') || ''
    const hotspotRows = hotspots?.items?.map(it=>`<tr><td>${it.path}</td><td style="text-align:right">${it.changes}</td><td>${it.last_modified||'—'}</td></tr>`).join('') || ''
    const communityMissing = community?.missing?.length ? `<div style="opacity:.8">Missing: ${community?.missing.join(', ')}</div>` : ''
    const securityFindings = security?.findings?.length ? `<ul>${(security?.findings as string[]).map((f: string)=>`<li>${f}</li>`).join('')}</ul>` : ''
    const archStats = arch ? `Nodes: ${arch.stats.node_count} · Edges: ${arch.stats.edge_count} · Internal: ${arch.stats.internal_nodes} · External: ${arch.stats.external_nodes}` : ''
    // Try to capture the current architecture graph SVG as data URL
    let archImg = ''
    try {
      const el = document.getElementById('arch-graph-svg') as SVGSVGElement | null
      if (el) {
        const serializer = new XMLSerializer()
        const src = serializer.serializeToString(el)
        const encoded = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(src)
        archImg = `<img src="${encoded}" alt="Architecture Graph" style="max-width:100%;border:1px solid #eee;border-radius:8px;"/>`
      }
    } catch {}

    // Compact summary
    const sumItems: string[] = []
    if (healthScore) sumItems.push(`Health: ${healthScore.score}/100`)
    if (community) sumItems.push(`Community: ${community.score}/100`)
    if (security) sumItems.push(`Security: ${security.risk_score}/100`)
    if (meta) sumItems.push(`Stars: ${meta.stars}`)
    if (analysis?.mi_avg != null) sumItems.push(`Avg MI: ${Number(analysis.mi_avg).toFixed(1)}`)
    const summaryHtml = sumItems.length ? `<div>${sumItems.join(' · ')}</div>` : ''

    const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>${title} – Report</title>
  <style>
    body{font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,Cantarell,"Noto Sans","Helvetica Neue",Arial,"Apple Color Emoji","Segoe UI Emoji";padding:24px;color:#111}
    h1{font-size:24px;margin:0 0 8px}
    h2{font-size:18px;margin:24px 0 8px}
    .muted{opacity:.7}
    .grid{display:grid;gap:16px;grid-template-columns:1fr 1fr}
    table{border-collapse:collapse;width:100%}
    td,th{border-bottom:1px solid #eee;padding:6px 8px;text-align:left}
    .badges{margin-top:4px}
    .section{page-break-inside:avoid}
    @media print{a{color:#000;text-decoration:none}}
  </style>
</head>
<body>
  <h1>GitHub Repo Analyzer Report</h1>
  <div class="muted">Generated for: ${meta?.full_name || repo}</div>
  <div style="margin:8px 0;display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
    ${badgeHealth?`<img src="${badgeHealth}" alt="health" />`:''}
    ${badgeCommunity?`<img src="${badgeCommunity}" alt="community" />`:''}
    ${badgeSecurity?`<img src="${badgeSecurity}" alt="security" />`:''}
  </div>
  ${reportOpts.summary ? `<div class="section"><h2>Summary</h2>${summaryHtml}</div>` : ''}

  ${reportOpts.metadata || reportOpts.languages ? '<div class="grid">' : ''}
    ${reportOpts.metadata ? `<div class="section">
      <h2>Metadata</h2>
      <div>${meta?.description || ''}</div>
      <table>
        <tr><td>Stars</td><td>${meta?.stars ?? '—'}</td></tr>
        <tr><td>Forks</td><td>${meta?.forks ?? '—'}</td></tr>
        <tr><td>Open issues</td><td>${meta?.open_issues ?? '—'}</td></tr>
        <tr><td>License</td><td>${meta?.license || '—'}</td></tr>
        <tr><td>Default branch</td><td>${meta?.default_branch || '—'}</td></tr>
        <tr><td>Last pushed</td><td>${meta?.last_pushed_at || '—'}</td></tr>
      </table>
    </div>` : ''}
    ${reportOpts.languages ? `<div class="section">
      <h2>Languages</h2>
      ${langRows?`<table><thead><tr><th>Language</th><th style="text-align:right">Bytes</th></tr></thead><tbody>${langRows}</tbody></table>`:'<div class="muted">No language data</div>'}
    </div>` : ''}
  ${reportOpts.metadata || reportOpts.languages ? '</div>' : ''}

  ${reportOpts.techstack || reportOpts.quality ? '<div class="grid">' : ''}
    ${reportOpts.techstack ? `<div class="section">
      <h2>Tech Stack</h2>
      <div class="badges">${stackBadges}</div>
    </div>` : ''}
    ${reportOpts.quality ? `<div class="section">
      <h2>Code Quality</h2>
      <div>Average MI: ${analysis?.mi_avg != null ? Number(analysis.mi_avg).toFixed(1) : '—'}</div>
      <div>flake8 total: ${analysis?.flake8?.total ?? 0}</div>
      ${analysisRows?`<h3>Top offenders</h3><table><thead><tr><th>File</th><th>MI</th><th>CC avg</th></tr></thead><tbody>${analysisRows}</tbody></table>`:''}
    </div>` : ''}
  ${reportOpts.techstack || reportOpts.quality ? '</div>' : ''}

  ${reportOpts.contributors || reportOpts.hotspots ? '<div class="grid">' : ''}
    ${reportOpts.contributors ? `<div class="section">
      <h2>Top Contributors</h2>
      ${contribRows?`<table><thead><tr><th>User</th><th style="text-align:right">Contribs</th></tr></thead><tbody>${contribRows}</tbody></table>`:'<div class="muted">No data</div>'}
    </div>` : ''}
    ${reportOpts.hotspots ? `<div class="section">
      <h2>File Hotspots</h2>
      ${hotspotRows?`<table><thead><tr><th>Path</th><th style="text-align:right">Changes</th><th>Last modified</th></tr></thead><tbody>${hotspotRows}</tbody></table>`:'<div class="muted">No hotspots</div>'}
    </div>` : ''}
  ${reportOpts.contributors || reportOpts.hotspots ? '</div>' : ''}

  ${reportOpts.community || reportOpts.security ? '<div class="grid">' : ''}
    ${reportOpts.community ? `<div class="section">
      <h2>Community Health</h2>
      <div>Score: ${community?.score ?? '—'}</div>
      ${communityMissing}
    </div>` : ''}
    ${reportOpts.security ? `<div class="section">
      <h2>Security & Compliance</h2>
      <div>Risk Score: ${security?.risk_score ?? '—'}</div>
      ${securityFindings || '<div class="muted">No findings</div>'}
    </div>` : ''}
  ${reportOpts.community || reportOpts.security ? '</div>' : ''}

  ${reportOpts.architecture ? `<div class="section">
    <h2>Architecture (Python)</h2>
    <div>${archStats || '<span class="muted">No graph</span>'}</div>
    ${archImg}
  </div>` : ''}

  <script>window.onload = () => { setTimeout(() => window.print(), 300); }</script>
</body>
</html>`
    const w = window.open('', '_blank')
    if (!w) return
    w.document.open()
    w.document.write(html)
    w.document.close()
  }

  const langData = useMemo(() => {
    const total = (Object.values(langs) as number[]).reduce((a: number, b: number) => a + b, 0)
    return Object.entries(langs).map(([name, value]) => ({ name, value: value as number, pct: total ? ((value as number) / total) * 100 : 0 }))
  }, [langs])

  function formatBytes(n: number): string {
    if (!n || n < 1024) return `${n} B`
    const kb = n / 1024
    if (kb < 1024) return `${kb.toFixed(kb < 10 ? 2 : 1)} KB`
    const mb = kb / 1024
    return `${mb.toFixed(mb < 10 ? 2 : 1)} MB`
  }

  function formatMs(ms?: number): string | null {
    if (ms == null) return null
    if (ms < 1000) return `${ms} ms`
    const s = ms / 1000
    return `${s.toFixed(s < 10 ? 2 : 1)} s`
  }

  function resetTimings(): void {
    try { localStorage.removeItem('gra_section_ms') } catch {}
    setSectionMs({})
    setAutoDisabled({})
  }

  function labelFor(key: string): string {
    const map: Record<string, string> = {
      metadata: 'Metadata',
      languages: 'Languages',
      readme: 'README Visuals',
      techstack: 'Tech Stack',
      quality: 'Code Quality',
      contributors: 'Contributors',
      activity: 'Recent Activity',
      hotspots: 'Hotspots',
      community: 'Community',
      security: 'Security',
      architecture: 'Architecture',
      related: 'Related Repos',
      author_repos: 'Author\'s Other Repos',
    }
    return map[key] || key
  }

  // Enable report download once analysis is finished (ignore per-section errors)
  const reportReady = useMemo(() => {
    return hasAnalyzed && !loading
  }, [hasAnalyzed, loading])

  const COLORS = ['#10b981', '#6366f1', '#f59e0b', '#ef4444', '#06b6d4', '#84cc16', '#8b5cf6', '#f97316']

  function ruleDocUrl(rule: string): string | null {
    try {
      const r = rule.trim()
      if (!r) return null
      // ESLint (e.g., no-unused-vars or @typescript-eslint/no-unused-vars)
      if (/^@?[-a-z]+(?:\/[-a-z]+)?$/i.test(r) && !/[A-Z]{2,}\d{2,}/.test(r)) {
        const clean = r.toLowerCase()
        if (clean.startsWith('@typescript-eslint/')) {
          return `https://typescript-eslint.io/rules/${clean.split('/')[1]}`
        }
        return `https://eslint.org/docs/latest/rules/${clean}`
      }
      // flake8 / pycodestyle / pyflakes (e.g., E501, F401, W291)
      if (/^[A-Z]\d{3}$/.test(r)) {
        return `https://flake8rules.com/rules/${r}.html`
      }
      // golangci-lint (e.g., errcheck, govet, revive)
      if (/^[a-z][a-z0-9-]+$/.test(r)) {
        return `https://golangci-lint.run/usage/linters/#${r}`
      }
      // dotnet analyzers (e.g., CA1822, IDE0051)
      if (/^[A-Z]{2,}\d{2,}$/.test(r)) {
        return `https://learn.microsoft.com/dotnet/fundamentals/code-analysis/quality-rules/${r}`
      }
      // RuboCop (e.g., Layout/LineLength)
      if (/^[A-Za-z]+\/[A-Za-z0-9]+$/.test(r)) {
        const dept = r.split('/')[0]
        return `https://docs.rubocop.org/rubocop/latest/cops_${dept.toLowerCase()}.html`
      }
      // Checkstyle generic docs
      if (/^[A-Za-z0-9_.-]+$/.test(r)) {
        return 'https://checkstyle.sourceforge.io/checks.html'
      }
      // PHP_CodeSniffer generic docs
      if (r.includes('.')) {
        return 'https://github.com/squizlabs/PHP_CodeSniffer/wiki'
      }
      // SpotBugs generic docs
      return 'https://spotbugs.readthedocs.io/en/latest/bugDescriptions.html'
    } catch {
      return null
    }
  }

  function fetchWithTimeout(input: RequestInfo, init?: RequestInit, timeoutMs = 10000): Promise<Response> {
    const controller = new AbortController()
    const id = setTimeout(() => controller.abort(), timeoutMs)
    return fetch(input, { ...(init || {}), signal: controller.signal })
      .finally(() => clearTimeout(id))
  }

  async function analyze() {
    try { window.scrollTo({ top: 0, behavior: 'smooth' }) } catch {}
    setLoading(true)
    setError('')
    setHasAnalyzed(true)
    // Preload heavy lazy-loaded components so they are ready by the time data arrives
    try {
      import('./components/ReadmeVisuals')
      import('./components/ArchGraphView')
    } catch {}
    setMeta(null)
    setLangs({})
    setReadmeTree(null)
    setContributors([])
    setWeekly([])
    setHealthScore(null)
    setSectionErrors({})
    setStack(null)
    setAnalysis(null)
    setHotspots(null)
    setCommunity(null)
    setSecurity(null)
    setArch(null)
    setArchLang('all')
    setHotspotsCount(5)
    setContributorsCount(5)
    setReadmeCount(5)
    try {
      const [o, n] = repo.split('/')
      if (!o || !n) throw new Error('Enter repo as owner/name')
      // Fetch metadata first so we can show precise errors
      const mRes = await fetchWithTimeout(`${API_BASE}/api/repo/${o}/${n}/metadata`)
      if (!mRes.ok) {
        // Try to extract backend error detail
        let msg = `Metadata HTTP ${mRes.status}`
        try {
          const body = await mRes.json()
          if (body?.detail) msg = body.detail
        } catch {
          try { msg = await mRes.text() } catch {}
        }
        throw new Error(msg)
      }
      const meta = await mRes.json()
      setMeta(meta)

      const includeHotspots = !!reportOpts.hotspots
      const isFast = perfMode === 'fast'
      const T = {
        meta: 15000,
        languages: 15000,
        readme: isFast ? 9000 : 12000,
        structure: isFast ? 9000 : 12000,
        common: isFast ? 12000 : 15000,
        analysis: isFast ? 25000 : 45000,
        hotspots: isFast ? 25000 : 45000,
        arch: isFast ? 40000 : 60000,
      }
      const caps = {
        analysis_max_files: isFast ? 400 : 600,
        analysis_clone_timeout: isFast ? 90 : 120,
        hotspots_max_files: isFast ? 500 : 800,
        arch_max_files: isFast ? 800 : 1200,
        arch_node_cap: isFast ? 120 : 160,
        arch_min_weight: 2,
      }
      // Build tasks conditionally from toggles
      const tasks: Partial<Record<string, Promise<Response>>> = {}
      tasks.meta = fetchWithTimeout(`${API_BASE}/api/repo/${o}/${n}/metadata`, undefined, T.meta)
      if (reportOpts.languages) {
        tasks.languages = fetchWithTimeout(`${API_BASE}/api/repo/${o}/${n}/languages`, undefined, T.languages)
        tasks.languages_detail = fetchWithTimeout(`${API_BASE}/api/repo/${o}/${n}/languages-detail`, undefined, T.languages)
      }
      if (reportOpts.readme) {
        tasks.readme = fetchWithTimeout(`${API_BASE}/api/repo/${o}/${n}/readme-map`, undefined, T.readme)
        tasks.structure = fetchWithTimeout(`${API_BASE}/api/repo/${o}/${n}/readme-structure`, undefined, T.structure)
      }
      if (reportOpts.contributors || reportOpts.activity) {
        tasks.contributors = fetchWithTimeout(`${API_BASE}/api/repo/${o}/${n}/contributors`, undefined, T.common)
      }
      if (reportOpts.quality) {
        tasks.health = fetchWithTimeout(`${API_BASE}/api/repo/${o}/${n}/health`, undefined, T.common)
        tasks.analysis = fetchWithTimeout(`${API_BASE}/api/repo/${o}/${n}/static-analysis?max_files=${caps.analysis_max_files}&clone_timeout=${caps.analysis_clone_timeout}`, undefined, T.analysis)
      }
      if (reportOpts.techstack) {
        tasks.stack = fetchWithTimeout(`${API_BASE}/api/repo/${o}/${n}/stack-detect`, undefined, T.common)
      }
      if (reportOpts.related) {
        tasks.related = fetchWithTimeout(`${API_BASE}/api/repo/${o}/${n}/related?limit=5`, undefined, T.common)
      }
      if (reportOpts.author_repos) {
        tasks.author_repos = fetchWithTimeout(`${API_BASE}/api/repo/${o}/${n}/author-repos?limit=5`, undefined, T.common)
      }
      if (reportOpts.hotspots) {
        tasks.hotspots = fetchWithTimeout(`${API_BASE}/api/repo/${o}/${n}/hotspots?max_files=${caps.hotspots_max_files}`, undefined, T.hotspots)
      }
      if (reportOpts.community) {
        tasks.community = fetchWithTimeout(`${API_BASE}/api/repo/${o}/${n}/community`, undefined, T.common)
      }
      if (reportOpts.security) {
        tasks.security = fetchWithTimeout(`${API_BASE}/api/repo/${o}/${n}/security`, undefined, T.common)
      }
      if (reportOpts.architecture) {
        tasks.arch = fetchWithTimeout(`${API_BASE}/api/repo/${o}/${n}/arch-graph?max_files=${caps.arch_max_files}&lang=${archLang}&min_weight=${caps.arch_min_weight}&node_cap=${caps.arch_node_cap}`, undefined, T.arch)
      }

      let remaining = Object.keys(tasks).length
      const done = () => { remaining -= 1; if (remaining <= 0) setLoading(false) }

      const handle = async (
        key: string,
        p: Promise<Response>,
        onOk: (data: any) => void,
        onNoContent?: () => void,
        onFinally?: () => void,
      ) => {
        try {
          const t0 = Date.now()
          const r = await p
          if (!r.ok) {
            setSectionErrors(prev => ({ ...prev, [key]: `HTTP ${r.status}` }))
            return
          }
          if (r.status === 204) {
            onNoContent && onNoContent()
            return
          }
          const data = await r.json()
          onOk(data)
          const dt = Date.now() - t0
          setSectionMs(prev => ({ ...prev, [key]: prev[key] != null ? Math.round((prev[key] * 0.5) + (dt * 0.5)) : dt }))
        } catch (e: any) {
          setSectionErrors(prev => ({ ...prev, [key]: e?.message || 'failed' }))
        } finally {
          onFinally && onFinally()
          done()
        }
      }

      handle('meta', tasks.meta!, (data) => setMeta(data))
      tasks.languages && handle('languages', tasks.languages, (data) => setLangs(data))
      if (tasks.languages_detail) {
        setLoadingLangDetail(true)
        handle(
          'languages_detail',
          tasks.languages_detail,
          (data) => setLangDetail(data || {}),
          () => {},
          () => setLoadingLangDetail(false),
        )
      }
      tasks.readme && handle('readme', tasks.readme, (_data) => { /* mermaid/headings removed */ })
      tasks.structure && handle('structure', tasks.structure, (data) => setReadmeTree(data))
      tasks.contributors && handle('contributors', tasks.contributors, (data) => { setContributors((data?.top) ?? []); setWeekly((data?.weekly_activity) ?? []) })
      tasks.health && handle('health', tasks.health, (data) => setHealthScore(data))
      tasks.stack && handle('stack', tasks.stack, (data) => setStack(data))
      tasks.related && handle('related', tasks.related, (data) => setRelated(data))
      tasks.author_repos && handle('author_repos', tasks.author_repos, (data) => setAuthorRepos(data))
      tasks.analysis && handle('analysis', tasks.analysis, (data) => setAnalysis(data))
      tasks.hotspots && handle('hotspots', tasks.hotspots, (data) => setHotspots(data), () => {})
      tasks.community && handle('community', tasks.community, (data) => setCommunity(data))
      tasks.security && handle('security', tasks.security, (data) => setSecurity(data))
      tasks.arch && handle('arch', tasks.arch, (data) => setArch(data))
    } catch (e: any) {
      setError(e?.message || 'Failed to analyze')
    }
  }

  async function refetchArchWithLang(nextLang: 'all'|'python'|'js'|'npm'|'go'|'java'|'csharp'|'php'|'ruby') {
    try {
      setArchLang(nextLang)
      if (!meta?.full_name) return
      const [o, n] = meta.full_name.split('/')
      // section loader
      setArch(null)
      const r = await fetchWithTimeout(`${API_BASE}/api/repo/${o}/${n}/arch-graph?max_files=1200&lang=${nextLang}&min_weight=2&node_cap=160`, undefined, 30000)
      if (!r.ok) {
        setSectionErrors(prev => ({ ...prev, arch: `HTTP ${r.status}` }))
        return
      }
      const data = await r.json()
      setArch(data)
    } catch (e: any) {
      setSectionErrors(prev => ({ ...prev, arch: e?.message || 'failed' }))
    }
  }

  const reportRef = useRef<HTMLDivElement>(null)

  return (
    <div className="min-h-screen bg-base-200 text-base-content">
      <div
        className="max-w-5xl mx-auto p-6 space-y-6 transition-transform duration-500 ease-out"
        style={{ transform: hasAnalyzed ? 'translateY(0)' : 'translateY(20vh)' }}
      >
        <header className="flex items-center justify-between">
          <h1 className={`text-3xl font-bold mb-1 ${hasAnalyzed ? '' : 'text-center'}`}>
            GitHub Repo Analyzer
          </h1>
          <div className="join">
            <button
              type="button"
              className={`btn btn-sm join-item ${!showRadar ? 'btn-primary' : 'btn-outline btn-primary'}`}
              onClick={()=>setShowRadar(false)}
            >
              Analyzer
            </button>
            <button
              type="button"
              className={`btn btn-sm join-item ${showRadar ? 'btn-primary' : 'btn-outline btn-primary'}`}
              onClick={()=>setShowRadar(true)}
            >
              Tech Radar
            </button>
          </div>
        </header>

        {/* Global notices (e.g., rate limits) */}
        {Object.values(sectionErrors).some((e)=>/\b(403|429)\b/.test(String(e))) && (
          <div className="alert alert-warning text-sm">
            Possible GitHub API rate limit detected. Add a GitHub token to your environment and retry for higher limits.
          </div>
        )}

        {/* Tech Radar standalone view (toggle) */}
        {showRadar && (
          <div className="card bg-base-100 border border-base-300 shadow-sm">
            <div className="card-body">
              <h3 className="card-title">Tech Radar (Multiple Repos)</h3>
              <div className="text-sm opacity-80">Paste a comma or newline-separated list of GitHub repositories (owner/name).</div>
              <div className="mt-2 grid md:grid-cols-3 gap-3 items-start">
                <div className="md:col-span-2">
                  <div className="flex items-center justify-between gap-2 mb-2">
                    <div className="text-sm opacity-80">Presets</div>
                    <select className="select select-bordered select-sm w-full max-w-xs"
                      onChange={(e)=>{
                        const v = e.target.value
                        const presets: Record<string,string> = {
                          popular_frontend: 'vercel/next.js, facebook/react, vitejs/vite, angular/angular, sveltejs/kit',
                          popular_python: 'django/django, pallets/flask, tiangolo/fastapi, numpy/numpy, pandas-dev/pandas',
                          popular_js_tools: 'webpack/webpack, rollup/rollup, vitejs/vite, eslint/eslint, babel/babel',
                          data_ai: 'scikit-learn/scikit-learn, pytorch/pytorch, tensorflow/tensorflow, huggingface/transformers, apache/spark',
                        }
                        if (presets[v]) setRadarRepos(presets[v])
                        e.currentTarget.selectedIndex = 0
                      }}
                    >
                      <option>Choose preset…</option>
                      <option value="popular_frontend">Popular Frontend</option>
                      <option value="popular_python">Popular Python</option>
                      <option value="popular_js_tools">Popular JS Tooling</option>
                      <option value="data_ai">Data/AI</option>
                    </select>
                  </div>
                  {/* Saved sets row */}
                  <div className="flex flex-wrap items-center gap-2 mb-2">
                    <input
                      type="text"
                      className="input input-bordered input-sm w-48"
                      placeholder="New set name"
                      value={newSetName}
                      onChange={(e)=>setNewSetName(e.target.value)}
                    />
                    <button className="btn btn-sm" onClick={saveRadarSet}>Save Set</button>
                    <select className="select select-bordered select-sm w-48" onChange={(e)=>{ const n=e.target.value; if(n) loadRadarSet(n); e.currentTarget.selectedIndex=0 }}>
                      <option>Load saved…</option>
                      {radarSets.map((s)=> (
                        <option key={s.name} value={s.name}>{s.name}</option>
                      ))}
                    </select>
                    <select className="select select-bordered select-sm w-40" onChange={(e)=>{ const n=e.target.value; if(n) deleteRadarSet(n); e.currentTarget.selectedIndex=0 }}>
                      <option>Delete set…</option>
                      {radarSets.map((s)=> (
                        <option key={s.name} value={s.name}>{s.name}</option>
                      ))}
                    </select>
                    <button className="btn btn-sm btn-outline" type="button" onClick={copyRadarLink}>Copy Link</button>
                  </div>
                  <textarea className="textarea textarea-bordered w-full h-24" value={radarRepos} onChange={(e)=>setRadarRepos(e.target.value)} placeholder="owner/name, owner2/name2, ..." />
                  <div className="mt-2">
                    <button className="btn btn-sm btn-primary" onClick={analyzeTechRadar} disabled={loadingRadar} aria-busy={loadingRadar}>{loadingRadar ? 'Analyzing…' : 'Analyze Tech Radar'}</button>
                    {radarError && <span className="ml-3 text-error text-sm">{radarError}</span>}
                  </div>
                </div>
                <div className="text-sm opacity-80">
                  Tips:
                  <ul className="list-disc pl-5 mt-1">
                    <li>Up to 25 repos are accepted.</li>
                    <li>We aggregate unique tech per repo (e.g., frameworks, languages).</li>
                  </ul>
                </div>
              </div>

              {techRadar && (
                <div className="mt-4 grid md:grid-cols-2 gap-6">
                  <div>
                    <div className="font-semibold mb-2">Top Frameworks</div>
                    <div className="h-64">
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={Object.entries(techRadar.frameworks||{}).sort((a,b)=>b[1]-a[1]).slice(0,8).map(([name,count])=>({ name, count }))} margin={{ left: 6, right: 6, top: 4, bottom: 4 }}>
                          <XAxis dataKey="name" hide />
                          <YAxis hide />
                          <Tooltip formatter={(v:any)=>[v,'repos']} labelFormatter={(l)=>String(l)} />
                          <Bar dataKey="count" fill="#10b981" radius={[3,3,0,0]} />
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                    <div className="mt-2 text-xs opacity-70">Showing top 8 frameworks by number of repos.</div>
                    {/* Radar (polar) view for frameworks */}
                    <div className="mt-4 h-64">
                      <ResponsiveContainer width="100%" height="100%">
                        <RadarChart cx="50%" cy="50%" outerRadius="70%" data={Object.entries(techRadar.frameworks||{})
                          .sort((a,b)=>b[1]-a[1])
                          .slice(0,8)
                          .map(([name,count])=>({ name, count }))}>
                          <PolarGrid />
                          <PolarAngleAxis dataKey="name" tick={false} />
                          <PolarRadiusAxis angle={30} domain={[0, 'auto']} tick={false} />
                          <Radar name="repos" dataKey="count" stroke="#10b981" fill="#10b981" fillOpacity={0.5} />
                          <Tooltip formatter={(v:any)=>[v,'repos']} labelFormatter={(l)=>String(l)} />
                        </RadarChart>
                      </ResponsiveContainer>
                    </div>
                  </div>
                  <div>
                    <div className="font-semibold mb-2">Top Languages</div>
                    <div className="h-64">
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={Object.entries(techRadar.languages||{}).sort((a,b)=>b[1]-a[1]).slice(0,8).map(([name,count])=>({ name, count }))} margin={{ left: 6, right: 6, top: 4, bottom: 4 }}>
                          <XAxis dataKey="name" hide />
                          <YAxis hide />
                          <Tooltip formatter={(v:any)=>[v,'repos']} labelFormatter={(l)=>String(l)} />
                          <Bar dataKey="count" fill="#6366f1" radius={[3,3,0,0]} />
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                    <div className="mt-2 text-xs opacity-70">Showing top 8 languages by number of repos.</div>
                    {/* Radar (polar) view for languages */}
                    <div className="mt-4 h-64">
                      <ResponsiveContainer width="100%" height="100%">
                        <RadarChart cx="50%" cy="50%" outerRadius="70%" data={Object.entries(techRadar.languages||{})
                          .sort((a,b)=>b[1]-a[1])
                          .slice(0,8)
                          .map(([name,count])=>({ name, count }))}>
                          <PolarGrid />
                          <PolarAngleAxis dataKey="name" tick={false} />
                          <PolarRadiusAxis angle={30} domain={[0, 'auto']} tick={false} />
                          <Radar name="repos" dataKey="count" stroke="#6366f1" fill="#6366f1" fillOpacity={0.5} />
                          <Tooltip formatter={(v:any)=>[v,'repos']} labelFormatter={(l)=>String(l)} />
                        </RadarChart>
                      </ResponsiveContainer>
                    </div>
                  </div>
                </div>
              )}
              {loadingRadar && !techRadar && (
                <div className="mt-4 h-64 skeleton rounded-md" />
              )}
            </div>
          </div>
        )}

        {/* Hide the analyzer content when radar view is active */}
        <div className={showRadar ? 'hidden' : ''}>

        {/* Analyze form (always visible) */}
        <div className="card bg-base-100 border border-base-300 shadow-sm">
            <div className="card-body gap-4">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <h2 className="card-title m-0">Analyze a repository</h2>
                  <div className="tooltip" data-tip="Reset">
                    <button
                      type="button"
                      onClick={resetUI}
                      className="btn btn-xs btn-circle"
                      aria-label="Reset"
                      title="Reset"
                    >
                      ↻
                    </button>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <div className="text-sm font-semibold">Performance Mode</div>
                  <div className="join">
                    <button className={`btn btn-xs join-item ${perfMode==='fast' ? 'btn-primary' : ''}`} onClick={() => setPerfMode('fast')}>Fast</button>
                    <button className={`btn btn-xs join-item ${perfMode==='thorough' ? 'btn-primary' : ''}`} onClick={() => setPerfMode('thorough')}>Thorough</button>
                  </div>
                  <div className="tooltip" data-tip={perfMode==='fast' ? 'Shorter timeouts and smaller caps for snappy results.' : 'Longer timeouts and larger caps for deeper analysis.'}>
                    <button type="button" className="btn btn-xs btn-circle">i</button>
                  </div>
                </div>
              </div>
              <div className="join w-full">
                <input
                  value={repo}
                  onChange={(e: ChangeEvent<HTMLInputElement>) => setRepo(e.target.value)}
                  placeholder="owner/name"
                  className="input input-bordered join-item w-full"
                />
                <button onClick={analyze} disabled={loading} aria-busy={loading} className="btn btn-primary join-item">
                  {loading ? (
                    <>
                      Analyzing...
                      <span className="loading loading-spinner loading-xs ml-2" />
                    </>
                  ) : (
                    'Analyze'
                  )}
                </button>
              </div>
              {/* Suggestions under the input */}
              <div className="flex flex-wrap gap-2 items-center mt-2">
                {[
                  'django/django',
                  'vercel/next.js',
                  'microsoft/vscode',
                  'vitejs/vite',
                  'fastapi/fastapi',
                  'axios/axios',
                  'facebook/react',
                ].map((r) => (
                  <button
                    key={r}
                    type="button"
                    onClick={() => setRepo(r)}
                    className="btn btn-xs btn-ghost border border-base-300"
                    title={`Use ${r}`}
                  >
                    {r}
                  </button>
                ))}
              </div>
              {hasAnalyzed && (
                <div className="mt-3">
                  <div className="text-sm font-semibold mb-1">Report Sections</div>
                  <div className="flex flex-wrap gap-3 items-center text-xs">
                    {([
                      ['metadata','Metadata'],
                      ['languages','Languages'],
                      ['readme','README Visuals'],
                      ['techstack','Tech Stack'],
                      ['quality','Code Quality'],
                      ['contributors','Contributors'],
                      ['activity','Recent Activity'],
                      ['hotspots','Hotspots'],
                      ['community','Community'],
                      ['security','Security'],
                      ['architecture','Architecture'],
                      ['related','Related Repos'],
                      ['author_repos',"Author's Other Repos"],
                    ] as Array<[keyof typeof reportOpts, string]>).map(([k,label]) => (
                      <label key={k} className="label cursor-pointer gap-2 items-center p-0">
                        <input
                          type="checkbox"
                          className="checkbox checkbox-xs"
                          checked={!!reportOpts[k]}
                          onChange={(e)=>setReportOpts({...reportOpts,[k]:e.target.checked})}
                        />
                        <span className="label-text text-xs flex items-center gap-2">
                          {label}
                          {!!autoDisabled[k as string] && (
                            <span className="badge badge-warning badge-outline text-[10px]">auto</span>
                          )}
                        </span>
                      </label>
                    ))}
                  </div>
                </div>
              )}
              {reportReady && (
                <div className="mt-2 text-left">
                  <button onClick={downloadReport} className="btn btn-sm">Download Report</button>
                </div>
              )}
              {error && <div className="alert alert-error">{error}</div>}
            </div>
        </div>

        {/* Analyze and Report Sections are defined below (full UI) */}

        <div ref={reportRef} className="space-y-6">
        {hasAnalyzed && (
          <div className="mt-6 md:mt-6 grid md:grid-cols-2 gap-x-6 gap-y-6 md:gap-y-10 lg:gap-y-12">
            {/* Metadata */}
            {reportOpts.metadata && (
              <div className="card bg-base-100 border border-base-300 shadow-sm">
                <div className="card-body">
                  <h3 className="card-title">Metadata</h3>
                  {!meta && loading && (
                    <div className="flex flex-col gap-2">
                      <div className="skeleton h-4 w-48" />
                      <div className="skeleton h-4 w-40" />
                      <div className="skeleton h-4 w-52" />
                    </div>
                  )}
                  {meta && (
                    <>
                      <p className="font-mono">{meta!.full_name}</p>
                      {meta!.description && <p className="opacity-80">{meta!.description}</p>}
                      <div className="grid grid-cols-2 gap-2 mt-2">
                        <div>⭐ Stars: {meta!.stars}</div>
                        <div className="flex items-center gap-2"><IconFork /> <span>Forks: {meta!.forks}</span></div>
                        <div>🐞 Open issues: {meta!.open_issues}</div>
                        <div>📄 License: {meta!.license || '—'}</div>
                        <div className="flex items-center gap-2"><IconBranch /> <span>Default branch: {meta!.default_branch}</span></div>
                        <div>⏱ Last pushed: {formatDateTime(meta!.last_pushed_at)}</div>
                      </div>
                      {meta!.topics?.length > 0 && (
                        <div className="mt-2 flex flex-wrap gap-2">
                          {meta!.topics!.map((t: string) => <div key={t} className="badge badge-outline">{t}</div>)}
                        </div>
                      )}
                    </>
                  )}
                </div>
              </div>
            )}

            {/* Languages */}
            {reportOpts.languages && (
              <div className="card bg-base-100 border border-base-300 shadow-sm">
                <div className="card-body">
                  <h3 className="card-title">Languages</h3>
                  {loading && !langData.length && (
                    <>
                      <div className="h-64 bg-base-200 rounded-md skeleton" />
                      <div className="mt-3 space-y-2">
                        <div className="skeleton h-3 w-3/5" />
                        <div className="skeleton h-3 w-1/2" />
                        <div className="skeleton h-3 w-2/3" />
                        <div className="skeleton h-3 w-1/3" />
                      </div>
                    </>
                  )}
                  {!loading && langData.length === 0 && (<p className="opacity-70">No language data</p>)}
                  {langData.length > 0 && (
                    <>
                      <div className="h-64">
                        <ResponsiveContainer width="100%" height="100%">
                          <PieChart>
                            <Pie dataKey="value" data={langData} nameKey="name" cx="50%" cy="50%" outerRadius={90}>
                              {langData.map((entry: any, idx: number) => (
                                <Cell key={`cell-${idx}`} fill={COLORS[idx % COLORS.length]} />
                              ))}
                            </Pie>
                            <Tooltip formatter={(v: any, n: any, p: any) => [formatBytes(v as number), p.payload.name]} />
                          </PieChart>
                        </ResponsiveContainer>
                      </div>
                      {/* Visible legend with labels and data */}
                      <div className="mt-3 text-sm">
                        {loading && loadingLangDetail && !sectionErrors['languages_detail'] && (
                          <div className="flex flex-col gap-1 mb-1">
                            <div className="skeleton h-2 w-24" />
                            <div className="skeleton h-2 w-20" />
                          </div>
                        )}
                        {sectionErrors['languages_detail'] && (
                          <div className="text-xs opacity-70 mb-1">Files/lines unavailable</div>
                        )}
                        {langData.map((d: any, idx: number) => {
                          const det = langDetail[d.name]
                          const details = sectionErrors['languages_detail']
                            ? ''
                            : (loadingLangDetail ? ' (loading…)' : ` (${(det?.files||0)} files, ${(det?.lines||0)} lines)`) 
                          return (
                            <div key={idx} className="flex justify-between items-center py-0.5">
                              <div className="flex items-center gap-2">
                                <span className="inline-block w-3 h-3 rounded-sm" style={{ background: COLORS[idx % COLORS.length] }} />
                                <span>{d.name}{details}</span>
                              </div>
                              <div className="opacity-70">{Math.round(d.pct)}% · {formatBytes(d.value)}</div>
                            </div>
                          )
                        })}
                      </div>
                      {/* Badges */}
                      <div className="mt-3 flex flex-wrap items-center gap-2">
                        {meta && (
                          <>
                            <img src={`${API_BASE}/api/repo/${meta.full_name}/health-badge.svg`.replace('/api/repo//','/api/repo/')} alt="health" />
                            <img src={`${API_BASE}/api/repo/${meta.full_name}/community-badge.svg`.replace('/api/repo//','/api/repo/')} alt="community" />
                            <img src={`${API_BASE}/api/repo/${meta.full_name}/security-badge.svg`.replace('/api/repo//','/api/repo/')} alt="security" />
                          </>
                        )}
                        {(() => { const o = overallHealth(); return o ? (
                          <span className={`badge ${o.level==='green'?'badge-success':o.level==='yellow'?'badge-warning':'badge-error'}`}>overall: {o.score}/100</span>
                        ) : null })()}
                      </div>
                    </>
                  )}
                </div>
              </div>
            )}
          </div>
        )}

        {hasAnalyzed && reportOpts.techstack && (
          <div className="card bg-base-100 border border-base-300 shadow-sm">
            <div className="card-body">
              <h3 className="card-title">Tech Stack</h3>
              {loading && !stack && (
                <div className="grid md:grid-cols-3 gap-4">
                  <div>
                    <div className="skeleton h-4 w-40 mb-2" />
                    <div className="flex flex-wrap gap-2">
                      <div className="skeleton h-6 w-20" />
                      <div className="skeleton h-6 w-24" />
                      <div className="skeleton h-6 w-16" />
                    </div>
                  </div>
                  <div>
                    <div className="skeleton h-4 w-44 mb-2" />
                    <div className="flex flex-wrap gap-2">
                      <div className="skeleton h-6 w-24" />
                      <div className="skeleton h-6 w-28" />
                    </div>
                  </div>
                  <div>
                    <div className="skeleton h-4 w-36 mb-2" />
                    <div className="flex flex-wrap gap-2">
                      <div className="skeleton h-6 w-24" />
                      <div className="skeleton h-6 w-20" />
                      <div className="skeleton h-6 w-16" />
                    </div>
                  </div>
                </div>
              )}
              {stack ? (
                <div className="grid md:grid-cols-3 gap-4">
                  <div>
                    <div className="font-semibold mb-1">Languages & Runtime</div>
                    <div className="flex flex-wrap gap-2">
                      {[...(stack!.languages||[]), ...(stack!.runtime||[])].map((t, i) => (
                        <div key={i} className="badge badge-outline">{t}</div>
                      ))}
                    </div>
                  </div>
                  <div>
                    <div className="font-semibold mb-1">Frameworks & Tests</div>
                    <div className="flex flex-wrap gap-2">
                      {[...(stack!.frameworks||[]), ...(stack!.tests||[])].map((t, i) => (
                        <div key={i} className="badge badge-outline">{t}</div>
                      ))}
                    </div>
                  </div>
                  <div>
                    <div className="font-semibold mb-1">Tooling</div>
                    <div className="flex flex-wrap gap-2">
                      {[...(stack!.packaging||[]), ...(stack!.containers||[]), ...(stack!.ci||[])].map((t, i) => (
                        <div key={i} className="badge badge-outline">{t}</div>
                      ))}
                    </div>
                  </div>
                </div>
              ) : (!loading && (
                <div className="text-sm opacity-70">No stack data.</div>
              ))}
            </div>
          </div>
        )}

        


        

        {hasAnalyzed && reportOpts.quality && (
          <div className="card bg-base-100 border border-base-300 shadow-sm">
            <div className="card-body">
              <h3 className="card-title">Code Quality {analysis && qualityStatus(analysis) && (
                <span className={`badge badge-${qualityStatus(analysis)!.color} ml-2`}>{qualityStatus(analysis)!.label}</span>
              )}</h3>
              {loading && !analysis && (
                <div className="grid md:grid-cols-3 gap-4 items-start">
                  <div>
                    <div className="skeleton h-4 w-32 mb-2" />
                    <div className="skeleton h-8 w-16" />
                    <div className="skeleton h-3 w-24 mt-2" />
                  </div>
                  <div>
                    <div className="skeleton h-4 w-24 mb-2" />
                    <div className="skeleton h-8 w-12" />
                    <div className="flex gap-2 mt-2">
                      <div className="skeleton h-6 w-16" />
                      <div className="skeleton h-6 w-16" />
                      <div className="skeleton h-6 w-16" />
                    </div>
                    <div className="skeleton h-32 w-full mt-3" />
                  </div>
                  <div>
                    <div className="skeleton h-4 w-20 mb-2" />
                    <div className="space-y-2">
                      <div className="skeleton h-3 w-3/4" />
                      <div className="skeleton h-3 w-2/3" />
                      <div className="skeleton h-3 w-1/2" />
                    </div>
                  </div>
                </div>
              )}
              {analysis ? (
                <div className="grid md:grid-cols-3 gap-4 items-start">
                  <div>
                    <div className="font-semibold mb-1">Maintainability</div>
                    <div className="text-2xl">
                      {analysis!.mi_avg != null ? analysis!.mi_avg!.toFixed(1) : '—'}
                    </div>
                    <div className="text-sm opacity-70">Average MI</div>
                    <div className="mt-3 grid grid-cols-2 gap-2 text-sm">
                      <div>
                        <div className="opacity-70">Grade</div>
                        <div className="font-semibold">{analysis!.grade ?? '—'}</div>
                      </div>
                      <div>
                        <div className="opacity-70">Coverage</div>
                        <div className="font-semibold">{analysis!.coverage_pct != null ? `${Number(analysis!.coverage_pct).toFixed(1)}%` : '—'}</div>
                      </div>
                    </div>
                  </div>
                  <div>
                    <div className="font-semibold mb-1">flake8</div>
                    <div className="text-2xl">{analysis!.flake8?.total ?? 0}</div>
                    {analysis!.by_severity && Object.keys(analysis!.by_severity).length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-2 text-xs">
                        {Object.entries(analysis!.by_severity as Record<string, number>).map(([k,v]: [string, number]) => (
                          <div key={k} className={`badge ${k==='error'?'badge-error':(k==='warning'?'badge-warning':'badge-ghost')}`}>{k}: {v as number}</div>
                        ))}
                      </div>
                    )}
                    <div className="mt-2 flex flex-wrap gap-2">
                      {Object.entries(analysis!.flake8?.by_code || {}).slice(0, 6).map(([code, cnt]: [string, number]) => (
                        <div key={code} className="badge badge-outline">{code}: {cnt as number}</div>
                      ))}
                    </div>
                    {analysis!.flake8 && Object.keys(analysis!.flake8.by_code || {}).length > 0 && (
                      <div className="mt-3">
                        <div className="font-semibold mb-1 text-sm">Top rules</div>
                        <div className="overflow-x-auto">
                          <table className="table table-compact">
                            <thead>
                              <tr>
                                <th>Rule</th>
                                <th className="text-right">Count</th>
                              </tr>
                            </thead>
                            <tbody>
                              {(Object.entries(analysis!.flake8!.by_code || {}) as Array<[string, number]>)
                                .sort((a: [string, number], b: [string, number])=> (b[1] as number) - (a[1] as number))
                                .slice(0,8)
                                .map(([rule, count]: [string, number]) => {
                                  const url = ruleDocUrl(String(rule))
                                  return (
                                    <tr key={rule}>
                                      <td className="font-mono text-xs">
                                        {url ? (<a href={url} className="link" target="_blank" rel="noreferrer">{rule}</a>) : rule}
                                      </td>
                                      <td className="text-right text-xs">{count as number}</td>
                                    </tr>
                                  )
                                })}
                            </tbody>
                          </table>
                        </div>
                        {/* Mini bar chart for top rules */}
                        <div className="mt-3 h-40">
                          <ResponsiveContainer width="100%" height="100%">
                            <BarChart data={(Object.entries(analysis!.flake8!.by_code || {}) as Array<[string, number]>)
                              .sort((a: [string, number], b: [string, number])=> (b[1] as number) - (a[1] as number))
                              .slice(0,8)
                              .map(([rule, count]: [string, number]) => ({ rule, count }))} margin={{ left: 6, right: 6, top: 4, bottom: 4 }}>
                              <XAxis dataKey="rule" hide />
                              <YAxis hide />
                              <Tooltip formatter={(v:any)=>[v,'count']} labelFormatter={(l)=>String(l)} />
                              <Bar dataKey="count" fill="#6366f1" radius={[3,3,0,0]} />
                            </BarChart>
                          </ResponsiveContainer>
                        </div>
                      </div>
                    )}
                  </div>
                  <div>
                    <div className="font-semibold mb-1">Advice</div>
                    {analysis!.advice?.length ? (
                      <ul className="list-disc pl-5 text-sm">
                        {analysis!.advice.map((a: string, i: number) => <li key={i}>{a}</li>)}
                      </ul>
                    ) : (
                      <div className="opacity-70 text-sm">No advice</div>
                    )}
                  </div>
                </div>
              ) : (!loading && (
                <div className="text-sm opacity-70">No analysis available (non-Python repo or skipped).</div>
              ))}
            </div>
          </div>
        )}

        {hasAnalyzed && reportOpts.architecture && (
          <div className="card bg-base-100 border border-base-300 shadow-sm">
            <div className="card-body">
              <h3 className="card-title">Architecture Graph</h3>
              {arch ? (
                <>
                  <div className="mb-3 text-sm opacity-80">
                    Nodes: {arch.stats?.node_count ?? 0} · Edges: {arch.stats?.edge_count ?? 0} · Internal: {arch.stats?.internal_nodes ?? 0} · External: {arch.stats?.external_nodes ?? 0}
                  </div>
                  <Suspense fallback={<div className="h-64 skeleton rounded-md" />}>
                    <ArchGraphView data={{ nodes: arch.nodes, edges: arch.edges }} langFilter={archLang} onLangChange={refetchArchWithLang} />
                  </Suspense>
                </>
              ) : (
                <div className="text-sm opacity-70">
                  {sectionErrors['arch'] ? (
                    `Failed to load architecture: ${sectionErrors['arch']}`
                  ) : loading ? (
                    <div className="h-64 skeleton rounded-md" />
                  ) : (
                    'No graph available for this repository.'
                  )}
                </div>
              )}
            </div>
          </div>
        )}

        {hasAnalyzed && reportOpts.community && (
          <div className="card bg-base-100 border border-base-300 shadow-sm">
            <div className="card-body">
              <h3 className="card-title">Community Health</h3>
              {!community && loading && (
                <div className="grid md:grid-cols-4 gap-4 items-start">
                  <div>
                    <div className="skeleton h-8 w-16 mb-1" />
                    <div className="skeleton h-3 w-24" />
                  </div>
                  <div className="md:col-span-3">
                    <div className="flex flex-wrap gap-2">
                      <div className="skeleton h-6 w-28" />
                      <div className="skeleton h-6 w-36" />
                      <div className="skeleton h-6 w-24" />
                    </div>
                  </div>
                </div>
              )}
              {community ? (
              <div className="grid md:grid-cols-4 gap-4 items-start">
                <div>
                  <div className="font-semibold text-2xl">{community.score}</div>
                  <div className="text-sm opacity-70">Readiness Score</div>
                </div>
                <div className="md:col-span-3">
                  <div className="flex flex-wrap gap-2">
                    {(() => {
                      const repoUrl = meta ? `https://github.com/${meta.full_name}` : ''
                      const items: Array<{label: string, ok: boolean, href?: string, title: string}> = [
                        { label: 'CONTRIBUTING', ok: community.contributing, href: `${repoUrl}/blob/HEAD/CONTRIBUTING.md`, title: 'Guidelines for contributors' },
                        { label: 'CODE_OF_CONDUCT', ok: community.code_of_conduct, href: `${repoUrl}/blob/HEAD/CODE_OF_CONDUCT.md`, title: 'Expected behavior policy' },
                        { label: 'SECURITY', ok: community.security, href: `${repoUrl}/blob/HEAD/SECURITY.md`, title: 'Security policy and reporting' },
                        { label: 'SUPPORT', ok: community.support, href: `${repoUrl}/blob/HEAD/SUPPORT.md`, title: 'How to get help' },
                        { label: 'FUNDING', ok: community.funding, href: `${repoUrl}/blob/HEAD/.github/FUNDING.yml`, title: 'Funding links' },
                        { label: 'CODEOWNERS', ok: community.codeowners, href: `${repoUrl}/blob/HEAD/CODEOWNERS`, title: 'Ownership rules' },
                        { label: 'ISSUE TEMPLATES', ok: community.issue_templates, href: `${repoUrl}/tree/HEAD/.github/ISSUE_TEMPLATE`, title: 'Issue templates' },
                        { label: 'PR TEMPLATE', ok: community.pr_template, href: `${repoUrl}/blob/HEAD/.github/PULL_REQUEST_TEMPLATE.md`, title: 'Pull Request Template' },
                        { label: 'DOCS DIR', ok: community.docs_dir, href: `${repoUrl}/tree/HEAD/docs`, title: 'Project documentation directory' },
                      ]
                      return (
                        <>
                          {items.map((it) => (
                            it.href ? (
                              <a key={it.label} href={it.href} title={it.title} target="_blank" rel="noreferrer" className={`badge ${it.ok ? 'badge-success' : 'badge-outline'}`}>{it.label}</a>
                            ) : (
                              <div key={it.label} title={it.title} className={`badge ${it.ok ? 'badge-success' : 'badge-outline'}`}>{it.label}</div>
                            )
                          ))}
                          {community.discussions_enabled != null && (
                            <a href={`${repoUrl}/discussions`} title="GitHub Discussions" target="_blank" rel="noreferrer" className={`badge ${community.discussions_enabled ? 'badge-success' : 'badge-outline'}`}>DISCUSSIONS</a>
                          )}
                        </>
                      )
                    })()}
                  </div>
                  {community.missing?.length > 0 && meta && (
                    <div className="mt-2 text-sm">
                      <div className="opacity-80 mb-1">Missing:</div>
                      <div className="flex flex-wrap gap-2">
                        {community.missing.map((m: string) => {
                          const b = meta.default_branch || 'HEAD'
                          const map: Record<string, {href: string, label: string, title: string}> = {
                            contributing: { href: `https://github.com/${meta.full_name}/new/${b}/?filename=CONTRIBUTING.md`, label: 'Add CONTRIBUTING.md', title: 'Create CONTRIBUTING.md at repo root' },
                            code_of_conduct: { href: `https://github.com/${meta.full_name}/new/${b}/?filename=CODE_OF_CONDUCT.md`, label: 'Add CODE_OF_CONDUCT.md', title: 'Create CODE_OF_CONDUCT.md at repo root' },
                            security: { href: `https://github.com/${meta.full_name}/new/${b}/?filename=SECURITY.md`, label: 'Add SECURITY.md', title: 'Create SECURITY.md at repo root' },
                            support: { href: `https://github.com/${meta.full_name}/new/${b}/?filename=SUPPORT.md`, label: 'Add SUPPORT.md', title: 'Create SUPPORT.md at repo root' },
                            funding: { href: `https://github.com/${meta.full_name}/new/${b}/.github?filename=FUNDING.yml`, label: 'Add FUNDING.yml', title: 'Create .github/FUNDING.yml' },
                            codeowners: { href: `https://github.com/${meta.full_name}/new/${b}/?filename=CODEOWNERS`, label: 'Add CODEOWNERS', title: 'Create CODEOWNERS at repo root' },
                            issue_templates: { href: `https://github.com/${meta.full_name}/new/${b}/.github/ISSUE_TEMPLATE?filename=bug_report.md`, label: 'Add Issue Template', title: 'Create an issue template under .github/ISSUE_TEMPLATE' },
                            pr_template: { href: `https://github.com/${meta.full_name}/new/${b}/.github?filename=PULL_REQUEST_TEMPLATE.md`, label: 'Add PR Template', title: 'Create .github/PULL_REQUEST_TEMPLATE.md' },
                            docs_dir: { href: `https://github.com/${meta.full_name}/new/${b}/docs?filename=README.md`, label: 'Add docs/README.md', title: 'Create docs/README.md' },
                          }
                          const cfg = map[m] || null
                          return cfg ? (
                            <a key={m} href={cfg.href} title={cfg.title} target="_blank" rel="noreferrer" className="badge badge-outline">{cfg.label}</a>
                          ) : null
                        })}
                      </div>
                    </div>
                  )}
                </div>
              </div>
              ) : (!loading && (
                <div className="text-sm opacity-70">No community data.</div>
              ))}
            </div>
          </div>
        )}

        {hasAnalyzed && reportOpts.security && (
          <div className="card bg-base-100 border border-base-300 shadow-sm">
            <div className="card-body">
              <h3 className="card-title">Security & Compliance</h3>
              {!security && loading && (
                <div className="grid md:grid-cols-4 gap-4 items-start">
                  <div>
                    <div className="skeleton h-8 w-16 mb-1" />
                    <div className="skeleton h-3 w-20" />
                  </div>
                  <div className="md:col-span-3 flex flex-wrap gap-2">
                    <div className="skeleton h-6 w-24" />
                    <div className="skeleton h-6 w-20" />
                    <div className="skeleton h-6 w-28" />
                  </div>
                </div>
              )}
              {security ? (
                <>
                  <div className="grid md:grid-cols-4 gap-4 items-start">
                    <div>
                      <div className="font-semibold text-2xl">{security.risk_score}</div>
                      <div className="text-sm opacity-70">Risk Score</div>
                    </div>
                    <div className="md:col-span-3 flex flex-wrap gap-2">
                      {meta && (
                        <>
                          <a href={`https://github.com/${meta.full_name}/blob/HEAD/.github/dependabot.yml`} title="View .github/dependabot.yml" target="_blank" rel="noreferrer" className={`badge ${security.dependabot_config ? 'badge-success' : 'badge-outline'}`}>Dependabot</a>
                          <a href={`https://github.com/${meta.full_name}/tree/HEAD/.github/workflows`} title="View workflows" target="_blank" rel="noreferrer" className={`badge ${security.codeql_workflow ? 'badge-success' : 'badge-outline'}`}>CodeQL</a>
                          <a href={`https://github.com/${meta.full_name}/settings/branches`} title="Open branch protection settings" target="_blank" rel="noreferrer" className={`badge ${security.branch_protection_enabled ? 'badge-success' : 'badge-outline'}`}>Branch Protection</a>
                        </>
                      )}
                    </div>
                  </div>
                  {security.findings?.length > 0 && (
                    <ul className="list-disc pl-5 text-sm mt-2">
                      {security.findings.map((f: string, i: number) => <li key={i}>{f}</li>)}
                    </ul>
                  )}
                </>
              ) : (!loading && (
                <div className="text-sm opacity-70">No security data.</div>
              ))}
            </div>
          </div>
        )}

        {hasAnalyzed && reportOpts.hotspots && (
          <div className="card bg-base-100 border border-base-300 shadow-sm">
            <div className="card-body">
              <h3 className="card-title">File Hotspots</h3>
              {loading && !hotspots && (
                <div className="overflow-x-auto">
                  <table className="table table-zebra">
                    <thead>
                      <tr>
                        <th>Path</th>
                        <th>Changes</th>
                        <th>Last Modified</th>
                        <th>Top Authors</th>
                      </tr>
                    </thead>
                    <tbody>
                      {[...Array(5)].map((_, i) => (
                        <tr key={i}>
                          <td><div className="skeleton h-4 w-64" /></td>
                          <td><div className="skeleton h-4 w-12" /></td>
                          <td><div className="skeleton h-4 w-24" /></td>
                          <td><div className="skeleton h-4 w-40" /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {hotspots?.items?.length ? (
                <div className="overflow-x-auto">
                  <table className="table table-zebra">
                    <thead>
                      <tr>
                        <th>Path</th>
                        <th>Changes</th>
                        <th>Last Modified</th>
                        <th>Top Authors</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(hotspots!.items.slice(0, hotspotsCount)).map((it, i) => (
                        <tr key={i}>
                          <td className="font-mono text-xs">{it.path}</td>
                          <td>{it.changes}</td>
                          <td className="text-xs opacity-80">{it.last_modified || '—'}</td>
                          <td className="text-xs">
                            {(it.top_authors || []).map((a, j) => (
                              <span key={j} className="badge badge-outline mr-1">{a.login || 'unknown'}: {a.commits}</span>
                            ))}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {hotspots!.items.length > hotspotsCount && (
                    <div className="mt-2">
                      <button className="btn btn-sm" onClick={() => setHotspotsCount(c => c + 5)}>See more</button>
                    </div>
                  )}
                </div>
              ) : (
                <div className="text-sm opacity-70">
                  {sectionErrors['hotspots'] ? `Failed to load hotspots: ${sectionErrors['hotspots']}` : (loading ? 'Loading…' : 'No hotspots available.')}
                </div>
              )}
            </div>
          </div>
        )}
        {hasAnalyzed && reportOpts.readme && (
          <div className="card bg-base-100 border border-base-300 shadow-sm">
            <div className="card-body">
              <h3 className="card-title">README Visuals</h3>
              {loading && !readmeTree && (
                <div className="space-y-2">
                  <div className="skeleton h-4 w-1/2" />
                  <div className="skeleton h-4 w-2/3" />
                  <div className="skeleton h-4 w-1/3" />
                </div>
              )}
              {readmeTree && (
                <div className="mt-2">
                  <Suspense fallback={<div className="h-40 skeleton rounded-md" />}>
                    <ReadmeVisuals root={readmeTree} visibleCount={readmeCount} />
                  </Suspense>
                  {countReadmeSections(readmeTree) > readmeCount && (
                    <div className="mt-2">
                      <button className="btn btn-sm" onClick={() => setReadmeCount(c => c + 5)}>See more</button>
                    </div>
                  )}
                </div>
              )}
              {!loading && !readmeTree && (
                <div className="text-sm opacity-70">No README flow available.</div>
              )}
            </div>
          </div>
        )}

        {hasAnalyzed && reportOpts.contributors && (
          <div className="card bg-base-100 border border-base-300 shadow-sm">
            <div className="card-body">
              <h3 className="card-title">Top Contributors</h3>
              {(() => { const info = busFactorInfo(); return info ? (
                <div className="mb-2 text-sm opacity-80">
                  Bus factor ~ <span className="font-semibold">{info.busFactor}</span> · Top contributor share: <span className="font-semibold">{Math.round(info.topShare * 100)}%</span>
                </div>
              ) : null })()}
              {loading && contributors.length === 0 && (
                <div className="overflow-x-auto">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>User</th>
                        <th>Contributions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {[...Array(5)].map((_, i) => (
                        <tr key={i}>
                          <td>
                            <div className="flex items-center gap-3">
                              <div className="skeleton w-8 h-8 rounded-full" />
                              <div className="skeleton h-4 w-32" />
                            </div>
                          </td>
                          <td><div className="skeleton h-4 w-16" /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {contributors.length > 0 ? (
                <>
                  <div className="overflow-x-auto">
                    <table className="table">
                      <thead>
                        <tr>
                          <th>User</th>
                          <th>Contributions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {contributors.slice(0, contributorsCount).map(c => (
                          <tr key={c.login}>
                            <td>
                              <div className="flex items-center gap-3">
                                {c.avatar_url && <img src={c.avatar_url} className="w-8 h-8 rounded-full" />}
                                <a href={c.profile_url} className="link" target="_blank" rel="noreferrer">{c.login}</a>
                              </div>
                            </td>
                            <td>{c.contributions}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {contributors.length > contributorsCount && (
                    <div className="mt-2">
                      <button className="btn btn-sm" onClick={() => setContributorsCount(c => c + 5)}>See more</button>
                    </div>
                  )}
                </>
              ) : (!loading && (
                <div className="text-sm opacity-70">No contributor data.</div>
              ))}
            </div>
          </div>
        )}

        {hasAnalyzed && reportOpts.activity && (
          <div className="card bg-base-100 border border-base-300 shadow-sm">
            <div className="card-body">
              <h3 className="card-title">Recent Activity</h3>
              {loading && weekly.length === 0 && (
                <div>
                  <div className="flex items-end h-24 w-full gap-1">
                    {[...Array(12)].map((_, i) => (
                      <div key={i} className="bg-base-200 skeleton" style={{ height: `${10 + (i%4)*20}%`, width: `${100/12}%` }} />
                    ))}
                  </div>
                  <div className="skeleton h-3 w-48 mt-2" />
                </div>
              )}
              {weekly.length > 0 ? (
                <div>
                  <div className="flex items-end h-24 w-full">
                    {weekly.map((v: number, i: number) => (
                      <div
                        key={i}
                        title={`${v} commits`}
                        className="bg-primary"
                        style={{ height: `${Math.min(100, v * 10)}%`, width: `${100 / weekly.length}%` }}
                      />
                    ))}
                  </div>
                  <div className="text-xs opacity-70 mt-1">Commits per week (last {weekly.length} weeks)</div>
                </div>
              ) : (!loading && (
                <div className="text-sm opacity-70">No recent activity data.</div>
              ))}
            </div>
          </div>
        )}

        {hasAnalyzed && (reportOpts.related || reportOpts.author_repos) && (
          <div className="border-t border-base-300 pt-4">
            <div className="grid md:grid-cols-2 gap-6">
              {reportOpts.related && (
                <div className="card bg-base-100 border border-base-300 shadow-sm">
                  <div className="card-body">
                    <h3 className="card-title">Related Top Repos</h3>
                    {loading && !related && (
                      <div className="space-y-3">
                        {[...Array(5)].map((_, i) => (
                          <div key={i} className="flex flex-col gap-1">
                            <div className="skeleton h-4 w-2/3" />
                            <div className="skeleton h-3 w-1/2" />
                          </div>
                        ))}
                      </div>
                    )}
                    {sectionErrors['related'] && (
                      <div className="text-sm opacity-70">Failed to load related repos: {sectionErrors['related']}</div>
                    )}
                    {related && related.length > 0 && (
                      <ul className="space-y-3">
                        {related.map((r, i) => (
                          <li key={i} className="text-sm">
                            <div className="flex items-center justify-between gap-2">
                              <div className="font-medium">{r.full_name}</div>
                              <div className="opacity-70">{r.language || '—'} · ⭐ {r.stars}</div>
                            </div>
                            {r.description && <div className="opacity-80 text-xs mt-0.5 line-clamp-2">{r.description}</div>}
                            <div className="mt-2 flex gap-2">
                              <a href={r.html_url || `https://github.com/${r.full_name}`} target="_blank" rel="noreferrer" className="btn btn-xs">GitHub</a>
                              <button className="btn btn-xs btn-primary" onClick={() => analyzeSelectedRepo(r.full_name)}>Analyze</button>
                            </div>
                          </li>
                        ))}
                      </ul>
                    )}
                    {related && related.length === 0 && !loading && (
                      <div className="text-sm opacity-70">No related repositories found.</div>
                    )}
                  </div>
                </div>
              )}

              {reportOpts.author_repos && (
                <div className="card bg-base-100 border border-base-300 shadow-sm">
                  <div className="card-body">
                    <h3 className="card-title">Other Top Repos from the Author</h3>
                    {loading && !authorRepos && (
                      <div className="space-y-3">
                        {[...Array(5)].map((_, i) => (
                          <div key={i} className="flex flex-col gap-1">
                            <div className="skeleton h-4 w-2/3" />
                            <div className="skeleton h-3 w-1/2" />
                          </div>
                        ))}
                      </div>
                    )}
                    {sectionErrors['author_repos'] && (
                      <div className="text-sm opacity-70">Failed to load author's repos: {sectionErrors['author_repos']}</div>
                    )}
                    {authorRepos && authorRepos.length > 0 && (
                      <ul className="space-y-3">
                        {authorRepos.map((r, i) => (
                          <li key={i} className="text-sm">
                            <div className="flex items-center justify-between gap-2">
                              <div className="font-medium">{r.full_name}</div>
                              <div className="opacity-70">{r.language || '—'} · ⭐ {r.stars}</div>
                            </div>
                            {r.description && <div className="opacity-80 text-xs mt-0.5 line-clamp-2">{r.description}</div>}
                            <div className="mt-2 flex gap-2">
                              <a href={r.html_url || `https://github.com/${r.full_name}`} target="_blank" rel="noreferrer" className="btn btn-xs">GitHub</a>
                              <button className="btn btn-xs btn-primary" onClick={() => analyzeSelectedRepo(r.full_name)}>Analyze</button>
                            </div>
                          </li>
                        ))}
                      </ul>
                    )}
                    {authorRepos && authorRepos.length === 0 && !loading && (
                      <div className="text-sm opacity-70">No other repositories found.</div>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
    </div>
    </div>
  )
}

export default App
