import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import http from 'node:http'
import { Library } from '../core/library.mjs'
import { safeSegment, validateMetadata, validateSettings, buildName } from '../core/metadata.mjs'
import { splitPages } from '../core/ai.mjs'
import { FolderWorkspace, findWorkspaceRoot } from '../core/folders.mjs'
import { writeFixture, fixtureMetadata } from './fixtures.mjs'

test('文件夹模式直接读取实际 PDF、保留空目录并限制打开范围', async (t) => {
  const temporary = await fsp.mkdtemp(path.join(os.tmpdir(), 'paperloom-folders-'))
  t.after(async () => {
    const resolved = await fsp.realpath(temporary)
    assert.equal(path.dirname(resolved), await fsp.realpath(os.tmpdir()))
    assert.ok(path.basename(resolved).startsWith('paperloom-folders-'))
    await fsp.rm(resolved, { recursive: true, force: true })
  })
  const root = path.join(temporary, 'workspace')
  const workspace = new FolderWorkspace(path.join(temporary, 'configuration', 'folders.json'))
  await workspace.initialize(root)
  const category = path.join(root, 'literature', '主题甲', '子主题')
  await fsp.mkdir(category, { recursive: true })
  await fsp.mkdir(path.join(root, 'literature', '空目录'))
  const source = path.join(category, '2026_合成测试文献.PDF')
  await writeFixture(source)
  await writeFixture(path.join(root, '待整理', 'new.pdf'))
  await fsp.writeFile(path.join(category, 'notes.txt'), '非 PDF 文件')
  const before = fs.readFileSync(source)
  const result = await workspace.snapshot()
  assert.deepEqual(result.counts, { library: 1, inbox: 1 })
  assert.deepEqual(result.warnings, [])
  assert.equal(result.folders.find((folder) => folder.name === '主题甲').count, 1)
  assert.equal(result.folders.find((folder) => folder.name === '空目录').count, 0)
  assert.deepEqual(fs.readFileSync(source), before)
  assert.equal(
    result.files.find((file) => file.scope === 'library').relativePath,
    '主题甲/子主题/2026_合成测试文献.PDF',
  )
  assert.equal(
    await workspace.resolveItem({
      scope: 'library',
      relativePath: '主题甲/子主题/2026_合成测试文献.PDF',
      kind: 'file',
    }),
    await fsp.realpath(source),
  )
  await assert.rejects(
    workspace.resolveItem({ scope: 'library', relativePath: '../待整理/new.pdf', kind: 'file' }),
    /超出文献目录/,
  )
  await assert.rejects(
    workspace.resolveItem({
      scope: 'library',
      relativePath: '主题甲/子主题/notes.txt',
      kind: 'file',
    }),
    /PDF/,
  )
  await assert.rejects(workspace.resolveItem({ scope: 'constructor' }), /文件位置无效/)
  const restored = new FolderWorkspace(workspace.configurationPath)
  await restored.initialize(path.join(temporary, 'unused'))
  assert.equal(restored.root, await fsp.realpath(root))
  assert.equal(
    await findWorkspaceRoot([category], path.join(temporary, 'fallback')),
    path.resolve(root),
  )
  // 使用目录链接验证外部目录不会进入文件清单。
  const outside = path.join(temporary, 'outside')
  await fsp.mkdir(outside)
  await writeFixture(path.join(outside, 'outside.pdf'))
  await fsp.symlink(
    outside,
    path.join(root, 'literature', 'external-link'),
    process.platform === 'win32' ? 'junction' : 'dir',
  )
  assert.equal((await workspace.snapshot()).counts.library, 1)
  await assert.rejects(
    workspace.resolveItem({
      scope: 'library',
      relativePath: 'external-link/outside.pdf',
      kind: 'file',
    }),
    /目录之外/,
  )
})

