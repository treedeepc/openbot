import {
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
  type ImMessage,
  type ImPage,
  type ImPeer,
} from "@openbot/contracts/ipc";
import { guardedDecoder } from "@openbot/contracts/ipc-decoding";

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

export const decodeImMessageFromMain = guardedDecoder<ImMessage>(accepted(decodeImMessage), "IM message response");
export const decodeImMessagesFromMain = guardedDecoder<ImPage<ImMessage>>(
  accepted(decodeImMessages),
  "IM message page response",
);
export const decodeImPeerFromMain = guardedDecoder<ImPeer>(accepted(decodeImPeer), "IM peer response");
export const decodeImPeersFromMain = guardedDecoder<ImPage<ImPeer>>(accepted(decodeImPeers), "IM peer page response");

export const decodeImThreadsListFromMain = guardedDecoder(accepted(decodeImThreads), "IM ThreadsList response");
export const decodeImThreadGetFromMain = guardedDecoder(accepted(decodeImThread), "IM ThreadGet response");
export const decodeImThreadAssignFromMain = guardedDecoder(accepted(decodeImThread), "IM ThreadAssign response");
export const decodeImThreadTransferFromMain = guardedDecoder(accepted(decodeImThread), "IM ThreadTransfer response");
export const decodeImContactsListFromMain = guardedDecoder(accepted(decodeImContacts), "IM ContactsList response");
export const decodeImContactRequestFromMain = guardedDecoder(accepted(decodeImContact), "IM ContactRequest response");
export const decodeImContactAcceptFromMain = guardedDecoder(accepted(decodeImContact), "IM ContactAccept response");
export const decodeImContactRejectFromMain = guardedDecoder(accepted(decodeImContact), "IM ContactReject response");
export const decodeImContactRemoveFromMain = guardedDecoder(accepted(decodeImContact), "IM ContactRemove response");
export const decodeImBlocklistListFromMain = guardedDecoder(accepted(decodeImBlockRules), "IM BlocklistList response");
export const decodeImBlocklistAddFromMain = guardedDecoder(accepted(decodeImBlockRule), "IM BlocklistAdd response");
export const decodeImBlocklistRemoveFromMain = guardedDecoder(
  accepted(decodeImBlockRules),
  "IM BlocklistRemove response",
);
export const decodeImReportCreateFromMain = guardedDecoder(accepted(decodeImReport), "IM ReportCreate response");
export const decodeImReportsListFromMain = guardedDecoder(accepted(decodeImReports), "IM ReportsList response");
