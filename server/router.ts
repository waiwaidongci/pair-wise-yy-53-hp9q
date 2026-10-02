import { initTRPC } from '@trpc/server'
import { z } from 'zod'
import { initialComments, initialWindows } from '@/lib/mock-data'
import { findConflicts } from '@/lib/rules'
import { initialBatches, verifiedLines, verifiedPackages, initialSnapshots } from '@/lib/settlement-data'
import { batchTotals, diffSources, pendingPackages, verifyPackage } from '@/lib/settlement'
import type { ReturnLine, ReturnPackage } from '@/lib/types'

const t = initTRPC.create()
const windowInput = z.object({
  channel: z.string().min(2),
  start: z.string().date(),
  end: z.string().date(),
  exclusive: z.boolean(),
})

const returnLineInput = z.object({
  id: z.string(),
  packageNo: z.string(),
  agent: z.string(),
  workId: z.string(),
  work: z.string(),
  channel: z.string(),
  territory: z.string(),
  periodStart: z.string(),
  periodEnd: z.string(),
  gross: z.number(),
  currency: z.string(),
  snapshotId: z.string().nullable(),
  snapshotVersion: z.number().nullable(),
  matchStatus: z.string(),
  diffReason: z.string().nullable(),
  shareRate: z.number().nullable(),
  shareAmount: z.number().nullable(),
  status: z.string(),
  blockingReason: z.string().nullable(),
  batchId: z.string().nullable(),
  backfilled: z.boolean(),
})

const returnPackageInput = z.object({
  packageNo: z.string(),
  agent: z.string(),
  region: z.string(),
  submittedAt: z.string(),
  queuedAt: z.string(),
  status: z.string(),
  lineIds: z.array(z.string()),
  batchId: z.string().nullable(),
  refVersion: z.number().nullable(),
  blockingReason: z.string().nullable(),
  confirmedAt: z.string().nullable(),
})

export const appRouter = t.router({
  catalog: t.procedure.query(() => ({ works: ['W-001', 'W-002'], channels: ['星海影院', '云帆视频', '南华卫视', '海岛航空', '环球新媒体'] })),
  windows: t.procedure.query(() => initialWindows),
  conflicts: t.procedure.query(() => findConflicts(initialWindows)),
  validateWindow: t.procedure.input(windowInput).mutation(({ input }) => {
    if (new Date(input.end) < new Date(input.start)) return { valid: false, message: '窗口结束日期不能早于开始日期。' }
    const collision = initialWindows.find((item) => item.channel === input.channel && input.start <= item.end && item.start <= input.end)
    return collision ? { valid: false, message: `与现有窗口 ${collision.id} 重叠，请调整窗口或明确优先级。` } : { valid: true, message: '窗口结构校验通过。' }
  }),
  comments: t.procedure.query(() => initialComments),

  settlement: t.router({
    overview: t.procedure.query(() => {
      const recorded = verifiedLines.filter((l) => l.status === '已入账')
      const blocked = verifiedLines.filter((l) => l.status === '已阻断')
      return {
        packageCount: verifiedPackages.length,
        pendingCount: pendingPackages(verifiedPackages).length,
        blockedCount: verifiedPackages.filter((p) => p.status === '已阻断').length,
        recordedShare: recorded.reduce((sum, l) => sum + (l.shareAmount ?? 0), 0),
        blockedAmount: blocked.reduce((sum, l) => sum + l.gross, 0),
        diffSources: diffSources(verifiedLines),
      }
    }),
    batches: t.procedure.query(() =>
      initialBatches.map((batch) => ({ ...batch, totals: batchTotals(batch, verifiedPackages, verifiedLines) })),
    ),
    packages: t.procedure.query(() => verifiedPackages),
    verify: t.procedure
      .input(z.object({ pkg: returnPackageInput, lines: z.array(returnLineInput), seen: z.array(z.string()) }))
      .mutation(({ input }) =>
        verifyPackage(input.pkg as ReturnPackage, input.lines as ReturnLine[], initialSnapshots, new Set(input.seen)),
      ),
  }),
})

export type AppRouter = typeof appRouter
