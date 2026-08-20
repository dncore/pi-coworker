/**
 * permissions 工作集群（DESIGN.md §4/§5）：权限目录 + 混合授予策略 + 状态跟踪。
 *
 * 混合策略分派（grant）：
 * - self-service  → wiki +member-add / drive +member-add（bot 直授，写前确认）
 * - approval      → approvals search/get → instances create（发起审批，写前确认）
 * - owner-request → drive +apply-permission（向 owner 申请访问）
 *
 * 安全：只接受 catalog.json 登记过的权限 id；写操作一律确认后执行。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { runLark, describeLarkError } from "../core/lark.ts";
import { getPermission, listPermissions, validatePermission } from "../core/catalog.ts";
import { appendAudit, loadUserConfig, readAudit } from "../core/config.ts";
import { requireCluster, confirmWrite } from "../core/safety.ts";
import { okResult, errResult, refreshIdentity, currentUser } from "../core/tools.ts";

/** 工具执行上下文的最小结构（pi 实际传入更完整，结构类型够用） */
interface ToolCtx {
  hasUI?: boolean;
  ui?: { confirm(title: string, message: string): Promise<boolean> };
}

function toLines(arr: string[]): string {
  return arr.filter((l) => l !== "" && l != null).join("\n");
}

export function registerPermissions(pi: ExtensionAPI): void {
  // ---------------------------------------------------------------
  // coworker_perm_list —— 列出目录中可申请的权限
  // ---------------------------------------------------------------
  pi.registerTool({
    name: "coworker_perm_list",
    label: "Coworker 权限目录",
    description: "列出企业权限目录（catalog）中可申请的权限：岗位权限、知识库权限、文档权限等，含授予策略。",
    parameters: Type.Object({
      query: Type.Optional(Type.String({ description: "按名称/类型/授予方式过滤关键词" })),
    }),
    async execute(_id, params) {
      const gate = requireCluster("permissions");
      if (gate) return errResult(gate);

      const perms = listPermissions().filter((p) => {
        const q = (params.query ?? "").toLowerCase();
        if (!q) return true;
        return [p.id, p.name, p.type, p.grant, p.description ?? ""].join(" ").toLowerCase().includes(q);
      });

      if (perms.length === 0) {
        return okResult(
          toLines([
            "权限目录为空或没有匹配项。",
            "提示：catalog.json 由管理员维护，位于包内 config/catalog.json。",
          ]),
          { count: 0 },
        );
      }

      const issues = perms.flatMap((p) => validatePermission(p));
      const lines = perms.map((p) => {
        const target = p.spaceId ? `space=${p.spaceId}` : p.url ? p.url : p.approvalKeyword ? `审批≈${p.approvalKeyword}` : "";
        return [
          `• [${p.id}] ${p.name}（${p.type}/${p.grant}）`,
          p.description ? `    ${p.description}` : "",
          target ? `    目标：${target}` : "",
        ].join("\n");
      });
      return okResult(
        toLines([...lines, "", `共 ${perms.length} 项。用 coworker_perm_apply 申请，coworker_perm_check 检查现状。`]),
        { count: perms.length, issues },
      );
    },
  });

  // ---------------------------------------------------------------
  // coworker_perm_check —— 检查当前是否已具备某权限
  // ---------------------------------------------------------------
  pi.registerTool({
    name: "coworker_perm_check",
    label: "Coworker 权限检查",
    description: "检查当前用户对某条权限（按目录 id）是否已具备访问能力。自服务/owner-request 类可探测；审批类需查看审批进度。",
    parameters: Type.Object({
      id: Type.String({ description: "catalog.json 中的权限 id，如 wiki_engineering" }),
    }),
    async execute(_id, params, _sig, _onUpdate, ctx: ToolCtx) {
      const gate = requireCluster("permissions");
      if (gate) return errResult(gate);

      const perm = getPermission(params.id);
      if (!perm) {
        return errResult(
          `目录中不存在权限 id「${params.id}」。可用 coworker_perm_list 查看全部。`,
          { registered: false },
        );
      }

      const detail: Record<string, unknown> = { id: params.id, grant: perm.grant };

      if (perm.grant === "approval") {
        return okResult(
          toLines([
            `权限「${perm.name}」走审批流程，无法直接探测现状。`,
            `可用 coworker_perm_status 查看审批进度，或 coworker_perm_apply 发起申请。`,
          ]),
          { ...detail, checkable: false },
        );
      }

      if (perm.type === "wiki-space" && perm.spaceId) {
        const r = await runLark(["wiki", "+space-list", "--format", "json"], { as: "user", timeoutMs: 60_000 });
        const spaces: any[] = r.envelope?.data?.spaces ?? r.envelope?.data?.items ?? [];
        const hit = spaces.find((s) => String(s.space_id) === String(perm.spaceId));
        if (hit) {
          appendAudit({ cluster: "permissions", action: "perm_check", resource: params.id, result: "ok", detail: { granted: true } });
          return okResult(`✅ 你已是知识空间「${hit.name ?? perm.spaceId}」可见成员，无需申请。`, { ...detail, granted: true });
        }
        return okResult(
          `未检测到你对知识空间 ${perm.spaceId} 的访问。可调用 coworker_perm_apply 申请（自服务直授或审批）。`,
          { ...detail, granted: false },
        );
      }

      if ((perm.type === "drive-doc" || perm.type === "drive-folder") && (perm.url || perm.token)) {
        const target = perm.url ?? perm.token ?? "";
        const r = await runLark(["drive", "+inspect", "--url", target], { as: "user", timeoutMs: 60_000 });
        if (r.ok) {
          const title = r.envelope?.data?.title ?? "文档";
          appendAudit({ cluster: "permissions", action: "perm_check", resource: params.id, result: "ok", detail: { granted: true } });
          return okResult(`✅ 你已能访问「${title}」。`, { ...detail, granted: true });
        }
        return okResult(
          `当前无法访问「${perm.name}」（${describeLarkError(r)}）。` +
            (perm.grant === "owner-request"
              ? ` 可调用 coworker_perm_apply 向 owner 申请访问。`
              : ` 可调用 coworker_perm_apply 申请。`),
          { ...detail, granted: false },
        );
      }

      return okResult(
        `该权限类型（${perm.type}）暂不支持自动探测，请用 coworker_perm_status 查看审批或申请记录。`,
        { ...detail, checkable: false },
      );
    },
  });

  // ---------------------------------------------------------------
  // coworker_perm_apply —— 申请权限（按 grant 分派）
  // ---------------------------------------------------------------
  pi.registerTool({
    name: "coworker_perm_apply",
    label: "Coworker 申请权限",
    description:
      "按目录申请一条权限。自服务类=bot 直接加成员/协作者；审批类=发起飞书审批实例；owner-request 类=向文档 owner 申请访问。写操作前会向用户确认。",
    parameters: Type.Object({
      id: Type.String({ description: "catalog.json 中的权限 id" }),
      form: Type.Optional(Type.String({ description: "审批表单覆盖，JSON 数组字符串，如 '[{\"name\":\"岗位\",\"value\":\"后端\"}]'。不传则用目录模板。" })),
      remark: Type.Optional(Type.String({ description: "申请备注（owner-request 展示给 owner 的说明）" })),
      confirm: Type.Optional(Type.Boolean({ description: "显式确认写操作（headless/RPC 场景使用，交互模式会自动弹确认）" })),
    }),
    async execute(_id, params, _sig, _onUpdate, ctx: ToolCtx) {
      const gate = requireCluster("permissions");
      if (gate) return errResult(gate);

      const perm = getPermission(params.id);
      if (!perm) {
        return errResult(`目录中不存在权限 id「${params.id}」。可用 coworker_perm_list 查看全部。`, { registered: false });
      }
      const issues = validatePermission(perm);
      if (issues.length > 0) {
        return errResult(`目录记录「${params.id}」配置不完整：${issues.join("；")}。请联系管理员修复 catalog.json。`, { issues });
      }

      switch (perm.grant) {
        case "self-service":
          return applySelfService(pi, params, ctx, perm);
        case "approval":
          return applyApproval(pi, params, ctx, perm);
        case "owner-request":
          return applyOwnerRequest(pi, params, ctx, perm);
        default:
          return errResult(`未知授予策略：${perm.grant}`, {});
      }
    },
  });

  // ---------------------------------------------------------------
  // coworker_perm_status —— 跟踪审批/申请状态
  // ---------------------------------------------------------------
  pi.registerTool({
    name: "coworker_perm_status",
    label: "Coworker 审批状态",
    description: "查看权限申请的审批进度：按 instance_code 查详情，或列出待办审批与我发起的审批。",
    parameters: Type.Object({
      instanceCode: Type.Optional(Type.String({ description: "审批实例 code（coworker_perm_apply 返回）" })),
    }),
    async execute(_id, params) {
      const gate = requireCluster("permissions");
      if (gate) return errResult(gate);

      if (params.instanceCode) {
        const r = await runLark(
          ["approval", "instances", "get", "--instance-code", params.instanceCode, "--as", "user"],
          { timeoutMs: 60_000 },
        );
        if (!r.ok) return errResult(`查询实例失败：${describeLarkError(r)}`, {});
        const d = r.envelope?.data ?? {};
        const statusMap: Record<string, string> = {
          PENDING: "审批中",
          APPROVED: "已通过",
          REJECTED: "已拒绝",
          CANCELED: "已取消",
          TERMINATED: "已终止",
        };
        const lines = [
          `实例：${d.instance_code ?? params.instanceCode}`,
          `状态：${statusMap[d.status] ?? d.status ?? "?"}`,
          d.title ? `名称：${d.title}` : "",
          d.definition_code ? `定义：${d.definition_code}` : "",
        ];
        return okResult(toLines(lines), { instanceCode: params.instanceCode, status: d.status });
      }

      // 待办 + 已办（已发起的审批用 instance_code 经 instances get 跟踪）
      const todo = await runLark(["approval", "tasks", "query", "--params", '{"topic":"1"}', "--as", "user"], { timeoutMs: 60_000 });
      const done = await runLark(["approval", "tasks", "query", "--params", '{"topic":"2"}', "--as", "user"], { timeoutMs: 60_000 });
      const lines: string[] = [];
      const todoItems: any[] = todo.envelope?.data?.tasks ?? todo.envelope?.data?.items ?? [];
      const doneItems: any[] = done.envelope?.data?.tasks ?? done.envelope?.data?.items ?? [];
      if (todoItems.length > 0) {
        lines.push("【待办审批】");
        for (const t of todoItems.slice(0, 10)) {
          lines.push(`  • ${t.title ?? t.instance_code ?? t.task_id}（${t.instance_code ?? ""}）`);
        }
      } else {
        lines.push("【待办审批】无");
      }
      if (doneItems.length > 0) {
        lines.push("【已办审批】");
        for (const t of doneItems.slice(0, 10)) {
          lines.push(`  • ${t.title ?? t.instance_code ?? t.task_id}（${t.instance_code ?? ""}）`);
        }
      } else {
        lines.push("【已办审批】无");
      }
      lines.push("");
      lines.push("提示：如需查自己发起的审批，用 coworker_perm_status 传 instance_code（coworker_perm_apply 返回）。");
      return okResult(toLines(lines), { todo: todoItems.length, done: doneItems.length });
    },
  });

  // ---------------------------------------------------------------
  // coworker_perm_scan —— 知识权限盘点（可见空间 + 角色 + 文档概览 + 目录缺口）
  // ---------------------------------------------------------------
  pi.registerTool({
    name: "coworker_perm_scan",
    label: "Coworker 知识权限盘点",
    description:
      "盘点当前用户的知识权限：可见知识空间及我的角色（admin/member/非成员仅可见）、可访问文档概览、以及权限目录（catalog）中尚未具备的缺口。用于入职自查与权限治理。",
    parameters: Type.Object({
      includeDocs: Type.Optional(Type.Boolean({ description: "是否附带可访问文档概览（默认 true）" })),
    }),
    async execute(_id, params) {
      const gate = requireCluster("permissions");
      if (gate) return errResult(gate);

      let user = currentUser();
      if (!user.openId) {
        const id = await refreshIdentity();
        if (id.openId) user = { ...user, openId: id.openId };
      }
      const myOpenId = user.openId;

      // 1) 可见知识空间
      const r = await runLark(["wiki", "+space-list", "--format", "json"], { as: "user", timeoutMs: 60_000 });
      if (!r.ok) return errResult(`查询知识空间失败：${describeLarkError(r)}`, {});
      const spaces: any[] = r.envelope?.data?.spaces ?? [];

      // 2) 每个空间里我的角色（并发，上限 20；单个失败不阻断）
      const roles: Record<string, string> = {};
      await Promise.all(
        spaces.slice(0, 20).map(async (s: any) => {
          const sid = String(s.space_id);
          try {
            const m = await runLark(["wiki", "+member-list", "--space-id", sid, "--page-all", "--format", "json"], {
              as: "user",
              timeoutMs: 60_000,
            });
            const members: any[] = m.envelope?.data?.members ?? [];
            const me = members.find((x) => String(x.member_id) === String(myOpenId));
            roles[sid] = me?.member_role === "admin" ? "admin" : me?.member_role === "member" ? "member" : "非成员(仅可见)";
          } catch {
            roles[sid] = "未知";
          }
        }),
      );

      // 3) 文档概览（检索受 ACL 约束，total 即当前用户可检索文档数）
      let docsLine = "";
      if (params.includeDocs !== false) {
        const d = await runLark(["drive", "+search", "--query", "", "--page-size", "1", "--format", "json"], {
          as: "user",
          timeoutMs: 60_000,
        });
        const total = d.envelope?.data?.total;
        docsLine = total != null ? `当前可检索文档约 ${total} 篇` : "文档概览暂不可用";
      }

      // 4) catalog 缺口（wiki-space 类）
      const gaps = listPermissions()
        .filter((p) => p.type === "wiki-space" && p.spaceId)
        .map((p) => {
          const configured = !String(p.spaceId).startsWith("REPLACE");
          const has = spaces.some((s) => String(s.space_id) === String(p.spaceId));
          return { p, configured, has };
        });

      const lines: string[] = [
        `用户：${user.name ?? myOpenId ?? "?"}`,
        ``,
        `【可见知识空间（${spaces.length}）】`,
        ...spaces.slice(0, 20).map((s) => {
          const sid = String(s.space_id);
          return `  • ${s.name}（${roles[sid] ?? "?"}）space=${sid} visibility=${s.visibility}`;
        }),
        spaces.length === 0 ? "  （无可访问空间）" : "",
        ``,
        `【文档概览】${docsLine || "（跳过）"}`,
        ``,
        `【权限目录缺口】`,
        ...gaps.map(({ p, configured, has }) => {
          if (!configured) return `  • ${p.name}（${p.id}）：目录未配置（spaceId 仍为占位）`;
          return has ? `  • ${p.name}（${p.id}）：✅ 已具备` : `  • ${p.name}（${p.id}）：❌ 未具备 → 可用 coworker_perm_apply 申请`;
        }),
        gaps.length === 0 ? "  （目录无 wiki-space 类权限）" : "",
        ``,
        "提示：缺少某空间访问时用 coworker_perm_apply 申请；需更高权限请联系知识库管理员。",
      ];

      appendAudit({ cluster: "permissions", action: "perm_scan", resource: "wiki", result: "ok", detail: { spaces: spaces.length } });
      return okResult(toLines(lines), { spaces: spaces.length, roles, gaps: gaps.filter((g) => g.configured && !g.has).length });
    },
  });

  // ---------------------------------------------------------------
  // coworker_perm_my —— 我的角色、启用的集群、申请记录
  // ---------------------------------------------------------------
  pi.registerTool({
    name: "coworker_perm_my",
    label: "Coworker 我的权限",
    description: "查看当前角色、启用的集群、以及本机记录的权限申请历史（来自审计日志）。",
    parameters: Type.Object({}),
    async execute() {
      const gate = requireCluster("permissions");
      if (gate) return errResult(gate);
      const cfg = loadUserConfig();
      const entries = readAudit(30).filter((e) => e.cluster === "permissions");
      const lines = [
        `角色：${cfg.roles.length ? cfg.roles.join(", ") : "employee（默认）"}`,
        `启用的集群：${cfg.clusters.enabled.length ? cfg.clusters.enabled.join(", ") : "全部"}`,
        ``,
        entries.length ? "【近期权限申请/授予记录】" : "【近期权限申请/授予记录】无",
        ...entries.slice(0, 15).map((e) => {
          const extra = e.detail?.instance_code ? ` instance=${e.detail.instance_code}` : "";
          return `  • ${e.ts.slice(0, 19)} ${e.action} ${e.resource} → ${e.result}${extra}`;
        }),
      ];
      return okResult(toLines(lines), { roles: cfg.roles, auditCount: entries.length });
    },
  });
}

