import { baseName, normalizeVaultPath } from "./utils";

export interface LocalImageAsset {
  path: string;
  fileName: string;
  data: ArrayBuffer;
}

export interface PreparedMarkdown {
  content: string;
  images: Map<string, LocalImageAsset>;
}

export interface DocxTextStyle {
  bold?: boolean;
  italic?: boolean;
  strikethrough?: boolean;
  underline?: boolean;
  inline_code?: boolean;
  link?: { url: string };
}

export interface DocxTextElement {
  text_run?: { content: string; text_element_style?: DocxTextStyle };
  equation?: { content: string; text_element_style?: DocxTextStyle };
  mention_doc?: { title?: string; url?: string; token?: string; text_element_style?: DocxTextStyle };
  mention_user?: { user_id: string; text_element_style?: DocxTextStyle };
  file?: { file_token?: string; name?: string; text_element_style?: DocxTextStyle };
}

export interface DocxTextEntity {
  elements?: DocxTextElement[];
  style?: { done?: boolean; language?: number };
}

export interface DocxBlock {
  block_id?: string;
  parent_id?: string;
  children?: string[];
  block_type: number;
  page?: DocxTextEntity;
  text?: DocxTextEntity;
  heading1?: DocxTextEntity;
  heading2?: DocxTextEntity;
  heading3?: DocxTextEntity;
  heading4?: DocxTextEntity;
  heading5?: DocxTextEntity;
  heading6?: DocxTextEntity;
  heading7?: DocxTextEntity;
  heading8?: DocxTextEntity;
  heading9?: DocxTextEntity;
  bullet?: DocxTextEntity;
  ordered?: DocxTextEntity;
  code?: DocxTextEntity;
  quote?: DocxTextEntity;
  todo?: DocxTextEntity;
  divider?: Record<string, never>;
  image?: { token?: string; caption?: { content?: string } };
  file?: { token?: string; name?: string };
  table?: { cells?: string[]; property?: { row_size?: number; column_size?: number } };
  table_cell?: Record<string, never>;
  [key: string]: unknown;
}

export type ResolveLocalImage = (
  linkPath: string,
  sourcePath: string
) => Promise<LocalImageAsset | undefined>;

export type SaveDocxMedia = (
  token: string,
  kind: "image" | "file",
  suggestedName?: string
) => Promise<string>;

const IMAGE_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "tif", "tiff", "heic", "svg", "avif"
]);

