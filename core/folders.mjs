/**
 * 真实文献文件夹浏览，2026-11-13。
 * 输入为工作目录，输出为目录树和 PDF 文件信息。浏览阶段只读取文件信息。
 * 工作目录固定包含 literature 与待整理两个目录，设置单独保存到用户配置目录。
 */
import fs from 'node:fs/promises'
import path from 'node:path'

function isInside(parent, child) {
  const relative = path.relative(parent, child)
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  )
}

export async function findWorkspaceRoot(candidates, fallback) {
  for (const candidate of candidates) {
    let directory = path.resolve(candidate)
    for (;;) {
      try {
        if ((await fs.stat(path.join(directory, 'literature'))).isDirectory()) return directory
      } catch (error) {
        if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error
      }
      const parent = path.dirname(directory)
      if (parent === directory) break
      directory = parent
    }
  }
  return path.resolve(fallback)
}

export class FolderWorkspace {
  constructor(configurationPath) {
    this.configurationPath = configurationPath
    this.root = null
    this.watchError = ''
  }

  async initialize(defaultRoot, explicitRoot) {
    let saved
    try {
      saved = JSON.parse(await fs.readFile(this.configurationPath, 'utf8'))
      if (typeof saved.root !== 'string' || !saved.root.trim()) throw new Error('文献目录配置无效')
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    await this.setRoot(explicitRoot || saved?.root || defaultRoot)
  }

  async setRoot(root) {
    if (typeof root !== 'string' || !path.isAbsolute(root))
      throw new Error('请选择完整的工作文件夹路径')
    await fs.mkdir(root, { recursive: true })
    const resolved = await fs.realpath(root)
    for (const name of ['literature', '待整理']) {
      const directory = path.join(resolved, name)
      await fs.mkdir(directory, { recursive: true })
      if (!isInside(resolved, await fs.realpath(directory)))
        throw new Error('文献目录链接指向工作文件夹之外')
    }
    const temporary = `${this.configurationPath}.tmp`
    await fs.mkdir(path.dirname(this.configurationPath), { recursive: true })
    await fs.writeFile(temporary, JSON.stringify({ root: resolved }, null, 2), 'utf8')
    await fs.rename(temporary, this.configurationPath)
    this.root = resolved
    this.watchError = ''
    return resolved
  }

  get roots() {
    return { library: path.join(this.root, 'literature'), inbox: path.join(this.root, '待整理') }
  }

  async resolveItem({ scope, relativePath = '', kind = 'directory' }) {
    if (!['library', 'inbox'].includes(scope)) throw new Error('文件位置无效')
    const root = this.roots[scope]
    if (
      !root ||
      typeof relativePath !== 'string' ||
      relativePath.includes('\0') ||
      path.isAbsolute(relativePath) ||
      path.win32.isAbsolute(relativePath)
    ) {
      throw new Error('文件位置无效')
    }
    const target = path.resolve(root, relativePath)
    if (!isInside(root, target)) throw new Error('文件位置超出文献目录')
    const realRoot = await fs.realpath(root)
    const realTarget = await fs.realpath(target)
    if (!isInside(realRoot, realTarget)) throw new Error('文件链接指向文献目录之外')
    const information = await fs.stat(realTarget)
    if (kind === 'file') {
      if (!information.isFile() || path.extname(realTarget).toLowerCase() !== '.pdf')
        throw new Error('请选择 PDF 文献')
    } else if (kind !== 'directory' || !information.isDirectory()) {
      throw new Error('请选择文献文件夹')
    }
    return realTarget
  }

  async snapshot() {
    const root = this.root
    const roots = this.roots
    const folders = []
    const files = []
    const warnings = []
    if (this.watchError) warnings.push(this.watchError)
    async function walk(scope, relativePath, parent) {
      const directory = path.join(roots[scope], relativePath)
      const folder = {
        scope,
        relativePath,
        parent,
        name: relativePath
          ? path.posix.basename(relativePath)
          : scope === 'inbox'
            ? '待整理'
            : '文献库',
        count: 0,
        bytes: 0,
      }
      folders.push(folder)
      try {
        const entries = await fs.readdir(directory, { withFileTypes: true })
        entries.sort((left, right) =>
          left.name.localeCompare(right.name, 'zh-CN', { numeric: true }),
        )
        for (const entry of entries) {
          if (entry.isSymbolicLink() || entry.name.startsWith('.')) continue
          const relative = path.posix.join(relativePath, entry.name)
          if (entry.isDirectory()) {
            const child = await walk(scope, relative, relativePath)
            folder.count += child.count
            folder.bytes += child.bytes
          } else if (entry.isFile() && path.extname(entry.name).toLowerCase() === '.pdf') {
            try {
              const information = await fs.stat(path.join(directory, entry.name))
              files.push({
                scope,
                relativePath: relative,
                parent: relativePath,
                name: entry.name,
                bytes: information.size,
                modifiedAt: information.mtime.toISOString(),
              })
              folder.count += 1
              folder.bytes += information.size
            } catch (error) {
              if (error.code !== 'ENOENT') warnings.push(`${relative}，${error.message}`)
            }
          }
        }
      } catch (error) {
        warnings.push(`${directory}，${error.message}`)
      }
      return folder
    }
    const library = await walk('library', '', null)
    const inbox = await walk('inbox', '', null)
    return {
      root,
      libraryPath: roots.library,
      inboxPath: roots.inbox,
      folders,
      files,
      warnings,
      counts: { library: library.count, inbox: inbox.count },
      bytes: library.bytes + inbox.bytes,
      scannedAt: new Date().toISOString(),
    }
  }
}
