// Magene 凭证存储:~/.pi/agent/magene-credentials.json(文件 0600)。
// 历史位置 ~/.pi/agent/extensions/magene-provider/.env 属离线安装器目录,
// 会被安装器覆盖安装 / 目录清理波及导致 key 丢失(与 custom-providers.json
// 同思路:凭证放 ~/.pi/agent/ 顶层,不受任何插件安装路线增删影响)。
// 读取时若 json 缺失而旧 .env 有凭证,自动迁移;旧 .env 保留不动(兼容旧版本)。

import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type MageneCredentials = {
  baseUrl: string;
  apiKey: string;
};

type CredentialsFile = {
  version: 1;
  baseUrl?: string;
  apiKey?: string;
};

export const MAGENE_CREDENTIALS_PATH = path.join(os.homedir(), ".pi", "agent", "magene-credentials.json");

/** 读取凭证 json;缺失/损坏/字段全空返回 null(不抛错)。 */
export async function loadMageneCredentials(
  filePath: string = MAGENE_CREDENTIALS_PATH,
): Promise<MageneCredentials | null> {
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8")) as Partial<CredentialsFile>;
    const baseUrl = typeof parsed.baseUrl === "string" ? parsed.baseUrl.trim() : "";
    const apiKey = typeof parsed.apiKey === "string" ? parsed.apiKey.trim() : "";
    if (!baseUrl && !apiKey) return null;
    return { baseUrl, apiKey };
  } catch {
    return null;
  }
}

/** 保存凭证 json(0600,不备份——含密钥,避免凭据多副本;同 custom-providers.json)。 */
export async function saveMageneCredentials(
  creds: MageneCredentials,
  filePath: string = MAGENE_CREDENTIALS_PATH,
): Promise<string> {
  const doc: CredentialsFile = { version: 1, baseUrl: creds.baseUrl, apiKey: creds.apiKey };
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600 });
  await chmod(filePath, 0o600);
  return filePath;
}

/** 一次性迁移:json 缺失而旧 .env 有凭证时,把 .env 内容写入 json。
 *  返回是否发生迁移(旧 .env 保留,供旧版本插件与离线安装器继续读取)。 */
export async function migrateLegacyEnvCredentials(
  envFile: Record<string, string | undefined>,
  filePath: string = MAGENE_CREDENTIALS_PATH,
): Promise<boolean> {
  const baseUrl = envFile.MAGENE_BASE_URL?.trim() ?? "";
  const apiKey = envFile.MAGENE_API_KEY?.trim() ?? "";
  if (!baseUrl && !apiKey) return false;
  await saveMageneCredentials({ baseUrl, apiKey }, filePath);
  return true;
}
