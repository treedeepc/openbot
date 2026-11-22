import { createRequire } from "node:module";
import { type DynamicRecord, isDynamicRecord } from "@openbot/contracts/runtime-values";
import type { ImPeerConnectionFactory, ImPeerConnectionLike } from "./lan-channel";

interface ImPeerConnectionConstructor {
  new (configuration: {
    iceServers: { urls: string[]; username?: string; credential?: string }[];
  }): ImPeerConnectionLike;
}

function isPeerConnection(value: unknown): value is ImPeerConnectionLike {
  if (!isDynamicRecord(value)) return false;
  const entry: DynamicRecord = value;
  return (
    typeof entry.createDataChannel === "function" &&
    typeof entry.createOffer === "function" &&
    typeof entry.setLocalDescription === "function" &&
    typeof entry.close === "function"
  );
}

function isPeerConnectionConstructor(value: unknown): value is ImPeerConnectionConstructor {
  return typeof value === "function";
}

export function createWrtcFactory(): ImPeerConnectionFactory {
  return (iceServers) => {
    const required = createRequire(import.meta.url)("@roamhq/wrtc");
    if (!isDynamicRecord(required)) throw new Error("im.unsupportedPlatform");
    const entry = required;
    const peerConnection = entry.RTCPeerConnection;
    if (!isPeerConnectionConstructor(peerConnection)) throw new Error("im.unsupportedPlatform");
    const created = new peerConnection({ iceServers });
    if (!isPeerConnection(created)) throw new Error("im.unsupportedPlatform");
    return created;
  };
}
