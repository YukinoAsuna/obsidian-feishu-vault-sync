import {
  App,
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
  SyncStats
} from "./types";

export default class FeishuVaultSyncPlugin extends Plugin {
  settings: FeishuSyncSettings = { ...DEFAULT_SETTINGS };
  state = { ...DEFAULT_STATE, entries: {} };
  client!: FeishuClient;
  private syncing = false;
  private intervalId: number | undefined;
  private statusBarItem!: HTMLElement;
  private loginAbortController: AbortController | undefined;

  async onload(): Promise<void> {
    // The Feishu SDK otherwise selects Axios' XHR adapter in Electron and the
    // device-registration endpoint is blocked by browser CORS. Obsidian's
    // requestUrl runs through the desktop network layer and avoids that limit.
    defaultHttpInstance.defaults.adapter = obsidianRequestAdapter;
    await this.loadPluginData();
    this.client = new FeishuClient(() => this.settings);
    this.statusBarItem = this.addStatusBarItem();
    this.setStatus(this.isConnected() ? "飞书同步：待机" : "飞书同步：未连接");

    this.addRibbonIcon("cloud-upload", "同步到飞书云盘", () => {
      void this.runSync("手动");
    });
    this.addCommand({
      id: "sync-now",
      name: "立即同步到飞书云盘",
      callback: () => void this.runSync("手动")
    });
    this.addCommand({
      id: "test-connection",
      name: "测试飞书连接",
      callback: () => void this.testConnection()
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
    this.loginAbortController?.abort();
  }

  async updateSettings(patch: Partial<FeishuSyncSettings>): Promise<void> {
    const previousInterval = this.settings.intervalMinutes;
    this.settings = { ...this.settings, ...patch };
    this.settings.intervalMinutes = Math.max(1, Math.min(10080, this.settings.intervalMinutes || 30));
    await this.persist();
    if (this.settings.intervalMinutes !== previousInterval) this.reschedule();
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
    this.setStatus(`飞书同步：${trigger}同步中…`);
    const notice = new Notice("正在同步 Obsidian 与飞书云盘…", 0);
    try {
      const engine = new SyncEngine(
        this.app.vault,
        this.client,
        () => this.settings,
        this.state,
        () => this.persist(),
        (message) => this.setStatus(`飞书同步：${message}`)
      );
      const stats = await engine.sync();
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
        this.state = { ...DEFAULT_STATE, entries: {} };
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
    this.state = { ...DEFAULT_STATE, entries: {} };
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
      entries: saved?.state?.entries ?? {}
    };
  }

  private async persist(): Promise<void> {
    const data: PluginData = { settings: this.settings, state: this.state };
    await this.saveData(data);
  }

  private reschedule(): void {
    if (this.intervalId !== undefined) {
      window.clearInterval(this.intervalId);
      this.intervalId = undefined;
    }
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
      .setName("同步间隔（分钟）")
      .setDesc("最短 1 分钟；修改后自动重新安排定时同步")
      .addText((text) => {
        text.inputEl.type = "number";
        text.inputEl.min = "1";
        text.inputEl.max = "10080";
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
        .onClick(async () => this.plugin.runSync("手动")));

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
}
