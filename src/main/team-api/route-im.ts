import { randomUUID } from "node:crypto";
import {
  type ImMessage,
  type ImPage,
  type ImPeer,
  ImProtocolError,
  parseImAssign,
  parseImAuditExport,
  parseImAuditQuery,
  parseImBlockAdd,
  parseImChannelId,
  parseImChannelMemberChange,
  parseImContactId,
  parseImContactRequest,
  parseImCursor,
  parseImDeliveryId,
  parseImDeviceId,
  parseImEnrollApprove,
  parseImEnrollBegin,
  parseImMessageList,
  parseImNotificationGet,
  parseImNotificationSet,
  parseImPeerDeviceRef,
  parseImPeerRef,
  parseImPeerVerify,
  parseImPresenceHidden,
  parseImPresenceQuery,
  parseImProxySet,
  parseImRead,
  parseImReportCreate,
  parseImResend,
  parseImSearchQuery,
  parseImSendMessage,
  parseImSignal,
  parseImThreadId,
  parseImTransfer,
  parseImUpdateProfile,
  parseImWithdraw,
} from "@openbot/contracts/ipc";
import {
  IM_AUDIT_CAPABILITY,
  IM_BLOCKLIST_CAPABILITY,
  IM_CHANNELS_ADMIN_CAPABILITY,
  IM_CONTACTS_CAPABILITY,
  IM_DELIVERY_CAPABILITY,
  IM_DEVICES_CAPABILITY,
  IM_INBOX_CAPABILITY,
  IM_LAN_DISCOVERY_CAPABILITY,
  IM_MESSAGES_CAPABILITY,
  IM_NOTIFICATIONS_CAPABILITY,
  IM_PEERS_CAPABILITY,
  IM_PRESENCE_CAPABILITY,
  IM_PROFILE_CAPABILITY,
  IM_PROXY_CAPABILITY,
  IM_REPORT_CAPABILITY,
  IM_ROUTES,
  IM_SEARCH_CAPABILITY,
} from "@openbot/contracts/team-protocol/im-v1";
import { ImFingerprintMismatch, ImPeerUnknown } from "../../backend/im/im-service";
import { ImDuplicateMessage } from "../../backend/im/messages";
import { ImPrimaryRequired, ImThreadUnknown } from "../../backend/im/proxy";
import { ImContactNotFound, ImDuplicateContact } from "../../backend/im/social";
import type {
  TeamApiChannels,
  TeamApiDeactivate,
  TeamApiDelivery,
  TeamApiDevices,
  TeamApiIm,
  TeamApiInbox,
  TeamApiLan,
  TeamApiNotifications,
  TeamApiProfile,
  TeamApiSettings,
} from "./dependencies";
import { HttpError } from "./http-error";
import type { RouteOutcome, TeamApiRequestContext } from "./request-context";
import { readJson, WEBRTC_FRAME_BODY_BUDGET } from "./request-helpers";

export const IM_HANDLED_PATHS: ReadonlySet<string> = new Set([
  IM_ROUTES.peersList,
  IM_ROUTES.peerVerify,
  IM_ROUTES.messagesList,
  IM_ROUTES.messageSend,
  IM_ROUTES.messageWithdraw,
  IM_ROUTES.threadsList,
  IM_ROUTES.threadGet,
  IM_ROUTES.threadAssign,
  IM_ROUTES.threadTransfer,
  IM_ROUTES.contactsList,
  IM_ROUTES.contactRequest,
  IM_ROUTES.contactAccept,
  IM_ROUTES.contactReject,
  IM_ROUTES.contactRemove,
  IM_ROUTES.blocklistList,
  IM_ROUTES.blocklistAdd,
  IM_ROUTES.blocklistRemove,
  IM_ROUTES.reportCreate,
  IM_ROUTES.reportsList,
  IM_ROUTES.channelMembersList,
  IM_ROUTES.channelMemberAdd,
  IM_ROUTES.channelMemberRemove,
  IM_ROUTES.deliveryList,
  IM_ROUTES.deliveryAck,
  IM_ROUTES.deliveryRead,
  IM_ROUTES.deliveryResend,
  IM_ROUTES.lanPeers,
  IM_ROUTES.lanSignal,
  IM_ROUTES.peersDevicesList,
  IM_ROUTES.devicesList,
  IM_ROUTES.enrollBegin,
  IM_ROUTES.enrollApprove,
  IM_ROUTES.enrollStatus,
  IM_ROUTES.enrollCancel,
  IM_ROUTES.deviceRevoke,
  IM_ROUTES.auditList,
  IM_ROUTES.auditExport,
  IM_ROUTES.searchQuery,
  IM_ROUTES.presenceGet,
  IM_ROUTES.presenceHidden,
  IM_ROUTES.proxyGet,
  IM_ROUTES.proxySet,
  IM_ROUTES.notificationsGet,
  IM_ROUTES.notificationsSet,
  IM_ROUTES.profileGet,
  IM_ROUTES.profileUpdate,
  IM_ROUTES.profileDeactivate,
]);

