import { Fragment, type ReactNode } from 'react'

function inline(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = []
  const re = /(\*\*[^*]+\*\*|\*[^*\n]+\*|`[^`]+`)/g
  let last = 0
  let m: RegExpExecArray | null
  let i = 0
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index))
    const t = m[0]
    if (t.startsWith('**')) out.push(<strong key={`${keyBase}-${i}`}>{t.slice(2, -2)}</strong>)
    else if (t.startsWith('`')) out.push(<code key={`${keyBase}-${i}`}>{t.slice(1, -1)}</code>)
    else out.push(<em key={`${keyBase}-${i}`}>{t.slice(1, -1)}</em>)
    last = m.index + t.length
    i++
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

/** Tiny markdown renderer: headings, lists, checkboxes, code fences, quotes, bold/italic/code. */
export function Markdown({ text }: { text: string }) {
  const blocks: ReactNode[] = []
  const lines = text.split('\n')
  let list: { ordered: boolean; items: ReactNode[][] } | null = null
  let code: string[] | null = null
  const flushList = (k: string) => {
    if (!list) return
    const items = list.items.map((it, i) => <li key={i}>{it}</li>)
    blocks.push(list.ordered ? <ol key={k}>{items}</ol> : <ul key={k}>{items}</ul>)
    list = null
  }
  for (const [i, line] of lines.entries()) {
    if (/^```/.test(line)) {
      if (code) {
        blocks.push(
          <pre key={`c${i}`}>
            <code>{code.join('\n')}</code>
          </pre>
        )
        code = null
      } else {
        flushList(`l${i}`)
        code = []
      }
      continue
    }
    if (code) {
      code.push(line)
      continue
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line)
    if (h) {
      flushList(`l${i}`)
      const Tag = `h${h[1].length}` as 'h1' | 'h2' | 'h3' | 'h4'
      blocks.push(<Tag key={i}>{inline(h[2], `h${i}`)}</Tag>)
      continue
    }
    if (/^\s*[-*]\s+\[([ xX])\]\s+/.test(line)) {
      const checked = /\[x\]/i.test(line)
      const text = line.replace(/^\s*[-*]\s+\[[ xX]\]\s+/, '')
      if (!list || list.ordered) {
        flushList(`l${i}`)
        list = { ordered: false, items: [] }
      }
      list.items.push([
        <Fragment key="c">
          <input type="checkbox" checked={checked} readOnly className="mr-1.5 accent-accent" />
          {inline(text, `cb${i}`)}
        </Fragment>
      ])
      continue
    }
    const li = /^(\s*)([-*]|\d+[.)])\s+(.*)$/.exec(line)
    if (li) {
      const ordered = /\d/.test(li[2])
      if (!list || list.ordered !== ordered) {
        flushList(`l${i}`)
        list = { ordered, items: [] }
      }
      list.items.push(inline(li[3], `li${i}`))
      continue
    }
    flushList(`l${i}`)
    if (/^>\s?/.test(line)) {
      blocks.push(<blockquote key={i}>{inline(line.replace(/^>\s?/, ''), `q${i}`)}</blockquote>)
      continue
    }
    if (/^(-{3,}|\*{3,})\s*$/.test(line)) {
      blocks.push(<hr key={i} />)
      continue
    }
    if (line.trim()) blocks.push(<p key={i}>{inline(line, `p${i}`)}</p>)
  }
  flushList('end')
  if (code) blocks.push(<pre key="ce"><code>{code.join('\n')}</code></pre>)
  return <div className="nm-md">{blocks}</div>
}
