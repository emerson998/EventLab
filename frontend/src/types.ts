export type Service = 'payment' | 'inventory' | 'notification'
export type Scenario =
  'healthy' | 'retry' | 'dead_letter' | 'duplicate' | 'outbox_recovery' | 'direct_loss'
export type Run = {
  id: string
  name: string
  scenario: Scenario
  mode: string
  paused: number
  max_attempts: number
  retry_base_ms: number
  created_at: number
  order_count?: number
}
export type Fault = {
  service: Service
  paused: number
  fail_next: number
  latency_ms: number
  ack_loss_next: number
}
export type Order = {
  id: string
  customer: string
  product: string
  quantity: number
  unit_price_cents: number
  status: string
  created_at: number
}
export type Event = {
  id: string
  type: string
  source: string
  target: string | null
  order_id: string
  causation_id: string | null
  payload: Record<string, unknown>
  created_at: number
}
export type Delivery = {
  id: string
  event_id: string
  service: Service
  status: string
  attempts: number
  generation: number
  last_error: string | null
  available_at: number
}
export type Journal = {
  seq: number
  kind: string
  message: string
  service: string | null
  event_id: string | null
  order_id: string | null
  delivery_id: string | null
  details: Record<string, unknown>
  created_at: number
}
export type Snapshot = {
  run: Run
  faults: Fault[]
  orders: Order[]
  events: Event[]
  deliveries: Delivery[]
  journal: Journal[]
  outbox: { event_id: string; status: string }[]
  effects: { service: Service; event_id: string }[]
  cursor: number
  metrics: {
    orders: number
    completed: number
    events: number
    pending: number
    dead: number
    deduplicated: number
    effects: number
    outbox_pending: number
  }
}
