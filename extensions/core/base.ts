/**
 * Base（多维表格）记录读取共享助手。
 * lark-cli 的 +record-search / +record-get / +record-list 都返回
 * record_id_list + fields（按索引对齐）的结构，统一解析。
 */
import { runLark, describeLarkError, runtimeIdentity } from "./lark.ts";

export function formatCellValue(v: any): string {
  if (v == null) return "";
  if (Array.isArray(v)) {
    return v.map((x) => (x && typeof x === "object" ? (x.text ?? x.name ?? x.origin_name ?? x.en_name ?? JSON.stringify(x)) : String(x))).join(", ");
  }
  if (typeof v === "object") {
    return v.text ?? v.name ?? JSON.stringify(v);
  }
  return String(v);
}

export interface BaseCell {
  fieldId: string;
  value: string;
}

export interface BaseRecord {
  record_id: string;
  values: BaseCell[];
}

export function parseBaseResult(envelope: any): BaseRecord[] {
  const data = envelope?.data ?? {};
  const ids: string[] = data.record_id_list ?? [];
  const fields: any[][] = data.fields ?? [];
  const fieldIds: string[] = data.field_id_list ?? [];
  return ids.map((record_id, i) => {
    const raw = Array.isArray(fields[i]) ? fields[i] : [];
    const values = raw.map((v, idx) => ({ fieldId: fieldIds[idx] ?? `f${idx}`, value: formatCellValue(v) }));
    return { record_id, values };
  });
}

/** 拉取表字段 id→名称 映射（含 name→id 反查） */
export async function fieldNameMap(
  baseToken: string,
  table: string,
): Promise<{ idToName: Record<string, string>; nameToId: Record<string, string> }> {
  const r = await runLark(["base", "+field-list", "--base-token", baseToken, "--table-id", table, "--format", "json"], {
    as: runtimeIdentity(),
    timeoutMs: 60_000,
  });
  if (!r.ok) throw new Error(describeLarkError(r));
  const fields: any[] = r.envelope?.data?.fields ?? [];
  const idToName: Record<string, string> = {};
  const nameToId: Record<string, string> = {};
  for (const f of fields) {
    const id = String(f.id ?? "");
    const name = String(f.name ?? "");
    if (id) idToName[id] = name || id;
    if (name) nameToId[name] = id;
  }
  return { idToName, nameToId };
}

/** 按字段名取值 */
export function recordValue(rec: BaseRecord, nameToId: Record<string, string>, fieldName: string): string {
  const id = nameToId[fieldName];
  if (!id) return "";
  return rec.values.find((v) => v.fieldId === id)?.value ?? "";
}

/** 分页读取整表记录（上限 maxPages 页） */
export async function listBaseRecords(
  baseToken: string,
  table: string,
  maxPages = 5,
): Promise<{ records: BaseRecord[]; idToName: Record<string, string>; nameToId: Record<string, string> }> {
  const { idToName, nameToId } = await fieldNameMap(baseToken, table);
  const records: BaseRecord[] = [];
  let offset = 0;
  const pageSize = 100;
  for (let page = 0; page < maxPages; page++) {
    const r = await runLark(
      ["base", "+record-list", "--base-token", baseToken, "--table-id", table, "--limit", String(pageSize), "--offset", String(offset), "--format", "json"],
      { as: runtimeIdentity(), timeoutMs: 90_000 },
    );
    if (!r.ok) throw new Error(describeLarkError(r));
    const pageRecords = parseBaseResult(r.envelope);
    records.push(...pageRecords);
    const hasMore = r.envelope?.data?.has_more === true;
    if (!hasMore || pageRecords.length === 0) break;
    offset += pageRecords.length;
  }
  return { records, idToName, nameToId };
}
