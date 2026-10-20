import { useCallback, useEffect, useRef, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import {
  Activity,
  ArrowDownToLine,
  ArrowRight,
  Bell,
  BookOpen,
  Box,
  Check,
  ChevronRight,
  CircleHelp,
  Code2,
  Copy,
  CreditCard,
  Database,
  ExternalLink,
  FlaskConical,
  GitBranch,
  Layers3,
  LoaderCircle,
  Pause,
  Play,
  Plus,
  Radio,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  ShoppingBag,
  Terminal,
  TriangleAlert,
  Workflow,
  X,
  Zap,
} from 'lucide-react'
import { api, exportRun, getToken, subscribe } from './api'
import type { Delivery, Event, Fault, Run, Scenario, Service, Snapshot } from './types'

const scenarios: {
  id: Scenario
  name: string
  label: string
  description: string
  outcome: string
}[] = [
  {
    id: 'healthy',
    name: 'Fluxo saudável',
    label: 'BASELINE',
    description: 'Um pedido percorre os três consumidores sem falhas.',
    outcome: '3 efeitos confirmados · pedido concluído',
  },
  {
    id: 'retry',
    name: 'Falha e recuperação',
    label: 'RETRIES',
    description: 'Pagamento falha duas vezes antes de se recuperar.',
    outcome: 'Backoff exponencial · sucesso na 3ª tentativa',
  },
  {
    id: 'dead_letter',
    name: 'Tentativas esgotadas',
    label: 'DEAD LETTER',
    description: 'Uma falha persistente leva a mensagem para a DLQ.',
    outcome: 'Corrija o consumidor e reprocessse a entrega',
  },
  {
    id: 'duplicate',
    name: 'ACK perdido',
    label: 'IDEMPOTÊNCIA',
    description: 'O efeito acontece, mas o reconhecimento se perde.',
    outcome: 'Redelivery · nenhum efeito de negócio duplicado',
  },
  {
    id: 'outbox_recovery',
    name: 'Outbox em ação',
    label: 'ATOMICIDADE',
    description: 'A publicação é interrompida por quatro segundos.',
    outcome: 'Intenção persistida · entrega recuperada',
  },
  {
    id: 'direct_loss',
    name: 'Sem outbox',
    label: 'DUAL WRITE',
    description: 'A mesma interrupção, sem persistir a intenção de publicar.',
    outcome: 'Pedido criado · evento perdido para o consumidor',
  },
]
const serviceInfo = {
  payment: {
    name: 'Pagamento',
    event: 'order.created',
    icon: CreditCard,
    accent: 'purple',
  },
  inventory: {
    name: 'Estoque',
    event: 'payment.approved',
    icon: Box,
    accent: 'blue',
  },
  notification: {
    name: 'Notificação',
    event: 'inventory.reserved',
    icon: Bell,
    accent: 'teal',
  },
}
const short = (id: string) => id.slice(0, 8)
const time = (value: number) =>
  new Date(value * 1000).toLocaleTimeString('pt-BR', { hour12: false })
const money = (value: number) =>
  (value / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
const statusLabels: Record<string, string> = {
  created: 'Criado',
  paid: 'Pago',
  reserved: 'Reservado',
  completed: 'Concluído',
  pending: 'Na fila',
  retry: 'Retry',
  dead: 'DLQ',
  succeeded: 'Confirmada',
  deduplicated: 'Deduplicada',
  published: 'Publicada',
}
function Badge({ value }: { value: string }) {
  return <span className={`badge ${value}`}>{statusLabels[value] ?? value}</span>
}
function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <Layers3 size={28} />
      <strong>{title}</strong>
      <p>{children}</p>
    </div>
  )
}
function Modal({
  title,
  children,
  onClose,
}: {
  title: string
  children: ReactNode
  onClose: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    dialog.current?.showModal()
  }, [])
  return (
    <dialog
      ref={dialog}
      onCancel={onClose}
      onClick={(e) => {
        if (e.target === dialog.current) onClose()
      }}
    >
      <div className="modal-head">
        <div>
          <span className="eyebrow">EVENTLAB / LABORATORY</span>
          <h2>{title}</h2>
        </div>
        <button className="icon-btn" aria-label="Fechar" onClick={onClose}>
          <X size={20} />
        </button>
      </div>
      {children}
    </dialog>
  )
}

