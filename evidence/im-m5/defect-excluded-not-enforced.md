# 缺陷单：`offline_targets.state` 只写不读，excluded 对取件无约束力

> **状态：已修复并复跑转过（2026-11-22）。** 后端按下方「修法」三条交付（另加 `confirm` 的 `#excluded` 守卫）。
> 复跑结果：D2-3（9 断言）、M5-08（5 断言）双双通过，PM 点名的两处对照组全过：未被撤销的设备照常取到、注销路径（整表 DELETE）行为不变。
> 验收与对照清单见 `evidence/im-m5/exit-criteria.md`。以下保留原始定位，供追溯。

- 关卡：T14d2 / M5（`scripts/im-offline-e2e.ts`）
- 落点用例：**D2-3**（撤销设备标 excluded）、**M5-08**（证书过期标 excluded）
- 判定：两条用例失败，同源

## 现象

`ImOfflineQueue.exclude()` 调用成功，`offline_targets` 三字段齐：`state='excluded'`、`excluded_at`、`audit_id`。
但被撤销 / 证书过期的那台设备，仍能从 `offline_queue` 里取到该消息：

- D2-3：撤销 dev-2 后，`queue.read(scope, "q-2")` 仍返回该行、`queue.pending(scope, "dev-2")` 仍包含它
- M5-08：标 excluded 后，`queue.pending(scope, "dev-1")` 仍返回 `rm-x`，等于会照旧重发

## 根因

两处叠加：

1. **`exclude()` 不清 queue 行**。它只 `UPDATE offline_targets`，不碰 `offline_queue`。
   设计 §6.6 时序表（`design-im-integrated.md:452`）明确写：「该行标 `excluded`（记 `excluded_at` + `audit_id`），**其 queue 行随之清理**；不阻止其余设备 ACK 完成」。
2. **`pending()` 不看 `state`**。它只查 `offline_queue`，不与 `offline_targets` 联查。
   设计 §6.6（`:453`）要求「不自动重发给该设备」，当前无任何代码保证这一点。

补一条铁证：全仓 `offline_targets.state` **只有写入方，没有任何读取方**——
`server-mode.ts:334`（insert 'pending'）、`:362`（confirm 置 'acked'）、`:392`（exclude 置 'excluded'），
外加 `deactivate.ts:41` 的 DELETE。这个列今天是纯装饰。

## 位置

- `src/backend/im/server-mode.ts:379` `ImOfflineQueue.exclude`（只 UPDATE targets）
- `src/backend/im/server-mode.ts:315` `ImOfflineQueue.pending`（只读 queue，不反连 targets）

## 修法

1. `exclude()` 在同一次调用里补一行 DELETE：
   `DELETE FROM offline_queue WHERE local_server_id=? AND local_member_id=? AND remote_message_id=? AND recipient_device_id=?`
   （与 `#delete` 同风格，保持幂等：无行时返回 false 也不报错）
2. `pending()` 反连接 `offline_targets`，排除 `state='excluded'` 的 (remote_message_id, recipient_device_id)。
   防御性留着，避免别的入口绕过 exclude 又投出去。
3. 顺带把「全 ACK 才删」的判定只数**非 excluded** 的目标（design §6.6 `:437` 的删除规则）。
   否则一台被撤销、永远不会 ACK 的设备，会把整条消息的删除永久卡住。

## 影响面

- **直接**：A8 的「发送后撤销设备」与「证书过期未 ACK」两个场景（D2-3 / M5-08）
- **隐私面要紧**：证书已吊销的设备仍能取到密文——excluded 本该是「不再收得到」，现在只是「表上记了一笔」
- **不受影响**：D2-1（单设备 ACK）、D2-2（两设备各自 ACK）、D2-4（配额与到期）、M5-06（发送方维度隔离）、
  M5-07（共用设备）、M5-09（新设备不补历史）、M5-10（离线只暂存密文）、M5-11（presence）、M5-13（注销）
  这些本轮实测仍通过
- **顺带**：M5-13 的注销路径用 `DELETE FROM offline_targets / offline_queue WHERE local_member_id=?` 整体清，
  不依赖 `state`，所以注销不受此缺陷影响

## 修完后的复跑口径

D2-3、M5-08 两条用例的失败断言已是具名断言（标签里写了「缺陷：…」），后端交付后直接复跑即转过，
无需改断言。转过则 **T14d2 达 11 通过 / 0 失败 / 2 阻塞**（余下 D2-5 待 T4b2、M5-12 待 presence 的 host route）。
