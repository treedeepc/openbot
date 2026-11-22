import type { ImChannelMember, ImPeer } from "@openbot/contracts/ipc";
import { Button, Typography } from "heroui-native";
import { useState } from "react";
import { View } from "react-native";
import {
  type ImPeerRef,
  imChannelCanInvite,
  imChannelInviteTargets,
  imPeerRef,
  toImChannelMemberRow,
} from "@/features/im/model/im-port";
import { useText } from "@/shared/lib/text";

const ROLE_LABEL = {
  admin: "im.channel.admin",
  member: "im.channel.member",
  readonly: "im.channel.readonly",
} as const;

export function ImChannelView(props: {
  members: readonly ImChannelMember[];
  peers: readonly ImPeer[];
  viewer?: ImPeerRef | null | undefined;
  onInvite?: ((member: ImPeerRef, role: ImChannelMember["role"]) => Promise<void>) | undefined;
  onRoleChange?: ((member: ImPeerRef, role: ImChannelMember["role"]) => Promise<void>) | undefined;
  onRemove?: ((member: ImPeerRef) => Promise<void>) | undefined;
}) {
  const { t } = useText();
  const [busy, setBusy] = useState(false);
  const [inviting, setInviting] = useState(false);
  const rows = props.members.map((member) =>
    toImChannelMemberRow(member, props.peers, (item) => item.peerServerId !== props.peers[0]?.peerServerId),
  );
  const canAdminister = rows.some((row) => row.role === "admin" && !row.external);
  const canInvite = imChannelCanInvite(rows, props.viewer ?? null) && props.onInvite !== undefined;
  const targets = imChannelInviteTargets(props.peers, props.members);

  async function run(action: () => Promise<void>): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      await action();
    } finally {
      setBusy(false);
    }
  }

  return (
    <View className="gap-2">
      <Typography.Heading type="h4">{t("im.channel.title")}</Typography.Heading>
      {canInvite ? (
        <View className="gap-2">
          <Button size="sm" variant="ghost" onPress={() => setInviting(!inviting)}>
            <Button.Label>{t("im.channel.invite")}</Button.Label>
          </Button>
          {inviting
            ? targets.map((peer) => (
                <View key={imPeerRef(peer)} className="flex-row items-center gap-2">
                  <Typography.Paragraph type="body-sm" className="flex-1">
                    {peer.displayName}
                  </Typography.Paragraph>
                  <Button
                    size="sm"
                    variant="ghost"
                    isDisabled={busy}
                    onPress={() =>
                      void run(async () => {
                        await props.onInvite?.(peer, "member");
                        setInviting(false);
                      })
                    }
                  >
                    <Button.Label>{t("common.add")}</Button.Label>
                  </Button>
                </View>
              ))
            : null}
        </View>
      ) : null}
      {rows.map((row) => (
        <View key={row.id} className="flex-row items-center gap-2">
          <Typography.Paragraph type="body-sm" className="flex-1">
            {row.name}
          </Typography.Paragraph>
          <Typography.Paragraph type="body-xs" className="text-grouped-secondary">
            {t(ROLE_LABEL[row.role])}
          </Typography.Paragraph>
          {row.external ? (
            <Typography.Paragraph type="body-xs" className="text-grouped-secondary">
              {t("im.channel.external")}
            </Typography.Paragraph>
          ) : null}
          {canAdminister && props.onRoleChange ? (
            <Button
              size="sm"
              variant="ghost"
              isDisabled={busy || row.role === "admin"}
              onPress={() =>
                void run(async () => {
                  await props.onRoleChange?.(
                    { peerServerId: row.id.split("/")[0] ?? "", peerAgentId: row.id.split("/")[1] ?? "" },
                    "admin",
                  );
                })
              }
            >
              <Button.Label>{t("im.channel.makeAdmin")}</Button.Label>
            </Button>
          ) : null}
          {canAdminister && props.onRemove ? (
            <Button
              size="sm"
              variant="ghost"
              isDisabled={busy}
              onPress={() =>
                void run(async () => {
                  await props.onRemove?.({
                    peerServerId: row.id.split("/")[0] ?? "",
                    peerAgentId: row.id.split("/")[1] ?? "",
                  });
                })
              }
            >
              <Button.Label>{t("im.channel.remove")}</Button.Label>
            </Button>
          ) : null}
        </View>
      ))}
    </View>
  );
}
