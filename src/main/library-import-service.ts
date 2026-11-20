import { randomUUID } from "node:crypto";
import { readdir, realpath, stat } from "node:fs/promises";
import { basename, join, relative, sep } from "node:path";
import { ATTACHMENT_LIMITS } from "@openbot/contracts/input-limits";
import {
  LIBRARY_FOLDER_LIMITS,
  type LibraryFolderContext,
  type LibraryImportResult,
  type LibraryImportSkipped,
  libraryFolderPath,
} from "@openbot/contracts/ipc";
import { sourceText } from "@openbot/i18n/source";
import { Effect, Result } from "effect";
import { LibraryFolderChangeRefused } from "../backend/library-folders-store";
import type { MailboxStore } from "../backend/mailbox-store";
import { StoredStateFailure, storedIO } from "../backend/stored-state-effects";
import type { LibraryFoldersService } from "./library-folders-service";

const MAX_SCANNED_ENTRIES = 20_000;

const skip = {
  hidden: () => sourceText("error.backend.libraryImportHidden"),
  tooLarge: () => sourceText("error.attachment.fileTooLarge"),
  unreadable: () => sourceText("error.attachment.unavailable"),
  nameTooLong: () => sourceText("error.backend.libraryFolderName", { limit: LIBRARY_FOLDER_LIMITS.name }),
  tooDeep: () => sourceText("error.backend.libraryFolderTooDeep", { limit: LIBRARY_FOLDER_LIMITS.levels }),
  folderLimit: () => sourceText("error.backend.libraryFolderLimit", { limit: LIBRARY_FOLDER_LIMITS.folders }),
  fileLimit: () => sourceText("error.backend.libraryFolderFileLimit"),
};

export interface LibraryImportSources {
  mailbox: Pick<MailboxStore, "storeGeneratedAttachment">;
  libraryFolders: Pick<LibraryFoldersService, "forAgents">;
  agents: () => readonly { id: string }[];
}

export interface LibraryImportRequest {
  kind: "files" | "directory";
  agentId: string;
  folderId?: string;
  paths: readonly string[];
}

interface ScannedFile {
  sourcePath: string;
  label: string;
  name: string;
  segments: string[];
}

interface ScanBudget {
  maxChain: number;
  folders: number;
  files: number;
}

interface ScanOutcome {
  files: ScannedFile[];
  skipped: LibraryImportSkipped[];
  folders: Set<string>;
}

type OpenedChain = { id: string | null } | { reason: string };

function labelOf(root: string, path: string): string {
  const shown = relative(root, path).split(sep).join("/");
  return shown.length > 0 ? `${basename(root)}/${shown}` : basename(root);
}

function chainKey(segments: readonly string[]): string {
  return segments.join("/");
}

function compareChains(left: string, right: string): number {
  return left.split("/").length - right.split("/").length || left.localeCompare(right);
}

function refusalSkip(cause: unknown): string {
  return cause instanceof LibraryFolderChangeRefused ? cause.message : skip.folderLimit();
}

export class LibraryImportService {
  readonly #sources: LibraryImportSources;

  constructor(sources: LibraryImportSources) {
    this.#sources = sources;
  }

