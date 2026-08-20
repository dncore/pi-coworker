/**
 * 飞书交互卡片通用构造器（Card 2.0 userDSL，参考官方文档）。
 *
 * 目标：不写固定模板，任何 agent 交互都能声明式组装卡片。
 * 结构（官方 v2）：{ schema:"2.0", config?, header?, body:{ elements:[...] } }
 *
 * 用法：
 *   const card = coworkerCard()
 *     .header("blue", "权限申请")
 *     .md("**研发知识库**\n授予方式：自服务直授")
 *     .divider()
 *     .buttons([
 *       { text: "一键申请", type: "primary", action: "perm_apply", payload: { permissionId: "wiki_engineering" } },
 *       { text: "取消", action: "perm_catalog" },
 *     ])
 *     .note("由 coworker 生成")
 *     .build();
 */

export type HeaderTemplate =
  | "blue" | "wathet" | "turquoise" | "green" | "yellow" | "orange" | "red"
  | "carmine" | "violet" | "purple" | "indigo" | "grey";

export type ButtonType = "primary" | "default" | "danger";

export interface Card2 {
  schema: "2.0";
  config?: {
    update_multi?: boolean;
    width_mode?: "compact" | "fill";
    enable_forward_interaction?: boolean;
    [k: string]: any;
  };
  header?: {
    template?: HeaderTemplate | string;
    title: { tag: "plain_text" | "lark_md"; content: string };
    emoji?: { tag: "img"; img_key: string };
    [k: string]: any;
  };
  body: { elements: any[] };
}

export interface CardButton {
  text: string;
  type?: ButtonType;
  /** 显式按钮值（回调时以 action_value JSON 字符串送达） */
  value?: Record<string, any>;
  /** 快捷写法：value = { action, ...payload } */
  action?: string;
  payload?: Record<string, any>;
  /** 点击确认弹窗 */
  confirm?: { title?: string; text: string };
  name?: string;
}

// ---------------- 元素帮助函数 ----------------

/** 段落文本（支持 lark_md 富文本） */
export function md(content: string): any {
  return { tag: "div", text: { tag: "lark_md", content } };
}
/** 纯文本段落 */
export function textEl(content: string): any {
  return { tag: "div", text: { tag: "plain_text", content } };
}
/** markdown 组件（渲染为整块富文本） */
export function markdown(content: string): any {
  return { tag: "markdown", content };
}
export function hr(): any {
  return { tag: "hr" };
}
/** 备注文本：v2 已移除 note 组件，降级为 markdown 块（内容可正常显示） */
export function note(content: string): any {
  return { tag: "markdown", content };
}
export function img(imgKey: string, alt = ""): any {
  return { tag: "img", img_key: imgKey, alt };
}
export function button(b: CardButton): any {
  const value = b.value ?? (b.action ? { action: b.action, ...(b.payload ?? {}) } : undefined);
  return {
    tag: "button",
    text: { tag: "plain_text", content: b.text },
    type: b.type ?? "default",
    ...(value !== undefined ? { value } : {}),
    ...(b.confirm
      ? {
          confirm: {
            ...(b.confirm.title ? { title: { tag: "plain_text", content: b.confirm.title } } : {}),
            text: { tag: "plain_text", content: b.confirm.text },
          },
        }
      : {}),
    ...(b.name ? { name: b.name } : {}),
  };
}
/**
 * 按钮组（Card 2.0：无 action 容器；平铺为多个独立 button 元素，每行一个）。
 * 返回元素数组；构建器 .buttons() 会逐个 add。
 */
