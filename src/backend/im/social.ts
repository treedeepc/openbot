import type { DatabaseSync } from "node:sqlite";
import type { DynamicRecord } from "@openbot/contracts/runtime-values";
import { databaseRow, databaseRows } from "../database/database-rows";
import type { ImApprovalRatePort } from "./identity";

export interface ImSocialScope {
  localServerId: string;
  localMemberId: string;
}

export interface ImPeerRef {
  peerServerId: string;
  peerAgentId: string;
}

export const IM_CONTACT_STATES = ["pending", "accepted", "removed"] as const;
export type ImContactState = (typeof IM_CONTACT_STATES)[number];

export interface ImContactRecord {
  contactId: string;
  peerServerId: string;
  peerAgentId: string;
  alias: string | null;
  state: ImContactState;
  addedAt: number;
  source: string | null;
  updatedAt: number;
}

export const IM_REQUEST_DIRECTIONS = ["inbound", "outbound"] as const;
export type ImRequestDirection = (typeof IM_REQUEST_DIRECTIONS)[number];

export interface ImContactRequestRecord {
  requestId: string;
  direction: ImRequestDirection;
  peerServerId: string;
  peerAgentId: string;
  message: string | null;
  createdAt: number;
  resolvedAt: number | null;
  attempts: number;
}

export interface ImBlockRule {
  ruleId: string;
  peerServerId: string;
  peerAgentId: string;
  createdAt: number;
  reason: string | null;
}

export const IM_REPORT_STATUSES = ["open", "reviewed", "actioned", "dismissed"] as const;
export type ImReportStatus = (typeof IM_REPORT_STATUSES)[number];

export const IM_REPORT_CATEGORIES = ["spam", "abuse", "impersonation", "scam", "other"] as const;
export type ImReportCategory = (typeof IM_REPORT_CATEGORIES)[number];

export interface ImReportRecord {
  reportId: string;
  targetPeer: string;
  category: ImReportCategory;
  detail: string | null;
  status: ImReportStatus;
  createdAt: number;
  resolvedAt: number | null;
}

export class ImDuplicateContact extends Error {
  constructor() {
    super("im.contactExists");
    this.name = "ImDuplicateContact";
  }
}

export class ImContactNotFound extends Error {
  constructor() {
    super("im.contactNotFound");
    this.name = "ImContactNotFound";
  }
}

export class ImBlockedPeer extends Error {
  constructor() {
    super("im.peerBlocked");
    this.name = "ImBlockedPeer";
  }
}

function contactState(value: unknown): ImContactState {
  return value === "accepted" ? "accepted" : value === "removed" ? "removed" : "pending";
}

function reportStatus(value: unknown): ImReportStatus {
  return value === "reviewed"
    ? "reviewed"
    : value === "actioned"
      ? "actioned"
      : value === "dismissed"
        ? "dismissed"
        : "open";
}

function reportCategory(value: unknown): ImReportCategory {
  return value === "spam"
    ? "spam"
    : value === "abuse"
      ? "abuse"
      : value === "impersonation"
        ? "impersonation"
        : value === "scam"
          ? "scam"
          : "other";
}

