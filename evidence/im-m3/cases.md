# T14c M3 关卡：安全闸门收口 用例与结果

- 脚本：`scripts/im-security-e2e.ts`
- 里程碑：P0-M3
- 证据目录：`evidence/im-m3`
- 跑完时间：2026-11-22T09:54:17.382Z
- 关卡关闭：是
- 计数：通过 17 / 失败 0 / 阻塞 0 / 跳过 0

| 用例 ID | 验收 | 标题 | 前置 | 状态 | 说明 |
| --- | --- | --- | --- | --- | --- |
| SEC-01 | A1（闸门判定） | A1 闸门判定：外部链禁用工具、只回文本 | T5 | ✅ 通过 | 13 项断言通过 |
| SEC-02 | A1（审计） | A1 审计带 causal_chain_id | T12a1（未交付） | ✅ 通过 | 6 项断言通过 |
| SEC-03 | A2（继承） | A2 派生委派/子任务继承因果链与信任域，工具仍禁用 | T5 | ✅ 通过 | 10 项断言通过 |
| SEC-04 | A2（重启后） | A2 进程重启后仍禁用（因果链落库后重开同判） | T5 | ✅ 通过 | 4 项断言通过 |
| SEC-05 | A2（队列恢复后） | A2 队列恢复后仍禁用 | T5 | ✅ 通过 | 10 项断言通过 |
| SEC-06 | A3（approval） | A3 approval 一律被拒 | T5 | ✅ 通过 | 4 项断言通过 |
| SEC-07 | A3（stop 边界） | A3 外部 stop 只停该外部会话的回复 | T5 | ✅ 通过 | 5 项断言通过 |
| SEC-08 | A3（运行时入口） | A3 频道任务/工作流步骤/InboundAction 入口同闸门 | T5（未交付） | ✅ 通过 | 14 项断言通过 |
| SEC-09 | A4（本地记忆） | A4 上下文隔离：不含本地记忆 | T5 | ✅ 通过 | 3 项断言通过 |
| SEC-10 | A4（工作区） | A4 上下文隔离：不含工作区文件与工作区指令 | T5 | ✅ 通过 | 3 项断言通过 |
| SEC-11 | A4（CRM/资料库） | A4 上下文隔离：不含 CRM 与资料库内容 | T5 | ✅ 通过 | 4 项断言通过 |
| SEC-12 | A4（其他会话） | A4 上下文隔离：不含其他会话历史与技能输出 | T5 | ✅ 通过 | 4 项断言通过 |
| SEC-13 | A4（默认拒绝） | A4 默认拒绝：缺因果链与非白名单上下文一律不放行 | T5 | ✅ 通过 | 4 项断言通过 |
| SEC-14 | A1–A4（授权点） | 授权点唯一裁决：外部信任域一律禁工具，不继承工作区发言人信任 | T5 | ✅ 通过 | 7 项断言通过 |
| SEC-15 | A4（白名单） | 外部上下文白名单恰为三类且带来源标记 | T5 | ✅ 通过 | 4 项断言通过 |
| SEC-16 | A1–A4（默认拒绝语义） | authorizeToolCall 三态：缺声明默认拒绝、显式本地放行、外部拒工具 | T5 | ✅ 通过 | 8 项断言通过 |
| SEC-17 | A2（注册表） | CausalChainRegistry：声明/读回/派生继承/未声明默认拒绝 | T5 | ✅ 通过 | 12 项断言通过 |

## 明细

### SEC-01 A1 闸门判定：外部链禁用工具、只回文本

- 验收：A1（闸门判定）
- 设计/计划出处：design §10 A1、plan §3 T5 验收、src/backend/im/causal-chain.ts toolsDecision
- 状态：✅ 通过（13 项断言通过）
- 步骤 1：外部信任域（im-peer/im-proxy/third-party）的因果链进来
- 步骤 2：断言 mayUseTools 为 false
- 步骤 3：断言 toolsDecision 的 toolsEnabled 为 false 且允许回文本
- 步骤 4：断言 reply 动作允许但 toolsEnabled 为 false（只回文本）
- 前置 T5：安全闸门：因果链继承与默认拒绝｜落点 `src/backend/im/causal-chain.ts`｜已存在
- 通过｜外部信任域 im-peer 禁用工具
- 通过｜im-peer 的 toolsEnabled 为 false
- 通过｜im-peer 允许回文本
- 通过｜im-peer 的 reply 只回文本
- 通过｜外部信任域 im-proxy 禁用工具
- 通过｜im-proxy 的 toolsEnabled 为 false
- 通过｜im-proxy 允许回文本
- 通过｜im-proxy 的 reply 只回文本
- 通过｜外部信任域 third-party 禁用工具
- 通过｜third-party 的 toolsEnabled 为 false
- 通过｜third-party 允许回文本
- 通过｜third-party 的 reply 只回文本
- 通过｜A1 闸门判定：外部输入禁用工具、只回文本

