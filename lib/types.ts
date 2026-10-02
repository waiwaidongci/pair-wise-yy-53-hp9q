export type RightsType = '院线' | '电视' | '流媒体' | '航空' | '非院线'
export type Territory = '中国大陆' | '中国香港' | '中国台湾' | '新加坡' | '马来西亚' | '东南亚区域' | '北美'

export interface LicenseWindow {
  id: string
  workId: string
  work: string
  channel: string
  rights: RightsType
  territory: Territory
  start: string
  end: string
  exclusive: boolean
  sublicense: boolean
  priority: number
  status: '草案' | '冲突' | '已确认'
  signedDate: string
}

export interface RightsComment {
  id: string
  channel: string
  anchor: string
  author: string
  role: string
  content: string
  resolved: boolean
}

export interface DraftVersion {
  id: string
  author: string
  time: string
  summary: string
  changes: string[]
}

/** 授权快照：授权窗口在某一时点的不可变版本，回传按作品/地区/渠道匹配它 */
export interface AuthSnapshot {
  id: string
  windowId: string
  workId: string
  work: string
  channel: string
  rights: RightsType
  territory: Territory
  start: string
  end: string
  exclusive: boolean
  sublicense: boolean
  priority: number
  /** 原签署日期，用于旧数据回填 */
  signedDate: string
  version: number
  validFrom: string
  validTo: string | null
  origin: 'current' | 'backfill'
  shareRate: number
}

export type MatchStatus = 'matched' | 'expired' | 'not-open' | 'no-auth' | 'exclusive-conflict' | 'legacy' | 'backfilled'
export type LineStatus = '已入账' | '待核验' | '已阻断'
export type PackageStatus = '排队中' | '已入账' | '待核验' | '已阻断' | '处理失败'

/** 回传行：代理回传的一条实收明细 */
export interface ReturnLine {
  id: string
  packageNo: string
  agent: string
  workId: string
  work: string
  channel: string
  territory: Territory
  periodStart: string
  periodEnd: string
  gross: number
  currency: string
  snapshotId: string | null
  snapshotVersion: number | null
  matchStatus: MatchStatus
  diffReason: string | null
  shareRate: number | null
  shareAmount: number | null
  status: LineStatus
  blockingReason: string | null
  batchId: string | null
  backfilled: boolean
}

/** 回传包：以包号为唯一标识的一次代理提交 */
export interface ReturnPackage {
  packageNo: string
  agent: string
  region: string
  submittedAt: string
  queuedAt: string
  status: PackageStatus
  lineIds: string[]
  batchId: string | null
  /** 回传所依据的快照版本，用于后到版本冲突判定 */
  refVersion: number | null
  blockingReason: string | null
  confirmedAt: string | null
}

/** 结算批次：回传包按结算周期归集 */
export interface SettlementBatch {
  id: string
  name: string
  period: string
  status: '草稿' | '待核验' | '已确认'
  packageNos: string[]
}
