import type { AuthSnapshot, LicenseWindow, MatchStatus, ReturnLine, ReturnPackage, SettlementBatch } from './types'

/**
 * 实收核验引擎：把授权快照、代理回传与结算批次接到同一核验里。
 * 纯函数，无副作用；store 与 tRPC 共用同一套核验逻辑。
 */

export interface PackageVerdict {
  status: ReturnPackage['status']
  blockingReason: string | null
  lines: ReturnLine[]
}

export interface BatchTotals {
  packageCount: number
  lineCount: number
  totalGross: number
  totalShare: number
  blockedAmount: number
  pendingCount: number
  recordedCount: number
}

const shareRateByRights: Record<string, number> = {
  院线: 0.4,
  电视: 0.3,
  流媒体: 0.5,
  航空: 0.2,
  非院线: 0.35,
}

export function rateFor(rights: string): number {
  return shareRateByRights[rights] ?? 0.3
}

function overlaps(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
  return new Date(aStart) <= new Date(bEnd) && new Date(bStart) <= new Date(aEnd)
}

/** 按作品、地区、渠道匹配有效授权快照，并校验收入期间是否落在窗口内 */
export function matchSnapshot(
  line: ReturnLine,
  snapshots: AuthSnapshot[],
): { snapshot: AuthSnapshot | null; status: MatchStatus; reason: string | null } {
  const candidates = snapshots
    .filter((s) => s.workId === line.workId && s.channel === line.channel && s.territory === line.territory)
    .sort((a, b) => b.version - a.version)
  if (candidates.length === 0) {
    return { snapshot: null, status: 'no-auth', reason: `无「${line.channel}」在「${line.territory}」的有效授权快照，该笔收入无授权依据` }
  }
  // 回传时点快照尚未建立：属旧数据，待按原签署日期升级回填
  const valid = candidates.filter((s) => s.validFrom <= line.periodStart)
  if (valid.length === 0) {
    return { snapshot: null, status: 'legacy', reason: `回传时点（${line.periodStart}）授权快照尚未建立，待按原签署日期升级回填` }
  }
  const current = valid.find((s) => s.validTo === null) ?? valid[0]!
  if (line.periodStart > current.end) {
    return { snapshot: current, status: 'expired', reason: `授权窗口已于 ${current.end} 结束，回传收入期间自 ${line.periodStart} 起超出窗口，属过期窗口收入，不得计入分成` }
  }
  if (line.periodEnd < current.start) {
    return { snapshot: current, status: 'not-open', reason: `回传收入期间早于授权窗口开始日 ${current.start}，窗口尚未开启` }
  }
  const exclusiveConflict = snapshots.find(
    (s) =>
      s.workId === line.workId &&
      s.territory === line.territory &&
      s.rights === current.rights &&
      s.id !== current.id &&
      s.exclusive &&
      s.validTo === null &&
      overlaps(s.start, s.end, line.periodStart, line.periodEnd),
  )
  if (exclusiveConflict && !current.exclusive) {
    return { snapshot: current, status: 'exclusive-conflict', reason: `「${exclusiveConflict.channel}」在「${line.territory}」持有「${current.rights}」独占窗口（${exclusiveConflict.start} ~ ${exclusiveConflict.end}）并覆盖同一收入期间，${line.channel} 非独占授权不得计入分成` }
  }
  return { snapshot: current, status: 'matched', reason: null }
}

/** 核验单条回传行：匹配快照、计算分成、标注差异来源与阻断原因 */
export function verifyLine(line: ReturnLine, snapshots: AuthSnapshot[]): ReturnLine {
  const { snapshot, status, reason } = matchSnapshot(line, snapshots)
  const blocked = status === 'no-auth' || status === 'expired' || status === 'not-open' || status === 'exclusive-conflict'
  const matched = status === 'matched'
  const legacy = status === 'legacy'
  return {
    ...line,
    snapshotId: snapshot?.id ?? null,
    snapshotVersion: snapshot?.version ?? null,
    matchStatus: status,
    diffReason: reason,
    shareRate: matched ? snapshot!.shareRate : null,
    shareAmount: matched ? Math.round(line.gross * snapshot!.shareRate) : null,
    status: blocked ? '已阻断' : legacy ? '待核验' : '已入账',
    blockingReason: blocked ? reason : null,
  }
}

