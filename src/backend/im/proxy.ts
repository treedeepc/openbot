import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { databaseRow, databaseRows } from "../database/database-rows";
import { withTransaction } from "../database/sqlite-transaction";
import { type CausalChain, isExternalChain, toolsDecision } from "./causal-chain";

export interface ImProxyScope {
  localServerId: string;
  localMemberId: string;
}

export const IM_THREAD_ROLES = ["primary", "assist"] as const;
export type ImThreadRole = (typeof IM_THREAD_ROLES)[number];

export interface ImThreadAssignee {
  agentId: string;
  role: ImThreadRole;
}

export class ImThreadUnknown extends Error {
  constructor() {
    super("im.threadNotFound");
    this.name = "ImThreadUnknown";
  }
}

export class ImNotPrimary extends Error {
  constructor() {
    super("im.notAssignee");
    this.name = "ImNotPrimary";
  }
}

export class ImPrimaryRequired extends Error {
  constructor() {
    super("im.primaryRequired");
    this.name = "ImPrimaryRequired";
  }
}

function role(value: unknown): ImThreadRole {
  return value === "primary" ? "primary" : "assist";
}

export class ImPrimaryChain {
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  assignees(scope: ImProxyScope, threadId: string): ImThreadAssignee[] {
    return databaseRows(
      this.#db
        .prepare(
          "SELECT agent_id, role FROM im_thread_assignees WHERE local_server_id = ? AND local_member_id = ? AND thread_id = ? ORDER BY agent_id",
        )
        .all(scope.localServerId, scope.localMemberId, threadId),
    ).map((row) => ({ agentId: String(row.agent_id), role: role(row.role) }));
  }

  primary(scope: ImProxyScope, threadId: string): string | null {
    return this.assignees(scope, threadId).find((assignee) => assignee.role === "primary")?.agentId ?? null;
  }

  assign(scope: ImProxyScope, threadId: string, agentId: string, assignRole: ImThreadRole): ImThreadAssignee[] {
    return withTransaction(this.#db, () => {
      this.#requireThread(scope, threadId);
      this.#upsert(scope, threadId, agentId, assignRole);
      return this.assignees(scope, threadId);
    });
  }

  transfer(scope: ImProxyScope, threadId: string, fromAgentId: string, toAgentId: string): ImThreadAssignee[] {
    return withTransaction(this.#db, () => {
      this.#requireThread(scope, threadId);
      const current = this.primary(scope, threadId);
      if (current === null) throw new ImPrimaryRequired();
      if (current !== fromAgentId) throw new ImNotPrimary();
      if (fromAgentId === toAgentId) return this.assignees(scope, threadId);
      this.#upsert(scope, threadId, fromAgentId, "assist");
      this.#upsert(scope, threadId, toAgentId, "primary");
      return this.assignees(scope, threadId);
    });
  }

  remove(scope: ImProxyScope, threadId: string, agentId: string): ImThreadAssignee[] {
    return withTransaction(this.#db, () => {
      this.#requireThread(scope, threadId);
      if (this.primary(scope, threadId) === agentId) throw new ImPrimaryRequired();
      this.#db
        .prepare(
          "DELETE FROM im_thread_assignees WHERE local_server_id = ? AND local_member_id = ? AND thread_id = ? AND agent_id = ?",
        )
        .run(scope.localServerId, scope.localMemberId, threadId, agentId);
      return this.assignees(scope, threadId);
    });
  }

  #requireThread(scope: ImProxyScope, threadId: string): void {
    const row = databaseRow(
      this.#db
        .prepare("SELECT thread_id FROM im_threads WHERE local_server_id = ? AND local_member_id = ? AND thread_id = ?")
        .get(scope.localServerId, scope.localMemberId, threadId),
    );
    if (!row) throw new ImThreadUnknown();
  }

  #upsert(scope: ImProxyScope, threadId: string, agentId: string, assignRole: ImThreadRole): void {
    this.#db
      .prepare(
        `INSERT INTO im_thread_assignees (local_server_id, local_member_id, thread_id, agent_id, role)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(local_server_id, local_member_id, thread_id, agent_id) DO UPDATE SET role = excluded.role`,
      )
      .run(scope.localServerId, scope.localMemberId, threadId, agentId, assignRole);
  }
}

export const IM_PROXY_BUDGET_USD_DEFAULT = 20;
export const IM_PROXY_BUDGET_USD = IM_PROXY_BUDGET_USD_DEFAULT;

export interface ImProxySettings {
  enabled: boolean;
  visibility: ImProxyVisibility;
  monthlyBudgetUsd: number;
}

export class ImProxyBudgetLimit extends Error {
  constructor() {
    super("im.budgetExceeded");
    this.name = "ImProxyBudgetLimit";
  }
}

export class ImProxySettingsStore {
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  read(scope: ImProxyScope): ImProxySettings {
    const row = databaseRow(
      this.#db
        .prepare(
          "SELECT enabled, visibility, monthly_budget_usd FROM im_proxy_settings WHERE local_server_id = ? AND local_member_id = ?",
        )
        .get(scope.localServerId, scope.localMemberId),
    );
    if (!row) {
      return { enabled: false, visibility: "shown", monthlyBudgetUsd: IM_PROXY_BUDGET_USD_DEFAULT };
    }
    return {
      enabled: Number(row.enabled) === 1,
      visibility: row.visibility === "hidden" ? "hidden" : "shown",
      monthlyBudgetUsd: Number(row.monthly_budget_usd),
    };
  }

