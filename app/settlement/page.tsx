'use client'

import { useMemo } from 'react'
import {
  Badge, Box, Button, Flex, Grid, Heading, HStack, Stack, Table, Tbody, Td, Text, Th, Thead, Tr, useToast,
} from '@chakra-ui/react'
import { useSettlementStore } from '@/store/settlement'
import { reasonText } from '@/lib/settlement/engine'
import { backfillSnapshot, windowV2Snapshot } from '@/lib/settlement/seed'
import type { AgentPackage, DiscrepancySource, ShareLine } from '@/lib/settlement/types'

const statusColor: Record<AgentPackage['status'], string> = {
  '队列中': 'blue',
  '处理中': 'blue',
  '已确认': 'green',
  '阻断': 'red',
  '失败': 'orange',
  '后到版本留验': 'purple',
}

const lineStatusColor: Record<ShareLine['status'], string> = {
  '正常': 'green',
  '待重算': 'orange',
  '已重算': 'blue',
  '阻断': 'red',
  '历史': 'gray',
}

const sourceHint: Record<DiscrepancySource, string> = {
  '窗口变更重算': '授权窗口条款/比例更新，冲回旧行后按新快照重算，不新增收入',
  '独占范围不符': '回传渠道或权利类型不在快照独占范围内',
  '结算批次不匹配': '收入期与批次账期不符，或批次已关账',
  '无授权快照': '回传到达时找不到作品/地区/渠道匹配的有效授权快照',
  '历史回填': '旧数据缺失快照，按原签署日期升级回填，历史分成仍可查',
  '后到版本冲突': '同包号不同内容，先入账版本保留，新版本留待核验',
  '包号重复': '重复包号内容一致，只入账一次',
  '窗口已过期': '回传到达时窗口已结束，过期窗口收入不得计入分成',
}

const money = (n: number) => `¥${n.toLocaleString('zh-CN', { maximumFractionDigits: 2 })}`

