import React, { useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeRaw from 'rehype-raw'
import type { ReadmeNode } from '../types/readme'

/*
  ReadmeVisuals
  - Renders a horizontal flow of key README sections (visual summary).
  - Each stage shows a circle with an icon and a title, and a card (box) either above or below
    the circle with a short summary and useful links/snippet.
  - Uses the structure provided by backend /readme-structure endpoint (ReadmeNode tree).
*/

type Props = {
  root: ReadmeNode
  visibleCount?: number
}

// Single icon style for all circles (user does not care about different icons)
function iconFor(): string { return '🔵' }

function normalizeLabel(s: string): string {
  // Strip images ![alt](url) and convert [text](url) -> text, then compact
  let t = s
  t = t.replace(/!\[[^\]]*\]\([^)]*\)/g, '')
  // Remove empty-text links [](...)
  t = t.replace(/\[\]\([^)]*\)/g, '')
  // Convert [text](url) -> text
  t = t.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
  t = t.replace(/`/g, '').replace(/\*/g, '')
  // Replace common HTML entities like &middot;
  t = t.replace(/&[a-z]+;/gi, ' ')
  // Collapse extraneous punctuation
  t = t.replace(/[()\[\]{}]/g, ' ')
  t = t.replace(/\s+/g, ' ').trim()
  return t
}

function BoxContent({ title, node }: { title: string; node: ReadmeNode }) {
  const links = node.links || []
  const code = (node as any).code as { lang?: string; content: string } | undefined

  // Extract additional top-of-body badges if the markdown starts with pure badge lines
  const topBadgeParse = useMemo(() => {
    const result: { badges: { image: string; href?: string | null; alt?: string | null }[]; startIndex: number } = { badges: [], startIndex: 0 }
    const md = (node as any).markdown as string | undefined
    if (!md) return result
    const lines = md.split(/\r?\n/)
    const badgeTokenRe = /(\[!\[[^\]]*\]\(([^)]+)\)\]\(([^)]+)\))|(!\[[^\]]*\]\(([^)]+)\))/g
    const isPureBadgeLine = (s: string) => {
      const t = s.trim()
      if (!t) return true
      // if after removing badge tokens and whitespace nothing remains, it's a pure badge line
      const stripped = t.replace(badgeTokenRe, '').replace(/&[a-z]+;/gi, '').replace(/\s+/g, '')
      return stripped.length === 0
    }
    let idx = 0
    while (idx < lines.length && isPureBadgeLine(lines[idx])) {
      const line = lines[idx]
      let m: RegExpExecArray | null
      badgeTokenRe.lastIndex = 0
      while ((m = badgeTokenRe.exec(line)) !== null) {
        if (m[2] && m[3]) {
          // linked image badge
          result.badges.push({ image: m[2], href: m[3], alt: undefined })
        } else if (m[5]) {
          result.badges.push({ image: m[5], href: undefined, alt: undefined })
        }
      }
      idx++
    }
    result.startIndex = idx
    return result
  }, [(node as any).markdown])

  // Dev-only: log raw markdown to diagnose mismatches
  useEffect(() => {
    // @ts-ignore
    if (import.meta && (import.meta as any).env && (import.meta as any).env.DEV && (node as any).markdown) {
      // Log only the first 600 chars to avoid noise
      const md: string = (node as any).markdown as string
      const preview = md.length > 600 ? md.slice(0, 600) + '\n…(truncated)…' : md
      console.debug('[ReadmeVisuals] Section:', title, '\n--- RAW MARKDOWN ---\n', preview)
    }
  }, [title, (node as any).markdown])

  // Render inline markdown (bold and [text](url)) as React nodes safely
  const renderInline = (text: string): (string | JSX.Element)[] => {
    const parts: (string | JSX.Element)[] = []
    let remaining = text
    const linkRe = /\[([^\]]+)\]\(([^)]+)\)/g
    const boldRe = /\*\*([^*]+)\*\*/g
    // Process links first by splitting
    let lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = linkRe.exec(remaining)) !== null) {
      const before = remaining.slice(lastIndex, m.index)
      if (before) {
        // process bold in "before"
        parts.push(...renderBold(before))
      }
      parts.push(
        <a key={parts.length} href={m[2]} target="_blank" rel="noreferrer" className="underline text-white/90 hover:text-white">{m[1]}</a>
      )
      lastIndex = m.index + m[0].length
    }
    const tail = remaining.slice(lastIndex)
    if (tail) parts.push(...renderBold(tail))
    return parts

    function renderBold(s: string): (string | JSX.Element)[] {
      const out: (string | JSX.Element)[] = []
      let idx = 0
      let bm: RegExpExecArray | null
      while ((bm = boldRe.exec(s)) !== null) {
        const pre = s.slice(idx, bm.index)
        if (pre) out.push(pre)
        out.push(<strong key={out.length}>{bm[1]}</strong>)
        idx = bm.index + bm[0].length
      }
      const rest = s.slice(idx)
      if (rest) out.push(rest)
      return out
    }
  }

  // Convert snippet lines into paragraphs and bullet lists
  const renderSnippet = (snippet: string): JSX.Element => {
    const lines = snippet.split(/\r?\n/)
    const blocks: JSX.Element[] = []
    let list: string[] = []
    const flushList = () => {
      if (list.length > 0) {
        blocks.push(
          <ul key={blocks.length} className="list-disc ml-5 space-y-1">
            {list.map((it, i) => <li key={i} className="marker:text-white/90">{renderInline(it)}</li>)}
          </ul>
        )
        list = []
      }
    }
    for (const raw of lines) {
      const line = raw.replace(/\u00A0/g, ' ').trim()
      if (!line) { flushList(); continue }
      // Standard list markers at start
      const m = /^[-*•]\s+(.+)/.exec(line)
      if (m) { list.push(m[1]); continue }

      // Inline bullets separated by * or • within the same line
      const inlineStar = line.split(/\s+\*\s+/).filter(Boolean)
      if (inlineStar.length >= 2) { list.push(...inlineStar); continue }
      const inlineDot = line.split(/\s+•\s+/).filter(Boolean)
      if (inlineDot.length >= 2) { list.push(...inlineDot); continue }

      // Fallback paragraph
      flushList()
      blocks.push(<p key={blocks.length} className="text-xs opacity-95">{renderInline(line)}</p>)
    }
    flushList()
    return <div className="space-y-2">{blocks}</div>
  }

  return (
    <div className="rounded-lg bg-blue-500 text-white shadow-md">
      <div className="py-4 px-6 space-y-3">
        <div className="text-xs font-bold tracking-wide">{normalizeLabel(title).toUpperCase()}</div>
        {((Array.isArray((node as any).badges) && (node as any).badges.length > 0) || topBadgeParse.badges.length > 0) && (
          <div className="flex flex-wrap items-center gap-2">
            {[...((node as any).badges || []), ...topBadgeParse.badges].map((b: any, i: number) => (
              b?.href ? (
                <a key={i} href={b.href} target="_blank" rel="noreferrer">
                  <img src={b.image} alt={b.alt || ''} className="h-5 inline-block align-middle" />
                </a>
              ) : (
                <img key={i} src={b.image} alt={b.alt || ''} className="h-5 inline-block align-middle" />
              )
            ))}
          </div>
        )}
        {node.markdown ? (
          <div className="text-xs">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              rehypePlugins={[rehypeRaw]}
              components={{
                a: ({node: _n, children, ...props}: any) => (
                  <a {...props} target="_blank" rel="noreferrer" className="underline text-white/90 hover:text-white">{children}</a>
                ),
                code: ({inline, className, children, ...props}: any) => (
                  inline ? (
                    <code className={`px-1 rounded bg-white/10 ${className || ''}`} {...props}>{children}</code>
                  ) : (
                    <pre className="bg-base-100 text-base-content rounded p-3 text-xs overflow-x-auto"><code className={className} {...props}>{children}</code></pre>
                  )
                ),
                img: ({node: _m, ...props}: any) => (
                  <img {...props} alt={props.alt || ''} style={{ maxWidth: '100%' }} />
                ),
                ul: ({node: _u, children, ...props}: any) => (
                  <ul {...props} className="list-disc ml-5 space-y-1">
                    {children}
                  </ul>
                ),
                ol: ({node: _o, children, ...props}: any) => (
                  <ol {...props} className="list-decimal ml-5 space-y-1">
                    {children}
                  </ol>
                ),
                li: ({node: _l, children, ...props}: any) => (
                  <li {...props} className="marker:text-white/90">
                    {children}
                  </li>
                ),
                h1: ({children}: any) => <>{children}</>,
                h2: ({children}: any) => <>{children}</>,
                h3: ({children}: any) => <>{children}</>,
                h4: ({children}: any) => <>{children}</>,
                h5: ({children}: any) => <>{children}</>,
                h6: ({children}: any) => <>{children}</>,
              }}
            >
              {/* Remove noisy heading-line that contains badges/links (e.g., "React · [License](...) [npm](...) ...") */}
              {(() => {
                const md = node.markdown || ''
                const lines = md.split(/\r?\n/)
                // Only strip the pure-badge lines we already parsed; show everything else verbatim
                const start = topBadgeParse.startIndex > 0 ? topBadgeParse.startIndex : 0
                return lines.slice(start).join('\n')
              })()}
            </ReactMarkdown>
          </div>
        ) : node.snippet ? (
          <div className="text-xs">{renderSnippet(node.snippet)}</div>
        ) : null}
        {!node.markdown && code?.content && (
          <div>
            <div className="text-[10px] uppercase tracking-wide opacity-80 mb-1">{code.lang || 'code'}</div>
            <pre className="bg-base-100 text-base-content rounded p-3 text-xs overflow-x-auto"><code>{code.content}</code></pre>
          </div>
        )}
        {!node.markdown && links.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {links.map((l, i) => (
              <a key={i} href={l.url} target="_blank" rel="noreferrer" className="badge badge-outline bg-white/10 text-white hover:bg-white/20">
                {l.text}
              </a>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function Legend({ items }: { items: string[] }) {
  return (
    <div className="rounded-xl bg-blue-50 p-3 border border-blue-100">
      <div className="text-sm font-semibold text-blue-900 mb-2">Legend</div>
      <div className="space-y-2">
        {items.map((t, i) => (
          <div key={i} className="rounded-md bg-blue-100 text-blue-800 text-xs font-semibold px-3 py-2">
            {normalizeLabel(t)}
          </div>
        ))}
      </div>
    </div>
  )
}

function flatten(root: ReadmeNode): ReadmeNode[] {
  const out: ReadmeNode[] = []
  const dfs = (n: ReadmeNode) => {
    out.push(n)
    ;(n.children || []).forEach(dfs)
  }
  dfs(root)
  return out
}

export default function ReadmeVisuals({ root, visibleCount }: Props) {
  // Show all sections in document order (excluding the synthetic ROOT)
  const sections = useMemo(() => {
    const all = flatten(root).filter(n => n.level > 0)
    if (typeof visibleCount === 'number' && visibleCount >= 0) {
      return all.slice(0, visibleCount)
    }
    return all
  }, [root, visibleCount])

  // Connectors
  const containerRef = useRef<HTMLDivElement>(null)
  const circleRefs = useRef<(HTMLDivElement | null)[]>([])
  const [conn, setConn] = useState<{ d: string; w: number; h: number }>({ d: '', w: 0, h: 0 })
  // Circle visual size (reduced by ~1/3 from previous 64px)
  const CIRCLE_SIZE = 43 // px

  useEffect(() => {
    function compute() {
      const c = containerRef.current
      if (!c) return
      const cb = c.getBoundingClientRect()
      const pts: { x: number; y: number }[] = []
      for (const el of circleRefs.current) {
        if (!el) continue
        const r = el.getBoundingClientRect()
        pts.push({ x: r.left + r.width / 2 - cb.left, y: r.top + r.height / 2 - cb.top })
      }
      if (pts.length < 2) {
        setConn({ d: '', w: cb.width, h: c.scrollHeight })
        return
      }
      // Draw a single straight vertical line along the left margin through all circles
      const avgX = pts.reduce((a, p) => a + p.x, 0) / pts.length
      const x = Math.max(4, Math.min(cb.width - 8, avgX))
      const topY = Math.min(...pts.map(p => p.y))
      const bottomY = Math.max(...pts.map(p => p.y))
      let d = `M ${x} ${topY} L ${x} ${bottomY}`
      setConn({ d, w: cb.width, h: c.scrollHeight })
    }
    compute()
    const ro = new ResizeObserver(() => compute())
    if (containerRef.current) ro.observe(containerRef.current)
    window.addEventListener('resize', compute)
    return () => { ro.disconnect(); window.removeEventListener('resize', compute) }
  }, [sections.length])

  return (
    <div className="w-full">
      <div className="text-xs opacity-70 mb-2">Auto-grouped key README sections</div>
      {/* Full-width alternating rows with edge circles + connectors */}
      <div ref={containerRef} className="relative">
        {conn.d && (
          <svg className="absolute inset-0 z-20" width={conn.w} height={conn.h} style={{ pointerEvents: 'none' }}>
            <path d={conn.d} fill="none" stroke="#d1d5db" strokeWidth="2" strokeLinecap="round" />
          </svg>
        )}
        <div className="space-y-10 relative">
          {sections.map((node, idx) => {
            return (
              <div key={node.id} className="relative ml-6">
                {/* Circle overlapping outer edge */}
                <div ref={el => { circleRefs.current[idx] = el }}
                     className={`absolute top-1/2 -translate-y-1/2 z-40 -left-4`}>
                  <a href={node.url} target="_blank" rel="noreferrer" title={node.title}>
                    <div className="rounded-full bg-blue-100 border border-blue-300 flex items-center justify-center text-xl text-blue-700 shadow-sm"
                         style={{ width: `${CIRCLE_SIZE}px`, height: `${CIRCLE_SIZE}px` }}>
                      <span>{iconFor()}</span>
                    </div>
                  </a>
                </div>
                {/* Box taking all width; pull border under circle and offset content */}
                <div className={`pr-2`} style={{ paddingLeft: `${CIRCLE_SIZE}px`, marginLeft: `-${Math.round(CIRCLE_SIZE/2)}px` }}>
                  <BoxContent title={node.title} node={node} />
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
