import { createMockIm } from "../src/renderer/src/preview/mock-im";

const checks: { name: string; ok: unknown }[] = [];
const check = (name: string, ok: unknown, detail = ""): void => {
  checks.push({ name, ok });
  process.stdout.write(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

const im = createMockIm();
const peer = { peerServerId: "srv-2", peerAgentId: "agent-peer" };

const contact = await im.contacts.request(peer);
check("mock contacts.request 落 pending", contact.state === "pending", contact.state);

const rejected = await im.contacts.reject(contact.contactId);
check("mock contacts.reject 转 removed", rejected.state === "removed", rejected.state);
check("mock contacts.reject 返回新状态而不是旧的", rejected.contactId === contact.contactId, "");
check(
  "mock contacts.reject 后列表读回 removed",
  (await im.contacts.list()).items.some((item) => item.contactId === contact.contactId && item.state === "removed"),
  "",
);

const again = await im.contacts.reject(contact.contactId);
check("mock contacts.reject 幂等（重复拒绝不报错）", again.state === "removed", again.state);

let missing = "";
try {
  await im.contacts.reject("no-such-contact");
} catch (error) {
  missing = error instanceof Error ? error.message : String(error);
}
check("mock contacts.reject 未知联系人报 im.contactNotFound", missing === "im.contactNotFound", missing);

const second = await im.contacts.request({ peerServerId: "srv-3", peerAgentId: "agent-other" });
const accepted = await im.contacts.accept(second.contactId);
check("对照组：accept 仍然可用", accepted.state === "accepted", accepted.state);
const rejectedSecond = await im.contacts.reject(second.contactId);
check("对照组：已接受的联系人也能拒绝", rejectedSecond.state === "removed", rejectedSecond.state);

const failed = checks.filter((entry) => !entry.ok);
process.stdout.write(`\n${checks.length - failed.length}/${checks.length} passed\n`);
if (failed.length > 0) process.exitCode = 1;