function parse<A>(decode: (value: unknown) => A, body: unknown): A {
  try {
    return decode(body);
  } catch (error) {
    throw failed(error);
  }
}

function bytesOf(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value));
}

function fittedPage<Item>(page: ImPage<Item>): ImPage<Item> {
  if (bytesOf(page) <= WEBRTC_FRAME_BODY_BUDGET) return page;
  const kept = [...page.items];
  let bytes = bytesOf(page);
  while (kept.length > 1 && bytes > WEBRTC_FRAME_BODY_BUDGET) bytes -= bytesOf(kept.pop()) + 1;
  return { items: kept, next: page.next };
}

function fitted<A>(value: A): A {
  if (bytesOf(value) > WEBRTC_FRAME_BODY_BUDGET) throw new HttpError(413, "im.tooLarge");
  return value;
}

function failed(error: unknown): HttpError {
  if (error instanceof HttpError) return error;
  if (error instanceof ImFingerprintMismatch) return new HttpError(409, error.message);
  if (error instanceof ImPeerUnknown) return new HttpError(404, error.message);
  if (error instanceof ImContactNotFound) return new HttpError(404, error.message);
  if (error instanceof ImThreadUnknown) return new HttpError(404, error.message);
  if (error instanceof ImDuplicateMessage || error instanceof ImDuplicateContact)
    return new HttpError(409, error.message);
  if (error instanceof ImPrimaryRequired) return new HttpError(409, error.message);
  if (error instanceof ImProtocolError) return new HttpError(400, error.message);
  if (error instanceof Error && error.message.startsWith("im.")) return new HttpError(400, error.message);
  return new HttpError(400, "im.protocolError");
}

function requireCapability(capabilities: ReadonlySet<string>, capability: string): void {
  if (!capabilities.has(capability)) throw new HttpError(400, "im.versionIncompatible");
}

