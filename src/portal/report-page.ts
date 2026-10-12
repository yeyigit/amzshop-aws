import { reportClientMain } from "./report-client.js";
import { brand, embedJson, escapeHtml, head } from "./page.js";
import type { ReportView } from "../report/view.js";

// 店铺报告页（2026-10-09）：与中台首页同一套样式与安全头；页面内嵌这一期的数据，切换周期时只取数据原地重绘（地址栏同步）。
const REPORT_CSS = String.raw`
main.report{max-width:1320px}
.report-head{padding:12px 16px 10px}
.report-title{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.report-title h1{font-size:20px;line-height:28px;margin:0;color:var(--ink)}
.report-title .period{font-size:16px;color:var(--ink-body);font-weight:600}
.period-bar{display:flex;align-items:center;justify-content:space-between;gap:10px 16px;flex-wrap:wrap;margin-top:10px}
.tabs{display:inline-flex;border:1px solid var(--input);border-radius:6px;overflow:hidden}
.tabs button{border:none;background:var(--surface);color:var(--ink-body);padding:5px 16px;cursor:pointer;font-size:14px}
.tabs button+button{border-left:1px solid var(--input)}
.tabs button[aria-selected="true"]{background:var(--head);color:var(--head-ink);font-weight:700}
.period-nav{display:flex;align-items:center;gap:6px}
.period-nav button{min-width:32px;height:32px;border:1px solid var(--input);border-radius:6px;background:var(--surface);color:var(--ink-body);cursor:pointer;font-size:16px}
.period-nav button:disabled{color:var(--muted);cursor:default;opacity:.5}
.period-nav input,.period-nav select{height:32px;border:1px solid var(--input);border-radius:6px;background:var(--surface);color:var(--ink-body);padding:0 8px;max-width:220px}
.status-line{margin-top:8px;color:var(--ink-2);font-size:13px;display:flex;gap:6px 10px;flex-wrap:wrap;align-items:center}
.status-line .chip{font-size:12px}
.status-details{margin:4px 0 0;padding-left:18px;color:var(--ink-2);font-size:12px}
.kpi-grid{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:1px;background:var(--border);border-radius:10px 10px 0 0;overflow:hidden}
.kpi{background:var(--surface);padding:10px 14px 12px;min-width:0}
.kpi-label{font-size:13px;color:var(--ink);display:flex;gap:6px;align-items:center}
.kpi-value{font-size:24px;font-weight:700;line-height:32px;margin-top:2px;color:var(--ink);font-variant-numeric:tabular-nums;white-space:nowrap}
.kpi-value.negative{color:var(--critical-text)}
.kpi-note{color:var(--muted);font-size:12px;margin-top:2px;min-height:16px}
.kpi-compare{font-size:12px;color:var(--ink-2);margin-top:4px;display:grid;gap:2px}
.est{display:inline-block;font-size:11px;line-height:16px;padding:0 6px;border-radius:999px;background:color-mix(in srgb,var(--warning) 14%,transparent);color:var(--warning);font-weight:600}
.metric-row{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:1px;background:var(--border);border-top:1px solid var(--border)}
.metric-grid.three{grid-template-columns:repeat(3,minmax(0,1fr))}
.metric-grid.four{grid-template-columns:repeat(4,minmax(0,1fr))}
.metric-row .metric{padding:8px 14px 10px}
.highlights{list-style:none;margin:0;padding:10px 16px 12px;display:grid;gap:6px;border-top:1px solid var(--border)}
.highlights li{font-size:14px;color:var(--ink-body);padding-left:16px;position:relative}
.highlights li::before{content:"•";position:absolute;left:2px;color:var(--link)}
.waterfall{list-style:none;margin:0;padding:10px 16px 14px;display:grid;gap:4px}
.wf-row{display:grid;grid-template-columns:minmax(120px,190px) minmax(0,1fr) 110px;align-items:center;gap:10px;font-size:13px}
.wf-row.result{font-weight:700;color:var(--ink)}
.wf-bar{height:14px;position:relative;background:transparent}
.wf-fill{position:absolute;top:0;height:14px;border-radius:3px;background:var(--series-2)}
.wf-row.result .wf-fill{background:var(--series)}
.wf-row.negative .wf-fill{background:var(--critical)}
.wf-value{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.wf-note{color:var(--muted);font-size:12px;padding:0 16px 12px}
.section-note{color:var(--muted);font-size:12px;padding:6px 16px 12px}
.report-table{width:100%;border-collapse:collapse;font-size:13px}
.report-table td,.report-table th{padding:7px 10px;white-space:nowrap}
.report-table td.text{white-space:normal;min-width:180px}
.report-table .neg{color:var(--critical-text)}
.sku-cell{display:flex;gap:8px;align-items:center;min-width:220px;max-width:360px}
.sku-cell .thumb{width:36px;height:36px}
.sku-cell .name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:block;max-width:300px}
.chips-row{display:flex;gap:6px;flex-wrap:wrap;padding:10px 16px}
.event-list{list-style:none;margin:0;padding:0 16px 12px;display:grid;gap:6px;font-size:13px}
.event-list .muted{margin-left:6px}
.check-list{margin:0;padding:8px 16px 12px 34px;display:grid;gap:4px;font-size:13px;color:var(--ink-body)}
.trend-chart{width:100%;height:auto;display:block;padding:8px 16px 4px;max-height:300px}
.trend-chart .grid{stroke:var(--grid);stroke-width:1}.trend-chart .tick{fill:var(--tick);font-size:11px}
.trend-chart .bar{fill:var(--series-2)}.trend-chart .bar.current{fill:var(--series)}
.trend-chart .profit{fill:none;stroke:var(--link);stroke-width:2}.trend-chart .profit-dot{fill:var(--link)}
.trend-chart .zero{stroke:var(--border);stroke-width:1}
.empty-state{padding:32px 16px;text-align:center;color:var(--ink-2)}
body.loading main .card{opacity:.6;transition:opacity .15s}
@media (max-width:1100px){.kpi-grid{grid-template-columns:repeat(3,minmax(0,1fr))}.metric-row{grid-template-columns:repeat(3,minmax(0,1fr))}.kpi-grid .kpi:last-child:nth-child(3n+2){grid-column:span 2}}
@media (max-width:860px){.kpi-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.kpi-grid .kpi:last-child:nth-child(odd){grid-column:1/-1}.kpi-value{font-size:20px;line-height:28px}.metric-row,.metric-grid.three,.metric-grid.four{grid-template-columns:repeat(2,minmax(0,1fr))}
.wf-row{grid-template-columns:minmax(96px,120px) minmax(0,1fr) 90px}.period-nav{width:100%}.period-nav input,.period-nav select{flex:1;max-width:none}
.report-table.cards thead{display:none}.report-table.cards,.report-table.cards tbody,.report-table.cards tr,.report-table.cards td{display:block;width:100%}
.report-table.cards tr{border:1px solid var(--border);border-radius:8px;margin:0 0 10px;padding:6px 12px;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));column-gap:16px}
.report-table.cards td{border:none;padding:3px 0;display:flex;justify-content:space-between;gap:8px;white-space:normal;min-width:0}
.report-table.cards td:first-child{grid-column:1/-1}
.report-table.cards td::before{content:attr(data-label);color:var(--muted);font-size:12px}
.report-table.cards td:first-child::before{display:none}.sku-cell{max-width:none}}
`;

