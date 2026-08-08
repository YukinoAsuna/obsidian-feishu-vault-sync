export type SyncDirection = "push" | "bidirectional";
export type MarkdownSyncMode = "file" | "docx";

export interface FeishuSyncSettings {
  appId: string;
  appSecret: string;
  rootFolderToken: string;
  remoteFolderPath: string;
  localVaultPath: string;
  userOpenId: string;
  connectedAt: number;
  direction: SyncDirection;
  markdownMode: MarkdownSyncMode;
  createDocxVersions: boolean;
  docxAttachmentFolder: string;
  intervalMinutes: number;
  autoSyncEnabled: boolean;
  syncOnSave: boolean;
  syncOnStartup: boolean;
  propagateDeletions: boolean;
  excludedPatterns: string[];
}

export interface SyncEntry {
  remoteToken: string;
  remoteType?: string;
  remoteModifiedTime: number;
  localHash: string;
  localMtime: number;
  size: number;
  emptyPlaceholder?: boolean;
}

export interface SyncFailure {
  path: string;
  message: string;
}

export interface SyncRunReport {
  startedAt: number;
  finishedAt: number;
  successfulPaths: string[];
  failures: SyncFailure[];
}

export interface SyncState {
  version: 3;
  lastSyncAt: number;
  entries: Record<string, SyncEntry>;
  disabledPaths: string[];
  fileFailures: Record<string, string>;
  lastRun?: SyncRunReport;
}

export interface PluginData {
  settings: FeishuSyncSettings;
  state: SyncState;
}

export interface RemoteNode {
  name: string;
  token: string;
  type: string;
  parentToken: string;
  modifiedTime: number;
}

export interface RemoteTree {
  folders: Map<string, RemoteNode>;
  files: Map<string, RemoteNode>;
  duplicates: Map<string, RemoteNode[]>;
  unsupported: Map<string, RemoteNode>;
}

export interface SyncStats {
  uploaded: number;
  downloaded: number;
  deletedRemote: number;
  deletedLocal: number;
  conflicts: number;
  skipped: number;
  errors: string[];
  successfulPaths: string[];
  failures: SyncFailure[];
  startedAt: number;
  finishedAt: number;
}

export const DEFAULT_SETTINGS: FeishuSyncSettings = {
  appId: "",
  appSecret: "",
  rootFolderToken: "",
  remoteFolderPath: "",
  localVaultPath: "",
  userOpenId: "",
  connectedAt: 0,
  direction: "push",
  markdownMode: "file",
  createDocxVersions: true,
  docxAttachmentFolder: "Feishu Attachments",
  intervalMinutes: 30,
  autoSyncEnabled: true,
  syncOnSave: true,
  syncOnStartup: true,
  propagateDeletions: false,
  excludedPatterns: [
    ".obsidian/**",
    ".trash/**",
    ".git/**",
    "node_modules/**"
  ]
};

export const DEFAULT_STATE: SyncState = {
  version: 3,
  lastSyncAt: 0,
  entries: {},
  disabledPaths: [],
  fileFailures: {}
};
