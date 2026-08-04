import { App, Modal } from "obsidian";
import QRCode from "qrcode";

export class FeishuLoginModal extends Modal {
  private qrUrl = "";
  private qrContainer!: HTMLElement;
  private statusEl!: HTMLElement;
  private expiryEl!: HTMLElement;
  private completed = false;

  constructor(app: App, private readonly onCancel: () => void) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("feishu-vault-sync-login");
    contentEl.createEl("h2", { text: "扫码连接飞书" });
    contentEl.createEl("p", {
      text: "插件正在向飞书请求创建专用同步应用和所需云盘权限。请使用飞书扫码并确认授权。"
    });
    this.qrContainer = contentEl.createDiv({ cls: "feishu-vault-sync-qr" });
    this.qrContainer.createDiv({ text: "正在获取二维码…" });
    this.statusEl = contentEl.createDiv({
      cls: "feishu-vault-sync-login-status",
      text: "正在连接飞书授权服务…"
    });
    this.expiryEl = contentEl.createDiv({ cls: "feishu-vault-sync-status" });

    const actions = contentEl.createDiv({ cls: "feishu-vault-sync-actions" });
    const browserButton = actions.createEl("button", { text: "在浏览器打开" });
    browserButton.addEventListener("click", () => {
      if (this.qrUrl) window.open(this.qrUrl, "_blank", "noopener,noreferrer");
    });
    const cancelButton = actions.createEl("button", { text: "取消" });
    cancelButton.addEventListener("click", () => this.close());
  }

  onClose(): void {
    this.contentEl.empty();
    if (!this.completed) this.onCancel();
  }

  async showQRCode(url: string, expireIn: number): Promise<void> {
    this.qrUrl = url;
    const dataUrl = await QRCode.toDataURL(url, {
      width: 280,
      margin: 2,
      errorCorrectionLevel: "M"
    });
    this.qrContainer.empty();
    this.qrContainer.createEl("img", {
      attr: { src: dataUrl, alt: "飞书扫码授权二维码" }
    });
    this.statusEl.setText("请使用飞书扫描二维码，并在手机上确认创建和授权");
    this.expiryEl.setText(`二维码约 ${Math.max(1, Math.floor(expireIn / 60))} 分钟后过期`);
  }

  setStatus(message: string): void {
    this.statusEl.setText(message);
  }

  setError(message: string): void {
    this.statusEl.setText(message);
    this.statusEl.addClass("feishu-vault-sync-login-error");
  }

  finish(message: string): void {
    this.completed = true;
    this.statusEl.setText(message);
    this.statusEl.addClass("feishu-vault-sync-login-success");
    window.setTimeout(() => this.close(), 1200);
  }
}
