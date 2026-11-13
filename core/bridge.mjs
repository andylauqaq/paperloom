/** 本地 Agent 桥接。桌面进程统一持有数据库，外部 MCP 通过认证的回环连接调用。 */
import http from 'node:http'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import { findPdfs } from './files.mjs'

export async function startBridge(library, runtimePath) {
  const token = crypto.randomBytes(32).toString('hex')
  const methods = {
    status: () => {
      const snapshot = library.snapshot()
      return {
        counts: snapshot.counts,
        templates: snapshot.templates,
        projectFocus: snapshot.settings.projectFocus,
        libraryRoot: library.root,
      }
    },
    list_documents: ({ search = '', filter = 'all', offset = 0, limit = 30 } = {}) => {
      if (
        !Number.isInteger(offset) ||
        offset < 0 ||
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 100
      )
        throw new Error('分页参数无效')
      const documents = library.listDocuments({ search, filter })
      return {
        total: documents.length,
        documents: documents.slice(offset, offset + limit).map((document) => ({
          id: document.id,
          title: document.metadata.title,
          originalName: document.originalName,
          year: document.metadata.year,
          status: document.status,
          organized: document.organized,
          revision: document.revision,
          pageCount: document.pageCount,
        })),
        nextOffset: offset + limit < documents.length ? offset + limit : null,
      }
    },
    read_document: (args) => library.readDocument(args),
    save_metadata: (args) => library.saveMetadata({ ...args, origin: 'agent', confirmed: false }),
    preview_organization: (args) => library.previewOrganization(args),
    apply_organization: (args) => library.applyOrganization(args),
    undo_organization: (args) => library.undoOrganization(args),
    organization_history: () => library.history(),
    scan_inbox: async () => {
      const folder = library.getSettings().watchFolder
      if (!folder) throw new Error('请先在软件的文件夹设置中选择下载目录')
      const files = await findPdfs(folder)
      if (!files.length)
        return { imported: [], duplicates: [], failed: [], message: '所选目录中没有 PDF 文献' }
      const result = await library.importFiles(files)
      return {
        ...result,
        imported: result.imported.map((document) => ({
          id: document.id,
          originalName: document.originalName,
          pageCount: document.pageCount,
        })),
      }
    },
  }
  const server = http.createServer(async (request, response) => {
    const reply = (status, value) => {
      response.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      })
      response.end(JSON.stringify(value))
    }
    const authorization = Buffer.from(request.headers.authorization || '')
    const expected = Buffer.from(`Bearer ${token}`)
    if (
      authorization.length !== expected.length ||
      !crypto.timingSafeEqual(authorization, expected)
    ) {
      reply(401, { error: 'Agent 连接未授权' })
      return
    }
    if (request.method !== 'POST' || request.url !== '/rpc' || request.headers.origin) {
      reply(400, { error: '请求格式不受支持' })
      return
    }
    try {
      const chunks = []
      let size = 0
      for await (const chunk of request) {
        size += chunk.length
        if (size > 2 * 1024 * 1024) throw new Error('请求内容超过 2 MB，请分批保存')
        chunks.push(chunk)
      }
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      if (!Object.hasOwn(methods, payload.method)) throw new Error('Agent 工具不存在')
      const result = await methods[payload.method](payload.args || {})
      library.emit('agent-call', { method: payload.method, time: new Date().toISOString() })
      reply(200, { result })
    } catch (error) {
      library.log('agent_request_failed', { error: error.message })
      reply(400, { error: error.message })
    }
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const runtime = { port: server.address().port, token, pid: process.pid, version: '0.2.1' }
  const temporary = `${runtimePath}.tmp`
  await fs.writeFile(temporary, JSON.stringify(runtime), { mode: 0o600 })
  await fs.rename(temporary, runtimePath)
  return {
    runtime,
    async close() {
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
      const current = await fs
        .readFile(runtimePath, 'utf8')
        .then(JSON.parse)
        .catch(() => null)
      if (current?.token === token) await fs.unlink(runtimePath)
    },
  }
}
