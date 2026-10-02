import type {
  AgentPackage,
  BlockReason,
  DiscrepancySource,
  IncomingPackage,
  LicenseSnapshot,
  ReconcileLog,
  ReconcileState,
  ShareLine,
} from './types'

/** 内容指纹：同包号不同内容 => 后到版本冲突 */
export function fingerprintOf(p: Omit<IncomingPackage, 'id'>): string {
  return [p.workId, p.channel, p.rights, p.territory, p.periodStart, p.periodEnd, p.batchId, (Math.round(p.gross * 100) / 100).toString()].join('|')
}

/** 回传到达时按作品 + 地区 + 渠道匹配当时有效的授权快照（含回填快照） */
export function snapshotAt(
  snapshots: LicenseSnapshot[],
  key: { workId: string; territory: string; channel: string },
  at: string,
): LicenseSnapshot | undefined {
  const atTime = new Date(at).getTime()
  return snapshots
    .filter(
      (s) => s.workId === key.workId && s.territory === key.territory && s.channel === key.channel,
    )
    // 仅取到达日已生效的快照版本，再按版本生效日取最新一版
    .filter((s) => new Date(s.effectiveFrom).getTime() <= atTime)
    .sort((a, b) => new Date(b.effectiveFrom).getTime() - new Date(a.effectiveFrom).getTime())[0]
}

export interface EligibilityResult {
  eligible: number
  daysIn: number
  daysTotal: number
  windowActive: boolean
  beforeWindow: boolean
  reason?: BlockReason
  detail?: string
}

type WindowCheckInput = {
  periodStart: string
  periodEnd: string
  gross: number
  receivedAt: string
}

/** 收入期与授权窗口按天折算；到达时窗口未生效或已过期直接阻断 */
export function evaluateWindow(p: WindowCheckInput, snap: LicenseSnapshot, at: string): EligibilityResult {
  const atTime = new Date(at).getTime()
  const winStart = new Date(snap.start).getTime()
  const winEnd = new Date(snap.end).getTime()
  const DAY = 86400000
  if (atTime < winStart) {
    return { eligible: 0, daysIn: 0, daysTotal: 0, windowActive: false, beforeWindow: true, reason: 'WINDOW_NOT_STARTED', detail: `回传到达日 ${p.receivedAt} 早于授权窗口生效日 ${snap.start}` }
  }
  if (atTime > winEnd + DAY - 1) {
    return { eligible: 0, daysIn: 0, daysTotal: 0, windowActive: false, beforeWindow: false, reason: 'WINDOW_EXPIRED', detail: `授权窗口 ${snap.start} → ${snap.end} 已于回传到达前过期，过期窗口收入不得计入分成` }
  }
  const periodStart = Math.max(new Date(p.periodStart).getTime(), winStart)
  const periodEnd = Math.min(new Date(p.periodEnd).getTime(), winEnd)
  const daysTotal = Math.max(1, Math.round((new Date(p.periodEnd).getTime() - new Date(p.periodStart).getTime()) / DAY) + 1)
  const daysIn = periodEnd < periodStart ? 0 : Math.round((periodEnd - periodStart) / DAY) + 1
  if (daysIn === 0) {
    return { eligible: 0, daysIn, daysTotal, windowActive: true, beforeWindow: false, reason: 'PERIOD_OUTSIDE', detail: `收入期 ${p.periodStart} → ${p.periodEnd} 全部落在窗口 ${snap.start} → ${snap.end} 之外` }
  }
  return { eligible: Math.round((p.gross * daysIn) / daysTotal * 100) / 100, daysIn, daysTotal, windowActive: true, beforeWindow: false }
}

function log(level: ReconcileLog['level'], event: string, detail: string): ReconcileLog {
  return { time: new Date().toISOString(), level, event, detail }
}

