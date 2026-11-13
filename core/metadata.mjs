/**
 * 文献字段与命名规则。输入为原文提取结果，输出为可追溯字段和安全文件名。
 * 日期 2026-11-13。阶段为桌面应用首版，研究结论始终保留来源及人工核对状态。
 */
import path from 'node:path'
import { z } from 'zod'

const text = z.string().max(4000)
const list = z.array(z.string().max(300)).max(60)
export const metadataSchema = z.object({
  title: text,
  shortTitleZh: text,
  shortTitleEn: text,
  authors: list,
  year: z.string().max(20),
  doi: z.string().max(300),
  drugsZh: list,
  drugsEn: list,
  microbes: list,
  diseasesZh: list,
  diseasesEn: list,
  studyTypeZh: text,
  studyTypeEn: text,
  findingZh: text,
  findingEn: text,
  tagsZh: list,
  tagsEn: list,
  evidence: z
    .array(
      z.object({
        field: z.enum([
          'title',
          'authors',
          'year',
          'doi',
          'drug',
          'microbe',
          'disease',
          'studyType',
          'finding',
          'tag',
        ]),
        value: z.string().max(500),
        page: z.number().int().min(1),
        quote: z.string().min(1).max(2000),
      }),
    )
    .max(300),
})

export const metadataJsonSchema = z.toJSONSchema(metadataSchema)

export function emptyMetadata(title = '') {
  return {
    title,
    shortTitleZh: '',
    shortTitleEn: '',
    authors: [],
    year: '',
    doi: '',
    drugsZh: [],
    drugsEn: [],
    microbes: [],
    diseasesZh: [],
    diseasesEn: [],
    studyTypeZh: '',
    studyTypeEn: '',
    findingZh: '',
    findingEn: '',
    tagsZh: [],
    tagsEn: [],
    evidence: [],
  }
}

export const templates = [
  { id: 'drug-microbe', name: '药物 + 菌种 + 疾病', pattern: '{drug}_{microbe}_{disease}_{year}' },
  { id: 'bibliographic', name: '年份 + 作者 + 短标题', pattern: '{year}_{author}_{title}' },
  {
    id: 'microbiome',
    name: '菌种 + 疾病 + 研究类型',
    pattern: '{microbe}_{disease}_{studyType}_{year}',
  },
  { id: 'topic', name: '研究主题 + 短标题', pattern: '{topic}_{title}_{year}' },
  { id: 'custom', name: '自定义模板', pattern: '{year}_{title}' },
]

export const defaultSettings = {
  provider: 'agent',
  language: 'zh',
  template: 'drug-microbe',
  customTemplate: '{year}_{title}',
  ollamaUrl: 'http://127.0.0.1:11434',
  model: '',
  projectFocus: '',
  watchFolder: '',
  watchEnabled: false,
  autoAnalyze: false,
}

export function normalizedText(value) {
  return String(value).normalize('NFKC').replace(/\s+/g, '').toLowerCase()
}

export function validateMetadata(input, pages) {
  const parsed = metadataSchema.parse({ ...emptyMetadata(), ...input })
  for (const [key, value] of Object.entries(parsed)) {
    if (Array.isArray(value) && key !== 'evidence')
      parsed[key] = [...new Set(value.map((item) => item.trim()).filter(Boolean))]
    if (typeof value === 'string') parsed[key] = value.trim()
  }
  const warnings = []
  const evidence = parsed.evidence.map((entry) => {
    const source = pages.find((page) => page.number === entry.page)?.text || ''
    const quote = normalizedText(entry.quote)
    const matched = quote.length >= 8 && normalizedText(source).includes(quote)
    if (!matched) warnings.push(`第 ${entry.page} 页的 ${entry.field} 引文需要核对`)
    return { ...entry, matched }
  })
  const groups = [
    ['drug', [...parsed.drugsZh, ...parsed.drugsEn]],
    ['microbe', parsed.microbes],
    ['disease', [...parsed.diseasesZh, ...parsed.diseasesEn]],
    ['finding', [parsed.findingZh, parsed.findingEn].filter(Boolean)],
  ]
  for (const [field, values] of groups) {
    if (values.length && !evidence.some((item) => item.field === field && item.matched)) {
      warnings.push(`${field} 字段缺少匹配成功的原文依据`)
    }
  }
  return { metadata: { ...parsed, evidence }, warnings: [...new Set(warnings)] }
}