function text(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function number(value: unknown): number {
  return Number(value ?? 0);
}

export class ImContactStore {
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  request(
    input: ImSocialScope & {
      contactId: string;
      peer: ImPeerRef;
      alias?: string | null;
      source?: string | null;
      at: number;
    },
  ): ImContactRecord {
    const existing = this.find(input, input.peer);
    if (existing && existing.state !== "removed") throw new ImDuplicateContact();
    const record: ImContactRecord = {
      contactId: input.contactId,
      peerServerId: input.peer.peerServerId,
      peerAgentId: input.peer.peerAgentId,
      alias: input.alias ?? null,
      state: "pending",
      addedAt: input.at,
      source: input.source ?? null,
      updatedAt: input.at,
    };
    this.#write(input, record);
    return record;
  }

  accept(input: ImSocialScope & { peer: ImPeerRef; at: number }): ImContactRecord {
    const record = this.find(input, input.peer);
    if (!record) throw new ImContactNotFound();
    const accepted: ImContactRecord = { ...record, state: "accepted", updatedAt: input.at };
    this.#write(input, accepted);
    return accepted;
  }

  remove(input: ImSocialScope & { peer: ImPeerRef; at: number }): ImContactRecord {
    const record = this.find(input, input.peer);
    if (!record) throw new ImContactNotFound();
    const removed: ImContactRecord = { ...record, state: "removed", updatedAt: input.at };
    this.#write(input, removed);
    return removed;
  }

  find(input: ImSocialScope, peer: ImPeerRef): ImContactRecord | null {
    const row = databaseRow(
      this.#db
        .prepare(
          "SELECT * FROM contacts WHERE local_server_id = ? AND local_member_id = ? AND peer_server_id = ? AND peer_agent_id = ?",
        )
        .get(input.localServerId, input.localMemberId, peer.peerServerId, peer.peerAgentId),
    );
    return row ? readContact(row) : null;
  }

  list(input: ImSocialScope): ImContactRecord[] {
    return databaseRows(
      this.#db
        .prepare(
          "SELECT * FROM contacts WHERE local_server_id = ? AND local_member_id = ? ORDER BY added_at, contact_id",
        )
        .all(input.localServerId, input.localMemberId),
    ).map(readContact);
  }

  #write(input: ImSocialScope, record: ImContactRecord): void {
    this.#db
      .prepare(
        `INSERT INTO contacts (local_server_id, local_member_id, contact_id, peer_server_id, peer_agent_id,
          alias, state, added_at, source, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(local_server_id, local_member_id, contact_id) DO UPDATE SET
           alias = excluded.alias, state = excluded.state, source = excluded.source, updated_at = excluded.updated_at`,
      )
      .run(
        input.localServerId,
        input.localMemberId,
        record.contactId,
        record.peerServerId,
        record.peerAgentId,
        record.alias,
        record.state,
        record.addedAt,
        record.source,
        record.updatedAt,
      );
  }
}

function readContact(row: DynamicRecord): ImContactRecord {
  return {
    contactId: String(row.contact_id),
    peerServerId: String(row.peer_server_id),
    peerAgentId: String(row.peer_agent_id),
    alias: text(row.alias),
    state: contactState(row.state),
    addedAt: number(row.added_at),
    source: text(row.source),
    updatedAt: number(row.updated_at),
  };
}

export class ImContactRequestStore {
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  create(
    input: ImSocialScope & {
      requestId: string;
      direction: ImRequestDirection;
      peer: ImPeerRef;
      message?: string | null;
      at: number;
    },
  ): ImContactRequestRecord {
    const record: ImContactRequestRecord = {
      requestId: input.requestId,
      direction: input.direction,
      peerServerId: input.peer.peerServerId,
      peerAgentId: input.peer.peerAgentId,
      message: input.message ?? null,
      createdAt: input.at,
      resolvedAt: null,
      attempts: 1,
    };
    this.#db
      .prepare(
        `INSERT INTO contact_requests (local_server_id, local_member_id, request_id, direction, peer_server_id,
          peer_agent_id, message, created_at, resolved_at, attempts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 1)
         ON CONFLICT(local_server_id, local_member_id, request_id) DO UPDATE SET
           attempts = contact_requests.attempts + 1, message = excluded.message`,
      )
      .run(
        input.localServerId,
        input.localMemberId,
        record.requestId,
        record.direction,
        record.peerServerId,
        record.peerAgentId,
        record.message,
        record.createdAt,
      );
    return record;
  }

  resolve(input: ImSocialScope & { requestId: string; at: number }): ImContactRequestRecord {
    const row = databaseRow(
      this.#db
        .prepare("SELECT * FROM contact_requests WHERE local_server_id = ? AND local_member_id = ? AND request_id = ?")
        .get(input.localServerId, input.localMemberId, input.requestId),
    );
    if (!row) throw new ImContactNotFound();
    this.#db
      .prepare(
        "UPDATE contact_requests SET resolved_at = ? WHERE local_server_id = ? AND local_member_id = ? AND request_id = ?",
      )
      .run(input.at, input.localServerId, input.localMemberId, input.requestId);
    return { ...readRequest(row), resolvedAt: input.at };
  }

  list(input: ImSocialScope & { direction?: ImRequestDirection }): ImContactRequestRecord[] {
    const rows = input.direction
      ? databaseRows(
          this.#db
            .prepare(
              "SELECT * FROM contact_requests WHERE local_server_id = ? AND local_member_id = ? AND direction = ? ORDER BY created_at, request_id",
            )
            .all(input.localServerId, input.localMemberId, input.direction),
        )
      : databaseRows(
          this.#db
            .prepare(
              "SELECT * FROM contact_requests WHERE local_server_id = ? AND local_member_id = ? ORDER BY created_at, request_id",
            )
            .all(input.localServerId, input.localMemberId),
        );
    return rows.map(readRequest);
  }
}

