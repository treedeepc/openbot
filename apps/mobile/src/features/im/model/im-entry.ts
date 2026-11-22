import type { ImEntrySupport } from "@/features/im/model/im-port";
import type { ServerRowState } from "@/features/workspace/model/server-row-state";

export function imEntryState(...states: readonly ServerRowState[]): ServerRowState {
  if (states.some((state) => state === "enabled")) return "enabled";
  if (states.some((state) => state === "disabled")) return "disabled";
  return "hidden";
}

export function imEntryToolVisible(state: ServerRowState): boolean {
  return state !== "hidden";
}

export function imSupportOf(rows: {
  inbox: ServerRowState;
  contacts: ServerRowState;
  session: ServerRowState;
  devices: ServerRowState;
  assign: ServerRowState;
  block: ServerRowState;
  report: ServerRowState;
}): ImEntrySupport {
  return {
    inbox: rows.inbox === "enabled",
    contacts: rows.contacts === "enabled",
    session: rows.session === "enabled",
    devices: rows.devices === "enabled",
    assign: rows.assign === "enabled",
    block: rows.block === "enabled",
    report: rows.report === "enabled",
  };
}
