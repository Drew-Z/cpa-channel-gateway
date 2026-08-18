import { ChangeEvent, FormEvent, useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import {
  Activity, AlertTriangle, ArrowDown, ArrowUp, Check, CheckCircle2, ChevronRight,
  Clipboard, CloudCog, Copy, Database, Eye, EyeOff, FileClock, Gauge, KeyRound,
  Layers3, LogIn, LogOut, Menu, Play, RefreshCw, RotateCcw, Save, Search, Server,
  Settings2, ShieldCheck, SlidersHorizontal, Trash2, UsersRound, X, XCircle, Zap,
} from 'lucide-react'
import './styles.css'

type Json = Record<string, any>
type View = 'overview' | 'channels' | 'models' | 'routing' | 'access' | 'changes'

const VIEWS: Array<{ id: View; label: string; icon: typeof Activity }> = [
  { id: 'overview', label: '概览', icon: Gauge },
  { id: 'channels', label: '渠道', icon: Server },
  { id: 'models', label: '模型', icon: Layers3 },
  { id: 'routing', label: '路由', icon: SlidersHorizontal },
  { id: 'access', label: '客户端', icon: UsersRound },
  { id: 'changes', label: '变更', icon: FileClock },
]

function removePasswordFromAddress() {
  const url = new URL(window.location.href)
  if (!url.searchParams.has('password')) return
  url.searchParams.delete('password')
  window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`)
}

function App() {
  const [csrf, setCsrf] = useState('')
  const [loggedIn, setLoggedIn] = useState(false)
  const [loginError, setLoginError] = useState('')
  const [view, setView] = useState<View>('overview')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error' | 'info'; text: string } | null>(null)
  const [state, setState] = useState<Json | null>(null)
  const [models, setModels] = useState<Json[]>([])
  const [usage, setUsage] = useState<Json | null>(null)
  const [discovery, setDiscovery] = useState<Json | null>(null)
  const [connection, setConnection] = useState<Json | null>(null)
  const [access, setAccess] = useState<Json | null>(null)
  const [revisions, setRevisions] = useState<Json[]>([])
  const [audits, setAudits] = useState<Json[]>([])
  const [mobileNav, setMobileNav] = useState(false)
  const [dialog, setDialog] = useState<{ title: string; body: string; action: () => Promise<void> } | null>(null)

  const refresh = async () => {
    if (!loggedIn) return
    setBusy(true)
    try {
      const [nextState, nextModels, nextUsage, nextDiscovery, nextConnection, nextAccess, nextRevisions, nextAudits] = await Promise.all([
        api('/admin/api/status', { csrf }),
        api('/admin/api/models', { csrf }),
        api('/admin/api/usage', { csrf }),
        api('/admin/api/channel-discovery', { csrf }),
        api('/admin/api/connection', { csrf }),
        api('/admin/api/access', { csrf }),
        api('/admin/api/revisions?limit=20', { csrf }),
        api('/admin/api/audit-events?limit=20', { csrf }),
      ])
      setState(nextState)
      setModels(nextModels.data ?? [])
      setUsage(nextUsage)
      setDiscovery(nextDiscovery)
      setConnection(nextConnection)
      setAccess(nextAccess)
      setRevisions(nextRevisions.data ?? [])
      setAudits(nextAudits.data ?? [])
    } catch (error) {
      setNotice({ kind: 'error', text: errorMessage(error) })
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => { if (loggedIn) void refresh() }, [loggedIn, csrf])

  const login = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setLoginError('')
    const key = String(new FormData(event.currentTarget).get('password') ?? '')
    removePasswordFromAddress()
    try {
      const data = await api('/admin/api/session', { method: 'POST', body: JSON.stringify({ key }) })
      setCsrf(data.csrfToken ?? '')
      setLoggedIn(true)
    } catch (error) {
      setLoginError(errorMessage(error))
    }
  }

  const logout = async () => {
    try { await api('/admin/api/session', { method: 'DELETE', csrf }) } catch { /* session can already be expired */ }
    setLoggedIn(false)
    setCsrf('')
    setConnection(null)
  }

  if (!loggedIn) return <LoginPage error={loginError} onSubmit={login} />

  const activeLabel = VIEWS.find(item => item.id === view)?.label ?? '概览'
  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand"><div className="brand-mark"><Zap size={18} /></div><div><strong>CPA Channel Gateway</strong><span>单租户运营控制台</span></div></div>
        <div className="top-actions"><button className="icon-button mobile-menu" title="打开导航" onClick={() => setMobileNav(value => !value)}><Menu size={18} /></button><button className="button subtle" onClick={() => void refresh()} disabled={busy}><RefreshCw size={16} className={busy ? 'spin' : ''} />刷新</button><button className="button subtle" onClick={() => void logout()}><LogOut size={16} />退出</button></div>
      </header>
      <div className="workspace">
        <aside className={`sidebar ${mobileNav ? 'open' : ''}`}>
          <div className="sidebar-title">工作视图</div>
          <nav aria-label="管理台导航">{VIEWS.map(item => { const Icon = item.icon; return <button key={item.id} className={`nav-item ${view === item.id ? 'active' : ''}`} onClick={() => { setView(item.id); setMobileNav(false) }}><Icon size={17} /><span>{item.label}</span>{view === item.id && <ChevronRight size={14} />}</button> })}</nav>
          <div className="sidebar-footer"><ShieldCheck size={15} /><span>同源会话 · 内存密钥</span></div>
        </aside>
        <main className="main-content">
          <div className="page-heading"><div><div className="eyebrow">OPERATIONS / {activeLabel.toUpperCase()}</div><h1>{activeLabel}</h1></div><div className="health-indicator"><span className={`status-dot ${state?.runtime?.available === false ? 'danger' : 'success'}`} />{state?.runtime?.available === false ? '运行时不可用' : '运行中'}<span className="muted">{state?.loadedRevision ? ` · ${state.loadedRevision}` : ''}</span></div></div>
          {notice && <div className={`notice ${notice.kind}`} role="status"><span>{notice.kind === 'ok' ? <CheckCircle2 size={17} /> : notice.kind === 'error' ? <XCircle size={17} /> : <AlertTriangle size={17} />}</span><span>{notice.text}</span><button className="icon-button" title="关闭" onClick={() => setNotice(null)}><X size={16} /></button></div>}
          {view === 'overview' && <Overview state={state} usage={usage} connection={connection} csrf={csrf} setNotice={setNotice} onApply={() => openDialog(setDialog, '应用待重启配置', '应用会先排空在途请求，再替换内部运行时。', async () => { const result = await api('/admin/api/runtime/apply', { method: 'POST', csrf }); setNotice({ kind: 'ok', text: result.changed ? '配置已应用，内部运行时已就绪。' : '当前运行时已经是最新配置。' }); await refresh() })} />}
          {view === 'channels' && <Channels state={state} discovery={discovery} csrf={csrf} setNotice={setNotice} onRefresh={refresh} openDialog={setDialog} />}
          {view === 'models' && <Models models={models} state={state} csrf={csrf} setNotice={setNotice} onRefresh={refresh} openDialog={setDialog} />}
          {view === 'routing' && <Routing state={state} models={models} csrf={csrf} setNotice={setNotice} onRefresh={refresh} openDialog={setDialog} />}
          {view === 'access' && <Access access={access} channels={state?.channels ?? []} csrf={csrf} setNotice={setNotice} onRefresh={refresh} openDialog={setDialog} />}
          {view === 'changes' && <Changes state={state} revisions={revisions} audits={audits} csrf={csrf} setNotice={setNotice} onRefresh={refresh} openDialog={setDialog} />}
        </main>
      </div>
      {dialog && <ConfirmDialog {...dialog} onCancel={() => setDialog(null)} />}
    </div>
  )
}

function LoginPage({ error, onSubmit }: { error: string; onSubmit: (event: FormEvent<HTMLFormElement>) => void }) {
  return <main className="login-shell"><form className="login-panel" onSubmit={onSubmit}><div className="brand centered"><div className="brand-mark"><KeyRound size={19} /></div><div><strong>CPA Channel Gateway</strong><span>管理台登录</span></div></div><label>管理密钥<input autoFocus autoComplete="current-password" name="password" required type="password" /></label><button className="button primary full" type="submit"><LogIn size={17} />登录</button>{error && <p className="form-error" role="alert">{error}</p>}<p className="muted login-note">会话仅保存在网关内存中，重启后需要重新登录。</p></form></main>
}

function Overview({ state, usage, connection, csrf, setNotice, onApply }: { state: Json | null; usage: Json | null; connection: Json | null; csrf: string; setNotice: (value: { kind: 'ok' | 'error' | 'info'; text: string } | null) => void; onApply: () => void }) {
  const summary = usage?.summary ?? { total: 0, success: 0, failure: 0, cancelled: 0, successRate: null }
  return <div className="view-stack"><section className="band connection-band"><div className="section-heading"><div><div className="eyebrow">CLIENT CONNECTION</div><h2>客户端连接</h2></div><span className="state-tag neutral"><ShieldCheck size={14} />已认证</span></div><Connection connection={connection} csrf={csrf} setNotice={setNotice} /></section><section className="metric-grid"><Metric icon={<Activity size={18} />} label="24 小时请求" value={summary.total} hint={`${summary.success} 成功 · ${summary.failure} 失败`} /><Metric icon={<CheckCircle2 size={18} />} label="成功率" value={summary.successRate == null ? '—' : `${Number(summary.successRate).toFixed(2)}%`} hint={`${summary.cancelled} 次取消`} tone="green" /><Metric icon={<Database size={18} />} label="当前预约" value={state?.reservations?.length ?? 0} hint={state?.controlJobs?.active ? `作业：${state.controlJobs.active.type}` : '无控制作业'} tone="amber" /><Metric icon={<CloudCog size={18} />} label="配置状态" value={state?.restartRequired ? '待应用' : '已加载'} hint={state?.pendingRevision ? `pending ${state.pendingRevision}` : '运行 revision 一致'} tone={state?.restartRequired ? 'amber' : 'green'} /></section><section className="band"><div className="section-heading"><div><div className="eyebrow">RUNTIME</div><h2>运行状态</h2></div>{state?.runtime?.available && state?.restartRequired && <button className="button primary" onClick={onApply}><Play size={16} />应用待重启配置</button>}</div><RuntimeRows state={state} /></section></div>
}

function Metric({ icon, label, value, hint, tone = 'blue' }: { icon: JSX.Element; label: string; value: string | number; hint: string; tone?: string }) { return <div className={`metric ${tone}`}><div className="metric-icon">{icon}</div><div><div className="metric-label">{label}</div><strong>{value}</strong><span>{hint}</span></div></div> }

function RuntimeRows({ state }: { state: Json | null }) { const metrics = state?.runtime?.metrics; const rows = [['运行时', state?.runtime?.available === false ? '不可用' : '可用'], ['运行 revision', state?.loadedRevision ?? '—'], ['待应用 revision', state?.pendingRevision ?? '—'], ['控制状态', state?.controlState?.storage === 'memory-fallback' ? '内存降级' : '持久化'], ['队列', state?.controlJobs?.active ? `${state.controlJobs.active.type} · ${state.controlJobs.queued ?? 0} 等待` : '空闲'], ['应用结果', metrics?.lastResult ?? '—'], ['应用耗时', metrics?.lastDurationMs == null ? '—' : `${metrics.lastDurationMs} ms`], ['异常退出', metrics?.unexpectedExitCount ?? 0]]; return <div className="key-value-grid">{rows.map(([label, value]) => <div key={label}><span>{label}</span><code>{value}</code></div>)}</div> }

function Connection({ connection, csrf, setNotice }: { connection: Json | null; csrf: string; setNotice: (value: { kind: 'ok' | 'error' | 'info'; text: string } | null) => void }) {
  const [revealed, setRevealed] = useState(false)
  const [key, setKey] = useState('')
  const timer = useRef<number | undefined>(undefined)
  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current) }, [])
  const reveal = async () => { try { const data = await api('/admin/api/connection/reveal', { method: 'POST', csrf }); const value = data.apiKey ?? ''; setKey(value); setRevealed(true); if (timer.current) window.clearTimeout(timer.current); timer.current = window.setTimeout(() => { setRevealed(false); setKey('') }, 30_000); return value; } catch (error) { setNotice({ kind: 'error', text: errorMessage(error) }); return '' } }
  const copy = async (value: string, message: string) => { try { await navigator.clipboard.writeText(value); setNotice({ kind: 'ok', text: message }) } catch (error) { setNotice({ kind: 'error', text: errorMessage(error) }) } }
  if (connection?.mode === 'clients') return <div className="connection-grid"><div className="connection-field"><label>Base URL（含 /v1）<input readOnly value={connection?.baseUrl ?? '—'} /></label><button className="icon-button bordered" title="复制 Base URL" onClick={() => connection?.baseUrl && void copy(connection.baseUrl, 'Base URL 已复制')}><Copy size={16} /></button></div><div className="connection-meta"><span>认证模式</span><code>客户端 key + 渠道分组</code><span className="muted">在“客户端”视图创建或轮换 key，明文仅显示一次。</span></div></div>
  const apiKey = revealed ? key : connection?.apiKeyMasked ?? '••••••••'
  return <div className="connection-grid"><div className="connection-field"><label>Base URL（含 /v1）<input readOnly value={connection?.baseUrl ?? '—'} /></label><button className="icon-button bordered" title="复制 Base URL" onClick={() => connection?.baseUrl && void copy(connection.baseUrl, 'Base URL 已复制')}><Copy size={16} /></button></div><div className="connection-field"><label>GATEWAY_API_KEY<input readOnly type={revealed ? 'text' : 'password'} value={apiKey} /></label><button className="icon-button bordered" title={revealed ? '隐藏 API key' : '显示 API key'} onClick={() => revealed ? (setRevealed(false), setKey('')) : void reveal()}>{revealed ? <EyeOff size={16} /> : <Eye size={16} />}</button><button className="icon-button bordered" title="复制 API key" onClick={() => void (async () => { const value = revealed ? key : await reveal(); if (value) await copy(value, 'API key 已复制') })()}><Clipboard size={16} /></button></div><div className="connection-meta"><span>稳定模型</span><code>coding-main</code><code>coding-backup</code><span className="muted">显示后 30 秒自动掩码</span></div></div>
}

function Channels({ state, discovery, csrf, setNotice, onRefresh, openDialog }: { state: Json | null; discovery: Json | null; csrf: string; setNotice: (value: { kind: 'ok' | 'error' | 'info'; text: string } | null) => void; onRefresh: () => Promise<void>; openDialog: (value: { title: string; body: string; action: () => Promise<void> } | null) => void }) {
  const [syncChannel, setSyncChannel] = useState('')
  const [form, setForm] = useState({ id: '', name: '', baseUrl: '', apiKey: '', protocol: 'responses', priority: '0' })
  const [editingId, setEditingId] = useState('')
  const [editForm, setEditForm] = useState({ name: '', baseUrl: '', apiKey: '', protocol: 'responses', priority: '0' })
  const formRef = useRef<HTMLFormElement>(null)
  const editFormRef = useRef<HTMLFormElement>(null)
  const channels = state?.channels ?? []
  const editingChannel = channels.find((channel: Json) => channel.id === editingId)
  const mutate = async (path: string, options: Json, message: string) => { try { const result = await api(path, { ...options, csrf }); setNotice({ kind: 'ok', text: `${message}${result.revision ? ` · ${result.revision}` : ''}` }); await onRefresh() } catch (error) { setNotice({ kind: 'error', text: errorMessage(error) }) } }
  const setMode = (channel: Json, mode: 'production' | 'staged' | 'disabled') => openDialog({ title: `${mode === 'production' ? '启用生产' : mode === 'staged' ? '设为待测试' : '停用'} ${channel.id}`, body: channel.busy ? '该渠道当前有在途请求，会先进入排空状态。' : '配置写入后需要应用或重启才能生效。', action: () => mutate(`/admin/api/channels/${encodeURIComponent(channel.id)}`, { method: 'PATCH', body: JSON.stringify(mode === 'production' ? { enabled: true, staged: false } : mode === 'staged' ? { enabled: false, staged: true } : { enabled: false, staged: false }) }, '渠道状态已更新') })
  const submitChannel = async (syncModels: boolean) => { if (!formRef.current?.reportValidity()) return; try { const result = await api('/admin/api/channels', { method: 'POST', csrf, body: JSON.stringify({ ...form, priority: Number(form.priority), sync: syncModels }) }); setForm({ id: '', name: '', baseUrl: '', apiKey: '', protocol: 'responses', priority: '0' }); setNotice({ kind: 'ok', text: `渠道已加入待测试${result.sync ? '并完成模型同步' : ''} · ${result.revision ?? ''}` }); await onRefresh() } catch (error) { setNotice({ kind: 'error', text: errorMessage(error) }) } }
  const submit = async (event: FormEvent) => { event.preventDefault(); await submitChannel(false) }
  const sync = async () => { try { const result = await api('/admin/api/model-sync', { method: 'POST', csrf, body: JSON.stringify({ channels: syncChannel ? [syncChannel] : [] }) }); setNotice({ kind: 'ok', text: `模型目录同步完成 · ${result.channels?.reduce((sum: number, item: Json) => sum + Number(item.discovered ?? 0), 0) ?? 0} 个模型` }); await onRefresh() } catch (error) { setNotice({ kind: 'error', text: errorMessage(error) }) } }
  const beginEdit = (channel: Json) => {
    setEditingId(channel.id)
    setEditForm({
      name: channel.name ?? channel.id,
      baseUrl: channel.baseUrl ?? '',
      apiKey: '',
      protocol: channel.protocol ?? 'openai-compatible',
      priority: String(channel.priority ?? 0)
    })
  }
  const cancelEdit = () => {
    setEditingId('')
    setEditForm({ name: '', baseUrl: '', apiKey: '', protocol: 'responses', priority: '0' })
  }
  const saveEdit = async (event: FormEvent) => {
    event.preventDefault()
    if (!editingChannel || !editFormRef.current?.reportValidity()) return
    const priority = Number(editForm.priority)
    const patch: Json = {}
    const name = editForm.name.trim()
    const baseUrl = editForm.baseUrl.trim()
    const apiKey = editForm.apiKey.trim()
    if (name !== editingChannel.name) patch.name = name
    if (baseUrl !== editingChannel.baseUrl) patch.baseUrl = baseUrl
    if (editForm.protocol !== editingChannel.protocol) patch.protocol = editForm.protocol
    if (priority !== Number(editingChannel.priority ?? 0)) patch.priority = priority
    if (apiKey) patch.apiKey = apiKey
    if (!Object.keys(patch).length) {
      setNotice({ kind: 'info', text: '没有需要保存的渠道修改。' })
      return
    }
    try {
      const result = await api(`/admin/api/channels/${encodeURIComponent(editingChannel.id)}`, { method: 'PATCH', csrf, body: JSON.stringify(patch) })
      cancelEdit()
      setNotice({ kind: 'ok', text: `渠道配置已保存，应用后生效${result.revision ? ` · ${result.revision}` : ''}` })
      await onRefresh()
    } catch (error) {
      setNotice({ kind: 'error', text: errorMessage(error) })
    }
  }
  return <div className="view-stack"><section className="band"><div className="section-heading"><div><div className="eyebrow">PHYSICAL CHANNELS</div><h2>渠道目录</h2></div><span className="muted">{channels.length} 个渠道</span></div><div className="table-scroll"><table><thead><tr><th>渠道</th><th>Base URL</th><th>生命周期</th><th>健康</th><th>模型</th><th>操作</th></tr></thead><tbody>{channels.map((channel: Json) => <tr key={channel.id}><td><strong>{channel.name}</strong><small>{channel.id}</small></td><td><code>{channel.baseUrl}</code></td><td><StateTag channel={channel} /></td><td><HealthTag value={channel.health} /></td><td>{channel.modelCount ?? 0}</td><td><div className="inline-actions"><button className="icon-button bordered" title="编辑渠道" onClick={() => beginEdit(channel)}><Settings2 size={15} /></button>{channel.staged ? <><button className="button tiny" onClick={() => setMode(channel, 'production')}><Check size={14} />设为生产</button><button className="button tiny subtle" onClick={() => setMode(channel, 'disabled')}><X size={14} />移出待测</button></> : channel.enabled ? <button className="button tiny subtle" onClick={() => setMode(channel, 'disabled')}><X size={14} />停用</button> : <><button className="button tiny" onClick={() => setMode(channel, 'staged')}><Activity size={14} />待测试</button><button className="button tiny subtle" onClick={() => setMode(channel, 'production')}><Check size={14} />启用</button></>}{!channel.enabled && !channel.staged && !channel.busy && <button className="icon-button danger" title="删除渠道" onClick={() => openDialog({ title: `删除 ${channel.id}`, body: '删除前必须确认该渠道没有别名或逻辑组引用。', action: () => mutate(`/admin/api/channels/${encodeURIComponent(channel.id)}`, { method: 'DELETE' }, '渠道已删除') })}><Trash2 size={15} /></button>}</div></td></tr>)}</tbody></table></div></section>{editingChannel && <section className="band"><div className="section-heading"><div><div className="eyebrow">CHANNEL SETTINGS</div><h2>编辑 {editingChannel.id}</h2></div><button className="icon-button" title="取消编辑" onClick={cancelEdit}><X size={17} /></button></div><form ref={editFormRef} className="form-grid" onSubmit={saveEdit}><label>名称<input required maxLength={80} value={editForm.name} onChange={event => setEditForm({ ...editForm, name: event.target.value })} /></label><label>Base URL<input required type="url" value={editForm.baseUrl} onChange={event => setEditForm({ ...editForm, baseUrl: event.target.value })} /></label><label>替换 API key<input type="password" minLength={8} autoComplete="new-password" placeholder={editingChannel.hasApiKey ? '留空保持现有密钥' : '输入新的 API key'} value={editForm.apiKey} onChange={event => setEditForm({ ...editForm, apiKey: event.target.value })} /></label><label>协议<select value={editForm.protocol} onChange={event => setEditForm({ ...editForm, protocol: event.target.value })}><option value="responses">responses</option><option value="openai-compatible">openai-compatible</option><option value="claude">claude</option></select></label><label>优先级<input required step="1" type="number" value={editForm.priority} onChange={event => setEditForm({ ...editForm, priority: event.target.value })} /></label><div className="form-actions"><button className="button primary" type="submit"><Save size={16} />保存修改</button><button className="button subtle" type="button" onClick={cancelEdit}>取消</button></div></form><p className="muted compact">现有 API key 不会读取或回显；留空即可保持不变。修改会创建私有 revision，并在应用或重启后生效。</p></section>}<section className="two-column"><div className="band"><div className="section-heading"><div><div className="eyebrow">MODEL DIRECTORY</div><h2>同步模型</h2></div><Database size={18} /></div><div className="form-row"><select value={syncChannel} onChange={event => setSyncChannel(event.target.value)}><option value="">全部生产渠道</option>{channels.filter((channel: Json) => channel.enabled).map((channel: Json) => <option key={channel.id} value={channel.id}>{channel.name} · {channel.id}</option>)}</select><button className="button primary" onClick={() => void sync}><RefreshCw size={16} />读取 /models</button></div><p className="muted compact">同步只读取模型目录，不发送生成请求。</p></div><div className="band"><div className="section-heading"><div><div className="eyebrow">DISCOVERY</div><h2>渠道发现</h2></div><Search size={18} /></div><Discovery discovery={discovery} csrf={csrf} setNotice={setNotice} onRefresh={onRefresh} /></div></section><section className="band"><div className="section-heading"><div><div className="eyebrow">NEW CHANNEL</div><h2>新增待测试渠道</h2></div><span className="muted">密钥只写入配置，不回显</span></div><form ref={formRef} className="form-grid" onSubmit={submit}><label>渠道 ID<input required pattern="[a-z][a-z0-9-]{0,31}" value={form.id} onChange={event => setForm({ ...form, id: event.target.value })} /></label><label>名称<input required maxLength={80} value={form.name} onChange={event => setForm({ ...form, name: event.target.value })} /></label><label>Base URL<input required type="url" value={form.baseUrl} onChange={event => setForm({ ...form, baseUrl: event.target.value })} /></label><label>API key<input required minLength={8} type="password" autoComplete="new-password" value={form.apiKey} onChange={event => setForm({ ...form, apiKey: event.target.value })} /></label><label>协议<select value={form.protocol} onChange={event => setForm({ ...form, protocol: event.target.value })}><option value="responses">responses</option><option value="openai-compatible">openai-compatible</option><option value="claude">claude</option></select></label><label>优先级<input required step="1" type="number" value={form.priority} onChange={event => setForm({ ...form, priority: event.target.value })} /></label><div className="form-actions"><button className="button primary" type="submit"><Save size={16} />新增渠道</button><button className="button subtle" type="button" onClick={() => void submitChannel(true)}><RefreshCw size={16} />新增并同步</button></div></form></section></div>
}

function Discovery({ discovery, csrf, setNotice, onRefresh }: { discovery: Json | null; csrf: string; setNotice: (value: { kind: 'ok' | 'error' | 'info'; text: string } | null) => void; onRefresh: () => Promise<void> }) { const importChannel = async (id: string, sync: boolean) => { try { await api('/admin/api/channels/import', { method: 'POST', csrf, body: JSON.stringify({ id, sync }) }); setNotice({ kind: 'ok', text: `已导入 ${id} 为待测试渠道` }); await onRefresh() } catch (error) { setNotice({ kind: 'error', text: errorMessage(error) }) } }; if (!discovery) return <p className="muted">暂无发现结果。</p>; return <div className="discovery-list">{discovery.pendingRestart?.map((item: Json) => <div className="discovery-row" key={item.id}><div><strong>{item.name}</strong><small>{item.id} · {item.protocol}</small></div><span className="state-tag warning">等待重启</span></div>)}{discovery.unregistered?.map((item: Json) => <div className="discovery-row" key={item.id}><div><strong>{item.name}</strong><small>{item.id} · {item.baseUrl}</small></div>{item.ready ? <div className="inline-actions"><button className="button tiny" onClick={() => void importChannel(item.id, false)}>导入</button><button className="button tiny subtle" onClick={() => void importChannel(item.id, true)}>导入并同步</button></div> : <span className="state-tag danger">缺少 {item.missing?.join(', ')}</span>}</div>)}{!discovery.pendingRestart?.length && !discovery.unregistered?.length && <p className="muted">没有新的 env 渠道。</p>}</div> }

function Models({ models, state, csrf, setNotice, onRefresh, openDialog }: { models: Json[]; state: Json | null; csrf: string; setNotice: (value: { kind: 'ok' | 'error' | 'info'; text: string } | null) => void; onRefresh: () => Promise<void>; openDialog: (value: { title: string; body: string; action: () => Promise<void> } | null) => void }) {
  const candidates = useMemo(() => models.flatMap(group => group.candidates ?? []), [models])
  const [selected, setSelected] = useState('')
  const candidate = candidates.find(item => item.directId === selected)
  const restart = state?.restartRequired === true
  const run = async (path: string, method: string, body: Json, message: string) => {
    try {
      const result = await api(path, { method, csrf, body: JSON.stringify(body) })
      setNotice({ kind: 'ok', text: `${message}${result.revision ? ` · ${result.revision}` : ''}` })
      await onRefresh()
    } catch (error) {
      setNotice({ kind: 'error', text: errorMessage(error) })
    }
  }
  const test = () => { if (selected) void run('/admin/api/tests', 'POST', { model: selected }, '固定诗词测活完成') }
  const confirmAlias = (name: string) => {
    if (!candidate) return
    openDialog({
      title: `移动 ${name}`,
      body: `将固定别名指向 ${candidate.directId}。修改会创建待应用 revision。`,
      action: () => run('/admin/api/stable-aliases', 'PUT', { alias: name, channel: candidate.channel, model: candidate.upstreamModel }, `${name} 已固定到 ${candidate.directId}`)
    })
  }
  const setStatus = async (status: 'active' | 'disabled') => {
    if (!candidate) return
    await run('/admin/api/models', 'PATCH', { channel: candidate.channel, model: candidate.upstreamModel, status }, status === 'active' ? '模型已恢复' : '模型已禁用')
  }
  const toggle = () => {
    if (!candidate) return
    if (candidate.status === 'disabled') {
      void setStatus('active')
      return
    }
    openDialog({
      title: `禁用 ${candidate.directId}`,
      body: '禁用后该模型会从公开目录和生产调度移除；仍有别名或逻辑候选引用时服务器会拒绝修改。',
      action: () => setStatus('disabled')
    })
  }
  const blocked = !candidate || restart || candidate.status === 'disabled' || candidate.busy || candidate.draining || candidate.suppressed || candidate.scheduling?.reasonCodes?.some((code: string) => ['channel-busy', 'channel-draining', 'channel-cooling', 'circuit-open', 'half-open-busy', 'configuration-pending-restart'].includes(code))
  return <div className="view-stack"><section className="band"><div className="section-heading"><div><div className="eyebrow">MODEL CONTROL</div><h2>精确模型测活与路由</h2></div><span className="muted">固定诗词任务 · 不计入业务统计</span></div><div className="model-toolbar"><select value={selected} onChange={event => setSelected(event.target.value)}><option value="">请选择精确模型</option>{candidates.map(item => <option key={item.directId} value={item.directId}>{item.directId} · {item.kind === 'generation' ? '生成' : item.kind}</option>)}</select><button className="button primary" disabled={Boolean(blocked) || candidate?.canaryEligible === false} onClick={test}><Play size={16} />测活</button><button className="button" disabled={!candidate || candidate.status === 'disabled'} onClick={() => confirmAlias('coding-main')}><ArrowUp size={16} />coding-main</button><button className="button subtle" disabled={!candidate || candidate.status === 'disabled'} onClick={() => confirmAlias('coding-backup')}><ArrowDown size={16} />coding-backup</button><button className="button subtle" disabled={!candidate} onClick={toggle}>{candidate?.status === 'disabled' ? <><Check size={16} />恢复</> : <><X size={16} />禁用</>}</button></div>{restart && <p className="inline-warning"><AlertTriangle size={16} />配置待应用，测活暂时禁用。</p>}{candidate && <div className="candidate-inspector"><StateTag channel={candidate} /><HealthTag value={candidate.health} /><span>模式：{streamingLabel(candidate.streaming)}</span><span>调度：{reasonText(candidate.scheduling?.reasonCodes)}</span><span>证据：{evidenceText(candidate.scheduling?.evidence)}</span></div>}</section><section className="band"><div className="section-heading"><div><div className="eyebrow">CATALOG</div><h2>模型目录</h2></div><span className="muted">{candidates.length} 个精确候选</span></div><div className="table-scroll"><table><thead><tr><th>精确模型</th><th>类型</th><th>请求模式</th><th>生命周期</th><th>证据</th><th>调度原因</th><th>测活</th></tr></thead><tbody>{candidates.map(item => <tr key={item.directId}><td><strong>{item.directId}</strong><small>{item.channel} / {item.upstreamModel}</small></td><td>{kindLabel(item.kind)}</td><td>{streamingLabel(item.streaming)}</td><td><StateTag channel={item} /></td><td>{evidenceText(item.scheduling?.evidence)}</td><td>{reasonText(item.scheduling?.reasonCodes)}</td><td>{item.canaryEligible && item.kind === 'generation' ? <span className="state-tag success">可测活</span> : <span className="state-tag neutral">不适用</span>}</td></tr>)}</tbody></table></div></section></div>
}

function Routing({ state, models, csrf, setNotice, onRefresh, openDialog }: { state: Json | null; models: Json[]; csrf: string; setNotice: (value: { kind: 'ok' | 'error' | 'info'; text: string } | null) => void; onRefresh: () => Promise<void>; openDialog: (value: { title: string; body: string; action: () => Promise<void> } | null) => void }) {
  const groups = state?.logicalModels ?? []
  const [selected, setSelected] = useState('')
  const group = groups.find((item: Json) => item.id === selected)
  const [id, setId] = useState('')
  const [enabled, setEnabled] = useState(true)
  const [candidates, setCandidates] = useState<Json[]>([])
  const exact = useMemo(() => models.flatMap(item => item.candidates ?? []), [models])
  useEffect(() => {
    if (group) {
      setId(group.id)
      setEnabled(group.enabled)
      setCandidates(group.candidates ?? [])
    } else {
      setId('')
      setEnabled(true)
      setCandidates([])
    }
  }, [group])
  const save = async () => {
    if (!id.trim()) return
    const body = { enabled, candidates: candidates.map(item => ({ channel: item.channel, model: item.upstreamModel ?? item.model, enabled: item.enabled !== false, priority: Number(item.priority ?? 0) })) }
    try {
      await api(selected ? `/admin/api/logical-models/${encodeURIComponent(selected)}` : '/admin/api/logical-models', { method: selected ? 'PATCH' : 'POST', csrf, body: JSON.stringify(selected ? body : { id, ...body }) })
      setNotice({ kind: 'ok', text: `逻辑模型 ${selected || id} 已保存` })
      await onRefresh()
    } catch (error) {
      setNotice({ kind: 'error', text: errorMessage(error) })
    }
  }
  const add = (event: ChangeEvent<HTMLSelectElement>) => {
    const item = exact.find(candidate => candidate.directId === event.target.value)
    if (item && !candidates.some(candidate => candidate.channel === item.channel && candidate.model === item.upstreamModel)) {
      setCandidates([...candidates, { channel: item.channel, model: item.upstreamModel, upstreamModel: item.upstreamModel, enabled: true, priority: 0 }])
    }
    event.target.value = ''
  }
  const remove = (index: number) => setCandidates(candidates.filter((_, current) => current !== index))
  const confirmDelete = () => {
    if (!selected) return
    openDialog({
      title: `删除逻辑模型 ${selected}`,
      body: '删除前必须先移走稳定别名引用。确认后会创建待应用 revision。',
      action: async () => {
        try {
          await api(`/admin/api/logical-models/${encodeURIComponent(selected)}`, { method: 'DELETE', csrf })
          setNotice({ kind: 'ok', text: '逻辑模型已删除' })
          setSelected('')
          await onRefresh()
        } catch (error) {
          setNotice({ kind: 'error', text: errorMessage(error) })
        }
      }
    })
  }
  const confirmAlias = (alias: string) => {
    if (!selected) return
    openDialog({
      title: `移动 ${alias}`,
      body: `将固定别名指向逻辑模型 ${selected}。修改会创建待应用 revision。`,
      action: () => setAlias(alias, selected, csrf, setNotice, onRefresh)
    })
  }
  return <div className="view-stack"><section className="band"><div className="section-heading"><div><div className="eyebrow">FIXED ROUTING</div><h2>稳定别名</h2></div><span className="muted">别名是固定指针，不自动漂移</span></div><div className="alias-grid">{(state?.stableAliases ?? []).map((item: Json) => <div key={item.alias} className="alias-row"><code>{item.alias}</code><ChevronRight size={15} /><code>{item.logicalModel ? `logical:${item.logicalModel}` : `${item.channel}/${item.model}`}</code></div>)}</div></section><section className="band"><div className="section-heading"><div><div className="eyebrow">LOGICAL MODEL</div><h2>逻辑模型与候选</h2></div><span className="muted">不同 upstream ID 仅在显式加入后聚合</span></div><div className="form-grid routing-form"><label>逻辑模型<select value={selected} onChange={event => setSelected(event.target.value)}><option value="">新建逻辑模型</option>{groups.map((item: Json) => <option key={item.id} value={item.id}>{item.id}</option>)}</select></label><label>逻辑模型 ID<input readOnly={Boolean(selected)} title={selected ? '现有逻辑模型 ID 不可修改' : undefined} value={id} onChange={event => setId(event.target.value)} pattern="[A-Za-z0-9][A-Za-z0-9._:@+-]{0,254}" /></label><label className="checkbox"><input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} />启用</label><label>添加精确候选<select value="" onChange={add}><option value="">选择模型</option>{exact.map(item => <option key={item.directId} value={item.directId}>{item.directId}</option>)}</select></label></div><div className="candidate-list">{candidates.map((item, index) => <div className="candidate-row" key={`${item.channel}/${item.model}`}><code>{item.channel}/{item.model}</code><label>优先级<input type="number" value={item.priority ?? 0} onChange={event => setCandidates(candidates.map((candidate, current) => current === index ? { ...candidate, priority: Number(event.target.value) } : candidate))} /></label><label className="checkbox"><input type="checkbox" checked={item.enabled !== false} onChange={event => setCandidates(candidates.map((candidate, current) => current === index ? { ...candidate, enabled: event.target.checked } : candidate))} />启用</label><button className="icon-button danger" title="移除候选" onClick={() => remove(index)}><Trash2 size={15} /></button></div>)}{!candidates.length && <p className="muted">尚未添加候选。</p>}</div><div className="form-actions"><button className="button primary" onClick={() => void save}><Save size={16} />保存逻辑模型</button>{selected && <button className="button subtle" onClick={confirmDelete}><Trash2 size={16} />删除</button>}<button className="button" disabled={!selected} onClick={() => confirmAlias('coding-main')}><ArrowUp size={16} />设为 coding-main</button><button className="button subtle" disabled={!selected} onClick={() => confirmAlias('coding-backup')}><ArrowDown size={16} />设为 coding-backup</button></div></section></div>
}

async function setAlias(alias: string, logicalModel: string, csrf: string, setNotice: (value: { kind: 'ok' | 'error' | 'info' } & { text: string }) => void, onRefresh: () => Promise<void>) { try { await api('/admin/api/stable-aliases', { method: 'PUT', csrf, body: JSON.stringify({ alias, logicalModel }) }); setNotice({ kind: 'ok', text: `${alias} 已固定到 ${logicalModel}` }); await onRefresh() } catch (error) { setNotice({ kind: 'error', text: errorMessage(error) }) } }

function Access({ access, channels, csrf, setNotice, onRefresh, openDialog }: { access: Json | null; channels: Json[]; csrf: string; setNotice: (value: { kind: 'ok' | 'error' | 'info'; text: string } | null) => void; onRefresh: () => Promise<void>; openDialog: (value: { title: string; body: string; action: () => Promise<void> } | null) => void }) {
  const groups = access?.groups ?? []
  const clients = access?.clients ?? []
  const [editingGroup, setEditingGroup] = useState('')
  const [groupId, setGroupId] = useState('')
  const [groupChannels, setGroupChannels] = useState<string[]>([])
  const [clientId, setClientId] = useState('')
  const [clientGroup, setClientGroup] = useState('')
  const [issued, setIssued] = useState<{ id: string; key: string } | null>(null)
  const mutate = async (path: string, method: string, body: Json | null, message: string) => {
    try {
      const result = await api(path, { method, csrf, ...(body ? { body: JSON.stringify(body) } : {}) })
      setNotice({ kind: 'ok', text: `${message}${result.revision ? ` · ${result.revision}` : ''}` })
      await onRefresh()
      return result
    } catch (error) {
      setNotice({ kind: 'error', text: errorMessage(error) })
      return null
    }
  }
  const resetGroup = () => { setEditingGroup(''); setGroupId(''); setGroupChannels([]) }
  const saveGroup = async (event: FormEvent) => {
    event.preventDefault()
    if (!groupId || !groupChannels.length) return
    const result = await mutate(editingGroup ? `/admin/api/access/groups/${encodeURIComponent(editingGroup)}` : '/admin/api/access/groups', editingGroup ? 'PATCH' : 'POST', { id: groupId, channels: groupChannels, enabled: true }, editingGroup ? '客户端分组已更新' : '客户端分组已创建')
    if (result) resetGroup()
  }
  const editGroup = (group: Json) => { setEditingGroup(group.id); setGroupId(group.id); setGroupChannels([...(group.channels ?? [])]) }
  const toggleChannel = (id: string) => setGroupChannels(current => current.includes(id) ? current.filter(item => item !== id) : [...current, id])
  const createClient = async (event: FormEvent) => {
    event.preventDefault()
    const result = await mutate('/admin/api/access/clients', 'POST', { id: clientId, group: clientGroup, enabled: true }, '客户端已创建，立即保存下方 key')
    if (result?.key) {
      setIssued({ id: result.id, key: result.key })
      setClientId('')
    }
  }
  const rotate = (client: Json) => openDialog({
    title: `轮换 ${client.id} 的 key`,
    body: '旧 key 会在应用配置后失效；新 key 明文只显示一次。',
    action: async () => {
      const result = await mutate(`/admin/api/access/clients/${encodeURIComponent(client.id)}/rotate`, 'POST', null, '客户端 key 已轮换')
      if (result?.key) setIssued({ id: result.id, key: result.key })
    }
  })
  const copyIssued = async () => {
    if (!issued) return
    try { await navigator.clipboard.writeText(issued.key); setNotice({ kind: 'ok', text: `${issued.id} 的 API key 已复制` }) } catch (error) { setNotice({ kind: 'error', text: errorMessage(error) }) }
  }
  return <div className="view-stack">
    {issued && <section className="band"><div className="section-heading"><div><div className="eyebrow">ONE-TIME SECRET</div><h2>新客户端 key</h2></div><button className="icon-button" title="关闭" onClick={() => setIssued(null)}><X size={16} /></button></div><div className="connection-field"><label>{issued.id}<input readOnly value={issued.key} /></label><button className="icon-button bordered" title="复制 API key" onClick={() => void copyIssued()}><Clipboard size={16} /></button></div><p className="inline-warning"><AlertTriangle size={16} />离开或关闭后无法再次查看，只能轮换。</p></section>}
    <section className="band"><div className="section-heading"><div><div className="eyebrow">CHANNEL GROUPS</div><h2>互斥渠道分组</h2></div><span className="muted">启用分组之间不能共享渠道</span></div><div className="table-scroll"><table><thead><tr><th>分组</th><th>渠道</th><th>状态</th><th>操作</th></tr></thead><tbody>{groups.map((group: Json) => <tr key={group.id}><td><strong>{group.id}</strong></td><td>{group.channels.map((channel: string) => <code key={channel}>{channel} </code>)}</td><td><span className={`state-tag ${group.enabled ? 'success' : 'neutral'}`}>{group.enabled ? '启用' : '停用'}</span></td><td><div className="inline-actions"><button className="button tiny" onClick={() => editGroup(group)}><Settings2 size={14} />编辑</button><button className="button tiny subtle" onClick={() => void mutate(`/admin/api/access/groups/${encodeURIComponent(group.id)}`, 'PATCH', { enabled: !group.enabled }, group.enabled ? '分组已停用' : '分组已启用')}>{group.enabled ? <X size={14} /> : <Check size={14} />}{group.enabled ? '停用' : '启用'}</button><button className="icon-button danger" title="删除分组" onClick={() => openDialog({ title: `删除分组 ${group.id}`, body: '分组仍有关联客户端时服务器会拒绝删除。', action: async () => { await mutate(`/admin/api/access/groups/${encodeURIComponent(group.id)}`, 'DELETE', null, '分组已删除') } })}><Trash2 size={15} /></button></div></td></tr>)}</tbody></table></div><form className="form-grid" onSubmit={saveGroup}><label>分组 ID<input required readOnly={Boolean(editingGroup)} value={groupId} onChange={event => setGroupId(event.target.value)} pattern="[a-z][a-z0-9-]{0,63}" /></label><fieldset><legend>分配渠道</legend><div className="checkbox-grid">{channels.map(channel => <label className="checkbox" key={channel.id}><input type="checkbox" checked={groupChannels.includes(channel.id)} onChange={() => toggleChannel(channel.id)} />{channel.id}</label>)}</div></fieldset><div className="form-actions"><button className="button primary" type="submit" disabled={!groupChannels.length}><Save size={16} />{editingGroup ? '保存分组' : '新增分组'}</button>{editingGroup && <button className="button subtle" type="button" onClick={resetGroup}>取消</button>}</div></form></section>
    <section className="band"><div className="section-heading"><div><div className="eyebrow">CLIENT KEYS</div><h2>客户端 key</h2></div><span className="muted">只保存哈希与末尾提示</span></div><div className="table-scroll"><table><thead><tr><th>客户端</th><th>分组</th><th>Key 提示</th><th>状态</th><th>操作</th></tr></thead><tbody>{clients.map((client: Json) => <tr key={client.id}><td><strong>{client.id}</strong></td><td><code>{client.group}</code></td><td><code>{client.keyHint ? `••••${client.keyHint}` : '—'}</code></td><td><span className={`state-tag ${client.enabled ? 'success' : 'neutral'}`}>{client.enabled ? '启用' : '停用'}</span></td><td><div className="inline-actions"><button className="button tiny" onClick={() => rotate(client)}><RefreshCw size={14} />轮换</button><button className="button tiny subtle" onClick={() => void mutate(`/admin/api/access/clients/${encodeURIComponent(client.id)}`, 'PATCH', { enabled: !client.enabled }, client.enabled ? '客户端已停用' : '客户端已启用')}>{client.enabled ? <X size={14} /> : <Check size={14} />}{client.enabled ? '停用' : '启用'}</button><button className="icon-button danger" title="删除客户端" onClick={() => openDialog({ title: `删除客户端 ${client.id}`, body: '删除后该客户端 key 将无法恢复。', action: async () => { await mutate(`/admin/api/access/clients/${encodeURIComponent(client.id)}`, 'DELETE', null, '客户端已删除') } })}><Trash2 size={15} /></button></div></td></tr>)}</tbody></table></div><form className="form-grid" onSubmit={createClient}><label>客户端 ID<input required value={clientId} onChange={event => setClientId(event.target.value)} pattern="[a-z][a-z0-9-]{0,63}" /></label><label>渠道分组<select required value={clientGroup} onChange={event => setClientGroup(event.target.value)}><option value="">选择分组</option>{groups.map((group: Json) => <option key={group.id} value={group.id}>{group.id}</option>)}</select></label><div className="form-actions"><button className="button primary" type="submit" disabled={!groups.length}><KeyRound size={16} />新增 key</button></div></form></section>
  </div>
}

function Changes({ state, revisions, audits, csrf, setNotice, onRefresh, openDialog }: { state: Json | null; revisions: Json[]; audits: Json[]; csrf: string; setNotice: (value: { kind: 'ok' | 'error' | 'info'; text: string } | null) => void; onRefresh: () => Promise<void>; openDialog: (value: { title: string; body: string; action: () => Promise<void> } | null) => void }) {
  const [revision, setRevision] = useState('')
  const [diff, setDiff] = useState<Json | null>(null)
  const [keep, setKeep] = useState(50)
  const storage = state?.revisionStorage
  const prunePlan = storage?.plans?.[String(keep)] ?? storage
  const loadDiff = async () => {
    if (!revision) return
    try {
      setDiff(await api(`/admin/api/revisions/${encodeURIComponent(revision)}/diff`, { csrf }))
    } catch (error) {
      setNotice({ kind: 'error', text: errorMessage(error) })
    }
  }
  const rollback = () => {
    if (!revision) return
    openDialog({
      title: `回滚到 ${revision}`,
      body: '运行中的请求会先排空，只有新运行时 readiness 通过后才会提交。',
      action: async () => {
        try {
          await api(`/admin/api/revisions/${encodeURIComponent(revision)}/rollback`, { method: 'POST', csrf, body: JSON.stringify({ confirmRevision: revision }) })
          setNotice({ kind: 'ok', text: '回滚作业已提交到控制队列。' })
          await onRefresh()
        } catch (error) {
          setNotice({ kind: 'error', text: errorMessage(error) })
        }
      }
    })
  }
  const prune = () => {
    if (!prunePlan?.prunableCount) return
    openDialog({
      title: `整理 revision 历史，保留 ${keep} 条`,
      body: `预计删除 ${prunePlan.prunableCount} 个旧或损坏 revision，释放约 ${formatBytes(prunePlan.prunableBytes)}。loaded 与 pending revision 始终保留；删除后不能在管理台恢复。`,
      action: async () => {
        try {
          const result = await api('/admin/api/revisions/prune', { method: 'POST', csrf, body: JSON.stringify({ keep, confirmKeep: keep }) })
          setRevision('')
          setDiff(null)
          setNotice({ kind: 'ok', text: `已删除 ${result.removedCount} 个 revision，释放 ${formatBytes(result.reclaimedBytes)}` })
          await onRefresh()
        } catch (error) {
          setNotice({ kind: 'error', text: errorMessage(error) })
        }
      }
    })
  }
  return <div className="view-stack"><section className="band"><div className="section-heading revision-heading"><div><div className="eyebrow">CONFIGURATION HISTORY</div><h2>变更与回滚</h2></div><span className="muted">当前 {state?.loadedRevision ?? '—'} · 待应用 {state?.pendingRevision ?? '—'}</span></div><div className="revision-storage-row"><div><strong>私有历史存储</strong><small>{storage ? `${storage.count} 个 revision · ${formatBytes(storage.totalBytes)} · ${storage.invalidCount} 个损坏` : '容量信息不可用'}</small></div><div className="inline-actions"><label>保留<select value={keep} onChange={event => setKeep(Number(event.target.value))}><option value={20}>20 条</option><option value={50}>50 条</option><option value={100}>100 条</option></select></label><span className="muted">预计可整理 {prunePlan?.prunableCount ?? 0} 条 · {formatBytes(prunePlan?.prunableBytes ?? 0)}</span><button className="button subtle" disabled={!prunePlan?.prunableCount || Boolean(state?.controlJobs?.active)} onClick={prune}><Trash2 size={16} />整理历史</button></div></div><div className="revision-toolbar"><select value={revision} onChange={event => setRevision(event.target.value)}><option value="">选择目标 revision</option>{revisions.filter(item => item.valid !== false).map(item => <option key={item.revision} value={item.revision}>{formatDate(item.createdAt)} · {operationLabel(item.operation)}</option>)}</select><button className="button" disabled={!revision} onClick={() => void loadDiff}><Search size={16} />查看脱敏 diff</button><button className="button subtle" disabled={!revision || Boolean(state?.controlJobs?.active)} onClick={rollback}><RotateCcw size={16} />回滚</button></div>{diff && <pre className="diff-output">{formatDiff(diff.diff)}</pre>}<div className="table-scroll"><table><thead><tr><th>时间</th><th>操作</th><th>Revision</th><th>影响</th></tr></thead><tbody>{revisions.map(item => <tr key={item.revision}><td>{formatDate(item.createdAt)}</td><td>{operationLabel(item.operation)}</td><td><code>{item.revision}</code></td><td>{item.valid === false ? <span className="state-tag danger">损坏</span> : `${item.affected?.channelIds?.length ?? 0} 渠道 · ${item.affected?.modelIds?.length ?? 0} 模型`}</td></tr>)}</tbody></table></div></section><section className="band"><div className="section-heading"><div><div className="eyebrow">AUDIT TRAIL</div><h2>最近审计</h2></div><span className="muted">{audits.length} 条</span></div><div className="table-scroll"><table><thead><tr><th>时间</th><th>操作</th><th>结果</th><th>Revision</th><th>耗时</th></tr></thead><tbody>{audits.map(item => <tr key={`${item.jobId}-${item.at}`}><td>{formatDate(item.at)}</td><td>{operationLabel(item.operation)}</td><td><span className={`state-tag ${item.result === 'success' ? 'success' : 'danger'}`}>{item.result === 'success' ? '成功' : '失败'}</span></td><td><code>{item.revision ?? '—'}</code></td><td>{item.durationMs ?? 0} ms {item.errorCode ? `· ${item.errorCode}` : ''}</td></tr>)}</tbody></table></div></section></div>
}

function StateTag({ channel }: { channel: Json }) { const label = channel.draining ? '排空中' : channel.suppressed ? '配置待应用' : channel.staged ? '待测试' : channel.status === 'disabled' || channel.channelEnabled === false || channel.enabled === false ? '已停用' : channel.busy ? '忙碌' : channel.status === 'stale' ? '已下线' : '生产启用'; const tone = channel.draining || channel.busy ? 'warning' : channel.status === 'disabled' || channel.enabled === false ? 'neutral' : channel.staged ? 'info' : 'success'; return <span className={`state-tag ${tone}`}>{channel.draining && <Activity size={13} />}{label}</span> }
function HealthTag({ value }: { value?: string }) { const labels: Record<string, string> = { healthy: '健康', cooling: '冷却中', auth_failed: '认证失败', payment_blocked: '支付受限', degraded: '降级', untested: '未测试' }; const tone = value === 'healthy' ? 'success' : value === 'cooling' ? 'warning' : value ? 'danger' : 'neutral'; return <span className={`state-tag ${tone}`}>{labels[value ?? ''] ?? value ?? '未知'}</span> }
function ConfirmDialog({ title, body, action, onCancel }: { title: string; body: string; action: () => Promise<void>; onCancel: () => void }) { const ref = useRef<HTMLDialogElement>(null); const [running, setRunning] = useState(false); useEffect(() => { ref.current?.showModal() }, []); const confirm = async () => { setRunning(true); try { await action(); ref.current?.close(); onCancel() } finally { setRunning(false) } }; return <dialog ref={ref} className="confirm-dialog" onCancel={onCancel}><div className="dialog-icon"><AlertTriangle size={20} /></div><h2>{title}</h2><p>{running ? '正在执行，请等待队列完成。' : body}</p><div className="dialog-actions"><button className="button subtle" disabled={running} onClick={onCancel}>取消</button><button className="button primary" disabled={running} onClick={() => void confirm()}>{running ? <><RefreshCw size={16} className="spin" />执行中</> : '确认继续'}</button></div></dialog> }

async function api(path: string, options: { method?: string; body?: string; csrf?: string } = {}) { const method = (options.method ?? 'GET').toUpperCase(); const headers: Record<string, string> = {}; if (options.body) headers['content-type'] = 'application/json'; if (options.csrf && !['GET', 'HEAD', 'OPTIONS'].includes(method)) headers['x-csrf-token'] = options.csrf; const response = await fetch(path, { method, body: options.body, headers, mode: 'same-origin', credentials: 'same-origin' }); const data = await response.json().catch(() => ({})); if (!response.ok) throw new Error(data.error?.message ?? '请求失败'); return data }
function openDialog(setDialog: (value: { title: string; body: string; action: () => Promise<void> } | null) => void, title: string, body: string, action: () => Promise<void>) { setDialog({ title, body, action }) }
function errorMessage(error: unknown) { return error instanceof Error ? error.message : '请求失败' }
function formatDate(value?: string) { if (!value) return '—'; const date = new Date(value); return Number.isNaN(date.getTime()) ? value : date.toLocaleString() }
function kindLabel(value?: string) { return ({ generation: '生成', embedding: '向量', rerank: '重排', audio: '音频', image: '图像', video: '视频', ocr: 'OCR', moderation: '审核' } as Record<string, string>)[value ?? ''] ?? value ?? '生成' }
function streamingLabel(value?: string) { return ({ both: '流式 / 非流式', 'stream-only': '仅流式', 'non-stream-only': '仅非流式' } as Record<string, string>)[value ?? ''] ?? '流式 / 非流式' }
function evidenceText(value?: Json) { if (!value?.sampleCount) return '暂无样本'; const rate = value.successRate == null ? '—' : `${(value.successRate * 100).toFixed(1)}%`; const latency = value.ewmaLatencyMs == null ? '—' : `${Math.round(value.ewmaLatencyMs)} ms`; return `${value.sampleCount} 次 · 成功率 ${rate} · EWMA ${latency}` }
function reasonText(values?: string[]) { const labels: Record<string, string> = { priority: '优先级', 'better-success-rate': '成功率更高', 'lower-ewma-latency': '延迟更低', 'channel-cooling': '渠道冷却', 'channel-auth-failed': '认证失败', 'channel-payment-blocked': '支付受限', 'channel-busy': '渠道忙碌', 'channel-draining': '渠道排空', 'candidate-misconfigured': '配置错误', 'circuit-open': '候选熔断', 'half-open-busy': '半开忙碌', 'configuration-pending-restart': '等待应用', 'candidate-ready': '可调度' }; return values?.map(value => labels[value] ?? value).join('、') || '—' }
function operationLabel(value?: string) { return ({ 'startup-baseline': '启动基线', 'external-change': '外部变更', 'channel-create': '新增渠道', 'channel-import': '导入渠道', 'channel-update': '更新渠道', 'channel-delete': '删除渠道', 'model-update': '更新模型', 'alias-update': '更新别名', 'logical-model-create': '新增逻辑模型', 'logical-model-update': '更新逻辑模型', 'logical-model-delete': '删除逻辑模型', 'revision-prune': '整理 revision', 'model-sync': '同步模型', 'runtime-rollback': '运行回滚' } as Record<string, string>)[value ?? ''] ?? value ?? '未知' }
function formatBytes(value?: number) { const bytes = Number(value ?? 0); if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'; if (bytes < 1024) return `${Math.round(bytes)} B`; if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`; return `${(bytes / (1024 * 1024)).toFixed(1)} MiB` }
function formatDiff(value: unknown) { if (!value || typeof value !== 'object') return '没有结构变化。'; const lines: string[] = []; const walk = (node: any, prefix = '') => { if (Array.isArray(node)) node.forEach(item => walk(item, prefix)); else if (node && typeof node === 'object') Object.entries(node).forEach(([key, item]) => { if (Array.isArray(item) && item.length) lines.push(`${prefix}${key}: ${item.map(value => typeof value === 'object' ? JSON.stringify(value) : value).join('、')}`); else if (item && typeof item === 'object') walk(item, `${prefix}${key} / `) }); }; walk(value); return lines.join('\n') || '没有结构变化。' }

export default App

createRoot(document.getElementById('root')!).render(<App />)
