import { assert } from 'node:console'
import {
  enqueue, processQueue, recover, applyWindowChange, backfillSnapshot,
  handleRepost, decideHeldVersion, snapshotAt, fingerprintOf,
} from '../lib/settlement/engine'
import { buildInitialState, windowV2Snapshot, backfillSnapshot as seedBackfill } from '../lib/settlement/seed'
import type { IncomingPackage } from '../lib/settlement/types'

let failures = 0
function check(name: string, cond: boolean, extra = '') {
  if (cond) console.log(`  ✓ ${name}`)
  else { failures += 1; console.error(`  ✗ ${name} ${extra}`) }
}

console.log('1) 初始场景：处理到过期窗口 PKG-2403 阻断，检查点=PKG-2402')
let s = buildInitialState()
const st = (id: string) => s.packages.find((p) => p.id === id)!.status
check('2401 已确认', st('PKG-2401') === '已确认')
check('2402 已确认', st('PKG-2402') === '已确认')
check('2403 过期窗口阻断', st('PKG-2403') === '阻断' && s.packages.find((p) => p.id === 'PKG-2403')!.blockReason === 'WINDOW_EXPIRED')
check('2404 及其后仍排队', st('PKG-2404') === '队列中' && st('PKG-2407') === '队列中')
check('检查点为最近确认包 PKG-2402', s.checkpoint === 'PKG-2402')
check('过期窗口没有产生分成行', !s.shares.some((l) => l.packageId === 'PKG-2403'))
check('历史行可查', s.shares.some((l) => l.id === 'SL-PKG-2399' && l.status === '历史'))

console.log('2) 挂起阻断继续处理其他包：其他代理人照旧')
s = processQueue(s, { continueAfterBlock: true })
check('2404 已确认', st('PKG-2404') === '已确认')
check('2501 已确认（同时提交按包号先处理）', st('PKG-2501') === '已确认')
check('2502 已确认', st('PKG-2502') === '已确认')
check('2399 关账阻断', st('PKG-2399') === '阻断' && s.packages.find((p) => p.id === 'PKG-2399')!.blockReason === 'BATCH_CLOSED')
check('2407 无快照阻断', st('PKG-2407') === '阻断' && s.packages.find((p) => p.id === 'PKG-2407')!.blockReason === 'NO_SNAPSHOT')
check('2403 仍旧阻断（未被跳过处理）', st('PKG-2403') === '阻断')
const line2404 = s.shares.find((l) => l.packageId === 'PKG-2404')!
check('2404 按 v1 分成 343000', line2404.share === 343000, `got ${line2404.share}`)
const line2501 = s.shares.find((l) => l.packageId === 'PKG-2501')!
check('2501 航空分成 53750', line2501.share === 53750, `got ${line2501.share}`)

console.log('3) 两笔新回传同时提交：按包号排队且只处理本批')
const beforeCount = s.shares.length
s = enqueue(s, [
  { id: 'PKG-2602', workId: 'W-002', work: '《深港口岸》', channel: '海岛航空', rights: '航空', territory: '东南亚区域', periodStart: '2027-02-11', periodEnd: '2027-02-28', gross: 120000, receivedAt: '2027-03-02', batchId: 'B-2027Q1', submittedTogether: true },
  { id: 'PKG-2601', workId: 'W-001', work: '《远山回声》', channel: '云帆视频', rights: '流媒体', territory: '中国大陆', periodStart: '2027-01-01', periodEnd: '2027-01-31', gross: 300000, receivedAt: '2027-02-05', batchId: 'B-2027Q1', submittedTogether: true },
])
const seq2601 = s.packages.find((p) => p.id === 'PKG-2601')!.seq
const seq2602 = s.packages.find((p) => p.id === 'PKG-2602')!.seq
check('同批按包号排序（2601 在前）', seq2601 < seq2602, `${seq2601} vs ${seq2602}`)
s = processQueue(s, { onlyPackageIds: ['PKG-2601', 'PKG-2602'] })
check('2601、2602 均确认', st('PKG-2601') === '已确认' && st('PKG-2602') === '已确认')
check('只新增两行分成', s.shares.length === beforeCount + 2)

console.log('4) 重复包号：同内容只入账一次')
const dup: IncomingPackage = {
  id: 'PKG-2401', workId: 'W-001', work: '《远山回声》', channel: '星海影院', rights: '院线', territory: '中国大陆',
  periodStart: '2026-10-18', periodEnd: '2026-11-15', gross: 1280000, receivedAt: '2026-11-20', batchId: 'B-2026Q4',
}
const shareRowsBefore = s.shares.filter((l) => l.packageId === 'PKG-2401').length
s = handleRepost(s, dup)
const shareRowsAfter = s.shares.filter((l) => l.packageId === 'PKG-2401').length
check('重复投递仍是一行', shareRowsBefore === 1 && shareRowsAfter === 1)
check('2401 保持已确认', st('PKG-2401') === '已确认')

