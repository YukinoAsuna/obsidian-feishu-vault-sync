import { requestUrl, RequestUrlParam } from "obsidian";
import { FeishuSyncSettings, RemoteNode, RemoteTree } from "./types";
import { joinPath, toArrayBuffer } from "./utils";

const API_BASE = "https://open.feishu.cn/open-apis";
const SIMPLE_UPLOAD_LIMIT = 20 * 1024 * 1024;
const EMPTY_PLACEHOLDER = new Uint8Array([0]);

interface FeishuEnvelope<T> {
  code: number;
  msg: string;
  data?: T;
}

interface TokenResponse {
  code: number;
  msg: string;
  tenant_access_token?: string;
  expire?: number;
}

interface FileListResponse {
  files?: Array<{
    name?: string;
    token?: string;
    type?: string;
    parent_token?: string;
    modified_time?: string;
  }>;
  has_more?: boolean;
  next_page_token?: string;
}

interface UploadResponse {
  file_token: string;
}

interface PrepareUploadResponse {
  upload_id: string;
  block_size: number;
  block_num: number;
}

interface CreateFolderResponse {
  token: string;
}

interface RootFolderResponse {
  token: string;
}

export interface StorageSetupResult {
  token: string;
  shareWarning?: string;
}

export interface UploadedFile {
  token: string;
  modifiedTime: number;
  emptyPlaceholder: boolean;
}

export class FeishuClient {
  private accessToken = "";
  private accessTokenExpiresAt = 0;
  private accessTokenCredentials = "";
  private lastMutationAt = 0;

  constructor(private readonly getSettings: () => FeishuSyncSettings) {}

  async testConnection(): Promise<void> {
    const settings = this.getSettings();
    this.validateCredentials(settings);
    if (!settings.rootFolderToken.trim()) throw new Error("尚未创建飞书同步目录，请重新扫码连接");
    await this.listFolder(settings.rootFolderToken.trim());
  }

  async setupStorage(vaultName: string, userOpenId: string): Promise<StorageSetupResult> {
    const root = await this.requestJson<RootFolderResponse>({
      url: `${API_BASE}/drive/explorer/v2/root_folder/meta`,
      method: "GET"
    });
    if (!root.token) throw new Error("飞书没有返回应用云盘根目录");

    const folderName = this.storageFolderName(vaultName);
    const rootChildren = await this.listFolder(root.token);
    let folder = rootChildren.find((item) => item.type === "folder" && item.name === folderName);
    if (!folder) folder = await this.createFolder(folderName, root.token);

    let shareWarning: string | undefined;
    if (userOpenId) {
      try {
        await this.shareFolder(folder.token, userOpenId);
      } catch (error) {
        shareWarning = error instanceof Error ? error.message : String(error);
        console.warn("Feishu Vault Sync: failed to share app-owned folder with scan user", error);
      }
    } else {
      shareWarning = "飞书未返回扫码用户的 Open ID，专用同步目录可能不会显示在你的云盘中";
    }
    return { token: folder.token, shareWarning };
  }

  async listTree(rootFolderToken: string): Promise<RemoteTree> {
    const tree: RemoteTree = {
      folders: new Map<string, RemoteNode>(),
      files: new Map<string, RemoteNode>(),
      unsupported: new Map<string, RemoteNode>()
    };
    tree.folders.set("", {
      name: "",
      token: rootFolderToken,
      type: "folder",
      parentToken: "",
      modifiedTime: 0
    });

    const queue: Array<{ path: string; token: string; depth: number }> = [
      { path: "", token: rootFolderToken, depth: 0 }
    ];
    while (queue.length > 0) {
      const current = queue.shift();
      if (!current) break;
      if (current.depth >= 15) {
        throw new Error(`飞书目录层级超过 15 层：${current.path}`);
      }
      const children = await this.listFolder(current.token);
      for (const child of children) {
        const path = joinPath(current.path, child.name);
        if (child.type === "folder") {
          tree.folders.set(path, child);
          queue.push({ path, token: child.token, depth: current.depth + 1 });
        } else if (child.type === "file") {
          const previous = tree.files.get(path);
          if (!previous || previous.modifiedTime <= child.modifiedTime) {
            tree.files.set(path, child);
          }
        } else {
          tree.unsupported.set(path, child);
        }
      }
    }
    return tree;
  }

