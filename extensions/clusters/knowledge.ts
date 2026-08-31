/**
 * knowledge 工作集群（DESIGN.md §3/§5）：统一检索层 + 内容抓取 + 问答护栏。
 *
 * 数据源（knowledge.json 声明，白名单）：
 * - base：多维表格 → +record-search / +record-get（返回 record_id_list + fields）
 * - wiki：知识空间 → +node-list（标题匹配）/ +node-get 解析 → docs +fetch
 * - doc：云文档 → drive +search（data.results）/ docs +fetch（data.document.content）
 *
 * 安全：sourceId 必须已登记；未登记的源一律拒绝（requireRegisteredSource）。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { runLark, describeLarkError, runtimeIdentity } from "../core/lark.ts";
import { getSource, listSources, validateSource } from "../core/knowledge.ts";
import { requireCluster, policyRules } from "../core/safety.ts";
import { okResult, errResult } from "../core/tools.ts";
import { parseBaseResult, fieldNameMap } from "../core/base.ts";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";

const MAX_FETCH_CHARS = 14_000;

/** 判断源是否配置占位符（未填真实标识，不应检索） */
function sourcePlaceholder(s: any): boolean {
  const v = s.type === "base" ? s.baseToken : s.type === "wiki" ? s.spaceId : s.type === "doc" ? s.url : "";
  return !v || /replac/i.test(String(v));
}

function truncate(text: string, max = MAX_FETCH_CHARS): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + `\n…（内容过长已截断，共 ${text.length} 字符）`;
}

function stripHtml(s: string): string {
  return s.replace(/<[^>]+>/g, "").trim();
}

export function registerKnowledge(pi: ExtensionAPI): void {
  // ---------------------------------------------------------------
  // coworker_knowledge_search —— 统一检索
  // ---------------------------------------------------------------
  pi.registerTool({
    name: "coworker_knowledge_search",
    label: "Coworker 知识检索",
    description:
      "在企业已登记的知识源（公司百科 Base / 制度 Wiki / FAQ 文档等）中检索。返回候选条目与定位信息，再用 coworker_knowledge_fetch 抓取全文。只能检索 knowledge.json 中登记过的源。",
    parameters: Type.Object({
      query: Type.String({ description: "检索关键词（≤30 字）" }),
      sourceId: Type.Optional(Type.String({ description: "指定知识源 id（knowledge.json 中登记）；不传则检索全部源" })),
      limit: Type.Optional(Type.Integer({ description: "每源返回条数（默认 5，最大 10）" })),
    }),
    async execute(_id, params) {
      const gate = requireCluster("knowledge");
      if (gate) return errResult(gate);

      const rules = policyRules();
      const query = String(params.query ?? "").trim().slice(0, 30);
      if (!query) return errResult("query 不能为空。");

      const limit = Math.min(Math.max(params.limit ?? 5, 1), 10);

      // 白名单校验
      let sources = listSources();
      if (params.sourceId) {
        const src = getSource(params.sourceId);
        if (!src) {
          return errResult(
            rules.requireRegisteredSource
              ? `知识源「${params.sourceId}」未登记（knowledge.json 白名单）。可用 coworker_knowledge_search 不带 sourceId 检索全部已登记源。`
              : `知识源「${params.sourceId}」不存在。`,
            { registered: false },
          );
        }
        sources = [src];
      }
      // 占位符（未配置真实标识）的源不中止检索，仅标记跳过；真正的配置缺失才报错
      const invalid = sources.flatMap((s) => validateSource(s)).filter((x) => !/尚未配置/.test(x));
      if (invalid.length > 0) {
        return errResult(`知识源配置不完整：${invalid.join("；")}。请联系管理员修复 knowledge.json。`, { issues: invalid });
      }

      const lines: string[] = [];
      const results: any[] = [];
      for (const src of sources) {
        if (sourcePlaceholder(src)) {
          lines.push(`⚙️ 源「${src.name}」：尚未配置（占位符），已跳过，可在知识库配置真实标识后使用。`);
          continue;
        }
        let found: any[] = [];
        try {
          if (src.type === "base") found = await searchBase(src, query, limit);
          else if (src.type === "wiki") found = await searchWiki(src, query, limit);
          else if (src.type === "doc") found = await searchDoc(src, query, limit);
        } catch (e: any) {
          lines.push(`⚠️ 源「${src.name}」检索出错：${e?.message ?? e}`);
          continue;
        }
        results.push({ sourceId: src.id, sourceName: src.name, hits: found });
        if (found.length === 0) {
          lines.push(`📦 ${src.name}（${src.id}）：无匹配`);
          continue;
        }
        lines.push(`📦 ${src.name}（${src.id}）：`);
        for (const hit of found) {
          lines.push(`  • ${hit.title ?? "?"}（${hit.locator}）${hit.snippet ? `\n    ${hit.snippet}` : ""}`);
        }
      }

      if (results.every((r) => r.hits.length === 0)) {
        lines.push("", "未检索到相关条目。可换关键词，或确认你的知识源访问权限（coworker_perm_check / coworker_perm_apply）。");
      } else {
        lines.push("", "用 coworker_knowledge_fetch（sourceId + locator）抓取候选内容后作答。");
      }
      return okResult(lines.join("\n"), { results });
    },
  });

  // ---------------------------------------------------------------
  // coworker_knowledge_fetch —— 抓取内容
  // ---------------------------------------------------------------
  pi.registerTool({
    name: "coworker_knowledge_fetch",
    label: "Coworker 知识抓取",
    description:
      "抓取指定知识源中的一条内容用于作答：base 源传 record_id；wiki 源传 node_token；doc 源传文档 URL 或 token。只能抓取已登记知识源。",
    parameters: Type.Object({
      sourceId: Type.String({ description: "知识源 id（coworker_knowledge_search 返回的 sourceId）" }),
      locator: Type.String({ description: "条目定位：record_id（base）/ node_token（wiki）/ 文档 URL 或 token（doc）" }),
      format: Type.Optional(Type.String({ description: "文档输出格式（doc/wiki 源）：markdown（默认）或 xml" })),
    }),
    async execute(_id, params) {
      const gate = requireCluster("knowledge");
      if (gate) return errResult(gate);

      const src = getSource(params.sourceId);
      if (!src) {
        return errResult(`知识源「${params.sourceId}」未登记，拒绝访问。`, { registered: false });
      }
      const docFormat = params.format === "xml" ? "xml" : "markdown";

      try {
        if (src.type === "base") return await fetchBase(src, params.locator);
        if (src.type === "wiki") return await fetchWiki(src, params.locator, docFormat);
        if (src.type === "doc") return await fetchDoc(src, params.locator, docFormat);
        return errResult(`未知知识源类型：${src.type}`);
      } catch (e: any) {
        return errResult(`抓取失败：${e?.message ?? e}`);
      }
    },
  });
}

