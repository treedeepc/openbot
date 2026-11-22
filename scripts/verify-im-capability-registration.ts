import {
  TEAM_CURRENT_CAPABILITIES,
  teamCapabilitiesForProtocol,
} from "../packages/contracts/src/team-protocol/current";
import {
  IM_CAPABILITIES,
  IM_MESSAGES_CAPABILITY,
  IM_PEERS_CAPABILITY,
  IM_ROUTES_BY_CAPABILITY,
} from "../packages/contracts/src/team-protocol/im-v1";
import { IM_HANDLED_PATHS } from "../src/main/team-api/route-im";
import { imEntryAvailable, imEntrySupport } from "../src/renderer/src/features/web-client/web-im";

const routesByCapability = new Map<string, readonly string[]>(Object.entries(IM_ROUTES_BY_CAPABILITY));
const routesOf = (capability: string): readonly string[] => routesByCapability.get(capability) ?? [];

const checks: { name: string; ok: unknown }[] = [];
const check = (name: string, ok: unknown, detail = ""): void => {
  checks.push({ name, ok });
  process.stdout.write(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

const registered = TEAM_CURRENT_CAPABILITIES.filter((capability) =>
  IM_CAPABILITIES.some((item) => item === capability),
);
const expected = [
  "im-audit-v1",
  "im-blocklist-v1",
  "im-channels-admin-v1",
  "im-contacts-v1",
  "im-delivery-v1",
  "im-devices-v1",
  "im-inbox-v1",
  "im-lan-discovery-v1",
  "im-messages-v1",
  "im-notifications-v1",
  "im-peers-v1",
  "im-presence-v1",
  "im-profile-v1",
  "im-proxy-v1",
  "im-report-v1",
  "im-search-v1",
];
check(
  "只注册 route 全通的能力",
  registered.slice().sort().join(",") === expected.join(","),
  registered.slice().sort().join(","),
);
check(
  "其余 IM 能力一律未注册",
  IM_CAPABILITIES.filter((capability) => !registered.includes(capability)).length ===
    IM_CAPABILITIES.length - expected.length,
  "",
);

for (const capability of registered) {
  const routes = routesOf(capability);
  const missing = routes.filter((route) => !IM_HANDLED_PATHS.has(route));
  check(
    `合规矩阵：${capability} 的 route 全部已实现`,
    missing.length === 0,
    missing.join(",") || `${routes.length} 条全通`,
  );
}
const servedBeyondRegistered = [...IM_HANDLED_PATHS].filter(
  (path) => !registered.some((capability) => routesOf(capability).includes(path)),
);
const allImRoutes = Object.values(IM_ROUTES_BY_CAPABILITY).flat();
check(
  "对外服务的 route 都属于某条 IM 能力（没有野 route）",
  servedBeyondRegistered.every((path) => allImRoutes.includes(path)),
  servedBeyondRegistered.filter((path) => !allImRoutes.includes(path)).join(","),
);
check(
  "口径：已注册能力的 route 全通（禁止注册了却只实现部分）",
  registered.every((capability) => routesOf(capability).every((route) => IM_HANDLED_PATHS.has(route))),
  "",
);
check(
  "口径：16 条能力全部注册，没有 route 全通却未声明的",
  servedBeyondRegistered.length === 0 && registered.length === 16,
  `${servedBeyondRegistered.length} 条 route 未归属已注册能力`,
);
const unregistered = IM_CAPABILITIES.filter((capability) => !registered.includes(capability));
check("未注册的口径：0 条", unregistered.length === 0, unregistered.join(","));

const advertised = teamCapabilitiesForProtocol(10);
check(
  "protocol 10 通告里含已注册的",
  advertised.includes(IM_PEERS_CAPABILITY) && advertised.includes(IM_MESSAGES_CAPABILITY),
  "",
);

const gates = imEntrySupport([...registered, "agent-tasks-v1", "agent-threads-v1", "storage-v1"]);
check(
  "注册后七段入口全部打开（用户可见变化，changelog 已写）",
  gates.session === true &&
    gates.devices === true &&
    gates.inbox === true &&
    gates.contacts === true &&
    gates.assign === true &&
    gates.block === true &&
    gates.report === true,
  JSON.stringify(gates),
);
check(
  "对照组：缺 im-* 的旧 host 七项入口全 false、无点击路径",
  imEntryAvailable(imEntrySupport(["agent-tasks-v1", "agent-threads-v1", "storage-v1"])) === false,
  "",
);
check(
  "对照组：旧 host 完全没有 im-* 时七项全 false",
  Object.values(imEntrySupport(["agent-tasks-v1", "agent-threads-v1"])).every((value) => value === false),
  JSON.stringify(imEntrySupport(["agent-tasks-v1", "agent-threads-v1"])),
);
check(
  "对照组：旧 host 完全没有 im-* 时入口不可用",
  imEntryAvailable(imEntrySupport(["agent-tasks-v1", "agent-threads-v1"])) === false,
  "",
);
check(
  "对照：注册不改契约、七段全开的形态稳定",
  Object.values(gates).every((value) => value === true),
  JSON.stringify(gates),
);

const failed = checks.filter((entry) => !entry.ok);
process.stdout.write(`\n${checks.length - failed.length}/${checks.length} passed\n`);
if (failed.length > 0) process.exitCode = 1;
