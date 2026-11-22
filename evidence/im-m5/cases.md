# T14d2 M5 关卡：服务器模式与离线队列 用例与结果

- 脚本：`scripts/im-offline-e2e.ts`
- 里程碑：P1-M5
- 证据目录：`evidence/im-m5`
- 跑完时间：2026-11-22T09:54:19.650Z
- 关卡关闭：是
- 计数：通过 13 / 失败 0 / 阻塞 0 / 跳过 0

| 用例 ID | 验收 | 标题 | 前置 | 状态 | 说明 |
| --- | --- | --- | --- | --- | --- |
| D2-1 | A8（单设备） | 单设备 ACK 后删行 | T8 | ✅ 通过 | 3 项断言通过 |
| D2-2 | A8（多设备） | 两设备各自 ACK、全 ACK 才删 | T8 | ✅ 通过 | 4 项断言通过 |
| D2-3 | A8（撤销） | 撤销设备标 excluded 且不阻塞其余 | T8 | ✅ 通过 | 9 项断言通过 |
| D2-4 | A8（配额与到期） | 30 天到期与全 ACK 先到为准 | T8 | ✅ 通过 | 4 项断言通过 |
| D2-5 | A8 + A14（已读与重发） | 已读关闭不发 read、重发成功后状态正确 | T4b2（未交付） | ✅ 通过 | 11 项断言通过 |
| M5-06 | A8（发送方维度隔离） | 两个发送方复用同一 remoteMessageId：各自建快照、各自 ACK、互不删除 | T8 | ✅ 通过 | 3 项断言通过 |
| M5-07 | A8（共用设备） | 两成员共用一台设备不串收件箱 | T8 | ✅ 通过 | 3 项断言通过 |
| M5-08 | A8（证书过期） | 证书过期标 excluded、其余照常、不自动重发 | T8 | ✅ 通过 | 5 项断言通过 |
| M5-09 | A8（目标快照） | 发送后新增设备不补历史 | T8 | ✅ 通过 | 2 项断言通过 |
| M5-10 | A8（离线暂存） | 离线只暂存密文、上线按序、收下删服务器副本 | T8 | ✅ 通过 | 4 项断言通过 |
| M5-11 | A14 | presence：好友可见在线、非好友不可见、隐身不暴露 | T8 | ✅ 通过 | 10 项断言通过 |
| M5-12 | A14（无最后上线时间） | 任何接口不返回「最后上线时间」 | T8 | ✅ 通过 | 9 项断言通过 |
| M5-13 | A8 + A13（注销） | 注销=deactivate：没接端口即拒 | T8、T2b2（未交付） | ✅ 通过 | 8 项断言通过 |

## 明细

### D2-1 单设备 ACK 后删行

- 验收：A8（单设备）
- 设计/计划出处：design §10 A8、design §6.5 删除规则、design §6.6 时序表
- 状态：✅ 通过（3 项断言通过）
- 步骤 1：接收方只有 1 台已授权设备，发送 1 条离线消息
- 步骤 2：该设备收下并 ACK
- 步骤 3：该消息的全部 queue 行被删除
- 步骤 4：删除后重复 ACK 幂等，不报错、不重复删
- 前置 T8：离线队列 + 取件确认｜落点 `src/backend/im/server-mode.ts`｜已存在
- 通过｜入队成功
- 通过｜取件确认后删服务器副本
- 通过｜重复 ACK 幂等

### D2-2 两设备各自 ACK、全 ACK 才删

- 验收：A8（多设备）
- 设计/计划出处：design §10 A8、design §6.5、design §6.6
- 状态：✅ 通过（4 项断言通过）
- 步骤 1：接收方有 2 台已授权设备，发送 1 条离线消息
- 步骤 2：两台各自收到并各自 ACK
- 步骤 3：只有一台 ACK 时，队列行不删，另一台仍能收到
- 步骤 4：两台都 ACK 后才删除该消息的全部 queue 行
- 步骤 5：同一消息的多设备行在配额里只算一条
- 前置 T8：offline_targets 目标快照｜落点 `src/backend/im/server-mode.ts`｜已存在
- 通过｜两台各自都能取到
- 通过｜只一台 ACK 时另一台不受影响
- 通过｜全 ACK 才删（对照：dev-1 已确认、dev-2 未确认）
- 通过｜两台都 ACK 后全部删除