// ================= 三种授予策略的实现 =================

/** 自服务直授：bot 加知识库成员 / 文档协作者 */
async function applySelfService(
  pi: ExtensionAPI,
  params: any,
  ctx: ToolCtx,
  perm: any,
): Promise<{ content: { type: "text"; text: string }[]; details: Record<string, unknown> }> {
  void pi;
  let user = currentUser();
  if (!user.openId) {
    const id = await refreshIdentity();
    if (!id.ok || !id.openId) {
      return errResult(
        `未取得当前用户 open_id，无法执行直授。请先调用 coworker_auth_status / coworker_check_env 确认已登录，或在配置中写入用户信息。`,
        {},
      );
    }
    user = { openId: id.openId, name: id.name, email: id.email };
  }

  const as = perm.as ?? "bot";
  let argv: string[];
  let describe: string;
  if (perm.type === "wiki-space") {
    argv = [
      "wiki", "+member-add",
      "--space-id", String(perm.spaceId),
      "--member-id", user.openId!,
      "--member-type", perm.memberType ?? "openid",
      "--member-role", perm.memberRole ?? "member",
      "--as", as,
    ];
    describe = `给 ${user.name ?? user.openId} 授予知识空间 ${perm.spaceId} 的 ${perm.memberRole ?? "member"} 权限`;
  } else {
    const target = perm.url ?? perm.token ?? "";
    const type = perm.targetType ?? (perm.url ? "docx" : undefined);
    argv = [
      "drive", "+member-add",
      "--token", target,
      ...(type ? ["--type", type] : []),
      "--member-id", user.openId!,
      "--member-type", perm.memberType ?? "openid",
      "--perm", perm.perm ?? "view",
      "--as", as,
    ];
    describe = `给 ${user.name ?? user.openId} 授予文档 ${target} 的 ${perm.perm ?? "view"} 权限`;
  }

  const confirm = await confirmWrite(ctx, {
    title: "确认直授权限",
    message: `${describe}\n\n命令：lark-cli ${argv.join(" ")} [--yes]\n这是高风险写操作，确认执行？`,
    explicitConfirm: params.confirm,
  });
  if (!confirm.ok) return errResult(`已取消：${confirm.reason ?? "用户未确认"}`, { blocked: true });

  const r = await runLark([...argv, "--yes"], { timeoutMs: 60_000 });
  appendAudit({
    cluster: "permissions",
    action: "perm_apply",
    resource: perm.id,
    result: r.ok ? "ok" : "error",
    detail: { grant: "self-service", argv: argv.join(" "), openId: user.openId },
  });
  if (!r.ok) {
    return errResult(`直授失败：${describeLarkError(r)}`, {});
  }
  return okResult(`✅ ${describe} 已完成。`, { granted: true, id: perm.id });
}

