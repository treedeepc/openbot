# IM 门控形态证据 —— 16 条能力全注册后

- 验证脚本：`scripts/im-scale-e2e.ts` 的 **M7-10**（9 项断言）
- 判定来源：`packages/contracts/src/team-protocol/current.ts` 的 `isTeamCurrentCapability`（注册的唯一真源）
- 门控函数：`packages/team-client/src/im-client.ts:115` `imEntrySupport` / `imEntryAvailable`；段列表 `src/renderer/src/features/web-client/web-im.ts:24` `imPanes`

## 一、注册现状（实测）

**16 条 IM 能力全部注册，0 条未注册**：

`im-peers-v1` `im-profile-v1` `im-messages-v1` `im-delivery-v1` `im-proxy-v1` `im-presence-v1`
`im-notifications-v1` `im-devices-v1` `im-search-v1` `im-lan-discovery-v1` `im-channels-admin-v1`
`im-audit-v1` **`im-contacts-v1` `im-blocklist-v1` `im-inbox-v1` `im-report-v1`**（后四条本轮补注册）

`imEntrySupport` 七位与 `imPanes` 段的对应：

| 能力组合 | `imEntrySupport` 位 | `imPanes` 段 |
| --- | --- | --- |
| `im-inbox-v1` + `im-peers-v1` | `inbox` | **inbox** |
| `im-contacts-v1` | `contacts` | **contacts** |
| `im-peers-v1` + `im-messages-v1` | `session` | **session** |
| `im-devices-v1` | `devices` | **devices** |
| `im-inbox-v1` | `assign` | （能力位，不是段） |
| `im-blocklist-v1` | `block` | （能力位，不是段） |
| `im-report-v1` | `report` | （能力位，不是段） |

## 二、形态（实测输出）

**注册后（16 条全满）**：

```
七项全开 {"inbox":true,"contacts":true,"session":true,"devices":true,
          "assign":true,"block":true,"report":true}  → imEntryAvailable true
imPanes 4  inbox,contacts,session,devices
```

→ **七段入口全开**（`imEntrySupport` 七位全 true），**`imPanes` 是 4 段**（段只覆盖 inbox/contacts/session/devices 四项，assign/block/report 是能力位、不占段）。

**对照组（无 `im-*` 的旧 host）**：

```
{"inbox":false,"contacts":false,"session":false,"devices":false,
 "assign":false,"block":false,"report":false}        → imEntryAvailable false
```

→ **七项仍全 false**，一个入口都不出。这条对照证明门控是「按能力开」，不是全都常开。

**对照组二（只留 `im-peers-v1` + `im-messages-v1`）**：`imPanes` 只剩 `session` 一段 —— 证明四段各由不同能力驱动。

## 三、演进

| 阶段 | 已注册 | `imEntrySupport` 开的位 | `imPanes` |
| --- | --- | --- | --- |
| 本轮前 | 12 条 | session, devices | 2 段 |
| **本轮后** | **16 条** | **七位全开** | **4 段** |

## 四、消费点（三端共用一个门控函数）

| 端 | 位置 | 读的能力来源 |
| --- | --- | --- |
| 桌面 | `src/renderer/src/features/window/WorkspacePageRail.tsx:74` / `ImDesktopPage.tsx:15` | `server().compatibility.capabilities` |
| Web | `src/renderer/src/features/web-client/WebWorkspace.tsx:1326` | `workspace.state.capabilities` |
| 移动 | `apps/mobile/src/features/im/model/im-port.tsx:25-26` | 同一 `imEntrySupport` |

**平台差异只在消费点**，门控判定三端同一个函数——所以 M7-08/09/10 三条能力缺失用例验的是同一套机制，各自补消费点出处。界面「点了不报错」「无可点击路径」属前端证据（T11c/T16c/T17c）。

## 五、本轮未验到的

- 四段入口的**实渲染**截图（前端本轮派单在做形态证据）
- `imEntrySupport` 由 2 段变 4 段是**用户可见变化**，后端已写 `changelog.d/main.md`；若界面另有新增可见变化，前端需补
