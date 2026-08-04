import type { AxiosAdapter, AxiosRequestHeaders } from "axios";
import { requestUrl } from "obsidian";

function serializeHeaders(headers: AxiosRequestHeaders): Record<string, string> {
  const serialized: Record<string, string> = {};
  const values = typeof headers.toJSON === "function" ? headers.toJSON() : headers;
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined || value === null || value === false) continue;
    serialized[name] = Array.isArray(value) ? value.join(", ") : String(value);
  }
  return serialized;
}

function serializeBody(data: unknown): string | ArrayBuffer | undefined {
  if (data === undefined || data === null) return undefined;
  if (typeof data === "string" || data instanceof ArrayBuffer) return data;
  if (ArrayBuffer.isView(data)) {
    return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
  }
  return JSON.stringify(data);
}

export const obsidianRequestAdapter: AxiosAdapter = async (config) => {
  if (!config.url) throw new Error("Feishu request is missing a URL");
  if (config.signal?.aborted) throw new Error("Feishu request was aborted");

  const response = await requestUrl({
    url: config.url,
    method: config.method?.toUpperCase() ?? "GET",
    headers: serializeHeaders(config.headers),
    body: serializeBody(config.data),
    throw: false
  });

  if (config.signal?.aborted) throw new Error("Feishu request was aborted");

  return {
    data: config.responseType === "arraybuffer" ? response.arrayBuffer : response.text,
    status: response.status,
    statusText: "",
    headers: response.headers,
    config,
    request: null
  };
};