// ================= base 源 =================

async function searchBase(src: any, query: string, limit: number): Promise<any[]> {
  const baseToken = src.baseToken;
  const table = src.table;
  const { idToName } = await fieldNameMap(baseToken, table);
  let searchFields = Array.isArray(src.searchFields) ? src.searchFields : [];
  if (searchFields.length === 0) searchFields = Object.values(idToName).slice(0, 5);

  const args = [
    "base", "+record-search",
    "--base-token", baseToken,
    "--table-id", table,
    "--keyword", query,
    ...searchFields.flatMap((f: string) => ["--search-field", f]),
    "--limit", String(limit),
    "--format", "json",
    "--as", runtimeIdentity(),
  ];
  const r = await runLark(args, { timeoutMs: 90_000 });
  if (!r.ok) throw new Error(describeLarkError(r));
  return parseBaseResult(r.envelope).slice(0, limit).map((rec) => {
    const title = rec.values.find((v) => v.value)?.value ?? rec.record_id;
    const snippet = rec.values
      .slice(0, 3)
      .map((v) => `${idToName[v.fieldId] ?? v.fieldId}: ${String(v.value).slice(0, 80)}`)
      .filter((s) => s && !s.endsWith(": "))
      .join(" | ");
    return { title: title.slice(0, 120), locator: rec.record_id, snippet };
  });
}

async function fetchBase(src: any, recordId: string): Promise<{ content: { type: "text"; text: string }[]; details: Record<string, unknown> }> {
  const r = await runLark(
    ["base", "+record-get", "--base-token", src.baseToken, "--table-id", src.table, "--record-id", recordId, "--format", "json"],
    { as: runtimeIdentity(), timeoutMs: 60_000 },
  );
  if (!r.ok) return errResult(`读取记录失败：${describeLarkError(r)}`, {});
  const rec = parseBaseResult(r.envelope)[0];
  if (!rec) return errResult("记录不存在或已删除。", {});
  const { idToName } = await fieldNameMap(src.baseToken, src.table);
  const lines = [
    `【${src.name}】记录 ${recordId}`,
    ...rec.values.map((v) => `${idToName[v.fieldId] ?? v.fieldId}: ${v.value}`),
  ];
  return okResult(truncate(lines.join("\n")), { sourceId: src.id, recordId });
}

