import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { IncomingPackage, LicenseSnapshot, ReconcileState } from '@/lib/settlement/types'
import {
  applyWindowChange,
  backfillSnapshot,
  decideHeldVersion,
  enqueue,
  handleRepost,
  processQueue,
  recover,
  retryPackage,
} from '@/lib/settlement/engine'
import { buildInitialState } from '@/lib/settlement/seed'

interface SettlementStore extends ReconcileState {
  /** 接收新回传并入账：默认遇阻断即停；onlyNew 时只处理本次入队的包 */
  ingest: (incoming: IncomingPackage[], options?: { onlyNew?: boolean; continueAfterBlock?: boolean; failAt?: string; failDetail?: string }) => void
  /** 处理队列中已有的待处理包 */
  process: (options?: { continueAfterBlock?: boolean }) => void
  /** 同包号再次回传：内容一致忽略，不一致留待核验 */
  repost: (incoming: IncomingPackage) => void
  /** 裁定后到版本 */
  resolveHeld: (packageId: string, accept: boolean) => void
  /** 授权窗口变更：只重算受影响分成行 */
  windowChanged: (snapshot: LicenseSnapshot) => void
  /** 旧数据按原签署日期回填授权快照 */
  backfill: (snapshot: LicenseSnapshot) => void
  /** 阻断解除后重试单个包 */
  retry: (packageId: string) => void
  /** 从已确认包号（检查点）恢复，不重复入账 */
  resume: () => void
  reset: () => void
}

export const useSettlementStore = create<SettlementStore>()(
  persist(
    (set) => ({
      ...buildInitialState(),

      ingest: (incoming, options) => set((state) => {
        const queued = enqueue(state, incoming)
        const newIds = incoming.map((p) => p.id)
        return processQueue(queued, {
          continueAfterBlock: options?.continueAfterBlock,
          failAt: options?.failAt,
          failDetail: options?.failDetail,
          onlyPackageIds: options?.onlyNew ? newIds : undefined,
        })
      }),

      process: (options) => set((state) => processQueue(state, { continueAfterBlock: options?.continueAfterBlock })),

      repost: (incoming) => set((state) => {
        if (!state.packages.some((p) => p.id === incoming.id)) {
          return enqueue(state, [incoming])
        }
        return handleRepost(state, incoming)
      }),

      resolveHeld: (packageId, accept) => set((state) => decideHeldVersion(state, packageId, accept)),

      windowChanged: (snapshot) => set((state) => applyWindowChange(state, snapshot)),

      backfill: (snapshot) => set((state) => backfillSnapshot(state, snapshot)),

      retry: (packageId) => set((state) => retryPackage(state, packageId)),

      resume: () => set((state) => recover(state)),

      reset: () => set({ ...buildInitialState() }),
    }),
    { name: 'yy53-settlement-reconcile-v1', version: 1 },
  ),
)