  readonly importFiles = Effect.fn("LibraryImportService.importFiles")(function* (
    this: LibraryImportService,
    request: LibraryImportRequest,
  ): Effect.fn.Return<LibraryImportResult, StoredStateFailure> {
    const agentId = this.#sources.agents().find((agent) => agent.id === request.agentId)?.id;
    if (!agentId) return yield* new StoredStateFailure({ cause: new Error(sourceText("error.storage.agentMissing")) });

    const store = this.#sources.libraryFolders.forAgents();
    const snapshot = store.getSnapshot();
    const base =
      request.folderId === undefined
        ? undefined
        : snapshot.folders.find((folder) => folder.id === request.folderId && folder.agentId === agentId);
    if (request.folderId !== undefined && !base)
      return yield* new StoredStateFailure({ cause: new Error(sourceText("error.backend.libraryFolderGone")) });

    const budget: ScanBudget = {
      maxChain:
        LIBRARY_FOLDER_LIMITS.levels - (base === undefined ? 0 : libraryFolderPath(snapshot.folders, base.id).length),
      folders: Math.max(0, LIBRARY_FOLDER_LIMITS.folders - snapshot.folders.length),
      files: Math.max(
        0,
        Math.min(
          LIBRARY_FOLDER_LIMITS.files,
          LIBRARY_FOLDER_LIMITS.placements - Object.keys(snapshot.placement).length,
        ),
      ),
    };
    const scan = yield* storedIO(() =>
      request.kind === "directory" ? scanDirectory(request.paths[0] ?? "", budget) : scanFiles(request.paths, budget),
    );
    const skipped: LibraryImportSkipped[] = [...scan.skipped];

    const registered = new Map<string, string>();
    const context: LibraryFolderContext = {
      agentIds: { has: (id) => id === agentId },
      fileAgent: (fileId) => registered.get(fileId),
    };
    const groups = new Map<string, ScannedFile[]>();
    for (const file of scan.files) {
      const key = chainKey(file.segments);
      const group = groups.get(key);
      if (group) group.push(file);
      else groups.set(key, [file]);
    }

    const opened = yield* this.#openChains(store, context, agentId, base?.id, [
      ...new Set([...scan.folders, ...groups.keys()]),
    ]);
    const placements = new Map<string, string[]>();
    for (const [key, group] of groups) {
      const target = resolveTarget(opened, key);
      if ("reason" in target) {
        for (const file of group) skipped.push({ name: file.label, reason: target.reason });
        continue;
      }
      for (const file of group) {
        const stored = yield* Effect.result(
          this.#sources.mailbox.storeGeneratedAttachment({
            sourcePath: file.sourcePath,
            name: file.name,
            ownerAgentId: agentId,
            importedAt: new Date().toISOString(),
          }),
        );
        if (Result.isFailure(stored)) {
          skipped.push({ name: file.label, reason: skip.unreadable() });
          continue;
        }
        registered.set(stored.success.id, agentId);
        if (target.id === null) continue;
        const bucket = placements.get(target.id);
        if (bucket) bucket.push(stored.success.id);
        else placements.set(target.id, [stored.success.id]);
      }
    }

    for (const [folderId, fileIds] of placements) {
      yield* store.mutate({ type: "place", fileIds, folderId }, context);
    }
    return { imported: registered.size, skipped };
  }).bind(this);

  readonly #openChains = Effect.fn("LibraryImportService.openChains")(function* (
    this: LibraryImportService,
    store: ReturnType<LibraryFoldersService["forAgents"]>,
    context: LibraryFolderContext,
    agentId: string,
    parentId: string | undefined,
    keys: readonly string[],
  ): Effect.fn.Return<Map<string, OpenedChain>, StoredStateFailure> {
    const opened = new Map<string, OpenedChain>();
    for (const key of [...keys].sort(compareChains)) {
      if (key === "") {
        opened.set(key, { id: parentId ?? null });
        continue;
      }
      const segments = key.split("/");
      const parentKey = segments.slice(0, -1).join("/");
      const parent = parentKey === "" ? { id: parentId ?? null } : (opened.get(parentKey) ?? { id: null });
      if ("reason" in parent) {
        opened.set(key, parent);
        continue;
      }
      const id = randomUUID();
      const created = yield* Effect.result(
        store.mutate(
          {
            type: "create",
            id,
            agentId,
            name: segments.at(-1) ?? "",
            ...(parent.id === null ? {} : { parentId: parent.id }),
          },
          context,
        ),
      );
      opened.set(key, Result.isFailure(created) ? { reason: refusalSkip(created.failure.cause) } : { id });
    }
    return opened;
  }).bind(this);
}

function resolveTarget(opened: ReadonlyMap<string, OpenedChain>, key: string): OpenedChain {
  const segments = key.split("/");
  for (let length = segments.length; length > 0; length -= 1) {
    const ancestor = opened.get(segments.slice(0, length).join("/"));
    if (ancestor !== undefined) return ancestor;
  }
  return { id: null };
}

