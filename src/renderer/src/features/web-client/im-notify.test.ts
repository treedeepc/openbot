import { imNotify, imNotifyDecision } from "@openbot/team-client/im-notify";
import { describe, expect, it } from "vitest";

const settings = {
  threadId: null,
  mutedUntil: null,
  notifyOn: "all" as const,
  showPreview: true,
};

const message = {
  localMessageId: "msg-1",
  body: "hello",
  senderName: "Mira",
  proxiedBy: null,
};

describe("im notify", () => {
  it("stays silent while a mute window is open and resumes after it ends", () => {
    const now = 1_700_000_000_000;
    const muted = { ...settings, mutedUntil: now + 1_000 };
    expect(imNotifyDecision(muted, message, now, new Set()).reason).toBe("muted");
    expect(imNotifyDecision(muted, message, now + 2_000, new Set()).reason).toBe("sent");
  });

  it("notifies once per message, including a proxied one", () => {
    const seen = new Set<string>();
    const sent: string[] = [];
    const deliver = (title: string) => sent.push(title);
    const proxied = { ...message, proxiedBy: "agent-1" };
    const first = imNotify(settings, proxied, seen, deliver);
    const second = imNotify(settings, proxied, seen, deliver);
    expect(first.reason).toBe("sent");
    expect(second.reason).toBe("deduped");
    expect(sent).toEqual(["Mira"]);
  });

  it("drops the preview text when previews are off", () => {
    const seen = new Set<string>();
    const bodies: string[] = [];
    imNotify({ ...settings, showPreview: false }, message, seen, (_title, body) => bodies.push(body));
    expect(bodies).toEqual([""]);
    expect(imNotifyDecision({ ...settings, notifyOn: "none" }, message, Date.now(), new Set()).reason).toBe(
      "notify-off",
    );
  });
});
