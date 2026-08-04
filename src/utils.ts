import { normalizePath } from "obsidian";

export function normalizeVaultPath(path: string): string {
  const stripped = path.trim().replace(/^\/+|\/+$/g, "");
  if (!stripped || stripped === ".") return "";
  const normalized = normalizePath(stripped);
  return normalized === "." || normalized === "/" ? "" : normalized;
}

export function parentPath(path: string): string {
  const normalized = normalizeVaultPath(path);
  const index = normalized.lastIndexOf("/");
  return index < 0 ? "" : normalized.slice(0, index);
}

export function baseName(path: string): string {
  const normalized = normalizeVaultPath(path);
  const index = normalized.lastIndexOf("/");
  return index < 0 ? normalized : normalized.slice(index + 1);
}

export function joinPath(...parts: string[]): string {
  return normalizeVaultPath(parts.filter(Boolean).join("/"));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}

export function globToRegExp(pattern: string): RegExp {
  const normalized = normalizeVaultPath(pattern.trim());
  let source = "";
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    const next = normalized[index + 1];
    if (char === "*" && next === "*") {
      source += ".*";
      index += 1;
    } else if (char === "*") {
      source += "[^/]*";
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += escapeRegExp(char);
    }
  }
  return new RegExp(`^${source}$`, "i");
}

export function isExcluded(path: string, patterns: string[]): boolean {
  const normalized = normalizeVaultPath(path);
  return patterns.some((pattern) => {
    const trimmed = pattern.trim();
    if (!trimmed) return false;
    const normalizedPattern = normalizeVaultPath(trimmed);
    if (normalizedPattern.endsWith("/**")) {
      const root = normalizedPattern.slice(0, -3);
      if (normalized === root || normalized.startsWith(`${root}/`)) return true;
    }
    return globToRegExp(normalizedPattern).test(normalized);
  });
}

export async function sha256(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function formatTimestamp(timestamp: number): string {
  return new Date(timestamp)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
}

export function conflictPath(path: string, timestamp: number): string {
  const folder = parentPath(path);
  const name = baseName(path);
  const dot = name.lastIndexOf(".");
  const suffix = `.conflict-feishu-${formatTimestamp(timestamp)}`;
  const conflictName = dot > 0
    ? `${name.slice(0, dot)}${suffix}${name.slice(dot)}`
    : `${name}${suffix}`;
  return joinPath(folder, conflictName);
}

export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
