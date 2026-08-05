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
    intervalMinutes: 30,
    syncOnStartup: true,
    propagateDeletions: false,
    excludedPatterns: []
  };
}

function state(disabledPaths = []) {
  return {
    version: 2,
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

  fs.rmSync(tempDirectory, { recursive: true, force: true });
  console.log("sync-engine tests passed");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
