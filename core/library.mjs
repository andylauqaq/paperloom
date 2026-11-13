/**
 * 本地文献库服务，2026-11-13。
 * 输入为用户选择的 PDF、字段与命名规则，输出为 SQLite 索引、文献副本及操作日志。
 * 整理仅操作文献库中的副本。逐文件持久化操作记录，用于重启恢复和撤销。
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { EventEmitter } from 'node:events'
import { DatabaseSync } from 'node:sqlite'
import { extractPdf } from './pdf.mjs'
import { analyzeWithOllama, getModels } from './ai.mjs'
import {
  buildName,
  defaultSettings,
  emptyMetadata,
  templates,
  validateMetadata,
  validateSettings,
} from './metadata.mjs'

const now = () => new Date().toISOString()
const digest = (filePath) =>
  crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
const samePath = (left, right) =>
  process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right

export class Library extends EventEmitter {
  constructor(root) {
    super()
    fs.mkdirSync(root, { recursive: true })
    this.root = fs.realpathSync(root)
    this.filesRoot = path.join(this.root, 'files')
    fs.mkdirSync(path.join(this.filesRoot, '待整理'), { recursive: true })
    fs.mkdirSync(path.join(this.root, 'logs'), { recursive: true })
    this.logFile = path.join(
      this.root,
      'logs',
      `paperloom-0.2.1-${now().replace(/[:.]/g, '-')}.jsonl`,
    )
    this.db = new DatabaseSync(path.join(this.root, 'library.sqlite'))
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS documents (
        id TEXT PRIMARY KEY, hash TEXT NOT NULL UNIQUE, original_name TEXT NOT NULL,
        source_path TEXT NOT NULL, file_path TEXT NOT NULL, imported_at TEXT NOT NULL,
        page_count INTEGER NOT NULL, text_length INTEGER NOT NULL, empty_pages TEXT NOT NULL,
        metadata TEXT NOT NULL, warnings TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL,
        origin TEXT NOT NULL DEFAULT 'pdf', confirmed INTEGER NOT NULL DEFAULT 0,
        organized INTEGER NOT NULL DEFAULT 0, favorite INTEGER NOT NULL DEFAULT 0,
        read_state TEXT NOT NULL DEFAULT 'unread', note TEXT NOT NULL DEFAULT '',
        revision INTEGER NOT NULL DEFAULT 0, analysis_state TEXT NOT NULL DEFAULT 'idle',
        analysis_message TEXT NOT NULL DEFAULT '', analyzed_at TEXT
      );
      CREATE TABLE IF NOT EXISTS pages (
        document_id TEXT NOT NULL REFERENCES documents(id), number INTEGER NOT NULL,
        text TEXT NOT NULL, PRIMARY KEY(document_id, number)
      );
      CREATE TABLE IF NOT EXISTS plans (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, status TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS operations (
        id TEXT PRIMARY KEY, batch_id TEXT NOT NULL, document_id TEXT NOT NULL,
        created_at TEXT NOT NULL, status TEXT NOT NULL, payload TEXT NOT NULL, error TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS analysis_runs (
        id TEXT PRIMARY KEY, document_id TEXT NOT NULL, started_at TEXT NOT NULL,
        ended_at TEXT, status TEXT NOT NULL, payload TEXT NOT NULL
      );
      PRAGMA user_version = 1;
    `)
    this.queue = []
    this.processing = false
    this.closed = false
    this.closing = false
    this.abortController = null
    this.importTail = Promise.resolve()
    this.recoverOperations()
    this.db
      .prepare(
        "UPDATE documents SET analysis_state='error', analysis_message=? WHERE analysis_state IN ('running','queued')",
      )
      .run('上次分析被中断，可以重新发起分析')
    this.log('application_start', {
      node: process.versions.node,
      electron: process.versions.electron || null,
      root: this.root,
    })
  }

  log(event, details = {}) {
    fs.appendFileSync(
      this.logFile,
      `${JSON.stringify({ time: now(), event, ...details })}\n`,
      'utf8',
    )
  }

  changed() {
    if (!this.closed) this.emit('changed')
  }

  transaction(action) {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = action()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  assertOwned(filePath) {
    const absolute = path.resolve(filePath)
    if (!absolute.startsWith(`${this.filesRoot}${path.sep}`))
      throw new Error('文件路径超出当前文献库')
    let current = path.dirname(absolute)
    while (current.startsWith(this.filesRoot)) {
      if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink())
        throw new Error('文献库目录包含链接，请先核对存储位置')
      if (samePath(current, this.filesRoot)) break
      current = path.dirname(current)
    }
    if (fs.existsSync(absolute) && fs.lstatSync(absolute).isSymbolicLink())
      throw new Error('文献文件是链接，无法执行整理')
    return absolute
  }

  getSettings() {
    const row = this.db.prepare('SELECT value FROM settings WHERE key=?').get('preferences')
    return { ...defaultSettings, ...(row ? JSON.parse(row.value) : {}) }
  }

  saveSettings(input) {
    const settings = validateSettings({ ...this.getSettings(), ...input })
    if (
      settings.watchEnabled &&
      (!settings.watchFolder || !fs.statSync(settings.watchFolder).isDirectory())
    ) {
      throw new Error('请选择实际存在的监控文件夹')
    }
    if (settings.watchFolder) {
      const selected = fs.realpathSync(settings.watchFolder)
      if (selected.startsWith(this.root) || this.root.startsWith(`${selected}${path.sep}`)) {
        throw new Error('监控目录与文献库目录重叠，请选择下载文献的独立文件夹')
      }
    }
    this.db
      .prepare(
        'INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      )
      .run('preferences', JSON.stringify(settings))
    this.log('settings_saved', {
      provider: settings.provider,
      model: settings.model,
      watchEnabled: settings.watchEnabled,
    })
    this.changed()
    return settings
  }

  fromRow(row) {
    if (!row) throw new Error('文献记录不存在')
    return {
      id: row.id,
      hash: row.hash,
      originalName: row.original_name,
      sourcePath: row.source_path,
      filePath: row.file_path,
      fileName: path.basename(row.file_path),
      importedAt: row.imported_at,
      pageCount: row.page_count,
      textLength: row.text_length,
      emptyPages: JSON.parse(row.empty_pages),
      metadata: JSON.parse(row.metadata),
      warnings: JSON.parse(row.warnings),
      status: row.status,
      origin: row.origin,
      confirmed: Boolean(row.confirmed),
      organized: Boolean(row.organized),
      favorite: Boolean(row.favorite),
      readState: row.read_state,
      note: row.note,
      revision: row.revision,
      analysisState: row.analysis_state,
      analysisMessage: row.analysis_message,
      analyzedAt: row.analyzed_at,
    }
  }

  getDocument(id) {
    return this.fromRow(this.db.prepare('SELECT * FROM documents WHERE id=?').get(id))
  }

  listDocuments({ search = '', filter = 'all', topic = '' } = {}) {
    let documents = this.db
      .prepare('SELECT * FROM documents ORDER BY imported_at DESC')
      .all()
      .map((row) => this.fromRow(row))
    if (filter === 'pending') documents = documents.filter((document) => !document.organized)
    if (filter === 'organized') documents = documents.filter((document) => document.organized)
    if (filter === 'favorites') documents = documents.filter((document) => document.favorite)
    if (topic)
      documents = documents.filter((document) =>
        [
          ...document.metadata.tagsZh,
          ...document.metadata.tagsEn,
          ...document.metadata.diseasesZh,
        ].includes(topic),
      )
    const terms = search.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
    if (terms.length) {
      documents = documents.filter((document) => {
        const haystack =
          `${JSON.stringify(document.metadata)} ${document.originalName} ${document.note}`.toLocaleLowerCase()
        return terms.every((term) => haystack.includes(term))
      })
    }
    return documents
  }

  snapshot() {
    const documents = this.listDocuments()
    const topics = new Map()
    for (const document of documents) {
      for (const topic of new Set([...document.metadata.tagsZh, ...document.metadata.diseasesZh])) {
        topics.set(topic, (topics.get(topic) || 0) + 1)
      }
    }
    return {
      documents,
      settings: this.getSettings(),
      templates,
      root: this.root,
      logFile: this.logFile,
      topics: [...topics]
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count),
      counts: {
        all: documents.length,
        pending: documents.filter((document) => !document.organized).length,
        organized: documents.filter((document) => document.organized).length,
        favorites: documents.filter((document) => document.favorite).length,
      },
      queue: { running: this.processing, pending: this.queue.length },
    }
  }

  readDocument({ id, startPage = 1, pageCount = 8 }) {
    const document = this.getDocument(id)
    if (
      !Number.isInteger(startPage) ||
      startPage < 1 ||
      !Number.isInteger(pageCount) ||
      pageCount < 1 ||
      pageCount > 20
    ) {
      throw new Error('每次可读取 1–20 页，请填写有效页码')
    }
    const pages = this.db
      .prepare(
        'SELECT number,text FROM pages WHERE document_id=? AND number>=? ORDER BY number LIMIT ?',
      )
      .all(id, startPage, pageCount)
    return {
      document,
      pages,
      totalPages: document.pageCount,
      nextPage: startPage + pages.length <= document.pageCount ? startPage + pages.length : null,
    }
  }

  allPages(id) {
    this.getDocument(id)
    return this.db
      .prepare('SELECT number,text FROM pages WHERE document_id=? ORDER BY number')
      .all(id)
  }

  importFiles(filePaths) {
    if (this.closed || this.closing)
      return Promise.reject(new Error('应用正在退出，请稍后重新导入'))
    const operation = this.importTail.then(() => this.performImport(filePaths))
    this.importTail = operation.catch(() => {})
    return operation
  }

  async performImport(filePaths) {
    if (!Array.isArray(filePaths) || !filePaths.length) throw new Error('请选择 PDF 文件')
    const result = { imported: [], duplicates: [], failed: [] }
    for (const source of [...new Set(filePaths)]) {
      let temporary
      try {
        const sourcePath = path.resolve(source)
        if (path.extname(sourcePath).toLowerCase() !== '.pdf') throw new Error('当前支持 PDF 文献')
        const before = await fsp.stat(sourcePath)
        if (!before.isFile() || !before.size) throw new Error('输入文件为空或无法读取')
        temporary = path.join(this.filesRoot, '待整理', `.import-${crypto.randomUUID()}.pdf`)
        await fsp.copyFile(sourcePath, temporary, fs.constants.COPYFILE_EXCL)
        const after = await fsp.stat(sourcePath)
        if (before.size !== after.size || before.mtimeMs !== after.mtimeMs)
          throw new Error('文件仍在写入，请等待下载完成后重试')
        const hash = digest(temporary)
        const existing = this.db
          .prepare('SELECT id,file_path FROM documents WHERE hash=?')
          .get(hash)
        if (existing) {
          this.assertOwned(existing.file_path)
          const missingCopy = !fs.existsSync(existing.file_path)
          if (missingCopy) {
            fs.mkdirSync(path.dirname(existing.file_path), { recursive: true })
            fs.linkSync(temporary, existing.file_path)
            this.log('document_copy_restored', { id: existing.id, hash })
          } else if (digest(existing.file_path) !== hash) {
            throw new Error('文献库内的同一文献副本内容已变化，请核对文件')
          }
          result.duplicates.push({ path: sourcePath, id: existing.id, restored: missingCopy })
          continue
        }
        const extracted = await extractPdf(temporary)
        if (this.closed) throw new Error('应用正在退出，请重新导入')
        const id = crypto.randomUUID()
        const destination = path.join(this.filesRoot, '待整理', `${hash}.pdf`)
        // 独占创建目标，避免覆盖重名文件。输入仅复制到文献库。
        const createdTarget = !fs.existsSync(destination)
        if (createdTarget) fs.linkSync(temporary, destination)
        else {
          this.assertOwned(destination)
          if (digest(destination) !== hash)
            throw new Error('导入目标已存在且内容不同，请核对文献库')
        }
        try {
          this.transaction(() => {
            this.db
              .prepare(
                `INSERT INTO documents(id,hash,original_name,source_path,file_path,imported_at,page_count,text_length,empty_pages,metadata,status,warnings)
              VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
              )
              .run(
                id,
                hash,
                path.basename(sourcePath),
                sourcePath,
                destination,
                now(),
                extracted.pages.length,
                extracted.textLength,
                JSON.stringify(extracted.emptyPages),
                JSON.stringify(emptyMetadata(extracted.title || path.parse(sourcePath).name)),
                extracted.needsOcr ? 'needs_ocr' : 'pending',
                JSON.stringify(
                  extracted.emptyPages.length
                    ? [`${extracted.emptyPages.length} 页文字较少，可能需要 OCR`]
                    : [],
                ),
              )
            const insertPage = this.db.prepare(
              'INSERT INTO pages(document_id,number,text) VALUES(?,?,?)',
            )
            for (const page of extracted.pages) insertPage.run(id, page.number, page.text)
          })
        } catch (error) {
          if (createdTarget) fs.unlinkSync(destination)
          throw error
        }
        result.imported.push(this.getDocument(id))
        this.log('document_imported', {
          id,
          sourcePath,
          hash,
          pageCount: extracted.pages.length,
          textLength: extracted.textLength,
        })
        this.changed()
      } catch (error) {
        result.failed.push({ path: String(source), error: error.message })
        this.log('import_failed', { source: String(source), error: error.message })
      } finally {
        if (temporary && fs.existsSync(temporary)) fs.unlinkSync(temporary)
      }
    }
    const settings = this.getSettings()
    if (!this.closing && settings.autoAnalyze && settings.provider === 'ollama') {
      const ids = result.imported
        .filter((document) => document.status !== 'needs_ocr')
        .map((document) => document.id)
      if (ids.length) this.queueAnalysis(ids)
    }
    return result
  }

  saveMetadata({
    id,
    metadata,
    expectedRevision,
    origin = 'manual',
    confirmed = false,
    extraWarnings = [],
  }) {
    const document = this.getDocument(id)
    if (expectedRevision !== undefined && expectedRevision !== document.revision)
      throw new Error('文献信息已更新，请刷新后重新保存')
    if (!['manual', 'agent', 'ollama'].includes(origin)) throw new Error('字段来源无法识别')
    const checked = validateMetadata(metadata, this.allPages(id))
    const warnings = [...new Set([...checked.warnings, ...extraWarnings])]
    if (document.emptyPages.length)
      warnings.push(`${document.emptyPages.length} 页文字较少，可能需要 OCR`)
    this.db
      .prepare(
        `UPDATE documents SET metadata=?,warnings=?,origin=?,confirmed=?,status=?,revision=revision+1,analyzed_at=? WHERE id=?`,
      )
      .run(
        JSON.stringify(checked.metadata),
        JSON.stringify(warnings),
        origin,
        Number(confirmed && origin === 'manual'),
        document.status === 'needs_ocr' ? 'needs_ocr' : 'ready',
        now(),
        id,
      )
    this.log('metadata_saved', {
      id,
      origin,
      confirmed: confirmed && origin === 'manual',
      warnings,
    })
    this.changed()
    return this.getDocument(id)
  }

  updateDocument({ id, favorite, readState, note }) {
    const document = this.getDocument(id)
    if (favorite !== undefined && typeof favorite !== 'boolean') throw new Error('收藏状态格式错误')
    if (readState !== undefined && !['read', 'unread'].includes(readState))
      throw new Error('阅读状态格式错误')
    if (note !== undefined && (typeof note !== 'string' || note.length > 20000))
      throw new Error('笔记长度应在 20000 字符以内')
    this.db
      .prepare('UPDATE documents SET favorite=?,read_state=?,note=? WHERE id=?')
      .run(
        Number(favorite ?? document.favorite),
        readState ?? document.readState,
        note ?? document.note,
        id,
      )
    this.changed()
    return this.getDocument(id)
  }

  previewOrganization({ ids, settings = {} }) {
    if (!Array.isArray(ids) || !ids.length) throw new Error('请先选择要整理的文献')
    const rules = validateSettings({ ...this.getSettings(), ...settings })
    const reserved = new Set()
    const items = [...new Set(ids)].map((id) => {
      const document = this.getDocument(id)
      const naming = buildName(document, rules)
      const folder = path.join(this.filesRoot, '已整理', naming.folder)
      let destination = path.join(folder, naming.fileName)
      let index = 2
      while (
        reserved.has(destination.toLowerCase()) ||
        (fs.existsSync(destination) && !samePath(destination, document.filePath))
      ) {
        destination = path.join(folder, `${path.parse(naming.fileName).name}_${index}.pdf`)
        index += 1
      }
      this.assertOwned(destination)
      reserved.add(destination.toLowerCase())
      const warnings = []
      if (!document.confirmed) warnings.push('AI 字段或原始题名待人工核对')
      if (naming.missing.length)
        warnings.push(`缺少字段 ${naming.missing.join('、')}，已使用可用字段生成名称`)
      if (document.status === 'needs_ocr') warnings.push('扫描件等待 OCR，当前名称来自已有信息')
      return {
        id,
        hash: document.hash,
        revision: document.revision,
        from: document.filePath,
        to: destination,
        originalName: document.originalName,
        title: document.metadata.title,
        fileName: path.basename(destination),
        folder: naming.folder,
        wasOrganized: document.organized,
        warnings,
      }
    })
    const plan = { id: crypto.randomUUID(), createdAt: now(), settings: rules, items }
    this.db
      .prepare('INSERT INTO plans VALUES(?,?,?,?)')
      .run(plan.id, plan.createdAt, 'preview', JSON.stringify(plan))
    return plan
  }

  moveDocument(item, batchId, organized) {
    const document = this.getDocument(item.id)
    if (document.revision !== item.revision || !samePath(document.filePath, item.from))
      throw new Error('文献在预览后已发生变化，请重新预览')
    const source = this.assertOwned(item.from)
    const target = this.assertOwned(item.to)
    if (!fs.existsSync(source) || digest(source) !== document.hash)
      throw new Error('文献副本缺失或内容发生变化，请核对文件')
    if (samePath(source, target)) return { ...item, status: 'skipped', revision: document.revision }
    fs.mkdirSync(path.dirname(target), { recursive: true })
    const payload = { ...item, organized, nextRevision: document.revision + 1 }
    const operationId = crypto.randomUUID()
    this.db
      .prepare('INSERT INTO operations VALUES(?,?,?,?,?,?,?)')
      .run(operationId, batchId, item.id, now(), 'pending', JSON.stringify(payload), '')
    try {
      // 硬链接独占创建目标；成功后移除旧路径，两处位于同一文献库存储卷。
      fs.linkSync(source, target)
      try {
        fs.unlinkSync(source)
      } catch (error) {
        fs.unlinkSync(target)
        throw error
      }
      this.transaction(() => {
        this.db
          .prepare('UPDATE documents SET file_path=?,organized=?,revision=? WHERE id=?')
          .run(target, Number(organized), payload.nextRevision, item.id)
        this.db.prepare("UPDATE operations SET status='done' WHERE id=?").run(operationId)
      })
      this.log('document_moved', { operationId, batchId, id: item.id, from: source, to: target })
      return { ...item, status: 'done', revision: payload.nextRevision }
    } catch (error) {
      // 文件已移动而数据库更新失败时保留 pending，供重启时按内容指纹恢复。
      if (fs.existsSync(source))
        this.db
          .prepare("UPDATE operations SET status='failed',error=? WHERE id=?")
          .run(error.message, operationId)
      this.log('move_failed', { operationId, error: error.message })
      throw error
    }
  }

  applyOrganization({ planId }) {
    const row = this.db.prepare('SELECT * FROM plans WHERE id=?').get(planId)
    if (!row) throw new Error('整理预览不存在')
    if (row.status !== 'preview') throw new Error('这个整理方案已执行，请重新生成预览')
    const plan = JSON.parse(row.payload)
    this.db.prepare("UPDATE plans SET status='running' WHERE id=?").run(planId)
    const results = plan.items.map((item) => {
      try {
        return this.moveDocument(item, planId, true)
      } catch (error) {
        return { ...item, status: 'failed', error: error.message }
      }
    })
    plan.results = results
    const status = results.every((item) => item.status !== 'failed') ? 'applied' : 'partial'
    this.db
      .prepare('UPDATE plans SET status=?,payload=? WHERE id=?')
      .run(status, JSON.stringify(plan), planId)
    this.changed()
    return { planId, status, results }
  }

  undoOrganization({ planId }) {
    const row = this.db.prepare('SELECT * FROM plans WHERE id=?').get(planId)
    if (!row || !['applied', 'partial', 'undo_partial'].includes(row.status))
      throw new Error('该记录当前无法撤销')
    const plan = JSON.parse(row.payload)
    const results = []
    for (const item of [...(plan.results || [])].reverse()) {
      if (item.status !== 'done' || item.undone) continue
      try {
        const current = this.getDocument(item.id)
        const undo = this.moveDocument(
          { ...item, revision: current.revision, from: item.to, to: item.from },
          `${planId}-undo`,
          item.wasOrganized,
        )
        item.undone = true
        results.push(undo)
      } catch (error) {
        results.push({ ...item, status: 'failed', error: error.message })
      }
    }
    const status = results.some((item) => item.status === 'failed') ? 'undo_partial' : 'undone'
    this.db
      .prepare('UPDATE plans SET status=?,payload=? WHERE id=?')
      .run(status, JSON.stringify(plan), planId)
    this.changed()
    return { planId, status, results }
  }

  history() {
    return this.db
      .prepare("SELECT * FROM plans WHERE status<>'preview' ORDER BY created_at DESC LIMIT 100")
      .all()
      .map((row) => ({
        id: row.id,
        createdAt: row.created_at,
        status: row.status,
        ...JSON.parse(row.payload),
      }))
  }

  recoverOperations() {
    for (const operation of this.db
      .prepare("SELECT * FROM operations WHERE status='pending' ORDER BY created_at")
      .all()) {
      const item = JSON.parse(operation.payload)
      try {
        const source = this.assertOwned(item.from)
        const target = this.assertOwned(item.to)
        if (fs.existsSync(target) && digest(target) === item.hash) {
          if (fs.existsSync(source)) {
            if (digest(source) !== item.hash) throw new Error('恢复时发现源文件内容变化')
            fs.unlinkSync(source)
          }
          this.transaction(() => {
            this.db
              .prepare('UPDATE documents SET file_path=?,organized=?,revision=? WHERE id=?')
              .run(target, Number(item.organized), item.nextRevision, item.id)
            this.db
              .prepare("UPDATE operations SET status='done',error='重启后已恢复' WHERE id=?")
              .run(operation.id)
          })
        } else {
          if (!fs.existsSync(source)) throw new Error('恢复时源文件及有效目标文件均缺失')
          this.db
            .prepare(
              "UPDATE operations SET status='failed',error='上次整理中断，源文件已保留' WHERE id=?",
            )
            .run(operation.id)
        }
      } catch (error) {
        this.db
          .prepare("UPDATE operations SET status='failed',error=? WHERE id=?")
          .run(error.message, operation.id)
        this.log('recovery_failed', { id: operation.document_id, error: error.message })
      }
    }
    for (const row of this.db.prepare("SELECT * FROM plans WHERE status='running'").all()) {
      const plan = JSON.parse(row.payload)
      const operations = this.db.prepare('SELECT * FROM operations WHERE batch_id=?').all(row.id)
      plan.results = plan.items.map((item) => {
        const operation = operations.find((entry) => entry.document_id === item.id)
        const done = operation?.status === 'done'
        return {
          ...item,
          status: done ? 'done' : 'failed',
          revision: done ? JSON.parse(operation.payload).nextRevision : item.revision,
          error: done ? undefined : '上次整理中断，可重新预览',
        }
      })
      this.db
        .prepare("UPDATE plans SET status='partial',payload=? WHERE id=?")
        .run(JSON.stringify(plan), row.id)
    }
    // 撤销过程中退出时，同步恢复批次记录，避免界面与文件路径不一致。
    for (const row of this.db
      .prepare("SELECT * FROM plans WHERE status IN ('applied','partial','undo_partial')")
      .all()) {
      const completed = this.db
        .prepare("SELECT * FROM operations WHERE batch_id=? AND status='done'")
        .all(`${row.id}-undo`)
      if (!completed.length) continue
      const plan = JSON.parse(row.payload)
      for (const item of plan.results || []) {
        if (completed.some((operation) => operation.document_id === item.id)) item.undone = true
      }
      const allUndone = (plan.results || []).every((item) => item.status !== 'done' || item.undone)
      this.db
        .prepare('UPDATE plans SET status=?,payload=? WHERE id=?')
        .run(allUndone ? 'undone' : 'undo_partial', JSON.stringify(plan), row.id)
    }
  }

  queueAnalysis(ids) {
    const settings = this.getSettings()
    if (settings.provider !== 'ollama')
      throw new Error('当前使用外部 Agent，请在 AI 连接中复制 MCP 配置并从 Agent 发起分析')
    if (!settings.model) throw new Error('请先连接本地模型并选择模型名称')
    for (const id of [...new Set(ids)]) {
      const document = this.getDocument(id)
      if (document.status === 'needs_ocr')
        throw new Error(`${document.originalName} 需要先进行 OCR`)
      if (['queued', 'running'].includes(document.analysisState)) continue
      this.queue.push({ id, settings: { ...settings } })
      this.db
        .prepare(
          "UPDATE documents SET analysis_state='queued',analysis_message='等待分析' WHERE id=?",
        )
        .run(id)
    }
    this.changed()
    void this.processQueue()
    return { queued: this.queue.length, running: this.processing }
  }

  async processQueue() {
    if (this.processing || this.closed) return
    this.processing = true
    try {
      while (this.queue.length && !this.closed) {
        const { id, settings } = this.queue.shift()
        const document = this.getDocument(id)
        const runId = crypto.randomUUID()
        const audit = {
          provider: 'ollama',
          model: settings.model,
          seed: 42,
          temperature: 0,
          promptVersion: 'v1',
          documentHash: document.hash,
          records: [],
        }
        this.db
          .prepare('INSERT INTO analysis_runs VALUES(?,?,?,?,?,?)')
          .run(runId, id, now(), null, 'running', JSON.stringify(audit))
        this.db
          .prepare(
            "UPDATE documents SET analysis_state='running',analysis_message='正在连接本地模型' WHERE id=?",
          )
          .run(id)
        this.abortController = new AbortController()
        this.changed()
        try {
          const result = await analyzeWithOllama({
            pages: this.allPages(id),
            settings,
            signal: this.abortController.signal,
            onProgress: (message) => {
              this.db.prepare('UPDATE documents SET analysis_message=? WHERE id=?').run(message, id)
              this.changed()
            },
            onRecord: (record) => {
              audit.records.push(record)
              this.db
                .prepare('UPDATE analysis_runs SET payload=? WHERE id=?')
                .run(JSON.stringify(audit), runId)
            },
          })
          audit.readPages = result.readPages
          this.saveMetadata({
            id,
            metadata: result.metadata,
            expectedRevision: document.revision,
            origin: 'ollama',
            extraWarnings: result.warnings,
          })
          this.db
            .prepare("UPDATE documents SET analysis_state='idle',analysis_message='' WHERE id=?")
            .run(id)
          this.db
            .prepare("UPDATE analysis_runs SET ended_at=?,status='complete',payload=? WHERE id=?")
            .run(now(), JSON.stringify(audit), runId)
          this.log('analysis_complete', {
            id,
            runId,
            model: settings.model,
            readPages: result.readPages,
          })
        } catch (error) {
          audit.error = error.message
          this.db
            .prepare("UPDATE documents SET analysis_state='error',analysis_message=? WHERE id=?")
            .run(error.message, id)
          this.db
            .prepare("UPDATE analysis_runs SET ended_at=?,status='failed',payload=? WHERE id=?")
            .run(now(), JSON.stringify(audit), runId)
          this.log('analysis_failed', { id, runId, error: error.message })
        }
        this.abortController = null
        this.changed()
      }
    } finally {
      this.processing = false
      this.changed()
    }
  }

  cancelAnalysis() {
    this.queue = []
    this.db
      .prepare(
        "UPDATE documents SET analysis_state='idle',analysis_message='' WHERE analysis_state='queued'",
      )
      .run()
    this.abortController?.abort(new Error('用户已停止分析'))
    this.changed()
    return { stopped: true }
  }

  async models(input = {}) {
    try {
      return {
        connected: true,
        models: await getModels(validateSettings({ ...this.getSettings(), ...input })),
      }
    } catch (error) {
      return { connected: false, models: [], error: error.message }
    }
  }

  exportCsv() {
    const columns = [
      'id',
      'original_name',
      'file_path',
      'title',
      'year',
      'doi',
      'authors',
      'drugs_zh',
      'drugs_en',
      'microbes',
      'diseases_zh',
      'diseases_en',
      'study_type',
      'finding',
      'tags',
      'origin',
      'confirmed',
      'warnings',
      'sha256',
    ]
    const escape = (value) => {
      let content = String(value ?? '')
      if (/^[=+@-]/.test(content)) content = `'${content}`
      return `"${content.replace(/"/g, '""')}"`
    }
    const rows = this.listDocuments().map((document) => {
      const metadata = document.metadata
      return [
        document.id,
        document.originalName,
        document.filePath,
        metadata.title,
        metadata.year,
        metadata.doi,
        metadata.authors.join(' | '),
        metadata.drugsZh.join(' | '),
        metadata.drugsEn.join(' | '),
        metadata.microbes.join(' | '),
        metadata.diseasesZh.join(' | '),
        metadata.diseasesEn.join(' | '),
        metadata.studyTypeZh,
        metadata.findingZh,
        metadata.tagsZh.join(' | '),
        document.origin,
        document.confirmed,
        document.warnings.join(' | '),
        document.hash,
      ]
    })
    return `\uFEFF${[columns, ...rows].map((row) => row.map(escape).join(',')).join('\r\n')}\r\n`
  }

  async close() {
    this.closing = true
    await this.importTail
    this.cancelAnalysis()
    this.closed = true
    while (this.processing) await new Promise((resolve) => setTimeout(resolve, 40))
    this.log('application_end')
    this.db.close()
  }
}
