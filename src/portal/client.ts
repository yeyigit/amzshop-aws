// 店铺中台浏览器端脚本（卖家后台样式）：整函数以 toString() 内联进页面（带 CSP nonce），因此必须自包含——不得引用本文件以外的任何符号。
// 所有业务文字一律经 textContent / createTextNode 写入，不拼 innerHTML。
/* eslint-disable */
declare const document: any;
declare const window: any;
declare const location: any;

export function clientMain(): void {
  const SVG_NS = "http://www.w3.org/2000/svg";
  const dataNode = document.getElementById("portal-data");
  let view: any = JSON.parse((dataNode && dataNode.textContent) || "{}");
  let refreshing = false;
  let lastRefreshAt = 0;
  const AUTO_REFRESH_MS = 5 * 60_000;
  const PAGE_SIZE = 10;
  const table = { sort: "units30", desc: true, filter: "buyable", query: "", page: 0 };

  // ---------- 基础工具 ----------
  function append(node: any, children: any[]): void {
    for (const child of children) {
      if (child === undefined || child === null || child === false) continue;
      if (Array.isArray(child)) append(node, child);
      else if (typeof child === "string" || typeof child === "number") node.appendChild(document.createTextNode(String(child)));
      else node.appendChild(child);
    }
  }
  // replaceChildren 会把 null/数组转成文字，统一走 append（跳过空值、展开数组）。
  function setChildren(node: any, ...children: any[]): void {
    node.replaceChildren();
    append(node, children);
  }
  function h(tag: string, props?: any, ...children: any[]): any {
    const node = document.createElement(tag);
    if (props) {
      for (const key of Object.keys(props)) {
        const value = props[key];
        if (value === undefined || value === null || value === false) continue;
        if (key === "class") node.className = value;
        else if (key === "text") node.textContent = String(value);
        else if (key.indexOf("on") === 0) node.addEventListener(key.slice(2), value);
        else node.setAttribute(key, value === true ? "" : String(value));
      }
    }
    append(node, children);
    return node;
  }
  function s(tag: string, attrs?: any, ...children: any[]): any {
    const node = document.createElementNS(SVG_NS, tag);
    if (attrs) for (const key of Object.keys(attrs)) { const value = attrs[key]; if (value !== undefined && value !== null) node.setAttribute(key, String(value)); }
    for (const child of children) if (child !== undefined && child !== null) node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
    return node;
  }
  const isNum = (value: any): boolean => typeof value === "number" && isFinite(value);
  const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value));
  // 卖家后台写法：US$1,234.56；whole=true 时取整（商品表与后台一致）。
  function money(value: any, whole?: boolean): string {
    if (!isNum(value)) return "—";
    const currency = view.currency || "USD";
    const digits = whole ? 0 : 2;
    let text = "";
    try { text = new Intl.NumberFormat("en-US", { style: "currency", currency, minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value); }
    catch (error) { text = "$" + Number(value).toFixed(digits); }
    return currency === "USD" ? text.replace("$", "US$") : text;
  }
  function axisMoney(value: number): string {
    if (Math.abs(value) >= 1000) return "$" + (value / 1000).toFixed(value % 1000 === 0 ? 0 : 1) + "K";
    return "$" + Math.round(value);
  }
  const int = (value: any): string => isNum(value) ? new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value) : "—";
  const dec = (value: any, digits: number): string => isNum(value) ? Number(value).toFixed(digits) : "—";
  const pct = (value: any, digits?: number): string => isNum(value) ? (value * 100).toFixed(digits === undefined ? 1 : digits) + "%" : "—";
  function signedPct(value: any): string {
    if (!isNum(value)) return "—";
    const rounded = Math.round(value * 1000) / 10;
    return (rounded > 0 ? "+" : rounded < 0 ? "−" : "±") + Math.abs(rounded).toFixed(1) + "%";
  }
  function ago(minutes: any): string {
    if (!isNum(minutes)) return "—";
    if (minutes < 1) return "刚刚";
    if (minutes < 60) return Math.round(minutes) + " 分钟前";
    if (minutes < 48 * 60) return Math.floor(minutes / 60) + " 小时前";
    return Math.floor(minutes / 1440) + " 天前";
  }
  const agoIso = (iso: any): string => { const ms = Date.parse(String(iso || "")); return isFinite(ms) ? ago(Math.max(0, (Date.now() - ms) / 60_000)) : "—"; };
  function shortDate(iso: any): string {
    const ms = Date.parse(String(iso || ""));
    if (!isFinite(ms)) return "";
    return new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(ms));
  }
  const monthDay = (ymd: any): string => { const match = /^\d{4}-(\d{2})-(\d{2})$/.exec(String(ymd || "")); return match ? Number(match[1]) + "/" + Number(match[2]) : ""; };
  function niceStep(raw: number): number {
    const power = Math.pow(10, Math.floor(Math.log10(Math.max(raw, 1e-9))));
    const unit = raw / power;
    return (unit <= 1 ? 1 : unit <= 2 ? 2 : unit <= 2.5 ? 2.5 : unit <= 5 ? 5 : 10) * power;
  }
  function scale(max: number, count: number): { max: number; ticks: number[] } {
    const step = niceStep(Math.max(max, 1) / count);
    const top = Math.ceil(Math.max(max, 1) / step) * step;
    const ticks: number[] = [];
    for (let value = 0; value <= top + step / 2; value += step) ticks.push(Math.round(value * 100) / 100);
    return { max: top, ticks };
  }
  const STATUS: any = {
    early: ["◷", "时间尚早", "muted"], fast: ["▲", "偏快", "good"], normal: ["●", "正常", "neutral"],
    slow: ["▼", "偏慢", "warning"], "very-slow": ["▼", "明显偏慢", "critical"], unknown: ["–", "暂无对比", "muted"],
  };
  function chip(icon: string, label: string, tone: string, title?: string | null): any {
    return h("span", { class: "chip tone-" + tone, title: title || null }, h("span", { class: "chip-icon", "aria-hidden": "true", text: icon }), label);
  }
  function delta(value: any, better: string, suffix?: string): any {
    if (!isNum(value)) return h("span", { class: "delta muted", text: "—" });
    const up = value > 0.0005, down = value < -0.0005;
    const good = better === "up" ? up : better === "down" ? down : false;
    const bad = better === "up" ? down : better === "down" ? up : false;
    const tone = good ? "good" : bad ? "critical" : "neutral";
    return h("span", { class: "delta tone-" + tone }, h("span", { "aria-hidden": "true", text: up ? "▲ " : down ? "▼ " : "" }), signedPct(value) + (suffix || ""));
  }
  function empty(text: string): any { return h("p", { class: "empty", text }); }
  function link(href: string, text: string, cls?: string): any { return href ? h("a", { href, target: "_blank", rel: "noopener noreferrer", class: "link" + (cls ? " " + cls : ""), text }) : null; }

  // ---------- 跳飞书多维表格（只能到表、视图或仪表盘：飞书网址不能带筛选条件） ----------
  function feishu(key: string): any {
    const item = (view.links || {})[key];
    return item && typeof item.url === "string" && item.url.indexOf("https://") === 0 ? item : null;
  }
  const openTitle = (item: any): string => "在飞书打开「" + item.label + "」";
  // 指标格大数字：可点时仍是深色（与后台一致），鼠标移上去变青色。
  function valueLink(content: any, key: string): any {
    const item = feishu(key);
    return item ? h("a", { class: "value-link", href: item.url, target: "_blank", rel: "noopener noreferrer", title: openTitle(item) }, content) : content;
  }
  // 行内小数字：可点时用链接青色（同后台“亚马逊物流待处理 N”）。
  function numLink(content: string, key: string): any {
    const item = feishu(key);
    return item ? h("a", { class: "num-link", href: item.url, target: "_blank", rel: "noopener noreferrer", title: openTitle(item), text: content }) : content;
  }
  function openIcon(key: string): any {
    const item = feishu(key);
    return item ? h("a", { class: "tile-open", href: item.url, target: "_blank", rel: "noopener noreferrer", title: openTitle(item), "aria-label": openTitle(item), text: "↗" }) : null;
  }
  // 同后台“前往‘管理所有库存’”的线框按钮；文字取链接名称，改了指向也不会写错表名。
  function outlineLink(key: string): any {
    const item = feishu(key);
    return item ? h("a", { class: "btn-outline", href: item.url, target: "_blank", rel: "noopener noreferrer", title: openTitle(item), text: "前往飞书“" + item.label + "”" }) : null;
  }

  // ---------- 悬停提示（单例） ----------
  const tip = h("div", { class: "tooltip", role: "status", "aria-live": "polite" });
  document.body.appendChild(tip);
  function showTip(event: any, title: string, lines: any[]): void {
    setChildren(tip, h("div", { class: "tip-title", text: title }), lines.map((line: any) => h("div", { class: "tip-row" },
      line[2] ? h("span", { class: "tip-key key-" + line[2], "aria-hidden": "true" }) : null, h("strong", { text: line[1] }), h("span", { class: "tip-label", text: line[0] }))));
    tip.classList.add("show");
    const width = tip.offsetWidth, height = tip.offsetHeight;
    tip.style.left = clamp(event.clientX + 14, 8, window.innerWidth - width - 8) + "px";
    tip.style.top = (event.clientY - height - 12 < 8 ? event.clientY + 16 : event.clientY - height - 12) + "px";
  }
  function hideTip(): void { tip.classList.remove("show"); }

  // ---------- 顶栏与提示 ----------
  function renderHeader(): void {
    document.title = view.title || "AMZ中台";
    document.getElementById("brand-name").textContent = view.title || "AMZ中台";
    setChildren(document.getElementById("clocks"), h("span", null, "洛杉矶 ", h("strong", { text: view.laClock })), h("span", { class: "sep", "aria-hidden": "true", text: "|" }), h("span", null, "北京 ", h("strong", { text: view.bjClock })));
    setChildren(document.getElementById("user"), view.user && view.user.avatar ? h("img", { src: view.user.avatar, alt: "", class: "avatar", referrerpolicy: "no-referrer" }) : null, h("span", { text: (view.user && view.user.name) || "" }));
    renderUpdated();
    const sales = (view.kpis || {}).sales;
    const verdict = !sales ? "销售数据取到后，这里会告诉你今天卖得怎么样。"
      : sales.status === "early" ? "洛杉矶今天刚开始，样本太少，先不判断快慢。"
      : sales.status === "very-slow" ? "今天明显偏慢：先看“商品绩效”里标红的商品，再看竞品动态和广告。"
      : sales.status === "slow" ? "今天有点慢，留意标黄的商品与近 7 天动态。"
      : sales.status === "fast" ? "今天卖得比平时快。"
      : sales.status === "normal" ? "今天节奏正常。" : "暂无足够的历史数据对比。";
    // 账户健康（2026-10-11）：正常时只在问候语后加一句，有问题时由下面的红色提示条展开。
    const health = view.storeHealth;
    const account = health && health.account;
    const healthNote = !account ? null
      : account.issues.length ? h("span", { class: "tone-text-critical", text: " 账户健康：" + account.issues.length + " 项需处理。" })
      : h("span", { class: "muted", title: account.fetchedAt ? "账户健康报告 " + agoIso(account.fetchedAt) + "取得" : "", text: " 账户健康 ✓ 正常" + (isNum(account.ahrScore) ? "（评分 " + account.ahrScore + "）" : "") + "。" });
    setChildren(document.getElementById("notice"), h("strong", { text: view.greeting + "，" + ((view.user && view.user.name) || "") + "。" }), " " + verdict, healthNote);
    renderHealthStrip();
  }
  // 有账户问题或 listing 问题时显示；不放卖家后台链接（中台可能给多人用，卖家后台只由店主在本店固定环境登录）。
  function renderHealthStrip(): void {
    const strip = document.getElementById("health");
    if (!strip) return;
    const health = view.storeHealth;
    const items: string[] = [];
    if (health && health.account) for (const issue of health.account.issues) items.push("账户：" + issue);
    if (health) for (const row of health.listings || []) items.push(row.market + " " + row.sku + "：" + (row.kind === "not-buyable" ? "不可售（原在售）" : row.text));
    strip.hidden = !items.length;
    setChildren(strip, items.length ? [h("strong", { text: "⚠️ 店铺健康：" }), items.slice(0, 6).join("；") + (items.length > 6 ? " 等 " + items.length + " 项" : ""), h("span", { class: "muted", text: "。请在本店固定环境登录卖家后台处理。" })] : null);
  }
  function renderUpdated(): void {
    const sales = (view.sources || []).find((item: any) => item.key === "sales");
    document.getElementById("updated").textContent = refreshing ? "正在更新…" : sales && sales.fetchedAt ? "销售数据 " + agoIso(sales.fetchedAt) + "更新" : "等待首次取数";
  }

  // ---------- 全局快照 ----------
  // link：可在飞书打开时，大数字可点、右上角（后台下拉箭头的位置）显示“↗”。
  // bottom：高格（销售额、订单）贴着格子底部排的内容（小图、行列表），空白留在中间而不是堆在底部。
  function tile(o: any): any {
    return h("div", { class: "tile" + (o.cls ? " " + o.cls : "") },
      h("div", { class: "tile-head" },
        h("div", { class: "tile-title" }, o.title, o.info ? h("span", { class: "info", title: o.info, "aria-label": o.info, text: "ⓘ" }) : null),
        o.link ? openIcon(o.link) : null),
      h("div", { class: "tile-value" }, o.link ? valueLink(o.value, o.link) : o.value),
      o.caption ? h("div", { class: "tile-caption", text: o.caption }) : null,
      o.extra || null,
      o.bottom ? h("div", { class: "tile-bottom" }, o.bottom) : null);
  }
  // 比近 7 日同一时刻的涨跌与快慢标记并成一行。
  function paceLine(kpi: any, withChip: boolean): any {
    const status = kpi ? STATUS[kpi.status] || STATUS.unknown : null;
    const showDelta = kpi && kpi.status !== "early" && isNum(kpi.pace);
    if (!showDelta && !(withChip && status)) return null;
    return h("div", { class: "tile-delta" },
      showDelta ? h("span", null, delta(kpi.pace, "up"), h("span", { class: "muted", text: " 比近 7 日同一时刻" })) : null,
      withChip && status ? chip(status[0], status[1], status[2], kpi.status === "early" ? "平时此刻还不到全天的 15%，先不判断快慢" : null) : null);
  }
  function rowLine(label: string, value: any, tone?: string): any {
    return h("div", { class: "tile-row" + (tone ? " tone-" + tone : "") }, h("span", { text: label }), h("span", { class: "tile-row-value" }, value));
  }
  // 小图刻度按后台写法：纵轴不带货币符号，横轴“10月1日 … 4日 … 7日”（换月时再带月份）。
  function axisPlain(value: number): string {
    return Math.abs(value) >= 10000 ? (value / 1000).toFixed(value % 1000 === 0 ? 0 : 1) + "K" : String(Math.round(value));
  }
  function dayTick(ymd: any, withMonth: boolean): string {
    const match = /^\d{4}-(\d{2})-(\d{2})$/.exec(String(ymd || ""));
    return match ? (withMonth ? Number(match[1]) + "月" : "") + Number(match[2]) + "日" : "";
  }
  function sparkline(): any {
    const days: any[] = view.daily || [];
    if (!days.length) return null;
    const W = 300, H = 92, m = { l: 34, r: 8, t: 8, b: 18 };
    const y0 = scale(Math.max(1, ...days.map((day) => day.sales)), 2);
    const x = (index: number): number => m.l + (days.length === 1 ? 0 : (index / (days.length - 1)) * (W - m.l - m.r));
    const y = (value: number): number => H - m.b - (value / y0.max) * (H - m.t - m.b);
    const svg = s("svg", { viewBox: "0 0 " + W + " " + H, class: "spark", role: "img", "aria-label": "近 7 日每日销售额" });
    for (const tick of y0.ticks) {
      svg.appendChild(s("line", { x1: m.l, x2: W - m.r, y1: y(tick), y2: y(tick), class: "grid" }));
      svg.appendChild(s("text", { x: m.l - 6, y: y(tick) + 3, class: "tick", "text-anchor": "end" }, axisPlain(tick)));
    }
    svg.appendChild(s("path", { d: days.map((day, index) => (index ? "L" : "M") + x(index).toFixed(1) + " " + y(day.sales).toFixed(1)).join(" "), class: "spark-line" }));
    const labelled = [0, Math.floor((days.length - 1) / 2), days.length - 1];
    let lastMonth = "";
    days.forEach((day, index) => {
      svg.appendChild(s("circle", { cx: x(index), cy: y(day.sales), r: day.partial ? 3.5 : 2.5, class: "spark-dot" + (day.partial ? " today" : "") }));
      if (labelled.indexOf(index) >= 0) {
        const month = String(day.date || "").slice(5, 7);
        svg.appendChild(s("text", { x: x(index), y: H - 4, class: "tick", "text-anchor": index === 0 ? "start" : index === days.length - 1 ? "end" : "middle" }, dayTick(day.date, month !== lastMonth)));
        lastMonth = month;
      }
      const hit = s("rect", { x: x(index) - 14, y: 0, width: 28, height: H, fill: "transparent" });
      hit.addEventListener("pointermove", (event: any) => showTip(event, day.partial ? "今天（进行中）" : day.label, [["销售额", money(day.sales), "main"], ["销量", int(day.units) + " 件"], ["订单", int(day.orders) + " 单"]]));
      hit.addEventListener("pointerleave", hideTip);
      svg.appendChild(hit);
    });
    return svg;
  }
  // 广告账单（10/10）：大数字是广告后台的“累积费用”（接口原值）；预计扣款日是估算，门槛、日均与最迟月结日放在悬停说明里。
  // 不可点：没有对应的飞书表；也不放广告后台链接（中台可能给多人用，卖家侧后台只由店主在本店固定环境登录）。
  function billingTile(): any {
    const bill = view.adsBilling;
    const info = "广告费按发票从卖家账户余额扣，会减少下次放款；累积满扣款门槛或每月 2 日月结时开票扣款";
    if (!bill) return tile({ title: "广告账单", value: "—", caption: "广告账单暂未取到", info });
    const next = bill.next;
    const cap = isNum(bill.threshold) ? money(bill.threshold, true) : "";
    const when = !next ? null
      : next.kind === "due" ? "已满约 " + cap + "，随时扣款"
      : next.kind === "closing" ? "月结开票中，随时扣款"
      : "预计 " + monthDay(next.date) + (next.kind === "month" ? " 月结扣款" : " 前后扣款");
    const basis = [cap ? "累积满约 " + cap + " 开票扣款（门槛按近期发票推断）" : "推断不出扣款门槛，只按月结日估计", isNum(bill.rate) && next && next.kind === "threshold" ? "按日均 " + money(bill.rate) + " 推算" : null,
      bill.monthClose ? "最迟 " + monthDay(bill.monthClose) + " 月结" : null].filter(Boolean).join("；");
    const pending = bill.pending;
    // 一行放得下：没超期写开票日，超期写已过天数（开票日放悬停说明）。
    const tail = pending ? h("div", { class: "tile-sub" + (pending.overdue ? " tone-text-critical" : ""), title: (pending.count > 1 ? pending.count + " 张发票，最早 " : "") + (pending.date ? monthDay(pending.date) + " 开票，还没从余额扣完" : ""),
      text: pending.overdue ? "未付 " + money(pending.amount) + " · 已 " + pending.days + " 天" : "待扣 " + money(pending.amount) + (pending.date ? " · " + monthDay(pending.date) + " 开票" : "") })
      : bill.last ? h("div", { class: "tile-sub", text: "上次扣款 " + money(bill.last.amount) + " · " + monthDay(bill.last.date) }) : null;
    return tile({ title: "广告账单", value: isNum(bill.accrued) ? money(bill.accrued) : "—", caption: isNum(bill.accrued) ? "累积费用" + (bill.since ? " · " + monthDay(bill.since) + " 起" : "") : "暂无累积中的发票", info,
      cls: pending && pending.overdue ? "alert" : "", extra: [when ? h("div", { class: "tile-sub", title: basis, text: when }) : null, tail] });
  }
  // 货件：未完成入库的货件按亚马逊状态计数（数据来自飞书货件表），各状态并成一行（10/08 改，免得撑高第二排）。
  function shipmentTile(): any {
    const ship = view.shipments;
    const info = "飞书货件表里的亚马逊货件状态（每天 08:00 北京时间同步）；已完成、已取消的不计";
    if (!ship) return tile({ title: "货件", value: "—", caption: "货件数据暂未取到", link: "shipments", info });
    const statuses: any[] = ship.statuses || [];
    return tile({ title: "货件", value: int(ship.active), caption: ship.active ? "个货件未完成入库" : "没有未完成入库的货件", link: "shipments", info,
      extra: statuses.length ? [h("div", { class: "ship-line" }, statuses.map((item: any, index: number) => [index ? " · " : "", h("span", { class: "nw" }, item.status + " ", numLink(int(item.count), "shipments"))]))] : [] });
  }
  function renderSnapshot(): void {
    const box = document.getElementById("snapshot");
    const kpis = view.kpis || {};
    const sales = kpis.sales, units = kpis.units, orders = kpis.orders;
    const salesTile = tile({ title: "销售额", value: money(sales && sales.value), caption: "今天到目前为止（洛杉矶）", link: "sales", cls: "tall wide",
      extra: [paceLine(sales, true)],
      bottom: [
        sparkline(),
        sales ? h("div", { class: "tile-foot" }, [isNum(sales.avgSameTime) ? "同时段均值 " + money(sales.avgSameTime) : null, isNum(sales.projection) ? "预计全天 ≈ " + money(sales.projection) : null, isNum(sales.yesterday) ? "昨日 " + money(sales.yesterday) : null].filter(Boolean).join(" · ")) : null,
      ] });
    const orderTile = tile({ title: "订单", value: orders ? int(orders.value) : "—", caption: "今天到目前为止", link: "orders", cls: "tall", info: "待处理＝订单表近 30 天里状态为“待处理”的订单数",
      extra: [paceLine(orders, false)],
      bottom: [h("div", { class: "tile-rows" },
        rowLine("销量（件）", units ? int(units.value) : "—"),
        rowLine("昨日订单", orders && isNum(orders.yesterday) ? int(orders.yesterday) : "—"),
        rowLine("昨日销量（件）", units && isNum(units.yesterday) ? int(units.yesterday) : "—"),
        rowLine("亚马逊物流待处理", isNum(view.pendingOrders) ? numLink(int(view.pendingOrders), "pending") : "—"))] });
    const ad = view.adSpend;
    const adTile = tile({ title: "广告花费", value: ad ? money(ad.today) : "—", caption: "今天到目前为止", link: "adSpend", info: "按亚马逊预算消息累计，略有延迟", extra: [
      ad ? h("div", { class: "tile-sub", text: [isNum(ad.shareOfSales) ? "占销售额 " + pct(ad.shareOfSales) : null, isNum(ad.avgDaily) ? "7 日日均 " + money(ad.avgDaily) : null].filter(Boolean).join(" · ") }) : null,
    ] });
    // 跟卖并入推荐报价格（10/07 晚为“货件”腾位置）：有跟卖时这一行标红。
    const featured = view.featured;
    const featuredTile = tile({ title: "推荐报价百分比", value: featured && featured.selling ? Math.round((featured.won / featured.selling) * 100) + "%" : "—", caption: "当前",
      info: "实时：本店美国站在售商品里此刻持有购物车（推荐报价）的比例；跟卖＝当前有其他卖家跟卖的商品数",
      extra: featured ? [h("div", { class: "tile-rows" },
        rowLine("持有购物车", featured.won + " / " + featured.selling),
        rowLine("跟卖", featured.hijacked ? int(featured.hijacked) + " 个商品" : "无", featured.hijacked ? "critical" : "")),
      featured.lost.length ? h("div", { class: "tile-sub tone-text-critical", text: "丢失：" + featured.lost.map((item: any) => item.sku || item.asin).slice(0, 3).join("、") }) : null] : [] });
    const funds = view.funds;
    const next = funds && funds.next;
    const fundsTile = tile({ title: "付款", value: funds ? money(funds.total) : "—", caption: "总余额", link: "funds", extra: [
      funds && isNum(funds.available) ? h("div", { class: "tile-sub", text: "可用 " + money(funds.available) }) : null,
      next ? h("div", { class: "tile-sub" }, "下次放款 ", numLink(money(next.amount), "payouts"), next.date ? " · 预计 " + shortDate(next.date).split(" ")[0] : "") : null,
    ] });
    const stock = view.stockAlerts;
    // 压货一行（2026-10-11）：亚马逊标为冗余的款数与下月仓储估算（含超龄附加费），鼠标停留看冗余的是哪几款。
    const aging = view.aging;
    const agingLine = aging ? h("div", { class: "tile-sub" + (aging.excessSkus ? " tone-text-critical" : ""), title: (aging.excess.length ? "冗余：" + aging.excess.join("、") + "\n" : "") + "下月仓储 " + money(aging.storageNextMonth) + "，其中超龄附加费 " + money(aging.aisNextMonth) + "（亚马逊库存健康报告 " + aging.snapshotDate + "）",
      text: "压货 " + aging.excessSkus + " 款 · 下月仓储 ≈ " + money(aging.storageNextMonth, true) }) : null;
    const stockTile = tile({ title: "库存预警", value: stock ? int(stock.risk + stock.soon) : "—", caption: "个商品需要补货", link: "stock", cls: stock && stock.risk ? "alert" : "", extra: stock ? [
      h("div", { class: "tile-sub", text: "断货风险 " + stock.risk + " · 即将补货 " + stock.soon }),
      stock.items.length ? h("div", { class: "tile-sub muted", title: stock.items.map((item: any) => item.sku + "：" + item.level + "（" + item.reason + "）").join("\n"), text: stock.items.map((item: any) => item.sku).slice(0, 2).join("、") + (stock.items.length > 2 ? " 等" : "") }) : null,
      agingLine,
    ] : [agingLine] });
    const day = view.adDay;
    const adSalesTile = tile({ title: "广告销售", value: day ? money(day.sales) : "—", caption: day ? "昨天（" + monthDay(day.date) + " 完整日）" : "昨天", link: "ads", extra: day ? [h("div", { class: "tile-sub", text: "ACOS " + pct(day.acos) + " · 广告订单 " + int(day.orders) })] : [] });
    const impressionTile = tile({ title: "广告曝光量", value: day ? int(day.impressions) : "—", caption: day ? "昨天（" + monthDay(day.date) + " 完整日）" : "昨天", link: "ads", extra: day ? [h("div", { class: "tile-sub", text: "点击 " + int(day.clicks) + " · 花费 " + money(day.spend) })] : [] });
    // 10/10 用户要求：“广告账单”替换“竞品降价”，并与“付款”互换位置（付款在左、广告账单在最右）。
    setChildren(box, salesTile, orderTile, adTile, featuredTile, fundsTile, billingTile(), stockTile, shipmentTile(), adSalesTile, impressionTile);
  }

  // ---------- 商品绩效 ----------
  const FLAG: any = { due: ["●", "该出未出", "critical"], slow: ["▼", "偏慢", "warning"] };
  const COLUMNS: any[] = [
    { key: "title", label: "商品详情" }, { key: "buyable", label: "状态" }, { key: "todayUnits", label: "今日", num: true },
    { key: "sales30", label: "销售额", num: true }, { key: "units30", label: "售出件数", num: true }, { key: "fulfillable", label: "库存", num: true },
    { key: "price", label: "价格", num: true }, { key: "buyBox", label: "购物车/跟卖" }, { key: "drops", label: "竞品（7 天）" }, { key: "sessions", label: "会话（3 天）", num: true },
  ];
  function sortValue(row: any, key: string): any {
    if (key === "drops") return row.competitor ? row.competitor.drops * 100 + row.competitor.promos : -1;
    if (key === "sessions") return row.sessions && isNum(row.sessions.drop) ? -row.sessions.drop : -9;
    if (key === "buyBox") return (row.buyBox === "lost" ? 2 : 0) + (row.hijackers ? 1 : 0);
    if (key === "buyable") return row.buyable ? 1 : 0;
    if (key === "title") return String(row.title || "").toLowerCase();
    const value = row[key];
    return isNum(value) ? value : -1;
  }
  function visibleProducts(): any[] {
    const query = table.query.trim().toLowerCase();
    const rows = (view.products || []).filter((row: any) => {
      if (table.filter === "buyable" && row.buyable === false) return false;
      if (table.filter === "flagged" && !(row.flag === "due" || row.flag === "slow" || row.buyBox === "lost" || row.hijackers > 0 || row.stockLevel === "FBA断货风险" || row.excessStock)) return false;
      return !query || [row.title, row.sku, row.asin].some((value) => String(value || "").toLowerCase().indexOf(query) >= 0);
    });
    rows.sort((a: any, b: any) => {
      const left = sortValue(a, table.sort), right = sortValue(b, table.sort);
      const order = left < right ? -1 : left > right ? 1 : 0;
      return (table.desc ? -order : order) || String(a.sku).localeCompare(String(b.sku));
    });
    return rows;
  }
  function productCells(row: any): any[] {
    const flag = FLAG[row.flag];
    const explain = isNum(row.expectedSoFar) ? "按平时节奏，此刻应已卖出约 " + dec(row.expectedSoFar, 1) + " 件；7 日日均 " + dec(row.avgDailyUnits, 1) + " 件" : "7 日日均 " + dec(row.avgDailyUnits, 1) + " 件";
    const rival = row.competitor;
    // 每一项整体不折行，只在“ · ”处换行（不会把“降价 2 次”拆成两行）。
    const rivalParts: string[] = !rival ? ["—"] : rival.count === 0 ? ["未跟踪竞品"] : [isNum(rival.minPrice) ? "最低 " + money(rival.minPrice) : "暂无报价", rival.promos ? "促销 " + rival.promos : "", rival.drops ? "降价 " + rival.drops + " 次" : ""].filter(Boolean);
    const sessions = row.sessions;
    const stockChip = row.stockLevel && row.stockLevel !== "正常" && row.stockLevel !== "已停用" ? chip("!", row.stockLevel, row.stockLevel === "FBA断货风险" ? "critical" : "warning", row.stockReason) : null;
    // 压货标记（2026-10-11）：亚马逊标为冗余、或有超 180 天的件（按 15 日库龄收超龄附加费）。
    const agingTip = [isNum(row.storageNextMonth) ? "下月仓储约 " + money(row.storageNextMonth) : null, isNum(row.monthsToClear) ? "按近 30 天约 " + dec(row.monthsToClear, 1) + " 个月卖完" : null].filter(Boolean).join("，");
    const agingChips = [row.excessStock ? chip("▣", "冗余", "warning", agingTip) : null, isNum(row.aged181) && row.aged181 > 0 ? chip("◷", "超龄 " + int(row.aged181), "warning", "超过 180 天的件数" + (agingTip ? "；" + agingTip : "")) : null].filter(Boolean);
    return [
      h("div", { class: "product" },
        row.image ? h("img", { class: "thumb", src: row.image, alt: "", loading: "lazy", referrerpolicy: "no-referrer" }) : h("div", { class: "thumb none", "aria-hidden": "true" }),
        h("div", { class: "product-text" },
          row.links.detail ? link(row.links.detail, row.title, "product-title") : h("div", { class: "product-title", text: row.title }),
          h("div", { class: "meta" }, h("b", { text: "ASIN" }), " " + (row.asin || "—")),
          h("div", { class: "meta" }, h("b", { text: "SKU" }), " " + row.sku + "  ", link(row.links.reviews, "评论")))),
      h("div", null, h("div", { text: row.buyable === false ? "不可售" : row.buyable ? "在售" : "—", class: row.buyable === false ? "muted" : "" }), flag ? h("div", { class: "chips" }, chip(flag[0], flag[1], flag[2], explain)) : null),
      h("div", { class: "nowrap", title: explain }, h("strong", { class: "num", text: int(row.todayUnits) + " 件" }),
        h("div", { class: "muted small", text: isNum(row.expectedSoFar) ? "平时 ≈ " + dec(row.expectedSoFar, 1) + " 件" : "日均 " + dec(row.avgDailyUnits, 1) + " 件" }),
        h("div", { class: "muted small", title: row.lastOrderAt ? "洛杉矶时间 " + row.lastOrderAt : "", text: row.lastOrderAt ? "最近一单 " + ago(row.lastOrderAgoMin) : "30 天内无单" })),
      h("span", { class: "num", text: money(row.sales30, true) }),
      h("span", { class: "num", text: int(row.units30) }),
      // 中文可逐字折行，列宽被挤时会碎成一字一行：这两行不折。
      h("div", null, h("div", { class: "num nowrap" }, isNum(row.fulfillable) ? int(row.fulfillable) + " " : "—", isNum(row.fulfillable) ? h("span", { class: "muted", text: "亚马逊物流" }) : null),
        h("div", { class: "muted small nowrap", text: [isNum(row.inbound) && row.inbound ? "在途 " + int(row.inbound) : null, isNum(row.fbaDays) ? "可售 " + dec(row.fbaDays, 0) + " 天" : null].filter(Boolean).join(" · ") }), stockChip,
        agingChips.length ? h("div", { class: "chips" }, agingChips) : null),
      h("span", { class: "num", text: money(row.price) }),
      h("div", { class: "chips" }, row.buyBox === "won" ? chip("✓", "持有", "good") : row.buyBox === "lost" ? chip("!", "丢失", "critical", row.holder ? "当前持有者 " + row.holder : "") : h("span", { class: "muted", text: "—" }),
        isNum(row.hijackers) && row.hijackers > 0 ? chip("!", "跟卖 " + row.hijackers, "serious") : null),
      h("span", { class: "rival" + (rival && (rival.drops || rival.promos) ? "" : " muted") }, rivalParts.map((part, index) => [index ? " · " : "", h("span", { class: "nw", text: part })])),
      !sessions || !isNum(sessions.drop) ? h("span", { class: "muted", text: "—" })
        : h("span", { title: "近 3 天会话 " + int(sessions.current) + "，基线 " + int(sessions.baseline) + (sessions.evalDay ? "，截至 " + sessions.evalDay : "") }, delta(-sessions.drop, "up"), sessions.status === "alert" ? h("span", { class: "muted", text: " 预警" }) : null),
    ];
  }
  // “大促加密中”标记：原在“竞品降价”格，10/10 那一格换成广告账单后放到商品绩效标题旁（竞品列在这张表里），只在大促窗口出现。
  function renderSaleChip(): void {
    const holder = document.getElementById("sale-chip");
    const sale = view.sale && view.sale.active ? view.sale : null;
    if (holder) setChildren(holder, sale ? chip("%", "大促加密中", "warning", (sale.names || []).join("、") + "：竞品每 2 小时比价一次") : null);
  }
  function renderProducts(): void {
    const box = document.getElementById("products-body");
    const rows = visibleProducts();
    const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
    table.page = clamp(table.page, 0, pages - 1);
    const shown = rows.slice(table.page * PAGE_SIZE, table.page * PAGE_SIZE + PAGE_SIZE);
    const head = h("tr", null, COLUMNS.map((column) => {
      const active = table.sort === column.key;
      return h("th", { scope: "col", class: (column.num ? "num-col " : "") + "sortable" + (active ? " active" : ""), "aria-sort": active ? (table.desc ? "descending" : "ascending") : "none" },
        h("button", { type: "button", class: "sort", onclick: () => { if (table.sort === column.key) table.desc = !table.desc; else { table.sort = column.key; table.desc = column.key !== "title"; } table.page = 0; renderProducts(); } },
          column.label, h("span", { class: "sort-icon", "aria-hidden": "true", text: active ? (table.desc ? "↓" : "↑") : "⇅" })));
    }));
    const body = shown.length ? shown.map((row: any) => h("tr", { class: "flag-" + row.flag + (row.buyBox === "lost" || row.hijackers > 0 ? " flag-offer" : "") }, productCells(row).map((cell, index) => h("td", { "data-label": COLUMNS[index].label, class: COLUMNS[index].num ? "num-col" : "" }, cell))))
      : [h("tr", null, h("td", { colspan: COLUMNS.length, class: "empty-cell", text: (view.products || []).length ? "没有符合条件的商品" : "商品数据暂未取到" }))];
    // 页脚同后台：左侧计数、中间翻页、右侧“前往……”线框按钮（这里打开飞书表）。
    const pager = h("div", { class: "pager" },
      h("span", { class: "pager-count", text: rows.length ? "第 " + (table.page * PAGE_SIZE + 1) + " - " + (table.page * PAGE_SIZE + shown.length) + " 个，共 " + rows.length + " 个" : "共 0 个" }),
      h("div", { class: "pager-buttons" },
        h("button", { type: "button", class: "page-btn arrow", disabled: table.page === 0 ? true : null, "aria-label": "上一页", onclick: () => { table.page -= 1; renderProducts(); }, text: "‹" }),
        Array.from({ length: pages }, (_, index) => h("button", { type: "button", class: "page-btn" + (index === table.page ? " current" : ""), "aria-current": index === table.page ? "page" : null, onclick: () => { table.page = index; renderProducts(); }, text: String(index + 1) })),
        h("button", { type: "button", class: "page-btn arrow", disabled: table.page >= pages - 1 ? true : null, "aria-label": "下一页", onclick: () => { table.page += 1; renderProducts(); }, text: "›" })),
      h("div", { class: "pager-links" }, outlineLink("stock"), outlineLink("profit")));
    setChildren(box, h("div", { class: "table-wrap" }, h("table", { class: "product-table" }, h("thead", null, head), h("tbody", null, body))), pager);
  }
  function setupProductControls(): void {
    const filter = document.getElementById("product-filter");
    const search = document.getElementById("product-search");
    filter.addEventListener("change", () => { table.filter = filter.value; table.page = 0; renderProducts(); });
    const apply = (): void => { table.query = search.value || ""; table.page = 0; renderProducts(); };
    search.addEventListener("input", apply);
    document.getElementById("product-search-btn").addEventListener("click", apply);
  }

  // ---------- 今日走势 ----------
  function legend(items: any[]): any {
    return h("div", { class: "legend" }, items.map((item: any) => h("span", { class: "legend-item" }, h("span", { class: "key " + item[0] + " key-" + item[1], "aria-hidden": "true" }), item[2])));
  }
  function tableToggle(card: any, headers: string[], rows: any[][]): void {
    const data = h("table", { class: "data-table", hidden: true }, h("thead", null, h("tr", null, headers.map((head) => h("th", { scope: "col", text: head })))),
      h("tbody", null, rows.map((row) => h("tr", null, row.map((cell) => h("td", { text: cell }))))));
    const button = h("button", { type: "button", class: "ghost small", "aria-expanded": "false", text: "数据表" });
    button.addEventListener("click", () => { const open = data.hidden; data.hidden = !open; button.setAttribute("aria-expanded", String(open)); button.textContent = open ? "收起数据表" : "数据表"; });
    card.querySelector(".card-head").appendChild(button);
    card.appendChild(data);
  }
  function renderPaceChart(): void {
    const card = document.getElementById("chart-pace");
    setChildren(card, h("div", { class: "card-head" }, h("h2", { text: "今日销售走势" }), legend([["line", "main", "今天累计"], ["line", "gray", "近 7 日同一时刻平均"]])));
    const pace = view.pace;
    if (!pace || !pace.today || !pace.today.length) { card.appendChild(empty("销售数据暂未取到")); return; }
    const W = 640, H = 250, m = { l: 52, r: 64, t: 14, b: 30 };
    const avg: number[] = pace.avg || [];
    const today: number[][] = pace.today;
    const last = today[today.length - 1]!;
    const y0 = scale(Math.max(1, ...avg, ...today.map((point) => point[1]!)), 4);
    const x = (hour: number): number => m.l + (hour / 24) * (W - m.l - m.r);
    const y = (value: number): number => H - m.b - (value / y0.max) * (H - m.t - m.b);
    const svg = s("svg", { viewBox: "0 0 " + W + " " + H, class: "chart", role: "img", "aria-label": "今日累计销售额 " + money(last[1]) + "，近 7 日同一时刻平均 " + money(view.kpis.sales && view.kpis.sales.avgSameTime) });
    for (const tick of y0.ticks) {
      svg.appendChild(s("line", { x1: m.l, x2: W - m.r, y1: y(tick), y2: y(tick), class: tick === 0 ? "axis" : "grid" }));
      svg.appendChild(s("text", { x: m.l - 8, y: y(tick) + 4, class: "tick", "text-anchor": "end" }, axisMoney(tick)));
    }
    for (const hour of [0, 6, 12, 18, 24]) svg.appendChild(s("text", { x: x(hour), y: H - 9, class: "tick", "text-anchor": hour === 0 ? "start" : hour === 24 ? "end" : "middle" }, hour + " 点"));
    svg.appendChild(s("line", { x1: x(last[0]!), x2: x(last[0]!), y1: m.t, y2: H - m.b, class: "now-line" }));
    if (avg.length === 25) {
      svg.appendChild(s("path", { d: avg.map((value, index) => (index ? "L" : "M") + x(index).toFixed(1) + " " + y(value).toFixed(1)).join(" "), class: "line gray" }));
      const avgNow = view.kpis.sales && view.kpis.sales.avgSameTime;
      if (isNum(avgNow)) svg.appendChild(s("circle", { cx: x(last[0]!), cy: y(avgNow), r: 4, class: "dot gray" }));
      svg.appendChild(s("text", { x: W - m.r + 6, y: y(avg[24]!) + 4, class: "end-label muted-text" }, axisMoney(avg[24]!)));
    }
    svg.appendChild(s("path", { d: today.map((point, index) => (index ? "L" : "M") + x(point[0]!).toFixed(1) + " " + y(point[1]!).toFixed(1)).join(" "), class: "line main" }));
    svg.appendChild(s("circle", { cx: x(last[0]!), cy: y(last[1]!), r: 4, class: "dot main" }));
    svg.appendChild(s("text", { x: clamp(x(last[0]!) + 8, m.l, W - m.r + 6), y: y(last[1]!) - 8, class: "end-label" }, money(last[1], true)));
    const cross = s("line", { class: "crosshair", y1: m.t, y2: H - m.b, x1: 0, x2: 0, visibility: "hidden" });
    svg.appendChild(cross);
    const hit = s("rect", { x: m.l, y: m.t, width: W - m.l - m.r, height: H - m.t - m.b, fill: "transparent", tabindex: "0" });
    // 今天只有 0 点到此刻的整点累计；此刻之后的钟点没有值。
    const todayAt = (hour: number): any => { const point = today.find((item) => item[0] === hour); return point ? point[1] : null; };
    hit.addEventListener("pointermove", (event: any) => {
      const box = svg.getBoundingClientRect();
      const hour = clamp(Math.round(((((event.clientX - box.left) / box.width) * W - m.l) / (W - m.l - m.r)) * 24), 0, 24);
      cross.setAttribute("x1", String(x(hour))); cross.setAttribute("x2", String(x(hour))); cross.setAttribute("visibility", "visible");
      showTip(event, hour + ":00 前累计（洛杉矶）", [["今天", money(todayAt(hour)), "main"], ["近 7 日平均", money(avg[hour]), "gray"]]);
    });
    hit.addEventListener("pointerleave", () => { cross.setAttribute("visibility", "hidden"); hideTip(); });
    svg.appendChild(hit);
    card.appendChild(svg);
    const rows: any[][] = [];
    for (let hour = 0; hour <= 24; hour += 3) rows.push([hour + ":00", todayAt(hour) === null ? "—" : money(todayAt(hour)), money(avg[hour])]);
    rows.push(["此刻", money(last[1]), money(view.kpis.sales && view.kpis.sales.avgSameTime)]);
    tableToggle(card, ["截至（洛杉矶）", "今天累计", "近 7 日同时段平均"], rows);
  }

  // ---------- 近 7 天动态 ----------
  const KIND: any = {
    "competitor-price": ["$", "neutral"], "competitor-promo": ["%", "warning"], "competitor-sale": ["%", "warning"], "hijacker-in": ["!", "serious"], "hijacker-out": ["✓", "good"],
    "buybox-lost": ["!", "critical"], "buybox-back": ["✓", "good"], traffic: ["↘", "warning"], inventory: ["▣", "warning"], brand: ["!", "serious"],
    "store-health": ["!", "critical"], "inventory-health": ["◷", "warning"],
  };
  function renderFeed(): void {
    const card = document.getElementById("feed");
    const items: any[] = view.feed || [];
    setChildren(card, h("div", { class: "card-head" }, h("h2", { text: "近 7 天动态" }), h("span", { class: "muted small", text: "竞品、跟卖、购物车、流量、库存、店铺健康" })));
    if (!items.length) { card.appendChild(empty("近 7 天没有新动态")); return; }
    card.appendChild(h("ol", { class: "feed" }, items.map((item) => {
      const kind = KIND[item.kind] || ["•", "neutral"];
      return h("li", null, h("span", { class: "feed-icon tone-" + kind[1], "aria-hidden": "true", text: kind[0] }),
        h("div", { class: "feed-body" }, h("div", { class: "feed-title" }, h("strong", { text: item.title }), h("span", { class: "muted small", title: shortDate(item.at), text: " " + agoIso(item.at) })),
          item.details.map((line: string) => h("div", { class: "muted small", text: line }))));
    })));
  }

  // ---------- 广告 ----------
  function adsValue(metric: any): string {
    if (metric.format === "usd") return money(metric.value);
    if (metric.format === "pct") return pct(metric.value);
    return int(metric.value);
  }
  function campaignTable(title: string, hint: string, rows: any[], columns: any[][]): any {
    const open = feishu("campaigns");
    return h("div", { class: "sub-block" }, h("h3", null, title, h("span", { class: "muted small", text: " " + hint }), open ? numLink(open.label + " ↗", "campaigns") : null),
      rows.length ? h("table", { class: "mini-table" }, h("thead", null, h("tr", null, columns.map((column) => h("th", { scope: "col", text: column[0] })))),
        h("tbody", null, rows.map((row) => h("tr", null, columns.map((column) => h("td", { title: column[0] === "活动" ? row.name : null, text: column[1](row) }))))))
        : h("p", { class: "empty ok" }, h("span", { "aria-hidden": "true", text: "✓ " }), "没有"));
  }
  function renderAds(): void {
    const card = document.getElementById("ads");
    const ads = view.ads;
    setChildren(card, h("div", { class: "card-head" }, h("h2", { text: "广告 · 近 7 个完整日" }),
      h("div", { class: "head-links" }, ads ? h("span", { class: "muted small", text: ads.from.slice(5) + " 至 " + ads.latest.slice(5) + "，对比前 7 天" }) : null, outlineLink("ads"))));
    if (!ads) { card.appendChild(empty("广告数据暂未取到")); return; }
    card.appendChild(h("div", { class: "metric-grid" }, ads.metrics.map((metric: any) => h("div", { class: "metric" },
      h("div", { class: "tile-title", text: metric.label }), h("div", { class: "metric-value" }, valueLink(adsValue(metric), "ads")),
      h("div", { class: "small" }, delta(metric.delta, metric.better), h("span", { class: "muted", text: isNum(metric.prev) ? " 前 7 天 " + adsValue({ format: metric.format, value: metric.prev }) : "" }))))));
    card.appendChild(h("div", { class: "sub-grid" },
      campaignTable("只花钱不出单", "近 7 天花费达标、0 单", ads.noOrder || [], [["活动", (row: any) => row.name], ["花费", (row: any) => money(row.spend)], ["点击", (row: any) => int(row.clicks)], ["曝光", (row: any) => int(row.impressions)]]),
      campaignTable("曝光明显下降", "较前 7 天降超 30%", ads.drops || [], [["活动", (row: any) => row.name], ["近 7 天曝光", (row: any) => int(row.impressions)], ["前 7 天", (row: any) => int(row.prevImpressions)], ["变化", (row: any) => signedPct(-row.drop)]])));
  }

  // ---------- 数据来源 ----------
  function renderSources(): void {
    const sources: any[] = view.sources || [];
    setChildren(document.getElementById("sources-body"), h("table", { class: "mini-table" }, h("thead", null, h("tr", null, ["区块", "更新于", "说明"].map((head) => h("th", { scope: "col", text: head })))),
      h("tbody", null, sources.map((source) => h("tr", null, h("td", { text: source.label }), h("td", { text: source.fetchedAt ? agoIso(source.fetchedAt) : "未取到" }),
        h("td", null, source.error ? h("span", { class: "tone-text-critical", text: source.error + "（显示的是上次取到的数据） " }) : null, h("span", { class: "muted", text: source.note })))))));
    const failed = sources.filter((source) => source.error);
    const banner = document.getElementById("banner");
    banner.hidden = !failed.length;
    banner.textContent = failed.length ? "部分数据暂时取不到：" + failed.map((source) => source.label.split("（")[0] + "（" + source.error + "）").join("；") + "。页面显示的是上次取到的数据。" : "";
  }

  function render(): void {
    renderHeader(); renderSnapshot(); renderSaleChip(); renderProducts(); renderPaceChart(); renderFeed(); renderAds(); renderSources();
  }

  // ---------- 刷新 ----------
  async function refresh(force: boolean): Promise<void> {
    if (refreshing) return;
    refreshing = true;
    lastRefreshAt = Date.now();
    document.body.classList.add("refreshing");
    renderUpdated();
    try {
      const response = await fetch("/api/refresh", { method: "POST", headers: { "content-type": "application/json", "x-portal-refresh": "1" }, body: JSON.stringify({ force }), credentials: "same-origin" });
      if (response.status === 401) { location.reload(); return; }
      if (!response.ok) throw new Error("HTTP " + response.status);
      view = await response.json();
      render();
    } catch (error) {
      const banner = document.getElementById("banner");
      banner.hidden = false;
      banner.textContent = "刷新失败（" + String((error && (error as any).message) || error) + "），稍后自动重试；页面显示的是上次的数据。";
    } finally {
      refreshing = false;
      document.body.classList.remove("refreshing");
      renderUpdated();
    }
  }
  document.getElementById("refresh").addEventListener("click", () => refresh(true));
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && Date.now() - lastRefreshAt > AUTO_REFRESH_MS) refresh(false); });
  window.setInterval(() => { if (document.visibilityState === "visible" && Date.now() - lastRefreshAt >= AUTO_REFRESH_MS) refresh(false); }, 30_000);
  window.setInterval(renderUpdated, 30_000);
  setupProductControls();
  render();
  lastRefreshAt = Date.now();
  if (view.stale && view.stale.length) window.setTimeout(() => refresh(false), 200);
}
