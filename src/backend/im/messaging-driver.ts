import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { ImMessage } from "@openbot/contracts/ipc";
import type { CausalChain } from "./causal-chain";
import { ImService } from "./im-service";

function requireUsdCents(value: number): number {
  if (!Number.isInteger(value) || value < 0) throw new ImProxyBudgetExceeded();
  return value;
}

import { ImMessageStore, type ImSendState } from "./messages";
import {
  ImProxyBudgetExceeded,
  ImProxySpeaking,
  type ImProxyVisibility,
  imExecutionDecision,
  imProxiedMessage,
} from "./proxy";
import {
  IM_RATE_LIMITS,
  type ImPeerRef,
  type ImRatePolicy,
  type ImSendDecision,
  ImSendGate,
  type ImSocialScope,
  imRateTargetId,
} from "./social";

export interface ImMessagingDriverInput {
  threadId: string;
  peer: ImPeerRef;
  body: string;
  remoteMessageId?: string;
  causalChainId?: string | null;
  proxiedBy?: string | null;
  proxyVisibility?: ImProxyVisibility | null;
  sentAt: number;
  expiresAt: number;
  policy?: ImRatePolicy;
}

export interface ImProxiedDriverInput extends ImMessagingDriverInput {
  proxiedBy: string;
  proxyVisibility: ImProxyVisibility | null;
  usdCents: number;
}

export interface ImSendResult {
  message: ImMessage;
  deliveryId: string;
  decision: ImSendDecision;
}

export class ImToolRefused extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(reason);
    this.name = "ImToolRefused";
    this.reason = reason;
  }
}

export class ImMessagingDriver {
  readonly #localServerId: string;
  readonly #service: ImService;
  readonly #messages: ImMessageStore;
  readonly gate: ImSendGate;
  readonly proxy: ImProxySpeaking;

  constructor(db: DatabaseSync, localServerId: string) {
    this.#localServerId = localServerId;
    this.#service = new ImService(db, localServerId);
    this.#messages = new ImMessageStore(db);
    this.gate = new ImSendGate(db);
    this.proxy = new ImProxySpeaking(db);
  }

  scope(memberId: string): ImSocialScope {
    return { localServerId: this.#localServerId, localMemberId: memberId };
  }

  send(memberId: string, input: ImMessagingDriverInput): ImSendResult {
    const decision = this.gate.decide({
      senderScope: this.scope(memberId),
      sender: { peerServerId: this.#localServerId, peerAgentId: memberId },
      recipientScope: this.scope(memberId),
      recipient: input.peer,
      action: "im.message",
      at: input.sentAt,
      policy: input.policy ?? IM_RATE_LIMITS.message,
    });
    if (decision.outcome !== "sent") return this.#discard(input, decision);
    const message = this.#persist(memberId, input);
    this.gate.recordSent({
      senderScope: this.scope(memberId),
      sender: { peerServerId: this.#localServerId, peerAgentId: memberId },
      recipientScope: this.scope(memberId),
      recipient: input.peer,
      action: "im.message",
      at: input.sentAt,
      policy: input.policy ?? IM_RATE_LIMITS.message,
    });
    return { message, deliveryId: `dl-${message.remoteMessageId}`, decision };
  }

  sendProxied(memberId: string, input: ImProxiedDriverInput): ImSendResult {
    const marked = imProxiedMessage({
      speaker: memberId,
      onBehalfOf: input.proxiedBy,
      visibility: input.proxyVisibility,
      body: input.body,
    });
    const usdCents = requireUsdCents(input.usdCents);
    const peerKey = imRateTargetId(input.peer);
    if (!this.proxy.canSpeak(this.scope(memberId), peerKey, usdCents, input.sentAt)) {
      throw new ImProxyBudgetExceeded();
    }
    const result = this.send(memberId, {
      ...input,
      body: marked.body,
      proxiedBy: marked.proxiedBy,
      proxyVisibility: marked.proxyVisibility,
    });
    if (result.decision.outcome === "sent") {
      this.proxy.charge(this.scope(memberId), peerKey, usdCents, input.sentAt);
    }
    return result;
  }

  advance(deliveryId: string, state: ImSendState, at: number): void {
    this.#messages.setDeliveryState(deliveryId, state, at);
  }

  execute<T>(chain: CausalChain | null | undefined, work: () => T): T {
    const decision = imExecutionDecision(chain);
    if (!decision.mayExecuteTools) throw new ImToolRefused(decision.reason ?? "im.toolDenied");
    return work();
  }

  speak<T>(chain: CausalChain | null | undefined, work: () => T): T {
    const decision = imExecutionDecision(chain);
    if (!decision.maySpeak) throw new ImToolRefused(decision.reason ?? "im.unauthorized");
    return work();
  }

  #persist(memberId: string, input: ImMessagingDriverInput): ImMessage {
    const remoteMessageId = input.remoteMessageId ?? randomUUID();
    return this.#service.sendFromClient(memberId, {
      threadId: input.threadId,
      remoteMessageId,
      body: input.body,
      attachments: [],
      replyTo: null,
      proxiedBy: input.proxiedBy ?? null,
      proxyVisibility: input.proxyVisibility ?? null,
      ...(input.causalChainId === undefined ? {} : { causalChainId: input.causalChainId }),
      at: input.sentAt,
    });
  }

  #discard(input: ImMessagingDriverInput, decision: ImSendDecision): ImSendResult {
    const message: ImMessage = {
      localMessageId: `lm-${input.remoteMessageId ?? randomUUID()}`,
      remoteMessageId: input.remoteMessageId ?? "",
      threadId: input.threadId,
      senderKind: "self",
      senderAgentId: null,
      deviceId: null,
      body: input.body,
      attachments: [],
      replyTo: null,
      proxiedBy: null,
      proxyVisibility: null,
      causalChainId: input.causalChainId ?? null,
      sentAt: input.sentAt,
      expiresAt: input.expiresAt,
      withdrawnAt: null,
      verified: false,
    };
    return { message, deliveryId: "", decision };
  }
}
