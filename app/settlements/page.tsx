'use client'

import { useMemo, useState } from 'react'
import {
  Box, Flex, Grid, Heading, Text, Badge, Button, Table, Thead, Tbody, Tr, Th, Td, Tabs, TabList, Tab, TabPanels, TabPanel,
  useToast, HStack, Select, Alert, AlertIcon, Stat, StatLabel, StatNumber, StatHelpText, Tag, Divider, Code,
} from '@chakra-ui/react'
import { useSettlementStore } from '@/store/settlement'
import { batchTotals, diffSources } from '@/lib/settlement'
import { trpc } from '@/trpc/client'
import type { MatchStatus, PackageStatus, ReturnLine } from '@/lib/types'

const statusColor: Record<PackageStatus, string> = {
  已入账: 'green',
  待核验: 'orange',
  已阻断: 'red',
  处理失败: 'purple',
  排队中: 'gray',
}

const matchColor: Record<MatchStatus, string> = {
  matched: 'green',
  backfilled: 'teal',
  expired: 'red',
  'not-open': 'orange',
  'no-auth': 'red',
  'exclusive-conflict': 'red',
  legacy: 'gray',
}

const matchLabel: Record<MatchStatus, string> = {
  matched: '已匹配',
  backfilled: '已回填',
  expired: '窗口过期',
  'not-open': '窗口未开',
  'no-auth': '无授权',
  'exclusive-conflict': '独占冲突',
  legacy: '待回填',
}

function fmt(n: number): string {
  return n.toLocaleString('zh-CN')
}

