import {
  App,
  MarkdownView,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting
} from "obsidian";
import { defaultHttpInstance, registerApp } from "@larksuiteoapi/node-sdk";
import { FeishuClient } from "./feishu-client";
import { FeishuLoginModal } from "./login-modal";
import { obsidianRequestAdapter } from "./obsidian-request-adapter";
import { SyncEngine } from "./sync-engine";
import {
  DEFAULT_SETTINGS,
  DEFAULT_STATE,
  FeishuSyncSettings,
  PluginData,
  RemoteNode,
  SyncState,
  SyncStats
} from "./types";
import { isExcluded, normalizeVaultPath } from "./utils";

type FileSyncCategory = "synced" | "pending" | "failed" | "disabled";

interface FileSyncStatus {
  path: string;
  category: FileSyncCategory;
  message?: string;
}

export default class FeishuVaultSyncPlugin extends Plugin {
  settings: FeishuSyncSettings = { ...DEFAULT_SETTINGS };
  state: SyncState = { ...DEFAULT_STATE, entries: {}, disabledPaths: [], fileFailures: {} };
  client!: FeishuClient;
  private syncing = false;
  private intervalId: number | undefined;
  private statusBarItem!: HTMLElement;
  private loginAbortController: AbortController | undefined;
  private remoteFiles: Map<string, RemoteNode> | undefined;
  private readonly saveSyncQueue = new Set<string>();
  private saveSyncTimer: number | undefined;
  remoteStatusCheckedAt = 0;

