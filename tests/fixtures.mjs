/** 仅用于软件回归测试的合成 PDF 与占位实体，均与实际研究数据分开保存。 */
import fs from 'node:fs/promises'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { emptyMetadata } from '../core/metadata.mjs'

export const fixtureQuote =
  'Compound Alpha, Bacterium Beta, and colorectal cancer are placeholder entities.'

export async function writeFixture(
  filePath,
  { title = 'Synthetic software test document', blank = false } = {},
) {
  const pdf = await PDFDocument.create()
  pdf.setTitle(title)
  pdf.setAuthor('Synthetic Test Author')
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  const page = pdf.addPage([650, 750])
  if (!blank) {
    const lines = [
      title,
      'Synthetic fixture for software testing. All entities are placeholders.',
      fixtureQuote,
      'The file is used to verify import, evidence matching, naming, and undo.',
    ]
    lines.forEach((line, index) =>
      page.drawText(line, { x: 35, y: 680 - index * 35, size: 11, font }),
    )
    const second = pdf.addPage([650, 750])
    second.drawText('Second page of the synthetic fixture. This page verifies pagination.', {
      x: 35,
      y: 680,
      size: 11,
      font,
    })
  }
  await fs.writeFile(filePath, await pdf.save())
}

export function fixtureMetadata() {
  return {
    ...emptyMetadata('Synthetic software test document'),
    shortTitleZh: '软件测试用合成文献',
    shortTitleEn: 'Synthetic software fixture',
    authors: ['Synthetic Test Author'],
    year: '2026',
    drugsZh: ['占位药物甲'],
    drugsEn: ['Compound Alpha'],
    microbes: ['Bacterium Beta'],
    diseasesZh: ['结直肠癌'],
    diseasesEn: ['Colorectal cancer'],
    studyTypeZh: '软件测试样例',
    studyTypeEn: 'Synthetic software fixture',
    findingZh: '该文档用于测试读取、命名和归档功能。所有研究对象均为占位符。',
    findingEn: 'A synthetic fixture for testing document reading and organization.',
    tagsZh: ['软件测试'],
    tagsEn: ['Software testing'],
    evidence: [
      { field: 'drug', value: 'Compound Alpha', page: 1, quote: fixtureQuote },
      { field: 'microbe', value: 'Bacterium Beta', page: 1, quote: fixtureQuote },
      { field: 'disease', value: 'Colorectal cancer', page: 1, quote: fixtureQuote },
    ],
  }
}
