import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { AuthSnapshot, ReturnLine, ReturnPackage, SettlementBatch } from '@/lib/types'
import { initialWindows } from '@/lib/mock-data'
import { initialBatches, verifiedLines, verifiedPackages, initialSnapshots } from '@/lib/settlement-data'
import { backfillLine, recalcAffected, verifyPackage } from '@/lib/settlement'

interface NewReturnInput {
  agent: string
  region: string
  refVersion: number | null
  lines: Array<{ workId: string; work: string; channel: string; territory: ReturnLine['territory']; periodStart: string; periodEnd: string; gross: number }>
}

interface SettlementState {
  windows: typeof initialWindows
  snapshots: AuthSnapshot[]
  packages: ReturnPackage[]
  lines: ReturnLine[]
  batches: SettlementBatch[]
  queue: string[]
  /** 已确认包号高水位线：恢复处理时从该包号之后继续 */
  confirmedPackageNo: string | null
  processing: boolean
  lastError: string | null
  submitReturn: (input: NewReturnInput, packageNo?: string) => string
  processQueue: () => void
  resumeProcessing: () => void
  verifyPackage: (packageNo: string) => void
  simulateFailure: (packageNo: string) => void
  applyWindowChange: (windowId: string, patch: Partial<AuthSnapshot>) => void
  backfillLegacy: () => void
  confirmBatch: (batchId: string) => void
  reset: () => void
}

function nextPackageNo(packages: ReturnPackage[]): string {
  const nums = packages
    .map((p) => Number(p.packageNo.replace(/^PKG-2026-/, '')))
    .filter((n) => Number.isFinite(n))
  const next = (nums.length ? Math.max(...nums) : 0) + 1
  return `PKG-2026-${String(next).padStart(3, '0')}`
}

function nowIso(): string {
  return new Date().toISOString()
}

/** 把核验结论落回包与行（按 id 原地更新，绝不追加，保证幂等不重复记账） */
function applyVerdict(
  packages: ReturnPackage[],
  lines: ReturnLine[],
  packageNo: string,
  verdict: { status: ReturnPackage['status']; blockingReason: string | null; lines: ReturnLine[] },
): { packages: ReturnPackage[]; lines: ReturnLine[] } {
  return {
    packages: packages.map((p) =>
      p.packageNo === packageNo
        ? { ...p, status: verdict.status, blockingReason: verdict.blockingReason, confirmedAt: verdict.status === '已入账' ? nowIso() : null }
        : p,
    ),
    lines: lines.map((l) => {
      const v = verdict.lines.find((vl) => vl.id === l.id)
      return v ?? l
    }),
  }
}