function isImagePath(path: string): boolean {
  const clean = path.split(/[?#]/, 1)[0];
  const dot = clean.lastIndexOf(".");
  return dot >= 0 && IMAGE_EXTENSIONS.has(clean.slice(dot + 1).toLowerCase());
}

function assetUrl(path: string): string {
  return `https://obsidian.local/${encodeURIComponent(normalizeVaultPath(path))}`;
}

function escapeAlt(value: string): string {
  return value.replace(/[\[\]\\]/g, "\\$&");
}

async function replaceAsync(
  value: string,
  pattern: RegExp,
  replacer: (...matches: string[]) => Promise<string>
): Promise<string> {
  const matches = [...value.matchAll(pattern)];
  if (matches.length === 0) return value;
  const replacements = await Promise.all(matches.map((match) => replacer(...match)));
  let result = "";
  let cursor = 0;
  matches.forEach((match, index) => {
    const start = match.index ?? cursor;
    result += value.slice(cursor, start) + replacements[index];
    cursor = start + match[0].length;
  });
  return result + value.slice(cursor);
}

export async function prepareMarkdownForDocx(
  markdown: string,
  sourcePath: string,
  resolveLocalImage: ResolveLocalImage
): Promise<PreparedMarkdown> {
  const images = new Map<string, LocalImageAsset>();
  const lines = markdown.split(/\r?\n/);
  let fence = "";

  for (let index = 0; index < lines.length; index += 1) {
    const fenceMatch = lines[index].match(/^\s*(```+|~~~+)/);
    if (fenceMatch) {
      if (!fence) fence = fenceMatch[1][0];
      else if (fence === fenceMatch[1][0]) fence = "";
      continue;
    }
    if (fence) continue;

    let line = await replaceAsync(
      lines[index],
      /!\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]*))?\]\]/g,
      async (full, rawPath, rawLabel) => {
        const linkPath = rawPath.trim();
        if (!isImagePath(linkPath)) return full;
        const asset = await resolveLocalImage(linkPath, sourcePath);
        if (!asset) throw new Error(`找不到笔记引用的图片：${linkPath}`);
        const url = assetUrl(asset.path);
        images.set(url, asset);
        const label = rawLabel && !/^\d+(?:x\d+)?$/.test(rawLabel.trim())
          ? rawLabel.trim()
          : baseName(asset.path);
        return `![${escapeAlt(label)}](${url})`;
      }
    );

    line = await replaceAsync(
      line,
      /!\[([^\]]*)\]\((<[^>]+>|[^)\s]+)(?:\s+["'][^)]*["'])?\)/g,
      async (full, alt, rawDestination) => {
        const destination = rawDestination.startsWith("<")
          ? rawDestination.slice(1, -1)
          : rawDestination;
        if (/^(?:https?:|data:)/i.test(destination) || !isImagePath(destination)) return full;
        const decoded = (() => {
          try { return decodeURIComponent(destination); } catch { return destination; }
        })();
        const asset = await resolveLocalImage(decoded, sourcePath);
        if (!asset) throw new Error(`找不到笔记引用的图片：${decoded}`);
        const url = assetUrl(asset.path);
        images.set(url, asset);
        return `![${escapeAlt(alt || baseName(asset.path))}](${url})`;
      }
    );
    lines[index] = line;
  }

  return { content: lines.join("\n"), images };
}

function decodeUrl(url: string): string {
  try { return decodeURIComponent(url); } catch { return url; }
}

function wrapStyle(content: string, style?: DocxTextStyle): string {
  if (!style || !content) return content;
  let result = content;
  if (style.link?.url) result = `[${result}](${decodeUrl(style.link.url)})`;
  if (style.inline_code) result = `\`${result.replace(/`/g, "\\`")}\``;
  if (style.bold) result = `**${result}**`;
  if (style.italic) result = `*${result}*`;
  if (style.strikethrough) result = `~~${result}~~`;
  if (style.underline) result = `<u>${result}</u>`;
  return result;
}

function renderElements(entity?: DocxTextEntity): string {
  return (entity?.elements ?? []).map((element) => {
    if (element.text_run) return wrapStyle(element.text_run.content, element.text_run.text_element_style);
    if (element.equation) return wrapStyle(`$${element.equation.content}$`, element.equation.text_element_style);
    if (element.mention_doc) {
      const title = element.mention_doc.title || "飞书文档";
      const url = element.mention_doc.url || `feishu-doc:${element.mention_doc.token ?? ""}`;
      return wrapStyle(`[${title}](${decodeUrl(url)})`, element.mention_doc.text_element_style);
    }
    if (element.mention_user) return wrapStyle(`@${element.mention_user.user_id}`, element.mention_user.text_element_style);
    if (element.file) return wrapStyle(element.file.name || "附件", element.file.text_element_style);
    return "";
  }).join("");
}

function textEntity(block: DocxBlock): { key: string; entity: DocxTextEntity } | undefined {
  const keys = [
    "text", "heading1", "heading2", "heading3", "heading4", "heading5",
    "heading6", "heading7", "heading8", "heading9", "bullet", "ordered",
    "code", "quote", "todo"
  ];
  for (const key of keys) {
    const entity = block[key] as DocxTextEntity | undefined;
    if (entity) return { key, entity };
  }
  return undefined;
}

function indentLines(value: string, depth: number): string {
  const indent = "  ".repeat(depth);
  return value.split("\n").map((line) => `${indent}${line}`).join("\n");
}

export async function documentBlocksToMarkdown(
  blocks: DocxBlock[],
  documentId: string,
  saveMedia: SaveDocxMedia
): Promise<string> {
  const byId = new Map(blocks.flatMap((block) => block.block_id ? [[block.block_id, block] as const] : []));
  const root = byId.get(documentId) ?? blocks.find((block) => block.page);
  const topLevel = root?.children ?? blocks
    .filter((block) => block.parent_id === documentId)
    .flatMap((block) => block.block_id ? [block.block_id] : []);
  const visited = new Set<string>();

  const renderChildren = async (ids: string[], depth: number): Promise<string[]> => {
    const rendered: string[] = [];
    for (const id of ids) {
      if (visited.has(id)) continue;
      visited.add(id);
      const block = byId.get(id);
      if (!block) continue;
      const text = textEntity(block);
      let value = "";

      if (text) {
        const content = renderElements(text.entity);
        if (text.key.startsWith("heading")) {
          const level = Number.parseInt(text.key.slice(7), 10) || 1;
          value = `${"#".repeat(level)} ${content}`;
        } else if (text.key === "bullet") {
          value = `${"  ".repeat(depth)}- ${content}`;
        } else if (text.key === "ordered") {
          value = `${"  ".repeat(depth)}1. ${content}`;
        } else if (text.key === "todo") {
          value = `${"  ".repeat(depth)}- [${text.entity.style?.done ? "x" : " "}] ${content}`;
        } else if (text.key === "quote") {
          value = content.split("\n").map((line) => `> ${line}`).join("\n");
        } else if (text.key === "code") {
          value = `\`\`\`\n${content}\n\`\`\``;
        } else {
          value = content;
        }
      } else if (block.divider) {
        value = "---";
      } else if (block.image?.token) {
        const path = await saveMedia(block.image.token, "image", block.image.caption?.content);
        value = `![[${path}]]`;
        if (block.image.caption?.content) value += `\n*${block.image.caption.content}*`;
      } else if (block.file?.token) {
        const path = await saveMedia(block.file.token, "file", block.file.name);
        value = `[[${path}]]`;
      } else if (block.table) {
        const cells = block.table.cells ?? block.children ?? [];
        const columns = Math.max(1, block.table.property?.column_size ?? cells.length);
        const rows: string[][] = [];
        for (let offset = 0; offset < cells.length; offset += columns) {
          const row: string[] = [];
          for (const cellId of cells.slice(offset, offset + columns)) {
            const cell = byId.get(cellId);
            const parts = await renderChildren(cell?.children ?? [], 0);
            row.push(parts.join("<br>").replace(/\|/g, "\\|"));
          }
          rows.push(row);
        }
        if (rows.length > 0) {
          const width = Math.max(...rows.map((row) => row.length));
          const normalizeRow = (row: string[]): string => `| ${[...row, ...Array<string>(width - row.length).fill("")].join(" | ")} |`;
          value = [normalizeRow(rows[0]), `| ${Array<string>(width).fill("---").join(" | ")} |`, ...rows.slice(1).map(normalizeRow)].join("\n");
        }
      }

      if (value) rendered.push(value);
      if (block.children?.length && !block.table) {
        const childDepth = text && ["bullet", "ordered", "todo"].includes(text.key) ? depth + 1 : depth;
        const children = await renderChildren(block.children, childDepth);
        if (children.length > 0) rendered.push(...children.map((child) => (
          text && ["bullet", "ordered", "todo"].includes(text.key) ? child : indentLines(child, 0)
        )));
      }
    }
    return rendered;
  };

  const result = await renderChildren(topLevel, 0);
  return `${result.join("\n\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}