  async onload(): Promise<void> {
    // The Feishu SDK otherwise selects Axios' XHR adapter in Electron and the
    // device-registration endpoint is blocked by browser CORS. Obsidian's
    // requestUrl runs through the desktop network layer and avoids that limit.
    defaultHttpInstance.defaults.adapter = obsidianRequestAdapter;
    await this.loadPluginData();
    this.client = new FeishuClient(() => this.settings);
    this.statusBarItem = this.addStatusBarItem();
    this.statusBarItem.addClass("feishu-vault-sync-status-button");
    this.registerDomEvent(this.statusBarItem, "click", () => this.openSyncManager());
    this.setStatus(this.isConnected() ? "飞书同步：待机" : "飞书同步：未连接");

    this.addRibbonIcon("cloud-upload", "飞书同步管理", () => this.openSyncManager());
    this.addCommand({
      id: "open-sync-manager",
      name: "打开飞书同步管理",
      callback: () => this.openSyncManager()
    });
    this.addCommand({
      id: "sync-now",
      name: "立即同步到飞书云盘",
      callback: () => void this.runSync("手动")
    });
    this.addCommand({
      id: "sync-active-file",
      name: "仅同步当前文件到飞书云盘",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || isExcluded(file.path, this.settings.excludedPatterns)) return false;
        if (!checking) void this.syncSelectedFiles([file.path]);
        return true;
      }
    });
    this.addCommand({
      id: "test-connection",
      name: "测试飞书连接",
      callback: () => void this.testConnection()
    });
    this.registerDomEvent(document, "keydown", (event: KeyboardEvent) => {
      if (!this.settings.syncOnSave || event.repeat) return;
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
      if (event.key.toLocaleLowerCase() !== "s") return;
      const view = this.app.workspace.getActiveViewOfType(MarkdownView);
      if (!view?.file || !view.editor.hasFocus()) return;
      const path = view.file.path;
      void view.save()
        .then(() => this.scheduleSaveSync(path))
        .catch((error: unknown) => console.error("Feishu Vault Sync: failed to save before sync", error));
    });
    this.addSettingTab(new FeishuVaultSyncSettingTab(this.app, this));
    this.reschedule();

    this.app.workspace.onLayoutReady(() => {
      if (this.settings.syncOnStartup && this.isConnected()) {
        const timeoutId = window.setTimeout(() => void this.runSync("启动"), 1500);
        this.register(() => window.clearTimeout(timeoutId));
      }
    });
  }

  onunload(): void {
    if (this.intervalId !== undefined) window.clearInterval(this.intervalId);
    if (this.saveSyncTimer !== undefined) window.clearTimeout(this.saveSyncTimer);
    this.loginAbortController?.abort();
  }

  async updateSettings(patch: Partial<FeishuSyncSettings>): Promise<void> {
    const previousInterval = this.settings.intervalMinutes;
    const previousAutoSyncEnabled = this.settings.autoSyncEnabled;
    this.settings = { ...this.settings, ...patch };
    this.settings.intervalMinutes = Math.max(1, Math.min(10080, this.settings.intervalMinutes || 30));
    await this.persist();
    if (
      this.settings.intervalMinutes !== previousInterval
      || this.settings.autoSyncEnabled !== previousAutoSyncEnabled
    ) this.reschedule();
  }

  openSyncManager(): void {
    new FileSyncManagerModal(this.app, this).open();
  }

  private scheduleSaveSync(path: string): void {
    const normalized = normalizeVaultPath(path);
    if (!normalized || !this.isConnected()) return;
    if (isExcluded(normalized, this.settings.excludedPatterns)) return;
    if (this.state.disabledPaths.map(normalizeVaultPath).includes(normalized)) return;
    this.saveSyncQueue.add(normalized);
    if (this.saveSyncTimer !== undefined) window.clearTimeout(this.saveSyncTimer);
    this.saveSyncTimer = window.setTimeout(() => void this.flushSaveSyncQueue(), 180);
  }

  private async flushSaveSyncQueue(): Promise<void> {
    this.saveSyncTimer = undefined;
    if (!this.settings.syncOnSave || !this.isConnected()) {
      this.saveSyncQueue.clear();
      return;
    }
    if (this.syncing) {
      this.saveSyncTimer = window.setTimeout(() => void this.flushSaveSyncQueue(), 500);
      return;
    }
    const disabled = new Set(this.state.disabledPaths.map(normalizeVaultPath));
    const paths = [...this.saveSyncQueue].filter((path) => (
      !disabled.has(path) && !isExcluded(path, this.settings.excludedPatterns)
    ));
    this.saveSyncQueue.clear();
    if (paths.length > 0) await this.syncSelectedFiles(paths, "保存");
  }

  async runSync(trigger: string): Promise<void> {
    if (!this.isConnected()) {
      this.setStatus("飞书同步：未连接");
      if (trigger === "手动") await this.connectFeishu();
      return;
    }
    if (this.syncing) {
      new Notice("飞书同步正在运行，请稍候");
      return;
    }
    this.syncing = true;
    this.remoteFiles = undefined;
    this.remoteStatusCheckedAt = 0;
    this.setStatus(`飞书同步：${trigger}同步中…`);
    const notice = new Notice("正在同步 Obsidian 与飞书云盘…", 0);
    try {
      const stats = await this.createSyncEngine().sync();
      const summary = this.formatStats(stats);
      this.setStatus(`飞书同步：${summary}`);
      notice.setMessage(`飞书同步完成：${summary}`);
      window.setTimeout(() => notice.hide(), stats.errors.length > 0 ? 10000 : 5000);
      if (stats.errors.length > 0) {
        console.warn("Feishu Vault Sync completed with errors", stats.errors);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.setStatus("飞书同步：失败");
      notice.setMessage(`飞书同步失败：${message}`);
      window.setTimeout(() => notice.hide(), 10000);
      console.error("Feishu Vault Sync failed", error);
    } finally {
      this.syncing = false;
    }
  }

  async syncSelectedFiles(paths: string[], trigger = "选中"): Promise<void> {
    const selected = [...new Set(paths.map(normalizeVaultPath).filter(Boolean))];
    if (selected.length === 0) {
      new Notice("请先选择要同步的文件");
      return;
    }
    if (!this.isConnected()) {
      new Notice("请先扫码连接飞书");
      return;
    }
    if (this.syncing) {
      new Notice("飞书同步正在运行，请稍候");
      return;
    }

    this.syncing = true;
    this.remoteFiles = undefined;
    this.remoteStatusCheckedAt = 0;
    const actionLabel = trigger === "保存" ? "保存后同步" : "选中文件同步";
    this.setStatus(`飞书同步：${actionLabel}中（${selected.length}）…`);
    const notice = new Notice(`${actionLabel}：${selected.length} 个文件…`, 0);
    try {
      const stats = await this.createSyncEngine().syncSelected(selected);
      const summary = this.formatStats(stats);
      this.setStatus(`飞书同步：${summary}`);
      notice.setMessage(`${actionLabel}完成：${summary}`);
      window.setTimeout(() => notice.hide(), stats.errors.length > 0 ? 10000 : 5000);
      if (stats.errors.length > 0) {
        console.warn("Feishu Vault Sync selected files completed with errors", stats.errors);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.setStatus(`飞书同步：${actionLabel}失败`);
      notice.setMessage(`${actionLabel}失败：${message}`);
      window.setTimeout(() => notice.hide(), 10000);
      console.error("Feishu Vault Sync selected files failed", error);
    } finally {
      this.syncing = false;
    }
  }

  async cancelSelectedFiles(paths: string[]): Promise<void> {
    const selected = [...new Set(paths.map(normalizeVaultPath).filter(Boolean))];
    if (selected.length === 0) {
      new Notice("请先选择要取消同步的文件");
      return;
    }
    if (!this.isConnected()) {
      new Notice("请先扫码连接飞书");
      return;
    }
    if (this.syncing) {
      new Notice("飞书同步正在运行，请稍候");
      return;
    }

    this.syncing = true;
    this.remoteFiles = undefined;
    this.remoteStatusCheckedAt = 0;
    this.setStatus(`飞书同步：正在取消 ${selected.length} 个文件…`);
    const notice = new Notice(`正在删除飞书中的 ${selected.length} 个文件副本…`, 0);
    try {
      const stats = await this.createSyncEngine().cancelSync(selected);
      const summary = stats.errors.length > 0
        ? `已取消 ${stats.successfulPaths.length}，失败 ${stats.errors.length}`
        : `已取消 ${stats.successfulPaths.length}`;
      this.setStatus(`飞书同步：${summary}`);
      notice.setMessage(`取消同步完成：${summary}`);
      window.setTimeout(() => notice.hide(), stats.errors.length > 0 ? 10000 : 5000);
      if (stats.errors.length > 0) {
        console.warn("Feishu Vault Sync cancellation completed with errors", stats.errors);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.setStatus("飞书同步：取消失败");
      notice.setMessage(`取消同步失败：${message}`);
      window.setTimeout(() => notice.hide(), 10000);
      console.error("Feishu Vault Sync cancellation failed", error);
    } finally {
      this.syncing = false;
    }
  }

  getFileSyncStatuses(): FileSyncStatus[] {
    const disabled = new Set(this.state.disabledPaths.map(normalizeVaultPath));
    const failures = new Map(Object.entries(this.state.fileFailures));
    const statuses: FileSyncStatus[] = [];
    const localPaths = new Set<string>();

    for (const file of this.app.vault.getFiles()) {
      const path = normalizeVaultPath(file.path);
      if (isExcluded(path, this.settings.excludedPatterns)) continue;
      localPaths.add(path);
      const entry = this.state.entries[path];
      if (disabled.has(path)) {
        statuses.push({ path, category: "disabled" });
      } else if (failures.has(path)) {
        statuses.push({ path, category: "failed", message: failures.get(path) });
      } else if (entry && entry.localMtime === file.stat.mtime && entry.size === file.stat.size) {
        const remote = this.remoteFiles?.get(path);
        if (this.remoteFiles && !remote) {
          statuses.push({ path, category: "pending", message: "飞书副本不存在" });
        } else if (remote && (
          entry.remoteToken !== remote.token
          || remote.modifiedTime > entry.remoteModifiedTime + 1
        )) {
          statuses.push({ path, category: "pending", message: "飞书文件在上次同步后有变化" });
        } else {
          statuses.push({ path, category: "synced" });
        }
      } else {
        statuses.push({
          path,
          category: "pending",
          message: entry ? "本地文件在上次同步后有变化" : "尚无同步记录"
        });
      }
    }

    for (const [path, message] of failures) {
      if (!localPaths.has(path) && !disabled.has(path)) {
        statuses.push({ path, category: "failed", message });
      }
    }
    return statuses.sort((left, right) => left.path.localeCompare(right.path, "zh-CN"));
  }

  async refreshRemoteFileStatuses(): Promise<void> {
    if (!this.isConnected()) throw new Error("请先扫码连接飞书");
    const tree = await this.client.listTree(this.settings.rootFolderToken.trim());
    this.remoteFiles = tree.files;
    this.remoteStatusCheckedAt = Date.now();
  }

  async testConnection(): Promise<void> {
    if (!this.isConnected()) {
      new Notice("请先扫码连接飞书");
      return;
    }
    const notice = new Notice("正在测试飞书连接…", 0);
    try {
      await this.client.testConnection();
      notice.setMessage("飞书连接成功，根文件夹可以访问");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      notice.setMessage(`飞书连接失败：${message}`);
    } finally {
      window.setTimeout(() => notice.hide(), 7000);
    }
  }

  isConnected(): boolean {
    return Boolean(
      this.settings.appId
      && this.settings.appSecret
      && this.settings.rootFolderToken
    );
  }

  async connectFeishu(): Promise<void> {
    if (this.loginAbortController) {
      new Notice("飞书扫码授权正在进行中");
      return;
    }
    const abortController = new AbortController();
    this.loginAbortController = abortController;
    const modal = new FeishuLoginModal(this.app, () => abortController.abort());
    modal.open();

    try {
      const existingAppId = this.settings.appId.trim();
      const result = await registerApp({
        appId: existingAppId || undefined,
        createOnly: !existingAppId,
        source: "obsidian-feishu-vault-sync",
        signal: abortController.signal,
        appPreset: {
          name: "Obsidian Vault Sync",
          desc: "将 Obsidian Vault 按原始目录和文件格式同步到飞书云盘"
        },
        addons: {
          preset: false,
          scopes: {
            tenant: [
              "drive:drive",
              "drive:drive.metadata:readonly",
            ]
          }
        },
        onQRCodeReady: (info) => {
          void modal.showQRCode(info.url, info.expireIn);
        },
        onStatusChange: (info) => {
          if (info.status === "slow_down") modal.setStatus("飞书要求降低轮询速度，请继续在手机上完成授权…");
          if (info.status === "domain_switched") modal.setStatus("已切换飞书账号域名，正在刷新二维码…");
        }
      });

      modal.setStatus("扫码成功，正在自动创建专用同步目录…");
      const previousAppId = this.settings.appId;
      const previousRootToken = this.settings.rootFolderToken;
      this.settings = {
        ...this.settings,
        appId: result.client_id,
        appSecret: result.client_secret,
        userOpenId: result.user_info?.open_id ?? this.settings.userOpenId,
        connectedAt: Date.now()
      };
      await this.persist();

      let storage: { token: string; shareWarning?: string };
      if (previousAppId === this.settings.appId && previousRootToken) {
        try {
          await this.client.testConnection();
          storage = { token: previousRootToken };
        } catch {
          storage = await this.client.setupStorage(
            this.app.vault.getName(),
            this.settings.userOpenId
          );
        }
      } else {
        storage = await this.client.setupStorage(
          this.app.vault.getName(),
          this.settings.userOpenId
        );
      }
      this.settings.rootFolderToken = storage.token;
      if (previousAppId !== this.settings.appId || previousRootToken !== storage.token) {
        this.state = { ...DEFAULT_STATE, entries: {}, disabledPaths: [], fileFailures: {} };
      }
      await this.persist();
      modal.finish("飞书连接成功，马上开始首次同步");
      this.setStatus("飞书同步：已连接");
      if (storage.shareWarning) {
        new Notice(`飞书已连接，但共享同步目录时出现提示：${storage.shareWarning}`, 10000);
      } else {
        new Notice("飞书连接成功，已自动创建并共享专用同步目录");
      }
      window.setTimeout(() => void this.runSync("首次"), 1400);
    } catch (error) {
      const details = error as { code?: string; description?: string; message?: string };
      if (details.code === "abort" || abortController.signal.aborted) return;
      const message = details.description || details.message || String(error);
      modal.setError(`连接失败：${message}`);
      new Notice(`飞书连接失败：${message}`, 10000);
    } finally {
      if (this.loginAbortController === abortController) {
        this.loginAbortController = undefined;
      }
    }
  }

  async disconnectFeishu(): Promise<void> {
    this.loginAbortController?.abort();
    this.settings = {
      ...this.settings,
      appId: "",
      appSecret: "",
      rootFolderToken: "",
      userOpenId: "",
      connectedAt: 0
    };
    this.state = { ...DEFAULT_STATE, entries: {}, disabledPaths: [], fileFailures: {} };
    await this.persist();
    this.setStatus("飞书同步：未连接");
    new Notice("已断开飞书连接；飞书云盘中的文件不会被删除");
  }

  private async loadPluginData(): Promise<void> {
    const saved = await this.loadData() as Partial<PluginData> | null;
    this.settings = {
      ...DEFAULT_SETTINGS,
      ...(saved?.settings ?? {}),
      excludedPatterns: saved?.settings?.excludedPatterns ?? [...DEFAULT_SETTINGS.excludedPatterns]
    };
    this.state = {
      ...DEFAULT_STATE,
      ...(saved?.state ?? {}),
      version: DEFAULT_STATE.version,
      entries: saved?.state?.entries ?? {},
      disabledPaths: saved?.state?.disabledPaths ?? [],
      fileFailures: saved?.state?.fileFailures ?? {}
    };
  }

  private async persist(): Promise<void> {
    const data: PluginData = { settings: this.settings, state: this.state };
    await this.saveData(data);
  }

  private createSyncEngine(): SyncEngine {
    return new SyncEngine(
      this.app.vault,
      this.client,
      () => this.settings,
      this.state,
      () => this.persist(),
      (message) => this.setStatus(`飞书同步：${message}`)
    );
  }

  private reschedule(): void {
    if (this.intervalId !== undefined) {
      window.clearInterval(this.intervalId);
      this.intervalId = undefined;
    }
    if (!this.settings.autoSyncEnabled) return;
    const milliseconds = Math.max(1, this.settings.intervalMinutes) * 60 * 1000;
    this.intervalId = window.setInterval(() => void this.runSync("定时"), milliseconds);
    this.registerInterval(this.intervalId);
  }

  private setStatus(message: string): void {
    this.statusBarItem?.setText(message);
  }

  private formatStats(stats: SyncStats): string {
    const parts = [
      `上传 ${stats.uploaded}`,
      `下载 ${stats.downloaded}`
    ];
    if (stats.conflicts) parts.push(`冲突 ${stats.conflicts}`);
    if (stats.deletedRemote || stats.deletedLocal) {
      parts.push(`删除 ${stats.deletedRemote + stats.deletedLocal}`);
    }
    if (stats.errors.length) parts.push(`错误 ${stats.errors.length}`);
    return parts.join("，");
  }
}

class FeishuVaultSyncSettingTab extends PluginSettingTab {
  private readonly selectedPaths = new Set<string>();
  private fileQuery = "";

  constructor(app: App, private readonly plugin: FeishuVaultSyncPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "飞书云盘同步" });
    containerEl.createEl("p", {
      text: "插件会把笔记和附件作为原始文件同步到飞书，以无损保留 Obsidian 的 Markdown、YAML、双链和目录结构。"
    });

    const connectedAt = this.plugin.settings.connectedAt
      ? new Date(this.plugin.settings.connectedAt).toLocaleString()
      : "";
    const accountSetting = new Setting(containerEl)
      .setName("飞书连接")
      .setDesc(this.plugin.isConnected()
        ? `已通过扫码连接${connectedAt ? `（${connectedAt}）` : ""}；同步目录已自动创建并共享给你`
        : "无需填写 App ID、Secret 或文件夹 Token；点击后使用飞书扫码授权");

    accountSetting.addButton((button) => {
      if (!this.plugin.isConnected()) button.setCta();
      button
        .setButtonText(this.plugin.isConnected() ? "重新扫码授权" : "扫码连接飞书")
        .onClick(async () => {
          await this.plugin.connectFeishu();
          this.display();
        });
    });
    if (this.plugin.isConnected()) {
      accountSetting.addButton((button) => button
        .setButtonText("断开连接")
        .onClick(async () => {
          await this.plugin.disconnectFeishu();
          this.display();
        }));
    }

    new Setting(containerEl)
      .setName("同步方向")
      .setDesc("默认仅本地到飞书；双向模式会把飞书端原始文件的变化写回本地")
      .addDropdown((dropdown) => dropdown
        .addOption("push", "本地 → 飞书（默认）")
        .addOption("bidirectional", "双向同步")
        .setValue(this.plugin.settings.direction)
        .onChange(async (value) => this.plugin.updateSettings({
          direction: value as FeishuSyncSettings["direction"]
        })));

    new Setting(containerEl)
      .setName("Ctrl+S 后同步当前文件")
      .setDesc("默认开启；在 Markdown 编辑器按 Ctrl+S 后，等本地保存完成便立即上传当前文件。已取消同步的文件不会被恢复")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.syncOnSave)
        .onChange(async (value) => this.plugin.updateSettings({ syncOnSave: value })));

    new Setting(containerEl)
      .setName("自动定时同步")
      .setDesc("开启后按下面设置的分钟数周期性同步整个 Vault")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.autoSyncEnabled)
        .onChange(async (value) => {
          await this.plugin.updateSettings({ autoSyncEnabled: value });
          this.display();
        }));

    new Setting(containerEl)
      .setName("同步间隔（分钟）")
      .setDesc(this.plugin.settings.autoSyncEnabled
        ? "最短 1 分钟；修改后自动重新安排定时同步"
        : "自动定时同步已关闭")
      .addText((text) => {
        text.inputEl.type = "number";
        text.inputEl.min = "1";
        text.inputEl.max = "10080";
        text.setDisabled(!this.plugin.settings.autoSyncEnabled);
        text
          .setValue(String(this.plugin.settings.intervalMinutes))
          .onChange(async (value) => this.plugin.updateSettings({
            intervalMinutes: Number.parseInt(value, 10) || 30
          }));
      });

    new Setting(containerEl)
      .setName("启动后同步")
      .setDesc("打开 Obsidian 并加载 Vault 后自动运行一次")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.syncOnStartup)
        .onChange(async (value) => this.plugin.updateSettings({ syncOnStartup: value })));

    new Setting(containerEl)
      .setName("同步删除")
      .setDesc("危险选项：传播文件删除。默认关闭；双向模式下本地删除使用 Obsidian .trash 回收站")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.propagateDeletions)
        .onChange(async (value) => this.plugin.updateSettings({ propagateDeletions: value })));

    new Setting(containerEl)
      .setName("排除规则")
      .setDesc("每行一个相对路径 Glob。默认不上传 Obsidian 配置、回收站、Git 与 node_modules")
      .addTextArea((area) => {
        area.inputEl.rows = 7;
        area.inputEl.cols = 40;
        area
          .setValue(this.plugin.settings.excludedPatterns.join("\n"))
          .onChange(async (value) => this.plugin.updateSettings({
            excludedPatterns: value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)
          }));
      });

    const actions = containerEl.createDiv({ cls: "feishu-vault-sync-actions" });
    new Setting(actions)
      .addButton((button) => button
        .setButtonText("测试连接")
        .onClick(async () => this.plugin.testConnection()))
      .addButton((button) => button
        .setCta()
        .setButtonText("立即同步")
        .onClick(async () => {
          await this.plugin.runSync("手动");
          this.display();
        }));

    containerEl.createEl("h3", { text: "文件同步状态" });
    containerEl.createEl("p", {
      cls: "feishu-vault-sync-panel-description",
      text: "可查看已同步、待同步、失败和已取消的文件。勾选一个或多个文件后，可以立即同步，或取消同步并删除飞书副本。"
    });
    const filePanel = containerEl.createDiv({ cls: "feishu-vault-sync-file-panel" });
    this.renderFilePanel(filePanel);

    const lastSync = this.plugin.state.lastSyncAt
      ? new Date(this.plugin.state.lastSyncAt).toLocaleString()
      : "尚未同步";
    containerEl.createDiv({
      cls: "feishu-vault-sync-status",
      text: `上次成功完成：${lastSync}`
    });
    containerEl.createDiv({
      cls: "feishu-vault-sync-warning",
      text: "飞书在线文档（docx）、表格和多维表格不会写回 Vault；本插件同步的是保持 Obsidian 格式的原始 .md 与附件文件。大文件会自动分片上传。"
    });
  }

  renderFilePanel(container: HTMLElement): void {
    container.empty();
    const allStatuses = this.plugin.getFileSyncStatuses();
    const knownPaths = new Set(allStatuses.map((status) => status.path));
    for (const path of [...this.selectedPaths]) {
      if (!knownPaths.has(path)) this.selectedPaths.delete(path);
    }

    const toolbar = container.createDiv({ cls: "feishu-vault-sync-file-toolbar" });
    const search = toolbar.createEl("input", {
      cls: "feishu-vault-sync-file-search",
      attr: { type: "search", placeholder: "搜索 Vault 相对路径…", "aria-label": "搜索同步文件" }
    });
    search.value = this.fileQuery;
    const refreshButton = toolbar.createEl("button", { text: "校验飞书状态" });
    if (this.plugin.remoteStatusCheckedAt) {
      container.createDiv({
        cls: "feishu-vault-sync-remote-checked",
        text: `飞书端校验时间：${new Date(this.plugin.remoteStatusCheckedAt).toLocaleString()}`
      });
    }

    const actionBar = container.createDiv({ cls: "feishu-vault-sync-file-actions" });
    const selectVisibleButton = actionBar.createEl("button", { text: "全选当前结果" });
    const syncButton = actionBar.createEl("button", { cls: "mod-cta" });
    const cancelButton = actionBar.createEl("button", { cls: "feishu-vault-sync-delete-button" });
    const listContainer = container.createDiv({ cls: "feishu-vault-sync-file-lists" });
    let visiblePaths: string[] = [];

    const updateActions = (): void => {
      const count = this.selectedPaths.size;
      syncButton.textContent = `同步选中（${count}）`;
      cancelButton.textContent = `取消同步并删除飞书副本（${count}）`;
      syncButton.disabled = count === 0 || !this.plugin.isConnected();
      cancelButton.disabled = count === 0 || !this.plugin.isConnected();
      const allVisibleSelected = visiblePaths.length > 0
        && visiblePaths.every((path) => this.selectedPaths.has(path));
      selectVisibleButton.textContent = allVisibleSelected ? "取消选择当前结果" : "全选当前结果";
      selectVisibleButton.disabled = visiblePaths.length === 0;
    };

    const renderLists = (): void => {
      listContainer.empty();
      const query = this.fileQuery.trim().toLocaleLowerCase();
      const filtered = query
        ? allStatuses.filter((status) => status.path.toLocaleLowerCase().includes(query))
        : allStatuses;
      visiblePaths = filtered.map((status) => status.path);

      const categories: Array<{
        category: FileSyncCategory;
        label: string;
        open: boolean;
      }> = [
        { category: "failed", label: "同步失败", open: true },
        { category: "pending", label: "尚未同步 / 有待上传变更", open: true },
        { category: "synced", label: "已同步成功", open: false },
        { category: "disabled", label: "已取消同步", open: false }
      ];
      for (const item of categories) {
        this.renderStatusSection(
          listContainer,
          item.label,
          item.category,
          filtered.filter((status) => status.category === item.category),
          item.open,
          updateActions
        );
      }
      if (filtered.length === 0) {
        listContainer.createDiv({
          cls: "feishu-vault-sync-empty",
          text: query ? "没有匹配的文件" : "Vault 中没有可同步文件"
        });
      }
      updateActions();
    };

    search.addEventListener("input", () => {
      this.fileQuery = search.value;
      renderLists();
    });
    refreshButton.addEventListener("click", async () => {
      refreshButton.disabled = true;
      refreshButton.textContent = "正在读取飞书…";
      try {
        await this.plugin.refreshRemoteFileStatuses();
        this.renderFilePanel(container);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        new Notice(`校验飞书文件状态失败：${message}`, 8000);
        refreshButton.disabled = false;
        refreshButton.textContent = "校验飞书状态";
      }
    });
    selectVisibleButton.addEventListener("click", () => {
      const allSelected = visiblePaths.length > 0
        && visiblePaths.every((path) => this.selectedPaths.has(path));
      for (const path of visiblePaths) {
        if (allSelected) this.selectedPaths.delete(path);
        else this.selectedPaths.add(path);
      }
      renderLists();
    });
    syncButton.addEventListener("click", async () => {
      await this.plugin.syncSelectedFiles([...this.selectedPaths]);
      this.selectedPaths.clear();
      this.renderFilePanel(container);
    });
    cancelButton.addEventListener("click", async () => {
      const paths = [...this.selectedPaths];
      if (!await this.confirmCancellation(paths)) return;
      await this.plugin.cancelSelectedFiles(paths);
      this.selectedPaths.clear();
      this.renderFilePanel(container);
    });

    renderLists();
  }

  private renderStatusSection(
    container: HTMLElement,
    label: string,
    category: FileSyncCategory,
    statuses: FileSyncStatus[],
    open: boolean,
    onSelectionChange: () => void
  ): void {
    const details = container.createEl("details", {
      cls: `feishu-vault-sync-file-section is-${category}`
    });
    details.open = open;
    details.createEl("summary", { text: `${label}（${statuses.length}）` });
    const rows = details.createDiv({ cls: "feishu-vault-sync-file-rows" });
    if (statuses.length === 0) {
      rows.createDiv({ cls: "feishu-vault-sync-empty", text: "无" });
      return;
    }

    for (const status of statuses) {
      const row = rows.createEl("label", { cls: "feishu-vault-sync-file-row" });
      const checkbox = row.createEl("input", {
        attr: { type: "checkbox", "aria-label": `选择 ${status.path}` }
      });
      checkbox.checked = this.selectedPaths.has(status.path);
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) this.selectedPaths.add(status.path);
        else this.selectedPaths.delete(status.path);
        onSelectionChange();
      });
      const content = row.createDiv({ cls: "feishu-vault-sync-file-content" });
      content.createDiv({ cls: "feishu-vault-sync-file-path", text: status.path });
      if (status.message) {
        content.createDiv({ cls: "feishu-vault-sync-file-message", text: status.message });
      }
    }
  }

  private confirmCancellation(paths: string[]): Promise<boolean> {
    return new Promise((resolve) => {
      new FileCancellationModal(this.app, paths, resolve).open();
    });
  }
}

