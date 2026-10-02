import type { AuthSnapshot, ReturnLine, ReturnPackage, SettlementBatch } from './types'
import { verifyPackage } from './settlement'

/**
 * 授权快照：窗口在某一时点的不可变版本。
 * RW-102 经历过一次窗口调整（11-15 → 11-20），因此存在 v1/v2 两个快照版本。
 * RW-099 为 2025 年历史窗口，尚无快照，用于演示按原签署日期升级回填。
 */
export const initialSnapshots: AuthSnapshot[] = [
  { id: 'SNAP-101-1', windowId: 'RW-101', workId: 'W-001', work: '《远山回声》', channel: '星海影院', rights: '院线', territory: '中国大陆', start: '2026-10-18', end: '2026-12-05', exclusive: true, sublicense: false, priority: 1, signedDate: '2026-09-01', version: 1, validFrom: '2026-09-01', validTo: null, origin: 'current', shareRate: 0.4 },
  { id: 'SNAP-102-1', windowId: 'RW-102', workId: 'W-001', work: '《远山回声》', channel: '云帆视频', rights: '流媒体', territory: '中国大陆', start: '2026-11-15', end: '2027-11-19', exclusive: true, sublicense: false, priority: 2, signedDate: '2026-09-05', version: 1, validFrom: '2026-09-05', validTo: '2026-11-19', origin: 'current', shareRate: 0.5 },
  { id: 'SNAP-102-2', windowId: 'RW-102', workId: 'W-001', work: '《远山回声》', channel: '云帆视频', rights: '流媒体', territory: '中国大陆', start: '2026-11-20', end: '2027-11-19', exclusive: true, sublicense: false, priority: 2, signedDate: '2026-09-05', version: 2, validFrom: '2026-11-20', validTo: null, origin: 'current', shareRate: 0.5 },
  { id: 'SNAP-103-1', windowId: 'RW-103', workId: 'W-001', work: '《远山回声》', channel: '南华卫视', rights: '电视', territory: '中国大陆', start: '2027-01-08', end: '2027-03-31', exclusive: false, sublicense: true, priority: 4, signedDate: '2026-09-10', version: 1, validFrom: '2026-09-10', validTo: null, origin: 'current', shareRate: 0.3 },
  { id: 'SNAP-104-1', windowId: 'RW-104', workId: 'W-002', work: '《深港口岸》', channel: '云帆视频', rights: '流媒体', territory: '新加坡', start: '2026-12-01', end: '2027-05-31', exclusive: true, sublicense: false, priority: 1, signedDate: '2026-09-12', version: 1, validFrom: '2026-09-12', validTo: null, origin: 'current', shareRate: 0.5 },
  { id: 'SNAP-105-1', windowId: 'RW-105', workId: 'W-002', work: '《深港口岸》', channel: '海岛航空', rights: '航空', territory: '东南亚区域', start: '2027-01-15', end: '2027-07-14', exclusive: false, sublicense: true, priority: 3, signedDate: '2026-09-15', version: 1, validFrom: '2026-09-15', validTo: null, origin: 'current', shareRate: 0.2 },
]

interface RawLine {
  id: string
  packageNo: string
  agent: string
  workId: string
  work: string
  channel: string
  territory: ReturnLine['territory']
  periodStart: string
  periodEnd: string
  gross: number
  refVersion: number | null
}

const rawLines: RawLine[] = [
  { id: 'PKG-2026-001-L1', packageNo: 'PKG-2026-001', agent: '星海院线发行', workId: 'W-001', work: '《远山回声》', channel: '星海影院', territory: '中国大陆', periodStart: '2026-11-01', periodEnd: '2026-11-30', gross: 1200000, refVersion: 1 },
  { id: 'PKG-2026-002-L1', packageNo: 'PKG-2026-002', agent: '云帆视频发行', workId: 'W-001', work: '《远山回声》', channel: '云帆视频', territory: '中国大陆', periodStart: '2026-12-01', periodEnd: '2026-12-31', gross: 860000, refVersion: 2 },
  { id: 'PKG-2026-003-L1', packageNo: 'PKG-2026-003', agent: '云帆视频发行', workId: 'W-001', work: '《远山回声》', channel: '云帆视频', territory: '中国大陆', periodStart: '2027-12-01', periodEnd: '2027-12-31', gross: 320000, refVersion: 2 },
  { id: 'PKG-2026-004-L1', packageNo: 'PKG-2026-004', agent: '南华卫视发行', workId: 'W-001', work: '《远山回声》', channel: '南华卫视', territory: '中国大陆', periodStart: '2027-02-01', periodEnd: '2027-02-28', gross: 540000, refVersion: 1 },
  { id: 'PKG-2026-005-L1', packageNo: 'PKG-2026-005', agent: '海岛航空发行', workId: 'W-002', work: '《深港口岸》', channel: '海岛航空', territory: '东南亚区域', periodStart: '2027-03-01', periodEnd: '2027-03-31', gross: 180000, refVersion: 1 },
  { id: 'PKG-2026-006-L1', packageNo: 'PKG-2026-006', agent: '云帆视频发行', workId: 'W-002', work: '《深港口岸》', channel: '云帆视频', territory: '新加坡', periodStart: '2027-01-01', periodEnd: '2027-01-31', gross: 410000, refVersion: 1 },
  { id: 'PKG-2026-007-L1', packageNo: 'PKG-2026-007', agent: '环球新媒体发行', workId: 'W-001', work: '《远山回声》', channel: '环球新媒体', territory: '中国大陆', periodStart: '2026-12-01', periodEnd: '2026-12-31', gross: 260000, refVersion: 1 },
  { id: 'PKG-2026-008-L1', packageNo: 'PKG-2026-008', agent: '云帆视频发行', workId: 'W-001', work: '《远山回声》', channel: '云帆视频', territory: '中国大陆', periodStart: '2026-12-01', periodEnd: '2026-12-31', gross: 290000, refVersion: 1 },
  { id: 'PKG-2025-011-L1', packageNo: 'PKG-2025-011', agent: '云帆视频发行', workId: 'W-001', work: '《远山回声》', channel: '云帆视频', territory: '中国大陆', periodStart: '2025-04-01', periodEnd: '2025-06-30', gross: 150000, refVersion: null },
  { id: 'PKG-2025-012-L1', packageNo: 'PKG-2025-012', agent: '云帆视频发行', workId: 'W-001', work: '《远山回声》', channel: '云帆视频', territory: '中国大陆', periodStart: '2025-07-01', periodEnd: '2025-09-30', gross: 175000, refVersion: null },
]

