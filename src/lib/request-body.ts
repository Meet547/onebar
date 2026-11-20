/** Read small telemetry payloads without buffering an unbounded request. */
export class InvalidBody extends Error {
  constructor(public readonly status: 400 | 413) {
    super(status === 413 ? 'Request body too large' : 'Expected a JSON object')
  }
}

export async function readJsonObject(request: Request, maxBytes: number): Promise<Record<string, unknown>> {
  const length = Number(request.headers.get('content-length'))
  if (Number.isFinite(length) && length > maxBytes) throw new InvalidBody(413)
  const reader = request.body?.getReader()
  if (!reader) throw new InvalidBody(400)
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > maxBytes) {
        await reader.cancel().catch(() => undefined)
        throw new InvalidBody(413)
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  let parsed: unknown
  try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) }
  catch { throw new InvalidBody(400) }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new InvalidBody(400)
  return parsed as Record<string, unknown>
}