class FileSyncManagerModal extends Modal {
  private readonly filePanel: FeishuVaultSyncSettingTab;

  constructor(app: App, private readonly plugin: FeishuVaultSyncPlugin) {
    super(app);
    this.filePanel = new FeishuVaultSyncSettingTab(app, plugin);
  }

  onOpen(): void {
    this.modalEl.addClass("feishu-vault-sync-manager-modal");
    this.render();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "飞书同步管理" });
    contentEl.createEl("p", {
      cls: "feishu-vault-sync-panel-description",
      text: "在这里查看所有文件状态，勾选单个或多个文件同步，也可以取消同步并删除对应飞书副本。"
    });

    const actions = contentEl.createDiv({ cls: "feishu-vault-sync-manager-actions" });
    const fullSyncButton = actions.createEl("button", {
      cls: "mod-cta",
      text: "立即全量同步"
    });
    fullSyncButton.disabled = !this.plugin.isConnected();
    fullSyncButton.addEventListener("click", async () => {
      fullSyncButton.disabled = true;
      fullSyncButton.textContent = "正在同步…";
      await this.plugin.runSync("手动");
      this.render();
    });

    if (!this.plugin.isConnected()) {
      const connectButton = actions.createEl("button", { text: "扫码连接飞书" });
      connectButton.addEventListener("click", async () => {
        connectButton.disabled = true;
        await this.plugin.connectFeishu();
        this.render();
      });
    }

    new Setting(contentEl)
      .setName("Ctrl+S 立即同步当前文件")
      .setDesc("在 Markdown 编辑器保存后立即上传当前文件")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.syncOnSave)
        .onChange(async (value) => this.plugin.updateSettings({ syncOnSave: value })));

    new Setting(contentEl)
      .setName("自动定时同步")
      .setDesc(this.plugin.settings.autoSyncEnabled
        ? `当前每 ${this.plugin.settings.intervalMinutes} 分钟同步一次`
        : "当前已关闭")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.autoSyncEnabled)
        .onChange(async (value) => {
          await this.plugin.updateSettings({ autoSyncEnabled: value });
          this.render();
        }));

    new Setting(contentEl)
      .setName("自动同步间隔（分钟）")
      .setDesc("范围 1–10080 分钟")
      .addText((text) => {
        text.inputEl.type = "number";
        text.inputEl.min = "1";
        text.inputEl.max = "10080";
        text.setDisabled(!this.plugin.settings.autoSyncEnabled);
        text
          .setValue(String(this.plugin.settings.intervalMinutes))
          .onChange(async (value) => this.plugin.updateSettings({
            intervalMinutes: Number.parseInt(value, 10) || 30
          }));
      });

    const lastSync = this.plugin.state.lastSyncAt
      ? new Date(this.plugin.state.lastSyncAt).toLocaleString()
      : "尚未同步";
    contentEl.createDiv({
      cls: "feishu-vault-sync-manager-summary",
      text: `上次完成：${lastSync}`
    });
    const panel = contentEl.createDiv({ cls: "feishu-vault-sync-file-panel" });
    this.filePanel.renderFilePanel(panel);
  }
}

