'use client'

type Listener = (...args: any[]) => void

/** Small Socket.IO-shaped client for Pico's Vercel WebSocket route. */
export class SignalingSocket {
  id: string | undefined
  private ws: WebSocket | null = null
  private listeners = new Map<string, Set<Listener>>()
  private acknowledgements = new Map<number, (value: any) => void>()
  private nextAck = 1
  private retryTimer: ReturnType<typeof setTimeout> | undefined
  private retryDelay = 1000
  private manuallyClosed = false
  connected = false

  constructor(private readonly url: string) {
    this.open()
  }

  private open() {
    if (this.manuallyClosed) return
    try {
      const ws = new WebSocket(this.url)
      this.ws = ws
      ws.addEventListener('open', () => { this.retryDelay = 1000 })
      ws.addEventListener('message', (message) => {
        try {
          const packet = JSON.parse(String(message.data)) as { event?: string; data?: any; ackId?: number }
          if (packet.event === 'connect') {
            this.id = packet.data?.id
            this.connected = true
            this.dispatch('connect')
            return
          }
          if (packet.event === 'ack' && typeof packet.ackId === 'number') {
            const callback = this.acknowledgements.get(packet.ackId)
            this.acknowledgements.delete(packet.ackId)
            callback?.(packet.data)
            return
          }
          if (packet.event) this.dispatch(packet.event, packet.data)
        } catch {
          this.dispatch('connect_error', new Error('Invalid signaling response'))
        }
      })
      ws.addEventListener('error', () => this.dispatch('connect_error', new Error('Signaling connection failed')))
      ws.addEventListener('close', () => {
        const wasConnected = this.connected
        this.connected = false
        this.id = undefined
        if (wasConnected) this.dispatch('disconnect')
        this.acknowledgements.clear()
        if (!this.manuallyClosed) {
          this.retryTimer = setTimeout(() => this.open(), this.retryDelay)
          this.retryDelay = Math.min(4000, this.retryDelay * 2)
        }
      })
    } catch (error) {
      this.dispatch('connect_error', error)
      this.retryTimer = setTimeout(() => this.open(), this.retryDelay)
      this.retryDelay = Math.min(4000, this.retryDelay * 2)
    }
  }

  emit(event: string, ...args: any[]) {
    const callback = typeof args.at(-1) === 'function' ? args.pop() as (value: any) => void : undefined
    if (!this.connected || this.ws?.readyState !== WebSocket.OPEN) return this
    const ackId = callback ? this.nextAck++ : undefined
    if (callback && ackId !== undefined) this.acknowledgements.set(ackId, callback)
    this.ws.send(JSON.stringify({ event, data: args[0], ...(ackId === undefined ? {} : { ackId }) }))
    return this
  }

  on(event: string, listener: Listener) {
    const listeners = this.listeners.get(event) ?? new Set<Listener>()
    listeners.add(listener)
    this.listeners.set(event, listeners)
    return this
  }

  once(event: string, listener: Listener) {
    const once = (...args: any[]) => {
      this.off(event, once)
      listener(...args)
    }
    return this.on(event, once)
  }

  off(event: string, listener?: Listener) {
    if (listener) this.listeners.get(event)?.delete(listener)
    else this.listeners.delete(event)
    return this
  }

  disconnect() {
    this.manuallyClosed = true
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.acknowledgements.clear()
    this.ws?.close(1000, 'client disconnect')
    this.connected = false
    return this
  }

  private dispatch(event: string, ...args: any[]) {
    for (const listener of this.listeners.get(event) ?? []) listener(...args)
  }
}