/**
 * 核验整个回传包：
 * - 重复包号只入账一次（seenPackageNos 去重）
 * - 后到的版本冲突（refVersion 落后于当前快照版本）先留待核验
 */
export function verifyPackage(
  pkg: ReturnPackage,
  lines: ReturnLine[],
  snapshots: AuthSnapshot[],
  seenPackageNos: Set<string>,
): PackageVerdict {
  if (seenPackageNos.has(pkg.packageNo)) {
    const reason = `重复包号：${pkg.packageNo} 已入账，重复回传只入账一次，本次不重复记录`
    return {
      status: '已阻断',
      blockingReason: reason,
      lines: lines.map((l) => ({ ...l, status: '已阻断', blockingReason: reason, shareAmount: null, shareRate: null })),
    }
  }
  const current = snapshots.filter((s) => s.validTo === null)
  const stale = lines.find((l) => {
    const snap = current.find((s) => s.workId === l.workId && s.channel === l.channel && s.territory === l.territory)
    return snap && pkg.refVersion != null && snap.version > pkg.refVersion
  })
  if (stale) {
    const snap = current.find((s) => s.workId === stale.workId && s.channel === stale.channel && s.territory === stale.territory)!
    const reason = `版本冲突：回传依据快照 v${pkg.refVersion}，当前有效快照为 v${snap.version}（${snap.id}），后到包留待核验`
    const verified = lines.map((l) => verifyLine(l, snapshots))
    return {
      status: '待核验',
      blockingReason: reason,
      lines: verified.map((l) => ({ ...l, status: '待核验', blockingReason: `快照版本 v${pkg.refVersion} 已被 v${snap.version} 取代，留待核验`, shareAmount: null, shareRate: null })),
    }
  }
  const verified = lines.map((l) => verifyLine(l, snapshots))
  const blocked = verified.filter((l) => l.status === '已阻断')
  if (blocked.length > 0) {
    const sources = Array.from(new Set(blocked.map((l) => l.matchStatus))).join('、')
    return { status: '已阻断', blockingReason: `${blocked.length} 行收入存在授权差异（${sources}），已阻断分成计入`, lines: verified }
  }
  const pending = verified.filter((l) => l.status === '待核验')
  if (pending.length > 0) {
    return { status: '待核验', blockingReason: `${pending.length} 行旧数据无授权快照，待按原签署日期升级回填`, lines: verified }
  }
  return { status: '已入账', blockingReason: null, lines: verified }
}

/**
 * 窗口变更后只重算受影响的分成行：
 * 仅重算已入账且匹配快照属于该窗口的行，其他代理人的行原样返回（引用不变）。
 * 待核验/已阻断的行不是分成行，不在此重算。
 */
export function recalcAffected(lines: ReturnLine[], snapshots: AuthSnapshot[], changedWindowId: string): ReturnLine[] {
  return lines.map((line) => {
    const snap = line.snapshotId ? snapshots.find((s) => s.id === line.snapshotId) : null
    if (!snap || snap.windowId !== changedWindowId) return line
    if (line.status !== '已入账') return line
    const verified = verifyLine(line, snapshots)
    if (verified.status === '已入账' && verified.snapshotVersion != null) {
      return { ...verified, diffReason: `窗口变更后重新核验，已按新快照 v${verified.snapshotVersion} 重算分成` }
    }
    return verified
  })
}

/**
 * 旧数据没有授权快照时，按原签署日期升级回填：
 * 以签署日确定的窗口条款合成回填快照，历史分成仍可查。
 * 选择覆盖回传收入期间的窗口；若多个窗口匹配，取签署日最新的一个。
 */
