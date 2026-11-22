export const IM_TRUST_DOMAINS = ["local", "im-peer", "im-proxy", "third-party"] as const;
export type ImTrustDomain = (typeof IM_TRUST_DOMAINS)[number];

export const IM_EXTERNAL_TRUST_DOMAINS: readonly ImTrustDomain[] = ["im-peer", "im-proxy", "third-party"];

export const IM_INBOUND_ACTIONS = ["reply", "stop", "approval"] as const;
export type ImInboundAction = (typeof IM_INBOUND_ACTIONS)[number];

export const IM_EXTERNAL_CONTEXT_SOURCES = ["current-message", "explicit-attachment", "session-history"] as const;
export type ImExternalContextSource = (typeof IM_EXTERNAL_CONTEXT_SOURCES)[number];

export const IM_FORBIDDEN_CONTEXT_SOURCES = [
  "local-memory",
  "workspace-instructions",
  "crm",
  "library",
  "other-session",
  "local-file",
  "skill-output",
] as const;
export type ImForbiddenContextSource = (typeof IM_FORBIDDEN_CONTEXT_SOURCES)[number];

export interface CausalChain {
  chainId: string;
  rootMessageId: string;
  trustDomain: ImTrustDomain;
  createdAt: number;
}

export interface InboundRequest {
  action: ImInboundAction;
  chainId: string | null;
  sessionThreadId: string;
  targetThreadId: string | null;
  targetKind: "own-reply" | "local-task" | "other-session" | "system-process";
}

export interface InboundDecision {
  allowed: boolean;
  reason: string | null;
  toolsEnabled: boolean;
}

export class CausalChainMissing extends Error {
  constructor() {
    super("im.protocolError");
    this.name = "CausalChainMissing";
  }
}

export function isExternalChain(chain: CausalChain | null | undefined): boolean {
  return chain !== null && chain !== undefined && IM_EXTERNAL_TRUST_DOMAINS.includes(chain.trustDomain);
}

export function requireChain(chain: CausalChain | null | undefined): CausalChain {
  if (!chain) throw new CausalChainMissing();
  return chain;
}

export function inheritedChain(
  parent: CausalChain | null | undefined,
  derived: { chainId?: string | null; createdAt: number },
): CausalChain {
  const source = requireChain(parent);
  return {
    chainId: derived.chainId ?? source.chainId,
    rootMessageId: source.rootMessageId,
    trustDomain: source.trustDomain,
    createdAt: derived.createdAt,
  };
}

export function mayUseTools(chain: CausalChain | null | undefined): boolean {
  if (!chain) return false;
  return !isExternalChain(chain);
}

export function authorizeToolCall(chain: CausalChain | null | undefined): InboundDecision {
  if (chain === undefined) return { allowed: false, reason: "im.unauthorized", toolsEnabled: false };
  if (chain === null) return { allowed: true, reason: null, toolsEnabled: true };
  return toolsDecision(chain);
}

export function toolsDecision(chain: CausalChain | null | undefined): InboundDecision {
  if (!chain) return { allowed: false, reason: "im.unauthorized", toolsEnabled: false };
  if (isExternalChain(chain)) return { allowed: true, reason: null, toolsEnabled: false };
  return { allowed: true, reason: null, toolsEnabled: true };
}

export function decideInboundAction(request: InboundRequest): InboundDecision {
  if (request.action === "approval") return { allowed: false, reason: "im.unauthorized", toolsEnabled: false };
  if (request.action === "stop") {
    const ownReply = request.targetKind === "own-reply" && request.targetThreadId === request.sessionThreadId;
    return ownReply
      ? { allowed: true, reason: null, toolsEnabled: false }
      : { allowed: false, reason: "im.unauthorized", toolsEnabled: false };
  }
  return { allowed: true, reason: null, toolsEnabled: false };
}

const ALLOWED_CONTEXT: ReadonlySet<string> = new Set(IM_EXTERNAL_CONTEXT_SOURCES);
const FORBIDDEN_CONTEXT: ReadonlySet<string> = new Set(IM_FORBIDDEN_CONTEXT_SOURCES);

export function externalContext(
  entries: readonly { source: ImExternalContextSource | ImForbiddenContextSource; text: string; marked?: boolean }[],
): { source: string; text: string; marked: boolean }[] {
  const kept: { source: string; text: string; marked: boolean }[] = [];
  for (const entry of entries) {
    if (!ALLOWED_CONTEXT.has(entry.source)) continue;
    kept.push({ source: entry.source, text: entry.text, marked: entry.marked ?? true });
  }
  return kept;
}

export function externalContextIsClean(entries: readonly { source: string }[]): { clean: boolean; leaked: string[] } {
  const leaked = entries.map((entry) => entry.source).filter((source) => FORBIDDEN_CONTEXT.has(source));
  return { clean: leaked.length === 0, leaked: [...new Set(leaked)] };
}

export interface CausalChainRow {
  chainId: string;
  rootMessageId: string;
  trustDomain: ImTrustDomain;
  createdAt: number;
}

export class CausalChainRegistry {
  readonly #chains = new Map<string, CausalChain>();

  declare(chain: CausalChain): CausalChain {
    const row: CausalChain = {
      chainId: chain.chainId,
      rootMessageId: chain.rootMessageId,
      trustDomain: chain.trustDomain,
      createdAt: chain.createdAt,
    };
    this.#chains.set(row.chainId, row);
    return row;
  }

  read(chainId: string | null | undefined): CausalChain | null | undefined {
    if (chainId === null) return null;
    if (chainId === undefined) return undefined;
    return this.#chains.get(chainId);
  }

  derive(parent: CausalChain | null | undefined, chainId: string, createdAt: number): CausalChain {
    return this.declare(inheritedChain(parent, { chainId, createdAt }));
  }

  authorize(chainId: string | null | undefined): InboundDecision {
    return authorizeToolCall(this.read(chainId));
  }
}

export class CausalChainThreads {
  readonly #threads = new Map<string, CausalChain>();

  bind(threadId: string, chain: CausalChain): void {
    this.#threads.set(threadId, chain);
  }

  read(threadId: string): CausalChain | undefined {
    return this.#threads.get(threadId);
  }
}

export const sharedCausalChains = new CausalChainRegistry();
export const sharedCausalThreads = new CausalChainThreads();

export function causalChainForThread(threadId: string): CausalChain | null | undefined {
  return sharedCausalThreads.read(threadId) ?? sharedCausalChains.read(threadId);
}

export function registerCausalChain(chain: CausalChain, threadId?: string): CausalChain {
  const declared = sharedCausalChains.declare(chain);
  if (threadId !== undefined) sharedCausalThreads.bind(threadId, declared);
  return declared;
}