/** 审批流：搜索定义 → 发起实例 */
async function applyApproval(
  pi: ExtensionAPI,
  params: any,
  ctx: ToolCtx,
  perm: any,
): Promise<{ content: { type: "text"; text: string }[]; details: Record<string, unknown> }> {
  void pi;
  let approvalCode = perm.approvalCode;
  let approvalName = perm.name;

  if (!approvalCode) {
    const kw = perm.approvalKeyword ?? perm.name;
    const search = await runLark(
      ["approval", "approvals", "search", "--data", JSON.stringify({ keyword: kw }), "--as", "user"],
      { timeoutMs: 60_000 },
    );
    const found: any[] = search.envelope?.data?.approvals ?? search.envelope?.data?.items ?? [];
    const hit = found.find((a: any) => (a.approval_code ?? a.code) && a.name?.includes(kw)) ?? found[0];
    if (!search.ok || !hit) {
      appendAudit({ cluster: "permissions", action: "perm_apply", resource: perm.id, result: "error", detail: { grant: "approval", phase: "search" } });
      return errResult(
        `未找到审批定义「${kw}」：${search.ok ? "无匹配" : describeLarkError(search)}。\n` +
          `提示：请管理员确认该审批定义已创建并开放给用户发起，或在 catalog.json 里配置 approvalCode。`,
        {},
      );
    }
    approvalCode = hit.approval_code ?? hit.code;
    approvalName = hit.name ?? approvalName;
  }

  // 表单：优先用户传参，其次目录模板
  let form: Array<{ name: string; value: string }> = [];
  if (params.form) {
    try {
      form = JSON.parse(params.form);
    } catch {
      return errResult("form 参数不是合法 JSON 数组。格式：[{\"name\":\"字段\",\"value\":\"值\"}]", {});
    }
  } else if (perm.formTemplate) {
    form = perm.formTemplate;
  }

  const body = JSON.stringify({ approval_code: approvalCode, form });

  const confirm = await confirmWrite(ctx, {
    title: "确认发起审批",
    message: `为「${approvalName}」发起审批申请。\n\n请求体：${body}\n这是写操作，确认发起？`,
    explicitConfirm: params.confirm,
  });
  if (!confirm.ok) return errResult(`已取消：${confirm.reason ?? "用户未确认"}`, { blocked: true });

  const r = await runLark(["approval", "instances", "create", "--data", body, "--as", "user", "--yes"], {
    timeoutMs: 90_000,
  });
  const code = r.envelope?.data?.instance_code ?? r.envelope?.data?.instanceCode;
  appendAudit({
    cluster: "permissions",
    action: "perm_apply",
    resource: perm.id,
    result: r.ok ? "pending" : "error",
    detail: { grant: "approval", approvalCode, instanceCode: code },
  });
  if (!r.ok) return errResult(`发起审批失败：${describeLarkError(r)}`, {});
  return okResult(
    toLines([
      `✅ 已发起审批「${approvalName}」`,
      `instance_code：${code ?? "?"}`,
      `用 coworker_perm_status 传 instance_code 跟踪进度；审批通过后权限即生效。`,
    ]),
    { instanceCode: code, id: perm.id },
  );
}

