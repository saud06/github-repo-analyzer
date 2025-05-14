import React, { useEffect, useMemo, useRef, useState } from 'react'

export type ArchGraph = {
  nodes: { id: string; label: string; type: 'internal' | 'external'; meta?: { lang?: string; pkg?: { manager: string; name: string; version: string } } }[]
  edges: { source: string; target: string; weight: number }[]
}

type Props = { data: ArchGraph; langFilter: 'all' | 'python' | 'js' | 'npm' | 'go' | 'java' | 'csharp' | 'php' | 'ruby'; onLangChange: (v: 'all' | 'python' | 'js' | 'npm' | 'go' | 'java' | 'csharp' | 'php' | 'ruby') => void }

export default function ArchGraphView({ data, langFilter, onLangChange }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState<{ w: number; h: number }>({ w: 800, h: 500 })
  type ViewMode = 'both' | 'internal' | 'external'
  const [hideExternal, setHideExternal] = useState(false) // kept for backward compatibility with UI; superseded by viewMode
  const [viewMode, setViewMode] = useState<ViewMode>('both')
  const [minWeight, setMinWeight] = useState(2)
  type LabelMode = 'active' | 'all' | 'none'
  const [labelMode, setLabelMode] = useState<LabelMode>('active')
  const [nodeCap, setNodeCap] = useState(80) // total nodes shown (split across internal/external)
  const [selected, setSelected] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const svgRef = useRef<SVGSVGElement | null>(null)

  useEffect(() => {
    const onResize = () => {
      const el = containerRef.current
      if (!el) return
      const b = el.getBoundingClientRect()
      setSize({ w: Math.max(400, b.width), h: 500 })
    }
    onResize()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  const layout = useMemo(() => {
    // Primary filters
    const nodesByView = data.nodes.filter(n => {
      if (viewMode === 'internal') return n.type === 'internal'
      if (viewMode === 'external') return n.type === 'external'
      return (hideExternal ? n.type !== 'external' : true)
    })
    // Language filter
    const nodesFiltered = nodesByView.filter(n => {
      if (langFilter === 'all') return true
      const l = (n.meta?.lang || '').toLowerCase()
      if (langFilter === 'js') return l === 'js' || l === 'npm' // group npm with JS by default
      return l === langFilter
    })
    // compute degrees for ranking
    const deg = new Map<string, number>()
    for (const e of data.edges) {
      deg.set(e.source, (deg.get(e.source) || 0) + 1)
      deg.set(e.target, (deg.get(e.target) || 0) + 1)
    }
    const internalAll = nodesFiltered.filter(n => n.type === 'internal')
    const externalAll = nodesFiltered.filter(n => n.type === 'external')
    const half = Math.max(10, Math.floor(nodeCap / 2))
    const byDeg = (a: {id:string}, b: {id:string}) => (deg.get(b.id)||0) - (deg.get(a.id)||0)
    const internal = internalAll.sort(byDeg).slice(0, half)
    const external = externalAll.sort(byDeg).slice(0, half)
    const leftX = 160
    const rightX = Math.max(size.w - 200, leftX + 200)

    const colY = (count: number, idx: number) => {
      if (count <= 1) return size.h / 2
      const pad = 40
      const span = size.h - pad * 2
      return pad + (idx * span) / (count - 1)
    }

    const pos = new Map<string, { x: number; y: number }>()
    internal.forEach((n, i) => pos.set(n.id, { x: leftX, y: colY(internal.length, i) }))
    external.forEach((n, i) => pos.set(n.id, { x: rightX, y: colY(external.length, i) }))

    const nodes = [...pos.entries()].map(([id, p]) => ({ id, x: p.x, y: p.y }))

    const maxW = data.edges.reduce((m, e) => Math.max(m, e.weight || 0), 1)
    const edges = data.edges
      .filter(e => (e.weight || 0) >= minWeight)
      .filter(e => pos.has(e.source) && pos.has(e.target))
      .slice(0, 400)
      .map(e => ({
        source: pos.get(e.source)!,
        target: pos.get(e.target)!,
        w: Math.max(1, (e.weight || 1) / maxW * 4),
        weight: e.weight || 1,
        from: e.source,
        to: e.target,
      }))

    // adjacency map for highlighting
    const neighbors = new Map<string, Set<string>>()
    for (const n of nodes) {
      neighbors.set(n.id, new Set<string>())
    }
    for (const e of edges) {
      neighbors.get(e.from)?.add(e.to)
      neighbors.get(e.to)?.add(e.from)
    }

    return { nodes, edges, neighbors }
  }, [data, size, hideExternal, minWeight, viewMode, nodeCap, langFilter])

  return (
    <div ref={containerRef} className="w-full">
      <div className="flex flex-wrap items-center gap-4 mb-2">
        <div className="join">
          <button className={`btn btn-sm join-item ${viewMode==='both'?'btn-active':''}`} onClick={()=>setViewMode('both')}>Both</button>
          <button className={`btn btn-sm join-item ${viewMode==='internal'?'btn-active':''}`} onClick={()=>setViewMode('internal')}>Internal</button>
          <button className={`btn btn-sm join-item ${viewMode==='external'?'btn-active':''}`} onClick={()=>setViewMode('external')}>External</button>
        </div>
        <label className="label cursor-pointer gap-2">
          <input type="checkbox" className="checkbox checkbox-sm" checked={hideExternal} onChange={e => setHideExternal(e.target.checked)} />
          <span className="label-text text-sm">Hide external</span>
        </label>
        <label className="label gap-2">
          <span className="label-text text-sm">Min weight</span>
          <input type="range" min={1} max={10} step={1} value={minWeight} onChange={e => setMinWeight(parseInt(e.target.value))} className="range range-xs w-40" />
          <span className="text-xs w-4 text-right">{minWeight}</span>
        </label>
        <label className="label gap-2">
          <span className="label-text text-sm">Nodes</span>
          <input type="range" min={20} max={200} step={10} value={nodeCap} onChange={e => setNodeCap(parseInt(e.target.value))} className="range range-xs w-40" />
          <span className="text-xs w-8 text-right">{nodeCap}</span>
        </label>
        <div className="join">
          <button className={`btn btn-sm join-item ${labelMode==='active'?'btn-active':''}`} onClick={()=>setLabelMode('active')}>Labels: Active</button>
          <button className={`btn btn-sm join-item ${labelMode==='all'?'btn-active':''}`} onClick={()=>setLabelMode('all')}>All</button>
          <button className={`btn btn-sm join-item ${labelMode==='none'?'btn-active':''}`} onClick={()=>setLabelMode('none')}>None</button>
        </div>
        <select className="select select-sm select-bordered" value={langFilter} onChange={e => onLangChange(e.target.value as any)}>
          <option value="all">All languages</option>
          <option value="python">Python</option>
          <option value="js">JS/TS</option>
          <option value="npm">NPM packages</option>
          <option value="go">Go</option>
          <option value="java">Java</option>
          <option value="csharp">C#</option>
          <option value="php">PHP</option>
          <option value="ruby">Ruby</option>
        </select>
        <div className="join">
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                const q = query.trim().toLowerCase()
                if (!q) return
                const hit = data.nodes.find(n => n.id.toLowerCase().includes(q))
                if (hit) setSelected(hit.id)
              }
            }}
            placeholder="Search module..."
            className="input input-sm input-bordered join-item w-48"
          />
          <button
            className="btn btn-sm btn-outline join-item"
            onClick={() => {
              const q = query.trim().toLowerCase()
              if (!q) return
              const hit = data.nodes.find(n => n.id.toLowerCase().includes(q))
              if (hit) setSelected(hit.id)
            }}
          >Focus</button>
        </div>
        <button className="btn btn-sm" onClick={() => { setViewMode('both'); setHideExternal(false); setMinWeight(2); setSelected(null); setQuery(''); setNodeCap(80); setLabelMode('active'); onLangChange('all') }}>Reset</button>
        <div className="ml-auto flex items-center gap-2">
          <button className="btn btn-sm btn-outline" onClick={() => {
            if (!svgRef.current) return
            const serializer = new XMLSerializer()
            const src = serializer.serializeToString(svgRef.current)
            const blob = new Blob([src], { type: 'image/svg+xml;charset=utf-8' })
            const url = URL.createObjectURL(blob)
            const a = document.createElement('a')
            a.href = url
            a.download = 'architecture-graph.svg'
            a.click()
            URL.revokeObjectURL(url)
          }}>Export SVG</button>
          <button className="btn btn-sm btn-outline" onClick={async () => {
            if (!svgRef.current) return
            const serializer = new XMLSerializer()
            const src = serializer.serializeToString(svgRef.current)
            const svgBlob = new Blob([src], { type: 'image/svg+xml;charset=utf-8' })
            const url = URL.createObjectURL(svgBlob)
            const img = new Image()
            img.onload = () => {
              const canvas = document.createElement('canvas')
              canvas.width = svgRef.current!.width.baseVal.value
              canvas.height = svgRef.current!.height.baseVal.value
              const ctx = canvas.getContext('2d')!
              ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--b2') || '#ffffff'
              ctx.fillRect(0,0,canvas.width,canvas.height)
              ctx.drawImage(img, 0, 0)
              canvas.toBlob((pngBlob) => {
                if (!pngBlob) return
                const dl = URL.createObjectURL(pngBlob)
                const a = document.createElement('a')
                a.href = dl
                a.download = 'architecture-graph.png'
                a.click()
                URL.revokeObjectURL(dl)
                URL.revokeObjectURL(url)
              }, 'image/png')
            }
            img.src = url
          }}>Export PNG</button>
        </div>
      </div>
      <div className="mb-2 text-xs opacity-70 flex items-center gap-4">
        <span className="inline-flex items-center gap-1"><span className="inline-block w-3 h-3 rounded-full" style={{background:'#2563eb'}}></span> Internal</span>
        <span className="inline-flex items-center gap-1"><span className="inline-block w-3 h-3 rounded-full" style={{background:'#93c5fd'}}></span> External</span>
        <span className="inline-flex items-center gap-1"><span className="inline-block h-0.5 w-5" style={{background:'#64748b'}}></span> Edge (thicker = higher weight)</span>
      </div>
      <div className="overflow-x-auto">
      <svg id="arch-graph-svg" ref={svgRef} width={size.w} height={size.h} className="bg-base-200 rounded" onClick={() => setSelected(null)}>
        {/* Background capture for clearing selection */}
        <rect x={0} y={0} width={size.w} height={size.h} fill="transparent" />
        {/* Edges */}
        {layout.edges.map((e, i) => {
          const edgeActive = !selected || selected === e.from || selected === e.to
            || layout.neighbors.get(selected || '')?.has(e.from)
            || layout.neighbors.get(selected || '')?.has(e.to)
          const edgeOpacity = edgeActive ? 0.85 : 0.15
          const edgeColor = edgeActive ? '#64748b' : '#cbd5e1'
          return (
          <g key={i}>
            <title>{`${e.from} → ${e.to} (w=${e.weight})`}</title>
            <line x1={e.source.x} y1={e.source.y} x2={e.target.x} y2={e.target.y}
                  stroke={edgeColor} strokeWidth={e.w} strokeOpacity={edgeOpacity} />
          </g>
        )})}
        {/* Nodes */}
        {layout.nodes.map(n => {
          const active = !selected || selected === n.id || layout.neighbors.get(selected || '')?.has(n.id)
          const showLabel = labelMode === 'all' || (labelMode === 'active' && active)
          const fill = active ? '#2563eb' : '#93c5fd'
          const stroke = active ? '#1e3a8a' : '#60a5fa'
          const textOpacity = active ? 1 : 0.35
          const label = n.id.length > 42 ? n.id.slice(0, 39) + '…' : n.id
          return (
            <g key={n.id} transform={`translate(${n.x},${n.y})`} onClick={(e) => { e.stopPropagation(); setSelected(n.id) }} style={{ cursor: 'pointer' }}>
              <title>{n.id}</title>
              <circle r={8} fill={fill} stroke={stroke} strokeWidth={1} />
              {showLabel && (
                <text x={12} y={4} fontSize={11} className="fill-base-content" opacity={textOpacity}>
                  {label}
                </text>
              )}
            </g>
          )
        })}
        {/* Column labels */}
        <text x={20} y={20} fontSize={12} className="fill-base-content">Internal</text>
        <text x={size.w - 100} y={20} fontSize={12} className="fill-base-content">External</text>
      </svg>
      </div>
    </div>
  )
}