### SEC-02 A1 审计带 causal_chain_id

- 验收：A1（审计）
- 设计/计划出处：design §10 A1、plan §3 T12a1 验收
- 状态：✅ 通过（6 项断言通过）
- 步骤 1：外部消息被处理后，审计条目必须带 causal_chain_id
- 步骤 2：信任域标为外部
- 步骤 3：脱敏后写入、不可变
- 前置 T12a1：审计写入：不可变事件、写入前脱敏、audit_log 只追加
- 通过｜信任域标为外部｜im-peer
- 通过｜写入前脱敏：密钥类键名被脱敏
- 通过｜审计带 causal_chain_id 一等字段并可读回｜causalChainId=chain-ext-1
- 通过｜只追加：同 id 再写被拒且原事件未被篡改
- 通过｜audit_log 含 redacted_detail 列｜action,actor_id,after,at,before,causal_chain_id,correlation_id,id,local_member_id,local_server_id,redacted_detail,result,source_trust_domain,target_id
- 通过｜audit_log 有一等列 causal_chain_id｜action,actor_id,after,at,before,causal_chain_id,correlation_id,id,local_member_id,local_server_id,redacted_detail,result,source_trust_domain,target_id

### SEC-03 A2 派生委派/子任务继承因果链与信任域，工具仍禁用

- 验收：A2（继承）
- 设计/计划出处：design §10 A2、src/backend/im/causal-chain.ts inheritedChain
- 状态：✅ 通过（10 项断言通过）
- 步骤 1：从外部链派生一个委派或子任务
- 步骤 2：断言继承 chainId、rootMessageId、trustDomain
- 步骤 3：断言派生物仍是外部链、工具仍禁用
- 步骤 4：二级派生同样继承信任域，不因派生升级为本地
- 步骤 5：父链缺失时派生必须抛错（默认拒绝）
- 前置 T5：因果链继承｜落点 `src/backend/im/causal-chain.ts`｜已存在
- 通过｜派生继承 chainId｜chain-ext-1
- 通过｜派生继承 rootMessageId
- 通过｜派生继承 trustDomain
- 通过｜派生仍是外部链
- 通过｜派生后工具仍禁用
- 通过｜派生后 toolsEnabled 仍为 false
- 通过｜二级派生继承信任域
- 通过｜二级派生工具仍禁用
- 通过｜二级派生可带自己的 chainId｜chain-derived-2
- 通过｜父链缺失时派生默认拒绝｜CausalChainMissing

### SEC-04 A2 进程重启后仍禁用（因果链落库后重开同判）

- 验收：A2（重启后）
- 设计/计划出处：design §10 A2、plan §2 P0-M3 出口、src/backend/migrations/0068-im-causal-chain.ts
- 状态：✅ 通过（4 项断言通过）
- 步骤 1：把外部因果链写进真实迁移后的 causal_chains 表
- 步骤 2：关掉连接（模拟进程重启）
- 步骤 3：重开连接读回同一条链
- 步骤 4：断言判定与重启前一致：工具仍禁用、toolsEnabled 仍 false
- 前置 T5：因果链持久化 + 重启后判定不变｜落点 `src/backend/im/causal-chain.ts`｜已存在
- 通过｜重启后因果链仍在库里
- 通过｜重启后工具仍禁用
- 通过｜重启后 toolsEnabled 仍为 false
- 通过｜重启前后判定一致

### SEC-05 A2 队列恢复后仍禁用

