// ETF 白名单：选股推荐的 ETF 候选池（方案B——主流场内 ETF 固定清单，不扫全市场）。
// 为什么用白名单而不是全量快照：不新增快照接口请求（风控面不扩大）、聚焦流动性好的主流品种、
// 不受个股扫描参数（价格区间等）影响。清单放 .data/etf-list.json 可自由增删（格式见 DEFAULT_ETF_LIST），
// 文件不存在或格式坏时回退内置默认。
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

export interface EtfItem {
  code: string
  name: string
}

/** 内置默认清单：宽基 + 主流行业 + 跨境 + 商品，均为场内流动性好的品种 */
export const DEFAULT_ETF_LIST: EtfItem[] = [
  // 宽基
  { code: '510300', name: '沪深300ETF' },
  { code: '510500', name: '中证500ETF' },
  { code: '510050', name: '上证50ETF' },
  { code: '588000', name: '科创50ETF' },
  { code: '159915', name: '创业板ETF' },
  { code: '159949', name: '创业板50ETF' },
  { code: '512100', name: '中证1000ETF' },
  { code: '510880', name: '红利ETF' },
  { code: '159901', name: '深100ETF' },
  // 行业/主题
  { code: '512880', name: '证券ETF' },
  { code: '512000', name: '券商ETF' },
  { code: '512010', name: '医药ETF' },
  { code: '512170', name: '医疗ETF' },
  { code: '512480', name: '半导体ETF' },
  { code: '159995', name: '芯片ETF' },
  { code: '512690', name: '酒ETF' },
  { code: '159928', name: '消费ETF' },
  { code: '512800', name: '银行ETF' },
  { code: '512660', name: '军工ETF' },
  { code: '512400', name: '有色金属ETF' },
  { code: '515790', name: '光伏ETF' },
  { code: '515030', name: '新能源车ETF' },
  { code: '512200', name: '房地产ETF' },
  // 跨境
  { code: '513100', name: '纳指ETF' },
  { code: '513500', name: '标普500ETF' },
  { code: '513050', name: '中概互联网ETF' },
  { code: '513180', name: '恒生科技ETF' },
  // 商品
  { code: '518880', name: '黄金ETF' },
  { code: '159985', name: '豆粕ETF' },
]

const DEFAULT_DIR = resolve(process.cwd(), '.data')

function validList(v: unknown): v is EtfItem[] {
  return Array.isArray(v) && v.every((x) => typeof (x as EtfItem).code === 'string' && /^\d{6}$/.test((x as EtfItem).code) && typeof (x as EtfItem).name === 'string')
}

/** 读 ETF 白名单：.data/etf-list.json 覆盖优先（用户可自由增删），缺省/坏格式回退内置默认 */
export async function loadEtfList(dir: string = DEFAULT_DIR): Promise<EtfItem[]> {
  try {
    const raw = await readFile(resolve(dir, 'etf-list.json'), 'utf-8')
    const parsed = JSON.parse(raw)
    if (validList(parsed)) return parsed
  } catch { /* 文件不存在或坏 JSON：用默认 */ }
  return DEFAULT_ETF_LIST
}