export default function SettlementsPage() {
  const toast = useToast()
  const {
    snapshots, packages, lines, batches, confirmedPackageNo, lastError,
    submitReturn, resumeProcessing, verifyPackage, simulateFailure,
    applyWindowChange, backfillLegacy, confirmBatch, reset,
  } = useSettlementStore()
  const [tab, setTab] = useState(0)
  const [lineFilter, setLineFilter] = useState<'全部' | '已入账' | '待核验' | '已阻断'>('全部')
  const [serverVerifyNo, setServerVerifyNo] = useState('')
  const verifyMutation = trpc.settlement.verify.useMutation()

  const stats = useMemo(() => {
    const recorded = lines.filter((l) => l.status === '已入账')
    const blocked = lines.filter((l) => l.status === '已阻断')
    return {
      pending: packages.filter((p) => p.status === '待核验').length,
      blocked: packages.filter((p) => p.status === '已阻断').length,
      failed: packages.filter((p) => p.status === '处理失败').length,
      recordedShare: recorded.reduce((sum, l) => sum + (l.shareAmount ?? 0), 0),
      blockedAmount: blocked.reduce((sum, l) => sum + l.gross, 0),
      recordedCount: recorded.length,
    }
  }, [packages, lines])

  const filteredLines = useMemo(
    () => (lineFilter === '全部' ? lines : lines.filter((l) => l.status === lineFilter)),
    [lines, lineFilter],
  )
  const diffs = useMemo(() => diffSources(lines), [lines])
  const pendingPkgs = packages.filter((p) => p.status === '待核验')
  const failedPkgs = packages.filter((p) => p.status === '处理失败')

  function runServerVerify() {
    if (!serverVerifyNo) return
    const pkg = packages.find((p) => p.packageNo === serverVerifyNo)
    if (!pkg) return
    verifyMutation.mutate({
      pkg,
      lines: lines.filter((l) => l.packageNo === serverVerifyNo),
      seen: packages.filter((p) => p.status === '已入账').map((p) => p.packageNo),
    })
  }

  return (
    <Box>
      <Flex justify="space-between" mb={5} gap={4} direction={{ base: 'column', md: 'row' }}>
        <Box>
          <Text color="brand.600" fontSize="xs" fontWeight="bold">SETTLEMENT VERIFICATION</Text>
          <Heading fontSize={{ base: '2xl', md: '3xl' }} my={1}>实收分成核验台</Heading>
          <Text color="gray.600">回传到达时按作品、地区、渠道匹配有效授权快照；窗口变更只重算受影响分成行；包号排队、重复只入账一次、失败从已确认包号恢复。</Text>
        </Box>
        <HStack flexWrap="wrap">
          <Button size="sm" variant="outline" onClick={() => {
            submitReturn({ agent: '海岛航空发行', region: '东南亚区域', refVersion: 1, lines: [{ workId: 'W-002', work: '《深港口岸》', channel: '海岛航空', territory: '东南亚区域', periodStart: '2027-03-01', periodEnd: '2027-03-31', gross: 180000 }] }, 'PKG-2026-010')
            submitReturn({ agent: '星海院线发行', region: '中国大陆', refVersion: 1, lines: [{ workId: 'W-001', work: '《远山回声》', channel: '星海影院', territory: '中国大陆', periodStart: '2026-11-01', periodEnd: '2026-11-30', gross: 980000 }] }, 'PKG-2026-009')
            toast({ title: '两笔回传同时提交', description: '已按包号排队：PKG-2026-009 先于 PKG-2026-010 核验', status: 'info' })
          }}>模拟两笔回传同时提交（包号排队）</Button>
          <Button size="sm" variant="outline" colorScheme="red" onClick={() => {
            submitReturn({ agent: '星海院线发行', region: '中国大陆', refVersion: 1, lines: [{ workId: 'W-001', work: '《远山回声》', channel: '星海影院', territory: '中国大陆', periodStart: '2026-11-01', periodEnd: '2026-11-30', gross: 1200000 }] }, 'PKG-2026-001')
            toast({ title: '重复包号已阻断', description: 'PKG-2026-001 已入账，重复回传只入账一次', status: 'warning' })
          }}>模拟重复包号</Button>
          <Button size="sm" variant="outline" colorScheme="purple" onClick={() => { simulateFailure('PKG-2026-005'); toast({ title: '已模拟处理失败', description: 'PKG-2026-005 处理失败，队列暂停', status: 'warning' }) }}>模拟处理失败</Button>
          <Button size="sm" colorScheme="purple" onClick={() => { const n = resumeProcessing(); toast({ title: '已从已确认包号恢复', description: `重算 ${n} 笔待处理包，未重复入账`, status: 'success' }) }}>从已确认包号恢复</Button>
          <Button size="sm" variant="outline" colorScheme="teal" onClick={() => { backfillLegacy(); toast({ title: '旧数据已按原签署日期回填', description: '2025 年历史分成仍可查', status: 'success' }) }}>按签署日期回填旧数据</Button>
          <Button size="sm" variant="outline" colorScheme="blue" onClick={() => { applyWindowChange('RW-102', { end: '2028-11-19' }); toast({ title: '窗口变更：只重算受影响分成行', description: '仅 RW-102 相关行重算，其他代理人照旧', status: 'info' }) }}>窗口变更重算</Button>
          <Button size="sm" variant="ghost" onClick={() => { reset(); toast({ title: '已重置核验数据', status: 'info' }) }}>重置</Button>
        </HStack>
      </Flex>

      {lastError && (
        <Alert status="error" mb={4} borderRadius="8px">
          <AlertIcon />
          <Box><Text fontWeight="700">核验阻断</Text><Text fontSize="sm">{lastError}（已确认包号：{confirmedPackageNo ?? '—'}）</Text></Box>
        </Alert>
      )}

      <Grid templateColumns={{ base: 'repeat(2,1fr)', lg: 'repeat(4,1fr)' }} gap={4} mb={5}>
        <Stat bg="white" border="1px solid" borderColor="gray.200" borderRadius="8px" p={4}>
          <StatLabel color="gray.500">待核验包号</StatLabel>
          <StatNumber color="orange.500">{stats.pending}</StatNumber>
          <StatHelpText>后到版本冲突，留待核验</StatHelpText>
        </Stat>
        <Stat bg="white" border="1px solid" borderColor="gray.200" borderRadius="8px" p={4}>
          <StatLabel color="gray.500">阻断金额（不计入分成）</StatLabel>
          <StatNumber color="red.500">¥{fmt(stats.blockedAmount)}</StatNumber>
          <StatHelpText>{stats.blocked} 个包被阻断</StatHelpText>
        </Stat>
        <Stat bg="white" border="1px solid" borderColor="gray.200" borderRadius="8px" p={4}>
          <StatLabel color="gray.500">已入账分成</StatLabel>
          <StatNumber color="green.600">¥{fmt(stats.recordedShare)}</StatNumber>
          <StatHelpText>{stats.recordedCount} 行已确认</StatHelpText>
        </Stat>
        <Stat bg="white" border="1px solid" borderColor="gray.200" borderRadius="8px" p={4}>
          <StatLabel color="gray.500">处理失败 / 已确认</StatLabel>
          <StatNumber color="purple.500">{stats.failed} / {confirmedPackageNo ?? '—'}</StatNumber>
          <StatHelpText>从已确认包号继续恢复</StatHelpText>
        </Stat>
      </Grid>

      <Tabs colorScheme="blue" variant="enclosed" index={tab} onChange={setTab}>
        <TabList>
          <Tab>回传包队列</Tab>
          <Tab>分成行明细</Tab>
          <Tab>结算批次</Tab>
          <Tab>差异来源与阻断</Tab>
        </TabList>
        <TabPanels>
          <TabPanel px={0} pt={4}>
            <Grid templateColumns={{ base: '1fr', xl: '1.6fr .9fr' }} gap={4}>
              <Box bg="white" border="1px solid" borderColor="gray.200" borderRadius="8px" overflow="hidden">
                <Flex p={4} justify="space-between" align="center">
                  <Box><Heading size="md">回传包队列</Heading><Text color="gray.500" fontSize="sm">以包号排队，重复包号只入账一次</Text></Box>
                  <HStack><Badge colorScheme="orange">{pendingPkgs.length} 待核验</Badge><Badge colorScheme="purple">{failedPkgs.length} 失败</Badge></HStack>
                </Flex>
                <Box overflowX="auto">
                  <Table size="sm">
                    <Thead><Tr><Th>包号</Th><Th>代理 / 地区</Th><Th>提交时间</Th><Th>状态</Th><Th>确认时间</Th><Th>阻断 / 核验原因</Th><Th>操作</Th></Tr></Thead>
                    <Tbody>
                      {packages.map((pkg) => (
                        <Tr key={pkg.packageNo} bg={pkg.status === '待核验' ? 'orange.50' : pkg.status === '处理失败' ? 'purple.50' : undefined}>
                          <Td><Code fontSize="xs">{pkg.packageNo}</Code>{pkg.refVersion != null && <Tag size="sm" ml={2}>v{pkg.refVersion}</Tag>}</Td>
                          <Td><Text fontWeight="600">{pkg.agent}</Text><Text color="gray.500" fontSize="xs">{pkg.region}</Text></Td>
                          <Td fontSize="xs" color="gray.500">{pkg.submittedAt.replace('T', ' ').slice(0, 16)}</Td>
                          <Td><Badge colorScheme={statusColor[pkg.status]}>{pkg.status}</Badge></Td>
                          <Td fontSize="xs" color="gray.500">{pkg.confirmedAt ? pkg.confirmedAt.replace('T', ' ').slice(0, 16) : '—'}</Td>
                          <Td fontSize="xs" color={pkg.blockingReason ? 'red.600' : 'gray.500'} maxW="280px">{pkg.blockingReason ?? '—'}</Td>
                          <Td>
                            {(pkg.status === '待核验' || pkg.status === '已阻断') && (
                              <Button size="xs" variant="outline" colorScheme="blue" onClick={() => { verifyPackage(pkg.packageNo); toast({ title: '已重新核验', description: pkg.packageNo, status: 'info' }) }}>重新核验</Button>
                            )}
                            {pkg.status === '处理失败' && (
                              <Button size="xs" colorScheme="purple" onClick={() => { resumeProcessing(); toast({ title: '已从已确认包号恢复', status: 'success' }) }}>恢复</Button>
                            )}
                          </Td>
                        </Tr>
                      ))}
                    </Tbody>
                  </Table>
                </Box>
              </Box>

              <Box bg="white" border="1px solid" borderColor="gray.200" borderRadius="8px" p={4}>
                <Heading size="md" mb={1}>服务端核验台</Heading>
                <Text color="gray.500" fontSize="sm" mb={3}>无状态核验：选择回传包，服务端按当前有效快照给出核验结论，不落库。</Text>
                <Select size="sm" value={serverVerifyNo} onChange={(e) => setServerVerifyNo(e.target.value)} placeholder="选择回传包号" mb={3}>
                  {packages.map((p) => <option key={p.packageNo} value={p.packageNo}>{p.packageNo} · {p.agent}</option>)}
                </Select>
                <Button size="sm" colorScheme="blue" w="100%" onClick={runServerVerify} isDisabled={!serverVerifyNo || verifyMutation.isPending}>服务端核验</Button>
                {verifyMutation.data && (
                  <Box mt={3} p={3} bg="gray.50" borderRadius="6px" borderLeft="3px solid" borderLeftColor={statusColor[verifyMutation.data.status] ? `${statusColor[verifyMutation.data.status]}.500` : 'gray.300'}>
                    <HStack justify="space-between"><Text fontWeight="700" fontSize="sm">核验结论</Text><Badge colorScheme={statusColor[verifyMutation.data.status]}>{verifyMutation.data.status}</Badge></HStack>
                    {verifyMutation.data.blockingReason && <Text fontSize="xs" color="red.600" mt={2}>{verifyMutation.data.blockingReason}</Text>}
                    <Text fontSize="xs" color="gray.500" mt={2}>核验行：{verifyMutation.data.lines.length} · 已入账 {verifyMutation.data.lines.filter((l) => l.status === '已入账').length} · 阻断 {verifyMutation.data.lines.filter((l) => l.status === '已阻断').length}</Text>
                  </Box>
                )}
              </Box>
            </Grid>
          </TabPanel>

          <TabPanel px={0} pt={4}>
            <Box bg="white" border="1px solid" borderColor="gray.200" borderRadius="8px" overflow="hidden">
              <Flex p={4} justify="space-between" align="center">
                <Box><Heading size="md">分成行明细</Heading><Text color="gray.500" fontSize="sm">每行匹配授权快照，差异来源与阻断原因逐行标注</Text></Box>
                <Select size="sm" w="140px" value={lineFilter} onChange={(e) => setLineFilter(e.target.value as typeof lineFilter)}>
                  <option value="全部">全部状态</option><option value="已入账">已入账</option><option value="待核验">待核验</option><option value="已阻断">已阻断</option>
                </Select>
              </Flex>
              <Box overflowX="auto">
                <Table size="sm">
                  <Thead><Tr><Th>包号</Th><Th>作品 / 渠道</Th><Th>地区</Th><Th>收入期间</Th><Th isNumeric>实收</Th><Th>快照</Th><Th>匹配状态</Th><Th>差异来源</Th><Th isNumeric>分成</Th><Th>状态</Th></Tr></Thead>
                  <Tbody>
                    {filteredLines.map((line) => (
                      <Tr key={line.id} bg={line.status === '已阻断' ? 'red.50' : line.status === '待核验' ? 'orange.50' : undefined}>
                        <Td><Code fontSize="xs">{line.packageNo}</Code>{line.backfilled && <Tag size="sm" ml={2} colorScheme="teal">回填</Tag>}</Td>
                        <Td><Text fontWeight="600">{line.work}</Text><Text color="gray.500" fontSize="xs">{line.channel}</Text></Td>
                        <Td fontSize="xs">{line.territory}</Td>
                        <Td fontSize="xs" color="gray.600">{line.periodStart} → {line.periodEnd}</Td>
                        <Td isNumeric fontSize="xs">¥{fmt(line.gross)}</Td>
                        <Td fontSize="xs">{line.snapshotId ? <><Code fontSize="xs">{line.snapshotId}</Code>{line.snapshotVersion != null && <Tag size="sm" ml={1}>v{line.snapshotVersion}</Tag>}</> : '—'}</Td>
                        <Td><Badge colorScheme={matchColor[line.matchStatus]}>{matchLabel[line.matchStatus]}</Badge></Td>
                        <Td fontSize="xs" color={line.diffReason ? 'red.600' : 'gray.400'} maxW="300px">{line.diffReason ?? '—'}</Td>
                        <Td isNumeric fontSize="xs" fontWeight="600" color={line.shareAmount ? 'green.700' : 'gray.400'}>{line.shareAmount ? `¥${fmt(line.shareAmount)}` : '—'}</Td>
                        <Td><Badge colorScheme={statusColor[line.status]}>{line.status}</Badge></Td>
                      </Tr>
                    ))}
                  </Tbody>
                </Table>
              </Box>
            </Box>
          </TabPanel>

          <TabPanel px={0} pt={4}>
            <Grid templateColumns={{ base: '1fr', lg: 'repeat(3,1fr)' }} gap={4}>
              {batches.map((batch) => {
                const totals = batchTotals(batch, packages, lines)
                return (
                  <Box key={batch.id} bg="white" border="1px solid" borderColor="gray.200" borderRadius="8px" p={4}>
                    <Flex justify="space-between" align="flex-start" mb={2}>
                      <Box><Heading size="md">{batch.name}</Heading><Text color="gray.500" fontSize="xs">{batch.id} · {batch.period}</Text></Box>
                      <Badge colorScheme={batch.status === '已确认' ? 'green' : batch.status === '待核验' ? 'orange' : 'gray'}>{batch.status}</Badge>
                    </Flex>
                    <Divider my={2} />
                    <Grid templateColumns="1fr 1fr" gap={2} fontSize="sm">
                      <Box><Text color="gray.500" fontSize="xs">包号数</Text><Text fontWeight="600">{totals.packageCount}</Text></Box>
                      <Box><Text color="gray.500" fontSize="xs">已入账 / 待核验</Text><Text fontWeight="600">{totals.recordedCount} / {totals.pendingCount}</Text></Box>
                      <Box><Text color="gray.500" fontSize="xs">实收合计</Text><Text fontWeight="600">¥{fmt(totals.totalGross)}</Text></Box>
                      <Box><Text color="gray.500" fontSize="xs">分成合计</Text><Text fontWeight="600" color="green.700">¥{fmt(totals.totalShare)}</Text></Box>
                      <Box gridColumn="span 2"><Text color="gray.500" fontSize="xs">阻断金额（不计入应付）</Text><Text fontWeight="600" color="red.600">¥{fmt(totals.blockedAmount)}</Text></Box>
                    </Grid>
                    <Text color="gray.500" fontSize="xs" mt={2}>包号：{batch.packageNos.join('、')}</Text>
                    <Button size="sm" w="100%" mt={3} variant="outline" colorScheme="blue" onClick={() => { confirmBatch(batch.id); toast({ title: '批次已复核', description: `${batch.id} 含阻断/待核验包，状态保持待核验`, status: 'info' }) }}>复核批次</Button>
                  </Box>
                )
              })}
            </Grid>
          </TabPanel>

          <TabPanel px={0} pt={4}>
            <Grid templateColumns={{ base: '1fr', lg: '1fr 1fr' }} gap={4}>
              <Box bg="white" border="1px solid" borderColor="gray.200" borderRadius="8px" p={4}>
                <Heading size="md" mb={1}>差异来源</Heading>
                <Text color="gray.500" fontSize="sm" mb={3}>按匹配状态汇总被阻断/待核验的收入行</Text>
                {diffs.length === 0 && <Text color="gray.400" fontSize="sm">暂无差异</Text>}
                {diffs.map((d) => (
                  <Box key={d.status} p={3} mb={3} bg="red.50" borderLeft="3px solid" borderLeftColor="red.500" borderRadius="6px">
                    <Flex justify="space-between" align="center">
                      <HStack><Badge colorScheme={matchColor[d.status]}>{matchLabel[d.status]}</Badge><Text fontWeight="700" fontSize="sm">{d.count} 行</Text></HStack>
                      <Text fontSize="sm" color="red.600" fontWeight="600">¥{fmt(d.amount)}</Text>
                    </Flex>
                    {d.reasons.map((reason, i) => <Text key={i} fontSize="xs" color="gray.600" mt={1}>{reason}</Text>)}
                  </Box>
                ))}
              </Box>

              <Box bg="white" border="1px solid" borderColor="gray.200" borderRadius="8px" p={4}>
                <Heading size="md" mb={1}>待核验包号与阻断原因</Heading>
                <Text color="gray.500" fontSize="sm" mb={3}>后到版本冲突先留待核验，阻断原因逐包列明</Text>
                {pendingPkgs.length === 0 && failedPkgs.length === 0 && <Text color="gray.400" fontSize="sm">暂无待核验包号</Text>}
                {pendingPkgs.map((pkg) => (
                  <Box key={pkg.packageNo} p={3} mb={3} bg="orange.50" borderLeft="3px solid" borderLeftColor="orange.400" borderRadius="6px">
                    <Flex justify="space-between" align="center"><HStack><Code fontSize="xs">{pkg.packageNo}</Code><Badge colorScheme="orange">待核验</Badge></HStack><Button size="xs" variant="outline" onClick={() => verifyPackage(pkg.packageNo)}>重新核验</Button></Flex>
                    <Text fontSize="xs" color="gray.600" mt={2}>{pkg.blockingReason}</Text>
                  </Box>
                ))}
                {failedPkgs.map((pkg) => (
                  <Box key={pkg.packageNo} p={3} mb={3} bg="purple.50" borderLeft="3px solid" borderLeftColor="purple.400" borderRadius="6px">
                    <Flex justify="space-between" align="center"><HStack><Code fontSize="xs">{pkg.packageNo}</Code><Badge colorScheme="purple">处理失败</Badge></HStack><Button size="xs" colorScheme="purple" onClick={() => resumeProcessing()}>从已确认包号恢复</Button></Flex>
                    <Text fontSize="xs" color="gray.600" mt={2}>{pkg.blockingReason}</Text>
                  </Box>
                ))}
              </Box>
            </Grid>
          </TabPanel>
        </TabPanels>
      </Tabs>
    </Box>
  )
}
