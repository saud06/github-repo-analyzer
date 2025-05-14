import { useEffect, useId, useState } from 'react'
import mermaid from 'mermaid'

mermaid.initialize({
  startOnLoad: false,
  theme: 'neutral',
  securityLevel: 'loose',
  themeVariables: {
    fontFamily: 'ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif',
    fontSize: '12px',
    primaryColor: '#e9d5ff',
    primaryBorderColor: '#8b5cf6',
    primaryTextColor: '#111827',
    lineColor: '#6b7280',
    secondaryColor: '#e5e7eb',
    tertiaryColor: '#ffffff',
  },
  // Ensure text is visible regardless of theme
  themeCSS: `.node text { fill: #111827 !important; } .label text { fill: #111827 !important; }`,
  flowchart: {
    htmlLabels: true,
    useMaxWidth: true,
    curve: 'basis',
    padding: 8,
  },
})

interface Props {
  chart: string
  headings?: string[]
}

export default function Mermaid({ chart, headings = [] }: Props) {
  const id = useId().replace(/:/g, '')
  const [svg, setSvg] = useState<string>('')
  const [error, setError] = useState<string>('')

  useEffect(() => {
    let cancelled = false
    async function render() {
      try {
        const input = (chart || '').trim()
        if (!input) { setSvg(''); return }
        // Reset mermaid's parser/renderer state between renders
        // @ts-ignore
        if (typeof mermaid.mermaidAPI?.reset === 'function') {
          // @ts-ignore
          mermaid.mermaidAPI.reset()
        }
        const { svg } = await mermaid.render(`mmd-${id}`, input)
        if (!cancelled) setSvg(svg)
      } catch (e: any) {
        if (!cancelled) setError(e?.message || 'Failed to render Mermaid')
      }
    }
    if (chart?.trim()) {
      render()
    } else {
      setSvg('')
    }
    return () => { cancelled = true }
  }, [chart, id])

  if (error) {
    // Fallback: render simple headings list if available
    if (headings.length > 0) {
      return (
        <div className="space-y-3">
          <div className="alert alert-warning">
            Mermaid couldn't render this README automatically. Showing a simplified outline instead.
          </div>
          <ul className="list-disc pl-6">
            {headings.map((h, i) => (
              <li key={i}>{h}</li>
            ))}
          </ul>
        </div>
      )
    }
    // If no headings, show the raw error
    return <div className="alert alert-error">{error}</div>
  }

  return (
    <div className="space-y-3">
      <div className="overflow-x-auto" dangerouslySetInnerHTML={{ __html: svg }} />
      {headings.length > 0 && (
        <div className="text-xs opacity-70">
          <span className="font-semibold">Sections:</span>
          <ul className="list-disc pl-6">
            {headings.map((h, i) => <li key={i}>{h}</li>)}
          </ul>
        </div>
      )}
    </div>
  )
}
