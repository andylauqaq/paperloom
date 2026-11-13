/** 文件夹界面的桌面入口回归，所有测试文件均为明确标识的合成 PDF。 */
import { _electron } from 'playwright'
import electron from 'electron'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { writeFixture, fixtureMetadata } from './fixtures.mjs'
import { mcpClient } from './mcp-client.mjs'

const root = path.resolve('.')
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'paperloom-desktop-'))
const workspace = path.join(temporary, 'workspace')
const output = path.join(root, 'test-results')
await fs.mkdir(output, { recursive: true })
const packaged = Boolean(process.env.PAPERLOOM_TEST_EXECUTABLE)
const version = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')).version
const prefix = `${packaged ? 'packaged-folders' : 'desktop-folders'}-${version}`
const report = {
  startedAt: new Date().toISOString(),
  status: 'RUNNING',
  checks: [],
  syntheticData: true,
  packaged,
  contrast: [],
}
let application
let client
let clipboardBefore
const pageErrors = []
const check = (name) => {
  report.checks.push({ name, status: 'PASS' })
  console.log(`PASS ${name}`)
}

// 实测渲染后的文字颜色与逐层合成背景，防止低对比度样式再次出现。
async function assertTextContrast(page, view) {
  const measurements = await page.evaluate(() => {
    const selectors = [
      '.brand strong',
      '.brand span',
      '.nav-item span',
      '.nav-item small',
      '.section-label',
      '.topic-item span',
      '.topic-item small',
      '.workspace-button span',
      '.sidebar-bottom p',
      '.breadcrumbs button:not(.icon-button)',
      'h1',
      '.page-heading p',
      '.add-button',
      '.outline',
      '.search-box input',
      '.toolbar-actions select',
      '.folder-card h2',
      '.folder-card p',
      '.folder-card p strong',
      '.file-caption strong',
      '.file-caption small',
      '.file-size',
      '.file-row time',
      '.file-table-head span:not(:empty)',
      '.pdf-icon > span',
      '.statusbar > span',
      '.inbox-guide h2',
      '.inbox-guide p',
      '.inbox-guide span',
      '.guide-copy',
    ]
    const rgba = (value) => value.match(/[\d.]+/g).map(Number)
    const luminance = (color) =>
      color
        .slice(0, 3)
        .map((value) => {
          const normalized = value / 255
          return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4
        })
        .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0)
    function background(element) {
      const ancestors = []
      for (let current = element; current; current = current.parentElement)
        ancestors.unshift(current)
      return ancestors.reduce(
        (base, current) => {
          const color = rgba(getComputedStyle(current).backgroundColor)
          const alpha = color[3] ?? 1
          return base.map((value, index) => color[index] * alpha + value * (1 - alpha))
        },
        [255, 255, 255],
      )
    }
    function measure(selector, element, pseudo) {
      const style = getComputedStyle(element, pseudo)
      const foreground = luminance(rgba(style.color))
      const backdrop = luminance(background(element))
      return {
        selector,
        ratio: (Math.max(foreground, backdrop) + 0.05) / (Math.min(foreground, backdrop) + 0.05),
        fontSize: parseFloat(style.fontSize),
        color: style.color,
      }
    }
    const results = selectors.flatMap((selector) =>
      [...document.querySelectorAll(selector)]
        .filter((element) => element.getBoundingClientRect().height > 0)
        .map((element) => measure(selector, element)),
    )
    const input = document.querySelector('.search-box input')
    if (input) results.push(measure('.search-box input::placeholder', input, '::placeholder'))
    return results
  })
  assert.ok(measurements.length > 15)
  const failures = measurements.filter((item) => item.ratio < 4.5)
  assert.deepEqual(failures, [], `${view} 存在文字对比度不足的样式`)
  const minimum = Math.min(...measurements.map((item) => item.ratio))
  report.contrast.push({
    view,
    textElements: measurements.length,
    minimumRatio: Number(minimum.toFixed(2)),
  })
}
try {
  const category = path.join(workspace, 'literature', '肠道菌群与消化系统', '结直肠癌')
  await fs.mkdir(category, { recursive: true })
  const source = path.join(category, '2026_Compound Alpha__abcdef1234.pdf')
  await writeFixture(source)
  await fs.copyFile(source, path.join(category, '2025_Compound Beta__1122334455.pdf'))
  await fs.copyFile(source, path.join(workspace, 'literature', 'Root reference.pdf'))
  const environment = {
    ...process.env,
    PAPERLOOM_DATA_DIR: path.join(temporary, 'application-data'),
    PAPERLOOM_FOLDER_ROOT: workspace,
    PAPERLOOM_TEST: '1',
  }
  delete environment.ELECTRON_RUN_AS_NODE
  application = await _electron.launch({
    executablePath: process.env.PAPERLOOM_TEST_EXECUTABLE || electron,
    args: packaged ? [] : [root],
    env: environment,
    timeout: 30000,
  })
  const page = await application.firstWindow({ timeout: 30000 })
  clipboardBefore = await application.evaluate(({ clipboard }) => clipboard.readText())
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await page.getByRole('heading', { name: '文献库', exact: true }).waitFor({ timeout: 20000 })
  await page.evaluate(() => document.fonts.ready.then(() => true))
  await page.getByRole('button', { name: '打开文件夹 肠道菌群与消化系统', exact: true }).waitFor()
  await page.getByText('Root reference', { exact: true }).waitFor()
  const initial = (await page.evaluate(() => window.paperloom.call('foldersSnapshot'))).value
  assert.deepEqual(initial.counts, { library: 3, inbox: 0 })
  assert.deepEqual(initial.warnings, [])
  await assertTextContrast(page, '文献库')
  await page.screenshot({ path: path.join(output, `${prefix}-library.png`) })
  check('从实际文件夹显示既有 PDF 与多级主题目录')

  await page.getByRole('button', { name: '打开文件夹 肠道菌群与消化系统', exact: true }).click()
  await page.getByRole('button', { name: '打开文件夹 结直肠癌', exact: true }).click()
  await page.getByRole('heading', { name: '结直肠癌', exact: true }).waitFor()
  await page.getByText('Compound Alpha', { exact: true }).waitFor()
  await page.getByText('Compound Beta', { exact: true }).waitFor()
  await assertTextContrast(page, '文献列表及已选主题')
  await page.getByRole('combobox', { name: '文件排序' }).selectOption('recent')
  await page.getByRole('button', { name: '上一级', exact: true }).click()
  await page.getByRole('heading', { name: '肠道菌群与消化系统', exact: true }).waitFor()
  check('逐层打开文件夹、上一级导航与排序')

  await page.getByRole('textbox', { name: '搜索文件名', exact: true }).fill('Compound Alpha')
  await page.getByText('找到 1 份文献', { exact: true }).waitFor()
  await page.getByText('Compound Alpha', { exact: true }).waitFor()
  await page.getByRole('textbox', { name: '搜索文件名', exact: true }).fill('不存在的检索词')
  await page.getByRole('heading', { name: '没有找到匹配的文献', exact: true }).waitFor()
  await page.getByRole('button', { name: '清空搜索', exact: true }).first().click()
  check('当前目录及子目录的文件名搜索和空结果反馈')

  await page.getByRole('button', { name: '待整理 0', exact: true }).click()
  await page.getByRole('heading', { name: '待整理', exact: true }).waitFor()
  await page.getByRole('heading', { name: '等待你的下一篇文献', exact: true }).waitFor()
  await assertTextContrast(page, '待整理')
  check('文献库、文献列表和待整理页面的文字对比度均达到 4.5')
  await page.getByRole('button', { name: '复制整理指令', exact: true }).click()
  await page.getByRole('status').getByText('整理指令已复制，粘贴到对话中即可').waitFor()
  const instruction = await application.evaluate(({ clipboard }) => clipboard.readText())
  assert.ok(instruction.includes(initial.inboxPath))
  assert.ok(instruction.includes(initial.libraryPath))
  await page.screenshot({ path: path.join(output, `${prefix}-inbox.png`) })
  check('待整理入口及包含实际目录的整理指令')

  const pending = path.join(workspace, '待整理', 'new-001.pdf')
  await fs.copyFile(source, pending)
  await page.getByRole('button', { name: '待整理 1', exact: true }).waitFor({ timeout: 15000 })
  await page.getByText('new-001', { exact: true }).waitFor()
  const renamed = path.join(workspace, '待整理', 'Renamed externally.pdf')
  await fs.rename(pending, renamed)
  await page.getByText('Renamed externally', { exact: true }).waitFor({ timeout: 15000 })
  await fs.copyFile(renamed, path.join(category, '2026_Archived externally__aabbccddee.pdf'))
  await fs.unlink(renamed)
  await page.getByRole('button', { name: '待整理 0', exact: true }).waitFor({ timeout: 15000 })
  await page.getByRole('button', { name: '文献库 4', exact: true }).click()
  await page.getByRole('textbox', { name: '搜索文件名', exact: true }).fill('Archived externally')
  await page.getByText('Archived externally', { exact: true }).waitFor()
  check('外部放入、重命名与归档后自动同步实际目录')

  await Promise.all(
    Array.from({ length: 102 }, (_, index) =>
      fs.copyFile(
        source,
        path.join(workspace, '待整理', `batch-${String(index + 1).padStart(3, '0')}.pdf`),
      ),
    ),
  )
  await page.getByRole('button', { name: '待整理 102', exact: true }).waitFor({ timeout: 15000 })
  await page.getByRole('button', { name: '待整理 102', exact: true }).click()
  await page.getByRole('button', { name: '继续显示文献 · 还有 2 份', exact: true }).waitFor()
  assert.equal(await page.locator('.file-row').count(), 100)
  await page.getByRole('button', { name: '继续显示文献 · 还有 2 份', exact: true }).click()
  assert.equal(await page.locator('.file-row').count(), 102)
  await page.getByRole('textbox', { name: '搜索文件名', exact: true }).fill('batch-102')
  await page.getByText('找到 1 份文献', { exact: true }).waitFor()
  assert.equal(await page.locator('.file-row').count(), 1)
  await page.getByRole('textbox', { name: '搜索文件名', exact: true }).fill('batch')
  assert.equal(await page.locator('.file-row').count(), 100)
  await application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(1000, 720),
  )
  await page.screenshot({ path: path.join(output, `${prefix}-compact.png`) })
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth),
    false,
  )
  check('大目录分批显示、搜索重置分页与紧凑窗口布局')

  const invalid = await page.evaluate(() =>
    window.paperloom.call('openFolderItem', {
      scope: 'library',
      relativePath: '../../outside.pdf',
      kind: 'file',
    }),
  )
  assert.equal(invalid.ok, false)
  assert.ok(invalid.error.includes('超出文献目录'))
  check('桌面文件打开入口拒绝越过已选文献目录')

  // 原有 Agent 接口仍通过桌面服务验证兼容性，使用独立的合成测试文献。
  const imported = (
    await page.evaluate(
      (filePath) => window.paperloom.call('importFiles', { paths: [filePath] }),
      source,
    )
  ).value
  const snapshot = (await page.evaluate(() => window.paperloom.call('snapshot'))).value
  const config = snapshot.mcpConfig.mcpServers.paperloom
  client = mcpClient(config.command, config.args, config.env)
  const initialized = await client.request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'paperloom-desktop-test', version: '1.0.0' },
  })
  assert.equal(initialized.result.serverInfo.name, 'paperloom')
  client.notification('notifications/initialized')
  const tools = await client.request('tools/list')
  assert.equal(tools.result.tools.length, 9)
  const saved = await client.request('tools/call', {
    name: 'save_metadata',
    arguments: { id: imported.imported[0].id, expectedRevision: 0, metadata: fixtureMetadata() },
  })
  assert.equal(saved.result.isError, undefined, JSON.stringify(saved))
  check('现有 MCP 接口的真实握手与字段回写兼容')
  assert.deepEqual(pageErrors, [])
  report.versions = await application.evaluate(({ app }) => ({
    application: app.getVersion(),
    electron: process.versions.electron,
    node: process.versions.node,
    chrome: process.versions.chrome,
  }))
  report.status = 'PASS'
} catch (error) {
  report.status = 'FAIL'
  report.error = error.stack
  if (application)
    await application
      .firstWindow()
      .then((page) => page.screenshot({ path: path.join(output, `${prefix}-failure.png`) }))
      .catch(() => {})
  throw error
} finally {
  client?.close()
  if (application && clipboardBefore !== undefined) {
    await application.evaluate(({ clipboard }, text) => clipboard.writeText(text), clipboardBefore)
  }
  await application?.close()
  report.endedAt = new Date().toISOString()
  report.pageErrors = pageErrors
  await fs.writeFile(
    path.join(output, `${prefix}-report.json`),
    JSON.stringify(report, null, 2),
    'utf8',
  )
  assert.ok(
    path.resolve(temporary).startsWith(`${path.resolve(os.tmpdir())}${path.sep}paperloom-desktop-`),
  )
  await fs.rm(temporary, { recursive: true, force: true })
}
