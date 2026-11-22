import {
  type AgentIpcRequest,
  decodeImAccepted,
  decodeImBlockRule,
  decodeImBlockRules,
  decodeImContact,
  decodeImContacts,
  decodeImMessage,
  decodeImMessages,
  decodeImPeer,
  decodeImPeers,
  decodeImReport,
  decodeImReports,
  decodeImThread,
  decodeImThreads,
  type ImMessageListRequest,
  type ImPeersListRequest,
  type ImPeerVerifyRequest,
  type ImSendMessageRequest,
  parseImAssign,
  parseImBlockAdd,
  parseImContactId,
  parseImContactRequest,
  parseImCursor,
  parseImMessageList,
  parseImPeerRef,
  parseImPeerVerify,
  parseImReportCreate,
  parseImSendMessage,
  parseImThreadId,
  parseImTransfer,
} from "@openbot/contracts/ipc";
import { guardedDecoder } from "@openbot/contracts/ipc-decoding";
import { IM_ROUTES, imCapabilityOfRoute } from "@openbot/contracts/team-protocol/im-v1";
import type { Effect } from "effect";
import { runCauseEffect } from "../../backend/effect-boundary";
import type { ImHostApi } from "../../backend/im/host-api";
import type { ImService } from "../../backend/im/im-service";
import type { ImInboxService } from "../../backend/im/inbox";
import { type ImLanSignalEnvelope, imSignalEnvelopeToWire } from "../../backend/im/lan-signal";
import type { ResponseDecoder } from "../remote-host-decoding";
import type { RemoteRequestInit } from "../remote-server-client";
import type { RemoteWorkflowError } from "../remote-service-effects";
import type { PayloadDecoder } from "../trusted-ipc";
import { agentRequest } from "./agent-inputs";
import { type BoundHandler, type IpcGroupHandlers, payloadHandler } from "./define-ipc-group";
import { scopedHandler } from "./scoped-handler";

export interface ImActor {
  localServerId: string;
  localMemberId: string;
}

export interface ImSessionScope {
  threadId: string;
  localMemberId: string;
}

export type ImAuthorize<Payload> = (payload: Payload, actor: ImActor) => void;

export interface ImServicePort<Payload, Result> {
  authorize?: ImAuthorize<Payload>;
  execute(payload: Payload, actor: ImActor): Result | Promise<Result>;
}

export class ImUnauthorized extends Error {
  constructor() {
    super("im.unauthorized");
    this.name = "ImUnauthorized";
  }
}

export class ImProtocolFailure extends Error {
  constructor() {
    super("im.protocolError");
    this.name = "ImProtocolFailure";
  }
}

export function imActorOf(localServerId: string, localMemberId: string): ImActor {
  return { localServerId, localMemberId };
}

export function requireImMember(actor: ImActor, localMemberId: string): void {
  if (actor.localMemberId !== localMemberId) throw new ImUnauthorized();
}

export function requireImThread(actor: ImActor, scope: ImSessionScope | undefined): void {
  if (!scope || scope.localMemberId !== actor.localMemberId) throw new ImUnauthorized();
}

export function imHandler<Payload, Result>(
  decode: PayloadDecoder<Payload>,
  port: ImServicePort<Payload, Result>,
  actor: () => ImActor,
): BoundHandler<AgentIpcRequest<Payload>, Result> {
  return payloadHandler(agentRequest(decode), ({ payload }) => {
    try {
      port.authorize?.(payload, actor());
    } catch (error) {
      throw error instanceof ImUnauthorized ? error : new ImUnauthorized();
    }
    return port.execute(payload, actor());
  });
}

function accepted<A>(decode: (value: unknown) => A): (value: unknown) => value is A {
  return (value): value is A => {
    try {
      decode(value);
      return true;
    } catch {
      return false;
    }
  };
}

export const decodeImMessageFromHost = guardedDecoder<ImSendMessageRequest>(
  accepted(parseImSendMessage),
  "IM send message request",
);
export const decodeImMessagesFromHost = guardedDecoder<ImMessageListRequest>(
  accepted(parseImMessageList),
  "IM message list request",
);
export const decodeImPeerFromHost = guardedDecoder<ImPeerVerifyRequest>(
  accepted(parseImPeerVerify),
  "IM peer verify request",
);
export const decodeImPeersFromHost = guardedDecoder<ImPeersListRequest>(
  accepted(parseImCursor),
  "IM peers list request",
);

