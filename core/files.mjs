import fs from 'node:fs/promises'
import path from 'node:path'

// 只遍历用户明确选定的目录，并跳过目录链接，防止循环读取。
export async function findPdfs(folder) {
  const results = []
  const stack = [path.resolve(folder)]
  while (stack.length) {
    const directory = stack.pop()
    const entries = await fs.readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      const filePath = path.join(directory, entry.name)
      if (entry.isDirectory()) stack.push(filePath)
      else if (entry.isFile() && path.extname(entry.name).toLowerCase() === '.pdf')
        results.push(filePath)
    }
  }
  return results.sort()
}