// ================= wiki 源 =================

async function searchWiki(src: any, query: string, limit: number): Promise<any[]> {
  const hits: any[] = [];
  // 1) 空间内根节点标题匹配（限定 scope）
  const r = await runLark(["wiki", "+node-list", "--space-id", src.spaceId, "--page-all", "--format", "json"], {
    as: runtimeIdentity(),
    timeoutMs: 120_000,
  });
  if (!r.ok) throw new Error(describeLarkError(r));
  const nodes: any[] = r.envelope?.data?.nodes ?? r.envelope?.data?.items ?? [];
  const q = query.toLowerCase();
  for (const n of nodes) {
    if (hits.length >= limit) break;
    if (String(n.title ?? "").toLowerCase().includes(q)) {
      hits.push({ title: n.title, locator: n.node_token, snippet: `类型: ${n.obj_type ?? "?"}` });
    }
  }
  // 2) 不足时用 drive 全量检索召回（覆盖深层/嵌套文档）
  if (hits.length < limit) {
    const ds = await runLark(
      ["drive", "+search", "--query", query, "--page-size", String(Math.min(limit * 2, 15)), "--format", "json"],
      { as: runtimeIdentity(), timeoutMs: 60_000 },
    );
    if (ds.ok) {
      const items: any[] = ds.envelope?.data?.results ?? [];
      for (const it of items) {
        if (hits.length >= limit) break;
        const url = it.result_meta?.url;
        if (!url) continue;
        const locator = hits.some((h) => h.locator === url) ? null : url;
        if (!locator) continue;
        hits.push({
          title: stripHtml(it.title_highlighted ?? it.title ?? "?").slice(0, 120),
          locator: url,
          snippet: `类型: ${it.entity_type ?? it.result_meta?.doc_types ?? "?"}`,
        });
      }
    }
  }
  return hits.slice(0, limit);
}

async function fetchWiki(src: any, locator: string, docFormat: string): Promise<{ content: { type: "text"; text: string }[]; details: Record<string, unknown> }> {
  // 兼容：wiki 节点 token / wiki URL / 文档 URL / 裸 obj_token
  if (/^https?:\/\//.test(locator)) {
    if (locator.includes("/wiki/")) {
      // wiki URL → 解析到底层对象
      const resolved = await runLark(["wiki", "+node-get", "--node-token", locator, "--as", runtimeIdentity()], { timeoutMs: 60_000 });
      if (!resolved.ok) return errResult(`解析 wiki 节点失败：${describeLarkError(resolved)}`, {});
      const node = resolved.envelope?.data ?? {};
      const objToken = node.obj_token;
      const objType = node.obj_type ?? "?";
      if (!objToken) return errResult("节点没有底层对象（obj_token 为空）。", {});
      if (objType === "docx" || objType === "doc" || objType === "mindnote") {
        return await fetchDocContent(src, objToken, node.title ?? locator, docFormat, node.node_token ?? locator);
      }
      if (objType === "file" || objType === "pdf") {
        return await fetchFileContent(src, objToken, node.title ?? locator, node.node_token ?? locator);
      }
      if (objType === "bitable") {
        return await fetchBitableContent(src, objToken, node.title ?? locator, node.node_token ?? locator);
      }
      if (objType === "sheet") {
        return await fetchSheetContent(src, objToken, node.title ?? locator, node.node_token ?? locator);
      }
      return okResult(
        `wiki 节点「${node.title ?? locator}」底层是 ${objType}，不支持全文抓取。` +
          `（请打开链接查看）`,
        { sourceId: src.id, objType, nodeToken: node.node_token, objToken },
      );
    }
    // 普通文档 URL → 直接抓取
    return await fetchDocContent(src, locator, src.name, docFormat);
  }
  // 裸 token：先当 wiki 节点解析，失败再当文档 token 抓取
  const resolved = await runLark(["wiki", "+node-get", "--node-token", locator, "--as", runtimeIdentity()], { timeoutMs: 60_000 });
  if (resolved.ok) {
    const node = resolved.envelope?.data ?? {};
    const objToken = node.obj_token;
    const objType = node.obj_type ?? "?";
    if (objToken && (objType === "docx" || objType === "doc" || objType === "mindnote")) {
      return await fetchDocContent(src, objToken, node.title ?? locator, docFormat, locator);
    }
    if (objToken && (objType === "file" || objType === "pdf")) {
      return await fetchFileContent(src, objToken, node.title ?? locator, locator);
    }
    if (objToken && objType === "bitable") {
      return await fetchBitableContent(src, objToken, node.title ?? locator, locator);
    }
    if (objToken && objType === "sheet") {
      return await fetchSheetContent(src, objToken, node.title ?? locator, locator);
    }
    if (objToken) {
      return okResult(
        `wiki 节点「${node.title ?? locator}」底层是 ${objType}，不支持全文抓取。` +
          `（请打开链接查看）`,
        { sourceId: src.id, objType, nodeToken: locator, objToken },
      );
    }
  }
  return await fetchDocContent(src, locator, src.name, docFormat);
}

