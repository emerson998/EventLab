import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, headers, parseFrame, subscribe } from './api'

afterEach(() => vi.unstubAllGlobals())
describe('authenticated API client', () => {
  it('keeps the access token in session and sends bearer authorization', async () => {
    sessionStorage.setItem('eventlab-token', 'local-test')
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true })))
    vi.stubGlobal('fetch', fetch)
    expect(headers()).toEqual({ Authorization: 'Bearer local-test' })
    await api('/api/runs', { method: 'POST', body: '{}' })
    expect(fetch.mock.calls[0][1].headers.Authorization).toBe('Bearer local-test')
  })
  it('presents actionable authentication and conflict errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 401 })))
    await expect(api('/api/runs')).rejects.toThrow('Conexão')
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ detail: 'Different payload' }), {
          status: 409,
        }),
      ),
    )
    await expect(api('/api/runs')).rejects.toThrow('409: Different payload')
  })
})
describe('durable SSE protocol', () => {
  it('ignores heartbeats and parses a journal frame', () => {
    expect(parseFrame(': heartbeat')).toBeNull()
    expect(parseFrame('retry: 1500')).toBeNull()
    expect(parseFrame('id: 42\nevent: journal\ndata: {"kind":"order.created"}')).toEqual({
      id: 42,
      data: { kind: 'order.created' },
    })
  })
  it('handles frames split across chunks and ignores replayed IDs', async () => {
    const encoder = new TextEncoder()
    const controller = new AbortController()
    const change = vi.fn()
    const status = vi.fn()
    const body = new ReadableStream({
      start(stream) {
        stream.enqueue(encoder.encode('id: 9\ndata: {}\n\nid: 1'))
        stream.enqueue(encoder.encode('0\ndata: {}\n\nid: 10\ndata: {}\n\n'))
        stream.close()
      },
    })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, body }))
    const done = subscribe(
      'run-1',
      9,
      controller.signal,
      () => {
        change()
        controller.abort()
      },
      status,
    )
    await done
    expect(change).toHaveBeenCalledTimes(1)
    expect(status).toHaveBeenCalledWith(true)
  })
})