/** 两笔同时提交时以包号排队（同批字典序定先后），重复包号只入账一次 */
export function enqueue(state: ReconcileState, incoming: IncomingPackage[]): ReconcileState {
  const existing = new Set(state.packages.map((p) => p.id))
  // 非同时提交严格按到达顺序；同批同时提交的一组内部按包号排序
  const ordered: IncomingPackage[] = []
  for (let i = 0; i < incoming.length; i += 1) {
    const group = [incoming[i]!]
    while (i + 1 < incoming.length && (incoming[i + 1]!.submittedTogether || incoming.length > 1) && incoming[i]!.submittedTogether) {
      i += 1
      group.push(incoming[i]!)
    }
    if (group.length > 1) group.sort((a, b) => a.id.localeCompare(b.id, 'zh-Hans-CN'))
    ordered.push(...group)
  }
  let seq = state.packages.reduce((max, p) => Math.max(max, p.seq), 0)
  const added: AgentPackage[] = ordered
    .filter((p) => !existing.has(p.id))
    .map((p) => {
      seq += 1
      const isTogether = p.submittedTogether ?? incoming.length > 1
      return {
        ...p,
        seq,
        submittedTogether: isTogether,
        fingerprint: fingerprintOf(p),
        status: '队列中' as const,
        attemptCount: 0,
        ...(isTogether ? { note: '与其他回传同时提交，按包号排序入队' } : {}),
      }
    })
  if (!added.length) return state
  const dupesSkipped = incoming.length - added.length
  return {
    ...state,
    packages: [...state.packages, ...added],
    logs: [
      ...state.logs,
      log('info', '回传入队', `新接收 ${added.length} 个包${dupesSkipped ? `，重复包号跳过 ${dupesSkipped} 个（只入账一次）` : ''}：${added.map((p) => p.id).join('、')}`),
    ],
  }
}

/** 重复包号再次到达：内容一致 => 忽略；内容不一致 => 后到版本留待核验 */
export function handleRepost(state: ReconcileState, p: IncomingPackage): ReconcileState {
  const first = state.packages.find((item) => item.id === p.id)!
  const fp = fingerprintOf(p)
  if (fp === first.fingerprint) {
    return { ...state, logs: [...state.logs, log('warn', '包号重复', `${p.id} 内容指纹一致，判定为重复投递，忽略，不重复入账。`)] }
  }
  if (first.heldVersion && !first.heldVersion.decided) {
    return { ...state, logs: [...state.logs, log('warn', '后到版本仍留验', `${p.id} 已有待核验的后到版本，需人工裁定后才能继续。`)] }
  }
  const held = { version: (first.heldVersion?.version ?? 0) + 1, gross: p.gross, receivedAt: p.receivedAt, note: `实收 ¥${p.gross}（原 ¥${first.gross}），收入期/批次或指纹不一致`, decided: false }
  return {
    ...state,
    packages: state.packages.map((item) => item.id === p.id ? { ...item, status: '后到版本留验' as const, heldVersion: held, blockReason: undefined, blockDetail: undefined } : item),
    logs: [...state.logs, log('warn', '后到版本冲突', `${p.id} 同包号不同内容：${held.note}。原入账保留，新版本留待核验，不覆盖。`)],
  }
}

/** 对后到版本做人工裁定：接受则重算该包分成行，拒绝则丢弃新版本 */
export function decideHeldVersion(state: ReconcileState, packageId: string, accept: boolean): ReconcileState {
  const pkg = state.packages.find((p) => p.id === packageId)
  if (!pkg?.heldVersion || pkg.heldVersion.decided) return state
  let next = {
    ...state,
    packages: state.packages.map((p) => p.id === packageId ? { ...p, heldVersion: { ...p.heldVersion!, decided: true } } : p),
  }
  if (accept) {
    next = {
      ...next,
      packages: next.packages.map((p) => p.id === packageId ? { ...p, gross: p.heldVersion!.gross, receivedAt: p.heldVersion!.receivedAt, status: '队列中' as const } : p),
      logs: [...next.logs, log('info', '接受后到版本', `${packageId} 以新版本实收重算，旧分成行将被冲回为一行（不新增收入）。`)],
    }
    return processQueue(next, { onlyPackageIds: [packageId] })
  }
  return { ...next, logs: [...next.logs, log('info', '拒却后到版本', `${packageId} 维持首次入账金额，后到版本作废。`)] }
}

