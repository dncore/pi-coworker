# pi-coworker — 企业就绪 pi agent 扩展

[![CI](https://github.com/dncore/pi-coworker/actions/workflows/ci.yml/badge.svg)](https://github.com/dncore/pi-coworker/actions/workflows/ci.yml)
[![Release](https://github.com/dncore/pi-coworker/actions/workflows/release.yml/badge.svg)](https://github.com/dncore/pi-coworker/actions/workflows/release.yml)

把 pi 变成企业就绪工作助手：**入职引导（安装/登录 lark-cli）、权限申请（岗位/知识库/文档）、企业知识问答、安全治理**。以「工作集群」组织功能，目录驱动、白名单安全、全量审计、可持续扩展。

- 设计文档：[DESIGN.md](./DESIGN.md)（内核）· [DESIGN-LOCAL.md](./docs/DESIGN-LOCAL.md)（纯本机 Agent 形态：每员工本机 + 飞书个人 Bot + magene 模型网关）
- **发布手册（管理员）**：[RELEASE.md](./RELEASE.md)（版本/打包/更新源/分发）· [IT 代建指南](./docs/IT-PROVISIONING.md)（A2：IT 代建个人 Bot）
- **Agent 工作方式与交互渠道**：[docs/INTERACTION.md](./docs/INTERACTION.md)（核心：个人本地 Bot，飞书内交互）
- 依赖：`lark-cli`（飞书官方 CLI，本扩展通过它编排飞书能力）

## 核心工作方式：个人本地 Bot（飞书内交互）

后台常驻 agent 跑在**员工本机**，用户**在飞书里私聊自己的 Bot**：问答、申请权限、入职引导、点卡片按钮。agent 用**用户自己的 lark-cli 身份 + 自己的 LLM provider**，工作目录=本机，通过 lark-cli 与飞书能力捆绑。

```bash
# agent/ 目录：RUN_MODE=local（默认）个人本机 | server 公司共享
cd agent && RUN_MODE=local node src/index.ts
```

| 补充模式 | 位置 | 用途 |
|---|---|---|
| 公司共享知识机器人（agent/ server） | 服务器 | 全员群 @ 的百科/制度机器人（7×24、只读） |
| CLI（pi + `/coworker:*`） | 本机 | 开发者最全能力 |
| 桌面 GUI | 本机 | 可选：仅作守护进程托盘/启动器（交互本身在飞书） |

> 详细交互方式见 [docs/INTERACTION.md](./docs/INTERACTION.md)。

## 工作集群

| 集群 | 工具 | 命令 |
|---|---|---|
| onboarding 入职引导 | `coworker_check_env` / `coworker_config_init` / `coworker_auth_login` / `coworker_auth_complete` / `coworker_auth_status` / `coworker_bot_setup` / `coworker_bot_activate` / `coworker_setup_status` / `coworker_daemon` / `coworker_magene_setup` / `coworker_magene_status` | `/coworker:setup` `/coworker:status` `/coworker:bot` |
| permissions 权限申请 | `coworker_perm_list` / `coworker_perm_check` / `coworker_perm_apply` / `coworker_perm_status` / `coworker_perm_my` / `coworker_perm_scan` | `/coworker:perm` |
| knowledge 知识问答 | `coworker_knowledge_search` / `coworker_knowledge_fetch` | — |
| skills 公司技能 | `coworker_skill_sync` | `/coworker:skills` |
| governance 治理安全 | 危险操作拦截 / 密钥脱敏 / 规则注入 / 审计 | `/coworker` `/coworker:audit` |

## 安装（员工机器）

```bash
# 方式一：pi 包 git 分发
pi install git:github.com/dncore/pi-coworker@v0.1.0

# 方式二：公司 bootstrap 一键安装（含 lark-cli 安装 + 开机自启 + 守护进程启动）
bash <(curl -fsSL <公司内网脚本地址>/bootstrap.sh)

# 方式三：离线包（无外网环境）
#   解压 scripts/package.sh 产出的 pi-coworker-<v>.tar.gz → pi install .

# 更新
pi update --extensions
```

安装后在任意目录运行 pi，输入：

```
/coworker:setup
```

按引导完成：环境检查 → 飞书授权登录（扫码/链接）→ 知识源确认 → 权限申请。

## 管理员：配置维护

配置位于包内 `config/`（`~/.pi/agent/npm/pi-coworker/config/` 或 git clone 的仓库目录）：

| 文件 | 说明 |
|---|---|
| `catalog.json` | 权限目录。`grant`：`self-service`（bot 直授）/ `approval`（审批）/ `owner-request`（向 owner 申请） |
| `knowledge.json` | 知识源。`type`：`base`（多维表格）/ `wiki`（知识空间）/ `doc`（云文档）；带 `skillSync` 的源可用于同步公司技能 |
| `policy.json` | 角色→集群映射、写确认门禁、安全规则开关 |

用户级配置（自动生成）：`~/.coworker/coworker.json`；审计日志：`~/.coworker/audit.jsonl`（`/coworker:audit` 查看）；动态加载的公司技能：`~/.coworker/skills/`（`/coworker:skills` 查看，`coworker_skill_sync` 从知识库同步）。

## 安全边界（四层）

1. **白名单**：只能申请 catalog 登记过的权限 id、检索 knowledge 登记过的源。
2. **lark-cli 原生门禁**：高风险写（exit 10）绝不自动 `--yes`，用户确认后执行。
3. **扩展拦截**：破坏性 shell、阻塞式 `auth login` 拦截；输出密钥脱敏；身份不静默切换。
4. **规则注入**：企业操作规则注入系统提示 + `coworker` skill；最小权限授权；问答附来源、不编造、敏感内容拒绝。

## 开发

```bash
npm install            # 仅开发期类型检查需要
npm run check          # tsc 类型检查
```

本地试运行：

```bash
pi -e ./extensions/index.ts
```

## 扩展点

- 新增权限 → `catalog.json` 加一条记录
- 新增知识源 → `knowledge.json` 加一个 source
- 新增集群 → `extensions/clusters/<name>.ts` 注册工具，并在 `policy.json` 分配角色
- 路线图：lifecycle 集群（离职回收/周期复核）、审计同步中心 Base、catalog 中心化下发
