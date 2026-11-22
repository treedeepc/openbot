# T14e / M7 本轮缺陷清单（三条，全部后端）

| # | 用例 | 缺陷 | 状态 |
| --- | --- | --- | --- |
| B | M7-01 | 审计导出缺 `before`/`after` 两列 | 待修 |
| C | M7-03 | `mergeContacts` 新对端丢失同步状态 | 待修 |
| D | M7-11 | `ImRelayService` 全程不写审计 | 待修 |

三条都已落成**具名断言**（标签带「缺陷：…」或打出实测值），后端交付后直接复跑即转过，无需改断言。
转过则 **T14e 达 12/12，成为第六个关闭的关卡**。

---

## B. 审计导出缺 `before` / `after`（M7-01）

- **现象**：`ImAuditAdmin.export()` 的 json / csv 两种格式都只有 9 列
  （`id, actorId, sourceTrustDomain, action, targetId, result, correlationId, causalChainId, at`），
  **不含 `before` 与 `after`**。
- **根因**：`audit-admin.ts` 的 `export()` SELECT 列表没取 `before`/`after`，
  json 映射与 csv 表头也照此裁剪。而 `ImAuditLog` 落库时是写的（`read()` 读得回来）。
- **位置**：`src/backend/im/audit-admin.ts` 的 `export()`（SELECT 列 + `entries.map` + csv `header`）。
- **修法**：SELECT 补 `before, after` 两列；json 映射补两个字段；csv 表头补 `before,after` 两列
  （与现有 `causalChainId` 同样处理 null）。两列在写入时已过 `redactImValue`，导出仍是脱敏值。
- **影响面**：A11 明确写「明细含 actor/信任域/action/target/result/correlationId/**before-after**/时间」。
  导出比明细少两个字段，导致「导出即完整审计」不成立；审计复盘看不到变更前后值。
  脱敏本身没问题（B 不是泄漏问题，是**不全**问题）。

---

## C. `mergeContacts` 新对端丢失同步状态（M7-03）

- **现象**：设备一有一条 `accepted` 的联系人，设备二同步后该对端在设备二上是 **`pending`**，不是 `accepted`。
  实测：`contacts.find(scope, peerA)?.state === "pending"`。
- **根因**：`sync.ts` 的 `mergeContacts()` 里，状态分支只在 **`existing` 存在时**才走：
  ```
  const saved = existing
    ? (state === "removed" ? remove(...) : state === "accepted" ? accept(...) : existing)
    : this.#contacts.request({...});   // ← 无论 incoming 什么状态，新建一律 request()
  ```
  本机没有该对端时，incoming 的 `accepted` / `removed` **一律被丢掉**，建成 `pending`。
  更糟的连带：同步一条 `removed`，在没有历史的机器上会**复活成 pending**。
- **位置**：`src/backend/im/sync.ts` `mergeContacts()`（`const saved = existing ? ... : request(...)`）。
- **修法**：`!existing` 分支也按 `entry.state` 分派——`accepted` → 建完即 `accept()`；
  `removed` → 建完即 `remove()`（或干脆不建行）；`pending` → 维持 `request()`。
- **影响面**：A13 多设备同步「四项一致」在**首次同步**这条路径上不成立。
  M7-04 的并集断言只验了「对端存在」，没验状态，所以那条过了——这轮补的状态断言把它抓出来。

---

## D. `ImRelayService` 全程不写审计（M7-11）

- **现象**：`enable` / `disable` / `relay` 三次调用后，`audit_log` 里 `action LIKE 'im.relay%'` 的条数 **= 0**。
- **根因**：`src/backend/im/relay.ts` 全文没有 `ImAuditLog` 引用，也没有任何写审计调用。
  同批交付的 `ImSyncService` 每个操作都走 `#record()` 写审计，唯独 relay 没有。
- **位置**：`src/backend/im/relay.ts` 的 `enable()` / `disable()` / `relay()`。
- **修法**：三个入口各写一条审计（建议 `im.relay.enable` / `im.relay.disable` / `im.relay.forward`），
  `before/after` 记 `enabled` 与 `exposedSurface`，与 `ImSyncService#record` 同风格。
- **影响面**：第三方中转是**暴露面操作**（启用等于允许第三方经手密文转发），
  开关与转发不留痕违反 A11「任一审计动作都可追溯」。隐私/合规面要紧。
  T12e 的另三条验收（只转发密文、默认关闭、启用须明示暴露面）**本轮实测都过**，只有审计这条缺。

---

## 附：本轮另查到的一处口径不符（非缺陷，但要同步）

PM/后端口径是「能力注册 10 条，只剩 `im-lan-discovery-v1` 未注册」。
**实测是两条**：`im-lan-discovery-v1` **和** `im-devices-v1`。

`im-devices-v1` 的 6 条 route（`devicesList` / `enrollBegin` / `enrollApprove` / `enrollStatus` /
`enrollCancel` / `deviceRevoke`）在 `src/main/team-api/` 里**没有任何实现**，
所以 `IM_HANDLED_PATHS` 不含它们——按「未实现 capability 不对外声明」这是对的，
但意味着 **M1-13/M1-14 的设备用户流程走不了真路由**，只能走预览/故事。
T14a 那两条 blocker 已按此写准。