function sourcesFor(pkg: AgentPackage, snap: LicenseSnapshot | undefined, eligible: ReturnType<typeof evaluateWindow> | undefined, batch: ReconcileState['batches'][number] | undefined, existing: ShareLine | undefined): DiscrepancySource[] {
  const sources = new Set<DiscrepancySource>()
  if (existing) sources.add('窗口变更重算')
  if (snap?.backfilled) sources.add('历史回填')
  if (!snap) sources.add('无授权快照')
  if (eligible?.reason === 'WINDOW_EXPIRED') sources.add('窗口已过期')
  if (snap && pkg.rights !== snap.rights) sources.add('独占范围不符')
  if (eligible && eligible.daysIn < eligible.daysTotal) sources.add('窗口变更重算')
  if (!batch) sources.add('结算批次不匹配')
  else if (batch.status === '已关账') sources.add('结算批次不匹配')
  else if (eligible && eligible.daysIn > 0 && (new Date(pkg.periodStart) < new Date(batch.periodStart) || new Date(pkg.periodEnd) > new Date(batch.periodEnd))) sources.add('结算批次不匹配')
  return [...sources]
}

/** 处理队列中排在最前（包号最小）的一个包 */
function processOne(state: ReconcileState, pkg: AgentPackage): ReconcileState {
  const mark = (patch: Partial<AgentPackage>, entry: ReconcileLog): ReconcileState => ({
    ...state,
    packages: state.packages.map((p) => p.id === pkg.id ? { ...p, ...patch } : p),
    logs: [...state.logs, entry],
  })

  const batch = state.batches.find((b) => b.id === pkg.batchId)
  if (!batch) {
    return mark({ status: '阻断', attemptCount: pkg.attemptCount + 1, blockReason: 'BATCH_NOT_FOUND', blockDetail: `找不到结算批次 ${pkg.batchId}` }, log('warn', '处理阻断', `${pkg.id}：结算批次 ${pkg.batchId} 不存在。`))
  }
  if (batch.status === '已关账') {
    return mark({ status: '阻断', attemptCount: pkg.attemptCount + 1, blockReason: 'BATCH_CLOSED', blockDetail: `批次 ${batch.name} 已关账，不能再计入分成` }, log('warn', '处理阻断', `${pkg.id}：批次 ${batch.name} 已关账。`))
  }
  if (new Date(pkg.periodStart) < new Date(batch.periodStart) || new Date(pkg.periodEnd) > new Date(batch.periodEnd)) {
    return mark({ status: '阻断', attemptCount: pkg.attemptCount + 1, blockReason: 'BATCH_PERIOD_MISMATCH', blockDetail: `回传收入期 ${pkg.periodStart}→${pkg.periodEnd} 超出批次账期 ${batch.periodStart}→${batch.periodEnd}` }, log('warn', '处理阻断', `${pkg.id}：收入期与批次 ${batch.name} 账期不一致。`))
  }

  const snap = snapshotAt(state.snapshots, { workId: pkg.workId, territory: pkg.territory, channel: pkg.channel }, pkg.receivedAt)
  if (!snap) {
    return mark({ status: '阻断', attemptCount: pkg.attemptCount + 1, blockReason: 'NO_SNAPSHOT', blockDetail: `回传到达日 ${pkg.receivedAt} 找不到 ${pkg.work}/${pkg.territory}/${pkg.channel} 的有效授权快照` }, log('warn', '处理阻断', `${pkg.id}：无匹配授权快照，等待旧数据回填。`))
  }
  const eligibility = evaluateWindow(pkg, snap, pkg.receivedAt)
  if (eligibility.reason) {
    return mark({ status: '阻断', attemptCount: pkg.attemptCount + 1, blockReason: eligibility.reason, blockDetail: eligibility.detail }, log('error', '处理阻断', `${pkg.id}：${eligibility.detail}`))
  }
  if (pkg.rights !== snap.rights || (snap.exclusive && pkg.channel !== snap.channel)) {
    return mark({ status: '阻断', attemptCount: pkg.attemptCount + 1, blockReason: 'EXCLUSIVITY_MISMATCH', blockDetail: `回传权利类型/渠道（${pkg.rights}·${pkg.channel}）不在快照 ${snap.id} 的独占范围内` }, log('warn', '处理阻断', `${pkg.id}：独占范围不符。`))
  }

  // 通过全部核验：同一包号始终只维护一行分成（幂等）
  const previous = state.shares.find((s) => s.packageId === pkg.id)
  const share = Math.round(eligibility.eligible * snap.rate * 100) / 100
  const sources = sourcesFor(pkg, snap, eligibility, batch, previous)
  const line: ShareLine = {
    id: `SL-${pkg.id}`,
    packageId: pkg.id,
    windowId: snap.windowId,
    snapshotId: snap.id,
    snapshotVersion: snap.version,
    workId: pkg.workId,
    work: pkg.work,
    channel: pkg.channel,
    territory: pkg.territory,
    batchId: batch.id,
    periodStart: pkg.periodStart,
    periodEnd: pkg.periodEnd,
    gross: pkg.gross,
    eligible: eligibility.eligible,
    rate: snap.rate,
    share,
    status: previous ? '已重算' : '正常',
    sources,
    note: previous
      ? `授权窗口第 ${snap.version} 版触发重算（${eligibility.daysIn}/${eligibility.daysTotal} 天在窗）；冲回旧行，不重复计收入`
      : snap.backfilled
        ? `旧数据无快照，已按原签署日期 ${snap.signedAt} 回填第 ${snap.version} 版快照`
        : `${eligibility.daysIn}/${eligibility.daysTotal} 天落在有效窗口内`,
    bookedAt: new Date().toISOString(),
  }
  const lastConfirmed = state.checkpoint ? state.packages.find((p) => p.id === state.checkpoint) : undefined
  const checkpoint = lastConfirmed && lastConfirmed.seq >= pkg.seq ? lastConfirmed.id : pkg.id
  return {
    ...state,
    shares: [...state.shares.filter((s) => s.packageId !== pkg.id), line],
    checkpoint,
    failure: null,
    packages: state.packages.map((p) => p.id === pkg.id ? { ...p, status: '已确认', confirmedAt: line.bookedAt, blockReason: undefined, blockDetail: undefined } : p),
    logs: [...state.logs, log('success', previous ? '分成行重算' : '回传确认入账', `${pkg.id}：实收 ¥${pkg.gross}，窗口内可计提 ¥${eligibility.eligible}，分成 ¥${share}（比例 ${(snap.rate * 100).toFixed(1)}%，快照 v${snap.version}${snap.backfilled ? '·回填' : ''}）。`)],
  }
}