function readRequest(row: DynamicRecord): ImContactRequestRecord {
  return {
    requestId: String(row.request_id),
    direction: row.direction === "outbound" ? "outbound" : "inbound",
    peerServerId: String(row.peer_server_id),
    peerAgentId: String(row.peer_agent_id),
    message: text(row.message),
    createdAt: number(row.created_at),
    resolvedAt: row.resolved_at === null ? null : number(row.resolved_at),
    attempts: number(row.attempts),
  };
}

export class ImBlockStore {
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  add(input: ImSocialScope & { ruleId: string; peer: ImPeerRef; reason?: string | null; at: number }): ImBlockRule {
    const rule: ImBlockRule = {
      ruleId: input.ruleId,
      peerServerId: input.peer.peerServerId,
      peerAgentId: input.peer.peerAgentId,
      createdAt: input.at,
      reason: input.reason ?? null,
    };
    this.#db
      .prepare(
        `INSERT INTO block_rules (local_server_id, local_member_id, rule_id, peer_server_id, peer_agent_id,
          created_at, reason)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(local_server_id, local_member_id, peer_server_id, peer_agent_id) DO UPDATE SET
           rule_id = excluded.rule_id, created_at = excluded.created_at, reason = excluded.reason`,
      )
      .run(
        input.localServerId,
        input.localMemberId,
        rule.ruleId,
        rule.peerServerId,
        rule.peerAgentId,
        rule.createdAt,
        rule.reason,
      );
    return rule;
  }

  remove(input: ImSocialScope & { peer: ImPeerRef }): boolean {
    return (
      this.#db
        .prepare(
          "DELETE FROM block_rules WHERE local_server_id = ? AND local_member_id = ? AND peer_server_id = ? AND peer_agent_id = ?",
        )
        .run(input.localServerId, input.localMemberId, input.peer.peerServerId, input.peer.peerAgentId).changes > 0
    );
  }

  isBlocked(input: ImSocialScope, peer: ImPeerRef): boolean {
    return (
      this.#db
        .prepare(
          "SELECT 1 FROM block_rules WHERE local_server_id = ? AND local_member_id = ? AND peer_server_id = ? AND peer_agent_id = ?",
        )
        .get(input.localServerId, input.localMemberId, peer.peerServerId, peer.peerAgentId) !== undefined
    );
  }

  list(input: ImSocialScope): ImBlockRule[] {
    return databaseRows(
      this.#db
        .prepare(
          "SELECT * FROM block_rules WHERE local_server_id = ? AND local_member_id = ? ORDER BY created_at, rule_id",
        )
        .all(input.localServerId, input.localMemberId),
    ).map((row) => ({
      ruleId: String(row.rule_id),
      peerServerId: String(row.peer_server_id),
      peerAgentId: String(row.peer_agent_id),
      createdAt: number(row.created_at),
      reason: text(row.reason),
    }));
  }
}

export class ImReportStore {
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  create(
    input: ImSocialScope & {
      reportId: string;
      targetPeer: string;
      category: ImReportCategory;
      detail?: string | null;
      at: number;
    },
  ): ImReportRecord {
    const record: ImReportRecord = {
      reportId: input.reportId,
      targetPeer: input.targetPeer,
      category: input.category,
      detail: input.detail ?? null,
      status: "open",
      createdAt: input.at,
      resolvedAt: null,
    };
    this.#db
      .prepare(
        `INSERT INTO im_reports (local_server_id, local_member_id, report_id, target_peer, category, detail,
          status, created_at, resolved_at)
         VALUES (?, ?, ?, ?, ?, ?, 'open', ?, NULL)`,
      )
      .run(
        input.localServerId,
        input.localMemberId,
        record.reportId,
        record.targetPeer,
        record.category,
        record.detail,
        record.createdAt,
      );
    return record;
  }