async function scanDirectory(root: string, budget: ScanBudget): Promise<ScanOutcome> {
  const files: ScannedFile[] = [];
  const skipped: LibraryImportSkipped[] = [];
  const folders = new Set<string>();
  const seen = new Set<string>();
  let scanned = 0;
  let stopped: LibraryImportSkipped | null = null;

  const top = basename(root);
  if (top.length > LIBRARY_FOLDER_LIMITS.name)
    return { files, skipped: [{ name: top, reason: skip.nameTooLong() }], folders };
  const segments = top === "" ? [] : [top];
  if (segments.length > budget.maxChain) return { files, skipped: [{ name: top, reason: skip.tooDeep() }], folders };
  if (segments.length > 0) {
    if (budget.folders < 1) return { files, skipped: [{ name: top, reason: skip.folderLimit() }], folders };
    folders.add(chainKey(segments));
  }

  const walk = async (directory: string, segments: string[]): Promise<void> => {
    if (stopped) return;
    const listed = await readdir(directory).catch(() => null);
    if (!listed) {
      skipped.push({ name: labelOf(root, directory), reason: skip.unreadable() });
      return;
    }
    for (const name of listed) {
      if (stopped) return;
      scanned += 1;
      if (scanned > MAX_SCANNED_ENTRIES) {
        stopped = { name: basename(root), reason: skip.fileLimit() };
        return;
      }
      const path = join(directory, name);
      const label = labelOf(root, path);
      if (name.startsWith(".")) {
        skipped.push({ name: label, reason: skip.hidden() });
        continue;
      }
      const info = await stat(path).catch(() => null);
      if (!info) {
        skipped.push({ name: label, reason: skip.unreadable() });
        continue;
      }
      if (info.isDirectory()) {
        const chain = [...segments, name];
        const key = chainKey(chain);
        const real = await realpath(path).catch(() => path);
        if (seen.has(real)) {
          skipped.push({ name: label, reason: skip.unreadable() });
          continue;
        }
        seen.add(real);
        if (name.length > LIBRARY_FOLDER_LIMITS.name) {
          skipped.push({ name: label, reason: skip.nameTooLong() });
          continue;
        }
        if (chain.length > budget.maxChain) {
          skipped.push({ name: label, reason: skip.tooDeep() });
          continue;
        }
        if (!folders.has(key) && folders.size >= budget.folders) {
          stopped = { name: basename(root), reason: skip.folderLimit() };
          return;
        }
        folders.add(key);
        await walk(path, chain);
        continue;
      }
      if (!info.isFile()) {
        skipped.push({ name: label, reason: skip.unreadable() });
        continue;
      }
      if (info.size > ATTACHMENT_LIMITS.fileBytes) {
        skipped.push({ name: label, reason: skip.tooLarge() });
        continue;
      }
      if (files.length >= budget.files) {
        stopped = { name: basename(root), reason: skip.fileLimit() };
        return;
      }
      files.push({ sourcePath: path, label, name, segments: [...segments] });
    }
  };

  seen.add(await realpath(root).catch(() => root));
  await walk(root, segments);
  if (stopped) skipped.push(stopped);
  return { files, skipped, folders };
}

async function scanFiles(paths: readonly string[], budget: ScanBudget): Promise<ScanOutcome> {
  const files: ScannedFile[] = [];
  const skipped: LibraryImportSkipped[] = [];
  for (const path of paths) {
    const name = basename(path);
    const info = await stat(path).catch(() => null);
    if (!info?.isFile()) {
      skipped.push({ name, reason: skip.unreadable() });
      continue;
    }
    if (info.size > ATTACHMENT_LIMITS.fileBytes) {
      skipped.push({ name, reason: skip.tooLarge() });
      continue;
    }
    if (files.length >= budget.files) {
      skipped.push({ name, reason: skip.fileLimit() });
      continue;
    }
    files.push({ sourcePath: path, label: name, name, segments: [] });
  }
  return { files, skipped, folders: new Set<string>() };
}
