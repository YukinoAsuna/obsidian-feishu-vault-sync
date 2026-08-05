export type SyncDirection = "push" | "bidirectional";

export interface FeishuSyncSettings {
  appId: string;
  appSecret: string;
  rootFolderToken: string;
  userOpenId: string;
  connectedAt: number;
  direction: SyncDirection;
  intervalMinutes: number;
  syncOnStartup: boolean;
  propagateDeletions: boolean;
  excludedPatterns: string[];
}

export interface SyncEntry {
  remoteToken: string;
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
  version: 2;
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
  userOpenId: "",
  connectedAt: 0,
  direction: "push",
  intervalMinutes: 30,
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
  version: 2,
  lastSyncAt: 0,
  entries: {},
  disabledPaths: [],
  fileFailures: {}
};