export default function App() {
  const [runs, setRuns] = useState<Run[]>([])
  const [runId, setRunId] = useState<string | null>(() => localStorage.getItem('eventlab-run'))
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [tab, setTab] = useState('overview')
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [connected, setConnected] = useState(false)
  const [modal, setModal] = useState<'run' | 'order' | 'connection' | null>(null)
  const [scenario, setScenario] = useState<Scenario>('healthy')
  const [inspect, setInspect] = useState<Event | null>(null)
  const [search, setSearch] = useState('')
  const [deliveryFilter, setDeliveryFilter] = useState('all')
  const [tokenVersion, setTokenVersion] = useState(0)
  const active = useRef(runId)
  active.current = runId

  const loadRuns = useCallback(async () => {
    const data = await api<Run[]>('/api/runs')
    setRuns(data)
    setRunId((current) =>
      current && data.some((r) => r.id === current) ? current : (data[0]?.id ?? null),
    )
  }, [])
  useEffect(() => {
    let alive = true
    setLoading(true)
    loadRuns()
      .catch((e) => {
        if (alive) setError(e.message)
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [loadRuns, tokenVersion])

  useEffect(() => {
    if (!runId) {
      setSnapshot(null)
      return
    }
    localStorage.setItem('eventlab-run', runId)
    setSnapshot(null)
    setConnected(false)
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    let fetching = false
    let queued = false
    async function refresh() {
      if (fetching) {
        queued = true
        return
      }
      fetching = true
      try {
        const data = await api<Snapshot>(`/api/runs/${runId}`, {
          signal: controller.signal,
        })
        if (!controller.signal.aborted && active.current === runId) setSnapshot(data)
      } catch (e) {
        if (!controller.signal.aborted) setError((e as Error).message)
      } finally {
        fetching = false
        if (queued && !controller.signal.aborted) {
          queued = false
          schedule()
        }
      }
    }
    function schedule() {
      if (!timer)
        timer = setTimeout(() => {
          timer = undefined
          void refresh()
        }, 180)
    }
    void refresh()
    // Stream replays durable journal entries. Debouncing coalesces a burst into one snapshot.
    void subscribe(runId, 0, controller.signal, schedule, setConnected)
    const fallback = setInterval(schedule, 5000)
    return () => {
      controller.abort()
      clearTimeout(timer)
      clearInterval(fallback)
    }
  }, [runId, tokenVersion])

  async function act(operation: () => Promise<unknown>) {
    setBusy(true)
    setError('')
    try {
      await operation()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  async function createRun(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const data = new FormData(e.currentTarget)
    await act(async () => {
      const created = await api<Snapshot>('/api/runs', {
        method: 'POST',
        body: JSON.stringify({
          name: data.get('name'),
          scenario,
          max_attempts: Number(data.get('max_attempts')),
          retry_base_ms: Number(data.get('retry_base_ms')),
        }),
      })
      await loadRuns()
      setRunId(created.run.id)
      setTab('overview')
      setModal(null)
    })
  }
  async function createOrder(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const data = new FormData(e.currentTarget)
    await act(async () => {
      await api(`/api/runs/${runId}/orders`, {
        method: 'POST',
        headers: { 'Idempotency-Key': crypto.randomUUID() },
        body: JSON.stringify({
          customer: data.get('customer'),
          product: data.get('product'),
          quantity: Number(data.get('quantity')),
          unit_price_cents: Math.round(Number(data.get('price')) * 100),
          publish_gap: data.get('gap') === 'on',
        }),
      })
      setModal(null)
    })
  }
  const updateFault = (service: Service, changes: Partial<Fault>) =>
    act(async () => {
      const requested = runId
      const next = await api<Snapshot>(`/api/runs/${runId}/faults/${service}`, {
        method: 'PATCH',
        body: JSON.stringify(changes),
      })
      if (active.current === requested) setSnapshot(next)
    })
  const deliveryAction = (delivery: Delivery, action: string) =>
    act(async () => {
      const requested = runId
      const next = await api<Snapshot>(`/api/runs/${runId}/deliveries/${delivery.id}/${action}`, {
        method: 'POST',
      })
      if (active.current === requested) setSnapshot(next)
    })
  const state = snapshot
  const m = state?.metrics
  const currentScenario = scenarios.find((s) => s.id === state?.run.scenario)
  const match = (value: unknown) =>
    JSON.stringify(value).toLowerCase().includes(search.toLowerCase())
  const events = state?.events.filter(match).slice().reverse() ?? []
  const deliveries =
    state?.deliveries
      .filter((d) => (deliveryFilter === 'all' || d.status === deliveryFilter) && match(d))
      .slice()
      .reverse() ?? []

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a
          className="brand"
          href="#"
          onClick={(e) => {
            e.preventDefault()
            setTab('overview')
          }}
        >
          <span className="brand-mark">
            <Zap size={23} fill="currentColor" />
          </span>
          <span>
            event<span className="brand-light">lab</span>
            <small>SYSTEMS LABORATORY</small>
          </span>
        </a>
        <div className="workspace">
          <span className="workspace-icon">
            <FlaskConical size={17} />
          </span>
          <div>
            Local workspace<small>Ambiente de experimentação</small>
          </div>
          <span className="tiny-dot" />
        </div>
        <span className="nav-label">EXPLORAR</span>
        <nav aria-label="Navegação principal">
          {[
            ['overview', Workflow, 'Laboratório'],
            ['events', Radio, 'Event explorer'],
            ['deliveries', Layers3, 'Entregas & DLQ'],
            ['guide', BookOpen, 'Guia de experimentos'],
          ].map(([id, Icon, label]) => {
            const NavIcon = Icon as typeof Workflow
            return (
              <button
                key={String(id)}
                className={tab === id ? 'nav-item active' : 'nav-item'}
                onClick={() => {
                  setTab(String(id))
                  setSearch('')
                }}
              >
                <NavIcon size={18} />
                <span>{String(label)}</span>
                {id === 'deliveries' && !!m?.dead && <b>{m.dead}</b>}
              </button>
            )
          })}
        </nav>
        <div className="sidebar-note">
          <ShieldCheck size={20} />
          <strong>Falhe. Observe. Entenda.</strong>
          <p>Um ambiente seguro para explorar as garantias de sistemas distribuídos.</p>
          <span>TRANSPORTE LOCAL SIMULADO</span>
        </div>
        <div className="sidebar-bottom">
          <button onClick={() => setModal('connection')}>
            <Settings2 size={16} />
            Conexão
          </button>
          <a href="https://github.com/emerson998" target="_blank" rel="noreferrer">
            <Code2 size={16} />
            GitHub
            <ExternalLink size={12} />
          </a>
          <span>
            EventLab <b>v1.0.0</b>
          </span>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumb">
            <FlaskConical size={15} />
            <span>Workspace</span>
            <ChevronRight size={14} />
            <strong>
              {tab === 'overview'
                ? 'Laboratório'
                : tab === 'events'
                  ? 'Event explorer'
                  : tab === 'deliveries'
                    ? 'Entregas & DLQ'
                    : 'Guia de experimentos'}
            </strong>
          </div>
          <div className="topbar-right">
            <span className={`connection ${connected ? 'live' : ''}`}>
              <span />
              {connected ? 'Live stream' : runId ? 'Reconectando' : 'Local engine'}
            </span>
            <span className="avatar">EO</span>
          </div>
        </header>
        <main>
          <div className="page-heading">
            <div>
              <div className="eyebrow">
                <span /> EVENT-DRIVEN ARCHITECTURE
              </div>
              <h1>
                {tab === 'overview'
                  ? 'Seu laboratório de eventos.'
                  : tab === 'events'
                    ? 'Cada evento, uma história.'
                    : tab === 'deliveries'
                      ? 'Controle cada entrega.'
                      : 'Da falha ao entendimento.'}
              </h1>
              <p>
                {tab === 'overview'
                  ? 'Injete falhas. Acompanhe mensagens. Descubra o que mantém seu sistema de pé.'
                  : tab === 'events'
                    ? 'Inspecione payloads, correlação e a cadeia de causalidade do seu experimento.'
                    : tab === 'deliveries'
                      ? 'Observe tentativas, investigue falhas e recupere mensagens da dead-letter queue.'
                      : 'Experimentos reproduzíveis para entender as garantias por trás da arquitetura.'}
              </p>
            </div>
            <button className="btn primary" onClick={() => setModal('run')} disabled={busy}>
              <Plus size={17} />
              Novo experimento
            </button>
          </div>
          {error && (
            <div className="error-banner" role="alert">
              <TriangleAlert size={18} />
              <span>{error}</span>
              <button onClick={() => setError('')} aria-label="Dispensar erro">
                <X size={17} />
              </button>
            </div>
          )}
          <section className="experiment-bar" aria-label="Experimento ativo">
            <div className="experiment-select">
              <span className="experiment-symbol">
                <GitBranch size={18} />
              </span>
              <div>
                <label htmlFor="run">EXPERIMENTO ATIVO</label>
                <select
                  id="run"
                  aria-label="Experimento ativo"
                  value={runId ?? ''}
                  onChange={(e) => setRunId(e.target.value)}
                  disabled={busy || !runs.length}
                >
                  {!runs.length && <option value="">Nenhum experimento</option>}
                  {runs.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name} · {short(r.id)}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="experiment-actions">
              {state && (
                <>
                  <span className={`mode-tag ${state.run.mode === 'direct' ? 'warning' : ''}`}>
                    <Database size={13} />
                    {state.run.mode === 'outbox' ? 'Transactional Outbox' : 'Direct publish'}
                  </span>
                  <button
                    className="btn subtle"
                    disabled={busy}
                    onClick={() =>
                      act(async () => {
                        const requested = runId
                        const next = await api<Snapshot>(`/api/runs/${runId}`, {
                          method: 'PATCH',
                          body: JSON.stringify({ paused: !state.run.paused }),
                        })
                        if (active.current === requested) setSnapshot(next)
                      })
                    }
                  >
                    {state.run.paused ? <Play size={15} /> : <Pause size={15} />}
                    {state.run.paused ? 'Retomar' : 'Pausar'}
                  </button>
                  <button
                    className="icon-btn"
                    aria-label="Exportar experimento"
                    title="Exportar experimento JSON"
                    disabled={busy}
                    onClick={() => act(() => exportRun(state.run.id))}
                  >
                    <ArrowDownToLine size={17} />
                  </button>
                </>
              )}
            </div>
          </section>
          {loading && (
            <div className="loading">
              <LoaderCircle className="spin" />
              Conectando ao laboratório…
            </div>
          )}
          {!loading && !runId && tab !== 'guide' && (
            <section className="welcome panel">
              <div className="welcome-art">
                <Workflow size={45} />
              </div>
              <span className="eyebrow">SEU PRIMEIRO EXPERIMENTO</span>
              <h2>Entenda o sistema quando as coisas dão errado.</h2>
              <p>
                Comece pelo fluxo saudável ou escolha um cenário de falha. Os eventos e as métricas
                aparecem aqui enquanto o motor trabalha.
              </p>
              <button className="btn primary" onClick={() => setModal('run')}>
                <FlaskConical size={17} />
                Criar experimento
              </button>
              <div className="welcome-features">
                <span>
                  <Check size={15} />
                  Estado persistente
                </span>
                <span>
                  <Check size={15} />
                  Sem serviços externos
                </span>
                <span>
                  <Check size={15} />
                  Cenários reproduzíveis
                </span>
              </div>
            </section>
          )}
          {tab === 'overview' && state && (
            <>
              <section className="metrics" aria-label="Métricas do experimento">
                {[
                  {
                    label: 'EVENTOS GERADOS',
                    value: m!.events,
                    icon: Radio,
                    note: `${m!.orders} pedido(s) no experimento`,
                    tone: 'teal',
                  },
                  {
                    label: 'PEDIDOS CONCLUÍDOS',
                    value: `${m!.completed}/${m!.orders}`,
                    icon: Check,
                    note: 'Fluxo de negócio finalizado',
                    tone: 'purple',
                  },
                  {
                    label: 'ENTREGAS PENDENTES',
                    value: m!.pending,
                    icon: Layers3,
                    note: `${m!.outbox_pending} aguardando na outbox`,
                    tone: 'blue',
                  },
                  {
                    label: 'DEAD-LETTER QUEUE',
                    value: m!.dead,
                    icon: TriangleAlert,
                    note: `${m!.deduplicated} duplicata(s) ignorada(s)`,
                    tone: m!.dead ? 'orange' : 'muted',
                  },
                ].map((item) => (
                  <article className="metric panel" key={item.label}>
                    <div>
                      <span>{item.label}</span>
                      <item.icon size={16} className={item.tone} />
                    </div>
                    <strong>{item.value}</strong>
                    <small>{item.note}</small>
                  </article>
                ))}
              </section>
              <section className="panel topology">
                <div className="section-heading">
                  <div>
                    <h2>
                      <Workflow size={18} />
                      Topologia do sistema
                    </h2>
                    <p>Pedido → pagamento → estoque → notificação</p>
                  </div>
                  <span className="live-label">
                    <span className={state.run.paused ? 'paused-dot' : ''} />
                    {state.run.paused ? 'MOTOR PAUSADO' : 'MOTOR ATIVO'}
                  </span>
                </div>
                <div className="topology-canvas">
                  <div className="producer-node">
                    <span className="node-icon">
                      <ShoppingBag size={23} />
                    </span>
                    <strong>Pedidos</strong>
                    <code>order.created</code>
                    <button
                      className="btn primary compact"
                      disabled={busy}
                      onClick={() => setModal('order')}
                    >
                      <Plus size={14} />
                      Criar pedido
                    </button>
                  </div>
                  <div className="transport-line">
                    <span>{state.run.mode === 'outbox' ? 'OUTBOX' : 'DIRECT'}</span>
                    <div />
                    <ArrowRight size={15} />
                    <small>{m!.outbox_pending} pendente(s)</small>
                  </div>
                  {state.faults.map((fault, i) => {
                    const info = serviceInfo[fault.service]
                    const Icon = info.icon
                    const count = state.deliveries.filter(
                      (d) => d.service === fault.service && ['pending', 'retry'].includes(d.status),
                    ).length
                    return (
                      <div className="service-wrapper" key={fault.service}>
                        <article
                          className={`service-node ${info.accent} ${fault.paused ? 'node-paused' : ''}`}
                        >
                          <div className="node-top">
                            <span className="node-icon">
                              <Icon size={21} />
                            </span>
                            <span
                              className={`service-status ${fault.paused ? 'off' : fault.fail_next ? 'faulty' : ''}`}
                            >
                              <i />
                              {fault.paused ? 'Pausado' : fault.fail_next ? 'Com falha' : 'Pronto'}
                            </span>
                          </div>
                          <strong>{info.name}</strong>
                          <code>{info.event}</code>
                          <div className="node-stats">
                            <span>
                              {state.effects.filter((e) => e.service === fault.service).length}{' '}
                              <small>efeito(s)</small>
                            </span>
                            <span>
                              {count} <small>na fila</small>
                            </span>
                          </div>
                        </article>
                        {i < 2 && <ArrowRight className="node-arrow" size={19} />}
                      </div>
                    )
                  })}
                </div>
                <div className="topology-footer">
                  <span>
                    <span className="legend-dot teal-bg" />
                    Confirmação transacional
                  </span>
                  <span>
                    <span className="legend-dot purple-bg" />
                    Consumidores idempotentes
                  </span>
                  <span>
                    <Activity size={13} />
                    At-least-once · transporte simulado
                  </span>
                </div>
              </section>
              <div className="lower-grid">
                <section className="panel fault-panel">
                  <div className="section-heading">
                    <div>
                      <h2>
                        <Settings2 size={18} />
                        Injeção de falhas
                      </h2>
                      <p>Controle o comportamento de cada consumidor.</p>
                    </div>
                    <span className="mini-tag">CHAOS CONTROLS</span>
                  </div>
                  {state.faults.map((fault) => (
                    <FaultControl
                      key={`${state.run.id}-${fault.service}`}
                      fault={fault}
                      busy={busy}
                      onChange={(changes) => updateFault(fault.service, changes)}
                    />
                  ))}
                  <div className="info-strip">
                    <CircleHelp size={15} />
                    <span>Latência se aplica a novas entregas. Pausar preserva a fila.</span>
                  </div>
                </section>
                <section className="panel timeline-panel">
                  <div className="section-heading">
                    <div>
                      <h2>
                        <Activity size={18} />
                        Timeline ao vivo
                      </h2>
                      <p>O que aconteceu, na ordem em que aconteceu.</p>
                    </div>
                    <span className="mini-tag">ÚLTIMOS 18</span>
                  </div>
                  <div className="timeline">
                    {!state.journal.length && <Empty title="Nenhuma atividade" />}
                    {state.journal.slice(0, 18).map((item) => (
                      <button
                        key={item.seq}
                        className="timeline-item"
                        onClick={() => {
                          const event = state.events.find((e) => e.id === item.event_id)
                          if (event) setInspect(event)
                        }}
                        disabled={!item.event_id}
                      >
                        <span
                          className={`timeline-dot ${item.kind.includes('dead') || item.kind.includes('lost') ? 'orange-bg' : item.kind.includes('retry') ? 'purple-bg' : 'teal-bg'}`}
                        />
                        <div>
                          <strong>{item.message}</strong>
                          <small>
                            {item.service ?? 'engine'}
                            {item.event_id ? ` · ${short(item.event_id)}` : ''}
                          </small>
                        </div>
                        <time>{time(item.created_at)}</time>
                      </button>
                    ))}
                  </div>
                </section>
              </div>
              <section className="panel orders-panel">
                <div className="section-heading">
                  <div>
                    <h2>
                      <ShoppingBag size={18} />
                      Pedidos do experimento
                    </h2>
                    <p>Acompanhe o resultado do processamento de negócio.</p>
                  </div>
                  <button className="btn subtle" disabled={busy} onClick={() => setModal('order')}>
                    <Plus size={15} />
                    Criar pedido
                  </button>
                </div>
                {state.orders.length ? (
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>PEDIDO</th>
                          <th>CLIENTE / PRODUTO</th>
                          <th>VALOR</th>
                          <th>STATUS</th>
                          <th>CRIADO ÀS</th>
                          <th />
                        </tr>
                      </thead>
                      <tbody>
                        {state.orders
                          .slice()
                          .reverse()
                          .map((order) => (
                            <tr key={order.id}>
                              <td>
                                <code>#{short(order.id)}</code>
                              </td>
                              <td>
                                <strong>{order.customer}</strong>
                                <small>
                                  {order.quantity} × {order.product}
                                </small>
                              </td>
                              <td>{money(order.quantity * order.unit_price_cents)}</td>
                              <td>
                                <Badge value={order.status} />
                              </td>
                              <td className="mono">{time(order.created_at)}</td>
                              <td>
                                <button
                                  className="icon-btn"
                                  aria-label={`Ver eventos do pedido ${short(order.id)}`}
                                  onClick={() => {
                                    setSearch(order.id)
                                    setTab('events')
                                  }}
                                >
                                  <ChevronRight size={17} />
                                </button>
                              </td>
                            </tr>
                          ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <Empty title="Seu primeiro pedido começa aqui">
                    Crie um pedido para observar os eventos atravessando o sistema.
                  </Empty>
                )}
              </section>
              <div className="scenario-callout">
                <span className="scenario-icon">
                  <FlaskConical size={21} />
                </span>
                <div>
                  <strong>{currentScenario?.name}</strong>
                  <p>
                    {currentScenario?.description} {currentScenario?.outcome}.
                  </p>
                </div>
                <button onClick={() => setTab('guide')}>
                  Entender o cenário
                  <ArrowRight size={15} />
                </button>
              </div>
            </>
          )}
          {tab === 'events' && state && (
            <section className="panel">
              <div className="section-heading">
                <div>
                  <h2>
                    <Radio size={18} />
                    Event explorer <span className="count">{events.length}</span>
                  </h2>
                  <p>Selecione um evento para inspecionar o envelope e sua causalidade.</p>
                </div>
                <SearchInput value={search} onChange={setSearch} />
              </div>
              {events.length ? (
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>EVENTO</th>
                        <th>TIPO</th>
                        <th>ORIGEM → DESTINO</th>
                        <th>PEDIDO</th>
                        <th>HORÁRIO</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {events.map((event) => (
                        <tr key={event.id}>
                          <td>
                            <code>{short(event.id)}</code>
                          </td>
                          <td>
                            <span className="event-type">{event.type}</span>
                          </td>
                          <td className="mono">
                            {event.source} <span className="muted">→</span> {event.target ?? '∎'}
                          </td>
                          <td>
                            <code>#{short(event.order_id)}</code>
                          </td>
                          <td className="mono">{time(event.created_at)}</td>
                          <td>
                            <button
                              className="btn subtle compact"
                              onClick={() => setInspect(event)}
                            >
                              Inspecionar
                              <ChevronRight size={14} />
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <Empty title="Nenhum evento encontrado">Crie um pedido ou ajuste sua busca.</Empty>
              )}
            </section>
          )}
          {tab === 'deliveries' && state && (
            <section className="panel">
              <div className="section-heading">
                <div>
                  <h2>
                    <Layers3 size={18} />
                    Entregas <span className="count">{deliveries.length}</span>
                  </h2>
                  <p>Corrija a falha do consumidor antes de reprocessar uma mensagem da DLQ.</p>
                </div>
                <SearchInput value={search} onChange={setSearch} />
              </div>
              <div className="filter-tabs">
                {[
                  ['all', 'Todas'],
                  ['pending', 'Na fila'],
                  ['retry', 'Retries'],
                  ['dead', 'Dead letter'],
                  ['deduplicated', 'Deduplicadas'],
                  ['succeeded', 'Confirmadas'],
                ].map(([id, label]) => (
                  <button
                    key={id}
                    onClick={() => setDeliveryFilter(id)}
                    className={deliveryFilter === id ? 'selected' : ''}
                  >
                    {label}
                  </button>
                ))}
              </div>
              {deliveries.length ? (
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>ENTREGA / EVENTO</th>
                        <th>CONSUMIDOR</th>
                        <th>STATUS</th>
                        <th>TENTATIVAS</th>
                        <th>DIAGNÓSTICO</th>
                        <th>AÇÕES</th>
                      </tr>
                    </thead>
                    <tbody>
                      {deliveries.map((delivery) => (
                        <tr key={delivery.id}>
                          <td>
                            <code>{short(delivery.id)}</code>
                            <small>
                              {short(delivery.event_id)} · geração {delivery.generation}
                            </small>
                          </td>
                          <td>{serviceInfo[delivery.service].name}</td>
                          <td>
                            <Badge value={delivery.status} />
                          </td>
                          <td className="mono">
                            {delivery.attempts} / {state.run.max_attempts}
                          </td>
                          <td>
                            <small>{delivery.last_error ?? 'Sem erro registrado'}</small>
                            {delivery.status === 'retry' && (
                              <small>Disponível às {time(delivery.available_at)}</small>
                            )}
                          </td>
                          <td>
                            <div className="row-actions">
                              {delivery.status === 'dead' && (
                                <button
                                  className="btn subtle compact"
                                  disabled={busy}
                                  onClick={() => deliveryAction(delivery, 'replay')}
                                >
                                  <RefreshCw size={13} />
                                  Reprocessar
                                </button>
                              )}
                              <button
                                className="icon-btn"
                                disabled={busy}
                                aria-label={`Duplicar entrega ${short(delivery.id)}`}
                                title="Simular redelivery"
                                onClick={() => deliveryAction(delivery, 'duplicate')}
                              >
                                <Copy size={15} />
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <Empty title="Nenhuma entrega nesta seleção">
                  Mensagens aparecem aqui quando o evento é publicado para um consumidor.
                </Empty>
              )}
            </section>
          )}
          {tab === 'guide' && (
            <>
              <div className="guide-intro panel">
                <span className="node-icon">
                  <BookOpen size={25} />
                </span>
                <div>
                  <h2>Aprenda observando as garantias.</h2>
                  <p>
                    Cada cenário configura o mesmo fluxo com uma falha diferente. Crie o
                    experimento, envie um pedido e acompanhe a timeline.
                  </p>
                </div>
                <span className="mini-tag">6 EXPERIMENTOS</span>
              </div>
              <div className="scenario-grid">
                {scenarios.map((item, index) => (
                  <article className="panel scenario-card" key={item.id}>
                    <div>
                      <span className="scenario-number">0{index + 1}</span>
                      <span className="mini-tag">{item.label}</span>
                    </div>
                    <h2>{item.name}</h2>
                    <p>{item.description}</p>
                    <div className="expected">
                      <Check size={15} />
                      {item.outcome}
                    </div>
                    <button
                      className="btn subtle"
                      onClick={() => {
                        setScenario(item.id)
                        setModal('run')
                      }}
                    >
                      Explorar cenário
                      <ArrowRight size={15} />
                    </button>
                  </article>
                ))}
              </div>
              <section className="panel concepts">
                <h2>O que este laboratório demonstra</h2>
                <div>
                  <article>
                    <Database size={22} />
                    <h3>Transactional Outbox</h3>
                    <p>
                      O pedido e a intenção de publicar são gravados na mesma transação. O relay
                      retoma intenções pendentes após um reinício.
                    </p>
                  </article>
                  <article>
                    <ShieldCheck size={22} />
                    <h3>Consumidor idempotente</h3>
                    <p>
                      Inbox, efeito de negócio e próximo evento são confirmados juntos. Uma
                      redelivery não repete o efeito local.
                    </p>
                  </article>
                  <article>
                    <RefreshCw size={22} />
                    <h3>Entrega at-least-once</h3>
                    <p>
                      Retries e ACK perdido podem gerar novas tentativas. Isso não garante
                      exactly-once para sistemas externos.
                    </p>
                  </article>
                </div>
                <p className="guide-limit">
                  Limite do modelo: transporte e consumidores são simulados em um processo com
                  SQLite. Não há broker externo, cobrança real, reserva real de estoque ou envio de
                  e-mail. O cenário de interrupção representa a janela de falha; não encerra o
                  processo.
                </p>
              </section>
            </>
          )}
          <footer className="page-footer">
            <span>
              <Zap size={12} />
              EventLab · Engenharia que você pode observar.
            </span>
            <span>
              React + FastAPI <span className="footer-divider">/</span> Built for curious engineers
            </span>
          </footer>
        </main>
      </div>
      {modal === 'run' && (
        <Modal title="Novo experimento" onClose={() => setModal(null)}>
          <form onSubmit={createRun}>
            <label className="field">
              Nome do experimento
              <input
                name="name"
                required
                maxLength={80}
                defaultValue={scenarios.find((s) => s.id === scenario)?.name}
                placeholder="Ex.: Recuperação de pagamento"
              />
            </label>
            <label className="field">
              Cenário
              <select value={scenario} onChange={(e) => setScenario(e.target.value as Scenario)}>
                {scenarios.map((s) => (
                  <option value={s.id} key={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="modal-explanation">
              <FlaskConical size={19} />
              <p>
                {scenarios.find((s) => s.id === scenario)?.description}
                <strong>{scenarios.find((s) => s.id === scenario)?.outcome}.</strong>
              </p>
            </div>
            <div className="form-grid">
              <label className="field">
                Máximo de tentativas
                <input
                  type="number"
                  name="max_attempts"
                  defaultValue={3}
                  min={1}
                  max={8}
                  required
                />
              </label>
              <label className="field">
                Backoff inicial (ms)
                <input
                  type="number"
                  name="retry_base_ms"
                  defaultValue={1000}
                  min={100}
                  max={10000}
                  required
                />
              </label>
            </div>
            <p className="form-hint">
              O retry dobra o intervalo a cada falha, com teto de 60 segundos. O cenário de
              recuperação precisa de pelo menos 3 tentativas.
            </p>
            <div className="modal-actions">
              <button type="button" className="btn subtle" onClick={() => setModal(null)}>
                Cancelar
              </button>
              <button className="btn primary" disabled={busy}>
                {busy ? <LoaderCircle size={16} className="spin" /> : <Plus size={16} />}
                Criar experimento
              </button>
            </div>
          </form>
        </Modal>
      )}
      {modal === 'order' && (
        <Modal title="Criar pedido" onClose={() => setModal(null)}>
          <form onSubmit={createOrder}>
            <div className="modal-explanation">
              <ShoppingBag size={19} />
              <p>
                Um pedido inicia uma cadeia de eventos.
                <strong>Os valores são fictícios; nenhuma cobrança é realizada.</strong>
              </p>
            </div>
            <label className="field">
              Cliente
              <input name="customer" defaultValue="Ada Lovelace" maxLength={80} required />
            </label>
            <label className="field">
              Produto
              <input name="product" defaultValue="Mechanical keyboard" maxLength={100} required />
            </label>
            <div className="form-grid">
              <label className="field">
                Quantidade
                <input type="number" name="quantity" defaultValue={1} min={1} max={100} required />
              </label>
              <label className="field">
                Preço unitário (R$)
                <input
                  type="number"
                  name="price"
                  defaultValue="249.00"
                  step="0.01"
                  min="0.01"
                  max="1000000"
                  required
                />
              </label>
            </div>
            <label className="check-field">
              <input type="checkbox" name="gap" />
              Simular interrupção entre commit e publicação
            </label>
            <p className="form-hint">
              Com outbox: recupera após 4s. Sem outbox: o evento não chega ao consumidor. Os dois
              cenários de comparação já ativam esta falha.
            </p>
            <div className="modal-actions">
              <button type="button" className="btn subtle" onClick={() => setModal(null)}>
                Cancelar
              </button>
              <button className="btn primary" disabled={busy}>
                <Play size={15} />
                Enviar pedido
              </button>
            </div>
          </form>
        </Modal>
      )}
      {modal === 'connection' && (
        <Modal title="Conexão com o motor" onClose={() => setModal(null)}>
          <form
            onSubmit={(e) => {
              e.preventDefault()
              const data = new FormData(e.currentTarget)
              sessionStorage.setItem('eventlab-token', String(data.get('token') ?? ''))
              setTokenVersion((v) => v + 1)
              setError('')
              setModal(null)
            }}
          >
            <div className="modal-explanation">
              <Terminal size={19} />
              <p>
                A interface usa a API configurada no build ou o proxy local.
                <strong>Se o servidor exigir autenticação, informe o bearer token abaixo.</strong>
              </p>
            </div>
            <label className="field">
              Token de acesso
              <input
                name="token"
                type="password"
                defaultValue={getToken()}
                autoComplete="off"
                placeholder="Opcional no ambiente local"
              />
            </label>
            <p className="form-hint">
              O token fica apenas nesta sessão do navegador. Não use credenciais de serviços reais
              no laboratório.
            </p>
            <div className="modal-actions">
              <button className="btn primary">Salvar conexão</button>
            </div>
          </form>
        </Modal>
      )}
      {inspect && (
        <Modal title="Inspecionar evento" onClose={() => setInspect(null)}>
          <div className="inspect-type">
            <Radio size={18} />
            {inspect.type}
            <span className="mini-tag">SCHEMA v1</span>
          </div>
          <dl className="event-details">
            <dt>Event ID</dt>
            <dd>{inspect.id}</dd>
            <dt>Order / correlation ID</dt>
            <dd>{inspect.order_id}</dd>
            <dt>Origem → destino</dt>
            <dd>
              {inspect.source} → {inspect.target ?? 'terminal'}
            </dd>
            <dt>Evento causador</dt>
            <dd>
              {inspect.causation_id ? (
                <button
                  className="text-btn"
                  onClick={() => {
                    const parent = state?.events.find((e) => e.id === inspect.causation_id)
                    if (parent) setInspect(parent)
                  }}
                >
                  {inspect.causation_id}
                </button>
              ) : (
                'Raiz da cadeia'
              )}
            </dd>
            <dt>Criado às</dt>
            <dd>{time(inspect.created_at)}</dd>
          </dl>
          <h3 className="code-label">PAYLOAD</h3>
          <pre>{JSON.stringify(inspect.payload, null, 2)}</pre>
          <h3 className="code-label">ENTREGAS DESTE EVENTO</h3>
          <div className="inspect-deliveries">
            {state?.deliveries
              .filter((d) => d.event_id === inspect.id)
              .map((d) => (
                <div key={d.id}>
                  <code>{short(d.id)}</code>
                  <span>{serviceInfo[d.service].name}</span>
                  <Badge value={d.status} />
                  <small>{d.attempts} tentativa(s)</small>
                </div>
              ))}
            {!state?.deliveries.some((d) => d.event_id === inspect.id) && (
              <p className="muted">
                Sem entregas. Evento terminal, publicação pendente ou janela de perda simulada.
              </p>
            )}
          </div>
        </Modal>
      )}
    </div>
  )
}

function SearchInput({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return (
    <label className="search">
      <Search size={16} />
      <input
        aria-label="Buscar eventos ou entregas"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Buscar por ID, tipo ou serviço…"
      />
      {value && (
        <button className="icon-btn" aria-label="Limpar busca" onClick={() => onChange('')}>
          <X size={14} />
        </button>
      )}
    </label>
  )
}
function FaultControl({
  fault,
  busy,
  onChange,
}: {
  fault: Fault
  busy: boolean
  onChange: (changes: Partial<Fault>) => Promise<void>
}) {
  const info = serviceInfo[fault.service]
  const Icon = info.icon
  const [latency, setLatency] = useState(fault.latency_ms)
  useEffect(() => {
    setLatency(fault.latency_ms)
  }, [fault.latency_ms])
  return (
    <div className="fault-row">
      <div className="fault-name">
        <span className={`small-service-icon ${info.accent}`}>
          <Icon size={17} />
        </span>
        <strong>{info.name}</strong>
        <span className={`fault-state ${fault.fail_next ? 'orange' : 'muted'}`}>
          {fault.fail_next ? `${fault.fail_next} falha(s) restante(s)` : 'Sem falhas injetadas'}
        </span>
        <button
          disabled={busy}
          className={`toggle ${!fault.paused ? 'on' : ''}`}
          aria-label={`${fault.paused ? 'Retomar' : 'Pausar'} ${info.name}`}
          aria-pressed={!fault.paused}
          onClick={() => onChange({ paused: fault.paused ? 0 : 1 } as Partial<Fault>)}
        >
          <span />
        </button>
      </div>
      <div className="fault-actions">
        <button className="btn micro" disabled={busy} onClick={() => onChange({ fail_next: 2 })}>
          Falhar 2×
        </button>
        <button className="btn micro" disabled={busy} onClick={() => onChange({ fail_next: 1000 })}>
          Falha contínua
        </button>
        <button
          className="btn micro"
          disabled={busy}
          title="Simular perda do próximo ACK"
          onClick={() => onChange({ ack_loss_next: 1 })}
        >
          Perder ACK
        </button>
        {(fault.fail_next > 0 || fault.ack_loss_next > 0) && (
          <button
            className="btn micro recover"
            disabled={busy}
            onClick={() => onChange({ fail_next: 0, ack_loss_next: 0 })}
          >
            Recuperar
          </button>
        )}
      </div>
      <form
        className="latency-control"
        onSubmit={(e) => {
          e.preventDefault()
          void onChange({ latency_ms: latency })
        }}
      >
        <label htmlFor={`latency-${fault.service}`}>Latência</label>
        <input
          id={`latency-${fault.service}`}
          type="number"
          min={0}
          max={15000}
          step={100}
          value={latency}
          onChange={(e) => setLatency(Number(e.target.value))}
          required
        />
        <span>ms</span>
        <button className="text-btn" disabled={busy || latency === fault.latency_ms}>
          Aplicar
        </button>
      </form>
    </div>
  )
}
