import { cpSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// File tracing can include arbitrary project files through runtime fs reads.
// Ship only the runtime graph, never local credentials, databases or source.
const out = '.next/standalone'
if (!existsSync(join(out, 'server.js'))) throw new Error('Missing Next standalone server')
const keep = new Set(['.next', 'node_modules', 'server.js', 'package.json'])
for (const entry of readdirSync(out)) {
  if (!keep.has(entry)) rmSync(join(out, entry), { recursive: true, force: true })
}
for (const [source, destination] of [['.next/static', join(out, '.next/static')], ['public', join(out, 'public')]]) {
  rmSync(destination, { recursive: true, force: true })
  cpSync(source, destination, { recursive: true })
}
const config = JSON.parse(readFileSync('.next/required-server-files.json', 'utf8'))
const version = config.config.env.NEXT_PUBLIC_PICO_VERSION
if (!version) throw new Error('Build is missing its deployment identity')
writeFileSync(join(out, '.pico-version'), `${version}\n`)
console.log(`Packaged production runtime (${version}); excluded project files and local secrets`)
