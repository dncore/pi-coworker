// 共享 I/O 与文本工具测试(node:test,零依赖)。
// 覆盖:YAML 块定位 / 标量引号 / .env upsert / 备份写入-列表-还原(含 pre-restore 双保险)。
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  blockBodyEnd,
  findKeyInRegion,
  headerHasInlineContent,
  listBackups,
  restoreBackup,
  upsertEnvKeyText,
  writeSecretFile,
  writeWithBackup,
  yamlQuote,
} from "./config-io.ts";

describe("yamlQuote", () => {
  it("安全标量直接输出,特殊字符按 JSON 转义", () => {
    assert.equal(yamlQuote("https://gw.example/v1"), "https://gw.example/v1");
    assert.equal(yamlQuote("a b"), "a b");
    // `: ` 与 ` #` 会让 plain scalar 语义改变,必须加引号
    assert.equal(yamlQuote("key: value"), '"key: value"');
    assert.equal(yamlQuote("a #b"), '"a #b"');
    assert.equal(yamlQuote("值*星"), '"值*星"');
  });
});

describe("YAML 块定位", () => {
  const yaml = [
    "# 顶部注释",
    "llm-pi-ai:",
    "  providers:",
    "    magene:",
    "      displayName: Magene",
    "    other: {}",
    "agent-default-model:",
    "  provider: magene",
    "",
  ].join("\n");

  it("findKeyInRegion 定位键行与缩进(可限定缩进)", () => {
    const llm = findKeyInRegion(yaml, 0, yaml.length, "llm-pi-ai", 0);
    assert.ok(llm);
    assert.equal(llm.indent, 0);
    const providers = findKeyInRegion(yaml, llm.end, yaml.length, "providers");
    assert.ok(providers);
    assert.equal(providers.indent, 2);
    // 缩进不匹配返回 null(顶层不存在第二个 providers)
    assert.equal(findKeyInRegion(yaml, 0, yaml.length, "providers", 0), null);
  });

  it("blockBodyEnd 到兄弟键即停", () => {
    const llm = findKeyInRegion(yaml, 0, yaml.length, "llm-pi-ai", 0)!;
    const bodyStart = llm.end + 1;
    const bodyEnd = blockBodyEnd(yaml, bodyStart, 0, yaml.length);
    const slice = yaml.slice(bodyStart, bodyEnd);
    assert.ok(slice.includes("providers:"));
    assert.ok(!slice.includes("agent-default-model:"));
  });

  it("headerHasInlineContent 识别 flow style", () => {
    const llm = findKeyInRegion(yaml, 0, yaml.length, "llm-pi-ai", 0)!;
    assert.equal(headerHasInlineContent(yaml, llm.start, llm.end), false);
    const other = findKeyInRegion(yaml, 0, yaml.length, "other")!;
    assert.equal(headerHasInlineContent(yaml, other.start, other.end), true);
  });
});

describe("upsertEnvKeyText", () => {
  it("新增/更新/兼容 export 前缀,保留其他 key", () => {
    const a = upsertEnvKeyText("", "AXON_API_KEY", "sk-1");
    assert.equal(a.text, 'AXON_API_KEY="sk-1"\n');
    const b = upsertEnvKeyText(`OTHER=k\n${a.text}`, "AXON_API_KEY", "sk-2");
    assert.equal(b.text, 'OTHER=k\nAXON_API_KEY="sk-2"\n');
    const c = upsertEnvKeyText("export AXON_API_KEY=old", "AXON_API_KEY", "sk-3");
    // 原行无尾换行,替换后同样无尾换行(行内替换,不改写行结构)
    assert.equal(c.text, 'AXON_API_KEY="sk-3"');
    assert.ok(c.changed);
  });
});

describe("备份写入 / 列表 / 还原", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "config-io-test-"));
  const target = path.join(tmp, "settings.json");

  it("写前备份为 .bak-*,还原前再备份 .bak-pre-restore-*", async () => {
    // 第一次写(文件不存在,无备份)
    const w1 = await writeWithBackup(target, '{"v":1}\n');
    assert.equal(w1.backup, undefined);
    assert.equal(readFileSync(target, "utf8"), '{"v":1}\n');

    // 第二次写(已有文件 → 备份)
    const w2 = await writeWithBackup(target, '{"v":2}\n');
    assert.ok(w2.backup, "应产生备份");
    assert.ok(path.basename(w2.backup!).startsWith("settings.json.bak-"));
    assert.equal(readFileSync(w2.backup!, "utf8"), '{"v":1}\n');

    // 备份列表(时间倒序,含全部 .bak-*)
    const backups = await listBackups(target);
    assert.equal(backups.length, 1);
    assert.equal(backups[0]!.path, w2.backup);

    // 还原:当前文件先备份为 .bak-pre-restore-*,再被备份覆盖
    const r = await restoreBackup(target, w2.backup!);
    assert.equal(r.target, target);
    assert.ok(r.backup, "还原前应先备份当前文件");
    assert.ok(path.basename(r.backup!).startsWith("settings.json.bak-pre-restore-"));
    assert.equal(readFileSync(target, "utf8"), '{"v":1}\n');
    assert.equal((await listBackups(target)).length, 2);
  });

  it("writeSecretFile 固定 0600", async () => {
    const secret = path.join(tmp, "auth.json");
    await writeSecretFile(secret, '{"k":"v"}\n');
    assert.equal(readFileSync(secret, "utf8"), '{"k":"v"}\n');
    if (process.platform !== "win32") {
      const st = statSync(secret);
      // 0600 = rw-------
      assert.equal(st.mode & 0o777, 0o600);
    }
  });

  it("缺失目标的备份列表为空", async () => {
    assert.deepEqual(await listBackups(path.join(tmp, "nope.yaml")), []);
  });

  rmSync(tmp, { recursive: true, force: true });
});