/** owner-request：向文档 owner 申请访问（低风险申请动作，直接执行 + 审计） */
async function applyOwnerRequest(
  pi: ExtensionAPI,
  params: any,
  _ctx: ToolCtx,
  perm: any,
): Promise<{ content: { type: "text"; text: string }[]; details: Record<string, unknown> }> {
  void pi;
  const target = perm.url ?? perm.token ?? "";
  const permLevel = perm.perm ?? "view";
  const argv = [
    "drive", "+apply-permission",
    "--token", target,
    "--perm", permLevel,
    ...(params.remark ? ["--remark", String(params.remark)] : []),
    "--as", "user",
  ];
  const r = await runLark(argv, { timeoutMs: 60_000 });
  appendAudit({
    cluster: "permissions",
    action: "perm_apply",
    resource: perm.id,
    result: r.ok ? "pending" : "error",
    detail: { grant: "owner-request", target, perm: permLevel },
  });
  if (!r.ok) return errResult(`申请访问失败：${describeLarkError(r)}`, {});
  return okResult(
    toLines([
      `✅ 已向「${perm.name}」的 owner 发起${permLevel === "edit" ? "编辑" : "查看"}权限申请。`,
      `owner 处理后你会收到通知；可用 coworker_perm_check 复查是否已能访问。`,
    ]),
    { id: perm.id, requested: permLevel },
  );
}
