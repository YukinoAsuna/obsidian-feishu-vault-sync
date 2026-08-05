import { TFile, TFolder, Vault } from "obsidian";
import { FeishuClient } from "./feishu-client";
import {
  FeishuSyncSettings,
  RemoteNode,
  RemoteTree,
  SyncEntry,
  SyncState,
  SyncStats
} from "./types";
import {
  baseName,
  conflictPath,
  isExcluded,
  joinPath,
  normalizeVaultPath,
  parentPath,
  sha256
} from "./utils";

interface LocalSnapshot {
  file: TFile;
  data?: ArrayBuffer;
  hash?: string;
}

export class SyncEngine {
  constructor(
    private readonly vault: Vault,
    private readonly client: FeishuClient,
    private readonly getSettings: () => FeishuSyncSettings,
    private readonly state: SyncState,
    private readonly persist: () => Promise<void>,
    private readonly onProgress: (message: string) => void
  ) {}

  async sync(): Promise<SyncStats> {
    const settings = this.getSettings();
    const stats = this.createStats();

    this.onProgress("正在读取飞书目录…");
    const remoteTree = await this.client.listTree(settings.rootFolderToken.trim());
    const localFiles = this.getLocalFiles(settings);
    await this.ensureLocalFoldersOnRemote(remoteTree, settings, stats);

    if (settings.direction === "bidirectional") {
      await this.syncBidirectional(localFiles, remoteTree, settings, stats);
    } else {
      await this.syncPushOnly(localFiles, remoteTree, settings, stats);
    }

    stats.skipped += remoteTree.unsupported.size;
    await this.finish(stats);
    this.onProgress("同步完成");
    return stats;
  }

  async syncSelected(paths: string[]): Promise<SyncStats> {
    const settings = this.getSettings();
    const stats = this.createStats();
    const selected = new Set(paths.map(normalizeVaultPath).filter(Boolean));
    this.state.disabledPaths = this.state.disabledPaths.filter((path) => !selected.has(path));

    this.onProgress("正在读取飞书目录…");
    const remoteTree = await this.client.listTree(settings.rootFolderToken.trim());
    const localFiles = this.getLocalFiles(settings, false);
    for (const path of [...selected].sort()) {
      const local = localFiles.get(path);
      if (!local) {
        this.addFailure(stats, path, "本地文件不存在或已被全局排除规则忽略");
        continue;
      }
      try {
        const { data, hash } = await this.readLocal(local);
        await this.uploadLocal(path, local, data, hash, remoteTree.files.get(path), remoteTree, stats);
      } catch (error) {
        this.addFailure(stats, path, error);
      }
    }

    await this.finish(stats);
    this.onProgress("选中文件同步完成");
    return stats;
  }

  async cancelSync(paths: string[]): Promise<SyncStats> {
    const settings = this.getSettings();
    const stats = this.createStats();
    const selected = [...new Set(paths.map(normalizeVaultPath).filter(Boolean))].sort();

    this.onProgress("正在读取飞书目录…");
    const remoteTree = await this.client.listTree(settings.rootFolderToken.trim());
    const disabled = new Set(this.state.disabledPaths.map(normalizeVaultPath));
    for (const path of selected) {
      try {
        const remote = remoteTree.files.get(path);
        if (remote) {
          this.onProgress(`删除飞书文件：${path}`);
          await this.client.deleteNode(remote.token, "file");
          remoteTree.files.delete(path);
          stats.deletedRemote += 1;
        }
        delete this.state.entries[path];
        disabled.add(path);
        this.markSuccess(stats, path);
      } catch (error) {
        this.addFailure(stats, path, error);
      }
    }
    this.state.disabledPaths = [...disabled].sort();

    await this.finish(stats);
    this.onProgress("取消同步完成");
    return stats;
  }