console.log('5) 后到版本冲突：留待核验，接受后冲回旧行（金额变化但行数不变）')
s = handleRepost(s, { ...dup, gross: 1290000, receivedAt: '2026-11-25' })
check('2401 变为后到版本留验', st('PKG-2401') === '后到版本留验')
const held = s.packages.find((p) => p.id === 'PKG-2401')!.heldVersion!
check('留验版本金额 1290000', held.gross === 1290000)
s = decideHeldVersion(s, 'PKG-2401', true)
const rows2401 = s.shares.filter((l) => l.packageId === 'PKG-2401')
check('接受后仍只有一行', rows2401.length === 1)
check('接受后按 1290000 重算分成 541800', rows2401[0]!.share === 541800, `got ${rows2401[0]!.share}`)
check('行状态为已重算且带差异来源', rows2401[0]!.status === '已重算' && rows2401[0]!.sources.includes('窗口变更重算'))

console.log('6) 处理失败：从检查点恢复，同一笔收入不记两遍')
// 初始处理停在 2403；继续时对仍排队的 2407 注入故障（2399 关账阻断被挂起跳过）
s = buildInitialState()
const rowsAtFailureStart = s.shares.length
s = processQueue(s, { continueAfterBlock: true, failAt: 'PKG-2407', failDetail: '模拟通道中断' })
check('2407 失败', st('PKG-2407') === '失败')
check('失败记录存在', s.failure?.packageId === 'PKG-2407')
check('检查点停留在 PKG-2502', s.checkpoint === 'PKG-2502', `got ${s.checkpoint}`)
const rowsBeforeRecover = s.shares.length
check('失败包未产生分成行', !s.shares.some((l) => l.packageId === 'PKG-2407'))
void rowsAtFailureStart
s = recover(s)
check('恢复后 2407 转为业务阻断（无快照），非重复入账', st('PKG-2407') === '阻断')
check('恢复未造成行数变化', s.shares.length === rowsBeforeRecover)
// 已确认包重放安全性：再次恢复不应新增任何行
const rowsTwice = s.shares.length
s = { ...s, failure: { packageId: 'PKG-2407', detail: 'x' } }
s = recover(s)
check('重复恢复不新增分成行', s.shares.length === rowsTwice)

console.log('7) 旧数据回填：按原签署日期升级，2407 补核验入账，历史行保留')
s = backfillSnapshot(s, seedBackfill)
check('2407 已确认', st('PKG-2407') === '已确认')
const line2407 = s.shares.find((l) => l.packageId === 'PKG-2407')!
check('2407 回填分成 106400', line2407.share === 106400, `got ${line2407.share}`)
check('2407 行标注历史回填来源', line2407.sources.includes('历史回填'))
check('Q3 历史行仍可查且未重算', s.shares.some((l) => l.id === 'SL-PKG-2399' && l.status === '历史'))

console.log('8) 窗口 v2 变更：只重算受影响的分成行，其他代理人照旧')
const fresh = buildInitialState()
let f = processQueue(fresh, { continueAfterBlock: true })
const othersBefore = f.shares.filter((l) => l.windowId !== 'RW-102').map((l) => ({ id: l.id, share: l.share, status: l.status, bookedAt: l.bookedAt }))
const v1line = f.shares.find((l) => l.packageId === 'PKG-2404')!
check('v1 下 2404 全期在窗', v1line.eligible === 980000 && v1line.share === 343000)
f = applyWindowChange(f, windowV2Snapshot)
const v2line = f.shares.find((l) => l.packageId === 'PKG-2404')!
check('v2 只覆盖窗内 17/42 天', v2line.eligible === 396666.67, `got ${v2line.eligible}`)
check('v2 分成按 33% 重算为 130900', v2line.share === 130900, `got ${v2line.share}`)
check('受影响行标注已重算', v2line.status === '已重算')
check('行数不变（冲回旧行而非新增）', f.shares.length === (processQueue(buildInitialState(), { continueAfterBlock: true })).shares.length)
const othersAfter = f.shares.filter((l) => l.windowId !== 'RW-102').map((l) => ({ id: l.id, share: l.share, status: l.status, bookedAt: l.bookedAt }))
check('其他代理人/窗口分成行原样保留', JSON.stringify(othersBefore) === JSON.stringify(othersAfter))
check('关账历史行未被重算', f.shares.find((l) => l.id === 'SL-PKG-2399')!.status === '历史')
// 变更后新到达的回传自动按 v2 快照匹配
const snapPicked = snapshotAt(f.snapshots, { workId: 'W-001', territory: '中国大陆', channel: '云帆视频' }, '2026-12-20')
check('12-20 到达的新回传匹配 v2 快照', snapPicked?.version === 2)

console.log('9) 指纹：同包号不同内容可识别')
check('指纹随金额变化', fingerprintOf(dup) !== fingerprintOf({ ...dup, gross: 1 }))

console.log(failures === 0 ? '\n全部通过 ✅' : `\n${failures} 项失败 ❌`)
process.exit(failures === 0 ? 0 : 1)
