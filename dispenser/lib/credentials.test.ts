// 凭证存储与配置源优先级测试(node:test,零依赖)。
// 覆盖:magene-credentials.json 读写 / 损坏与空文件兜底 / 0600 权限 /
// 旧 .env 一次性迁移 / resolveMageneConfigFromSources 三层优先级(env > json > .env)与来源标注。
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadMageneCredentials, migrateLegacyEnvCredentials, saveMageneCredentials } from "./credentials.ts";
import { resolveMageneConfigFromSources } from "./core.ts";

describe("magene-credentials.json 读写", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "magene-creds-"));
  const jsonPath = path.join(tmp, "magene-credentials.json");

  it("save 后 load 往返一致,文件 0600", async () => {
    await saveMageneCredentials({ baseUrl: "http://gw.example/api/v1", apiKey: "sk-test" }, jsonPath);
    assert.deepEqual(await loadMageneCredentials(jsonPath), {
      baseUrl: "http://gw.example/api/v1",
      apiKey: "sk-test",
    });
    if (process.platform !== "win32") {
      assert.equal(statSync(jsonPath).mode & 0o777, 0o600);
    }
  });

  it("缺失 / 损坏 / 字段全空返回 null", async () => {
    assert.equal(await loadMageneCredentials(path.join(tmp, "absent.json")), null);
    writeFileSync(path.join(tmp, "corrupt.json"), "{not json");
    assert.equal(await loadMageneCredentials(path.join(tmp, "corrupt.json")), null);
    writeFileSync(path.join(tmp, "empty.json"), JSON.stringify({ version: 1 }));
    assert.equal(await loadMageneCredentials(path.join(tmp, "empty.json")), null);
  });

  it("旧 .env 有凭证时迁移写入 json,空 .env 不迁移", async () => {
    const target = path.join(tmp, "migrated.json");
    assert.equal(
      await migrateLegacyEnvCredentials(
        { MAGENE_BASE_URL: "http://gw.example/api/v1", MAGENE_API_KEY: "sk-old" },
        target,
      ),
      true,
    );
    assert.deepEqual(await loadMageneCredentials(target), {
      baseUrl: "http://gw.example/api/v1",
      apiKey: "sk-old",
    });
    assert.equal(await migrateLegacyEnvCredentials({}, path.join(tmp, "unused.json")), false);
  });

  rmSync(tmp, { recursive: true, force: true });
});

describe("配置源优先级 env > json > .env", () => {
  const resolve = (env: Record<string, string | undefined>, stored: { baseUrl?: string; apiKey?: string } | undefined, envFile: Record<string, string | undefined>) =>
    resolveMageneConfigFromSources({ env, envFile, stored, defaultBaseUrl: "http://default/api/v1" });

  it("三层齐全时 env 全胜", () => {
    const r = resolve(
      { MAGENE_BASE_URL: "http://env/api/v1", MAGENE_API_KEY: "sk-env" },
      { baseUrl: "http://json/api/v1", apiKey: "sk-json" },
      { MAGENE_BASE_URL: "http://file/api/v1", MAGENE_API_KEY: "sk-file" },
    );
    assert.equal(r.baseUrl, "http://env/api/v1");
    assert.equal(r.baseUrlSource, "env");
    assert.equal(r.apiKey, "sk-env");
    assert.equal(r.apiKeySource, "env");
  });

  it("无 env 变量时 json 胜 .env,来源标注为 json", () => {
    const r = resolve(
      {},
      { baseUrl: "http://json/api/v1", apiKey: "sk-json" },
      { MAGENE_BASE_URL: "http://file/api/v1", MAGENE_API_KEY: "sk-file" },
    );
    assert.equal(r.baseUrl, "http://json/api/v1");
    assert.equal(r.baseUrlSource, "json");
    assert.equal(r.apiKey, "sk-json");
    assert.equal(r.apiKeySource, "json");
  });

  it("仅 .env 时回退到 .env 层", () => {
    const r = resolve({}, undefined, { MAGENE_BASE_URL: "http://file/api/v1", MAGENE_API_KEY: "sk-file" });
    assert.equal(r.baseUrl, "http://file/api/v1");
    assert.equal(r.baseUrlSource, ".env");
    assert.equal(r.apiKey, "sk-file");
    assert.equal(r.apiKeySource, ".env");
  });

  it("全空时 baseUrl 落默认、key 为空,来源 default/none", () => {
    const r = resolve({}, undefined, {});
    assert.equal(r.baseUrl, "http://default/api/v1");
    assert.equal(r.baseUrlSource, "default");
    assert.equal(r.apiKey, "");
    assert.equal(r.apiKeySource, "none");
  });

  it("按字段独立回退:json 只有 key,baseUrl 取 .env", () => {
    const r = resolve({}, { apiKey: "sk-json" }, { MAGENE_BASE_URL: "http://file/api/v1" });
    assert.equal(r.baseUrl, "http://file/api/v1");
    assert.equal(r.baseUrlSource, ".env");
    assert.equal(r.apiKey, "sk-json");
    assert.equal(r.apiKeySource, "json");
  });

  it("normalizeApiKey 生效:json 里的 Bearer 前缀被剥离", () => {
    const r = resolve({}, { apiKey: "Bearer sk-json" }, {});
    assert.equal(r.apiKey, "sk-json");
  });
});