  private getLocalFiles(
    settings: FeishuSyncSettings,
    respectDisabled = true
  ): Map<string, LocalSnapshot> {
    const files = new Map<string, LocalSnapshot>();
    const disabled = new Set(this.state.disabledPaths.map(normalizeVaultPath));
    for (const file of this.vault.getFiles()) {
      const path = normalizeVaultPath(file.path);
      if (isExcluded(path, settings.excludedPatterns)) continue;
      if (respectDisabled && disabled.has(path)) continue;
      files.set(path, { file });
    }
    return files;
  }

  private async ensureLocalFoldersOnRemote(
    tree: RemoteTree,
    settings: FeishuSyncSettings,
    stats: SyncStats
  ): Promise<void> {
    const folderPaths = this.vault.getAllLoadedFiles()
      .filter((item): item is TFolder => item instanceof TFolder)
      .map((folder) => normalizeVaultPath(folder.path))
      .filter((path) => path && !isExcluded(path, settings.excludedPatterns))
      .sort((left, right) => left.split("/").length - right.split("/").length);

    for (const path of folderPaths) {
      try {
        await this.ensureRemoteFolder(path, tree);
      } catch (error) {
        stats.errors.push(`${path}: ${this.errorMessage(error)}`);
      }
    }
  }

  private async syncPushOnly(
    localFiles: Map<string, LocalSnapshot>,
    tree: RemoteTree,
    settings: FeishuSyncSettings,
    stats: SyncStats
  ): Promise<void> {
    for (const [path, local] of localFiles) {
      try {
        const { data, hash } = await this.readLocal(local);
        const entry = this.state.entries[path];
        const remote = tree.files.get(path);
        const localChanged = !entry || entry.localHash !== hash;
        const remoteChanged = !entry || !remote || this.remoteChanged(entry, remote);
        if (localChanged || remoteChanged) {
          await this.uploadLocal(path, local, data, hash, remote, tree, stats);
        } else if (remote) {
          this.state.entries[path] = this.makeEntry(local, hash, remote, entry.emptyPlaceholder);
          stats.skipped += 1;
          this.markSuccess(stats, path);
        }
      } catch (error) {
        this.addFailure(stats, path, error);
      }
    }

    if (!settings.propagateDeletions) return;
    for (const [path, entry] of Object.entries(this.state.entries)) {
      if (localFiles.has(path)) continue;
      const remote = tree.files.get(path);
      if (!remote) {
        delete this.state.entries[path];
        this.markSuccess(stats, path);
        continue;
      }
      if (this.remoteChanged(entry, remote)) {
        this.addFailure(stats, path, "本地已删除，但飞书版本也有变化，已保留远端文件");
        continue;
      }
      try {
        this.onProgress(`删除飞书文件：${path}`);
        await this.client.deleteNode(remote.token, "file");
        tree.files.delete(path);
        delete this.state.entries[path];
        stats.deletedRemote += 1;
        this.markSuccess(stats, path);
      } catch (error) {
        this.addFailure(stats, path, error);
      }
    }
  }