export async function routeIm(
  context: TeamApiRequestContext,
  im: TeamApiIm | undefined,
  inbox: TeamApiInbox | undefined,
  channels: TeamApiChannels | undefined,
  delivery: TeamApiDelivery | undefined,
  settings: TeamApiSettings | undefined,
  notifications: TeamApiNotifications | undefined,
  profile: TeamApiProfile | undefined,
  devices: TeamApiDevices | undefined,
  deactivate: TeamApiDeactivate | undefined,
  lan: TeamApiLan | undefined,
): Promise<RouteOutcome> {
  const { method, url, capabilities, member, request, json } = context;
  const path = url.pathname;
  if (method !== "POST" || !IM_HANDLED_PATHS.has(path)) return "unmatched";
  if (!im || !inbox || !channels || !delivery || !settings || !notifications || !profile || !deactivate || !devices)
    throw new HttpError(400, "im.versionIncompatible");
  const body = await readJson(request);
  const memberId = member.id;
  try {
    switch (path) {
      case IM_ROUTES.peersList:
        requireCapability(capabilities, IM_PEERS_CAPABILITY);
        return json(200, fittedPage(im.listPeers(memberId, parse(parseImCursor, body))));
      case IM_ROUTES.peerVerify:
        requireCapability(capabilities, IM_PEERS_CAPABILITY);
        return json(200, fitted(im.verifyPeer(memberId, parse(parseImPeerVerify, body))));
      case IM_ROUTES.messagesList:
        requireCapability(capabilities, IM_MESSAGES_CAPABILITY);
        return json(200, fittedPage(im.listMessages(memberId, parse(parseImMessageList, body))));
      case IM_ROUTES.messageSend:
        requireCapability(capabilities, IM_MESSAGES_CAPABILITY);
        return json(200, fitted(im.sendFromClient(memberId, parse(parseImSendMessage, body))));
      case IM_ROUTES.messageWithdraw:
        requireCapability(capabilities, IM_MESSAGES_CAPABILITY);
        im.withdrawMessage(memberId, parse(parseImWithdraw, body));
        return json(200, { withdrawn: true });
      case IM_ROUTES.threadsList:
        requireCapability(capabilities, IM_INBOX_CAPABILITY);
        return json(200, fittedPage(inbox.listThreads(memberId, parse(parseImCursor, body))));
      case IM_ROUTES.threadGet:
        requireCapability(capabilities, IM_INBOX_CAPABILITY);
        return json(200, fitted(inbox.getThread(memberId, parse(parseImThreadId, body))));
      case IM_ROUTES.threadAssign:
        requireCapability(capabilities, IM_INBOX_CAPABILITY);
        return json(200, fitted(inbox.assignThread(memberId, parse(parseImAssign, body))));
      case IM_ROUTES.threadTransfer:
        requireCapability(capabilities, IM_INBOX_CAPABILITY);
        return json(200, fitted(inbox.transferThread(memberId, parse(parseImTransfer, body))));
      case IM_ROUTES.contactsList:
        requireCapability(capabilities, IM_CONTACTS_CAPABILITY);
        return json(200, fittedPage(inbox.listContacts(memberId)));
      case IM_ROUTES.contactRequest: {
        requireCapability(capabilities, IM_CONTACTS_CAPABILITY);
        const entry = parse(parseImContactRequest, body);
        return json(
          200,
          fitted(
            inbox.requestContact(memberId, { contactId: randomUUID(), peer: entry, note: entry.note, at: Date.now() }),
          ),
        );
      }
      case IM_ROUTES.contactAccept:
        requireCapability(capabilities, IM_CONTACTS_CAPABILITY);
        return json(200, fitted(inbox.acceptContact(memberId, { ...parse(parseImContactId, body), at: Date.now() })));
      case IM_ROUTES.contactReject:
        requireCapability(capabilities, IM_CONTACTS_CAPABILITY);
        return json(200, fitted(inbox.rejectContact(memberId, { ...parse(parseImContactId, body), at: Date.now() })));
      case IM_ROUTES.contactRemove:
        requireCapability(capabilities, IM_CONTACTS_CAPABILITY);
        return json(200, fitted(inbox.removeContact(memberId, { ...parse(parseImContactId, body), at: Date.now() })));
      case IM_ROUTES.blocklistList:
        requireCapability(capabilities, IM_BLOCKLIST_CAPABILITY);
        return json(200, fittedPage(inbox.listBlocklist(memberId)));
      case IM_ROUTES.blocklistAdd: {
        requireCapability(capabilities, IM_BLOCKLIST_CAPABILITY);
        const entry = parse(parseImBlockAdd, body);
        return json(
          200,
          fitted(inbox.addBlock(memberId, { ruleId: randomUUID(), peer: entry, reason: entry.reason, at: Date.now() })),
        );
      }
      case IM_ROUTES.blocklistRemove:
        requireCapability(capabilities, IM_BLOCKLIST_CAPABILITY);
        return json(200, { removed: inbox.removeBlock(memberId, { peer: parse(parseImPeerRef, body) }) });
      case IM_ROUTES.reportCreate: {
        requireCapability(capabilities, IM_REPORT_CAPABILITY);
        const entry = parse(parseImReportCreate, body);
        return json(200, fitted(inbox.createReport(memberId, { ...entry, reportId: randomUUID(), at: Date.now() })));
      }
      case IM_ROUTES.reportsList:
        requireCapability(capabilities, IM_REPORT_CAPABILITY);
        return json(200, fittedPage(inbox.listReports(memberId)));
      case IM_ROUTES.channelMembersList:
        requireCapability(capabilities, IM_CHANNELS_ADMIN_CAPABILITY);
        return json(200, fittedPage(channels.list(memberId, parse(parseImChannelId, body).channelId)));
      case IM_ROUTES.channelMemberAdd: {
        requireCapability(capabilities, IM_CHANNELS_ADMIN_CAPABILITY);
        const entry = parse(parseImChannelMemberChange, body);
        return json(
          200,
          fitted(
            channels.addByMember(memberId, {
              channelId: entry.channelId,
              peer: entry,
              role: entry.role,
              at: Date.now(),
              verified: im.peerVerifiedAt(memberId, entry) !== null,
            }),
          ),
        );
      }
      case IM_ROUTES.channelMemberRemove: {
        requireCapability(capabilities, IM_CHANNELS_ADMIN_CAPABILITY);
        const removal = parse(parseImChannelMemberChange, body);
        return json(200, {
          removed: channels.removeByMember(memberId, {
            channelId: removal.channelId,
            peer: { peerServerId: removal.peerServerId, peerAgentId: removal.peerAgentId },
          }),
        });
      }
      case IM_ROUTES.deliveryList:
        requireCapability(capabilities, IM_DELIVERY_CAPABILITY);
        return json(200, fittedPage(delivery.list(memberId, parse(parseImCursor, body))));
      case IM_ROUTES.deliveryAck:
        requireCapability(capabilities, IM_DELIVERY_CAPABILITY);
        return json(
          200,
          fitted(delivery.ack(memberId, { ...parse(parseImDeliveryId, body), deliveryId: "", at: Date.now() })),
        );
      case IM_ROUTES.deliveryRead:
        requireCapability(capabilities, IM_DELIVERY_CAPABILITY);
        return json(
          200,
          fitted(
            (() => {
              const entry = parse(parseImRead, body);
              return delivery.markRead(memberId, {
                threadId: entry.threadId,
                localMessageId: entry.lastReadLocalMessageId,
                at: Date.now(),
              });
            })(),
          ),
        );
      case IM_ROUTES.deliveryResend: {
        requireCapability(capabilities, IM_DELIVERY_CAPABILITY);
        const entry = parse(parseImResend, body);
        return json(200, fitted(delivery.resend(memberId, { deliveryId: entry.deliveryId, at: Date.now() })));
      }
      case IM_ROUTES.lanPeers:
        requireCapability(capabilities, IM_LAN_DISCOVERY_CAPABILITY);
        if (!lan) throw new HttpError(400, "im.versionIncompatible");
        return json(200, fittedPage(lan.lanPeers(memberId)));
      case IM_ROUTES.lanSignal: {
        requireCapability(capabilities, IM_LAN_DISCOVERY_CAPABILITY);
        if (!lan) throw new HttpError(400, "im.versionIncompatible");
        const signal = parse(parseImSignal, body);
        await lan.lanSignal({
          peerServerId: signal.fromServerId,
          peerAgentId: signal.fromAgentId,
          signal: { kind: signal.kind, payload: signal.payload },
        });
        return json(200, { accepted: true });
      }
      case IM_ROUTES.peersDevicesList:
        requireCapability(capabilities, IM_DEVICES_CAPABILITY);
        if (!devices) throw new HttpError(400, "im.versionIncompatible");
        return json(200, fittedPage(devices.peerDevices(parse(parseImPeerDeviceRef, body))));
      case IM_ROUTES.devicesList:
        requireCapability(capabilities, IM_DEVICES_CAPABILITY);
        return json(200, fittedPage(devices.listDevices(memberId)));
      case IM_ROUTES.enrollBegin: {
        requireCapability(capabilities, IM_DEVICES_CAPABILITY);
        const entry = parse(parseImEnrollBegin, body);
        return json(200, fitted(devices.enrollBegin(memberId, { ...entry, now: Date.now() })));
      }
      case IM_ROUTES.enrollApprove: {
        requireCapability(capabilities, IM_DEVICES_CAPABILITY);
        const entry = parse(parseImEnrollApprove, body);
        return json(200, fitted(devices.enrollApprove(memberId, { ...entry, now: Date.now() })));
      }
      case IM_ROUTES.enrollStatus:
        requireCapability(capabilities, IM_DEVICES_CAPABILITY);
        return json(200, fitted(devices.enrollStatus(memberId, parse(parseImDeviceId, body))));
      case IM_ROUTES.enrollCancel:
        requireCapability(capabilities, IM_DEVICES_CAPABILITY);
        return json(200, devices.enrollCancel(memberId, parse(parseImDeviceId, body)));
      case IM_ROUTES.deviceRevoke:
        requireCapability(capabilities, IM_DEVICES_CAPABILITY);
        return json(200, fitted(devices.deviceRevoke(memberId, { ...parse(parseImDeviceId, body), now: Date.now() })));
      case IM_ROUTES.auditList: {
        requireCapability(capabilities, IM_AUDIT_CAPABILITY);
        return json(200, fittedPage(profile.listAudit(memberId, parse(parseImAuditQuery, body))));
      }
      case IM_ROUTES.auditExport: {
        requireCapability(capabilities, IM_AUDIT_CAPABILITY);
        const entry = parse(parseImAuditExport, body);
        return json(200, {
          format: entry.format,
          body: profile.exportAudit(memberId, { from: null, to: null, format: entry.format }),
        });
      }
      case IM_ROUTES.searchQuery: {
        requireCapability(capabilities, IM_SEARCH_CAPABILITY);
        const entry = parse(parseImSearchQuery, body);
        return json(200, fittedPage(profile.search(memberId, entry.q, Date.now())));
      }
      case IM_ROUTES.presenceGet: {
        requireCapability(capabilities, IM_PRESENCE_CAPABILITY);
        const entry = parse(parseImPresenceQuery, body);
        return json(200, fittedPage(profile.readPresence(memberId, entry.peers, Date.now())));
      }
      case IM_ROUTES.presenceHidden: {
        requireCapability(capabilities, IM_PRESENCE_CAPABILITY);
        const entry = parse(parseImPresenceHidden, body);
        return json(200, fitted(profile.setHidden(memberId, { hidden: entry.hidden, at: Date.now() })));
      }
      case IM_ROUTES.proxyGet:
        requireCapability(capabilities, IM_PROXY_CAPABILITY);
        return json(200, fitted(settings.readProxy(memberId)));
      case IM_ROUTES.proxySet: {
        requireCapability(capabilities, IM_PROXY_CAPABILITY);
        const entry = parse(parseImProxySet, body);
        return json(200, fitted(settings.writeProxy(memberId, { ...entry, at: Date.now() })));
      }
      case IM_ROUTES.notificationsGet:
        requireCapability(capabilities, IM_NOTIFICATIONS_CAPABILITY);
        return json(
          200,
          fitted(notifications.readNotifications(memberId, parse(parseImNotificationGet, body).threadId)),
        );
      case IM_ROUTES.notificationsSet: {
        requireCapability(capabilities, IM_NOTIFICATIONS_CAPABILITY);
        const entry = parse(parseImNotificationSet, body);
        return json(200, fitted(notifications.writeNotifications(memberId, entry)));
      }
      case IM_ROUTES.profileGet:
        requireCapability(capabilities, IM_PROFILE_CAPABILITY);
        return json(200, fitted(profile.readProfile(memberId)));
      case IM_ROUTES.profileUpdate: {
        requireCapability(capabilities, IM_PROFILE_CAPABILITY);
        const entry = parse(parseImUpdateProfile, body);
        return json(200, fitted(profile.updateProfile(memberId, entry)));
      }
      case IM_ROUTES.profileDeactivate: {
        requireCapability(capabilities, IM_PROFILE_CAPABILITY);
        deactivate.deactivate(memberId, Date.now());
        return json(200, { deactivated: true });
      }
    }
    return "unmatched";
  } catch (error) {
    throw failed(error);
  }
}

export type { ImMessage, ImPeer };