export const decodeImThreadsListFromHost = guardedDecoder(accepted(parseImCursor), "IM ThreadsList request");
export const decodeImThreadGetFromHost = guardedDecoder(accepted(parseImThreadId), "IM ThreadGet request");
export const decodeImThreadAssignFromHost = guardedDecoder(accepted(parseImAssign), "IM ThreadAssign request");
export const decodeImThreadTransferFromHost = guardedDecoder(accepted(parseImTransfer), "IM ThreadTransfer request");
export const decodeImContactsListFromHost = guardedDecoder(accepted(parseImCursor), "IM ContactsList request");
export const decodeImContactRequestFromHost = guardedDecoder(
  accepted(parseImContactRequest),
  "IM ContactRequest request",
);
export const decodeImContactAcceptFromHost = guardedDecoder(accepted(parseImContactId), "IM ContactAccept request");
export const decodeImContactRejectFromHost = guardedDecoder(accepted(parseImContactId), "IM ContactReject request");
export const decodeImContactRemoveFromHost = guardedDecoder(accepted(parseImContactId), "IM ContactRemove request");
export const decodeImBlocklistListFromHost = guardedDecoder(accepted(parseImCursor), "IM BlocklistList request");
export const decodeImBlocklistAddFromHost = guardedDecoder(accepted(parseImBlockAdd), "IM BlocklistAdd request");
export const decodeImBlocklistRemoveFromHost = guardedDecoder(accepted(parseImPeerRef), "IM BlocklistRemove request");
export const decodeImReportCreateFromHost = guardedDecoder(accepted(parseImReportCreate), "IM ReportCreate request");
export const decodeImReportsListFromHost = guardedDecoder(accepted(parseImCursor), "IM ReportsList request");

export interface ImRemoteServers {
  supportsCapability(serverId: string, capability: string): boolean;
  request<T>(
    serverId: string,
    path: string,
    decoder: ResponseDecoder<T>,
    init?: RemoteRequestInit,
  ): Effect.Effect<T, RemoteWorkflowError>;
}

export interface ImIpcDependencies {
  im: () => { service: ImService; memberId: string } | null;
  inbox: () => { service: ImInboxService; memberId: string } | null;
  lan: () => { host: ImHostApi; memberId: string } | null;
  remoteServers: ImRemoteServers;
}

