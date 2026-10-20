const base = (import.meta as unknown as { env: Record<string, string> }).env.VITE_API_BASE ?? ''
export const getToken = () => sessionStorage.getItem('eventlab-token') ?? ''
export function headers(): Record<string, string> {
  const token = getToken()
  return token ? { Authorization: `Bearer ${token}` } : {}
}
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...headers(),
      ...init.headers,
    },
  })
  if (!response.ok) {
    const error = await response.json().catch(() => ({}))
    const detail = typeof error.detail === 'string' ? error.detail : 'Verifique os dados enviados.'
    throw new Error(
      response.status === 401
        ? 'Informe o token de acesso em Conexão.'
        : `${response.status}: ${detail}`,
    )
  }
  return response.json()
}
export async function exportRun(id: string) {
  const data = await api(`/api/runs/${id}/export`)
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }),
  )
  const link = document.createElement('a')
  link.href = url
  link.download = `eventlab-${id}.json`
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
export function parseFrame(frame: string): { id: number; data: unknown } | null {
  const lines = frame.split('\n')
  const id = lines
    .find((line) => line.startsWith('id:'))
    ?.slice(3)
    .trim()
  const data = lines
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n')
  if (!id || !data || !/^\d+$/.test(id)) return null
  return { id: Number(id), data: JSON.parse(data) }
}
export async function subscribe(
  runId: string,
  after: number,
  signal: AbortSignal,
  onChange: () => void,
  onStatus: (connected: boolean) => void,
) {
  let cursor = after
  let backoff = 1000
  while (!signal.aborted) {
    try {
      const response = await fetch(`${base}/api/runs/${runId}/stream?after=${cursor}`, {
        signal,
        headers: { ...headers(), 'Last-Event-ID': String(cursor) },
      })
      if (!response.ok || !response.body) throw new Error('Stream unavailable')
      onStatus(true)
      backoff = 1000
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      try {
        while (!signal.aborted) {
          const { value, done } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true }).replace(/\r/g, '')
          const frames = buffer.split('\n\n')
          buffer = frames.pop() ?? ''
          let changed = false
          for (const frame of frames) {
            const parsed = parseFrame(frame)
            if (parsed && parsed.id > cursor) {
              cursor = parsed.id
              changed = true
            }
          }
          if (changed) onChange()
        }
      } finally {
        await reader.cancel().catch(() => undefined)
        reader.releaseLock()
      }
    } catch (error) {
      if (signal.aborted) return
      console.debug('EventLab stream reconnecting', error)
    }
    onStatus(false)
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer)
        signal.removeEventListener('abort', done)
        resolve()
      }
      const timer = setTimeout(done, backoff)
      signal.addEventListener('abort', done, { once: true })
      if (signal.aborted) done()
    })
    backoff = Math.min(backoff * 2, 10000)
  }
}
