/// <reference types="bun-types" />
import { describe, expect, test } from 'bun:test'
import { readJsonObject } from '../../src/lib/request-body'
import { POST as quality } from '../../src/app/api/quality/route'
import { POST as clientError } from '../../src/app/api/client-error/route'

const req = (body: string, headers: Record<string, string> = {}) => new Request('http://localhost/api/test', { method: 'POST', body, headers })
describe('bounded telemetry intake', () => {
  for (const body of ['null', '[]', '"text"', '42', '{', '']) {
    test(`rejects ${JSON.stringify(body)} as an invalid object`, async () => {
      expect((await quality(req(body))).status).toBe(400)
      expect((await clientError(req(body))).status).toBe(400)
    })
  }
  test('counts UTF-8 bytes rather than JavaScript characters', async () => {
    await expect(readJsonObject(req(JSON.stringify({ text: '😀'.repeat(600) })), 2048)).rejects.toMatchObject({ status: 413 })
  })
  test('rejects oversized declared content before reading', async () => {
    await expect(readJsonObject(req('{}', { 'content-length': '99999' }), 2048)).rejects.toMatchObject({ status: 413 })
  })
  test('accepts an object and preserves values for validation', async () => {
    expect(await readJsonObject(req('{"level":3}'), 100)).toEqual({ level: 3 })
  })
  test('streaming requests are bounded even without Content-Length', async () => {
    let cancelled = false
    const stream = new ReadableStream({ start(c) { c.enqueue(new Uint8Array(4096)) }, cancel() { cancelled = true } })
    const request = new Request('http://localhost', { method: 'POST', body: stream, duplex: 'half' } as RequestInit)
    await expect(readJsonObject(request, 100)).rejects.toMatchObject({ status: 413 })
    expect(cancelled).toBe(true)
  })
})
