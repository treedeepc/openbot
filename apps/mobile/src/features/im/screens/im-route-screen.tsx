import { useLocalSearchParams } from "expo-router";
import { imEntryState, imSupportOf } from "@/features/im/model/im-entry";
import { ImScreen } from "@/features/im/screens/im-screen";
import {
  useMobileWorkspaceActions,
  useMobileWorkspaceSelector,
} from "@/features/workspace/context/mobile-workspace-context";
import { serverRowState } from "@/features/workspace/model/server-row-state";
import { LargeTitleScrollView } from "@/shared/components/large-title";
import { useText } from "@/shared/lib/text";

export function ImRouteScreen() {
  const { t } = useText();
  const { serverId } = useLocalSearchParams<{ serverId: string }>();
  const inbox = useMobileWorkspaceSelector((current) =>
    serverRowState(current, serverId, (checks) => checks.canUseImInbox(serverId)),
  );
  const contacts = useMobileWorkspaceSelector((current) =>
    serverRowState(current, serverId, (checks) => checks.canUseImContacts(serverId)),
  );
  const session = useMobileWorkspaceSelector((current) =>
    serverRowState(current, serverId, (checks) => checks.canUseImSession(serverId)),
  );
  const devices = useMobileWorkspaceSelector((current) =>
    serverRowState(current, serverId, (checks) => checks.canUseImDevices(serverId)),
  );
  const assign = useMobileWorkspaceSelector((current) =>
    serverRowState(current, serverId, (checks) => checks.canUseImInbox(serverId)),
  );
  const block = useMobileWorkspaceSelector((current) =>
    serverRowState(current, serverId, (checks) => checks.canUseImBlock(serverId)),
  );
  const report = useMobileWorkspaceSelector((current) =>
    serverRowState(current, serverId, (checks) => checks.canUseImReport(serverId)),
  );
  const support = imSupportOf({ inbox, contacts, session, devices, assign, block, report });
  const port = useMobileWorkspaceActions().imPort(serverId);
  if (imEntryState(inbox, session, devices) === "hidden") return null;
  return (
    <LargeTitleScrollView title={t("mobile.app.route.im")}>
      <ImScreen port={port} support={support} agents={[]} network="offline" />
    </LargeTitleScrollView>
  );
}