export const useSettlementStore = create<SettlementState>()(
  persist(
    (set, get) => ({
      windows: initialWindows,
      snapshots: initialSnapshots,
      packages: verifiedPackages,
      lines: verifiedLines,
      batches: initialBatches,
      queue: verifiedPackages.map((p) => p.packageNo),
      confirmedPackageNo: verifiedPackages.filter((p) => p.status === '已入账').map((p) => p.packageNo).sort().pop() ?? null,
      processing: false,
      lastError: null,

      submitReturn: (input, forcedPackageNo) => {
        const state = get()
        const packageNo = forcedPackageNo ?? nextPackageNo(state.packages)
        // 重复包号：只入账一次，重复提交直接阻断
        if (state.packages.some((p) => p.packageNo === packageNo)) {
          const dupReason = `重复包号：${packageNo} 已入账，重复回传只入账一次，本次不重复记录`
          const pkg: ReturnPackage = {
            packageNo,
            agent: input.agent,
            region: input.region,
            submittedAt: nowIso(),
            queuedAt: nowIso(),
            status: '已阻断',
            lineIds: [],
            batchId: null,
            refVersion: input.refVersion,
            blockingReason: dupReason,
            confirmedAt: null,
          }
          set((s) => ({ packages: [...s.packages, pkg], lastError: null }))
          return packageNo
        }
        const baseLines: ReturnLine[] = input.lines.map((l, i) => ({
          id: `${packageNo}-L${i + 1}`,
          packageNo,
          agent: input.agent,
          workId: l.workId,
          work: l.work,
          channel: l.channel,
          territory: l.territory,
          periodStart: l.periodStart,
          periodEnd: l.periodEnd,
          gross: l.gross,
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
        const pkg: ReturnPackage = {
          packageNo,
          agent: input.agent,
          region: input.region,
          submittedAt: nowIso(),
          queuedAt: nowIso(),
          status: '排队中',
          lineIds: baseLines.map((l) => l.id),
          batchId: null,
          refVersion: input.refVersion,
          blockingReason: null,
          confirmedAt: null,
        }
        set((s) => ({
          packages: [...s.packages, pkg],
          lines: [...s.lines, ...baseLines],
          queue: [...s.queue, packageNo],
          lastError: null,
        }))
        get().processQueue()
        return packageNo
      },

      processQueue: () => {
        set({ processing: true, lastError: null })
        const state = get()
        const sorted = [...state.queue].sort((a, b) => a.localeCompare(b, 'zh'))
        let packages = [...state.packages]
        let lines = [...state.lines]
        let confirmed = state.confirmedPackageNo
        let lastError: string | null = null
        for (const no of sorted) {
          const pkg = packages.find((p) => p.packageNo === no)
          if (!pkg) continue
          if (pkg.status === '已入账') {
            if (confirmed == null || no > confirmed) confirmed = no
            continue
          }
          if (pkg.status === '已阻断' || pkg.status === '待核验') continue
          if (pkg.status === '处理失败') {
            lastError = `包号 ${no} 处理失败，队列已暂停；请从已确认包号 ${confirmed ?? '—'} 恢复处理`
            break
          }
          // 排队中：按包号顺序核验
          const seen = new Set(packages.filter((p) => p.status === '已入账').map((p) => p.packageNo))
          const verdict = verifyPackage(pkg, lines.filter((l) => l.packageNo === no), state.snapshots, seen)
          const applied = applyVerdict(packages, lines, no, verdict)
          packages = applied.packages
          lines = applied.lines
          if (verdict.status === '已入账') confirmed = no
        }
        set({ packages, lines, confirmedPackageNo: confirmed, lastError, processing: false })
      },

      resumeProcessing: () => {
        set({ processing: true, lastError: null })
        const state = get()
        const sorted = [...state.queue].sort((a, b) => a.localeCompare(b, 'zh'))
        let packages = [...state.packages]
        let lines = [...state.lines]
        let confirmed = state.confirmedPackageNo
        let resumed = 0
        for (const no of sorted) {
          // 从已确认包号之后继续，已确认的不重复处理
          if (confirmed != null && no <= confirmed) continue
          const pkg = packages.find((p) => p.packageNo === no)
          if (!pkg) continue
          if (pkg.status === '已入账') {
            confirmed = no
            continue
          }
          if (pkg.status === '待核验') continue // 留待核验，不自动通过
          const seen = new Set(packages.filter((p) => p.status === '已入账').map((p) => p.packageNo))
          const verdict = verifyPackage(pkg, lines.filter((l) => l.packageNo === no), state.snapshots, seen)
          const applied = applyVerdict(packages, lines, no, verdict)
          packages = applied.packages
          lines = applied.lines
          if (verdict.status === '已入账') {
            confirmed = no
            resumed += 1
          }
        }
        set({
          packages,
          lines,
          confirmedPackageNo: confirmed,
          lastError: null,
          processing: false,
        })
        return resumed
      },

      verifyPackage: (packageNo) => {
        const state = get()
        const pkg = state.packages.find((p) => p.packageNo === packageNo)
        if (!pkg) return
        const seen = new Set(state.packages.filter((p) => p.status === '已入账').map((p) => p.packageNo))
        const verdict = verifyPackage(pkg, state.lines.filter((l) => l.packageNo === packageNo), state.snapshots, seen)
        const applied = applyVerdict(state.packages, state.lines, packageNo, verdict)
        set({ packages: applied.packages, lines: applied.lines, lastError: verdict.status === '已入账' ? null : state.lastError })
      },

      simulateFailure: (packageNo) =>
        set((s) => ({
          packages: s.packages.map((p) => (p.packageNo === packageNo ? { ...p, status: '处理失败', confirmedAt: null } : p)),
          lastError: `包号 ${packageNo} 处理失败，队列已暂停；请从已确认包号 ${s.confirmedPackageNo ?? '—'} 恢复处理`,
        })),

      applyWindowChange: (windowId, patch) => {
        const state = get()
        const win = state.windows.find((w) => w.id === windowId)
        if (!win) return
        const current = state.snapshots
          .filter((s) => s.windowId === windowId && s.validTo === null)
          .sort((a, b) => b.version - a.version)[0]
        if (!current) return
        const today = nowIso().slice(0, 10)
        const next: AuthSnapshot = {
          ...current,
          id: `SNAP-${windowId}-v${current.version + 1}`,
          version: current.version + 1,
          validFrom: today,
          validTo: null,
          ...patch,
        }
        const snapshots = state.snapshots
          .map((s) => (s.windowId === windowId && s.validTo === null ? { ...s, validTo: today } : s))
          .concat(next)
        // 只重算受影响的分成行，其他代理人照旧
        const lines = recalcAffected(state.lines, snapshots, windowId)
        set({ snapshots, lines })
      },

      backfillLegacy: () => {
        const state = get()
        const created: AuthSnapshot[] = []
        const lines = state.lines.map((line) => {
          if (line.snapshotId || line.backfilled) return line
          const result = backfillLine(line, state.windows, [...state.snapshots, ...created])
          if (!result) return line
          if (!created.some((s) => s.id === result.snapshot.id) && !state.snapshots.some((s) => s.id === result.snapshot.id)) {
            created.push(result.snapshot)
          }
          return result.line
        })
        if (created.length === 0) return
        set({ snapshots: [...state.snapshots, ...created], lines })
      },

      confirmBatch: (batchId) =>
        set((s) => {
          const batch = s.batches.find((b) => b.id === batchId)
          if (!batch) return {}
          const pkgs = s.packages.filter((p) => batch.packageNos.includes(p.packageNo))
          const hasHold = pkgs.some((p) => p.status === '待核验' || p.status === '已阻断' || p.status === '处理失败')
          return { batches: s.batches.map((b) => (b.id === batchId ? { ...b, status: hasHold ? '待核验' : '已确认' } : b)) }
        }),

      reset: () =>
        set({
          windows: initialWindows,
          snapshots: initialSnapshots,
          packages: verifiedPackages,
          lines: verifiedLines,
          batches: initialBatches,
          queue: verifiedPackages.map((p) => p.packageNo),
          confirmedPackageNo: verifiedPackages.filter((p) => p.status === '已入账').map((p) => p.packageNo).sort().pop() ?? null,
          processing: false,
          lastError: null,
        }),
    }),
    { name: 'yy53-settlement-v1', version: 1 },
  ),
)

// 首次加载（未持久化）时对初始回传包按包号排队核验一次；持久化后不重复执行
if (typeof window !== 'undefined') {
  const state = useSettlementStore.getState()
  if (state.confirmedPackageNo === null && state.packages.some((p) => p.status === '排队中')) {
    state.processQueue()
  }
}