async function setup(t) {
  const temporary = await fsp.mkdtemp(path.join(os.tmpdir(), 'paperloom-test-'))
  const library = new Library(path.join(temporary, 'library'))
  t.after(async () => {
    if (!library.closed) await library.close()
    const resolved = path.resolve(temporary)
    assert.ok(resolved.startsWith(`${path.resolve(os.tmpdir())}${path.sep}paperloom-test-`))
    await fsp.rm(resolved, { recursive: true, force: true })
  })
  const source = path.join(temporary, 'downloaded.pdf')
  await writeFixture(source)
  return { temporary, library, source }
}

test('PDF 导入读取全部页码，复制原文件并按内容识别重复下载', async (t) => {
  const { library, source, temporary } = await setup(t)
  const original = fs.readFileSync(source)
  const result = await library.importFiles([source])
  assert.equal(result.imported.length, 1)
  assert.equal(result.failed.length, 0)
  const document = result.imported[0]
  assert.equal(document.pageCount, 2)
  assert.equal(document.metadata.title, 'Synthetic software test document')
  assert.ok(library.readDocument({ id: document.id }).pages[0].text.includes('Compound Alpha'))
  assert.deepEqual(fs.readFileSync(source), original)
  assert.notEqual(document.filePath, source)
  const renamed = path.join(temporary, 'different-name.pdf')
  fs.copyFileSync(source, renamed)
  const duplicate = await library.importFiles([renamed])
  assert.equal(duplicate.duplicates.length, 1)
  assert.equal(library.snapshot().counts.all, 1)
})

test('错误页面、空文件、缺失文件和扫描件分别记录', async (t) => {
  const { library, temporary } = await setup(t)
  const fake = path.join(temporary, 'error-page.pdf')
  const blank = path.join(temporary, 'empty.pdf')
  const scan = path.join(temporary, 'scan.pdf')
  fs.writeFileSync(fake, '<html>download failed</html>')
  fs.writeFileSync(blank, '')
  await writeFixture(scan, { blank: true })
  const result = await library.importFiles([fake, blank, path.join(temporary, 'missing.pdf'), scan])
  assert.equal(result.failed.length, 3)
  assert.equal(result.imported.length, 1)
  assert.equal(result.imported[0].status, 'needs_ocr')
})

test('原文依据按实际页码匹配，错误引文保留并提示核对', () => {
  const metadata = fixtureMetadata()
  metadata.evidence.push({
    field: 'finding',
    value: 'invalid',
    page: 99,
    quote: 'A sentence absent from the document.',
  })
  const result = validateMetadata(metadata, [{ number: 1, text: metadata.evidence[0].quote }])
  assert.equal(result.metadata.evidence[0].matched, true)
  assert.equal(result.metadata.evidence.at(-1).matched, false)
  assert.ok(result.warnings.length >= 1)
})

test('中文与英文模板从各自字段生成名称，菌种保留原文名', async (t) => {
  const { library, source } = await setup(t)
  const {
    imported: [document],
  } = await library.importFiles([source])
  const updated = library.saveMetadata({
    id: document.id,
    metadata: fixtureMetadata(),
    origin: 'agent',
    confirmed: true,
  })
  assert.equal(updated.confirmed, false)
  const chinese = buildName(updated, library.getSettings())
  const english = buildName(updated, { ...library.getSettings(), language: 'en' })
  assert.match(chinese.fileName, /占位药物甲_Bacterium Beta_结直肠癌/)
  assert.match(english.fileName, /Compound Alpha_Bacterium Beta_Colorectal cancer/)
  assert.equal(safeSegment('CON'), '_CON')
  assert.equal(safeSegment('a/b:c?d'), 'a b c d')
})

test('整理执行可撤销，原文件内容保持一致，重复执行已有计划被识别', async (t) => {
  const { library, source } = await setup(t)
  const {
    imported: [document],
  } = await library.importFiles([source])
  const originalHash = crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex')
  library.saveMetadata({ id: document.id, metadata: fixtureMetadata(), confirmed: true })
  const plan = library.previewOrganization({ ids: [document.id] })
  const applied = library.applyOrganization({ planId: plan.id })
  assert.equal(applied.status, 'applied')
  assert.ok(fs.existsSync(plan.items[0].to))
  assert.ok(!fs.existsSync(plan.items[0].from))
  assert.equal(library.getDocument(document.id).organized, true)
  assert.throws(() => library.applyOrganization({ planId: plan.id }), /已执行/)
  const undone = library.undoOrganization({ planId: plan.id })
  assert.equal(undone.status, 'undone')
  assert.equal(library.getDocument(document.id).filePath, document.filePath)
  assert.ok(fs.existsSync(document.filePath))
  assert.equal(
    crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex'),
    originalHash,
  )
})