export function backfillLine(
  line: ReturnLine,
  windows: LicenseWindow[],
  snapshots: AuthSnapshot[],
): { line: ReturnLine; snapshot: AuthSnapshot } | null {
  if (line.snapshotId || line.backfilled) return null
  // 只回填旧数据（回传时点快照尚未建立）；无授权、版本冲突的行不在此回填
  if (line.matchStatus !== 'legacy') return null
  const matches = windows
    .filter((w) => w.workId === line.workId && w.channel === line.channel && w.territory === line.territory)
    .sort((a, b) => b.signedDate.localeCompare(a.signedDate))
  if (matches.length === 0) return null
  const covering = matches.find((w) => w.start <= line.periodStart && line.periodStart <= w.end)
  const win = covering ?? matches[0]!
  const id = `SNAP-BF-${win.id}`
  const existing = snapshots.find((s) => s.id === id)
  const snapshot: AuthSnapshot =
    existing ??
    {
      id,
      windowId: win.id,
      workId: win.workId,
      work: win.work,
      channel: win.channel,
      rights: win.rights,
      territory: win.territory,
      start: win.start,
      end: win.end,
      exclusive: win.exclusive,
      sublicense: win.sublicense,
      priority: win.priority,
      signedDate: win.signedDate,
      version: 1,
      validFrom: win.signedDate,
      validTo: null,
      origin: 'backfill',
      shareRate: rateFor(win.rights),
    }
  const verified = verifyLine({ ...line, snapshotId: snapshot.id, snapshotVersion: 1 }, [...snapshots, snapshot])
  return {
    snapshot,
    line: { ...verified, matchStatus: 'backfilled', diffReason: `按原签署日期 ${win.signedDate} 升级回填授权快照 ${snapshot.id}`, backfilled: true },
  }
}

/** 结算批次合计：只统计已入账分成，阻断金额单列，不计入应付 */
export function batchTotals(batch: SettlementBatch, packages: ReturnPackage[], lines: ReturnLine[]): BatchTotals {
  const pkgs = packages.filter((p) => batch.packageNos.includes(p.packageNo))
  const pkgNos = new Set(pkgs.map((p) => p.packageNo))
  const batchLines = lines.filter((l) => pkgNos.has(l.packageNo))
  const recorded = batchLines.filter((l) => l.status === '已入账')
  const blocked = batchLines.filter((l) => l.status === '已阻断')
  return {
    packageCount: pkgs.length,
    lineCount: batchLines.length,
    totalGross: batchLines.reduce((sum, l) => sum + l.gross, 0),
    totalShare: recorded.reduce((sum, l) => sum + (l.shareAmount ?? 0), 0),
    blockedAmount: blocked.reduce((sum, l) => sum + l.gross, 0),
    pendingCount: pkgs.filter((p) => p.status === '待核验').length,
    recordedCount: pkgs.filter((p) => p.status === '已入账').length,
  }
}

/** 待核验包号：状态为待核验的包，含阻断原因 */
export function pendingPackages(packages: ReturnPackage[]): ReturnPackage[] {
  return packages.filter((p) => p.status === '待核验')
}

/** 差异来源汇总：按匹配状态统计被阻断/待核验的行 */
export function diffSources(lines: ReturnLine[]): { status: MatchStatus; count: number; amount: number; reasons: string[] }[] {
  const map = new Map<MatchStatus, { count: number; amount: number; reasons: Set<string> }>()
  for (const line of lines) {
    if (line.status === '已入账' || !line.diffReason) continue
    const entry = map.get(line.matchStatus) ?? { count: 0, amount: 0, reasons: new Set<string>() }
    entry.count += 1
    entry.amount += line.gross
    entry.reasons.add(line.diffReason)
    map.set(line.matchStatus, entry)
  }
  return Array.from(map.entries())
    .map(([status, v]) => ({ status, count: v.count, amount: v.amount, reasons: Array.from(v.reasons) }))
    .sort((a, b) => b.count - a.count)
}