// ================= doc 源 =================

async function searchDoc(src: any, query: string, limit: number): Promise<any[]> {
  const r = await runLark(
    ["drive", "+search", "--query", query, "--doc-types", "docx,doc", "--page-size", String(Math.min(limit, 10)), "--format", "json"],
    { as: runtimeIdentity(), timeoutMs: 60_000 },
  );
  if (!r.ok) throw new Error(describeLarkError(r));
  const items: any[] = r.envelope?.data?.results ?? [];
  return items.slice(0, limit).map((it) => ({
    title: stripHtml(it.title_highlighted ?? it.title ?? "?").slice(0, 120),
    locator: it.result_meta?.url ?? it.url,
    snippet: `类型: ${it.entity_type ?? it.result_meta?.doc_types ?? "?"}`,
  }));
}

async function fetchDoc(src: any, locator: string, docFormat: string): Promise<{ content: { type: "text"; text: string }[]; details: Record<string, unknown> }> {
  return fetchDocContent(src, locator, src.name, docFormat);
}

/** 抓取 wiki 附件（PDF/文件）：下载 + pdftotext 转文本 */
let _pdftotext: string | undefined;
function pdftotextBin(): string {
  if (_pdftotext !== undefined) return _pdftotext;
  const cands = ["/opt/homebrew/bin/pdftotext", "/usr/local/bin/pdftotext", "/usr/bin/pdftotext"];
  for (const c of cands) {
    try { if (require("node:fs").existsSync(c)) return (_pdftotext = c); } catch { /* ignore */ }
  }
  _pdftotext = "pdftotext"; // 回退 PATH
  return _pdftotext;
}

async function fetchFileContent(src: any, objToken: string, title: string, viaToken?: string): Promise<{ content: { type: "text"; text: string }[]; details: Record<string, unknown> }> {
  const tmp = join(tmpdir(), `kw-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.bin`);
  try {
    const dl = await runLark(["drive", "+download", "--file-token", objToken, "--output", tmp, "--as", runtimeIdentity()], { timeoutMs: 90_000 });
    if (!dl.ok) return errResult(`下载附件失败：${describeLarkError(dl)}`, {});
    const txt = spawnSync(pdftotextBin(), [tmp, "-"], { encoding: "utf8", timeout: 60_000 });
    const content = (txt.stdout || txt.stderr || "").trim();
    if (!content) return errResult("PDF 未能提取文本（可能为扫描件，需 OCR）。", { objType: "file", objToken });
    const head = `【${src.name}】${title}\n来源: ${viaToken ? `wiki 节点 ${viaToken}` : objToken}\n\n`;
    return okResult(truncate(head + content), { sourceId: src.id, objType: "file", objToken, viaToken });
  } finally {
    try { rmSync(tmp, { force: true }); } catch { /* ignore */ }
  }
}