test('预览后更新字段会识别过期方案；目标重名时独立生成名称', async (t) => {
  const { library, source } = await setup(t)
  const {
    imported: [document],
  } = await library.importFiles([source])
  const first = library.previewOrganization({ ids: [document.id] })
  library.saveMetadata({ id: document.id, metadata: fixtureMetadata(), confirmed: true })
  const stale = library.applyOrganization({ planId: first.id })
  assert.equal(stale.status, 'partial')
  assert.equal(stale.results[0].status, 'failed')
  const second = library.previewOrganization({ ids: [document.id] })
  const target = second.items[0].to
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, 'Existing file must be preserved')
  const third = library.previewOrganization({ ids: [document.id] })
  assert.notEqual(third.items[0].to, target)
  assert.equal(library.applyOrganization({ planId: third.id }).status, 'applied')
  assert.equal(fs.readFileSync(target, 'utf8'), 'Existing file must be preserved')
})

test('预览之后出现同名文件时，独占创建阻止覆盖', async (t) => {
  const { library, source } = await setup(t)
  const {
    imported: [document],
  } = await library.importFiles([source])
  const plan = library.previewOrganization({ ids: [document.id] })
  fs.mkdirSync(path.dirname(plan.items[0].to), { recursive: true })
  fs.writeFileSync(plan.items[0].to, 'Concurrent new file')
  const outcome = library.applyOrganization({ planId: plan.id })
  assert.equal(outcome.results[0].status, 'failed')
  assert.equal(fs.readFileSync(plan.items[0].to, 'utf8'), 'Concurrent new file')
  assert.ok(fs.existsSync(document.filePath))
})

test('意外退出后的文件移动根据持久化记录恢复', async (t) => {
  const { library, source } = await setup(t)
  const {
    imported: [document],
  } = await library.importFiles([source])
  const plan = library.previewOrganization({ ids: [document.id] })
  const item = plan.items[0]
  library.db.prepare("UPDATE plans SET status='running' WHERE id=?").run(plan.id)
  library.db
    .prepare('INSERT INTO operations VALUES(?,?,?,?,?,?,?)')
    .run(
      'interrupted-operation',
      plan.id,
      document.id,
      new Date().toISOString(),
      'pending',
      JSON.stringify({ ...item, organized: true, nextRevision: 1 }),
      '',
    )
  fs.mkdirSync(path.dirname(item.to), { recursive: true })
  fs.linkSync(item.from, item.to)
  await library.close()
  const recovered = new Library(library.root)
  try {
    assert.equal(recovered.getDocument(document.id).filePath, item.to)
    assert.ok(fs.existsSync(item.to))
    assert.ok(!fs.existsSync(item.from))
    assert.equal(recovered.history()[0].results[0].status, 'done')
    assert.equal(recovered.undoOrganization({ planId: plan.id }).status, 'undone')
  } finally {
    await recovered.close()
  }
})

test('关键词、主题和收藏筛选可复用，索引导出包含字段与审计信息', async (t) => {
  const { library, source } = await setup(t)
  const {
    imported: [document],
  } = await library.importFiles([source])
  library.saveMetadata({ id: document.id, metadata: fixtureMetadata() })
  library.updateDocument({ id: document.id, favorite: true, note: 'Important synthetic fixture' })
  assert.equal(library.listDocuments({ search: 'Bacterium Beta' }).length, 1)
  assert.equal(library.listDocuments({ filter: 'favorites' }).length, 1)
  assert.equal(library.listDocuments({ topic: '软件测试' }).length, 1)
  const csv = library.exportCsv()
  assert.ok(csv.includes('Synthetic software test document'))
  assert.ok(csv.includes('sha256'))
})