  private async syncBidirectional(
    localFiles: Map<string, LocalSnapshot>,
    tree: RemoteTree,
    settings: FeishuSyncSettings,
    stats: SyncStats
  ): Promise<void> {
    const disabled = new Set(this.state.disabledPaths.map(normalizeVaultPath));
    const paths = new Set(
      [...localFiles.keys(), ...tree.files.keys()].filter((path) => !disabled.has(path))
    );
    for (const path of [...paths].sort()) {
      const local = localFiles.get(path);
      const remote = tree.files.get(path);
      const entry = this.state.entries[path];
      try {
        if (local && remote) {
          const { data, hash } = await this.readLocal(local);
          const localChanged = !entry || entry.localHash !== hash;
          const remoteChanged = !entry || this.remoteChanged(entry, remote);
          if (localChanged && remoteChanged) {
            await this.preserveRemoteConflict(path, remote, entry, stats);
            await this.uploadLocal(path, local, data, hash, remote, tree, stats);
          } else if (remoteChanged) {
            await this.pullRemote(path, remote, entry, stats);
          } else if (localChanged) {
            await this.uploadLocal(path, local, data, hash, remote, tree, stats);
          } else {
            this.state.entries[path] = this.makeEntry(local, hash, remote, entry?.emptyPlaceholder);
            stats.skipped += 1;
            this.markSuccess(stats, path);
          }
          continue;
        }

        if (local && !remote) {
          const { data, hash } = await this.readLocal(local);
          const localChanged = !entry || entry.localHash !== hash;
          if (entry && settings.propagateDeletions && !localChanged) {
            this.onProgress(`移入本地回收站：${path}`);
            await this.vault.trash(local.file, false);
            delete this.state.entries[path];
            stats.deletedLocal += 1;
            this.markSuccess(stats, path);
          } else {
            await this.uploadLocal(path, local, data, hash, undefined, tree, stats);
          }
          continue;
        }

        if (!local && remote) {
          const remoteChanged = !entry || this.remoteChanged(entry, remote);
          if (entry && settings.propagateDeletions && !remoteChanged) {
            this.onProgress(`删除飞书文件：${path}`);
            await this.client.deleteNode(remote.token, "file");
            tree.files.delete(path);
            delete this.state.entries[path];
            stats.deletedRemote += 1;
            this.markSuccess(stats, path);
          } else {
            await this.pullRemote(path, remote, entry, stats);
          }
        }
      } catch (error) {
        this.addFailure(stats, path, error);
      }
    }
  }

  private async uploadLocal(
    path: string,
    local: LocalSnapshot,
    data: ArrayBuffer,
    hash: string,
    remote: RemoteNode | undefined,
    tree: RemoteTree,
    stats: SyncStats
  ): Promise<void> {
    this.onProgress(`上传：${path}`);
    const folderToken = await this.ensureRemoteFolder(parentPath(path), tree);
    const uploaded = await this.client.replaceFile(
      baseName(path),
      folderToken,
      data,
      remote?.token
    );
    const remoteNode: RemoteNode = {
      name: baseName(path),
      token: uploaded.token,
      type: "file",
      parentToken: folderToken,
      modifiedTime: uploaded.modifiedTime
    };
    tree.files.set(path, remoteNode);
    this.state.entries[path] = this.makeEntry(local, hash, remoteNode, uploaded.emptyPlaceholder);
    stats.uploaded += 1;
    this.markSuccess(stats, path);
  }

  private async pullRemote(
    path: string,
    remote: RemoteNode,
    entry: SyncEntry | undefined,
    stats: SyncStats
  ): Promise<void> {
    this.onProgress(`下载：${path}`);
    const emptyPlaceholder = Boolean(entry?.emptyPlaceholder && entry.remoteToken === remote.token);
    const data = await this.client.downloadFile(remote.token, emptyPlaceholder);
    const file = await this.writeLocal(path, data);
    const hash = await sha256(data);
    this.state.entries[path] = this.makeEntry({ file, data, hash }, hash, remote, emptyPlaceholder);
    stats.downloaded += 1;
    this.markSuccess(stats, path);
  }

  private async preserveRemoteConflict(
    path: string,
    remote: RemoteNode,
    entry: SyncEntry | undefined,
    stats: SyncStats
  ): Promise<void> {
    const data = await this.client.downloadFile(
      remote.token,
      Boolean(entry?.emptyPlaceholder && entry.remoteToken === remote.token)
    );
    const target = this.uniqueConflictPath(path);
    this.onProgress(`保存冲突副本：${target}`);
    await this.writeLocal(target, data);
    stats.conflicts += 1;
  }

  private async ensureRemoteFolder(path: string, tree: RemoteTree): Promise<string> {
    const normalized = normalizeVaultPath(path);
    if (!normalized) {
      const root = tree.folders.get("");
      if (!root) throw new Error("飞书根目录不存在");
      return root.token;
    }
    const existing = tree.folders.get(normalized);
    if (existing) return existing.token;
    const parent = parentPath(normalized);
    if (parent === normalized) {
      throw new Error(`无法解析飞书目录的父路径：${normalized}`);
    }
    const parentToken = await this.ensureRemoteFolder(parent, tree);
    this.onProgress(`创建飞书文件夹：${normalized}`);
    const created = await this.client.createFolder(baseName(normalized), parentToken);
    tree.folders.set(normalized, created);
    return created.token;
  }