export function buttons(btns: CardButton[]): any[] {
  return btns.map(button);
}
/** option 文本在 v2 必须是对象 { tag: "plain_text", content } */
export function option(text: string, value: any): { text: { tag: "plain_text"; content: string }; value: any } {
  return { text: { tag: "plain_text", content: text }, value };
}
export function overflow(options: Array<{ text: string; value: any }>, name?: string): any {
  return { tag: "overflow", options: options.map((o) => option(o.text, o.value)), ...(name ? { name } : {}) };
}
export interface SelectOpts {
  placeholder?: string;
  initial?: any;
  required?: boolean;
}
export function select(name: string, options: Array<{ text: string; value: any }>, opts: SelectOpts = {}): any {
  return {
    tag: "select_static",
    name,
    options: options.map((o) => option(o.text, o.value)),
    ...(opts.placeholder ? { placeholder: { tag: "plain_text", content: opts.placeholder } } : {}),
    ...(opts.initial !== undefined ? { initial_option: opts.initial } : {}),
    ...(opts.required ? { required: true } : {}),
  };
}
export interface InputOpts {
  placeholder?: string;
  label?: string;
  value?: string;
  required?: boolean;
}
export function input(name: string, opts: InputOpts = {}): any {
  return {
    tag: "input",
    name,
    ...(opts.placeholder ? { placeholder: { tag: "plain_text", content: opts.placeholder } } : {}),
    ...(opts.label ? { label: { tag: "plain_text", content: opts.label } } : {}),
    ...(opts.value !== undefined ? { value: opts.value } : {}),
    ...(opts.required ? { required: true } : {}),
  };
}
/**
 * 表单容器（实验性）：v2 要求容器内至少一个提交按钮（且提交按钮需包在 column_set 内，
 * 而 v2 column_set 的列容器结构仍在验证中）。生产卡片暂勿使用，待 schema 确认后完善。
 */
export function form(name: string, elements: any[]): any {
  return { tag: "form", name, elements };
}

/**
 * 分栏容器（实验性）：v2 列容器的承载字段（children/columns）未最终确认，API 曾拒绝 children。
 * 生产卡片暂勿使用，待验证。
 */
export function columnSet(_opts?: Record<string, any>): never {
  throw new Error("columnSet 为实验性：v2 列容器 schema 未确认，暂不可用");
}

// ---------------- 卡片构建器（链式） ----------------

export class CardBuilder {
  private card: Card2 = { schema: "2.0", body: { elements: [] } };

  header(template: HeaderTemplate | "none", title: string, opts: { emoji?: string; tag?: "plain_text" | "lark_md" } = {}): this {
    const h: NonNullable<Card2["header"]> = { title: { tag: opts.tag ?? "plain_text", content: title } };
    if (template !== "none") h.template = template;
    if (opts.emoji) h.emoji = { tag: "img", img_key: opts.emoji };
    this.card.header = h;
    return this;
  }

  config(cfg: NonNullable<Card2["config"]>): this {
    this.card.config = { ...this.card.config, ...cfg };
    return this;
  }

  add(el: any): this {
    this.card.body.elements.push(el);
    return this;
  }

  md(content: string): this {
    return this.add(md(content));
  }
  text(content: string): this {
    return this.add(textEl(content));
  }
  markdown(content: string): this {
    return this.add(markdown(content));
  }
  divider(): this {
    return this.add(hr());
  }
  note(content: string): this {
    return this.add(note(content));
  }
  img(imgKey: string, alt = ""): this {
    return this.add(img(imgKey, alt));
  }
  buttons(btns: CardButton[]): this {
    for (const b of btns) this.add(button(b));
    return this;
  }
  overflow(options: Array<{ text: string; value: any }>, name?: string): this {
    return this.add(overflow(options, name));
  }
  select(name: string, options: Array<{ text: string; value: any }>, opts?: SelectOpts): this {
    return this.add(select(name, options, opts));
  }
  input(name: string, opts?: InputOpts): this {
    return this.add(input(name, opts));
  }
  form(name: string, elements: any[]): this {
    return this.add(form(name, elements));
  }

  build(): Card2 {
    return this.card;
  }
}

export function coworkerCard(): CardBuilder {
  return new CardBuilder();
}
