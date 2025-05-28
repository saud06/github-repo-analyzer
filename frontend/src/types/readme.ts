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
