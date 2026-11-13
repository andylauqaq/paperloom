import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowLeft,
  ArrowUpRight,
  BookOpen,
  Check,
  ChevronRight,
  Copy,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  Inbox,
  LoaderCircle,
  RefreshCw,
  Search,
  X,
} from 'lucide-react'
import { call } from './api.js'

const pageSize = 100
const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' })
const count = (value) => new Intl.NumberFormat('zh-CN').format(value)
const inFolder = (relative, folder) => !folder || relative.startsWith(`${folder}/`)

function formatBytes(bytes) {
  if (bytes === 0) return '0 字节'
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GiB`
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`
  return `${Math.max(1, Math.round(bytes / 1024))} KiB`
}

function fileTitle(name) {
  return name
    .replace(/\.pdf$/i, '')
    .replace(/__[a-f0-9]{10}$/i, '')
    .replace(/^((?:19|20)\d{2}|未标年)_/, '')
}

export default function App() {
  const [snapshot, setSnapshot] = useState(null)
  const [location, setLocation] = useState({ scope: 'library', relativePath: '' })
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState('name')
  const [limit, setLimit] = useState(pageSize)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [toast, setToast] = useState('')
  const request = useRef(0)
  const toastTimer = useRef(null)
  const listRef = useRef(null)

  const refresh = useCallback(async () => {
    const current = ++request.current
    setLoading(true)
    try {
      const value = await call('foldersSnapshot')
      if (current === request.current) {
        setSnapshot(value)
        setError('')
      }
    } catch (failure) {
      if (current === request.current) setError(failure.message)
    } finally {
      if (current === request.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
    const unsubscribe = window.paperloom?.subscribe(() => void refresh())
    const onFocus = () => void refresh()
    window.addEventListener('focus', onFocus)
    return () => {
      unsubscribe?.()
      window.removeEventListener('focus', onFocus)
      clearTimeout(toastTimer.current)
    }
  }, [refresh])

  useEffect(() => {
    setLimit(pageSize)
    if (listRef.current) listRef.current.scrollTop = 0
  }, [location, search, sort])

  useEffect(() => {
    if (
      snapshot &&
      !snapshot.folders.some(
        (folder) =>
          folder.scope === location.scope && folder.relativePath === location.relativePath,
      )
    ) {
      setLocation({ scope: location.scope, relativePath: '' })
    }
  }, [snapshot, location])

  const items = useMemo(() => {
    if (!snapshot) return { folders: [], files: [], total: 0 }
    const terms = search.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
    const files = snapshot.files.filter((file) => {
      if (file.scope !== location.scope) return false
      if (terms.length)
        return (
          inFolder(file.relativePath, location.relativePath) &&
          terms.every((term) => file.relativePath.toLocaleLowerCase().includes(term))
        )
      return file.parent === location.relativePath
    })
    files.sort((left, right) =>
      sort === 'recent'
        ? right.modifiedAt.localeCompare(left.modifiedAt) || collator.compare(left.name, right.name)
        : collator.compare(left.name, right.name),
    )
    const folders = terms.length
      ? []
      : snapshot.folders.filter(
          (folder) => folder.scope === location.scope && folder.parent === location.relativePath,
        )
    const current = snapshot.folders.find(
      (folder) => folder.scope === location.scope && folder.relativePath === location.relativePath,
    )
    return { folders, files, total: terms.length ? files.length : current?.count || 0 }
  }, [snapshot, location, search, sort])

  const topFolders =
    snapshot?.folders.filter((folder) => folder.scope === 'library' && folder.parent === '') || []
  const parts = location.relativePath.split('/').filter(Boolean)
  const isInbox = location.scope === 'inbox'
  const title = parts.at(-1) || (isInbox ? '待整理' : '文献库')

  function navigate(scope, relativePath = '') {
    setLocation({ scope, relativePath })
    setSearch('')
    setError('')
  }

  async function perform(method, args) {
    try {
      return await call(method, args)
    } catch (failure) {
      setError(failure.message)
      return null
    }
  }

  async function chooseWorkspace() {
    if (await perform('chooseWorkspace')) {
      navigate('library')
      await refresh()
    }
  }

  async function copyInstruction() {
    if (await perform('copyFolderInstruction')) {
      setToast('整理指令已复制，粘贴到对话中即可')
      clearTimeout(toastTimer.current)
      toastTimer.current = setTimeout(() => setToast(''), 4000)
    }
  }

  if (!snapshot)
    return (
      <div className="boot">
        <BookOpen size={34} strokeWidth={1.4} />
        <h1>纸序</h1>
        {error ? (
          <>
            <p role="alert">{error}</p>
            <button className="button primary" onClick={() => void refresh()}>
              重新打开
            </button>
          </>
        ) : (
          <>
            <LoaderCircle className="spin" size={19} />
            <p>正在读取文献文件夹</p>
          </>
        )}
      </div>
    )

  return (
    <div className="folder-app">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-symbol">
            <BookOpen size={23} strokeWidth={1.5} />
          </div>
          <div>
            <strong>纸序</strong>
            <span>Paperloom</span>
          </div>
        </div>
        <div className="nav-section">
          <button
            className={`nav-item ${!isInbox && !parts.length ? 'active' : ''}`}
            aria-label={`文献库 ${count(snapshot.counts.library)}`}
            onClick={() => navigate('library')}
          >
            <FolderOpen size={19} />
            <span>文献库</span>
            <small>{count(snapshot.counts.library)}</small>
          </button>
          <button
            className={`nav-item ${isInbox ? 'active' : ''}`}
            aria-label={`待整理 ${count(snapshot.counts.inbox)}`}
            onClick={() => navigate('inbox')}
          >
            <Inbox size={19} />
            <span>待整理</span>
            <small className={snapshot.counts.inbox ? 'inbox-count' : ''}>
              {count(snapshot.counts.inbox)}
            </small>
          </button>
        </div>
        <div className="section-label">主题文件夹</div>
        <nav className="topic-nav" aria-label="主题文件夹">
          {topFolders.map((folder) => (
            <button
              key={folder.relativePath}
              className={`topic-item ${!isInbox && (location.relativePath === folder.relativePath || location.relativePath.startsWith(`${folder.relativePath}/`)) ? 'selected' : ''}`}
              onClick={() => navigate('library', folder.relativePath)}
              title={folder.name}
            >
              <Folder size={16} />
              <span>{folder.name}</span>
              <small>{count(folder.count)}</small>
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <button
            className="workspace-button"
            onClick={() => void chooseWorkspace()}
            title={snapshot.root}
          >
            <FolderPlus size={16} />
            <span>选择工作文件夹</span>
            <ChevronRight size={14} />
          </button>
          <p title={snapshot.root}>{snapshot.root}</p>
        </div>
      </aside>
      <main className="main-panel">
        <header className="topbar">
          <nav className="breadcrumbs" aria-label="文件位置">
            <button
              className="icon-button back-button"
              title="上一级"
              aria-label="上一级"
              disabled={!parts.length}
              onClick={() => navigate(location.scope, parts.slice(0, -1).join('/'))}
            >
              <ArrowLeft size={18} />
            </button>
            <button onClick={() => navigate(location.scope)}>
              {isInbox ? '待整理' : '文献库'}
            </button>
            {parts.map((part, index) => (
              <span className="breadcrumb-part" key={index}>
                <ChevronRight size={14} />
                <button
                  onClick={() => navigate(location.scope, parts.slice(0, index + 1).join('/'))}
                  title={part}
                >
                  {part}
                </button>
              </span>
            ))}
          </nav>
          <button
            className="button add-button"
            onClick={() => void perform('openFolderItem', { scope: 'inbox' })}
          >
            <FolderPlus size={17} />
            放入新文献
          </button>
        </header>
        <div className="page-heading">
          <div>
            <h1>{title}</h1>
            <p>
              {search.trim()
                ? `找到 ${count(items.total)} 份文献`
                : `${count(items.total)} 份文献${items.folders.length ? ` · ${items.folders.length} 个文件夹` : ''}`}
            </p>
          </div>
          <button
            className="button outline"
            onClick={() => void perform('openFolderItem', location)}
          >
            <FolderOpen size={16} />
            在资源管理器中打开
            <ArrowUpRight size={14} />
          </button>
        </div>
        {isInbox && !search.trim() && !parts.length && (
          <section className="inbox-guide">
            <div className="inbox-guide-icon">
              <Inbox size={24} strokeWidth={1.5} />
            </div>
            <div>
              <h2>新文献，从这里开始</h2>
              <p>将 PDF 放进这个文件夹，然后在对话中告诉我怎样命名和分类。</p>
              <span title={snapshot.inboxPath}>{snapshot.inboxPath}</span>
            </div>
            <button className="button guide-copy" onClick={() => void copyInstruction()}>
              <Copy size={15} />
              复制整理指令
            </button>
          </section>
        )}
        <div className="file-toolbar">
          <label className="search-box">
            <Search size={17} />
            <input
              aria-label="搜索文件名"
              placeholder="搜索这个文件夹及其子文件夹"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            {search && (
              <button className="icon-button" aria-label="清空搜索" onClick={() => setSearch('')}>
                <X size={15} />
              </button>
            )}
          </label>
          <div className="toolbar-actions">
            <select
              aria-label="文件排序"
              value={sort}
              onChange={(event) => setSort(event.target.value)}
            >
              <option value="name">按名称排序</option>
              <option value="recent">最近修改</option>
            </select>
            <button
              className="icon-button refresh-button"
              title="刷新文件夹"
              aria-label="刷新文件夹"
              disabled={loading}
              onClick={() => void refresh()}
            >
              <RefreshCw size={17} className={loading ? 'spin' : ''} />
            </button>
          </div>
        </div>
        {(error || snapshot.warnings.length > 0) && (
          <div className="error-banner" role="alert">
            <span>{error || snapshot.warnings[0]}</span>
            <button className="button" onClick={() => void refresh()}>
              重新读取
            </button>
          </div>
        )}
        <div className="folder-content" ref={listRef}>
          {items.folders.length > 0 && (
            <div className="folder-grid" aria-label="子文件夹">
              {items.folders.map((folder) => (
                <button
                  className="folder-card"
                  key={folder.relativePath}
                  aria-label={`打开文件夹 ${folder.name}`}
                  onClick={() => navigate(folder.scope, folder.relativePath)}
                >
                  <div className="folder-card-top">
                    <Folder size={44} strokeWidth={1.6} />
                    <ChevronRight size={16} />
                  </div>
                  <h2 title={folder.name}>{folder.name}</h2>
                  <p>
                    <strong>{count(folder.count)}</strong> 份文献
                  </p>
                </button>
              ))}
            </div>
          )}
          {items.files.length > 0 && (
            <div className="file-list" role="table" aria-label="PDF 文献">
              <div className="file-table-head" role="row">
                <span role="columnheader">名称</span>
                <span role="columnheader">大小</span>
                <span role="columnheader">修改日期</span>
                <span />
              </div>
              {items.files.slice(0, limit).map((file) => (
                <div className="file-row" role="row" key={`${file.scope}:${file.relativePath}`}>
                  <div className="file-name-cell" role="cell">
                    <button
                      className="file-name"
                      onClick={() =>
                        void perform('openFolderItem', {
                          scope: file.scope,
                          relativePath: file.relativePath,
                          kind: 'file',
                        })
                      }
                      title={file.name}
                      aria-label={`打开文献 ${file.name}`}
                    >
                      <span className="pdf-icon">
                        <FileText size={20} strokeWidth={1.5} />
                        <span>PDF</span>
                      </span>
                      <span className="file-caption">
                        <strong>{fileTitle(file.name)}</strong>
                        <small>
                          {search.trim() && file.parent ? `${file.parent} / ` : ''}
                          {file.name.match(/^((?:19|20)\d{2})_/)?.[1] || 'PDF 文献'}
                        </small>
                      </span>
                    </button>
                  </div>
                  <span className="file-size" role="cell">
                    {formatBytes(file.bytes)}
                  </span>
                  <time role="cell" dateTime={file.modifiedAt}>
                    {new Date(file.modifiedAt).toLocaleDateString('zh-CN')}
                  </time>
                  <button
                    className="icon-button reveal-file"
                    aria-label={`定位文件 ${file.name}`}
                    title="在文件夹中定位"
                    onClick={() =>
                      void perform('revealFolderItem', {
                        scope: file.scope,
                        relativePath: file.relativePath,
                      })
                    }
                  >
                    <FolderOpen size={17} />
                  </button>
                </div>
              ))}
            </div>
          )}
          {items.files.length > limit && (
            <button
              className="button load-more"
              onClick={() => setLimit((current) => current + pageSize)}
            >
              继续显示文献 · 还有 {count(items.files.length - limit)} 份
            </button>
          )}
          {!items.folders.length && !items.files.length && (
            <div className="empty-state">
              {search.trim() ? (
                <>
                  <Search size={35} strokeWidth={1.2} />
                  <h2>没有找到匹配的文献</h2>
                  <button className="button outline" onClick={() => setSearch('')}>
                    清空搜索
                  </button>
                </>
              ) : (
                <>
                  <FolderOpen size={47} strokeWidth={1.1} />
                  <h2>{isInbox ? '等待你的下一篇文献' : '这个文件夹还是空的'}</h2>
                  <p>
                    {isInbox
                      ? '点击右上角“放入新文献”，即可打开待整理文件夹。'
                      : '整理后的 PDF 会显示在这里。'}
                  </p>
                </>
              )}
            </div>
          )}
        </div>
        <footer className="statusbar">
          <span>
            <span className={`connection-dot ${snapshot.warnings.length ? 'warning' : ''}`} />
            {loading ? '正在刷新文件夹' : '已与本地文件夹同步'}
          </span>
          <span>{formatBytes(snapshot.bytes)} · 本地文献</span>
        </footer>
      </main>
      {toast && (
        <div className="toast" role="status">
          <Check size={17} />
          {toast}
        </div>
      )}
    </div>
  )
}