  async createFolder(name: string, parentToken: string): Promise<RemoteNode> {
    await this.throttleMutation();
    const data = await this.requestJson<CreateFolderResponse>({
      url: `${API_BASE}/drive/v1/files/create_folder`,
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ name, folder_token: parentToken })
    });
    return {
      name,
      token: data.token,
      type: "folder",
      parentToken,
      modifiedTime: Math.floor(Date.now() / 1000)
    };
  }

  async uploadFile(name: string, parentToken: string, source: ArrayBuffer): Promise<UploadedFile> {
    const emptyPlaceholder = source.byteLength === 0;
    const bytes = emptyPlaceholder ? EMPTY_PLACEHOLDER : new Uint8Array(source);
    const token = bytes.byteLength > SIMPLE_UPLOAD_LIMIT
      ? await this.uploadMultipart(name, parentToken, bytes)
      : await this.uploadSimple(name, parentToken, bytes);
    return {
      token,
      modifiedTime: Math.floor(Date.now() / 1000),
      emptyPlaceholder
    };
  }

  private async uploadSimple(name: string, parentToken: string, bytes: Uint8Array): Promise<string> {
    await this.throttleMutation();
    const boundary = `----ObsidianFeishu${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
    const body = this.buildMultipart(boundary, {
      file_name: name,
      parent_type: "explorer",
      parent_node: parentToken,
      size: String(bytes.byteLength)
    }, name, bytes);
    const data = await this.requestJson<UploadResponse>({
      url: `${API_BASE}/drive/v1/files/upload_all`,
      method: "POST",
      headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
      body: toArrayBuffer(body)
    });
    return data.file_token;
  }

  private async uploadMultipart(name: string, parentToken: string, bytes: Uint8Array): Promise<string> {
    await this.throttleMutation();
    const prepared = await this.requestJson<PrepareUploadResponse>({
      url: `${API_BASE}/drive/v1/files/upload_prepare`,
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        file_name: name,
        parent_type: "explorer",
        parent_node: parentToken,
        size: bytes.byteLength
      })
    });
    if (!prepared.upload_id || prepared.block_size <= 0 || prepared.block_num <= 0) {
      throw new Error(`飞书没有返回有效的分片策略：${name}`);
    }

    for (let sequence = 0; sequence < prepared.block_num; sequence += 1) {
      const start = sequence * prepared.block_size;
      const part = bytes.subarray(start, Math.min(bytes.byteLength, start + prepared.block_size));
      await this.throttleMutation();
      const boundary = `----ObsidianFeishuPart${Date.now().toString(16)}${sequence}`;
      const body = this.buildMultipart(boundary, {
        upload_id: prepared.upload_id,
        seq: String(sequence),
        size: String(part.byteLength)
      }, name, part);
      await this.requestJson<Record<string, never>>({
        url: `${API_BASE}/drive/v1/files/upload_part`,
        method: "POST",
        headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
        body: toArrayBuffer(body)
      });
    }

    await this.throttleMutation();
    const finished = await this.requestJson<UploadResponse>({
      url: `${API_BASE}/drive/v1/files/upload_finish`,
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        upload_id: prepared.upload_id,
        block_num: prepared.block_num
      })
    });
    return finished.file_token;
  }

  async replaceFile(
    name: string,
    parentToken: string,
    source: ArrayBuffer,
    previousToken?: string
  ): Promise<UploadedFile> {
    const uploaded = await this.uploadFile(name, parentToken, source);
    if (previousToken && previousToken !== uploaded.token) {
      try {
        await this.deleteNode(previousToken, "file");
      } catch (error) {
        console.warn("Feishu Vault Sync: old remote file could not be deleted", error);
      }
    }
    return uploaded;
  }

  async downloadFile(token: string, emptyPlaceholder = false): Promise<ArrayBuffer> {
    const accessToken = await this.getAccessToken();
    const response = await requestUrl({
      url: `${API_BASE}/drive/v1/files/${encodeURIComponent(token)}/download`,
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken}` },
      throw: false
    });
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`下载飞书文件失败（HTTP ${response.status}）`);
    }
    const bytes = new Uint8Array(response.arrayBuffer);
    if (emptyPlaceholder && bytes.byteLength === 1 && bytes[0] === 0) {
      return new ArrayBuffer(0);
    }
    return response.arrayBuffer;
  }

  async deleteNode(token: string, type: string): Promise<void> {
    await this.throttleMutation();
    await this.requestJson<Record<string, never>>({
      url: `${API_BASE}/drive/v1/files/${encodeURIComponent(token)}?type=${encodeURIComponent(type)}`,
      method: "DELETE"
    });
  }

  private async shareFolder(folderToken: string, userOpenId: string): Promise<void> {
    await this.requestJson<Record<string, unknown>>({
      url: `${API_BASE}/drive/v1/permissions/${encodeURIComponent(folderToken)}/members?type=folder&need_notification=false`,
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        member_type: "openid",
        member_id: userOpenId,
        perm: "full_access"
      })
    });
  }

  private storageFolderName(vaultName: string): string {
    const cleaned = vaultName.replace(/[\\/:*?"<>|\r\n]/g, "_").trim();
    return `Obsidian Vault - ${cleaned || "Vault"}`.slice(0, 240);
  }

  private async listFolder(folderToken: string): Promise<RemoteNode[]> {
    const result: RemoteNode[] = [];
    let pageToken = "";
    do {
      const query = new URLSearchParams({
        folder_token: folderToken,
        page_size: "200",
        order_by: "EditedTime",
        direction: "DESC"
      });
      if (pageToken) query.set("page_token", pageToken);
      const data = await this.requestJson<FileListResponse>({
        url: `${API_BASE}/drive/v1/files?${query.toString()}`,
        method: "GET"
      });
      for (const file of data.files ?? []) {
        if (!file.name || !file.token || !file.type) continue;
        result.push({
          name: file.name,
          token: file.token,
          type: file.type,
          parentToken: file.parent_token ?? folderToken,
          modifiedTime: Number(file.modified_time ?? 0)
        });
      }
      pageToken = data.has_more ? (data.next_page_token ?? "") : "";
    } while (pageToken);
    return result;
  }

  private validateCredentials(settings: FeishuSyncSettings): void {
    if (!settings.appId.trim() || !settings.appSecret.trim()) {
      throw new Error("尚未连接飞书，请在插件设置中点击“扫码连接飞书”");
    }
  }

  private async getAccessToken(): Promise<string> {
    const settings = this.getSettings();
    this.validateCredentials(settings);
    const credentials = `${settings.appId.trim()}\u0000${settings.appSecret.trim()}`;
    if (
      this.accessToken
      && this.accessTokenCredentials === credentials
      && Date.now() < this.accessTokenExpiresAt - 5 * 60 * 1000
    ) {
      return this.accessToken;
    }
    const response = await requestUrl({
      url: `${API_BASE}/auth/v3/tenant_access_token/internal`,
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ app_id: settings.appId.trim(), app_secret: settings.appSecret.trim() }),
      throw: false
    });
    const payload = response.json as TokenResponse;
    if (response.status < 200 || response.status >= 300 || payload.code !== 0 || !payload.tenant_access_token) {
      throw new Error(`获取飞书访问令牌失败：${payload.msg || `HTTP ${response.status}`}`);
    }
    this.accessToken = payload.tenant_access_token;
    this.accessTokenCredentials = credentials;
    this.accessTokenExpiresAt = Date.now() + Math.max(60, payload.expire ?? 7200) * 1000;
    return this.accessToken;
  }

  private async requestJson<T>(params: RequestUrlParam): Promise<T> {
    const token = await this.getAccessToken();
    const response = await requestUrl({
      ...params,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(params.headers ?? {})
      },
      throw: false
    });
    let envelope: FeishuEnvelope<T>;
    try {
      envelope = response.json as FeishuEnvelope<T>;
    } catch {
      throw new Error(`飞书接口返回了无法解析的响应（HTTP ${response.status}）`);
    }
    if (response.status < 200 || response.status >= 300 || envelope.code !== 0) {
      throw new Error(`飞书接口失败：${envelope.msg || `HTTP ${response.status}`}（code ${envelope.code ?? "unknown"}）`);
    }
    return (envelope.data ?? {}) as T;
  }

  private buildMultipart(
    boundary: string,
    fields: Record<string, string>,
    fileName: string,
    file: Uint8Array
  ): Uint8Array {
    const encoder = new TextEncoder();
    const chunks: Uint8Array[] = [];
    for (const [name, value] of Object.entries(fields)) {
      chunks.push(encoder.encode(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`
      ));
    }
    const safeName = fileName.replace(/["\r\n]/g, "_");
    chunks.push(encoder.encode(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${safeName}"\r\nContent-Type: application/octet-stream\r\n\r\n`
    ));
    chunks.push(file);
    chunks.push(encoder.encode(`\r\n--${boundary}--\r\n`));
    const length = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
    const result = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return result;
  }

  private async throttleMutation(): Promise<void> {
    const elapsed = Date.now() - this.lastMutationAt;
    if (elapsed < 250) {
      await new Promise((resolve) => window.setTimeout(resolve, 250 - elapsed));
    }
    this.lastMutationAt = Date.now();
  }
}
