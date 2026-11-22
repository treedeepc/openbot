import * as contracts from "../packages/contracts/src/ipc-im";
import { itemAt } from "./verify-im-helpers";

const checks: { name: string; ok: unknown }[] = [];
const check = (name: string, ok: unknown, detail = ""): void => {
  checks.push({ name, ok });
  process.stdout.write(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

const peer = { peerServerId: "srv-2", peerAgentId: "agent-peer" };

const contact = contracts.parseImContactRequest({ ...peer, note: "hi, it's me" });
check(
  "parseImContactRequest 收下自己的合法请求体",
  contact.peerServerId === "srv-2" && contact.peerAgentId === "agent-peer" && contact.note === "hi, it's me",
  JSON.stringify(contact),
);

const contactNoNote = contracts.parseImContactRequest({ ...peer });
check("parseImContactRequest note 可省", contactNoNote.note === null, String(contactNoNote.note));

const block = contracts.parseImBlockAdd({ ...peer, reason: "spam" });
check(
  "parseImBlockAdd 收下自己的合法请求体",
  block.peerServerId === "srv-2" && block.reason === "spam",
  JSON.stringify(block),
);

const blockNoReason = contracts.parseImBlockAdd({ ...peer });
check("parseImBlockAdd reason 可省", blockNoReason.reason === null, String(blockNoReason.reason));

const member = contracts.parseImChannelMemberChange({ channelId: "ch-1", ...peer, role: "member" });
check(
  "parseImChannelMemberChange 同类缺陷一并修好",
  member.channelId === "ch-1" && member.role === "member" && member.peerAgentId === "agent-peer",
  JSON.stringify(member),
);

function rejected(name: string, run: () => unknown | Promise<unknown>): void {
  let code = "";
  try {
    void run();
  } catch (error) {
    code = error instanceof Error ? error.name : String(error);
  }
  check(name, code !== "", code || "没有报错");
}

rejected("fail-closed：contactRequest 多一个未知字段仍拒", () =>
  contracts.parseImContactRequest({ ...peer, note: "n", extra: 1 }),
);
rejected("fail-closed：blockAdd 多一个未知字段仍拒", () =>
  contracts.parseImBlockAdd({ ...peer, reason: "r", extra: 1 }),
);
rejected("fail-closed：peerRef 仍然严格（多余字段拒）", () => contracts.parseImPeerRef({ ...peer, note: "n" }));
rejected("fail-closed：contactRequest 缺 peerServerId 拒", () =>
  contracts.parseImContactRequest({ peerAgentId: "a", note: "n" }),
);
rejected("fail-closed：blockAdd 非法 reason 类型拒", () => contracts.parseImBlockAdd({ ...peer, reason: 42 }));

const peerRef = contracts.parseImPeerRef(peer);
check(
  "对照组：parseImPeerRef 本体行为不变",
  peerRef.peerServerId === "srv-2" && peerRef.peerAgentId === "agent-peer",
  "",
);
const presence = contracts.parseImPresenceQuery({ peers: [peer] });
check(
  "对照组：parseImPresenceQuery 逐项过 peerRef 仍可用",
  presence.peers.length === 1 && itemAt(presence.peers, 0).peerAgentId === "agent-peer",
  "",
);

const failed = checks.filter((entry) => !entry.ok);
process.stdout.write(`\n${checks.length - failed.length}/${checks.length} passed\n`);
if (failed.length > 0) process.exitCode = 1;