export function imIpcHandlers({ im, inbox, lan, remoteServers }: ImIpcDependencies): Pick<IpcGroupHandlers, "im"> {
  function local(): { service: ImService; memberId: string } {
    const bound = im();
    if (!bound) throw new ImUnauthorized();
    return bound;
  }
  async function lanDeliver(message: { remoteMessageId: string }): Promise<void> {
    const bound = lan();
    if (!bound) return;
    await bound.host.lanResend(bound.memberId, {
      deliveryId: `dl-${message.remoteMessageId}`,
      at: Date.now(),
    });
  }
  function localInbox(): { service: ImInboxService; memberId: string } {
    const bound = inbox();
    if (!bound) throw new ImUnauthorized();
    return bound;
  }
  async function signalRelay(envelope: ImLanSignalEnvelope): Promise<void> {
    await remote(envelope.toServerId, IM_ROUTES.lanSignal, decodeImAccepted, imSignalEnvelopeToWire(envelope));
  }
  function remote<T>(serverId: string, path: string, decoder: ResponseDecoder<T>, body: unknown): Promise<T> {
    const capability = imCapabilityOfRoute(path);
    if (!capability || !remoteServers.supportsCapability(serverId, capability)) throw new ImProtocolFailure();
    return runCauseEffect(remoteServers.request(serverId, path, decoder, { method: "POST", body }));
  }
  const boundLan = lan();
  if (boundLan) boundLan.host.setSignalRelay(signalRelay);
  return {
    im: {
      messageSend: scopedHandler(decodeImMessageFromHost, {
        local: (input) => {
          const bound = local();
          const message = bound.service.sendFromClient(bound.memberId, input);
          void lanDeliver(message);
          return message;
        },
        remote: (input, serverId) => remote(serverId, IM_ROUTES.messageSend, decodeImMessage, input),
      }),
      messageList: scopedHandler(decodeImMessagesFromHost, {
        local: (input) => {
          const bound = local();
          return bound.service.listMessages(bound.memberId, input);
        },
        remote: (input, serverId) => remote(serverId, IM_ROUTES.messagesList, decodeImMessages, input),
      }),
      peersList: scopedHandler(decodeImPeersFromHost, {
        local: (input) => {
          const bound = local();
          return bound.service.listPeers(bound.memberId, input);
        },
        remote: (input, serverId) => remote(serverId, IM_ROUTES.peersList, decodeImPeers, input),
      }),
      peerVerify: scopedHandler(decodeImPeerFromHost, {
        local: (input) => {
          const bound = local();
          return bound.service.verifyPeer(bound.memberId, input);
        },
        remote: (input, serverId) => remote(serverId, IM_ROUTES.peerVerify, decodeImPeer, input),
      }),
      threadsList: scopedHandler(decodeImThreadsListFromHost, {
        local: () => {
          const bound = localInbox();
          return bound.service.listThreads(bound.memberId);
        },
        remote: (input, serverId) => remote(serverId, IM_ROUTES.threadsList, decodeImThreads, input),
      }),
      threadGet: scopedHandler(decodeImThreadGetFromHost, {
        local: (input) => {
          const bound = localInbox();
          return bound.service.getThread(bound.memberId, input);
        },
        remote: (input, serverId) => remote(serverId, IM_ROUTES.threadGet, decodeImThread, input),
      }),
      threadAssign: scopedHandler(decodeImThreadAssignFromHost, {
        local: (input) => {
          const bound = localInbox();
          return bound.service.assignThread(bound.memberId, input);
        },
        remote: (input, serverId) => remote(serverId, IM_ROUTES.threadAssign, decodeImThread, input),
      }),
      threadTransfer: scopedHandler(decodeImThreadTransferFromHost, {
        local: (input) => {
          const bound = localInbox();
          return bound.service.transferThread(bound.memberId, input);
        },
        remote: (input, serverId) => remote(serverId, IM_ROUTES.threadTransfer, decodeImThread, input),
      }),
      contactsList: scopedHandler(decodeImContactsListFromHost, {
        local: () => {
          const bound = localInbox();
          return bound.service.listContacts(bound.memberId);
        },
        remote: (input, serverId) => remote(serverId, IM_ROUTES.contactsList, decodeImContacts, input),
      }),
      contactRequest: scopedHandler(decodeImContactRequestFromHost, {
        local: (input) => {
          const bound = localInbox();
          return bound.service.requestContact(bound.memberId, {
            contactId: `c-${Date.now()}`,
            peer: input,
            note: input.note,
            at: Date.now(),
          });
        },
        remote: (input, serverId) => remote(serverId, IM_ROUTES.contactRequest, decodeImContact, input),
      }),
      contactAccept: scopedHandler(decodeImContactAcceptFromHost, {
        local: (input) => {
          const bound = localInbox();
          return bound.service.acceptContact(bound.memberId, { contactId: input.contactId, at: Date.now() });
        },
        remote: (input, serverId) => remote(serverId, IM_ROUTES.contactAccept, decodeImContact, input),
      }),
      contactReject: scopedHandler(decodeImContactRejectFromHost, {
        local: (input) => {
          const bound = localInbox();
          return bound.service.rejectContact(bound.memberId, { contactId: input.contactId, at: Date.now() });
        },
        remote: (input, serverId) => remote(serverId, IM_ROUTES.contactReject, decodeImContact, input),
      }),
      contactRemove: scopedHandler(decodeImContactRemoveFromHost, {
        local: (input) => {
          const bound = localInbox();
          return bound.service.removeContact(bound.memberId, { contactId: input.contactId, at: Date.now() });
        },
        remote: (input, serverId) => remote(serverId, IM_ROUTES.contactRemove, decodeImContact, input),
      }),
      blocklistList: scopedHandler(decodeImBlocklistListFromHost, {
        local: () => {
          const bound = localInbox();
          return bound.service.listBlocklist(bound.memberId);
        },
        remote: (input, serverId) => remote(serverId, IM_ROUTES.blocklistList, decodeImBlockRules, input),
      }),
      blocklistAdd: scopedHandler(decodeImBlocklistAddFromHost, {
        local: (input) => {
          const bound = localInbox();
          return bound.service.addBlock(bound.memberId, {
            ruleId: `b-${Date.now()}`,
            peer: input,
            reason: input.reason,
            at: Date.now(),
          });
        },
        remote: (input, serverId) => remote(serverId, IM_ROUTES.blocklistAdd, decodeImBlockRule, input),
      }),
      blocklistRemove: scopedHandler(decodeImBlocklistRemoveFromHost, {
        local: (input) => {
          const bound = localInbox();
          bound.service.removeBlock(bound.memberId, { peer: input });
          return bound.service.listBlocklist(bound.memberId);
        },
        remote: (input, serverId) => remote(serverId, IM_ROUTES.blocklistRemove, decodeImBlockRules, input),
      }),
      reportCreate: scopedHandler(decodeImReportCreateFromHost, {
        local: (input) => {
          const bound = localInbox();
          return bound.service.createReport(bound.memberId, { ...input, reportId: `rp-${Date.now()}`, at: Date.now() });
        },
        remote: (input, serverId) => remote(serverId, IM_ROUTES.reportCreate, decodeImReport, input),
      }),
      reportsList: scopedHandler(decodeImReportsListFromHost, {
        local: () => {
          const bound = localInbox();
          return bound.service.listReports(bound.memberId);
        },
        remote: (input, serverId) => remote(serverId, IM_ROUTES.reportsList, decodeImReports, input),
      }),
    },
  };
}
