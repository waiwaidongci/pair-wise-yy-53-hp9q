import type { RightsType, Territory } from '../types'

/** 核验阻断原因（财务最关注：过期窗口收入不能进分成） */
export type BlockReason =
  | 'NO_SNAPSHOT' // 无匹配授权快照
  | 'WINDOW_NOT_STARTED' // 回传到达时窗口尚未生效
  | 'WINDOW_EXPIRED' // 回传到达时窗口已过期
  | 'PERIOD_OUTSIDE' // 收入期整体落在授权窗口之外
  | 'EXCLUSIVITY_MISMATCH' // 独占范围内出现未授权渠道
  | 'BATCH_NOT_FOUND' // 无对应结算批次
  | 'BATCH_PERIOD_MISMATCH' // 批次账期与回传收入期不一致
  | 'BATCH_CLOSED' // 结算批次已关账
  | 'TECHNICAL' // 传输/处理失败，可恢复

/** 差异来源：分成行为什么与最初入账时不同 */
export type DiscrepancySource =
  | '窗口变更重算'
  | '独占范围不符'
  | '结算批次不匹配'
  | '无授权快照'
  | '历史回填'
  | '后到版本冲突'
  | '包号重复'
  | '窗口已过期'

/** 授权快照：回传到达时按作品 + 地区 + 渠道匹配的“当时有效”版本 */
export interface LicenseSnapshot {
  id: string
  windowId: string
  version: number
  workId: string
  work: string
  channel: string
  rights: RightsType
  territory: Territory
  start: string
  end: string
  exclusive: boolean
  rate: number // 分成比例 0..1
  effectiveFrom: string // 该版本快照生效日期（回传到达时按此选取版本）
  signedAt?: string // 原始签署日期（旧数据回填时保留）
  backfilled?: boolean
  note?: string
}

export interface SettlementBatch {
  id: string
  name: string
  periodStart: string
  periodEnd: string
  status: '开放' | '处理中' | '已关账'
}

export interface HeldVersion {
  version: number
  gross: number
  receivedAt: string
  note: string
  decided: boolean
}

export type PackageStatus =
  | '队列中'
  | '处理中'
  | '已确认'
  | '阻断'
  | '失败'
  | '后到版本留验'

export interface AgentPackage {
  id: string // 包号，排队与幂等的主键
  seq: number // 入队序号（同时提交的一组按包号排序，其余按到达先后 FIFO）
  workId: string
  work: string
  channel: string
  rights: RightsType
  territory: Territory
  periodStart: string
  periodEnd: string
  gross: number // 代理回传实收
  receivedAt: string
  batchId: string
  submittedTogether: boolean // 是否与另一笔同时提交（以包号定先后）
  fingerprint: string // 内容幂等指纹（包号相同但内容不同 => 后到版本）
  status: PackageStatus
  attemptCount: number
  blockReason?: BlockReason
  blockDetail?: string
  confirmedAt?: string
  heldVersion?: HeldVersion
}

export type ShareLineStatus = '正常' | '待重算' | '已重算' | '阻断' | '历史'

/** 分成行：一笔回传确认后唯一对应一行，重复包号不会产生第二行 */
export interface ShareLine {
  id: string // SL-<包号>
  packageId: string
  windowId: string
  snapshotId: string // 入账时所依据的授权快照（可能为空，等待旧数据回填）
  snapshotVersion: number
  workId: string
  work: string
  channel: string
  territory: Territory
  batchId: string
  periodStart: string
  periodEnd: string
  gross: number
  eligible: number // 落入有效窗口的可计提收入（跨窗口按天折算）
  rate: number
  share: number
  status: ShareLineStatus
  sources: DiscrepancySource[]
  note?: string
  bookedAt: string
}

export interface ReconcileLog {
  time: string
  level: 'info' | 'success' | 'warn' | 'error'
  event: string
  detail: string
}

export interface ReconcileState {
  snapshots: LicenseSnapshot[]
  batches: SettlementBatch[]
  packages: AgentPackage[]
  shares: ShareLine[]
  checkpoint: string | null // 已确认包号（恢复点）
  failure: { packageId: string; detail: string } | null
  logs: ReconcileLog[]
}

export interface IncomingPackage {
  id: string
  workId: string
  work: string
  channel: string
  rights: RightsType
  territory: Territory
  periodStart: string
  periodEnd: string
  gross: number
  receivedAt: string
  batchId: string
  submittedTogether?: boolean
}
