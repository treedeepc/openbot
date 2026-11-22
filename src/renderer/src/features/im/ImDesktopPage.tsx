import { imEntrySupportFor } from "@openbot/team-client/im-client";
import type { JSX } from "@solidjs/web";
import { createStableConversationState } from "../conversation/conversation-controller";
import { useServers } from "../servers/servers-context";
import { useSettings } from "../settings/settings-context";
import { WebImPage } from "../web-client/WebImPage";
import { desktopImPort } from "./desktop-im-port";

export function ImDesktopPage(props: { serverId: string; hostName: string; onBack: () => void }): JSX.Element {
  const { servers } = useServers();
  const { openAppSettingRow } = useSettings();
  const server = () => servers().find((item) => item.id === props.serverId);
  const drafts = createStableConversationState({ onTypingChange: () => undefined }, true);
  return (
    <WebImPage
      port={desktopImPort(props.serverId)}
      support={imEntrySupportFor(server())}
      hostName={props.hostName}
      network={server() ? "server" : "offline"}
      onBack={props.onBack}
      agents={[]}
      drafts={() => drafts.threadDrafts()}
      setDrafts={drafts.setThreadDrafts}
      onOpenImSettings={() => openAppSettingRow("app-behavior", "im.settings.title")}
    />
  );
}