/** 抓取多维表格（bitable）：列所有表 + 读记录，转为文本 */
async function fetchBitableContent(src: any, baseToken: string, title: string, viaToken?: string): Promise<{ content: { type: "text"; text: string }[]; details: Record<string, unknown> }> {
  const tl = await runLark(["base", "+table-list", "--base-token", baseToken, "--format", "json", "--as", runtimeIdentity()], { timeoutMs: 60_000 });
  if (!tl.ok) return errResult(`读取多维表格失败：${describeLarkError(tl)}`, {});
  const tables = tl.envelope?.data?.items ?? tl.envelope?.data?.tables ?? [];
  const lines: string[] = [`【${src.name}】${title}\n来源: ${viaToken ? `wiki 节点 ${viaToken}` : baseToken}\n`];
  let tableCount = 0, recCount = 0;
  for (const t of tables.slice(0, 5)) {
    const tableId = t.table_id || t.tableId;
    const tableName = t.name || tableId;
    if (!tableId) continue;
    const rl = await runLark(["base", "+record-list", "--base-token", baseToken, "--table-id", tableId, "--limit", "60", "--format", "json", "--as", runtimeIdentity()], { timeoutMs: 60_000 });
    if (!rl.ok) continue;
    const items = rl.envelope?.data?.items ?? rl.envelope?.data?.records ?? [];
    if (items.length === 0) continue;
    tableCount++;
    lines.push(`\n【表：${tableName}】（${items.length} 条）`);
    for (const rec of items.slice(0, 40)) {
      const fields: Record<string, any> = {};
      const f = rec.fields ?? rec;
      if (typeof f === "object") {
        for (const [k, v] of Object.entries(f)) {
          const val = Array.isArray(v) ? v.map((x) => x?.text ?? x).join(", ") : v;
          fields[k] = String(val ?? "").slice(0, 120);
        }
      }
      const row = Object.entries(fields).map(([k, v]) => `${k}: ${v}`).join(" ");
      if (row.trim()) { lines.push("• " + row.slice(0, 300)); recCount++; }
    }
    if (recCount >= 120) break;
  }
  if (recCount === 0) return errResult("多维表格无记录或读取失败。", { objType: "bitable", objToken: baseToken });
  return okResult(truncate(lines.join("\n")), { sourceId: src.id, objType: "bitable", objToken: baseToken, viaToken, tableCount });
}

/** 抓取电子表格（sheet）：workbook-info 拿 sub-sheets，cells-get 读区域转文本 */
async function fetchSheetContent(src: any, spreadsheetToken: string, title: string, viaToken?: string): Promise<{ content: { type: "text"; text: string }[]; details: Record<string, unknown> }> {
  const wi = await runLark(["sheets", "+workbook-info", "--spreadsheet-token", spreadsheetToken, "--format", "json", "--as", runtimeIdentity()], { timeoutMs: 60_000 });
  if (!wi.ok) return errResult(`读取电子表格失败：${describeLarkError(wi)}`, {});
  const sheets = wi.envelope?.data?.sheets ?? wi.envelope?.data?.items ?? [];
  const lines: string[] = [`【${src.name}】${title}\n来源: ${viaToken ? `wiki 节点 ${viaToken}` : spreadsheetToken}\n`];
  let cellCount = 0;
  for (const sh of sheets.slice(0, 4)) {
    const sheetId = sh.sheet_id || sh.sheetId;
    const sheetName = sh.title || sheetId;
    if (!sheetId) continue;
    const cg = await runLark(["sheets", "+cells-get", "--spreadsheet-token", spreadsheetToken, "--sheet-id", sheetId, "--range", "A1:Z40", "--format", "json", "--as", runtimeIdentity()], { timeoutMs: 60_000 });
    if (!cg.ok) continue;
    const values: any[][] = cg.envelope?.data?.valueRange?.values ?? cg.envelope?.data?.values ?? [];
    if (!values.length) continue;
    lines.push(`\n【表：${sheetName}】`);
    for (const row of values.slice(0, 40)) {
      const cells = row.map((c) => String(c ?? "").trim()).filter(Boolean);
      if (cells.length) { lines.push("• " + cells.join(" | ").slice(0, 300)); cellCount++; }
    }
    if (cellCount >= 120) break;
  }
  if (cellCount === 0) return errResult("电子表格无内容或读取失败。", { objType: "sheet", objToken: spreadsheetToken });
  return okResult(truncate(lines.join("\n")), { sourceId: src.id, objType: "sheet", objToken: spreadsheetToken, viaToken });
}

async function fetchDocContent(
  src: any,
  docLocator: string,
  title: string,
  docFormat: string,
  viaToken?: string,
): Promise<{ content: { type: "text"; text: string }[]; details: Record<string, unknown> }> {
  const r = await runLark(
    ["docs", "+fetch", "--doc", docLocator, "--doc-format", docFormat, "--detail", "simple", "--as", runtimeIdentity()],
    { timeoutMs: 90_000 },
  );
  if (!r.ok) return errResult(`读取文档失败：${describeLarkError(r)}`, {});
  const content = r.envelope?.data?.document?.content ?? r.envelope?.data?.content ?? "";
  const head = `【${src.name}】${title}\n来源: ${docLocator}${viaToken ? `（wiki 节点 ${viaToken}）` : ""}\n\n`;
  return okResult(truncate(head + content), { sourceId: src.id, locator: docLocator, viaToken });
}