- 验收：A2（队列恢复后）
- 设计/计划出处：design §10 A2、plan §2 P0-M3 出口
- 状态：✅ 通过（10 项断言通过）
- 步骤 1：把外部消息压入待处理队列后中断执行
- 步骤 2：触发队列恢复/崩溃恢复
- 步骤 3：恢复后继续处理，工具仍然禁用，不得因为重新入队而丢掉因果链
- 前置 T5：安全闸门｜落点 `src/backend/im/causal-chain.ts`｜已存在
- 通过｜外部因果链写进队列｜b6755621
- 通过｜对照组：本地因果链也写进队列｜2f696b15
- 通过｜因果链落到持久化投递记录｜chain-external-1
- 通过｜重启后队列恢复、外部因果链仍在｜chain-external-1
- 通过｜对照组：重启后本地因果链同样仍在｜chain-local-1
- 通过｜恢复后闸门仍读到外部链｜{"chainId":"chain-external-1","rootMessageId":"m-1","trustDomain":"im-peer","createdAt":1795341257207}
- 通过｜恢复后外部链工具仍禁用
- 通过｜对照组：恢复后本地链工具仍可用
- 通过｜恢复后缺声明仍默认拒绝
- 通过｜恢复后派生仍继承外部链且禁工具

### SEC-06 A3 approval 一律被拒

- 验收：A3（approval）
- 设计/计划出处：design §10 A3、src/backend/im/causal-chain.ts decideInboundAction
- 状态：✅ 通过（4 项断言通过）
- 步骤 1：外部消息触发 approval 动作
- 步骤 2：断言一律被拒、reason 为 im.unauthorized、toolsEnabled 为 false
- 步骤 3：本地链下的 approval 同样被拒（不因信任域高就放行）
- 前置 T5：InboundAction 边界｜落点 `src/backend/im/causal-chain.ts`｜已存在
- 通过｜approval 在 im-peer 下被拒｜{"allowed":false,"reason":"im.unauthorized","toolsEnabled":false}
- 通过｜approval 在 local 下被拒｜{"allowed":false,"reason":"im.unauthorized","toolsEnabled":false}
- 通过｜approval 在 无链 下被拒｜{"allowed":false,"reason":"im.unauthorized","toolsEnabled":false}
- 通过｜A3 approval 一律被拒

### SEC-07 A3 外部 stop 只停该外部会话的回复

- 验收：A3（stop 边界）
- 设计/计划出处：design §10 A3、src/backend/im/causal-chain.ts decideInboundAction
- 状态：✅ 通过（5 项断言通过）
- 步骤 1：stop 指向自己的会话回复 → 允许
- 步骤 2：stop 指向本地任务 → 拒绝
- 步骤 3：stop 指向其他会话 → 拒绝
- 步骤 4：stop 指向系统进程 → 拒绝
- 前置 T5：InboundAction stop 边界｜落点 `src/backend/im/causal-chain.ts`｜已存在
- 通过｜stop 自己会话的回复被允许
- 通过｜stop 本地任务被拒
- 通过｜stop 其他会话被拒
- 通过｜stop 系统进程被拒
- 通过｜stop 自己会话但目标不是自己也拒

### SEC-08 A3 频道任务/工作流步骤/InboundAction 入口同闸门

- 验收：A3（运行时入口）
- 设计/计划出处：design §10 A3、plan §3 T5 验收
- 状态：✅ 通过（14 项断言通过）
- 步骤 1：外部消息进入频道任务，断言工具禁用
- 步骤 2：外部消息进入工作流步骤，断言工具禁用
- 步骤 3：外部消息触发 InboundAction，断言工具禁用
- 步骤 4：三种入口发起 approval 都被拒
- 前置 T5：各任务表 causal_chain_id 落点写入与继承接线（委派/子任务/频道任务/工作流步骤/mailbox delivery）
- 通过｜InboundAction 入口：允许回文本但工具禁用｜{"allowed":true,"reason":null,"toolsEnabled":false}
- 通过｜InboundAction 入口：approval 被拒
- 通过｜mailbox delivery 落点把因果链写进投递记录
- 通过｜mailbox delivery 落点入口同闸门：工具禁用
- 通过｜对照组：本地链在同落点上工具仍可用
- 通过｜工作流步骤落点：从 workflow_runs 继承因果链｜chain-ext-1
- 通过｜工作流步骤入口同闸门：工具禁用
- 通过｜对照组：本地链的步骤同样继承，且工具仍可用｜chain-local-1
- 通过｜updated_at 落的是时间戳而非 run_id（根因定位：末两个绑定参数错位）｜updated_at=2023-11-14T22:13:20.000Z
- 通过｜加列后频道任务仍能落库（无列名位置插入的坑已补）｜落库并读回成功
- 通过｜频道任务落点继承因果链｜chain-ext-1
- 通过｜频道任务入口同闸门：工具禁用
- 通过｜对照组：本地链的频道任务同样落库且继承，工具仍可用｜chain-local-1
- 通过｜加列后频道指派仍能落库（无列名位置插入第二处已补）｜task_id=ac137be2-4449-4eda-a733-231bb84d7bb2