### D2-3 撤销设备标 excluded 且不阻塞其余

- 验收：A8（撤销）
- 设计/计划出处：design §10 A8、design §6.6 时序表
- 状态：✅ 通过（9 项断言通过）
- 步骤 1：发送后、未 ACK 前撤销其中一台设备
- 步骤 2：该行标 excluded，记 excluded_at 与 audit_id
- 步骤 3：该设备对应的 queue 行随之清理
- 步骤 4：其余设备照常 ACK，全 ACK 后删除，不被撤销设备卡住
- 前置 T8：offline_targets excluded 态｜落点 `src/backend/im/server-mode.ts`｜已存在
- 通过｜offline_targets 表在（快照落点）
- 通过｜快照带 excluded 态与 audit_id 字段｜local_server_id,local_member_id,peer_server_id,peer_agent_id,remote_message_id,recipient_device_id,snapshot_at,state,acked_at,excluded_at,audit_id
- 通过｜撤销设备标 excluded（state / excluded_at / audit_id 三字段齐）｜state=excluded at=1700000000003 audit=audit-ex-1
- 通过｜excluded 后该设备的 queue 行随之清理（design §6.6）
- 通过｜对照：未撤销设备照常取到（不是整条消息谁都取不到）
- 通过｜对照：未撤销设备的目标行不被牵连
- 通过｜excluded 设备的 ACK 被拒（confirm 返回 false）
- 通过｜对照：未撤销设备的 ACK 照常成功
- 通过｜不被撤销设备卡住（只剩 excluded 目标也算结清）

### D2-4 30 天到期与全 ACK 先到为准

- 验收：A8（配额与到期）
- 设计/计划出处：design §10 A8、design §6.6 时序表、design 决策记录 22
- 状态：✅ 通过（4 项断言通过）
- 步骤 1：构造一条 30 天到期、仍有未 ACK 设备的消息
- 步骤 2：到期先到：按消息丢最旧并告知发送方「已过期未全部送达」
- 步骤 3：构造全 ACK 先到的情形：全 ACK 后立即删行，即使未到 30 天
- 步骤 4：再验 500 条上限：超限丢最旧并告知
- 步骤 5：两种上限都按「消息」计，多设备行只算一条
- 前置 T8：离线队列配额与到期｜落点 `src/backend/im/server-mode.ts`｜已存在
- 通过｜上限口径：500 条 / 30 天｜500/2592000000
- 通过｜到期先到：丢最旧并告知发送方｜expired
- 通过｜超限丢弃有可读回报（reason + 是否告知发送方 + 被丢条目）｜over-limit notify=true dropped=1
- 通过｜对照：全 ACK 先到即删行（D2-1 已验）

### D2-5 已读关闭不发 read、重发成功后状态正确

- 验收：A8 + A14（已读与重发）
- 设计/计划出处：design §10 A8、plan §3 T4b2 验收
- 状态：✅ 通过（11 项断言通过）
- 步骤 1：接收方关闭已读回执后收下消息，断言不发出 read
- 步骤 2：开启已读回执后收下消息，断言发出 read
- 步骤 3：制造一次投递失败后触发 resend，重发成功
- 步骤 4：重发成功后状态机回到正确状态，不残留「未送达」也不假报「已读」
- 前置 T4b2：read_state + im:delivery:read|resend
- 通过｜投递失败态可读回（前置用 SQL 造：setDeliveryState 单调不回退，造不出 failed）｜failed
- 通过｜重发成功：回到 submitted 且 attempts+1｜submitted/1
- 通过｜重发成功后状态机回正（不残留未送达、不假报已读）｜null/submitted
- 通过｜对照：已 ack 的不可再重发（ImNotResendable）
- 通过｜收下已读后该条置 read｜read
- 通过｜对照：另一条不被误标已读｜acked
- 通过｜已读水位可读回｜lm-2
- 通过｜关闭已读回执后收下不发 read（receiptSent=false 且不置 read 态）｜receiptSent=false state=submitted
- 通过｜对照：关回执只关「发出」，已读水位照常推进（不是不记录已读）｜lm-3
- 通过｜开启已读回执后收下发 read（receiptSent=true 且置 read 态）｜receiptSent=true state=read
- 通过｜开关按会话级落库（可跨实例读回）

