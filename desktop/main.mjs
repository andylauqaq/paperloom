/** 纸序桌面入口。2026-11-13，0.2.1。负责真实文件夹浏览、目录监控及兼容的 Agent 桥接。 */
import {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  shell,
  protocol,
  net,
  session,
  clipboard,
} from 'electron'
import path from 'node:path'
import fs from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'

const applicationRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
app.setName('Paperloom')
if (process.env.PAPERLOOM_DATA_DIR) app.setPath('userData', process.env.PAPERLOOM_DATA_DIR)

protocol.registerSchemesAsPrivileged([
  { scheme: 'paperloom', privileges: { standard: true, secure: true, supportFetchAPI: true } },
])
if (!app.requestSingleInstanceLock()) app.quit()
else {
  let window
  let library
  let bridge
  let watcher
  let folderWorkspace
  let folderWatcher
  let folderChangeTimer
  let quitting = false
  let lastAgentCall = null
  const runtimePath = path.join(app.getPath('userData'), 'runtime.json')
  function mcpConfig() {
    const entry = app.isPackaged
      ? path.join(process.resourcesPath, 'mcp', 'paperloom-mcp.mjs')
      : path.join(applicationRoot, 'dist-mcp', 'paperloom-mcp.mjs')
    return {
      mcpServers: {
        paperloom: {
          command: process.execPath,
          args: [entry, '--runtime', runtimePath],
          env: { ELECTRON_RUN_AS_NODE: '1' },
        },
      },
    }
  }
  const notify = () => {
    if (window && !window.isDestroyed()) window.webContents.send('paperloom:changed')
  }
  async function updateFolderWatcher() {
    clearTimeout(folderChangeTimer)
    await folderWatcher?.close()
    const { watch } = await import('chokidar')
    folderWatcher = watch(Object.values(folderWorkspace.roots), {
      ignoreInitial: true,
      followSymlinks: false,
      awaitWriteFinish: { stabilityThreshold: 700, pollInterval: 200 },
    })
    folderWatcher.on('all', () => {
      clearTimeout(folderChangeTimer)
      folderChangeTimer = setTimeout(notify, 200)
    })
    folderWatcher.on('error', (error) => {
      folderWorkspace.watchError = `目录监控需要刷新，${error.message}`
      library.log('folder_watch_error', { error: error.message })
      notify()
    })
    await new Promise((resolve) => {
      folderWatcher.once('ready', resolve)
      folderWatcher.once('error', resolve)
    })
  }
  async function updateWatcher() {
    await watcher?.close()
    watcher = null
    const settings = library.getSettings()
    if (!settings.watchEnabled || !settings.watchFolder) return
    const { watch } = await import('chokidar')
    watcher = watch(settings.watchFolder, {
      persistent: true,
      ignoreInitial: false,
      followSymlinks: false,
      awaitWriteFinish: { stabilityThreshold: 2500, pollInterval: 500 },
    })
    watcher.on('add', (filePath) => {
      if (path.extname(filePath).toLowerCase() !== '.pdf') return
      void library
        .importFiles([filePath])
        .catch((error) => library.log('watch_import_failed', { error: error.message }))
    })
    watcher.on('error', (error) => {
      library.log('watch_error', { error: error.message })
      notify()
    })
  }
  app.on('second-instance', () => {
    window?.show()
    window?.focus()
  })
  app
    .whenReady()
    .then(async () => {
      const { Library } = await import('../core/library.mjs')
      const { startBridge } = await import('../core/bridge.mjs')
      const { findPdfs } = await import('../core/files.mjs')
      const { FolderWorkspace, findWorkspaceRoot } = await import('../core/folders.mjs')
      library = new Library(path.join(app.getPath('userData'), 'library'))
      folderWorkspace = new FolderWorkspace(path.join(app.getPath('userData'), 'folders.json'))
      const defaultRoot = await findWorkspaceRoot(
        [path.dirname(process.execPath), applicationRoot, process.cwd()],
        path.join(app.getPath('documents'), 'Paperloom'),
      )
      await folderWorkspace.initialize(defaultRoot, process.env.PAPERLOOM_FOLDER_ROOT)
      bridge = await startBridge(library, runtimePath)
      library.on('changed', notify)
      library.on('agent-call', (event) => {
        lastAgentCall = event
        notify()
      })
      const distributionRoot = path.join(applicationRoot, 'dist')
      protocol.handle('paperloom', (request) => {
        const url = new URL(request.url)
        const relative = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)
        const location = path.resolve(distributionRoot, `.${relative}`)
        if (url.host !== 'app' || !location.startsWith(`${distributionRoot}${path.sep}`))
          return new Response('Not found', { status: 404 })
        return net.fetch(pathToFileURL(location).href)
      })
      session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) =>
        callback(false),
      )
      const methods = {
        foldersSnapshot: () => folderWorkspace.snapshot(),
        chooseWorkspace: async () => {
          const selection = await dialog.showOpenDialog(window, {
            title: '选择工作文件夹，其中保存 literature 和待整理',
            defaultPath: folderWorkspace.root,
            properties: ['openDirectory', 'createDirectory'],
          })
          if (selection.canceled) return null
          await folderWorkspace.setRoot(selection.filePaths[0])
          await updateFolderWatcher()
          library.log('folder_workspace_selected', { root: folderWorkspace.root })
          notify()
          return folderWorkspace.snapshot()
        },
        openFolderItem: async (args) => {
          const location = await folderWorkspace.resolveItem(args)
          const error = await shell.openPath(location)
          if (error) throw new Error(error)
          return true
        },
        revealFolderItem: async (args) => {
          shell.showItemInFolder(await folderWorkspace.resolveItem({ ...args, kind: 'file' }))
          return true
        },
        copyFolderInstruction: async () => {
          clipboard.writeText(
            `请整理“${folderWorkspace.roots.inbox}”中的新文献。逐篇读取内容，按本次指令的语言和规则命名并归档到“${folderWorkspace.roots.library}”的合适主题目录。按完整文件内容去重，记录来源和命名依据，题名、年份或研究关系无法确认时保留待核对标记。`,
          )
          return true
        },
        snapshot: () => ({
          ...library.snapshot(),
          mcpConfig: mcpConfig(),
          lastAgentCall,
          version: app.getVersion(),
        }),
        importFiles: async ({ paths } = {}) => {
          let files = paths
          if (!files) {
            const selection = await dialog.showOpenDialog(window, {
              title: '导入 PDF 文献',
              properties: ['openFile', 'multiSelections'],
              filters: [{ name: 'PDF 文献', extensions: ['pdf'] }],
            })
            if (selection.canceled) return null
            files = selection.filePaths
          }
          return library.importFiles(files)
        },
        importFolder: async () => {
          const selected = await dialog.showOpenDialog(window, {
            title: '选择文献文件夹',
            properties: ['openDirectory'],
          })
          if (selected.canceled) return null
          const files = await findPdfs(selected.filePaths[0])
          if (!files.length) throw new Error('所选文件夹中没有 PDF 文献')
          return library.importFiles(files)
        },
        chooseWatchFolder: async () => {
          const selected = await dialog.showOpenDialog(window, {
            title: '选择下载文献的文件夹',
            properties: ['openDirectory'],
          })
          return selected.canceled ? null : selected.filePaths[0]
        },
        saveSettings: async (args) => {
          const previous = library.getSettings()
          const result = library.saveSettings(args)
          if (
            previous.watchEnabled !== result.watchEnabled ||
            previous.watchFolder !== result.watchFolder
          )
            await updateWatcher()
          return result
        },
        saveMetadata: (args) => library.saveMetadata({ ...args, origin: 'manual' }),
        updateDocument: (args) => library.updateDocument(args),
        readDocument: (args) => library.readDocument(args),
        previewOrganization: (args) => library.previewOrganization(args),
        applyOrganization: (args) => library.applyOrganization(args),
        undoOrganization: (args) => library.undoOrganization(args),
        history: () => library.history(),
        analyze: ({ ids }) => library.queueAnalysis(ids),
        cancelAnalysis: () => library.cancelAnalysis(),
        models: (args) => library.models(args),
        openDocument: async ({ id }) => {
          const document = library.getDocument(id)
          const error = await shell.openPath(library.assertOwned(document.filePath))
          if (error) throw new Error(error)
          return true
        },
        revealDocument: ({ id }) => {
          shell.showItemInFolder(library.getDocument(id).filePath)
          return true
        },
        openLibrary: async () => {
          const error = await shell.openPath(library.filesRoot)
          if (error) throw new Error(error)
          return true
        },
        copyMcpConfig: ({ format = 'json' } = {}) => {
          const configuration = mcpConfig()
          const server = configuration.mcpServers.paperloom
          const content =
            format === 'toml'
              ? `[mcp_servers.paperloom]\ncommand = ${JSON.stringify(server.command)}\nargs = ${JSON.stringify(server.args)}\n\n[mcp_servers.paperloom.env]\nELECTRON_RUN_AS_NODE = "1"`
              : JSON.stringify(configuration, null, 2)
          clipboard.writeText(content)
          return true
        },
        copyAgentPrompt: () => {
          clipboard.writeText(
            '请使用 Paperloom 工具整理待处理文献。先 list_documents，再逐页 read_document 读取全文，区分本研究结果和背景引用。保存中英文药物、菌种、疾病、研究类型、主要发现及真实页码和原文引文。保留阴性结果及未知字段。按当前命名模板生成 preview_organization，展示命名与归档方案。',
          )
          return true
        },
        exportLibrary: async () => {
          const selected = await dialog.showSaveDialog(window, {
            title: '导出文献索引',
            defaultPath: 'paperloom_library.csv',
            filters: [{ name: 'CSV 表格', extensions: ['csv'] }],
          })
          if (selected.canceled) return null
          await fs.writeFile(selected.filePath, library.exportCsv(), 'utf8')
          return selected.filePath
        },
      }
      ipcMain.handle('paperloom:call', async (event, method, args) => {
        if (
          event.sender !== window?.webContents ||
          !event.senderFrame?.url.startsWith('paperloom://app/')
        )
          throw new Error('窗口来源无效')
        if (!Object.hasOwn(methods, method)) throw new Error('操作不存在')
        try {
          return { ok: true, value: await methods[method](args || {}) }
        } catch (error) {
          library.log('ui_operation_failed', { method, error: error.message })
          return { ok: false, error: error.message }
        }
      })
      window = new BrowserWindow({
        width: 1340,
        height: 900,
        minWidth: 1000,
        minHeight: 680,
        title: '纸序 · Paperloom',
        backgroundColor: '#f3f6fc',
        autoHideMenuBar: true,
        show: true,
        webPreferences: {
          preload: path.join(applicationRoot, 'desktop', 'preload.cjs'),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      })
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      window.webContents.on('will-navigate', (event) => event.preventDefault())
      await updateFolderWatcher()
      await window.loadURL('paperloom://app/index.html')
    })
    .catch((error) => {
      console.error(error.stack)
      if (process.env.PAPERLOOM_TEST === '1') app.exit(1)
      else {
        dialog.showErrorBox('Paperloom 启动失败', error.message)
        app.quit()
      }
    })
  app.on('window-all-closed', () => app.quit())
  app.on('before-quit', (event) => {
    if (quitting || !library) return
    event.preventDefault()
    quitting = true
    void (async () => {
      clearTimeout(folderChangeTimer)
      await folderWatcher?.close()
      await watcher?.close()
      await bridge?.close()
      await library.close()
      app.quit()
    })()
  })
}
