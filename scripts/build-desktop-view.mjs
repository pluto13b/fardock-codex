import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Preserve the official Lucide 24px geometry in one embedded WPF dictionary. */
export async function buildDesktopView(source, staging) {
  const directory = join(source, 'assets/lucide')
  const definitions = []
  for (const file of (await readdir(directory)).filter(file => file.endsWith('.svg')).sort()) {
    const svg = await readFile(join(directory, file), 'utf8')
    const paths = []
    for (const match of svg.matchAll(/<(path|line|polyline|polygon|rect|circle)\s+([^>]+)\/?\s*>/gu)) {
      const attrs = Object.fromEntries([...match[2].matchAll(/([\w-]+)="([^"]*)"/gu)].map(value => [value[1], value[2]]))
      const n = (key, fallback = 0) => Number(attrs[key] ?? fallback)
      switch (match[1]) {
        case 'path': paths.push(`M0 0 ${attrs.d}`); break
        case 'line': paths.push(`M${n('x1')} ${n('y1')} L${n('x2')} ${n('y2')}`); break
        case 'polyline': case 'polygon': paths.push(`M${attrs.points}${match[1] === 'polygon' ? ' Z' : ''}`); break
        case 'circle': { const x=n('cx'), y=n('cy'), r=n('r'); paths.push(`M${x-r} ${y} A${r} ${r} 0 1 0 ${x+r} ${y} A${r} ${r} 0 1 0 ${x-r} ${y}`); break }
        case 'rect': {
          const x=n('x'), y=n('y'), w=n('width'), h=n('height'), r=n('rx')
          paths.push(r ? `M${x+r} ${y} H${x+w-r} A${r} ${r} 0 0 1 ${x+w} ${y+r} V${y+h-r} A${r} ${r} 0 0 1 ${x+w-r} ${y+h} H${x+r} A${r} ${r} 0 0 1 ${x} ${y+h-r} V${y+r} A${r} ${r} 0 0 1 ${x+r} ${y} Z` : `M${x} ${y} H${x+w} V${y+h} H${x} Z`); break
        }
      }
    }
    if (!paths.length) throw new Error(`Empty icon: ${file}`)
    definitions.push(`<Geometry x:Key="icon.${file.slice(0,-4)}">${paths.join(' ')}</Geometry>`)
  }
  const template = await readFile(join(source, 'MainView.xaml'), 'utf8')
  const output = join(staging, 'MainView.generated.xaml')
  await writeFile(output, template.replace('<!-- ICON_GEOMETRIES -->', definitions.join('\n')))
  return output
}