### M5-06 两个发送方复用同一 remoteMessageId：各自建快照、各自 ACK、互不删除

- 验收：A8（发送方维度隔离）
- 设计/计划出处：design §10 A8、design §6.5 R6-B01、design 决策记录 24
- 状态：✅ 通过（3 项断言通过）
- 步骤 1：发送方 P1 与 P2 用同一 remoteMessageId 各发一条离线消息
- 步骤 2：各自建立自己的 offline_targets 目标快照（含 peer_server_id/peer_agent_id）
- 步骤 3：P1 的消息被 ACK 后只删 P1 那组 queue 行
- 步骤 4：P2 的行不受影响，仍可被 ACK
- 步骤 5：P2 ACK 后删自己那组，互不覆盖、互不误删
- 前置 T8：offline_targets 按发送方隔离｜落点 `src/backend/im/server-mode.ts`｜已存在
- 通过｜两个发送方同 remoteMessageId 各自入队
- 通过｜P1 确认后只删自己那组
- 通过｜P2 确认后删自己那组

### M5-07 两成员共用一台设备不串收件箱

- 验收：A8（共用设备）
- 设计/计划出处：design §10 A8
- 状态：✅ 通过（3 项断言通过）
- 步骤 1：成员 M1 与 M2 共用同一台物理设备
- 步骤 2：分别向 M1、M2 发离线消息
- 步骤 3：M1 的收件箱只见发给 M1 的，M2 同理
- 步骤 4：任一方收下并 ACK，不影响另一方的队列行
- 前置 T8：离线队列作用域隔离｜落点 `src/backend/im/server-mode.ts`｜已存在
- 通过｜M1 只见自己的
- 通过｜M2 只见自己的
- 通过｜M1 确认不影响 M2 的队列行

### M5-08 证书过期标 excluded、其余照常、不自动重发

- 验收：A8（证书过期）
- 设计/计划出处：design §6.6 时序表
- 状态：✅ 通过（5 项断言通过）
- 步骤 1：发送后某台设备证书过期且未 ACK
- 步骤 2：该行标 excluded，原因记为证书过期
- 步骤 3：其余设备照常收下与 ACK
- 步骤 4：不对该设备自动重发
- 前置 T8：offline_targets excluded 态｜落点 `src/backend/im/server-mode.ts`｜已存在
- 通过｜快照有 state / excluded_at / audit_id 字段（excluded 态可承载）｜local_server_id,local_member_id,peer_server_id,peer_agent_id,remote_message_id,recipient_device_id,snapshot_at,state,acked_at,excluded_at,audit_id
- 通过｜证书过期→标 excluded 且记 excluded_at｜state=excluded at=1700000000001
- 通过｜excluded 后不自动重发给该设备
- 通过｜excluded 不卡住全 ACK 判定（settled 只数非 excluded 目标）
- 通过｜对照：同一消息的另一台设备照常取到（不是整条消息谁都取不到）

### M5-09 发送后新增设备不补历史

- 验收：A8（目标快照）
- 设计/计划出处：design §6.6 时序表、design 决策记录 22
- 状态：✅ 通过（2 项断言通过）
- 步骤 1：发送离线消息后，接收方新入网一台设备
- 步骤 2：新设备不出现在该消息的目标快照里
- 步骤 3：新设备收不到这条历史消息
- 前置 T8：offline_targets 目标快照｜落点 `src/backend/im/server-mode.ts`｜已存在
- 通过｜新设备不在该消息的目标快照里
- 通过｜新设备收不到历史消息

### M5-10 离线只暂存密文、上线按序、收下删服务器副本