export function renderReportPage(view: ReportView, nonce: string, appTitle: string, user: { name: string; avatar: string }): string {
  const script = `(${reportClientMain.toString()})();`.replace(/<\/script/gi, "<\\/script");
  const title = `${view.typeName} ${view.label} · ${appTitle}`;
  return `${head(nonce, title, REPORT_CSS)}<body>
<header class="top">
${brand(appTitle)}
<nav class="top-nav" aria-label="页面"><a href="/">首页</a><a href="/report" aria-current="page">报告</a></nav>
<div class="spacer"></div>
<div class="user">${user.avatar ? `<img src="${escapeHtml(user.avatar)}" alt="" class="avatar" referrerpolicy="no-referrer">` : ""}<span>${escapeHtml(user.name)}</span></div>
</header>
<main class="report">
<section class="card report-head" aria-labelledby="report-title">
<div class="report-title"><h1 id="report-title"></h1><span class="period" id="period-label"></span><span id="status-chip"></span></div>
<div class="period-bar"><div class="tabs" role="tablist" id="tabs"></div><div class="period-nav" id="period-nav"></div></div>
<div class="status-line" id="status-line"></div>
</section>
<div class="banner" id="banner" role="status" hidden></div>
<section class="card" id="kpis-card"></section>
<section class="card" id="waterfall"></section>
<section class="duo"><div class="card" id="traffic"></div><div class="card" id="ads"></div></section>
<section class="card" id="skus"></section>
<section class="card" id="trend"></section>
<section class="card" id="rows" hidden></section>
<section class="card" id="fees" hidden></section>
<section class="duo"><div class="card" id="refunds"></div><div class="card" id="events"></div></section>
<section class="card" id="inventory" hidden></section>
<details class="card" id="checks"><summary>数据核对与说明</summary><div id="checks-body"></div></details>
</main>
<script type="application/json" id="report-data">${embedJson(view)}</script>
<script nonce="${nonce}">${script}</script>
</body></html>`;
}
