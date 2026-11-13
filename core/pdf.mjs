/** PDF 逐页读取与完整性检查。原始 PDF 只读，正文缓存记录实际读取范围。 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const pdfRoot = path.dirname(require.resolve('pdfjs-dist/package.json'))
let pdfModule

export async function extractPdf(filePath) {
  const bytes = await fs.readFile(filePath)
  if (!bytes.length) throw new Error('文件为空')
  if (!bytes.subarray(0, 1024).toString('latin1').includes('%PDF-')) {
    throw new Error('文件内容无法识别为 PDF，请检查是否下载了错误页面')
  }
  pdfModule ||= await import('pdfjs-dist/legacy/build/pdf.mjs')
  const task = pdfModule.getDocument({
    data: new Uint8Array(bytes),
    isEvalSupported: false,
    useSystemFonts: true,
    standardFontDataUrl: `${path.join(pdfRoot, 'standard_fonts')}/`,
    cMapUrl: `${path.join(pdfRoot, 'cmaps')}/`,
    cMapPacked: true,
  })
  let pdf
  try {
    pdf = await task.promise
    const pages = []
    for (let number = 1; number <= pdf.numPages; number += 1) {
      const page = await pdf.getPage(number)
      const content = await page.getTextContent()
      const pageText = content.items
        .filter((item) => 'str' in item)
        .map((item) => `${item.str}${item.hasEOL ? '\n' : ' '}`)
        .join('')
        .replace(/ +\n/g, '\n')
        .trim()
      pages.push({ number, text: pageText })
      page.cleanup()
    }
    const info = await pdf.getMetadata().catch(() => ({ info: {} }))
    const textLength = pages.reduce((total, page) => total + page.text.length, 0)
    const emptyPages = pages.filter((page) => page.text.length < 20).map((page) => page.number)
    return {
      pages,
      title: typeof info.info?.Title === 'string' ? info.info.Title.trim() : '',
      textLength,
      emptyPages,
      needsOcr: textLength < 80,
    }
  } catch (error) {
    if (error.name === 'PasswordException')
      throw new Error('PDF 有密码保护，请先使用已解密的文献副本')
    throw new Error(`PDF 读取失败：${error.message}`, { cause: error })
  } finally {
    await task.destroy()
  }
}