  resolve(
    input: ImSocialScope & { reportId: string; status: Exclude<ImReportStatus, "open">; at: number },
  ): ImReportRecord {
    const row = databaseRow(
      this.#db
        .prepare("SELECT * FROM im_reports WHERE local_server_id = ? AND local_member_id = ? AND report_id = ?")
        .get(input.localServerId, input.localMemberId, input.reportId),
    );
    if (!row) throw new ImContactNotFound();
    this.#db
      .prepare(
        "UPDATE im_reports SET status = ?, resolved_at = ? WHERE local_server_id = ? AND local_member_id = ? AND report_id = ?",
      )
      .run(input.status, input.at, input.localServerId, input.localMemberId, input.reportId);
    return { ...readReport(row), status: input.status, resolvedAt: input.at };
  }

  list(input: ImSocialScope): ImReportRecord[] {
    return databaseRows(
      this.#db
        .prepare(
          "SELECT * FROM im_reports WHERE local_server_id = ? AND local_member_id = ? ORDER BY created_at, report_id",
        )
        .all(input.localServerId, input.localMemberId),
    ).map(readReport);
  }
}

function readReport(row: DynamicRecord): ImReportRecord {
  return {
    reportId: String(row.report_id),
    targetPeer: String(row.target_peer),
    category: reportCategory(row.category),
    detail: text(row.detail),
    status: reportStatus(row.status),
    createdAt: number(row.created_at),
    resolvedAt: row.resolved_at === null ? null : number(row.resolved_at),
  };
}

export interface ImRatePolicy {
  windowMs: number;
  max: number;
  cooldownMs: number;
}

export const IM_RATE_LIMITS = {
  message: { windowMs: 60_000, max: 30, cooldownMs: 0 },
  contactRequest: { windowMs: 3_600_000, max: 10, cooldownMs: 60_000 },
  report: { windowMs: 86_400_000, max: 20, cooldownMs: 5_000 },
  pairingApprove: { windowMs: 900_000, max: 5, cooldownMs: 1_000 },
  search: { windowMs: 60_000, max: 30, cooldownMs: 0 },
} as const satisfies Record<string, ImRatePolicy>;

export interface ImRateDecision {
  allowed: boolean;
  reason: "ok" | "rate-limited" | "cooldown";
  retryAfterMs: number;
  used: number;
}

export class ImRateLimiter {
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  peek(
    input: ImSocialScope & {
      actorId: string;
      action: string;
      targetId: string;
      at: number;
      policy: ImRatePolicy;
      result?: string;
    },
  ): ImRateDecision {
    const bucket = String(Math.floor(input.at / input.policy.windowMs));
    const row = databaseRow(
      this.#db
        .prepare(
          `SELECT count, last_at FROM audit_aggregates
           WHERE local_server_id = ? AND local_member_id = ? AND bucket = ? AND actor_id = ? AND action = ?
             AND target_id = ? AND result = ?`,
        )
        .get(
          input.localServerId,
          input.localMemberId,
          bucket,
          input.actorId,
          input.action,
          input.targetId,
          input.result ?? "ok",
        ),
    );
    const used = row ? number(row.count) : 0;
    const lastAt = row ? number(row.last_at) : 0;
    const cooldownLeft = lastAt > 0 ? input.policy.cooldownMs - (input.at - lastAt) : 0;
    if (cooldownLeft > 0) return { allowed: false, reason: "cooldown", retryAfterMs: cooldownLeft, used };
    if (used >= input.policy.max) {
      return {
        allowed: false,
        reason: "rate-limited",
        retryAfterMs: input.policy.windowMs - (input.at % input.policy.windowMs),
        used,
      };
    }
    return { allowed: true, reason: "ok", retryAfterMs: 0, used };
  }

  record(
    input: ImSocialScope & {
      actorId: string;
      action: string;
      targetId: string;
      at: number;
      policy: ImRatePolicy;
      result?: string;
    },
  ): void {
    const bucket = String(Math.floor(input.at / input.policy.windowMs));
    this.#db
      .prepare(
        `INSERT INTO audit_aggregates (local_server_id, local_member_id, bucket, actor_id, action, target_id, result,
          count, first_at, last_at, summary)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, NULL)
         ON CONFLICT(local_server_id, local_member_id, bucket, actor_id, action, target_id, result) DO UPDATE SET
           count = audit_aggregates.count + 1, last_at = excluded.last_at`,
      )
      .run(
        input.localServerId,
        input.localMemberId,
        bucket,
        input.actorId,
        input.action,
        input.targetId,
        input.result ?? "ok",
        input.at,
        input.at,
      );
  }
}

export const IM_SEND_OUTCOMES = ["sent", "blocked-discarded", "rate-limited-discarded"] as const;
export type ImSendOutcome = (typeof IM_SEND_OUTCOMES)[number];

