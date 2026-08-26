/** update 模块冒烟测试：版本比较 + 本地版本读取 + 检查失败路径（无网络依赖） */
import { createJiti } from "jiti";
import { join } from "node:path";

const jiti = createJiti(import.meta.url);
const U = await jiti.import(join(process.cwd(), "agent/src/update.ts")) as typeof import("../agent/src/update.ts");

let failed = 0;
function check(name: string, cond: boolean, extra = "") {
  if (cond) console.log(`  ✅ ${name}`);
  else { failed++; console.log(`  ❌ ${name} ${extra}`); }
}

console.log("== compareVersions ==");
check("0.2.0 > 0.1.0", U.compareVersions("0.2.0", "0.1.0") > 0);
check("0.1.0 == 0.1.0", U.compareVersions("0.1.0", "0.1.0") === 0);
check("0.1.1 > 0.1.0", U.compareVersions("0.1.1", "0.1.0") > 0);
check("1.0.0 > 0.9.9", U.compareVersions("1.0.0", "0.9.9") > 0);
check("0.2.0 < 0.2.1", U.compareVersions("0.2.0", "0.2.1") < 0);
check("预发布后缀忽略", U.compareVersions("0.1.0-beta", "0.1.0") === 0);

console.log("== localVersion ==");
const v = U.localVersion();
check("本地版本可读", /^\d+\.\d+\.\d+/.test(v), v);

console.log("== checkUpdate 失败/关闭路径 ==");
const off = await U.checkUpdate({ url: "", intervalMs: 0 });
check("无 URL 不检查", off.latest === null && !off.error);
const bad = await U.checkUpdate({ url: "http://127.0.0.1:1/version.json", intervalMs: 0 }, 1500);
check("不可达快速失败且不抛", Boolean(bad.error), bad.error ?? "");

console.log(failed === 0 ? "\n全部通过 ✅" : `\n${failed} 项失败 ❌`);
process.exit(failed === 0 ? 0 : 1);
