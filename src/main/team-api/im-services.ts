import type { DatabaseSync } from "node:sqlite";
import { IM_CAPABILITIES } from "@openbot/contracts/team-protocol/im-v1";
import { ImChannelRoles } from "../../backend/im/channel-roles";
import { ImDeliveryService } from "../../backend/im/delivery";
import type { ImHostApi } from "../../backend/im/host-api";
import { ImService } from "../../backend/im/im-service";
import { ImInboxService } from "../../backend/im/inbox";
import type {
  TeamApiChannels,
  TeamApiDeactivate,
  TeamApiDelivery,
  TeamApiDevices,
  TeamApiIm,
  TeamApiInbox,
  TeamApiLan,
  TeamApiNotifications,
  TeamApiOptions,
  TeamApiProfile,
  TeamApiSettings,
} from "./dependencies";

export interface ImTeamApiServices {
  im: TeamApiIm;
  inbox: TeamApiInbox;
  imChannels: TeamApiChannels;
  imDelivery: TeamApiDelivery;
  imSettings: TeamApiSettings;
  imNotifications: TeamApiNotifications;
  imProfile: TeamApiProfile;
  imDeactivate: TeamApiDeactivate;
  imDevices: TeamApiDevices;
  imLan: TeamApiLan;
}

export interface ImTeamApiHostIdentity {
  serverId: string;
  publicKey: string;
}

export interface ImTeamApiServicesSource {
  database: () => DatabaseSync | null;
  identity: () => ImTeamApiHostIdentity | null;
  hostApi: (database: DatabaseSync, localServerId: string, publicKey: string) => ImHostApi;
}

export function createImTeamApiServices(source: ImTeamApiServicesSource): () => ImTeamApiServices | null {
  let builtFor: string | null = null;
  let built: ImTeamApiServices | null = null;
  return () => {
    const identity = source.identity();
    const database = source.database();
    if (!identity || !database) return null;
    if (built !== null && builtFor === identity.serverId) return built;
    const host = source.hostApi(database, identity.serverId, identity.publicKey);
    builtFor = identity.serverId;
    built = {
      im: new ImService(database, identity.serverId),
      inbox: new ImInboxService(database, identity.serverId),
      imChannels: new ImChannelRoles(database, identity.serverId),
      imDelivery: new ImDeliveryService(database, identity.serverId),
      imSettings: host,
      imNotifications: host,
      imProfile: host,
      imDeactivate: host,
      imDevices: host,
      imLan: host,
    };
    return built;
  };
}

export type ImTeamApiOptionKeys =
  | "im"
  | "inbox"
  | "imChannels"
  | "imDelivery"
  | "imSettings"
  | "imNotifications"
  | "imProfile"
  | "imDeactivate"
  | "imDevices"
  | "imLan";

export function imTeamApiOptions(resolve: () => ImTeamApiServices | null): Pick<TeamApiOptions, ImTeamApiOptionKeys> {
  return {
    get im(): TeamApiIm | undefined {
      return resolve()?.im;
    },
    get inbox(): TeamApiInbox | undefined {
      return resolve()?.inbox;
    },
    get imChannels(): TeamApiChannels | undefined {
      return resolve()?.imChannels;
    },
    get imDelivery(): TeamApiDelivery | undefined {
      return resolve()?.imDelivery;
    },
    get imSettings(): TeamApiSettings | undefined {
      return resolve()?.imSettings;
    },
    get imNotifications(): TeamApiNotifications | undefined {
      return resolve()?.imNotifications;
    },
    get imProfile(): TeamApiProfile | undefined {
      return resolve()?.imProfile;
    },
    get imDeactivate(): TeamApiDeactivate | undefined {
      return resolve()?.imDeactivate;
    },
    get imDevices(): TeamApiDevices | undefined {
      return resolve()?.imDevices;
    },
    get imLan(): TeamApiLan | undefined {
      return resolve()?.imLan;
    },
  };
}

const IM_REQUIRED_OPTIONS: readonly ImTeamApiOptionKeys[] = [
  "im",
  "inbox",
  "imChannels",
  "imDelivery",
  "imSettings",
  "imNotifications",
  "imProfile",
  "imDeactivate",
  "imDevices",
  "imLan",
];

const IM_CAPABILITY_OPTIONS: ReadonlyMap<string, readonly ImTeamApiOptionKeys[]> = new Map(
  IM_CAPABILITIES.map((capability) => [capability, IM_REQUIRED_OPTIONS] as const),
);

export function imCapabilityOptions(capability: string): readonly ImTeamApiOptionKeys[] | null {
  return IM_CAPABILITY_OPTIONS.get(capability) ?? null;
}

export function imCapabilityServicesReady(
  capability: string,
  options: Pick<TeamApiOptions, ImTeamApiOptionKeys>,
): boolean {
  const required = imCapabilityOptions(capability);
  if (required === null) return true;
  return required.every((key) => options[key] !== undefined);
}