export function safeSegment(value, maxLength = 110) {
  let cleaned = String(value || '')
    .normalize('NFC')
    .replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '')
  if (/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(cleaned)) cleaned = `_${cleaned}`
  return Array.from(cleaned)
    .slice(0, maxLength)
    .join('')
    .replace(/[. ]+$/g, '')
}

export function namingFields(metadata, language = 'zh') {
  const english = language === 'en'
  const shortTitle = english ? metadata.shortTitleEn : metadata.shortTitleZh
  const drugs = english ? metadata.drugsEn : metadata.drugsZh
  const diseases = english ? metadata.diseasesEn : metadata.diseasesZh
  const tags = english ? metadata.tagsEn : metadata.tagsZh
  return {
    title: shortTitle || metadata.title,
    year: metadata.year,
    author: metadata.authors[0] || '',
    drug: drugs.slice(0, 2).join('+'),
    microbe: metadata.microbes.slice(0, 2).join('+'),
    disease: diseases.slice(0, 2).join('+'),
    studyType: english ? metadata.studyTypeEn : metadata.studyTypeZh,
    topic: tags[0] || diseases[0] || '',
  }
}

export function buildName(document, settings) {
  const template = templates.find((item) => item.id === settings.template)
  if (!template) throw new Error('命名模板不存在')
  const pattern = template.id === 'custom' ? settings.customTemplate : template.pattern
  if (!pattern || pattern.length > 500) throw new Error('请填写长度在 500 字符以内的命名模板')
  const fields = namingFields(document.metadata, settings.language)
  const missing = []
  const rendered = pattern
    .replace(/\{([^{}]+)\}/g, (_, key) => {
      if (!(key in fields)) throw new Error(`模板字段 ${key} 无法识别`)
      if (!fields[key]) missing.push(key)
      return safeSegment(fields[key], key === 'title' ? 64 : 44)
    })
    .replace(/[_\- ]{2,}/g, '_')
    .replace(/^[_\- ]+|[_\- ]+$/g, '')
  const fallback = safeSegment(fields.title || path.parse(document.originalName).name, 100)
  const subjectFields = [...pattern.matchAll(/\{([^{}]+)\}/g)]
    .map((match) => match[1])
    .filter((key) => !['year', 'author'].includes(key))
  const missingSubject = template.id !== 'custom' && !subjectFields.some((key) => fields[key])
  const meaningfulName = missingSubject
    ? [fallback, fields.year].filter(Boolean).join('_')
    : rendered
  const stem = safeSegment(meaningfulName || fallback || 'Paper', 110)
  const folder = safeSegment(
    fields.disease || fields.topic || (settings.language === 'en' ? 'Unclassified' : '未分类'),
    55,
  )
  return {
    fileName: `${stem}__${document.hash.slice(0, 8)}.pdf`,
    folder,
    missing: [...new Set(missing)],
  }
}

export function validateSettings(input) {
  const value = z
    .object({
      provider: z.enum(['agent', 'ollama']),
      language: z.enum(['zh', 'en']),
      template: z.enum(templates.map((item) => item.id)),
      customTemplate: z.string().min(1).max(500),
      ollamaUrl: z.string().url(),
      model: z.string().max(200),
      projectFocus: z.string().max(4000),
      watchFolder: z.string().max(2000),
      watchEnabled: z.boolean(),
      autoAnalyze: z.boolean(),
    })
    .parse({ ...defaultSettings, ...input })
  // 首版本地模型请求限定到回环地址，避免把文献意外发往远端。
  const url = new URL(value.ollamaUrl)
  if (
    url.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  ) {
    throw new Error('本地模型地址应为 http://127.0.0.1:端口 这样的回环地址')
  }
  if (value.autoAnalyze && value.provider !== 'ollama')
    throw new Error('自动分析需要选择已配置的本地模型')
  return value
}