/** 串行处理队列（按包号顺序）；默认遇阻断即停，continueAfterBlock 时挂起阻断包、其他代理人的回传继续处理 */
export function processQueue(state: ReconcileState, options?: { failAt?: string; failDetail?: string; continueAfterBlock?: boolean; onlyPackageIds?: string[] }): ReconcileState {
  let next = state
  const queued = next.packages
    .filter((p) => p.status === '队列中' || p.status === '失败')
    .filter((p) => !options?.onlyPackageIds || options.onlyPackageIds.includes(p.id))
    // 同时提交的包包号相邻、按包号定先后；其余严格按入队序号 FIFO
    .sort((a, b) => (a.seq - b.seq) || a.id.localeCompare(b.id, 'zh-Hans-CN'))
  const blocked: AgentPackage[] = []
  let stoppedByFailure = false
  for (const pkg0 of queued) {
    const pkg = next.packages.find((p) => p.id === pkg0.id)!
    if (options?.failAt === pkg.id) {
      next = {
        ...next,
        packages: next.packages.map((p) => p.id === pkg.id ? { ...p, status: '失败', attemptCount: p.attemptCount + 1 } : p),
        failure: { packageId: pkg.id, detail: options.failDetail ?? '处理过程发生异常' },
        logs: [...next.logs, log('error', '处理失败', `${pkg.id}：${options.failDetail ?? '处理过程发生异常'}。检查点停留在 ${next.checkpoint ?? '无'}，恢复后从该包重放，已确认包不会重复入账。`)],
      }
      stoppedByFailure = true
      break
    }
    next = processOne(next, pkg)
    const updated = next.packages.find((p) => p.id === pkg.id)!
    if (updated.status === '失败') {
      next = { ...next, failure: { packageId: pkg.id, detail: updated.blockDetail ?? '处理失败' } }
      stoppedByFailure = true
      break
    }
    if (updated.status === '阻断') {
      blocked.push(updated)
      if (!options?.continueAfterBlock) {
        next = { ...next, failure: { packageId: pkg.id, detail: updated.blockDetail ?? '核验阻断' } }
        break
      }
    }
  }
  if (options?.continueAfterBlock && blocked.length && !stoppedByFailure) {
    next = {
      ...next,
      failure: null,
      logs: [...next.logs, log('warn', '阻断包挂起', `${blocked.map((p) => p.id).join('、')} 留待核验，其余回传照常入账；阻断解除前不产生分成。`)],
    }
  }
  return next
}