export interface ImSendDecision {
  outcome: ImSendOutcome;
  pseudoSuccess: boolean;
  notify: boolean;
  retry: boolean;
  reason: "ok" | "blocked-outbound" | "blocked-inbound" | "rate-limited" | "cooldown";
}

export function imSendDecision(input: {
  outboundBlocked: boolean;
  inboundBlocked: boolean;
  rate: ImRateDecision;
}): ImSendDecision {
  if (input.outboundBlocked) return pseudo("blocked-outbound");
  if (input.inboundBlocked) return pseudo("blocked-inbound");
  if (!input.rate.allowed) return pseudo(input.rate.reason === "cooldown" ? "cooldown" : "rate-limited");
  return { outcome: "sent", pseudoSuccess: false, notify: true, retry: true, reason: "ok" };
}

function pseudo(reason: ImSendDecision["reason"]): ImSendDecision {
  return {
    outcome: reason === "rate-limited" || reason === "cooldown" ? "rate-limited-discarded" : "blocked-discarded",
    pseudoSuccess: true,
    notify: false,
    retry: false,
    reason,
  };
}

export function imRateTargetId(peer: ImPeerRef): string {
  return `${peer.peerServerId}/${peer.peerAgentId}`;
}

export class ImSendGate {
  readonly blocks: ImBlockStore;
  readonly limiter: ImRateLimiter;

  constructor(db: DatabaseSync) {
    this.blocks = new ImBlockStore(db);
    this.limiter = new ImRateLimiter(db);
  }

  decide(input: {
    senderScope: ImSocialScope;
    sender: ImPeerRef;
    recipientScope: ImSocialScope;
    recipient: ImPeerRef;
    action: string;
    at: number;
    policy: ImRatePolicy;
  }): ImSendDecision {
    return imSendDecision({
      outboundBlocked: this.blocks.isBlocked(input.senderScope, input.recipient),
      inboundBlocked: this.blocks.isBlocked(input.recipientScope, input.sender),
      rate: this.peekRate(input),
    });
  }

  recordSent(input: {
    senderScope: ImSocialScope;
    sender: ImPeerRef;
    recipientScope: ImSocialScope;
    recipient: ImPeerRef;
    action: string;
    at: number;
    policy: ImRatePolicy;
  }): void {
    this.limiter.record({ ...this.rateKey(input), at: input.at, policy: input.policy });
  }

  peekRate(input: {
    senderScope: ImSocialScope;
    sender: ImPeerRef;
    recipientScope: ImSocialScope;
    recipient: ImPeerRef;
    action: string;
    at: number;
    policy: ImRatePolicy;
  }): ImRateDecision {
    return this.limiter.peek({ ...this.rateKey(input), at: input.at, policy: input.policy });
  }

  rateKey(input: {
    senderScope: ImSocialScope;
    sender: ImPeerRef;
    recipientScope: ImSocialScope;
    recipient: ImPeerRef;
    action: string;
  }): ImSocialScope & { actorId: string; action: string; targetId: string } {
    return {
      ...input.senderScope,
      actorId: imRateTargetId(input.sender),
      action: input.action,
      targetId: imRateTargetId(input.recipient),
    };
  }
}

export const IM_PAIRING_APPROVE_ACTION = "im.pairingApprove";
const IM_PAIRING_APPROVE_RESULT = "denied";

export function imApprovalRatePort(
  limiter: ImRateLimiter,
  scope: ImSocialScope,
  policy: ImRatePolicy = IM_RATE_LIMITS.pairingApprove,
): ImApprovalRatePort {
  return {
    checkApproval: ({ deviceId, at }) => {
      const decision = limiter.peek({
        ...scope,
        actorId: deviceId,
        action: IM_PAIRING_APPROVE_ACTION,
        targetId: deviceId,
        at,
        policy,
        result: IM_PAIRING_APPROVE_RESULT,
      });
      return { allowed: decision.allowed, retryAfterMs: decision.retryAfterMs };
    },
    recordApprovalFailure: ({ deviceId, at }) => {
      limiter.record({
        ...scope,
        actorId: deviceId,
        action: IM_PAIRING_APPROVE_ACTION,
        targetId: deviceId,
        at,
        policy,
        result: IM_PAIRING_APPROVE_RESULT,
      });
    },
  };
}
