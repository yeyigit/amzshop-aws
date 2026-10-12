// 店铺报告页的浏览器端脚本：整函数以 toString() 内联进页面（带 CSP nonce），必须自包含，不得引用本文件以外的任何符号。
// 所有业务文字一律经 textContent / createTextNode 写入，不拼 innerHTML。切换周期只取 /api/report 的数据原地重绘，并用 history 记下地址。
/* eslint-disable */
declare const document: any;
declare const window: any;
declare const location: any;
declare const history: any;

export function reportClientMain(): void {
  const SVG_NS = "http://www.w3.org/2000/svg";
  const node = document.getElementById("report-data");
  let view: any = JSON.parse((node && node.textContent) || "{}");
  let loading = false;
  const TYPES: any[] = [["day", "日"], ["week", "周"], ["month", "月"], ["year", "年"]];
  const skuTable = { sort: "sales", desc: true };

  // ---------- 工具 ----------
  function append(target: any, children: any[]): void {
    for (const child of children) {
      if (child === undefined || child === null || child === false) continue;
      if (Array.isArray(child)) append(target, child);
      else if (typeof child === "string" || typeof child === "number") target.appendChild(document.createTextNode(String(child)));
      else target.appendChild(child);
    }
  }
  function setChildren(target: any, ...children: any[]): void { target.replaceChildren(); append(target, children); }
  function h(tag: string, props?: any, ...children: any[]): any {
    const element = document.createElement(tag);
    if (props) for (const key of Object.keys(props)) {
      const value = props[key];
      if (value === undefined || value === null || value === false) continue;
      if (key === "class") element.className = value;
      else if (key === "text") element.textContent = String(value);
      else if (key.indexOf("on") === 0) element.addEventListener(key.slice(2), value);
      else element.setAttribute(key, value === true ? "" : String(value));
    }
    append(element, children);
    return element;
  }
  function s(tag: string, attrs?: any, ...children: any[]): any {
    const element = document.createElementNS(SVG_NS, tag);
    if (attrs) for (const key of Object.keys(attrs)) { const value = attrs[key]; if (value !== undefined && value !== null) element.setAttribute(key, String(value)); }
    for (const child of children) if (child !== undefined && child !== null) element.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
    return element;
  }
  const isNum = (value: any): boolean => typeof value === "number" && isFinite(value);
  function money(value: any): string {
    if (!isNum(value)) return "—";
    const text = Math.abs(value).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return (value < 0 ? "−" : "") + "US$" + text;
  }
  const int = (value: any): string => isNum(value) ? Math.round(value).toLocaleString("en-US") : "—";
  const pct = (value: any, digits?: number): string => isNum(value) ? (value < 0 ? "−" : "") + Math.abs(value * 100).toFixed(digits === undefined ? 1 : digits) + "%" : "—";
  function signedPct(value: any): string { if (!isNum(value)) return ""; const rounded = Math.round(value * 1000) / 10; return (rounded > 0 ? "+" : rounded < 0 ? "−" : "±") + Math.abs(rounded).toFixed(1) + "%"; }
  function signedMoney(value: any): string { if (!isNum(value)) return ""; return (value > 0 ? "+" : value < 0 ? "−" : "±") + "US$" + Math.abs(value).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function format(value: any, kind: string): string { return kind === "usd" ? money(value) : kind === "pct" ? pct(value) : kind === "pp" ? (isNum(value) ? value.toFixed(1) + " 个百分点" : "—") : int(value); }
  function beijing(iso: any): string {
    const ms = Date.parse(String(iso || ""));
    if (!isFinite(ms)) return "";
    return new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(ms));
  }
  function card(id: string, title: string, sub?: string, extra?: any): any {
    const element = document.getElementById(id);
    setChildren(element, h("div", { class: "card-head" }, h("div", null, h("h2", { text: title }), sub ? h("div", { class: "card-sub", text: sub }) : null), extra || null));
    element.hidden = false;
    return element;
  }
  function empty(text: string): any { return h("p", { class: "empty", text }); }
  // 涨跌：better=up 涨为好，down 跌为好，neutral 不判好坏；颜色之外总配箭头与文字。
  function delta(cell: any, kind: string, better: string): any {
    if (!cell || (!isNum(cell.diff) && !isNum(cell.pct))) return h("span", { class: "muted", text: (cell ? cell.label : "") + " —" });
    const up = isNum(cell.diff) ? cell.diff > 0.004 : cell.pct > 0, down = isNum(cell.diff) ? cell.diff < -0.004 : cell.pct < 0;
    const good = better === "up" ? up : better === "down" ? down : false, bad = better === "up" ? down : better === "down" ? up : false;
    const amount = kind === "usd" ? signedMoney(cell.diff) : kind === "pct" ? (isNum(cell.diff) ? (cell.diff > 0 ? "+" : cell.diff < 0 ? "−" : "±") + Math.abs(cell.diff * 100).toFixed(1) + " 个百分点" : "") : isNum(cell.diff) ? (cell.diff > 0 ? "+" : cell.diff < 0 ? "−" : "±") + int(Math.abs(cell.diff)) : "";
    return h("span", null, h("span", { class: "muted", text: cell.label + " " }), h("span", { class: "delta tone-" + (good ? "good" : bad ? "critical" : "neutral") }, h("span", { "aria-hidden": "true", text: up ? "▲ " : down ? "▼ " : "" }), amount + (isNum(cell.pct) && kind !== "pct" ? "（" + signedPct(cell.pct) + "）" : "")));
  }

  // ---------- 报告头与切换 ----------
  function renderHead(): void {
    document.title = view.typeName + " " + view.label + " · AMZ中台";
    document.getElementById("report-title").textContent = "店铺" + view.typeName;
    document.getElementById("period-label").textContent = view.label + (view.type === "day" ? "（洛杉矶）" : "");
    const tone = view.status.tone === "final" ? "good" : view.status.tone === "estimate" ? "warning" : "neutral";
    setChildren(document.getElementById("status-chip"), h("span", { class: "chip tone-" + tone }, h("span", { class: "chip-icon", "aria-hidden": "true", text: view.status.tone === "final" ? "✓" : "◷" }), view.status.label));
    const tabs = document.getElementById("tabs");
    setChildren(tabs, TYPES.map((item: any) => h("button", { type: "button", role: "tab", "aria-selected": String(item[0] === view.type), onclick: () => { if (item[0] !== view.type) go(item[0], view.nav.switchTo[item[0]]); }, text: item[1] + "报" })));
    const nav = document.getElementById("period-nav");
    const prev = h("button", { type: "button", "aria-label": "上一期", title: "上一期（←）", disabled: view.nav.prev ? null : true, onclick: () => { if (view.nav.prev) go(view.type, view.nav.prev); }, text: "‹" });
    const next = h("button", { type: "button", "aria-label": "下一期", title: "下一期（→）", disabled: view.nav.next ? null : true, onclick: () => { if (view.nav.next) go(view.type, view.nav.next); }, text: "›" });
    let picker: any;
    if (view.type === "day") {
      picker = h("input", { type: "date", value: view.key, min: view.nav.earliest || null, max: view.nav.latest || null, "aria-label": "选择日期" });
      picker.addEventListener("change", () => { if (/^\d{4}-\d{2}-\d{2}$/.test(picker.value)) go("day", picker.value); });
    } else {
      const options = (view.nav.options || []).slice();
      if (!options.some((item: any) => item.key === view.key)) options.unshift({ key: view.key, label: view.label });
      picker = h("select", { "aria-label": "选择周期" }, options.map((item: any) => h("option", { value: item.key, selected: item.key === view.key ? true : null, text: item.label })));
      picker.addEventListener("change", () => go(view.type, picker.value));
    }
    setChildren(nav, prev, picker, next);
    const line = document.getElementById("status-line");
    const details: string[] = view.status.details || [];
    setChildren(line, view.updatedAt ? h("span", { text: "数据更新于北京时间 " + beijing(view.updatedAt) }) : null,
      details.length ? h("ul", { class: "status-details" }, details.map((item: string) => h("li", { text: item }))) : null);
  }

  // ---------- 核心数与要点 ----------
  const BETTER: any = { units: "up", sales: "up", orderProfit: "up", adSpend: "neutral", expectedProfit: "up" };
  function renderKpis(): void {
    const element = document.getElementById("kpis-card");
    element.replaceChildren();
    if (view.empty) { element.appendChild(h("div", { class: "empty-state", text: "这一期还没有数据" + (view.nav.earliest ? "（最早 " + view.nav.earliest + "，最新 " + view.nav.latest + "）" : "") })); return; }
    element.appendChild(h("div", { class: "kpi-grid" }, view.kpis.map((kpi: any) => h("div", { class: "kpi" },
      h("div", { class: "kpi-label" }, kpi.label, kpi.estimate ? h("span", { class: "est", title: "广告报表到后自动换成实际值", text: "估" }) : null),
      h("div", { class: "kpi-value" + (isNum(kpi.value) && kpi.value < 0 ? " negative" : ""), text: (kpi.estimate && isNum(kpi.value) ? "≈" : "") + (kpi.format === "usd" ? money(kpi.value) : int(kpi.value)) }),
      h("div", { class: "kpi-note", text: kpi.note || "" }),
      h("div", { class: "kpi-compare" }, kpi.compare.map((cell: any) => delta(cell, kpi.format, BETTER[kpi.key])))))));
    element.appendChild(h("div", { class: "metric-row" }, view.metrics.map((metric: any) => h("div", { class: "metric" },
      h("div", { class: "tile-title", text: metric.label }), h("div", { class: "metric-value", text: format(metric.value, metric.format) }),
      h("div", { class: "small" }, metric.compare && metric.compare[0] ? delta(metric.compare[0], metric.format, metric.key === "tacos" || metric.key === "refunds" ? "down" : "up") : null, metric.note ? h("div", { class: "muted", text: metric.note }) : null)))));
    if (view.highlights.length) element.appendChild(h("ul", { class: "highlights", "aria-label": "要点" }, view.highlights.map((text: string) => h("li", { text }))));
  }

  // ---------- 利润拆解 ----------
  function renderWaterfall(): void {
    const wf = view.waterfall;
    const element = card("waterfall", "利润拆解", "费用记为负数；订单毛利、预期毛利" + (view.net ? "、净利润" : "") + "为合计");
    if (!wf) { element.appendChild(empty("订单数据暂未取到")); return; }
    const steps: any[] = wf.steps.slice();
    if (view.net) {
      const net = view.net;
      steps.push({ label: "净退款损失", value: net.refundLoss, kind: "minus", note: "按退款入账日" }, { label: "赔偿与补偿", value: net.reimbursements, kind: "plus" },
        { label: "店铺费用（实际扣费）", value: net.fees, kind: "minus" }, { label: "加回按件仓储费", value: net.storageAddBack, kind: "plus", note: "已用实际仓储费替换" });
      steps.push({ label: "净利润（估）", value: net.netProfit, kind: "result", note: net.pendingNote });
    }
    const max = Math.max(1, ...steps.map((step) => Math.abs(isNum(step.value) ? step.value : 0)));
    element.appendChild(h("ol", { class: "waterfall" }, steps.map((step) => {
      const width = isNum(step.value) ? Math.max(1, (Math.abs(step.value) / max) * 100) : 0;
      // 宽度经 CSSOM 设置：页面 CSP 不允许内联 style 属性。
      const fill = h("span", { class: "wf-fill" });
      fill.style.width = width.toFixed(1) + "%";
      return h("li", { class: "wf-row" + (step.kind === "result" ? " result" : "") + (isNum(step.value) && step.value < 0 && step.kind === "result" ? " negative" : ""), title: step.note || null },
        h("span", { text: step.label }), h("span", { class: "wf-bar", "aria-hidden": "true" }, fill),
        h("span", { class: "wf-value" + (isNum(step.value) && step.value < 0 ? " neg" : ""), text: isNum(step.value) ? money(step.value) : (step.note || "—") }));
    })));
    if (wf.note) element.appendChild(h("div", { class: "wf-note", text: wf.note }));
  }

  // ---------- 流量、广告 ----------
  function metricGrid(id: string, title: string, sub: string, metrics: any[] | null, emptyText: string, columns: string): void {
    const element = card(id, title, sub);
    if (!metrics) { element.appendChild(empty(emptyText)); return; }
    element.appendChild(h("div", { class: "metric-grid " + columns }, metrics.map((metric: any) => h("div", { class: "metric" },
      h("div", { class: "tile-title", text: metric.label }), h("div", { class: "metric-value", text: format(metric.value, metric.format) }),
      h("div", { class: "small" }, metric.compare && metric.compare[0] ? delta(metric.compare[0], metric.format, metric.key === "acos" || metric.key === "tacos" || metric.key === "cpc" ? "down" : metric.key === "spend" ? "neutral" : "up") : null, metric.note ? h("div", { class: "muted", text: metric.note }) : null)))));
  }

  // ---------- 商品明细 ----------
  const SKU_COLUMNS: any[] = [
    ["title", "商品", ""], ["units", "销量", "int"], ["sales", "销售金额", "usd"], ["share", "占比", "pct"], ["promo", "促销", "usd"], ["orderProfit", "订单毛利", "usd"],
    ["adSpend", "广告花费", "usd"], ["acos", "ACOS", "pct"], ["expectedProfit", "预期毛利", "usd"], ["margin", "毛利率", "pct"], ["sessions", "会话", "int"], ["conversion", "转化率", "pct"], ["refundUnits", "退款", "int"], ["unitsDiff", "件数变化", "diff"],
  ];
  function renderSkus(): void {
    const rows: any[] = (view.skus || []).slice();
    const element = card("skus", "商品明细", rows.length ? "共 " + rows.length + " 款" + (isNum(view.unattributedAds) && view.unattributedAds > 0 ? "；另有未归属 SKU 的广告花费 " + money(view.unattributedAds) : "") : "");
    if (!rows.length) { element.appendChild(empty("这一期没有商品数据")); return; }
    rows.sort((a: any, b: any) => {
      const key = skuTable.sort;
      const left = key === "title" ? String(a.sku) : isNum(a[key]) ? a[key] : -Infinity, right = key === "title" ? String(b.sku) : isNum(b[key]) ? b[key] : -Infinity;
      const order = left < right ? -1 : left > right ? 1 : 0;
      return skuTable.desc ? -order : order;
    });
    const head = h("tr", null, SKU_COLUMNS.map((column: any) => {
      const active = skuTable.sort === column[0];
      return h("th", { scope: "col", class: (column[2] ? "num-col" : "") + (active ? " active" : ""), "aria-sort": active ? (skuTable.desc ? "descending" : "ascending") : "none" },
        h("button", { type: "button", class: "sort", onclick: () => { if (skuTable.sort === column[0]) skuTable.desc = !skuTable.desc; else { skuTable.sort = column[0]; skuTable.desc = column[0] !== "title"; } renderSkus(); } }, column[1], h("span", { class: "sort-icon", "aria-hidden": "true", text: active ? (skuTable.desc ? "↓" : "↑") : "⇅" })));
    }));
    const body = rows.map((row: any) => h("tr", null, SKU_COLUMNS.map((column: any) => {
      const key = column[0];
      if (key === "title") {
        return h("td", { "data-label": column[1] }, h("div", { class: "sku-cell" },
          row.image ? h("img", { class: "thumb", src: row.image, alt: "", loading: "lazy", referrerpolicy: "no-referrer" }) : h("div", { class: "thumb none", "aria-hidden": "true" }),
          h("div", { class: "product-text" }, h("span", { class: "name", title: row.title || row.sku, text: row.title || row.sku }),
            h("div", { class: "meta" }, h("b", { text: "SKU" }), " " + row.sku + (row.asin ? "  ·  " + row.asin : "")),
            h("div", { class: "chips" }, row.clearance ? h("span", { class: "chip tone-warning" }, h("span", { class: "chip-icon", "aria-hidden": "true", text: "!" }), "清货") : null,
              row.adEstimate ? h("span", { class: "est", text: "广告估" }) : null, row.estimatedLines ? h("span", { class: "muted small", title: "费用未到账，按成本表预估", text: row.estimatedLines + " 行预估" }) : null,
              row.costMissing ? h("span", { class: "chip tone-critical", title: "缺成本参数，未计入毛利" }, h("span", { class: "chip-icon", text: "!" }), "缺成本") : null))));
      }
      const value = row[key];
      let text = column[2] === "diff" ? (isNum(value) ? (value > 0 ? "+" : value < 0 ? "−" : "±") + Math.abs(value) : "—") : column[2] === "usd" ? money(value) : column[2] === "pct" ? pct(value) : int(value);
      if (key === "sessions" && row.sharedAsin && isNum(value)) text += "*";
      return h("td", { "data-label": column[1], class: "num-col" + (isNum(value) && value < 0 && (key === "expectedProfit" || key === "orderProfit" || key === "margin") ? " neg" : ""), text });
    })));
    element.appendChild(h("div", { class: "table-wrap" }, h("table", { class: "report-table cards" }, h("thead", null, head), h("tbody", null, body))));
    if (rows.some((row: any) => row.sharedAsin)) element.appendChild(h("div", { class: "section-note", text: "* 同一个 ASIN 下有多个 SKU，会话与转化按 ASIN 计。" }));
  }

  // ---------- 趋势 ----------
  function renderTrend(): void {
    const points: any[] = (view.trend && view.trend.points) || [];
    const unit = view.trend ? view.trend.unit : "day";
    const element = card("trend", unit === "month" ? "逐月趋势" : unit === "week" ? "近 8 周趋势" : view.type === "month" ? "本月逐日" : "近 14 天趋势", "柱：销售金额；线：预期毛利");
    if (!points.length) { element.appendChild(empty("暂无趋势数据")); return; }
    const W = 1100, H = 260, m = { l: 60, r: 16, t: 14, b: 30 };
    const values = points.flatMap((point: any) => [point.sales, point.expectedProfit]).filter(isNum);
    const top = Math.max(1, ...values), bottom = Math.min(0, ...values);
    const x = (index: number): number => m.l + (index + 0.5) * ((W - m.l - m.r) / points.length);
    const y = (value: number): number => H - m.b - ((value - bottom) / (top - bottom)) * (H - m.t - m.b);
    const band = (W - m.l - m.r) / points.length;
    const svg = s("svg", { viewBox: "0 0 " + W + " " + H, class: "trend-chart", role: "img", "aria-label": "销售金额与预期毛利趋势" });
    for (const tick of [bottom, (top + bottom) / 2, top]) {
      svg.appendChild(s("line", { x1: m.l, x2: W - m.r, y1: y(tick), y2: y(tick), class: "grid" }));
      svg.appendChild(s("text", { x: m.l - 6, y: y(tick) + 4, class: "tick", "text-anchor": "end" }, (tick < 0 ? "−$" : "$") + Math.abs(Math.round(tick)).toLocaleString("en-US")));
    }
    if (bottom < 0) svg.appendChild(s("line", { x1: m.l, x2: W - m.r, y1: y(0), y2: y(0), class: "zero" }));
    points.forEach((point: any, index: number) => {
      if (isNum(point.sales)) svg.appendChild(s("rect", { x: x(index) - band * 0.32, y: y(Math.max(0, point.sales)), width: band * 0.64, height: Math.abs(y(0) - y(point.sales)), class: "bar" + (point.current ? " current" : ""), rx: 2 }));
      const every = Math.ceil(points.length / 8);
      if (index % every === 0 || index === points.length - 1) svg.appendChild(s("text", { x: x(index), y: H - 9, class: "tick", "text-anchor": "middle" }, point.label));
    });
    const profit = points.map((point: any, index: number) => isNum(point.expectedProfit) ? [x(index), y(point.expectedProfit)] : null).filter(Boolean) as number[][];
    if (profit.length > 1) svg.appendChild(s("path", { d: profit.map((point, index) => (index ? "L" : "M") + point[0]!.toFixed(1) + " " + point[1]!.toFixed(1)).join(" "), class: "profit" }));
    for (const point of profit) svg.appendChild(s("circle", { cx: point[0], cy: point[1], r: 2.5, class: "profit-dot" }));
    element.appendChild(svg);
    element.appendChild(h("div", { class: "table-wrap" }, h("table", { class: "report-table" }, h("thead", null, h("tr", null, ["期", "销售金额", "预期毛利", "广告花费", "件数"].map((label) => h("th", { scope: "col", class: label === "期" ? "" : "num-col", text: label })))),
      h("tbody", null, points.slice().reverse().slice(0, 14).map((point: any) => h("tr", null, h("td", { text: point.label + (point.partial ? "（进行中）" : "") }), h("td", { class: "num-col", text: money(point.sales) }), h("td", { class: "num-col" + (isNum(point.expectedProfit) && point.expectedProfit < 0 ? " neg" : ""), text: money(point.expectedProfit) }), h("td", { class: "num-col", text: money(point.adSpend) }), h("td", { class: "num-col", text: int(point.units) })))))));
  }

  // ---------- 逐日 / 逐月 ----------
  function renderRows(): void {
    const element = document.getElementById("rows");
    const rows: any[] = view.rows || [];
    if (!rows.length) { element.hidden = true; return; }
    const target = card("rows", view.type === "year" ? "逐月明细" : "逐日明细", "点日期可打开当天的日报");
    target.appendChild(h("div", { class: "table-wrap" }, h("table", { class: "report-table cards" },
      h("thead", null, h("tr", null, ["日期", "销量", "订单", "销售金额", "订单毛利", "广告花费", "预期毛利", "会话", "转化率", "退款", "状态"].map((label, index) => h("th", { scope: "col", class: index ? "num-col" : "", text: label })))),
      h("tbody", null, rows.map((row: any) => h("tr", null,
        h("td", { "data-label": "日期" }, h("a", { class: "link", href: "/report/" + (view.type === "year" ? "month" : "day") + "/" + row.key, onclick: (event: any) => { event.preventDefault(); go(view.type === "year" ? "month" : "day", row.key); }, text: row.label })),
        h("td", { "data-label": "销量", class: "num-col", text: int(row.units) }), h("td", { "data-label": "订单", class: "num-col", text: int(row.orders) }),
        h("td", { "data-label": "销售金额", class: "num-col", text: money(row.sales) }), h("td", { "data-label": "订单毛利", class: "num-col", text: money(row.orderProfit) }),
        h("td", { "data-label": "广告花费", class: "num-col", text: (row.adEstimate ? "≈" : "") + money(row.adSpend) }), h("td", { "data-label": "预期毛利", class: "num-col" + (isNum(row.expectedProfit) && row.expectedProfit < 0 ? " neg" : ""), text: money(row.expectedProfit) }),
        h("td", { "data-label": "会话", class: "num-col", text: int(row.sessions) }), h("td", { "data-label": "转化率", class: "num-col", text: pct(row.conversion) }),
        h("td", { "data-label": "退款", class: "num-col", text: int(row.refundUnits) }), h("td", { "data-label": "状态", class: "num-col muted", text: row.status })))))));
  }

  // ---------- 店铺费用（月、年） ----------
  function renderFees(): void {
    const element = document.getElementById("fees");
    const fees = view.fees;
    if (!fees) { element.hidden = true; return; }
    const target = card("fees", "店铺费用（账户其他资金流水）", "FBA/AWD 月度仓储费按所属月份；其余按扣费日；广告扣款不计（广告按报表计）");
    const rows: any[] = fees.lines.map((line: any) => [line.label, money(line.amount), line.months]);
    rows.push(["合计（美元）", money(fees.usdTotal), ""]);
    rows.push(["赔偿与补偿", money(fees.reimbursements), "计入净利润"]);
    for (const item of fees.nonUsd) rows.push([item.label, item.amount.toFixed(2) + " " + item.currency, "非美元，单列不折算"]);
    for (const item of fees.unclassified) rows.push(["待分类｜" + item.label, item.amount.toFixed(2) + " " + item.currency, "不计入"]);
    if (fees.adsInvoice) rows.push(["广告扣款（参考）", money(fees.adsInvoice), "不计入：广告已按报表计"]);
    target.appendChild(h("div", { class: "table-wrap" }, h("table", { class: "report-table" }, h("tbody", null, rows.map((row) => h("tr", null, h("td", { text: row[0] }), h("td", { class: "num-col", text: row[1] }), h("td", { class: "muted", text: row[2] })))))));
    if (fees.storagePending.length) target.appendChild(h("div", { class: "section-note", text: fees.storagePending.join("；") }));
  }

  // ---------- 退款与动态 ----------
  function renderRefunds(): void {
    const refunds = view.refunds;
    const element = card("refunds", "退款", "按退款入账日（洛杉矶）");
    if (!refunds) { element.appendChild(empty("退款数据暂未取到")); return; }
    element.appendChild(h("div", { class: "metric-grid three" }, refunds.metrics.map((metric: any) => h("div", { class: "metric" },
      h("div", { class: "tile-title", text: metric.label }), h("div", { class: "metric-value", text: format(metric.value, metric.format) }), metric.note ? h("div", { class: "muted small", text: metric.note }) : null))));
    if (refunds.reasons.length) element.appendChild(h("ul", { class: "event-list" }, refunds.reasons.map((item: any) => h("li", null, h("strong", { text: item.sku }), h("span", { class: "muted", text: item.text })))));
  }
  function renderEvents(): void {
    const events = view.events;
    const element = card("events", "本期动态", "系统已发出的业务消息");
    if (!events || !events.counts.length) { element.appendChild(empty("这一期没有跟卖、购物车、竞品、流量或库存消息")); return; }
    element.appendChild(h("div", { class: "chips-row" }, events.counts.map((item: any) => h("span", { class: "chip tone-neutral" }, item.label + " " + item.count))));
    if (events.items.length) element.appendChild(h("ul", { class: "event-list" }, events.items.slice(0, 12).map((item: any) => h("li", null, h("strong", { text: item.title }), h("span", { class: "muted", text: beijing(item.at) + (item.details[0] ? " · " + item.details[0] : "") })))));
  }

  // ---------- 库存（周、月、年） ----------
  function renderInventory(): void {
    const element = document.getElementById("inventory");
    const inventory = view.inventory;
    if (!inventory || !inventory.rows.length) { element.hidden = true; return; }
    const target = card("inventory", "期末库存", "库存预警表（每天北京 09:00 同步），取本期最后一次快照");
    target.appendChild(h("div", { class: "table-wrap" }, h("table", { class: "report-table cards" },
      h("thead", null, h("tr", null, ["SKU", "FBA 可售", "在途", "AWD", "可售天数", "预警"].map((label, index) => h("th", { scope: "col", class: index ? "num-col" : "", text: label })))),
      h("tbody", null, inventory.rows.map((row: any) => h("tr", null, h("td", { "data-label": "SKU", text: row.sku }), h("td", { "data-label": "FBA 可售", class: "num-col", text: int(row.fba) }), h("td", { "data-label": "在途", class: "num-col", text: int(row.inbound) }),
        h("td", { "data-label": "AWD", class: "num-col", text: int(row.awd) }), h("td", { "data-label": "可售天数", class: "num-col" + (isNum(row.days) && row.days < 14 ? " neg" : ""), text: isNum(row.days) ? Math.round(row.days) + " 天" : "—" }), h("td", { "data-label": "预警", class: "num-col", text: row.level || "" })))))));
  }

  function renderChecks(): void {
    const items: string[] = view.checks || [];
    setChildren(document.getElementById("checks-body"), items.length ? h("ul", { class: "check-list" }, items.map((text) => h("li", { text }))) : h("p", { class: "empty", text: "没有需要说明的差异" }),
      h("p", { class: "section-note", text: "口径：销售数量、金额、订单取亚马逊销售接口（不含已取消，与后台一致）；订单毛利＝订单表「预期毛利」逐行（费用未到账的行扣订单报告里的实际促销折扣，仓储费按下单月份费率）；广告取 SP 广告报表；会话、转化取亚马逊业务报告。每天的数据第 20 天定稿，月报次月 22 日定稿。" }));
  }

  function render(): void {
    renderHead(); renderKpis(); renderWaterfall();
    metricGrid("traffic", "流量与转化", "亚马逊业务报告口径" + (view.type === "day" ? "，次日出数" : ""), view.traffic, "会话与转化：亚马逊次日出数", "three");
    metricGrid("ads", "广告（SP）", "按点击日；广告销售额为 7 天归因", view.ads, "广告数据暂未取到", "four");
    renderSkus(); renderTrend(); renderRows(); renderFees(); renderRefunds(); renderEvents(); renderInventory(); renderChecks();
  }

  // ---------- 切换周期 ----------
  async function go(type: string, key: string, replace?: boolean): Promise<void> {
    if (loading || !type || !key) return;
    loading = true;
    document.body.classList.add("loading");
    const banner = document.getElementById("banner");
    try {
      const response = await fetch("/api/report?type=" + encodeURIComponent(type) + "&period=" + encodeURIComponent(key), { credentials: "same-origin" });
      if (response.status === 401) { location.href = "/report/" + type + "/" + key; return; }
      if (!response.ok) throw new Error("HTTP " + response.status);
      view = await response.json();
      const path = "/report/" + view.type + "/" + view.key;
      if (replace) history.replaceState({ type: view.type, key: view.key }, "", path); else history.pushState({ type: view.type, key: view.key }, "", path);
      banner.hidden = true;
      render();
      window.scrollTo(0, 0);
    } catch (error) {
      banner.hidden = false;
      banner.textContent = "切换失败（" + String((error && (error as any).message) || error) + "），请稍后再试。";
    } finally {
      loading = false;
      document.body.classList.remove("loading");
    }
  }
  window.addEventListener("popstate", (event: any) => { const state = event.state; if (state && state.type && state.key) go(state.type, state.key, true); else location.reload(); });
  document.addEventListener("keydown", (event: any) => {
    const tag = String((event.target && event.target.tagName) || "").toLowerCase();
    if (tag === "input" || tag === "select" || tag === "textarea" || event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === "ArrowLeft" && view.nav.prev) go(view.type, view.nav.prev);
    if (event.key === "ArrowRight" && view.nav.next) go(view.type, view.nav.next);
  });
  history.replaceState({ type: view.type, key: view.key }, "", location.pathname);
  render();
}
