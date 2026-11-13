import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { mcpClient } from './mcp-client.mjs'
import { Library } from '../core/library.mjs'
import { startBridge } from '../core/bridge.mjs'
import { writeFixture, fixtureMetadata } from './fixtures.mjs'

test('MCP 标准协议完成工具发现、逐页读取、字段保存、整理和撤销', async (t) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'paperloom-mcp-'))
  const library = new Library(path.join(temporary, 'library'))
  const runtimePath = path.join(temporary, 'runtime.json')
  const bridge = await startBridge(library, runtimePath)
  const source = path.join(temporary, 'synthetic.pdf')
  await writeFixture(source)
  const {
    imported: [document],
  } = await library.importFiles([source])
  const client = mcpClient(process.execPath, [
    path.resolve('desktop/mcp-entry.mjs'),
    '--runtime',
    runtimePath,
  ])
  t.after(async () => {
    client.close()
    await bridge.close()
    await library.close()
    assert.ok(
      path.resolve(temporary).startsWith(`${path.resolve(os.tmpdir())}${path.sep}paperloom-mcp-`),
    )
    await fs.rm(temporary, { recursive: true, force: true })
  })
  const initialized = await client.request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'paperloom-regression', version: '1.0.0' },
  })
  assert.equal(initialized.result.serverInfo.name, 'paperloom')
  client.notification('notifications/initialized')
  const tools = await client.request('tools/list')
  assert.equal(tools.result.tools.length, 9)
  const tool = async (name, args = {}) => {
    const response = await client.request('tools/call', { name, arguments: args })
    assert.equal(response.result.isError, undefined, JSON.stringify(response))
    return JSON.parse(response.result.content[0].text)
  }
  const listed = await tool('list_documents')
  assert.equal(listed.total, 1)
  const read = await tool('read_document', { id: document.id, startPage: 1, pageCount: 1 })
  assert.equal(read.nextPage, 2)
  assert.ok(read.pages[0].text.includes('Compound Alpha'))
  const saved = await tool('save_metadata', {
    id: document.id,
    expectedRevision: document.revision,
    metadata: fixtureMetadata(),
  })
  assert.equal(saved.origin, 'agent')
  assert.equal(saved.metadata.evidence[0].matched, true)
  const preview = await tool('preview_organization', {
    ids: [document.id],
    settings: { language: 'zh' },
  })
  assert.ok(preview.items[0].fileName.includes('占位药物甲'))
  assert.equal((await tool('apply_organization', { planId: preview.id })).status, 'applied')
  assert.equal((await tool('undo_organization', { planId: preview.id })).status, 'undone')
  const unauthorized = await fetch(`http://127.0.0.1:${bridge.runtime.port}/rpc`, {
    method: 'POST',
    body: '{}',
  })
  assert.equal(unauthorized.status, 401)
})
