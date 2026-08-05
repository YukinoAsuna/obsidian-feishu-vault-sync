const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const esbuild = require("esbuild");

class TFile {
  constructor(filePath, text) {
    this.path = filePath;
    this.data = new TextEncoder().encode(text);
    this.stat = { mtime: 1000, size: this.data.byteLength };
  }
}

class TFolder {
  constructor(folderPath) {
    this.path = folderPath;
  }
}

const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === "obsidian") {
    return {
      TFile,
      TFolder,
      requestUrl: (params) => global.__feishuRequestUrl(params),
      normalizePath: (value) => value.replace(/\\/g, "/").replace(/\/{2,}/g, "/")
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

function arrayBuffer(bytes) {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

class MockVault {
  constructor(files = []) {
    this.files = files;
  }

  getFiles() {
    return this.files;
  }

  getAllLoadedFiles() {
    return [];
  }

  async readBinary(file) {
    return arrayBuffer(file.data);
  }

  getAbstractFileByPath(filePath) {
    return this.files.find((file) => file.path === filePath) || null;
  }
}

class MockClient {
  constructor(remoteFiles = new Map()) {
    this.remoteFiles = remoteFiles;
    this.uploaded = [];
    this.deleted = [];
    this.downloaded = [];
  }

  async listTree(rootToken) {
    return {
      folders: new Map([["", {
        name: "",
        token: rootToken,
        type: "folder",
        parentToken: "",
        modifiedTime: 0
      }]]),
      files: new Map(this.remoteFiles),
      duplicates: new Map(),
      unsupported: new Map()
    };
  }

  async replaceFile(name, parentToken, source, previousToken) {
    const token = `token-${this.uploaded.length + 1}`;
    this.uploaded.push({ name, parentToken, source, previousToken, token });
    this.remoteFiles.set(name, {
      name,
      token,
      type: "file",
      parentToken,
      modifiedTime: 2000
    });
    return { token, modifiedTime: 2000, emptyPlaceholder: false };
  }

  async upsertMarkdownDocument(name, parentToken, prepared, previousToken) {
    const token = previousToken || `docx-${this.uploaded.length + 1}`;
    this.uploaded.push({ name, parentToken, prepared, previousToken, token, type: "docx" });
    return { token, modifiedTime: 2000, emptyPlaceholder: false };
  }

  async deleteNode(token) {
    this.deleted.push(token);
    for (const [filePath, node] of this.remoteFiles) {
      if (node.token === token) this.remoteFiles.delete(filePath);
    }
  }

  async downloadFile(token) {
    this.downloaded.push(token);
    return new ArrayBuffer(0);
  }
}

function settings(direction = "push") {
  return {
    appId: "app",
    appSecret: "secret",
    rootFolderToken: "root",
    userOpenId: "user",
    connectedAt: 1,
    direction,
    markdownMode: "file",
    createDocxVersions: true,
    docxAttachmentFolder: "Feishu Attachments",
    intervalMinutes: 30,
    autoSyncEnabled: true,
    syncOnSave: true,
    syncOnStartup: true,
    propagateDeletions: false,
    excludedPatterns: []
  };
}

function state(disabledPaths = []) {
  return {
    version: 3,
    lastSyncAt: 0,
    entries: {},
    disabledPaths,
    fileFailures: {}
  };
}

async function run() {
  const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "feishu-vault-sync-test-"));
  const bundlePath = path.join(tempDirectory, "sync-engine.cjs");
  esbuild.buildSync({
    entryPoints: [path.join(__dirname, "..", "src", "sync-engine.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    external: ["obsidian"],
    outfile: bundlePath,
    logLevel: "silent"
  });
  const { SyncEngine } = require(bundlePath);

  const markdownBundlePath = path.join(tempDirectory, "markdown-docx.cjs");
  esbuild.buildSync({
    entryPoints: [path.join(__dirname, "..", "src", "markdown-docx.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    external: ["obsidian"],
    outfile: markdownBundlePath,
    logLevel: "silent"
  });
  const { prepareMarkdownForDocx, documentBlocksToMarkdown } = require(markdownBundlePath);

  const preparedMarkdown = await prepareMarkdownForDocx(
    "# 图文\n\n![[assets/图片.png|600]]\n\n```md\n![[assets/图片.png]]\n```",
    "notes/test.md",
    async (linkPath) => linkPath === "assets/图片.png" ? {
      path: "assets/图片.png",
      fileName: "图片.png",
      data: new Uint8Array([1, 2, 3]).buffer
    } : undefined
  );
  assert.match(preparedMarkdown.content, /https:\/\/obsidian\.local\//);
  assert.match(preparedMarkdown.content, /```md\n!\[\[assets\/图片\.png\]\]\n```/);
  assert.equal(preparedMarkdown.images.size, 1);

  const restoredMarkdown = await documentBlocksToMarkdown([
    { block_id: "doc", block_type: 1, page: { elements: [] }, children: ["h", "b", "i"] },
    { block_id: "h", parent_id: "doc", block_type: 3, heading1: { elements: [{ text_run: { content: "标题" } }] } },
    { block_id: "b", parent_id: "doc", block_type: 12, bullet: { elements: [{ text_run: { content: "项目" } }] } },
    { block_id: "i", parent_id: "doc", block_type: 27, image: { token: "media-token" } }
  ], "doc", async () => "Feishu Attachments/media.png");
  assert.match(restoredMarkdown, /^# 标题/m);
  assert.match(restoredMarkdown, /^- 项目/m);
  assert.match(restoredMarkdown, /!\[\[Feishu Attachments\/media\.png\]\]/);

  const clientBundlePath = path.join(tempDirectory, "feishu-client.cjs");
  esbuild.buildSync({
    entryPoints: [path.join(__dirname, "..", "src", "feishu-client.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    external: ["obsidian"],
    outfile: clientBundlePath,
    logLevel: "silent"
  });
  global.window = { setTimeout: (callback) => setTimeout(callback, 0) };
  const feishuCalls = [];
  global.__feishuRequestUrl = async (params) => {
    feishuCalls.push(params);
    const success = (data) => ({
      status: 200,
      json: { code: 0, msg: "success", data },
      text: JSON.stringify({ code: 0, msg: "success", data }),
      arrayBuffer: new ArrayBuffer(0),
      headers: {}
    });
    if (params.url.endsWith("/auth/v3/tenant_access_token/internal")) {
      return { ...success({}), json: { code: 0, msg: "success", tenant_access_token: "tenant", expire: 7200 } };
    }
    if (params.url.endsWith("/docx/v1/documents/blocks/convert")) {
      return success({
        first_level_block_ids: ["temp-image"],
        blocks: [{ block_id: "temp-image", block_type: 27, image: {} }],
        block_id_to_image_urls: [{ block_id: "temp-image", image_url: "https://obsidian.local/assets%2Fimage.png" }]
      });
    }
    if (params.url.endsWith("/versions")) return success({ version: "v1" });
    if (params.url.includes("/blocks?") && params.method === "GET") {
      return success({ items: [{ block_id: "existing-doc", block_type: 1, page: { elements: [] }, children: ["old"] }] });
    }
    if (params.url.endsWith("/children/batch_delete")) return success({ document_revision_id: 2 });
    if (params.url.endsWith("/descendant")) {
      return success({ block_id_relations: [{ temporary_block_id: "temp-image", block_id: "real-image" }] });
    }
    if (params.url.endsWith("/drive/v1/medias/upload_all")) return success({ file_token: "media-token" });
    if (params.url.endsWith("/blocks/real-image") && params.method === "PATCH") return success({});
    throw new Error(`Unexpected Feishu request: ${params.method} ${params.url}`);
  };
  const { FeishuClient } = require(clientBundlePath);
  const apiSettings = settings();
  apiSettings.markdownMode = "docx";
  const feishuClient = new FeishuClient(() => apiSettings);
  const updatedDoc = await feishuClient.upsertMarkdownDocument("Note", "root", {
    content: "![image](https://obsidian.local/assets%2Fimage.png)",
    images: new Map([["https://obsidian.local/assets%2Fimage.png", {
      path: "assets/image.png",
      fileName: "image.png",
      data: new Uint8Array([1, 2, 3]).buffer
    }]])
  }, "existing-doc");
  assert.equal(updatedDoc.token, "existing-doc");
  assert.ok(feishuCalls.some((call) => call.url.endsWith("/versions")));
  assert.ok(feishuCalls.some((call) => call.url.endsWith("/children/batch_delete")));
  assert.ok(feishuCalls.some((call) => call.url.endsWith("/drive/v1/medias/upload_all")));
  assert.ok(feishuCalls.some((call) => call.url.endsWith("/blocks/real-image") && call.method === "PATCH"));

  const note = new TFile("note.md", "hello");
  const vault = new MockVault([note]);
  const client = new MockClient();
  const syncState = state(["note.md"]);
  let persisted = 0;
  const engine = new SyncEngine(
    vault,
    client,
    () => settings(),
    syncState,
    async () => { persisted += 1; },
    () => {}
  );

  const selectedStats = await engine.syncSelected(["note.md"]);
  assert.equal(selectedStats.uploaded, 1);
  assert.deepEqual(syncState.disabledPaths, []);
  assert.ok(syncState.entries["note.md"]);
  assert.equal(syncState.fileFailures["note.md"], undefined);

  const cancelStats = await engine.cancelSync(["note.md"]);
  assert.equal(cancelStats.deletedRemote, 1);
  assert.deepEqual(syncState.disabledPaths, ["note.md"]);
  assert.equal(syncState.entries["note.md"], undefined);
  assert.equal(client.deleted.length, 1);
  assert.equal(persisted, 2);

  const blockedRemote = new Map([["blocked.md", {
    name: "blocked.md",
    token: "blocked-token",
    type: "file",
    parentToken: "root",
    modifiedTime: 3000
  }]]);
  const bidirectionalClient = new MockClient(blockedRemote);
  const bidirectionalEngine = new SyncEngine(
    new MockVault(),
    bidirectionalClient,
    () => settings("bidirectional"),
    state(["blocked.md"]),
    async () => {},
    () => {}
  );
  await bidirectionalEngine.sync();
  assert.deepEqual(bidirectionalClient.downloaded, []);

  const disabledPushClient = new MockClient();
  const disabledPushEngine = new SyncEngine(
    vault,
    disabledPushClient,
    () => settings(),
    state(["note.md"]),
    async () => {},
    () => {}
  );
  await disabledPushEngine.sync();
  assert.deepEqual(disabledPushClient.uploaded, []);

  const docxNote = new TFile("docx-note.md", "# 标题\n\n正文");
  const docxClient = new MockClient(new Map([["docx-note.md", {
    name: "docx-note.md",
    token: "legacy-file-token",
    type: "file",
    parentToken: "root",
    modifiedTime: 1000
  }]]));
  const docxSettings = settings();
  docxSettings.markdownMode = "docx";
  const docxEngine = new SyncEngine(
    new MockVault([docxNote]),
    docxClient,
    () => docxSettings,
    state(),
    async () => {},
    () => {}
  );
  const docxStats = await docxEngine.syncSelected(["docx-note.md"]);
  assert.equal(docxStats.uploaded, 1);
  assert.equal(docxClient.uploaded[0].type, "docx");
  assert.equal(docxClient.uploaded[0].name, "docx-note");
  assert.equal(docxClient.uploaded[0].previousToken, undefined);
  assert.match(docxClient.uploaded[0].prepared.content, /# 标题/);

  fs.rmSync(tempDirectory, { recursive: true, force: true });
  console.log("sync-engine tests passed");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