/** 阻断解除（如修正窗口/批次）后把包重新放回队列 */
export function retryPackage(state: ReconcileState, packageId: string): ReconcileState {
  const pkg = state.packages.find((p) => p.id === packageId)
  if (!pkg || (pkg.status !== '阻断' && pkg.status !== '后到版本留验')) return state
  return processQueue({
    ...state,
    failure: null,
    packages: state.packages.map((p) => p.id === packageId ? { ...p, status: '队列中', blockReason: undefined, blockDetail: undefined } : p),
    logs: [...state.logs, log('info', '阻断解除重试', `${packageId} 重新进入核验队列。`)],
  }, { onlyPackageIds: [packageId] })
}

/**
 * 窗口变更：只重算受影响的分成行（windowId 相同、批次未关账），
 * 其他代理人/窗口的分成行原样保留。
 */
export function applyWindowChange(
  state: ReconcileState,
  snapshot: LicenseSnapshot,
): ReconcileState {
  const others = state.snapshots.filter((s) => s.id !== snapshot.id)
  const nextSnapshots = [...others, snapshot].sort((a, b) => new Date(b.effectiveFrom).getTime() - new Date(a.effectiveFrom).getTime())
  const affected = state.shares.filter((s) => s.windowId === snapshot.windowId && state.batches.find((b) => b.id === s.batchId)?.status !== '已关账')
  const closed = state.shares.filter((s) => s.windowId === snapshot.windowId && state.batches.find((b) => b.id === s.batchId)?.status === '已关账')
  let next: ReconcileState = {
    ...state,
    snapshots: nextSnapshots,
    shares: state.shares.map((s) => affected.some((a) => a.id === s.id) ? { ...s, status: '待重算', sources: unique([...s.sources, '窗口变更重算']), note: `窗口变更为 v${snapshot.version}（${snapshot.start}→${snapshot.end}），等待重算` } : s),
    logs: [
      ...state.logs,
      log('info', '授权窗口变更', `${snapshot.windowId} 发布 v${snapshot.version}（${snapshot.start}→${snapshot.end}，分成比例 ${(snapshot.rate * 100).toFixed(1)}%）。受影响分成行 ${affected.length} 行标记重算，其余 ${state.shares.length - affected.length - closed.length} 行照旧。`),
      ...(closed.length ? [log('info', '关账批次保留', `${closed.length} 行属于已关账批次，保留历史数据仅供查询，不重算。`)] : []),
    ],
  }
  // 逐行按新快照重算（行内幂等：冲回旧行，不新增收入）
  for (const line of affected) {
    const pkg = next.packages.find((p) => p.id === line.packageId)
    if (!pkg) continue
    const eligibility = evaluateWindow(pkg, snapshot, pkg.receivedAt)
    next = eligibility.reason
      ? {
          ...next,
          shares: next.shares.map((s) => s.id === line.id ? { ...s, status: '阻断', sources: unique([...s.sources, eligibility.reason === 'WINDOW_EXPIRED' ? '窗口已过期' : '窗口变更重算']), note: eligibility.detail } : s),
          logs: [...next.logs, log('warn', '重算阻断', `${line.id}：${eligibility.detail}`)],
        }
      : {
          ...next,
          shares: next.shares.map((s) => {
            if (s.id !== line.id) return s
            const share = Math.round(eligibility.eligible * snapshot.rate * 100) / 100
            return {
              ...s,
              snapshotId: snapshot.id,
              snapshotVersion: snapshot.version,
              eligible: eligibility.eligible,
              rate: snapshot.rate,
              share,
              status: '已重算' as const,
              sources: unique([...s.sources.filter((x) => x !== '窗口变更重算'), '窗口变更重算']),
              note: `按 v${snapshot.version} 重算：窗口内 ${eligibility.daysIn}/${eligibility.daysTotal} 天，分成 ¥${s.share} → ¥${share}（冲回旧行，未重复计收入）`,
              bookedAt: new Date().toISOString(),
            }
          }),
          logs: [...next.logs, log('success', '受影响分成行重算', `${line.id}：按 v${snapshot.version} 重算完成，其他代理人分成行未受影响。`)],
        }
  }
  return next
}

