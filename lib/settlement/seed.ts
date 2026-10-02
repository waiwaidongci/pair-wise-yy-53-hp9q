import type { IncomingPackage, LicenseSnapshot, ReconcileState, SettlementBatch, ShareLine } from './types'
import { enqueue, processQueue } from './engine'

export const settlementBatches: SettlementBatch[] = [
  { id: 'B-2026Q3', name: '2026 年第三季度批次', periodStart: '2026-07-01', periodEnd: '2026-09-30', status: '已关账' },
  { id: 'B-2026Q4', name: '2026 年第四季度批次', periodStart: '2026-10-01', periodEnd: '2026-12-31', status: '开放' },
  { id: 'B-2027Q1', name: '2027 年第一季度批次', periodStart: '2027-01-01', periodEnd: '2027-03-31', status: '处理中' },
]

export const initialSnapshots: LicenseSnapshot[] = [
  { id: 'S101-v1', windowId: 'RW-101', version: 1, workId: 'W-001', work: '《远山回声》', channel: '星海影院', rights: '院线', territory: '中国大陆', start: '2026-10-18', end: '2026-12-05', exclusive: true, rate: 0.42, effectiveFrom: '2026-09-01' },
  { id: 'S102-v1', windowId: 'RW-102', version: 1, workId: 'W-001', work: '《远山回声》', channel: '云帆视频', rights: '流媒体', territory: '中国大陆', start: '2026-11-20', end: '2027-11-19', exclusive: true, rate: 0.35, effectiveFrom: '2026-09-01' },
  { id: 'S104-v1', windowId: 'RW-104', version: 1, workId: 'W-002', work: '《深港口岸》', channel: '云帆视频', rights: '流媒体', territory: '新加坡', start: '2026-12-01', end: '2027-05-31', exclusive: true, rate: 0.38, effectiveFrom: '2026-10-01' },
  { id: 'S105-v1', windowId: 'RW-105', version: 1, workId: 'W-002', work: '《深港口岸》', channel: '海岛航空', rights: '航空', territory: '东南亚区域', start: '2027-01-15', end: '2027-07-14', exclusive: false, rate: 0.25, effectiveFrom: '2026-10-20' },
]

/** RW-102 窗口变更后的新版本（演示“只重算受影响分成行”） */
export const windowV2Snapshot: LicenseSnapshot = {
  ...initialSnapshots[1]!,
  id: 'S102-v2',
  version: 2,
  start: '2026-12-15',
  end: '2027-11-19',
  rate: 0.33,
  effectiveFrom: '2026-12-15',
  note: '院线尾部延长，流媒体开窗顺延至 12-15，分成比例下调至 33%',
}

/** 旧数据：无授权快照的回传，等待按原签署日期回填 */
export const backfillSnapshot: LicenseSnapshot = {
  id: 'S401-v1',
  windowId: 'RW-401',
  version: 1,
  workId: 'W-003',
  work: '《北纬63度》',
  channel: '环球新媒体',
  rights: '电视',
  territory: '北美',
  start: '2026-10-01',
  end: '2027-09-30',
  exclusive: false,
  rate: 0.28,
  effectiveFrom: '2026-08-01',
  signedAt: '2026-08-01',
  note: '旧合同迁移时缺失快照，按原签署日期升级回填',
}

const basePackages: IncomingPackage[] = [
  { id: 'PKG-2401', workId: 'W-001', work: '《远山回声》', channel: '星海影院', rights: '院线', territory: '中国大陆', periodStart: '2026-10-18', periodEnd: '2026-11-15', gross: 1280000, receivedAt: '2026-11-20', batchId: 'B-2026Q4' },
  { id: 'PKG-2402', workId: 'W-002', work: '《深港口岸》', channel: '云帆视频', rights: '流媒体', territory: '新加坡', periodStart: '2026-12-01', periodEnd: '2026-12-20', gross: 660000, receivedAt: '2026-12-22', batchId: 'B-2026Q4' },
  { id: 'PKG-2403', workId: 'W-001', work: '《远山回声》', channel: '星海影院', rights: '院线', territory: '中国大陆', periodStart: '2026-11-20', periodEnd: '2026-12-10', gross: 420000, receivedAt: '2026-12-10', batchId: 'B-2026Q4' },
  { id: 'PKG-2404', workId: 'W-001', work: '《远山回声》', channel: '云帆视频', rights: '流媒体', territory: '中国大陆', periodStart: '2026-11-20', periodEnd: '2026-12-31', gross: 980000, receivedAt: '2027-01-05', batchId: 'B-2026Q4' },
  // 两笔同时提交，以包号排队
  { id: 'PKG-2501', workId: 'W-002', work: '《深港口岸》', channel: '海岛航空', rights: '航空', territory: '东南亚区域', periodStart: '2027-01-15', periodEnd: '2027-02-10', gross: 215000, receivedAt: '2027-02-12', batchId: 'B-2027Q1', submittedTogether: true },
  { id: 'PKG-2502', workId: 'W-002', work: '《深港口岸》', channel: '云帆视频', rights: '流媒体', territory: '新加坡', periodStart: '2027-01-01', periodEnd: '2027-02-15', gross: 520000, receivedAt: '2027-02-12', batchId: 'B-2027Q1', submittedTogether: true },
  // 旧数据：批次已关账（历史分成行可查、不重算）
  { id: 'PKG-2399', workId: 'W-003', work: '《北纬63度》', channel: '环球新媒体', rights: '电视', territory: '北美', periodStart: '2026-07-01', periodEnd: '2026-09-30', gross: 390000, receivedAt: '2026-10-05', batchId: 'B-2026Q3' },
  // 旧数据：无授权快照（回填后补核验）
  { id: 'PKG-2407', workId: 'W-003', work: '《北纬63度》', channel: '环球新媒体', rights: '电视', territory: '北美', periodStart: '2026-10-01', periodEnd: '2026-11-30', gross: 380000, receivedAt: '2026-12-08', batchId: 'B-2026Q4' },
]

/** 已关账批次里的历史分成行（始终可查、不参与重算） */
export const historicalLines: ShareLine[] = [
  {
    id: 'SL-PKG-2399',
    packageId: 'PKG-2399',
    windowId: 'RW-401',
    snapshotId: 'S401-v1',
    snapshotVersion: 1,
    workId: 'W-003',
    work: '《北纬63度》',
    channel: '环球新媒体',
    territory: '北美',
    batchId: 'B-2026Q3',
    periodStart: '2026-07-01',
    periodEnd: '2026-09-30',
    gross: 390000,
    eligible: 390000,
    rate: 0.28,
    share: 109200,
    status: '历史',
    sources: ['历史回填'],
    note: 'Q3 已关账：旧数据按原签署日期 2026-08-01 回填后入账，仅供查询，不再重算',
    bookedAt: '2026-10-08T03:00:00.000Z',
  },
]

/**
 * 初始场景：队列处理到 PKG-2403（过期窗口）即阻断，
 * PKG-2404、两笔同时提交、旧数据全部留在队列中待演示。
 */
export function buildInitialState(): ReconcileState {
  const queued = enqueue(
    {
      snapshots: initialSnapshots,
      batches: settlementBatches,
      packages: [],
      shares: historicalLines,
      checkpoint: null,
      failure: null,
      logs: [{ time: new Date().toISOString(), level: 'info', event: '核验台就绪', detail: '授权窗口、代理回传与结算批次已接入同一核验；窗口变更仅重算受影响分成行。' }],
    },
    basePackages,
  )
  return processQueue(queued)
}