export default function SettlementPage() {
  const s = useSettlementStore()
  const toast = useToast()
  const packages = useMemo(() => [...s.packages].sort((a, b) => a.seq - b.seq), [s.packages])

  const pending = packages.filter((p) => p.status !== '已确认')
  const blocked = packages.filter((p) => p.status === '阻断' || p.status === '失败' || p.status === '后到版本留验')
  const needRecompute = s.shares.filter((line) => line.status === '待重算' || line.status === '已重算')

  const discrepancyCounts = useMemo(() => {
    const counts = new Map<DiscrepancySource, number>()
    for (const line of s.shares) for (const src of line.sources) counts.set(src, (counts.get(src) ?? 0) + 1)
    for (const p of s.packages) {
      if (p.status === '后到版本留验') counts.set('后到版本冲突', (counts.get('后到版本冲突') ?? 0) + 1)
      if (p.blockReason === 'WINDOW_EXPIRED') counts.set('窗口已过期', (counts.get('窗口已过期') ?? 0) + 1)
      if (p.blockReason === 'NO_SNAPSHOT') counts.set('无授权快照', (counts.get('无授权快照') ?? 0) + 1)
      if (p.blockReason === 'BATCH_CLOSED' || p.blockReason === 'BATCH_PERIOD_MISMATCH' || p.blockReason === 'BATCH_NOT_FOUND') counts.set('结算批次不匹配', (counts.get('结算批次不匹配') ?? 0) + 1)
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1])
  }, [s.shares, s.packages])

  function simulateFailure() {
    const first = [...s.packages].filter((p) => p.status === '队列中').sort((a, b) => a.seq - b.seq)[0]
    if (!first) return toast({ title: '队列中没有待处理包', status: 'warning' })
    s.ingest([], { onlyNew: false, failAt: first.id, failDetail: '代理通道超时，实收回执未写完' })
    toast({ title: `已模拟 ${first.id} 处理失败`, description: '检查点保留在最近已确认包号，恢复时不会把同一笔收入记两遍。', status: 'error' })
  }

  function submitTogether() {
    s.ingest([
      { id: 'PKG-2601', workId: 'W-001', work: '《远山回声》', channel: '云帆视频', rights: '流媒体', territory: '中国大陆', periodStart: '2027-01-01', periodEnd: '2027-01-31', gross: 300000, receivedAt: '2027-02-05', batchId: 'B-2027Q1', submittedTogether: true },
      { id: 'PKG-2602', workId: 'W-002', work: '《深港口岸》', channel: '海岛航空', rights: '航空', territory: '东南亚区域', periodStart: '2027-02-11', periodEnd: '2027-02-28', gross: 120000, receivedAt: '2027-03-02', batchId: 'B-2027Q1', submittedTogether: true },
    ], { onlyNew: true })
    toast({ title: '两笔回传同时提交', description: '已按包号排队（PKG-2601 先于 PKG-2602），仅处理本批。', status: 'info' })
  }

  const cards = [
    { label: '待核验包号', value: pending.length, color: 'blue' },
    { label: '已确认包', value: packages.filter((p) => p.status === '已确认').length, color: 'green' },
    { label: '阻断 / 失败', value: blocked.length, color: 'red' },
    { label: '重算分成行', value: needRecompute.length, color: 'orange' },
  ]

  return (
    <Box>
      <Flex justify="space-between" mb={5} gap={4} direction={{ base: 'column', md: 'row' }}>
        <Box>
          <Text color="brand.600" fontSize="xs" fontWeight="bold">WINDOW × AGENT RETURN × SETTLEMENT BATCH</Text>
          <Heading fontSize="3xl" my={1}>实收回传统一核验</Heading>
          <Text color="gray.600">回传到达时按作品 / 地区 / 渠道匹配有效授权快照；窗口变更只重算受影响分成行，重复包号不重复入账。</Text>
        </Box>
        <HStack align="flex-start">
          <Badge colorScheme={s.failure ? 'orange' : 'green'} fontSize="sm" px={3} py={2}>
            检查点（已确认包号）：{s.checkpoint ?? '—'}
          </Badge>
          <Button size="sm" variant="outline" onClick={() => { s.reset(); toast({ title: '演示数据已重置', status: 'info' }) }}>重置演示</Button>
        </HStack>
      </Flex>

      {s.failure && (
        <Flex mb={4} p={4} bg="orange.50" border="1px solid" borderColor="orange.300" borderRadius="8px" justify="space-between" align="center" gap={4} direction={{ base: 'column', md: 'row' }}>
          <Box>
            <Text fontWeight="800" color="orange.800">处理中断：{s.failure.packageId}</Text>
            <Text fontSize="sm" color="orange.700">{s.failure.detail}。已确认到 {s.checkpoint ?? '—'}，恢复从该包号继续，已入账收入不会再记一遍。</Text>
          </Box>
          <Button colorScheme="orange" onClick={() => { s.resume(); toast({ title: '已从检查点恢复处理', status: 'success' }) }}>从已确认包号继续恢复</Button>
        </Flex>
      )}

      <Grid templateColumns={{ base: 'repeat(2,1fr)', lg: 'repeat(4,1fr)' }} gap={4} mb={5}>
        {cards.map((card) => (
          <Box key={card.label} bg="white" border="1px solid" borderColor="gray.200" borderLeft="4px solid" borderLeftColor={`${card.color}.400`} borderRadius="8px" p={4}>
            <Text color="gray.500" fontSize="sm">{card.label}</Text>
            <Heading size="lg" my={1}>{card.value}</Heading>
          </Box>
        ))}
      </Grid>

      <Flex mb={4} gap={2} flexWrap="wrap">
        <Button size="sm" colorScheme="blue" onClick={() => { s.process(); toast({ title: '按队列顺序处理（遇阻断暂停）', status: 'info' }) }}>处理队列</Button>
        <Button size="sm" variant="outline" onClick={() => { s.process({ continueAfterBlock: true }); toast({ title: '阻断包挂起，其他代理人的回传继续入账', status: 'info' }) }}>挂起阻断并继续其他包</Button>
        <Button size="sm" variant="outline" onClick={simulateFailure}>模拟下一包处理失败</Button>
        <Button size="sm" variant="outline" onClick={submitTogether}>同时提交两笔回传</Button>
        <Button size="sm" variant="outline" onClick={() => { s.windowChanged(windowV2Snapshot); toast({ title: 'RW-102 窗口变更为 v2', description: '仅云帆视频相关分成行重算，星海/海岛/环球照旧。', status: 'success' }) }}>授权窗口发布 v2（只重算受影响行）</Button>
        <Button size="sm" variant="outline" onClick={() => { s.backfill(backfillSnapshot); toast({ title: '旧合同按原签署日期回填快照', status: 'success' }) }}>旧数据按签署日期回填快照</Button>
      </Flex>

      <Grid templateColumns={{ base: '1fr', xl: '1.55fr .9fr' }} gap={4}>
        <Stack spacing={4}>
          <Box bg="white" border="1px solid" borderColor="gray.200" borderRadius="8px" overflow="hidden">
            <Flex p={4} justify="space-between" align="center">
              <Heading size="md">代理回传包队列</Heading>
              <Text color="gray.500" fontSize="xs">按入队顺序串行处理；同时提交的一组以包号定先后</Text>
            </Flex>
            <Box overflowX="auto">
              <Table size="sm" whiteSpace="nowrap">
                <Thead><Tr><Th>包号 / 序</Th><Th>作品 · 渠道</Th><Th>地区 / 权利</Th><Th>收入期</Th><Th>实收</Th><Th>到达日</Th><Th>批次</Th><Th>状态</Th><Th>操作</Th></Tr></Thead>
                <Tbody>
                  {packages.map((p) => (
                    <Tr key={p.id} bg={p.id === s.failure?.packageId ? 'orange.50' : undefined}>
                      <Td>
                        <Text fontWeight="700">{p.id}</Text>
                        <Text color="gray.400" fontSize="10px">#{p.seq}{p.submittedTogether ? ' · 同批' : ''}</Text>
                      </Td>
                      <Td><Text fontWeight="600">{p.work}</Text><Text color="gray.500" fontSize="xs">{p.channel}</Text></Td>
                      <Td>{p.territory}<Text color="gray.500" fontSize="xs">{p.rights}</Text></Td>
                      <Td><Text fontSize="xs">{p.periodStart}</Text><Text fontSize="xs">{p.periodEnd}</Text></Td>
                      <Td isNumeric>{money(p.gross)}</Td>
                      <Td>{p.receivedAt}</Td>
                      <Td>{p.batchId}</Td>
                      <Td>
                        <Badge colorScheme={statusColor[p.status]}>{p.status}</Badge>
                        {p.blockReason && <Text color="red.600" fontSize="10px" maxW="160px" mt={1}>{reasonText[p.blockReason]}</Text>}
                      </Td>
                      <Td>
                        <HStack spacing={1}>
                          {p.status === '阻断' && <Button size="xs" colorScheme="blue" variant="outline" onClick={() => { s.retry(p.id); toast({ title: `${p.id} 重新核验`, status: 'info' }) }}>重试</Button>}
                          {p.status === '后到版本留验' && <>
                            <Button size="xs" colorScheme="purple" onClick={() => { s.resolveHeld(p.id, true); toast({ title: `接受 ${p.id} 后到版本，冲回旧行重算`, status: 'success' }) }}>接受新版</Button>
                            <Button size="xs" variant="outline" onClick={() => { s.resolveHeld(p.id, false); toast({ title: `拒却 ${p.id} 后到版本`, status: 'info' }) }}>拒却</Button>
                          </>}
                          {p.status === '已确认' && p.id === 'PKG-2401' && <>
                            <Button size="xs" variant="ghost" onClick={() => { s.repost({ id: p.id, workId: p.workId, work: p.work, channel: p.channel, rights: p.rights, territory: p.territory, periodStart: p.periodStart, periodEnd: p.periodEnd, gross: p.gross, receivedAt: p.receivedAt, batchId: p.batchId }); toast({ title: '同内容重复包号已忽略', description: '包号 + 内容指纹一致，不第二次入账。', status: 'warning' }) }}>重复投递</Button>
                            <Button size="xs" colorScheme="purple" variant="ghost" onClick={() => { s.repost({ id: p.id, workId: p.workId, work: p.work, channel: p.channel, rights: p.rights, territory: p.territory, periodStart: p.periodStart, periodEnd: p.periodEnd, gross: 1290000, receivedAt: '2026-11-25', batchId: p.batchId }); toast({ title: '后到版本金额不一致', description: '原入账保留，新版本留待核验。', status: 'warning' }) }}>后到版本</Button>
                          </>}
                        </HStack>
                        {p.heldVersion && !p.heldVersion.decided && <Text color="purple.600" fontSize="10px" mt={1}>{p.heldVersion.note}</Text>}
                        {p.blockDetail && <Text color="gray.500" fontSize="10px" maxW="200px" mt={1}>{p.blockDetail}</Text>}
                      </Td>
                    </Tr>
                  ))}
                </Tbody>
              </Table>
            </Box>
          </Box>

          <Box bg="white" border="1px solid" borderColor="gray.200" borderRadius="8px" overflow="hidden">
            <Flex p={4} justify="space-between" align="center">
              <Heading size="md">分成行（一笔包号唯一一行）</Heading>
              <Text color="gray.500" fontSize="xs">冲回旧行而非新增行，保证同一笔收入不记两遍</Text>
            </Flex>
            <Box overflowX="auto">
              <Table size="sm" whiteSpace="nowrap">
                <Thead><Tr><Th>分成行 / 包号</Th><Th>作品 · 渠道</Th><Th>批次</Th><Th>快照版本</Th><Th>实收 / 窗内可计提</Th><Th>比例</Th><Th>分成</Th><Th>状态 / 差异来源</Th></Tr></Thead>
                <Tbody>
                  {s.shares.map((line) => (
                    <Tr key={line.id} opacity={line.status === '历史' ? 0.75 : 1}>
                      <Td><Text fontWeight="700">{line.id}</Text><Text color="gray.400" fontSize="10px">{line.bookedAt.slice(0, 10)}</Text></Td>
                      <Td><Text fontWeight="600">{line.work}</Text><Text color="gray.500" fontSize="xs">{line.channel} · {line.territory}</Text></Td>
                      <Td>{line.batchId}</Td>
                      <Td>v{line.snapshotVersion}</Td>
                      <Td><Text>{money(line.gross)}</Text><Text color="gray.500" fontSize="xs">{money(line.eligible)}</Text></Td>
                      <Td>{(line.rate * 100).toFixed(1)}%</Td>
                      <Td fontWeight="700">{money(line.share)}</Td>
                      <Td>
                        <Badge colorScheme={lineStatusColor[line.status]} mb={1}>{line.status}</Badge>
                        <HStack spacing={1} flexWrap="wrap">
                          {line.sources.map((src) => <Badge key={src} colorScheme="orange" variant="subtle" fontSize="9px">{src}</Badge>)}
                        </HStack>
                        {line.note && <Text color="gray.500" fontSize="10px" maxW="260px" mt={1}>{line.note}</Text>}
                      </Td>
                    </Tr>
                  ))}
                </Tbody>
              </Table>
            </Box>
          </Box>
        </Stack>

        <Stack spacing={4}>
          <Box bg="white" border="1px solid" borderColor="gray.200" borderRadius="8px" p={4}>
            <Heading size="sm" mb={3}>差异来源</Heading>
            {discrepancyCounts.length === 0 && <Text color="gray.500" fontSize="sm">暂无差异。</Text>}
            <Stack spacing={2}>
              {discrepancyCounts.map(([src, count]) => (
                <Box key={src} p={2} bg="orange.50" borderRadius="6px">
                  <Flex justify="space-between"><Text fontWeight="700" fontSize="sm">{src}</Text><Badge colorScheme="orange">{count}</Badge></Flex>
                  <Text color="gray.600" fontSize="xs" mt={1}>{sourceHint[src]}</Text>
                </Box>
              ))}
            </Stack>
          </Box>

          <Box bg="white" border="1px solid" borderColor="gray.200" borderRadius="8px" p={4}>
            <Heading size="sm" mb={3}>待核验包号（{pending.length}）</Heading>
            {pending.length === 0 && <Text color="gray.500" fontSize="sm">队列已清空。</Text>}
            <HStack spacing={1} flexWrap="wrap">
              {pending.map((p) => <Badge key={p.id} colorScheme={statusColor[p.status]} mb={1}>{p.id} · {p.status}</Badge>)}
            </HStack>
          </Box>

          <Box bg="white" border="1px solid" borderColor="gray.200" borderRadius="8px" p={4}>
            <Heading size="sm" mb={3}>阻断原因</Heading>
            {blocked.length === 0 && <Text color="gray.500" fontSize="sm">当前没有阻断。</Text>}
            <Stack spacing={2}>
              {blocked.map((p) => (
                <Box key={p.id} p={2} bg="red.50" borderRadius="6px">
                  <Flex justify="space-between">
                    <Text fontWeight="700" fontSize="sm">{p.id}</Text>
                    <Badge colorScheme={statusColor[p.status]}>{p.status}</Badge>
                  </Flex>
                  <Text color="red.700" fontSize="xs" mt={1}>{p.blockReason ? reasonText[p.blockReason] : '后到版本冲突，等待人工裁定'}</Text>
                  {p.blockDetail && <Text color="gray.600" fontSize="xs" mt={1}>{p.blockDetail}</Text>}
                </Box>
              ))}
            </Stack>
          </Box>

          <Box bg="white" border="1px solid" borderColor="gray.200" borderRadius="8px" p={4}>
            <Heading size="sm" mb={3}>核验日志</Heading>
            <Stack spacing={2} maxH="320px" overflowY="auto">
              {[...s.logs].reverse().slice(0, 18).map((entry, i) => (
                <Box key={i} borderLeft="2px solid" borderLeftColor={entry.level === 'error' ? 'red.400' : entry.level === 'warn' ? 'orange.400' : entry.level === 'success' ? 'green.400' : 'blue.400'} pl={2}>
                  <Text fontWeight="700" fontSize="xs">{entry.event}</Text>
                  <Text color="gray.600" fontSize="xs">{entry.detail}</Text>
                </Box>
              ))}
            </Stack>
          </Box>
        </Stack>
      </Grid>
    </Box>
  )
}