- 验收：A8（离线暂存）
- 设计/计划出处：design §10 A8、design §6.6
- 状态：✅ 通过（4 项断言通过）
- 步骤 1：对方离线时连发 3 条，服务器只暂存密文，不落明文
- 步骤 2：对方上线后按发送顺序收到 3 条
- 步骤 3：收下后服务器删除对应队列行
- 步骤 4：服务器侧看不到消息明文与附件内容
- 前置 T8：离线队列只存密文｜落点 `src/backend/im/server-mode.ts`｜已存在
- 通过｜按发送顺序排列｜rm-1,rm-2,rm-3
- 通过｜只暂存密文（BLOB，不落明文）
- 通过｜服务器侧看不到明文
- 通过｜收下后删服务器副本

### M5-11 presence：好友可见在线、非好友不可见、隐身不暴露

- 验收：A14
- 设计/计划出处：design §10 A14、design 决策记录 8
- 状态：✅ 通过（10 项断言通过）
- 步骤 1：好友视角：能看到在线状态
- 步骤 2：非好友视角：看不到在线状态
- 步骤 3：隐身状态：对好友也不暴露
- 步骤 4：presence 三档（online/away/offline）切换正确、有节流
- 前置 T8：在线状态隐私｜落点 `src/backend/im/server-mode.ts`｜已存在
- 通过｜节流口径为 30 秒栅格｜30000
- 通过｜好友可见在线
- 通过｜非好友不可见（im.notFriend）
- 通过｜对照：内部状态立即生效（current() 当场就是隐身）
- 通过｜30 秒栅格内对外读不到切换时刻（poller 抓不到隐身那一瞬）
- 通过｜隐身不暴露（栅格过后对好友也报 offline）
- 通过｜解除隐身后对外恢复可见
- 通过｜三档切换逐档可读回（online/away/offline）
- 通过｜对照：非好友始终被拒（不是只拦第一次）
- 通过｜对照：三档切换不影响好友可见性（可见性闸只看好友关系）

### M5-12 任何接口不返回「最后上线时间」

- 验收：A14（无最后上线时间）
- 设计/计划出处：design §10 A14、design 决策记录 8
- 状态：✅ 通过（9 项断言通过）
- 步骤 1：遍历 presence / 资料 / 搜索 / 好友相关接口
- 步骤 2：断言响应里不含「最后上线时间」
- 步骤 3：含 host route 与 remote 侧接口
- 前置 T8：读回对象不含最后上线时间｜落点 `src/backend/im/server-mode.ts`｜已存在
- 通过｜读回对象键集正好四项、无最后上线时间｜hidden,peerAgentId,peerServerId,state
- 通过｜隐身 update 的返回值同样不含最后上线时间
- 通过｜host route 已接（IM_HANDLED_PATHS 含 presence 两条）
- 通过｜host route 读回不含最后上线时间｜hidden,peerAgentId,peerServerId,state
- 通过｜对照：读回确实有数据（不是空结果才没字段）
- 通过｜隐身接口只回 hidden（不带任何时间戳）
- 通过｜资料接口不含最后上线时间
- 通过｜搜索接口不含最后上线时间｜peerServerId,peerAgentId,displayName,searchable
- 通过｜好友接口不含最后上线时间｜contactId,peerServerId,peerAgentId,alias,state,addedAt,source,updatedAt

### M5-13 注销=deactivate：没接端口即拒

- 验收：A8 + A13（注销）
- 设计/计划出处：design 决策记录 8、plan §3 T2b2 验收
- 状态：✅ 通过（8 项断言通过）
- 步骤 1：资料注销后在搜索里消失
- 步骤 2：注销即清空该成员的离线队列
- 步骤 3：撤销其设备证书
- 步骤 4：注销动作本身写审计
- 前置 T8：ImDirectoryStore 走 T2b1/T2b2 端口｜落点 `src/backend/im/server-mode.ts`｜已存在
- 前置 T2b2：资料注销本体：清队列 + 撤销设备证书
- 通过｜没接端口就拒（本任务不实现注册/deactivate 本体）
- 通过｜只读 profile 不需要端口
- 通过｜没接端口即拒：deactivate 抛 im.notRegistered
- 通过｜对照：被拒时队列与设备都没动（拒绝不是静默半成功）
- 通过｜接上端口后注销成功｜true
- 通过｜注销清空离线队列｜queueCleared=1
- 通过｜注销清空目标快照｜targetsCleared=2
- 通过｜注销撤销全部设备证书（状态转 revoked）｜devicesRevoked=3

