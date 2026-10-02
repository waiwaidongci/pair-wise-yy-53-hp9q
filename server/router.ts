import { initTRPC } from '@trpc/server'
import { z } from 'zod'
import { initialComments, initialWindows } from '@/lib/mock-data'
import { findConflicts } from '@/lib/rules'
import { buildInitialState } from '@/lib/settlement/seed'
import { snapshotAt, evaluateWindow, reasonText } from '@/lib/settlement/engine'

const t = initTRPC.create()
const windowInput = z.object({
  channel: z.string().min(2),
  start: z.string().date(),
  end: z.string().date(),
  exclusive: z.boolean(),
})

const receiptInput = z.object({
  workId: z.string().min(1),
  channel: z.string().min(2),
  territory: z.string().min(2),
  rights: z.string(),
  periodStart: z.string().date(),
  periodEnd: z.string().date(),
  gross: z.number().nonnegative(),
  receivedAt: z.string().date(),
  batchId: z.string().min(1),
})

export const appRouter = t.router({
  catalog: t.procedure.query(() => ({ works: ['W-001', 'W-002', 'W-003'], channels: ['星海影院', '云帆视频', '南华卫视', '海岛航空', '环球新媒体'] })),
  windows: t.procedure.query(() => initialWindows),
  conflicts: t.procedure.query(() => findConflicts(initialWindows)),
  validateWindow: t.procedure.input(windowInput).mutation(({ input }) => {
    if (new Date(input.end) < new Date(input.start)) return { valid: false, message: '窗口结束日期不能早于开始日期。' }
    const collision = initialWindows.find((item) => item.channel === input.channel && input.start <= item.end && item.start <= input.end)
    return collision ? { valid: false, message: `与现有窗口 ${collision.id} 重叠，请调整窗口或明确优先级。` } : { valid: true, message: '窗口结构校验通过。' }
  }),
  comments: t.procedure.query(() => initialComments),
  /** 结算核验总览：初始队列、检查点、待核验包号与阻断原因 */
  settlementOverview: t.procedure.query(() => {
    const state = buildInitialState()
    return {
      checkpoint: state.checkpoint,
      batches: state.batches,
      snapshots: state.snapshots,
      packages: state.packages.map((p) => ({
        id: p.id,
        seq: p.seq,
        workId: p.workId,
        channel: p.channel,
        territory: p.territory,
        rights: p.rights,
        gross: p.gross,
        receivedAt: p.receivedAt,
        batchId: p.batchId,
        status: p.status,
        blockReason: p.blockReason ? reasonText[p.blockReason] : undefined,
        blockDetail: p.blockDetail,
      })),
      shares: state.shares,
    }
  }),
  /** 单笔回传试核验：按作品/地区/渠道匹配到达时有效的授权快照 */
  verifyReceipt: t.procedure.input(receiptInput).mutation(({ input }) => {
    const state = buildInitialState()
    const batch = state.batches.find((b) => b.id === input.batchId)
    if (!batch) return { valid: false, message: `结算批次 ${input.batchId} 不存在。` }
    if (batch.status === '已关账') return { valid: false, message: `批次 ${batch.name} 已关账，不能再计入分成。` }
    const snap = snapshotAt(state.snapshots, { workId: input.workId, territory: input.territory, channel: input.channel }, input.receivedAt)
    if (!snap) return { valid: false, message: `回传到达日 ${input.receivedAt} 无匹配的有效授权快照，旧数据需按原签署日期回填。` }
    const eligibility = evaluateWindow(input, snap, input.receivedAt)
    if (eligibility.reason) return { valid: false, message: eligibility.detail ?? reasonText[eligibility.reason] }
    const share = Math.round(eligibility.eligible * snap.rate * 100) / 100
    return { valid: true, message: `通过核验：快照 v${snap.version}，窗内 ${eligibility.daysIn}/${eligibility.daysTotal} 天，可计提 ¥${eligibility.eligible}，分成 ¥${share}。`, snapshot: snap.id, eligible: eligibility.eligible, share }
  }),
})

export type AppRouter = typeof appRouter
