import { requestUrl, RequestUrlParam } from "obsidian";
import {
  DocxBlock,
  LocalImageAsset,
  PreparedMarkdown,
  SaveDocxMedia,
  documentBlocksToMarkdown
} from "./markdown-docx";
import { FeishuSyncSettings, RemoteNode, RemoteTree } from "./types";
import { joinPath, normalizeVaultPath, toArrayBuffer } from "./utils";

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

interface CreateDocumentResponse {
  document?: {
    document_id?: string;
    revision_id?: number;
    title?: string;
  };
}

interface ConvertDocumentResponse {
  first_level_block_ids?: string[];
  blocks?: DocxBlock[];
  block_id_to_image_urls?: Array<{ block_id: string; image_url: string }>;
}

interface CreateDescendantResponse {
  document_revision_id?: number;
  block_id_relations?: Array<{ temporary_block_id?: string; block_id?: string }>;
}

interface DocumentBlockListResponse {
  items?: DocxBlock[];
  has_more?: boolean;
  page_token?: string;
}

interface DocumentVersionResponse {
  version?: string;
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

export interface DownloadedMedia {
  data: ArrayBuffer;
  fileName: string;
  contentType: string;
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
    if (settings.markdownMode === "docx") await this.convertMarkdown("在线文档权限测试");
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
      duplicates: new Map<string, RemoteNode[]>(),
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
        const path = joinPath(
          current.path,
          child.type === "docx" && this.getSettings().markdownMode === "docx"
            ? this.localMarkdownName(child.name)
            : child.name
        );
        if (child.type === "folder") {
          tree.folders.set(path, child);
          queue.push({ path, token: child.token, depth: current.depth + 1 });
        } else if (child.type === "file" || (
          child.type === "docx" && this.getSettings().markdownMode === "docx"
        )) {
          const previous = tree.files.get(path);
          if (!previous) {
            tree.files.set(path, child);
          } else if (this.preferRemoteNode(path, child, previous)) {
            this.addDuplicate(tree, path, previous);
            tree.files.set(path, child);
          } else {
            this.addDuplicate(tree, path, child);
          }
        } else {
          tree.unsupported.set(path, child);
        }
      }
    }
    return tree;
  }

  private localMarkdownName(title: string): string {
    return title.toLowerCase().endsWith(".md") ? title : `${title}.md`;
  }

  private preferRemoteNode(path: string, candidate: RemoteNode, current: RemoteNode): boolean {
    const markdown = path.toLowerCase().endsWith(".md");
    if (this.getSettings().markdownMode === "docx" && markdown) {
      if (candidate.type === "docx" && current.type !== "docx") return true;
      if (candidate.type !== "docx" && current.type === "docx") return false;
    }
    return candidate.modifiedTime >= current.modifiedTime;
  }

  private addDuplicate(tree: RemoteTree, path: string, node: RemoteNode): void {
    const duplicates = tree.duplicates.get(path) ?? [];
    if (!duplicates.some((item) => item.token === node.token)) duplicates.push(node);
    tree.duplicates.set(path, duplicates);
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

  async upsertMarkdownDocument(
    title: string,
    parentToken: string,
    prepared: PreparedMarkdown,
    previousToken?: string
  ): Promise<UploadedFile> {
    const converted = await this.convertMarkdown(prepared.content);
    const imageSources = new Map<string, { fileName: string; data: ArrayBuffer }>();
    for (const image of converted.block_id_to_image_urls ?? []) {
      if (!image.image_url || imageSources.has(image.image_url)) continue;
      imageSources.set(image.image_url, await this.loadImageSource(image.image_url, prepared.images));
    }

    let documentId = previousToken;
    if (!documentId) {
      const created = await this.createDocument(title, parentToken);
      documentId = created.documentId;
    } else if (this.getSettings().createDocxVersions) {
      await this.createDocumentVersion(documentId);
    }

    const existingBlocks = await this.listDocumentBlocks(documentId);
    const root = existingBlocks.find((block) => block.block_id === documentId || block.page);
    const rootChildren = root?.children ?? [];
    if (rootChildren.length > 0) await this.deleteDocumentChildren(documentId, rootChildren.length);

    const blocks = (converted.blocks ?? []).map((block) => this.sanitizeConvertedBlock(block));
    const batches = this.splitConvertedBlocks(converted.first_level_block_ids ?? [], blocks);
    const idRelations = new Map<string, string>();
    for (const batch of batches) {
      const created = await this.createDocumentDescendants(
        documentId,
        batch.firstLevelIds,
        batch.blocks
      );
      for (const relation of created.block_id_relations ?? []) {
        if (relation.temporary_block_id && relation.block_id) {
          idRelations.set(relation.temporary_block_id, relation.block_id);
        }
      }
    }

    for (const image of converted.block_id_to_image_urls ?? []) {
      const actualBlockId = idRelations.get(image.block_id);
      const source = imageSources.get(image.image_url);
      if (!actualBlockId || !source) {
        throw new Error(`飞书没有返回图片块映射：${image.image_url}`);
      }
      const mediaToken = await this.uploadDocumentImage(
        documentId,
        actualBlockId,
        source.fileName,
        source.data
      );
      await this.replaceDocumentImage(documentId, actualBlockId, mediaToken);
    }

    return {
      token: documentId,
      modifiedTime: Math.floor(Date.now() / 1000),
      emptyPlaceholder: false
    };
  }

  async downloadMarkdownDocument(
    documentId: string,
    saveMedia: SaveDocxMedia
  ): Promise<ArrayBuffer> {
    const blocks = await this.listDocumentBlocks(documentId);
    const markdown = await documentBlocksToMarkdown(blocks, documentId, saveMedia);
    return new TextEncoder().encode(markdown).buffer;
  }

  async downloadMedia(token: string): Promise<DownloadedMedia> {
    const accessToken = await this.getAccessToken();
    const response = await requestUrl({
      url: `${API_BASE}/drive/v1/medias/${encodeURIComponent(token)}/download`,
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken}` },
      throw: false
    });
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`下载飞书文档素材失败（HTTP ${response.status}）`);
    }
    const contentType = this.headerValue(response.headers, "content-type") ?? "application/octet-stream";
    const disposition = this.headerValue(response.headers, "content-disposition") ?? "";
    const encodedName = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
    const plainName = disposition.match(/filename="?([^";]+)"?/i)?.[1];
    let fileName = encodedName ? decodeURIComponent(encodedName) : (plainName ?? "");
    if (!fileName) fileName = `feishu-${token}${this.extensionForContentType(contentType)}`;
    return { data: response.arrayBuffer, fileName, contentType };
  }

  private async convertMarkdown(content: string): Promise<ConvertDocumentResponse> {
    return this.requestJson<ConvertDocumentResponse>({
      url: `${API_BASE}/docx/v1/documents/blocks/convert`,
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ content_type: "markdown", content })
    });
  }

  private async createDocument(
    title: string,
    folderToken: string
  ): Promise<{ documentId: string; revisionId: number }> {
    await this.throttleMutation();
    const data = await this.requestJson<CreateDocumentResponse>({
      url: `${API_BASE}/docx/v1/documents`,
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ title: title.slice(0, 800) || "未命名笔记", folder_token: folderToken })
    });
    const documentId = data.document?.document_id;
    if (!documentId) throw new Error("飞书没有返回新建在线文档的 ID");
    return { documentId, revisionId: data.document?.revision_id ?? 1 };
  }

  private async createDocumentVersion(documentId: string): Promise<void> {
    await this.throttleMutation();
    const timestamp = new Date().toLocaleString("zh-CN", { hour12: false });
    await this.requestJson<DocumentVersionResponse>({
      url: `${API_BASE}/drive/v1/files/${encodeURIComponent(documentId)}/versions`,
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ name: `Obsidian 同步前 ${timestamp}`, obj_type: "docx" })
    });
  }

  private async listDocumentBlocks(documentId: string): Promise<DocxBlock[]> {
    const blocks: DocxBlock[] = [];
    let pageToken = "";
    do {
      const query = new URLSearchParams({ page_size: "500", document_revision_id: "-1" });
      if (pageToken) query.set("page_token", pageToken);
      const data = await this.requestJson<DocumentBlockListResponse>({
        url: `${API_BASE}/docx/v1/documents/${encodeURIComponent(documentId)}/blocks?${query.toString()}`,
        method: "GET"
      });
      blocks.push(...(data.items ?? []));
      pageToken = data.has_more ? (data.page_token ?? "") : "";
    } while (pageToken);
    return blocks;
  }

  private async deleteDocumentChildren(documentId: string, childCount: number): Promise<void> {
    await this.throttleMutation();
    await this.requestJson<Record<string, unknown>>({
      url: `${API_BASE}/docx/v1/documents/${encodeURIComponent(documentId)}/blocks/${encodeURIComponent(documentId)}/children/batch_delete`,
      method: "DELETE",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ start_index: 0, end_index: childCount })
    });
  }

  private async createDocumentDescendants(
    documentId: string,
    firstLevelIds: string[],
    blocks: DocxBlock[]
  ): Promise<CreateDescendantResponse> {
    if (blocks.length === 0) return {};
    await this.throttleMutation();
    return this.requestJson<CreateDescendantResponse>({
      url: `${API_BASE}/docx/v1/documents/${encodeURIComponent(documentId)}/blocks/${encodeURIComponent(documentId)}/descendant`,
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ index: -1, children_id: firstLevelIds, descendants: blocks })
    });
  }

  private splitConvertedBlocks(
    firstLevelIds: string[],
    blocks: DocxBlock[]
  ): Array<{ firstLevelIds: string[]; blocks: DocxBlock[] }> {
    if (blocks.length === 0) return [];
    const byId = new Map(blocks.flatMap((block) => block.block_id ? [[block.block_id, block] as const] : []));
    const subtree = (rootId: string): Set<string> => {
      const ids = new Set<string>();
      const visit = (id: string): void => {
        if (ids.has(id)) return;
        ids.add(id);
        for (const child of byId.get(id)?.children ?? []) visit(child);
      };
      visit(rootId);
      return ids;
    };
    const groups: Array<{ roots: string[]; ids: Set<string> }> = [];
    let current = { roots: [] as string[], ids: new Set<string>() };
    for (const rootId of firstLevelIds) {
      const ids = subtree(rootId);
      if (ids.size > 1000) throw new Error(`单个 Markdown 内容树超过飞书单次 1000 块限制：${rootId}`);
      if (current.ids.size > 0 && current.ids.size + ids.size > 1000) {
        groups.push(current);
        current = { roots: [], ids: new Set<string>() };
      }
      current.roots.push(rootId);
      for (const id of ids) current.ids.add(id);
    }
    if (current.ids.size > 0) groups.push(current);
    return groups.map((group) => ({
      firstLevelIds: group.roots,
      blocks: blocks.filter((block) => block.block_id && group.ids.has(block.block_id))
    }));
  }

  private sanitizeConvertedBlock(block: DocxBlock): DocxBlock {
    const sanitized = JSON.parse(JSON.stringify(block)) as DocxBlock;
    delete sanitized.parent_id;
    delete sanitized.comment_ids;
    const table = sanitized.table as Record<string, unknown> | undefined;
    if (table) {
      delete table.merge_info;
      const property = table.property as Record<string, unknown> | undefined;
      if (property) delete property.merge_info;
    }
    return sanitized;
  }

  private async loadImageSource(
    imageUrl: string,
    localImages: Map<string, LocalImageAsset>
  ): Promise<{ fileName: string; data: ArrayBuffer }> {
    const local = localImages.get(imageUrl);
    if (local) return { fileName: local.fileName, data: local.data };
    try {
      const parsed = new URL(imageUrl);
      if (parsed.hostname === "obsidian.local") {
        const path = normalizeVaultPath(decodeURIComponent(parsed.pathname.replace(/^\//, "")));
        const matched = [...localImages.values()].find((asset) => normalizeVaultPath(asset.path) === path);
        if (matched) return { fileName: matched.fileName, data: matched.data };
      }
    } catch { /* continue with other supported URL forms */ }
    if (imageUrl.startsWith("data:")) {
      const match = imageUrl.match(/^data:([^;,]+)?(;base64)?,(.*)$/s);
      if (!match) throw new Error("Markdown 中的 data 图片格式无效");
      const decoded = match[2]
        ? Uint8Array.from(atob(match[3]), (char) => char.charCodeAt(0))
        : new TextEncoder().encode(decodeURIComponent(match[3]));
      return { fileName: `embedded${this.extensionForContentType(match[1] ?? "image/png")}`, data: toArrayBuffer(decoded) };
    }
    if (!/^https?:\/\//i.test(imageUrl)) throw new Error(`不支持的图片地址：${imageUrl}`);
    const response = await requestUrl({ url: imageUrl, method: "GET", throw: false });
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`下载 Markdown 外链图片失败（HTTP ${response.status}）：${imageUrl}`);
    }
    const contentType = this.headerValue(response.headers, "content-type") ?? "image/png";
    let fileName = "";
    try { fileName = decodeURIComponent(new URL(imageUrl).pathname.split("/").pop() ?? ""); } catch { /* use fallback */ }
    return {
      fileName: fileName || `external${this.extensionForContentType(contentType)}`,
      data: response.arrayBuffer
    };
  }

  private async uploadDocumentImage(
    documentId: string,
    blockId: string,
    fileName: string,
    source: ArrayBuffer
  ): Promise<string> {
    const bytes = new Uint8Array(source);
    const fields = {
      file_name: fileName,
      parent_type: "docx_image",
      parent_node: blockId,
      size: String(bytes.byteLength),
      extra: JSON.stringify({ drive_route_token: documentId })
    };
    if (bytes.byteLength > SIMPLE_UPLOAD_LIMIT) {
      return this.uploadMediaMultipart(fileName, bytes, fields);
    }
    await this.throttleMutation();
    const boundary = `----ObsidianFeishuImage${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
    const body = this.buildMultipart(boundary, fields, fileName, bytes);
    const data = await this.requestJson<UploadResponse>({
      url: `${API_BASE}/drive/v1/medias/upload_all`,
      method: "POST",
      headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
      body: toArrayBuffer(body)
    });
    return data.file_token;
  }

  private async uploadMediaMultipart(
    fileName: string,
    bytes: Uint8Array,
    fields: Record<string, string>
  ): Promise<string> {
    await this.throttleMutation();
    const prepared = await this.requestJson<PrepareUploadResponse>({
      url: `${API_BASE}/drive/v1/medias/upload_prepare`,
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ ...fields, size: bytes.byteLength })
    });
    if (!prepared.upload_id || prepared.block_size <= 0 || prepared.block_num <= 0) {
      throw new Error(`飞书没有返回有效的图片分片策略：${fileName}`);
    }
    for (let sequence = 0; sequence < prepared.block_num; sequence += 1) {
      const start = sequence * prepared.block_size;
      const part = bytes.subarray(start, Math.min(bytes.byteLength, start + prepared.block_size));
      await this.throttleMutation();
      const boundary = `----ObsidianFeishuMedia${Date.now().toString(16)}${sequence}`;
      const body = this.buildMultipart(boundary, {
        upload_id: prepared.upload_id,
        seq: String(sequence),
        size: String(part.byteLength)
      }, fileName, part);
      await this.requestJson<Record<string, never>>({
        url: `${API_BASE}/drive/v1/medias/upload_part`,
        method: "POST",
        headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
        body: toArrayBuffer(body)
      });
    }
    await this.throttleMutation();
    const finished = await this.requestJson<UploadResponse>({
      url: `${API_BASE}/drive/v1/medias/upload_finish`,
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ upload_id: prepared.upload_id, block_num: prepared.block_num })
    });
    return finished.file_token;
  }

  private async replaceDocumentImage(documentId: string, blockId: string, token: string): Promise<void> {
    await this.throttleMutation();
    await this.requestJson<Record<string, unknown>>({
      url: `${API_BASE}/docx/v1/documents/${encodeURIComponent(documentId)}/blocks/${encodeURIComponent(blockId)}`,
      method: "PATCH",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ replace_image: { token } })
    });
  }

  private extensionForContentType(contentType: string): string {
    const clean = contentType.split(";", 1)[0].trim().toLowerCase();
    const extensions: Record<string, string> = {
      "image/jpeg": ".jpg",
      "image/png": ".png",
      "image/gif": ".gif",
      "image/webp": ".webp",
      "image/bmp": ".bmp",
      "image/svg+xml": ".svg",
      "application/pdf": ".pdf"
    };
    return extensions[clean] ?? "";
  }

  private headerValue(headers: Record<string, string>, name: string): string | undefined {
    const target = name.toLowerCase();
    for (const [key, value] of Object.entries(headers)) {
      if (key.toLowerCase() === target) return value;
    }
    return undefined;
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
    if (elapsed < 350) {
      await new Promise((resolve) => window.setTimeout(resolve, 350 - elapsed));
    }
    this.lastMutationAt = Date.now();
  }
}