test('本地模型配置校验回环地址和自动分析依赖', () => {
  assert.throws(() => validateSettings({ ollamaUrl: 'https://example.com' }), /回环/)
  assert.throws(() => validateSettings({ ollamaUrl: 'http://localhost:11434/api' }), /回环/)
  assert.throws(() => validateSettings({ autoAnalyze: true, provider: 'agent' }), /本地模型/)
  assert.equal(validateSettings({ ollamaUrl: 'http://localhost:11434' }).provider, 'agent')
})

test('并发导入同一文献被串行处理并识别重复下载', async (t) => {
  const { library, source } = await setup(t)
  const results = await Promise.all([library.importFiles([source]), library.importFiles([source])])
  assert.equal(
    results.reduce((total, result) => total + result.imported.length, 0),
    1,
  )
  assert.equal(
    results.reduce((total, result) => total + result.duplicates.length, 0),
    1,
  )
  assert.equal(
    results.reduce((total, result) => total + result.failed.length, 0),
    0,
  )
})

test('导入中断遗留的文献副本可复用，缺失的库内副本可以由原文恢复', async (t) => {
  const { library, source } = await setup(t)
  const hash = crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex')
  const orphan = path.join(library.filesRoot, '待整理', `${hash}.pdf`)
  fs.copyFileSync(source, orphan)
  const imported = await library.importFiles([source])
  assert.equal(imported.imported.length, 1)
  assert.equal(imported.failed.length, 0)
  fs.unlinkSync(orphan)
  const restored = await library.importFiles([source])
  assert.equal(restored.duplicates[0].restored, true)
  assert.ok(fs.existsSync(orphan))
})

test('整理后修改元数据仍可按当前文件路径撤销归档', async (t) => {
  const { library, source } = await setup(t)
  const {
    imported: [document],
  } = await library.importFiles([source])
  const plan = library.previewOrganization({ ids: [document.id] })
  library.applyOrganization({ planId: plan.id })
  library.saveMetadata({ id: document.id, metadata: fixtureMetadata() })
  assert.equal(library.undoOrganization({ planId: plan.id }).status, 'undone')
  assert.equal(library.getDocument(document.id).metadata.shortTitleZh, '软件测试用合成文献')
})

test('长页分段覆盖全部输入文字并保留实际页码', () => {
  const pages = [
    { number: 7, text: 'x'.repeat(50000) },
    { number: 8, text: 'y'.repeat(20) },
  ]
  const chunks = splitPages(pages, 1000)
  assert.equal(
    chunks
      .map((chunk) => chunk.text)
      .join('')
      .match(/x/g).length,
    50000,
  )
  assert.ok(chunks.some((chunk) => chunk.pages.includes(8)))
})

test('本地模型队列经模拟服务完成字段保存，记录模型参数与实际读取页码', async (t) => {
  const { library, source } = await setup(t)
  const requests = []
  const server = http.createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    requests.push(JSON.parse(Buffer.concat(chunks).toString()))
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(
      JSON.stringify({
        model: 'synthetic-fixture-model',
        message: { content: JSON.stringify(fixtureMetadata()) },
        done: true,
        prompt_eval_count: 10,
        eval_count: 20,
      }),
    )
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const {
    imported: [document],
  } = await library.importFiles([source])
  library.saveSettings({
    provider: 'ollama',
    model: 'synthetic-fixture-model',
    ollamaUrl: `http://127.0.0.1:${server.address().port}`,
  })
  library.queueAnalysis([document.id])
  const deadline = Date.now() + 5000
  while (library.processing && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 20))
  const updated = library.getDocument(document.id)
  assert.equal(updated.analysisState, 'idle')
  assert.equal(updated.origin, 'ollama')
  assert.equal(requests[0].options.seed, 42)
  assert.equal(requests[0].options.temperature, 0)
  const run = library.db.prepare('SELECT * FROM analysis_runs WHERE document_id=?').get(document.id)
  assert.deepEqual(JSON.parse(run.payload).readPages, [1, 2])
  assert.equal(run.status, 'complete')
})
