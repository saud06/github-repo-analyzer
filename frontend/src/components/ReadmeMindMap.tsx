import { useMemo, useState } from 'react'

export type ReadmeNode = {
  id: string
  level: number
  title: string
  slug: string
  url: string
  snippet?: string | null
  markdown?: string | null
  links?: { text: string; url: string }[]
  badges?: { alt?: string | null; image: string; href?: string | null }[]
  children: ReadmeNode[]
}

type Props = {
  root: ReadmeNode | null
}

function NodeItem({ node, depth = 0, search = '', forceOpen }: { node: ReadmeNode; depth?: number; search?: string; forceOpen?: boolean }) {
  const [open, setOpen] = useState<boolean>(false)
  const hasChildren = node.children && node.children.length > 0
  const pad = Math.min(depth * 16, 64)
  const matches = search ? (node.title.toLowerCase().includes(search) || (node.snippet || '').toLowerCase().includes(search)) : true
  const isOpen = forceOpen ?? (open || (search && matches))

  return (
    <div className="relative">
      {/* connector line to parent */}
      {depth > 0 && (
        <div className="absolute left-0 top-4 h-full border-l border-base-300" style={{ transform: 'translateX(-12px)' }} />
      )}
      <div className="flex items-start gap-2" style={{ paddingLeft: pad }}>
        {hasChildren ? (
          <button className={`btn btn-xs ${isOpen ? '' : 'btn-outline'}`} onClick={() => setOpen(v => !v)}>{isOpen ? '−' : '+'}</button>
        ) : (
          <div className="w-6" />
        )}
        <div className={`card bg-base-100 border ${matches ? 'border-primary/70' : 'border-base-300'} hover:shadow-md transition-shadow`}>
          <div className="card-body p-3">
            <div className="flex items-center gap-2">
              <a href={node.url} target="_blank" rel="noreferrer" className="font-semibold hover:underline">{node.title}</a>
              <div className="badge badge-outline">H{node.level}</div>
            </div>
            {isOpen && node.snippet && (
              <p className="text-xs opacity-80 mt-1 line-clamp-3">{node.snippet}</p>
            )}
            {isOpen && node.links && node.links.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-2">
                {node.links.map((l: { text: string; url: string }, i: number) => (
                  <a key={i} href={l.url} target="_blank" rel="noreferrer" className="badge badge-primary badge-outline hover:badge-primary hover:text-primary-content">
                    {l.text}
                  </a>
                ))}
              </div>
            )}
            {!isOpen && node.links && node.links.length > 0 && (
              <div className="mt-1 text-[10px] opacity-70">{node.links.length} link{node.links.length > 1 ? 's' : ''}</div>
            )}
          </div>
        </div>
      </div>
      {hasChildren && isOpen && (
        <div className="mt-2 space-y-2">
          {node.children.map(child => (
            <NodeItem key={child.id} node={child} depth={depth + 1} search={search} forceOpen={forceOpen} />
          ))}
        </div>
      )}
    </div>
  )
}

export default function ReadmeMindMap({ root }: Props) {
  const nodes = useMemo(() => root, [root])
  const [query, setQuery] = useState('')
  const [forceOpen, setForceOpen] = useState<boolean | undefined>(undefined)
  if (!nodes) return null
  const q = query.trim().toLowerCase()
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h3 className="card-title">README Mind Map</h3>
        <div className="join ml-auto">
          <input className="input input-sm input-bordered join-item" placeholder="Search sections..." value={query} onChange={e => setQuery(e.target.value)} />
          <button className="btn btn-sm join-item" onClick={() => setForceOpen(true)}>Expand all</button>
          <button className="btn btn-sm join-item" onClick={() => setForceOpen(false)}>Collapse all</button>
          <button className="btn btn-sm join-item" onClick={() => { setQuery(''); setForceOpen(undefined) }}>Reset</button>
        </div>
      </div>
      <div className="text-xs opacity-70">Interactive outline with links, badges and snippets</div>
      <div className="space-y-2">
        {nodes.children?.map(ch => (
          <NodeItem key={ch.id} node={ch} depth={0} search={q} forceOpen={forceOpen} />
        ))}
      </div>
    </div>
  )
}