export const initialPackages: ReturnPackage[] = rawLines.map((line, index) => ({
  packageNo: line.packageNo,
  agent: line.agent,
  region: line.territory,
  submittedAt: line.packageNo.startsWith('PKG-2025') ? '2025-10-15T09:00:00.000Z' : `2026-10-02T09:0${index}:00.000Z`,
  queuedAt: line.packageNo.startsWith('PKG-2025') ? '2025-10-15T09:00:00.000Z' : `2026-10-02T09:0${index}:30.000Z`,
  status: '排队中',
  lineIds: [line.id],
  batchId: null,
  refVersion: line.refVersion,
  blockingReason: null,
  confirmedAt: null,
}))

export const initialLines: ReturnLine[] = rawLines.map((line) => ({
  id: line.id,
  packageNo: line.packageNo,
  agent: line.agent,
  workId: line.workId,
  work: line.work,
  channel: line.channel,
  territory: line.territory,
  periodStart: line.periodStart,
  periodEnd: line.periodEnd,
  gross: line.gross,
  currency: 'CNY',
  snapshotId: null,
  snapshotVersion: null,
  matchStatus: 'no-auth',
  diffReason: null,
  shareRate: null,
  shareAmount: null,
  status: '待核验',
  blockingReason: null,
  batchId: null,
  backfilled: false,
}))

export const initialBatches: SettlementBatch[] = [
  { id: 'STL-2026-Q4', name: '2026 第四季度结算批次', period: '2026-Q4', status: '草稿', packageNos: ['PKG-2026-001', 'PKG-2026-002', 'PKG-2026-004', 'PKG-2026-005', 'PKG-2026-006'] },
  { id: 'STL-2026-HOLD', name: '待核验与阻断批次', period: '2026-HOLD', status: '待核验', packageNos: ['PKG-2026-003', 'PKG-2026-007', 'PKG-2026-008'] },
  { id: 'STL-2025-LEGACY', name: '2025 年度历史结算批次（回填）', period: '2025', status: '已确认', packageNos: ['PKG-2025-011', 'PKG-2025-012'] },
]

/**
 * 首次加载时按包号排队对初始回传包核验一遍，使 store 与 tRPC 读模型一致。
 * 重复包号只入账一次、后到版本冲突留待核验、旧数据待回填。
 */
function preverify(): { packages: ReturnPackage[]; lines: ReturnLine[] } {
  let packages = [...initialPackages]
  let lines = [...initialLines]
  const seen = new Set<string>()
  const sorted = [...packages].sort((a, b) => a.packageNo.localeCompare(b.packageNo, 'zh'))
  for (const pkg of sorted) {
    const verdict = verifyPackage(pkg, lines.filter((l) => l.packageNo === pkg.packageNo), initialSnapshots, seen)
    packages = packages.map((p) =>
      p.packageNo === pkg.packageNo
        ? { ...p, status: verdict.status, blockingReason: verdict.blockingReason, confirmedAt: verdict.status === '已入账' ? new Date().toISOString() : null }
        : p,
    )
    lines = lines.map((l) => {
      const v = verdict.lines.find((vl) => vl.id === l.id)
      return v ?? l
    })
    if (verdict.status === '已入账') seen.add(pkg.packageNo)
  }
  return { packages, lines }
}

const verified = preverify()
export const verifiedPackages = verified.packages
export const verifiedLines = verified.lines