  private async readLocal(local: LocalSnapshot): Promise<{ data: ArrayBuffer; hash: string }> {
    if (!local.data) local.data = await this.vault.readBinary(local.file);
    if (!local.hash) local.hash = await sha256(local.data);
    return { data: local.data, hash: local.hash };
  }

  private async writeLocal(path: string, data: ArrayBuffer): Promise<TFile> {
    await this.ensureLocalFolder(parentPath(path));
    const existing = this.vault.getAbstractFileByPath(path);
    if (existing instanceof TFolder) {
      throw new Error(`本地同名路径是文件夹，无法写入文件：${path}`);
    }
    if (existing instanceof TFile) {
      await this.vault.modifyBinary(existing, data);
      return existing;
    }
    return this.vault.createBinary(path, data);
  }

  private async ensureLocalFolder(path: string): Promise<void> {
    const normalized = normalizeVaultPath(path);
    if (!normalized) return;
    let current = "";
    for (const part of normalized.split("/")) {
      current = joinPath(current, part);
      const existing = this.vault.getAbstractFileByPath(current);
      if (existing instanceof TFile) {
        throw new Error(`本地同名路径是文件，无法创建文件夹：${current}`);
      }
      if (!existing) await this.vault.createFolder(current);
    }
  }

  private makeEntry(
    local: LocalSnapshot,
    hash: string,
    remote: RemoteNode,
    emptyPlaceholder?: boolean
  ): SyncEntry {
    return {
      remoteToken: remote.token,
      remoteModifiedTime: remote.modifiedTime,
      localHash: hash,
      localMtime: local.file.stat.mtime,
      size: local.file.stat.size,
      emptyPlaceholder
    };
  }

  private remoteChanged(entry: SyncEntry, remote: RemoteNode): boolean {
    return entry.remoteToken !== remote.token
      || remote.modifiedTime > entry.remoteModifiedTime + 1;
  }

  private uniqueConflictPath(path: string): string {
    const initial = conflictPath(path, Date.now());
    if (!this.vault.getAbstractFileByPath(initial)) return initial;
    const folder = parentPath(initial);
    const name = baseName(initial);
    const dot = name.lastIndexOf(".");
    for (let index = 2; index < 1000; index += 1) {
      const candidateName = dot > 0
        ? `${name.slice(0, dot)}-${index}${name.slice(dot)}`
        : `${name}-${index}`;
      const candidate = joinPath(folder, candidateName);
      if (!this.vault.getAbstractFileByPath(candidate)) return candidate;
    }
    throw new Error(`无法为 ${path} 创建唯一的冲突副本`);
  }

  private createStats(): SyncStats {
    return {
      uploaded: 0,
      downloaded: 0,
      deletedRemote: 0,
      deletedLocal: 0,
      conflicts: 0,
      skipped: 0,
      errors: [],
      successfulPaths: [],
      failures: [],
      startedAt: Date.now(),
      finishedAt: 0
    };
  }

  private async finish(stats: SyncStats): Promise<void> {
    stats.finishedAt = Date.now();
    this.state.lastSyncAt = stats.finishedAt;
    for (const path of stats.successfulPaths) delete this.state.fileFailures[path];
    for (const failure of stats.failures) this.state.fileFailures[failure.path] = failure.message;
    this.state.lastRun = {
      startedAt: stats.startedAt,
      finishedAt: stats.finishedAt,
      successfulPaths: [...new Set(stats.successfulPaths)].sort(),
      failures: stats.failures
    };
    await this.persist();
  }

  private markSuccess(stats: SyncStats, path: string): void {
    stats.successfulPaths.push(path);
  }

  private addFailure(stats: SyncStats, path: string, error: unknown): void {
    const message = typeof error === "string" ? error : this.errorMessage(error);
    stats.errors.push(`${path}: ${message}`);
    stats.failures.push({ path, message });
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