  write(scope: ImProxyScope, input: Partial<ImProxySettings> & { at: number }): ImProxySettings {
    const current = this.read(scope);
    const next: ImProxySettings = {
      enabled: input.enabled ?? current.enabled,
      visibility: input.visibility ?? current.visibility,
      monthlyBudgetUsd: input.monthlyBudgetUsd ?? current.monthlyBudgetUsd,
    };
    if (!Number.isInteger(next.monthlyBudgetUsd) || next.monthlyBudgetUsd < 0 || next.monthlyBudgetUsd > 1000) {
      throw new ImProxyBudgetLimit();
    }
    this.#db
      .prepare(
        `INSERT INTO im_proxy_settings (local_server_id, local_member_id, enabled, visibility, monthly_budget_usd, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(local_server_id, local_member_id) DO UPDATE SET enabled = excluded.enabled,
           visibility = excluded.visibility, monthly_budget_usd = excluded.monthly_budget_usd,
           updated_at = excluded.updated_at`,
      )
      .run(
        scope.localServerId,
        scope.localMemberId,
        next.enabled ? 1 : 0,
        next.visibility,
        next.monthlyBudgetUsd,
        input.at,
      );
    return next;
  }
}
export const IM_PROXY_BUDGET_ACTION = "im.proxySpend";
const CENTS_PER_USD = 100;

export interface ImProxyBudget {
  limitUsd: number;
  spentUsd: number;
  remainingUsd: number;
  month: string;
}

export class ImProxyBudgetExceeded extends Error {
  constructor() {
    super("im.budgetExceeded");
    this.name = "ImProxyBudgetExceeded";
  }
}

export class ImProxySpeaking {
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  month(at: number): string {
    return new Date(at).toISOString().slice(0, 7);
  }

  limitUsd(scope: ImProxyScope): number {
    return new ImProxySettingsStore(this.#db).read(scope).monthlyBudgetUsd;
  }

  budget(scope: ImProxyScope, peerKey: string, at: number): ImProxyBudget {
    const month = this.month(at);
    const limit = this.limitUsd(scope);
    const row = databaseRow(
      this.#db
        .prepare(
          `SELECT count FROM audit_aggregates
           WHERE local_server_id = ? AND local_member_id = ? AND bucket = ? AND actor_id = ?
             AND action = ? AND target_id = ? AND result = 'spent'`,
        )
        .get(scope.localServerId, scope.localMemberId, month, peerKey, IM_PROXY_BUDGET_ACTION, peerKey),
    );
    const spentUsd = (row ? Number(row.count) : 0) / CENTS_PER_USD;
    return {
      limitUsd: limit,
      spentUsd,
      remainingUsd: Math.max(0, limit - spentUsd),
      month,
    };
  }

  charge(scope: ImProxyScope, peerKey: string, usdCents: number, at: number): ImProxyBudget {
    if (!Number.isInteger(usdCents) || usdCents < 0) throw new ImProxyBudgetExceeded();
    const month = this.month(at);
    const current = this.budget(scope, peerKey, at);
    if (current.spentUsd * CENTS_PER_USD + usdCents > this.limitUsd(scope) * CENTS_PER_USD) {
      throw new ImProxyBudgetExceeded();
    }
    this.#db
      .prepare(
        `INSERT INTO audit_aggregates (local_server_id, local_member_id, bucket, actor_id, action, target_id, result,
          count, first_at, last_at, summary)
         VALUES (?, ?, ?, ?, ?, ?, 'spent', ?, ?, ?, NULL)
         ON CONFLICT(local_server_id, local_member_id, bucket, actor_id, action, target_id, result) DO UPDATE SET
           count = audit_aggregates.count + excluded.count, last_at = excluded.last_at`,
      )
      .run(scope.localServerId, scope.localMemberId, month, peerKey, IM_PROXY_BUDGET_ACTION, peerKey, usdCents, at, at);
    return this.budget(scope, peerKey, at);
  }

  canSpeak(scope: ImProxyScope, peerKey: string, usdCents: number, at: number): boolean {
    const current = this.budget(scope, peerKey, at);
    return current.spentUsd * CENTS_PER_USD + usdCents <= this.limitUsd(scope) * CENTS_PER_USD;
  }
}

export const IM_PROXY_VISIBILITY = ["shown", "hidden"] as const;
export type ImProxyVisibility = (typeof IM_PROXY_VISIBILITY)[number];

export interface ImProxiedMessage {
  localMessageId: string;
  proxiedBy: string | null;
  proxyVisibility: ImProxyVisibility | null;
  body: string;
}

export class ImProxyNotAllowed extends Error {
  constructor() {
    super("im.notFriend");
    this.name = "ImProxyNotAllowed";
  }
}

export function imProxiedMessage(input: {
  speaker: string;
  onBehalfOf: string | null;
  visibility: ImProxyVisibility | null;
  body: string;
}): ImProxiedMessage {
  if (input.onBehalfOf !== null && input.visibility === null) throw new ImProxyNotAllowed();
  return {
    localMessageId: `lm-${randomUUID()}`,
    proxiedBy: input.onBehalfOf,
    proxyVisibility: input.onBehalfOf === null ? null : input.visibility,
    body: input.body,
  };
}

export interface ImExecutionDecision {
  mayExecuteTools: boolean;
  maySpeak: boolean;
  reason: string | null;
}

export function imExecutionDecision(chain: CausalChain | null | undefined): ImExecutionDecision {
  const decision = toolsDecision(chain);
  return {
    mayExecuteTools: decision.toolsEnabled,
    maySpeak: decision.allowed,
    reason: decision.reason,
  };
}

export function imExternalSpeaksOnly(chain: CausalChain | null | undefined): boolean {
  return isExternalChain(chain) && toolsDecision(chain).toolsEnabled === false;
}
