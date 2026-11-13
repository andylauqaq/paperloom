import { useEffect, useRef, useState } from 'react'
import {
  Archive,
  ArrowRight,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Copy,
  FileText,
  FolderOpen,
  LoaderCircle,
  Network,
  Plus,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  X,
  AlertCircle,
} from 'lucide-react'
import { call } from './api.js'

function Modal({ children, title, subtitle, onClose, className = '', footer }) {
  const dialog = useRef(null)
  useEffect(() => {
    const previous = document.activeElement
    const frame = requestAnimationFrame(() =>
      dialog.current?.querySelector('button, input, select, textarea')?.focus(),
    )
    const onKey = (event) => {
      if (event.key === 'Escape') onClose()
      if (event.key !== 'Tab') return
      const controls = [
        ...dialog.current.querySelectorAll(
          'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex="0"]',
        ),
      ].filter((element) => element.offsetParent !== null)
      const first = controls[0]
      const last = controls.at(-1)
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last?.focus()
      }
      if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first?.focus()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => {
      cancelAnimationFrame(frame)
      document.removeEventListener('keydown', onKey)
      previous?.focus()
    }
  }, [onClose])
  return (
    <div
      className="modal-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <section
        className={`modal ${className}`}
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <header className="modal-heading">
          <div>
            <h2>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <button className="icon-button" onClick={onClose} aria-label="关闭窗口">
            <X size={19} />
          </button>
        </header>
        {children}
        {footer && <footer className="modal-footer">{footer}</footer>}
      </section>
    </div>
  )
}