### SEC-09 A4 上下文隔离：不含本地记忆

- 验收：A4（本地记忆）
- 设计/计划出处：design §10 A4、src/backend/im/causal-chain.ts IM_FORBIDDEN_CONTEXT_SOURCES
- 状态：✅ 通过（3 项断言通过）
- 步骤 1：把 local-memory 来源的上下文交给白名单过滤
- 步骤 2：断言它被丢弃、不进入外部上下文
- 步骤 3：断言泄漏检出把它报出来
- 前置 T5：外部上下文白名单｜落点 `src/backend/im/causal-chain.ts`｜已存在
- 通过｜local-memory 被白名单丢弃
- 通过｜白名单只留当前消息
- 通过｜泄漏检出报出 local-memory

### SEC-10 A4 上下文隔离：不含工作区文件与工作区指令

- 验收：A4（工作区）
- 设计/计划出处：design §10 A4、design R15
- 状态：✅ 通过（3 项断言通过）
- 步骤 1：把 workspace-instructions 与 local-file 来源交给白名单过滤
- 步骤 2：断言两者都被丢弃
- 步骤 3：断言泄漏检出把两者都报出来
- 前置 T5：外部上下文白名单｜落点 `src/backend/im/causal-chain.ts`｜已存在
- 通过｜workspace-instructions 被丢弃
- 通过｜local-file 被丢弃
- 通过｜泄漏检出报出工作区来源

### SEC-11 A4 上下文隔离：不含 CRM 与资料库内容

- 验收：A4（CRM/资料库）
- 设计/计划出处：design §10 A4
- 状态：✅ 通过（4 项断言通过）
- 步骤 1：把 crm 与 library 来源交给白名单过滤
- 步骤 2：断言两者都被丢弃
- 步骤 3：断言泄漏检出把两者都报出来
- 前置 T5：外部上下文白名单｜落点 `src/backend/im/causal-chain.ts`｜已存在
- 通过｜crm 被丢弃
- 通过｜library 被丢弃
- 通过｜本会话历史是白名单来源、保留
- 通过｜泄漏检出报出 crm 与 library

### SEC-12 A4 上下文隔离：不含其他会话历史与技能输出

- 验收：A4（其他会话）
- 设计/计划出处：design §10 A4
- 状态：✅ 通过（4 项断言通过）
- 步骤 1：把 other-session 与 skill-output 来源交给白名单过滤
- 步骤 2：断言两者都被丢弃
- 步骤 3：断言泄漏检出把两者都报出来
- 前置 T5：外部上下文白名单｜落点 `src/backend/im/causal-chain.ts`｜已存在
- 通过｜other-session 被丢弃
- 通过｜skill-output 被丢弃
- 通过｜两者的上下文全被清空
- 通过｜泄漏检出报出两者

### SEC-13 A4 默认拒绝：缺因果链与非白名单上下文一律不放行

- 验收：A4（默认拒绝）
- 设计/计划出处：design §4.1.1、design R15、src/backend/im/causal-chain.ts requireChain/toolsDecision
- 状态：✅ 通过（4 项断言通过）
- 步骤 1：没有因果链时 requireChain 必须抛错
- 步骤 2：没有因果链时 mayUseTools 为 false、toolsDecision 不放行
- 步骤 3：白名单之外的上下文来源一律被丢弃，不因没有匹配规则而放行
- 前置 T5：默认拒绝｜落点 `src/backend/im/causal-chain.ts`｜已存在
- 通过｜缺因果链时 requireChain 抛错｜im.protocolError
- 通过｜缺因果链时 mayUseTools 为 false
- 通过｜缺因果链时不放行｜{"allowed":false,"reason":"im.unauthorized","toolsEnabled":false}
- 通过｜非白名单来源一律丢弃

### SEC-14 授权点唯一裁决：外部信任域一律禁工具，不继承工作区发言人信任

- 验收：A1–A4（授权点）
- 设计/计划出处：plan §8 结论 5、docs/messaging.md R10、src/backend/im/causal-chain.ts toolsDecision
- 状态：✅ 通过（7 项断言通过）
- 步骤 1：断言 IM_INBOUND_ACTIONS 闭合为 reply/stop/approval
- 步骤 2：外部三类信任域逐一走 toolsDecision，一律 toolsEnabled 为 false
- 步骤 3：本地信任域对照：toolsEnabled 为 true
- 步骤 4：断言外部信任域与本地信任域不重叠
- 前置 T5：MessagingDriver 信任模型切断｜落点 `src/backend/im/causal-chain.ts`｜已存在
- 通过｜InboundAction 闭合为三项｜reply,stop,approval
- 通过｜im-peer 禁工具
- 通过｜im-proxy 禁工具
- 通过｜third-party 禁工具
- 通过｜本地信任域对照可用工具
- 通过｜外部信任域不含 local
- 通过｜授权点唯一裁决：外部一律不动手