class FileCancellationModal extends Modal {
  private settled = false;

  constructor(
    app: App,
    private readonly paths: string[],
    private readonly resolve: (confirmed: boolean) => void
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl("h2", { text: `取消同步 ${this.paths.length} 个文件？` });
    contentEl.createEl("p", {
      text: "这些文件的飞书副本会被删除，本地文件会保留，并在以后自动/定时同步时跳过。你可以随时在“已取消同步”中重新选中并上传。"
    });
    const preview = contentEl.createEl("ul", { cls: "feishu-vault-sync-cancel-preview" });
    for (const path of this.paths.slice(0, 10)) preview.createEl("li", { text: path });
    if (this.paths.length > 10) preview.createEl("li", { text: `以及另外 ${this.paths.length - 10} 个文件…` });

    const actions = contentEl.createDiv({ cls: "modal-button-container" });
    const keepButton = actions.createEl("button", { text: "返回" });
    keepButton.addEventListener("click", () => this.finish(false));
    const deleteButton = actions.createEl("button", {
      cls: "mod-warning",
      text: "删除飞书副本并取消同步"
    });
    deleteButton.addEventListener("click", () => this.finish(true));
  }

  onClose(): void {
    this.contentEl.empty();
    if (!this.settled) this.resolve(false);
  }

  private finish(confirmed: boolean): void {
    if (this.settled) return;
    this.settled = true;
    this.resolve(confirmed);
    this.close();
  }
}