export function SettingsModal({ tab: initialTab, snapshot, onClose, onSave, notify }) {
  const [tab, setTab] = useState(initialTab)
  const [form, setForm] = useState({ ...snapshot.settings })
  const [format, setFormat] = useState('json')
  const [connection, setConnection] = useState(null)
  const [checking, setChecking] = useState(false)
  const [saving, setSaving] = useState(false)
  const update = (key, value) => setForm((current) => ({ ...current, [key]: value }))
  const server = snapshot.mcpConfig.mcpServers.paperloom
  const config =
    format === 'json'
      ? JSON.stringify(snapshot.mcpConfig, null, 2)
      : `[mcp_servers.paperloom]\ncommand = ${JSON.stringify(server.command)}\nargs = ${JSON.stringify(server.args)}\n\n[mcp_servers.paperloom.env]\nELECTRON_RUN_AS_NODE = "1"`
  async function copyConfig() {
    try {
      await call('copyMcpConfig', { format })
      notify('MCP 配置已复制')
    } catch (error) {
      notify(error.message, true)
    }
  }
  async function checkConnection() {
    setChecking(true)
    try {
      const result = await call('models', { ollamaUrl: form.ollamaUrl })
      setConnection(result)
      if (
        result.connected &&
        result.models.length &&
        !result.models.some((model) => model.name === form.model)
      )
        update('model', result.models[0].name)
    } catch (error) {
      setConnection({ connected: false, error: error.message })
    } finally {
      setChecking(false)
    }
  }
  async function save() {
    setSaving(true)
    try {
      await onSave(form)
    } finally {
      setSaving(false)
    }
  }
  return (
    <Modal
      title="文献库设置"
      subtitle="连接 AI，设置属于你的整理方式。"
      className="settings-modal"
      onClose={onClose}
      footer={
        <>
          <span className="footer-note">
            <ShieldCheck size={13} />
            设置保存在这台电脑
          </span>
          <button className="button secondary" onClick={onClose}>
            关闭
          </button>
          <button className="button primary" disabled={saving} onClick={() => void save()}>
            {saving && <LoaderCircle size={14} className="spin" />}保存设置
          </button>
        </>
      }
    >
      <div className="settings-layout">
        <nav className="settings-nav" aria-label="设置分类">
          {[
            { id: 'ai', name: 'AI 连接', icon: Network },
            { id: 'rules', name: '命名规则', icon: SlidersHorizontal },
            { id: 'folders', name: '文件夹', icon: FolderOpen },
          ].map(({ id, name, icon: Icon }) => (
            <button key={id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>
              <Icon size={16} />
              {name}
              <ChevronRight size={13} />
            </button>
          ))}
        </nav>
        <div className="settings-content">
          {tab === 'ai' && (
            <>
              <div className="section-heading">
                <h3>选择 AI 工作方式</h3>
                <p>外部 Agent 和本地模型共用同一份文献库。</p>
              </div>
              <div className="provider-options">
                <button
                  className={form.provider === 'agent' ? 'selected' : ''}
                  onClick={() =>
                    setForm((current) => ({ ...current, provider: 'agent', autoAnalyze: false }))
                  }
                >
                  <Network size={21} />
                  <strong>已有 AI Agent</strong>
                  <span>通过 MCP 读取与整理</span>
                  <span className="radio-mark">
                    {form.provider === 'agent' && <Check size={11} />}
                  </span>
                </button>
                <button
                  className={form.provider === 'ollama' ? 'selected' : ''}
                  onClick={() => update('provider', 'ollama')}
                >
                  <Sparkles size={21} />
                  <strong>Ollama 本地模型</strong>
                  <span>从软件发起全文分析</span>
                  <span className="radio-mark">
                    {form.provider === 'ollama' && <Check size={11} />}
                  </span>
                </button>
              </div>
              {form.provider === 'agent' ? (
                <>
                  <div className="connection-heading">
                    <h3>MCP 接入配置</h3>
                    <span className="status green">
                      <span className="status-dot" />
                      接口已开启
                    </span>
                  </div>
                  <p className="settings-description">
                    把下方配置添加到你的 Agent，然后保持纸序运行。Agent
                    可以读取全文、保存字段和执行整理。
                  </p>
                  <div className="code-panel">
                    <div>
                      <select
                        aria-label="MCP 配置格式"
                        value={format}
                        onChange={(event) => setFormat(event.target.value)}
                      >
                        <option value="json">通用 JSON</option>
                        <option value="toml">Codex TOML</option>
                      </select>
                      <button onClick={() => void copyConfig()}>
                        <Copy size={13} />
                        复制配置
                      </button>
                    </div>
                    <pre>{config}</pre>
                  </div>
                  <div className="agent-next-step">
                    <span>
                      <Sparkles size={17} />
                      <strong>接入后，让 Agent 开始阅读</strong>
                    </span>
                    <p>从待整理文献开始，提取研究对象和原文依据，再按当前规则生成命名预览。</p>
                    <button
                      className="button secondary compact"
                      onClick={async () => {
                        try {
                          await call('copyAgentPrompt')
                          notify('整理指令已复制，可以发送给已接入的 Agent')
                        } catch (error) {
                          notify(error.message, true)
                        }
                      }}
                    >
                      <Copy size={13} />
                      复制整理指令
                    </button>
                  </div>
                  {snapshot.lastAgentCall && (
                    <p className="connection-last-seen">
                      <CheckCircle2 size={13} />
                      最近访问 {new Date(snapshot.lastAgentCall.time).toLocaleTimeString(
                        'zh-CN',
                      )} · {snapshot.lastAgentCall.method}
                    </p>
                  )}
                </>
              ) : (
                <>
                  <label className="form-field">
                    模型服务地址
                    <input
                      value={form.ollamaUrl}
                      onChange={(event) => update('ollamaUrl', event.target.value)}
                      placeholder="http://127.0.0.1:11434"
                    />
                  </label>
                  <button
                    className="button secondary"
                    disabled={checking}
                    onClick={() => void checkConnection()}
                  >
                    {checking ? <LoaderCircle className="spin" size={14} /> : <Network size={14} />}
                    检测连接与模型
                  </button>
                  {connection && (
                    <div className={connection.connected ? 'inline-info' : 'inline-warning'}>
                      {connection.connected
                        ? `已连接，检测到 ${connection.models.length} 个本地模型`
                        : `连接失败，请确认 Ollama 已运行。${connection.error || ''}`}
                    </div>
                  )}
                  <label className="form-field">
                    模型名称
                    {connection?.connected ? (
                      <select
                        value={form.model}
                        onChange={(event) => update('model', event.target.value)}
                      >
                        <option value="">选择已安装的模型</option>
                        {connection.models.map((model) => (
                          <option key={model.name} value={model.name}>
                            {model.name}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        value={form.model}
                        onChange={(event) => update('model', event.target.value)}
                        placeholder="已安装的本地模型名称"
                      />
                    )}
                  </label>
                  <p className="settings-description">
                    模型在电脑上运行，逐段读取全文。长文献的处理时间取决于模型和硬件。
                  </p>
                </>
              )}
              <label className="form-field project-focus">
                项目关注点 <span>可选</span>
                <textarea
                  value={form.projectFocus}
                  onChange={(event) => update('projectFocus', event.target.value)}
                  placeholder="例如，关注肠道菌群与结直肠癌治疗应答的研究。"
                />
              </label>
            </>
          )}
          {tab === 'rules' && (
            <>
              <div className="section-heading">
                <h3>用熟悉的方式命名</h3>
                <p>字段来自已保存的文献信息，缺失字段会在整理预览中提示。</p>
              </div>
              <div className="template-options">
                {snapshot.templates.map((template) => (
                  <label
                    className={form.template === template.id ? 'selected' : ''}
                    key={template.id}
                  >
                    <input
                      type="radio"
                      name="template"
                      value={template.id}
                      checked={form.template === template.id}
                      onChange={() => update('template', template.id)}
                    />
                    <span>
                      <strong>{template.name}</strong>
                      <code>
                        {template.id === 'custom' ? form.customTemplate : template.pattern}
                      </code>
                    </span>
                    {form.template === template.id && <CheckCircle2 size={17} />}
                  </label>
                ))}
              </div>
              {form.template === 'custom' && (
                <label className="form-field">
                  自定义模板
                  <input
                    value={form.customTemplate}
                    onChange={(event) => update('customTemplate', event.target.value)}
                  />
                  <span className="field-help">
                    可用字段
                    title、year、author、drug、microbe、disease、studyType、topic，使用花括号包裹。
                  </span>
                </label>
              )}
              <label className="form-field">
                命名语言
                <select
                  value={form.language}
                  onChange={(event) => update('language', event.target.value)}
                >
                  <option value="zh">中文 · 菌种保留拉丁学名</option>
                  <option value="en">English · 英文命名</option>
                </select>
              </label>
              <div className="rule-note">
                <ShieldCheck size={17} />
                <p>
                  文件名末尾保留短指纹，帮助区分同名文献。原始题名、作者和 DOI 保存在文献卡片中。
                </p>
              </div>
            </>
          )}
          {tab === 'folders' && (
            <>
              <div className="section-heading">
                <h3>下载目录与文献库</h3>
                <p>选择下载文献的文件夹，支持自动导入新 PDF。</p>
              </div>
              <label className="form-field">
                下载文献的文件夹
                <div className="path-input">
                  <input
                    aria-label="下载文献的文件夹"
                    value={form.watchFolder}
                    readOnly
                    placeholder="选择一个本地文件夹"
                  />
                  <button
                    className="button secondary"
                    onClick={async () => {
                      try {
                        const folder = await call('chooseWatchFolder')
                        if (folder) update('watchFolder', folder)
                      } catch (error) {
                        notify(error.message, true)
                      }
                    }}
                  >
                    <FolderOpen size={15} />
                    选择
                  </button>
                </div>
              </label>
              <label className="toggle-row">
                <span>
                  <strong>自动导入新文献</strong>
                  <small>文件下载完成后读取并导入，重复下载按指纹识别。</small>
                </span>
                <input
                  type="checkbox"
                  role="switch"
                  checked={form.watchEnabled}
                  onChange={(event) => update('watchEnabled', event.target.checked)}
                />
              </label>
              {form.provider === 'ollama' && (
                <label className="toggle-row">
                  <span>
                    <strong>导入后自动分析</strong>
                    <small>使用已选的本地模型读取新文献。</small>
                  </span>
                  <input
                    type="checkbox"
                    role="switch"
                    checked={form.autoAnalyze}
                    onChange={(event) => update('autoAnalyze', event.target.checked)}
                  />
                </label>
              )}
              <div className="storage-card">
                <FolderOpen size={20} />
                <div>
                  <strong>文献库存储位置</strong>
                  <code>{snapshot.root}</code>
                  <p>导入的 PDF 副本、索引、逐页正文和运行日志保存在这里。</p>
                </div>
              </div>
              <div className="agent-next-step">
                <strong>归档与主题</strong>
                <p>文件按主要疾病或主题保存。文献可以同时拥有多个标签，便于从不同研究方向查找。</p>
              </div>
            </>
          )}
        </div>
      </div>
    </Modal>
  )
}

export function MetadataModal({ document, onClose, onSave }) {
  const [form, setForm] = useState(structuredClone(document.metadata))
  const [saving, setSaving] = useState(false)
  const update = (key, value) => setForm((current) => ({ ...current, [key]: value }))
  const arrayInput = (key, label) => (
    <label className="form-field" key={key}>
      {label}
      <textarea
        className="short-textarea"
        value={form[key].join('\n')}
        onChange={(event) => update(key, event.target.value.split('\n'))}
        placeholder="每行填写一个，未知时留空"
      />
    </label>
  )
  const fieldInput = (key, label, multiline = false) => (
    <label className="form-field" key={key}>
      {label}
      {multiline ? (
        <textarea value={form[key]} onChange={(event) => update(key, event.target.value)} />
      ) : (
        <input value={form[key]} onChange={(event) => update(key, event.target.value)} />
      )}
    </label>
  )
  async function save() {
    const cleaned = { ...form }
    for (const [key, value] of Object.entries(cleaned)) {
      if (Array.isArray(value) && key !== 'evidence')
        cleaned[key] = value.map((item) => item.trim()).filter(Boolean)
    }
    setSaving(true)
    try {
      await onSave(cleaned)
    } finally {
      setSaving(false)
    }
  }
  return (
    <Modal
      title="核对文献信息"
      subtitle="按论文原文修改，未知内容可以留空。"
      className="metadata-modal"
      onClose={onClose}
      footer={
        <>
          <span className="footer-note">保存后标记为已人工核对</span>
          <button className="button secondary" onClick={onClose}>
            取消
          </button>
          <button className="button primary" disabled={saving} onClick={() => void save()}>
            {saving ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />}保存并确认
          </button>
        </>
      }
    >
      <div className="metadata-form">
        {fieldInput('title', '原始题名')}
        <div className="form-grid">
          {fieldInput('shortTitleZh', '中文短标题')}
          {fieldInput('shortTitleEn', 'English short title')}
          {fieldInput('year', '发表年份')}
          {fieldInput('doi', 'DOI')}
          {arrayInput('authors', '作者')}
          {arrayInput('microbes', '菌种 / 菌群（拉丁学名）')}
          {arrayInput('drugsZh', '药物 / 干预（中文）')}
          {arrayInput('drugsEn', 'Drugs / interventions')}
          {arrayInput('diseasesZh', '疾病（中文）')}
          {arrayInput('diseasesEn', 'Diseases')}
          {fieldInput('studyTypeZh', '研究类型（中文）')}
          {fieldInput('studyTypeEn', 'Study type')}
          {arrayInput('tagsZh', '研究主题（中文）')}
          {arrayInput('tagsEn', 'Topics')}
          {fieldInput('findingZh', '主要发现（中文）', true)}
          {fieldInput('findingEn', 'Key findings', true)}
        </div>
        <div className="metadata-evidence-heading">
          <h3>原文依据</h3>
          <button
            className="button secondary compact"
            onClick={() =>
              update('evidence', [
                ...form.evidence,
                { field: 'finding', value: '', page: 1, quote: '' },
              ])
            }
          >
            <Plus size={13} />
            添加依据
          </button>
        </div>
        {form.evidence.map((entry, index) => (
          <div className="editable-evidence" key={index}>
            <div>
              <select
                aria-label={`依据 ${index + 1} 对应字段`}
                value={entry.field}
                onChange={(event) =>
                  update(
                    'evidence',
                    form.evidence.map((item, current) =>
                      current === index ? { ...item, field: event.target.value } : item,
                    ),
                  )
                }
              >
                {[
                  { id: 'finding', label: '主要发现' },
                  { id: 'drug', label: '药物' },
                  { id: 'microbe', label: '菌种' },
                  { id: 'disease', label: '疾病' },
                  { id: 'studyType', label: '研究类型' },
                  { id: 'title', label: '题名' },
                  { id: 'authors', label: '作者' },
                  { id: 'year', label: '年份' },
                  { id: 'doi', label: 'DOI' },
                  { id: 'tag', label: '主题' },
                ].map((field) => (
                  <option value={field.id} key={field.id}>
                    {field.label}
                  </option>
                ))}
              </select>
              <label>
                第
                <input
                  type="number"
                  aria-label={`依据 ${index + 1} 页码`}
                  min={1}
                  max={document.pageCount}
                  value={entry.page}
                  onChange={(event) =>
                    update(
                      'evidence',
                      form.evidence.map((item, current) =>
                        current === index ? { ...item, page: Number(event.target.value) } : item,
                      ),
                    )
                  }
                />
                页
              </label>
              <button
                className="icon-button"
                aria-label={`移除依据 ${index + 1}`}
                onClick={() =>
                  update(
                    'evidence',
                    form.evidence.filter((_item, current) => current !== index),
                  )
                }
              >
                <X size={14} />
              </button>
            </div>
            <input
              aria-label={`依据 ${index + 1} 字段值`}
              placeholder="对应的研究对象或发现"
              value={entry.value}
              onChange={(event) =>
                update(
                  'evidence',
                  form.evidence.map((item, current) =>
                    current === index ? { ...item, value: event.target.value } : item,
                  ),
                )
              }
            />
            <textarea
              aria-label={`依据 ${index + 1} 原文`}
              placeholder="粘贴该页逐字原文，保存时会自动校验"
              value={entry.quote}
              onChange={(event) =>
                update(
                  'evidence',
                  form.evidence.map((item, current) =>
                    current === index ? { ...item, quote: event.target.value } : item,
                  ),
                )
              }
            />
          </div>
        ))}
      </div>
    </Modal>
  )
}

export function PreviewModal({ plan, onClose, onApply }) {
  const [working, setWorking] = useState(false)
  const outcome = plan.outcome
  const failed = outcome?.results.filter((item) => item.status === 'failed') || []
  async function apply() {
    setWorking(true)
    try {
      await onApply()
    } finally {
      setWorking(false)
    }
  }
  return (
    <Modal
      title={outcome ? '整理执行结果' : '预览命名与归档'}
      subtitle={`${plan.items.length} 篇文献 · ${plan.settings.language === 'zh' ? '中文命名' : '英文命名'}`}
      className="preview-modal"
      onClose={() => {
        if (!working) onClose()
      }}
      footer={
        <>
          <span className="footer-note">
            <ShieldCheck size={13} />
            整理库内副本，支持按批次撤销
          </span>
          <button className="button secondary" disabled={working} onClick={onClose}>
            {outcome ? '关闭' : '取消'}
          </button>
          {!outcome && (
            <button className="button primary" disabled={working} onClick={() => void apply()}>
              {working ? <LoaderCircle className="spin" size={15} /> : <Archive size={15} />}归档{' '}
              {plan.items.length} 篇文献
            </button>
          )}
        </>
      }
    >
      <div className="preview-content">
        {outcome && (
          <div className={failed.length ? 'inline-warning' : 'inline-info'}>
            {failed.length ? <AlertCircle size={17} /> : <CheckCircle2 size={17} />}
            {failed.length
              ? `${failed.length} 篇整理失败，其他文献的结果如下。`
              : '文献已按当前命名规则完成整理。'}
          </div>
        )}
        {plan.items.map((item) => {
          const result = outcome?.results.find((value) => value.id === item.id)
          return (
            <div className="preview-item" key={item.id}>
              <div className="preview-file-icon">
                <FileText size={22} />
              </div>
              <div>
                <span className="preview-original">{item.originalName}</span>
                <div className="preview-name">
                  <ArrowRight size={14} />
                  <strong>{item.fileName}</strong>
                </div>
                <span className="preview-folder">
                  <FolderOpen size={12} />
                  已整理 / {item.folder}
                </span>
                {!outcome &&
                  item.warnings.map((warning) => (
                    <p className="preview-warning" key={warning}>
                      <AlertCircle size={11} />
                      {warning}
                    </p>
                  ))}
                {result && (
                  <p className={result.status === 'failed' ? 'preview-error' : 'preview-success'}>
                    {result.status === 'failed'
                      ? result.error
                      : result.status === 'skipped'
                        ? '文件已位于该路径'
                        : '已归档'}
                  </p>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </Modal>
  )
}

export function TextModal({ id, page, onClose }) {
  const [current, setCurrent] = useState(page)
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let active = true
    setError('')
    setData(null)
    call('readDocument', { id, startPage: current, pageCount: 1 })
      .then((result) => {
        if (active) setData(result)
      })
      .catch((failure) => {
        if (active) setError(failure.message)
      })
    return () => {
      active = false
    }
  }, [id, current])
  return (
    <Modal
      title="逐页原文"
      subtitle={data?.document.metadata.title}
      className="text-modal"
      onClose={onClose}
      footer={
        <>
          <span className="footer-note">PDF 提取文本 · 保留实际页码</span>
          <button
            className="button secondary compact"
            disabled={current <= 1}
            onClick={() => setCurrent(current - 1)}
          >
            <ChevronLeft size={14} />
            上一页
          </button>
          <span className="page-number">
            {current} / {data?.totalPages || '…'}
          </span>
          <button
            className="button secondary compact"
            disabled={!data || current >= data.totalPages}
            onClick={() => setCurrent(current + 1)}
          >
            下一页
            <ChevronRight size={14} />
          </button>
        </>
      }
    >
      <div className="text-content">
        {error ? (
          <div className="inline-warning">{error}</div>
        ) : data ? (
          <pre>{data.pages[0]?.text || '此页未提取到足够文字，可能需要 OCR。'}</pre>
        ) : (
          <div className="loading-block">
            <LoaderCircle className="spin" size={22} />
            正在读取第 {current} 页
          </div>
        )}
      </div>
    </Modal>
  )
}