/** 失败恢复：从已确认包号（检查点）之后继续，已确认包绝不重放、不重复入账 */
export function recover(state: ReconcileState, options?: { failAt?: string; failDetail?: string }): ReconcileState {
  if (!state.failure) return state
  const failedId = state.failure.packageId
  const resumed: ReconcileState = {
    ...state,
    failure: null,
    packages: state.packages.map((p) => p.id === failedId ? { ...p, status: '队列中', blockReason: undefined, blockDetail: undefined } : p),
    logs: [...state.logs, log('info', '开始恢复', `从检查点「${state.checkpoint ?? '无'}」之后继续，失败包 ${failedId} 重新处理；已确认包号跳过重放，保证同一笔收入不记两遍。`)],
  }
  return processQueue(resumed, options)
}

/** 旧数据没有授权快照：按原签署日期升级回填，历史分成行仍可查 */
export function backfillSnapshot(state: ReconcileState, snapshot: LicenseSnapshot): ReconcileState {
  const withSnap: ReconcileState = {
    ...state,
    snapshots: [...state.snapshots, { ...snapshot, backfilled: true }],
    logs: [...state.logs, log('success', '历史快照回填', `${snapshot.windowId} 按原签署日期 ${snapshot.signedAt} 回填 v${snapshot.version} 授权快照（${snapshot.territory}/${snapshot.channel}，分成 ${(snapshot.rate * 100).toFixed(1)}%）。`)],
  }
  // 回填后自动核验：此前因 NO_SNAPSHOT 阻断的包回到队列
  const unblocked = withSnap.packages.filter((p) => p.blockReason === 'NO_SNAPSHOT')
  if (!unblocked.length) return withSnap
  return processQueue({
    ...withSnap,
    packages: withSnap.packages.map((p) => p.blockReason === 'NO_SNAPSHOT' ? { ...p, status: '队列中', blockReason: undefined, blockDetail: undefined } : p),
    logs: [...withSnap.logs, log('info', '回填触发补核验', `${unblocked.map((p) => p.id).join('、')} 等待按回填快照补入账，历史分成行保留可查。`)],
  }, { onlyPackageIds: unblocked.map((p) => p.id) })
}

/** 标记历史分成行（旧批次已关账数据），仅查询不参与重算 */
export function historicalShares(state: ReconcileState): ShareLine[] {
  return state.shares.filter((s) => s.status === '历史' || state.batches.find((b) => b.id === s.batchId)?.status === '已关账')
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)]
}

export const reasonText: Record<BlockReason, string> = {
  NO_SNAPSHOT: '无有效授权快照',
  WINDOW_NOT_STARTED: '回传到达时窗口未生效',
  WINDOW_EXPIRED: '授权窗口已过期（过期收入不得分成）',
  PERIOD_OUTSIDE: '收入期落在窗口之外',
  EXCLUSIVITY_MISMATCH: '独占范围不符',
  BATCH_NOT_FOUND: '结算批次不存在',
  BATCH_PERIOD_MISMATCH: '批次账期不一致',
  BATCH_CLOSED: '结算批次已关账',
  TECHNICAL: '处理失败，待恢复',
}