### SEC-15 外部上下文白名单恰为三类且带来源标记

- 验收：A4（白名单）
- 设计/计划出处：design §4.1.1、src/backend/im/causal-chain.ts IM_EXTERNAL_CONTEXT_SOURCES
- 状态：✅ 通过（4 项断言通过）
- 步骤 1：白名单恰为当前消息、显式附件、本会话历史三类
- 步骤 2：每条保留的上下文都带来源标记
- 步骤 3：白名单与禁用清单不重叠
- 步骤 4：禁用清单覆盖本地记忆、工作区指令、CRM、资料库、其他会话、本地文件、技能输出七类
- 前置 T5：外部上下文白名单｜落点 `src/backend/im/causal-chain.ts`｜已存在
- 通过｜白名单恰为三类｜current-message,explicit-attachment,session-history
- 通过｜禁用清单七类齐备｜local-memory,workspace-instructions,crm,library,other-session,local-file,skill-output
- 通过｜白名单与禁用清单不重叠
- 通过｜保留的上下文都带来源标记

### SEC-16 authorizeToolCall 三态：缺声明默认拒绝、显式本地放行、外部拒工具

- 验收：A1–A4（默认拒绝语义）
- 设计/计划出处：design §4.1 缺声明或传递失败→默认拒绝工具、src/backend/im/causal-chain.ts authorizeToolCall
- 状态：✅ 通过（8 项断言通过）
- 步骤 1：缺声明（undefined，含传递失败）→ 默认拒绝，不放行
- 步骤 2：显式本地（null）→ 放行且可用工具
- 步骤 3：外部三类信任域 → 放行回文本但工具禁用
- 步骤 4：本地链 → 放行且可用工具
- 步骤 5：与 toolsDecision 的语义差异要分开验：toolsDecision(null) 是缺链拒绝
- 前置 T5：authorizeToolCall 默认拒绝语义｜落点 `src/backend/im/causal-chain.ts`｜已存在
- 通过｜缺声明默认拒绝｜{"allowed":false,"reason":"im.unauthorized","toolsEnabled":false}
- 通过｜显式本地放行且可用工具｜{"allowed":true,"reason":null,"toolsEnabled":true}
- 通过｜im-peer 可回文本但工具禁用
- 通过｜im-proxy 可回文本但工具禁用
- 通过｜third-party 可回文本但工具禁用
- 通过｜本地链可用工具
- 通过｜toolsDecision(null) 是缺链拒绝（与显式本地区分）｜{"allowed":false,"reason":"im.unauthorized","toolsEnabled":false}
- 通过｜缺声明默认拒绝、显式本地放行的区分成立

### SEC-17 CausalChainRegistry：声明/读回/派生继承/未声明默认拒绝

- 验收：A2（注册表）
- 设计/计划出处：design §10 A2、src/backend/im/causal-chain.ts CausalChainRegistry
- 状态：✅ 通过（12 项断言通过）
- 步骤 1：declare 后可 read 回同一条链
- 步骤 2：read(null) 是 null、read(undefined) 是 undefined、未声明的 chainId 拒绝
- 步骤 3：derive 继承父链信任域，派生链仍在注册表里
- 步骤 4：外部派生链工具仍禁用，本地派生链放行
- 步骤 5：无父链派生必须抛错（默认拒绝）
- 前置 T5：CausalChainRegistry declare/read/derive/authorize｜落点 `src/backend/im/causal-chain.ts`｜已存在
- 通过｜declare 返回落库后的链｜chain-ext-1
- 通过｜read 读回同一条
- 通过｜read(null) 是 null
- 通过｜read(undefined) 是 undefined
- 通过｜未声明的 chainId 默认拒绝
- 通过｜已声明的外部链仍禁工具
- 通过｜derive 继承信任域｜im-peer
- 通过｜derive 继承 rootMessageId
- 通过｜派生链已进注册表
- 通过｜外部派生链工具仍禁用
- 通过｜本地派生链放行
- 通过｜无父链派生默认拒绝｜CausalChainMissing

