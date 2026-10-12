import { clientMain } from "./client.js";
import { DEFAULT_TITLE, type PortalView } from "./view.js";

// 店铺中台的 HTML：单页、内联样式与脚本（带 nonce），不加载外部脚本与字体（国内访问 CDN 不稳定）；商品主图直接用亚马逊图片地址。
// 样式按卖家后台首页（用户 10/07 要求）：深色顶栏、白底细边框卡片、“全局快照”指标格之间用细线分隔、青色链接、商品表带主图与排序。
// 浅色配色逐像素取自用户 10/07 给的新版卖家后台截图；截图里没有的顶栏、状态色与深色模式沿用原设计。
const DARK = `color-scheme:dark;--page:#0f1418;--surface:#171e24;--surface-2:#1e262d;--surface-3:#28323b;
--ink:#e3eef0;--ink-body:#dde3e8;--ink-2:#a9b4bf;--label:#c2cbd3;--muted:#8b97a2;--meta:#97a0a8;--border:#2e3a44;--rule:#29333c;--grid:#26303a;--tick:#8b97a2;
--link:#4fc3d6;--link-2:#5cc6d8;--outline:#5fb3c4;--input:#5d6973;--search:#3f4a59;--head:#0b1014;--head-2:#1d2730;--series:#e3eef0;--series-2:#6b7782;
--good:#3fbf9a;--warning:#ff9a3d;--serious:#ffa34d;--critical:#ff5c7a;--good-text:#3fbf9a;--critical-text:#ff7a90`;
export const CSS = String.raw`
:root{color-scheme:light;--page:#fafafa;--surface:#fff;--surface-2:#f7f7f8;--surface-3:#ebeced;
--ink:#002f36;--ink-body:#232f3e;--ink-2:#5e6a78;--label:#3f4a59;--muted:#86919c;--meta:#8a8a8a;--border:#d5dbdb;--rule:#d3d5d8;--grid:#e5e5e5;--tick:#727272;
--link:#008296;--link-2:#007587;--outline:#3c8093;--input:#868d95;--search:#3f4a59;--head:#232f3e;--head-2:#37475a;--head-ink:#fff;--head-muted:#ccd2d6;--brand:#ff9900;
--series:#002f36;--series-2:#a2a9b1;--good:#067d62;--warning:#c45500;--serious:#e47911;--critical:#cc0c39;--good-text:#067d62;--critical-text:#cc0c39}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){${DARK}}}
:root[data-theme="dark"]{${DARK}}
*{box-sizing:border-box}
html,body{margin:0;background:var(--page);color:var(--ink-body)}
body{font:14px/1.43 "Amazon Ember",Arial,"PingFang SC","Microsoft YaHei",sans-serif;-webkit-font-smoothing:antialiased}
figure{margin:0}
button,input,select{font:inherit;color:inherit}
a.link{color:var(--link);text-decoration:none}a.link:hover{text-decoration:underline}
a.num-link{color:var(--link-2);text-decoration:none}a.num-link:hover{text-decoration:underline}
a.value-link{color:inherit;text-decoration:none}a.value-link:hover{color:var(--link-2);text-decoration:underline}
.btn-outline{display:inline-flex;align-items:center;height:30px;padding:0 12px;border:1px solid var(--outline);border-radius:4px;background:var(--surface);color:var(--outline);text-decoration:none;font-size:13px;white-space:nowrap}
.btn-outline:hover{background:var(--surface-2)}
.top{display:flex;align-items:center;gap:14px;padding:0 20px;height:48px;background:var(--head);color:var(--head-ink);position:sticky;top:0;z-index:5}
.brand{display:flex;align-items:center;gap:8px;font-weight:700;font-size:16px;white-space:nowrap}
.brand-mark{width:22px;height:22px;border-radius:4px;background:var(--brand);display:inline-flex;align-items:center;justify-content:center;color:#232f3e;font-size:13px;font-weight:800}
.clocks{color:var(--head-muted);font-size:13px;display:flex;gap:8px;flex-wrap:wrap}.clocks strong{color:var(--head-ink);font-weight:600}.sep{opacity:.5}
.spacer{flex:1}
.top-nav{display:flex;gap:4px}.top-nav a{color:var(--head-muted);text-decoration:none;font-size:14px;padding:4px 10px;border-radius:6px;white-space:nowrap}
.top-nav a:hover{background:var(--head-2);color:var(--head-ink)}.top-nav a[aria-current="page"]{color:var(--head-ink);font-weight:700;background:var(--head-2)}
.status{display:flex;align-items:center;gap:10px;color:var(--head-muted);font-size:13px;white-space:nowrap}
.top .ghost{border:1px solid rgba(255,255,255,.45);background:transparent;color:var(--head-ink);border-radius:8px;padding:4px 12px;cursor:pointer;box-shadow:none}
.top .ghost:hover{background:var(--head-2)}
.user{display:flex;align-items:center;gap:8px;font-size:13px;color:var(--head-ink);white-space:nowrap}
.avatar{width:26px;height:26px;border-radius:50%;object-fit:cover}
.ghost{border:1px solid var(--outline);background:var(--surface);color:var(--outline);border-radius:4px;padding:3px 12px;cursor:pointer}
.ghost:hover{background:var(--surface-2)}.ghost.small{padding:1px 10px;font-size:12px}
:focus-visible{outline:2px solid var(--link);outline-offset:2px}
main{max-width:1440px;margin:0 auto;padding:12px 24px 32px;display:grid;grid-template-columns:minmax(0,1fr);gap:12px}
.notice{color:var(--ink-2);font-size:14px}.notice strong{color:var(--ink)}
.banner{border:1px solid var(--warning);border-left-width:4px;background:var(--surface);border-radius:8px;padding:10px 14px;font-size:13px}
.health-strip{border:1px solid var(--critical);border-left-width:4px;background:color-mix(in srgb,var(--critical) 6%,var(--surface));border-radius:8px;padding:10px 14px;font-size:13px;color:var(--ink)}.health-strip strong{color:var(--critical-text)}
.card{background:var(--surface);border:1px solid var(--border);border-radius:10px;min-width:0}
.card-head{display:flex;align-items:center;justify-content:space-between;gap:8px 12px;flex-wrap:wrap;padding:8px 16px;border-bottom:1px solid var(--border)}
.card-head h2{font-size:16px;line-height:22px;margin:0;font-weight:700;color:var(--ink)}
.title-line{display:flex;align-items:center;gap:8px}.card-sub{color:var(--ink-2);font-size:13px;margin-top:2px}
.head-links{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.snapshot{display:grid;grid-template-columns:minmax(0,1.5fr) minmax(0,1.1fr) repeat(4,minmax(0,1fr));gap:1px;background:var(--border);border-radius:0 0 10px 10px;overflow:hidden}
.tile{background:var(--surface);padding:8px 12px 10px;min-width:0;display:flex;flex-direction:column}
.tile.tall{grid-row:span 2}
.tile-bottom{margin-top:auto;padding-top:6px}.tile-bottom>.spark,.tile-bottom>.tile-rows{margin-top:0}
.tile-head{display:flex;align-items:flex-start;justify-content:space-between;gap:6px}
.tile-title{font-size:13px;color:var(--ink);display:flex;align-items:center;gap:6px}
.tile-open{color:var(--link-2);text-decoration:none;font-size:13px;line-height:18px;padding:0 4px;border-radius:4px;flex:none}.tile-open:hover{background:var(--surface-2)}
.info{color:var(--ink-2);font-size:12px;cursor:help}
.tile-value{font-size:20px;font-weight:700;line-height:26px;margin-top:4px;color:var(--ink);letter-spacing:-.01em}
.tile.wide .tile-value{font-size:24px;line-height:30px}
.tile-caption{color:var(--muted);font-size:12px}
.tile-sub{color:var(--ink-2);font-size:12px;margin-top:2px}
.tile-foot{color:var(--ink-2);font-size:12px;margin-top:4px}
.tile-delta{font-size:13px;margin-top:4px;display:flex;align-items:center;flex-wrap:wrap;gap:2px 8px}
.tile-chips{margin-top:4px}
.tile-rows{margin-top:6px;padding-top:2px;border-top:1px solid var(--rule)}
.tile-row{display:flex;justify-content:space-between;gap:8px;padding:2px 0;font-size:13px;color:var(--label)}
.ship-line{color:var(--label);font-size:13px;line-height:20px;margin-top:4px}
.nw{white-space:nowrap}
.tile-row-value{color:var(--ink-body);font-variant-numeric:tabular-nums;white-space:nowrap}
.tile-row.tone-critical,.tile-row.tone-critical .tile-row-value{color:var(--critical-text)}
.tile.alert .tile-value{color:var(--critical-text)}
.spark{width:100%;height:auto;display:block;margin-top:6px;overflow:visible}
.spark .grid{stroke:var(--grid);stroke-width:1}.spark .tick{fill:var(--tick);font-size:10px}
.spark-line{fill:none;stroke:var(--series);stroke-width:2;stroke-linejoin:round}
.spark-dot{fill:var(--surface);stroke:var(--series);stroke-width:1.5}.spark-dot.today{fill:var(--series)}
.chip{display:inline-flex;align-items:center;gap:4px;font-size:12px;line-height:20px;padding:0 8px 0 6px;border-radius:999px;background:var(--surface-2);color:var(--ink-body);white-space:nowrap}
.chip-icon{font-size:10px}
.chip.tone-good{background:color-mix(in srgb,var(--good) 10%,transparent)}.chip.tone-good .chip-icon{color:var(--good)}
.chip.tone-warning{background:color-mix(in srgb,var(--warning) 12%,transparent)}.chip.tone-warning .chip-icon{color:var(--warning)}
.chip.tone-serious{background:color-mix(in srgb,var(--serious) 14%,transparent)}.chip.tone-serious .chip-icon{color:var(--serious)}
.chip.tone-critical{background:color-mix(in srgb,var(--critical) 10%,transparent)}.chip.tone-critical .chip-icon{color:var(--critical)}
.chip.tone-neutral .chip-icon,.chip.tone-muted .chip-icon{color:var(--muted)}.chip.tone-muted{color:var(--ink-2)}
.delta{font-variant-numeric:tabular-nums}.delta.tone-good{color:var(--good-text)}.delta.tone-critical{color:var(--critical-text)}.delta.tone-neutral{color:var(--ink-2)}
.tone-text-critical{color:var(--critical-text)}
.controls{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.controls select{height:32px;border:1px solid var(--input);border-radius:4px;background:var(--surface);color:var(--ink-body);padding:0 8px}
.search{display:flex}.search input{height:32px;width:220px;border:1px solid var(--input);border-right:none;border-radius:4px 0 0 4px;padding:0 10px;background:var(--surface);color:var(--ink-body)}
.search input::placeholder{color:var(--muted)}
.search button{height:32px;width:40px;border:none;border-radius:0 4px 4px 0;background:var(--search);color:#fff;cursor:pointer}
.table-wrap{overflow-x:auto}
table{width:100%;border-collapse:collapse;font-size:13px}
th{text-align:left;font-weight:400;color:var(--ink-2);font-size:13px;padding:10px;background:var(--surface-2);white-space:nowrap}
th.active{background:var(--surface-3)}
td{padding:8px 10px;border-bottom:1px solid var(--rule);vertical-align:middle;color:var(--ink-body)}
.rival{display:inline-block;min-width:110px}
tbody tr:last-child td{border-bottom:none}
.num-col{text-align:right}
.product-table th.num-col .sort{justify-content:flex-end}
.sort{display:inline-flex;align-items:center;gap:4px;border:none;background:none;padding:0;cursor:pointer;font-weight:400;color:inherit}
.sort-icon{color:var(--ink-2);font-size:12px}th.active .sort-icon{color:var(--ink-body)}
.product{display:flex;gap:10px;align-items:center;min-width:250px}
.thumb{width:44px;height:44px;object-fit:contain;border-radius:4px;background:#fff;border:1px solid var(--grid);flex:none}.thumb.none{background:var(--surface-2)}
.product-text{min-width:0;flex:1}
/* 商品列占表宽约 28%，标题在列内省略：width:0 + min-width:100% 不让长标题撑宽表格，宽屏时自动多显示标题。 */
.product-table td:first-child{width:28%}
.product-title{display:block;width:0;min-width:100%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:14px}
.meta{color:var(--meta);font-size:12px;white-space:nowrap}.meta b{font-weight:700}
tr.flag-due td:first-child{box-shadow:inset 3px 0 0 var(--critical)}tr.flag-slow td:first-child{box-shadow:inset 3px 0 0 var(--warning)}
tr.flag-offer td:first-child{box-shadow:inset 3px 0 0 var(--serious)}
.empty-cell{text-align:center;color:var(--muted);padding:24px}
.pager{display:grid;grid-template-columns:minmax(0,1fr) auto minmax(0,1fr);align-items:center;gap:12px;padding:8px 16px;border-top:1px solid var(--rule)}
.pager-count{color:var(--ink-body)}.pager-links{display:flex;justify-content:flex-end;gap:8px;flex-wrap:wrap}
.pager-buttons{display:flex;gap:2px}
.page-btn{min-width:28px;height:28px;border:none;background:none;border-radius:4px;cursor:pointer;color:var(--link-2)}
.page-btn:hover{background:var(--surface-2)}.page-btn.arrow{color:var(--ink-body);font-size:16px}
.page-btn.current{color:var(--ink-body);cursor:default}.page-btn:disabled{color:var(--muted);cursor:default}
.chips{display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-top:2px}
.num{font-variant-numeric:tabular-nums}.nowrap{white-space:nowrap}.small{font-size:12px}.muted{color:var(--muted)}
.duo{display:grid;grid-template-columns:minmax(0,1.4fr) minmax(0,1fr);gap:12px}
.legend{display:flex;gap:12px;font-size:12px;color:var(--ink-2);flex-wrap:wrap}
.key{display:inline-block;vertical-align:middle;margin-right:6px}.key.line{width:16px;height:2px;border-radius:2px}
.key-main{background:var(--series)}.key-gray{background:var(--series-2)}
.chart{width:100%;height:auto;display:block;overflow:visible;touch-action:pan-y;padding:4px 16px 0}
.chart .grid{stroke:var(--grid);stroke-width:1}.chart .axis{stroke:var(--border);stroke-width:1}
.chart .tick{fill:var(--tick);font-size:11px}
.chart .line{fill:none;stroke-width:2;stroke-linejoin:round;stroke-linecap:round}.chart .line.main{stroke:var(--series)}.chart .line.gray{stroke:var(--series-2)}
.chart .dot{stroke:var(--surface);stroke-width:2}.chart .dot.main{fill:var(--series)}.chart .dot.gray{fill:var(--series-2)}
.chart .end-label{fill:var(--ink);font-size:12px;font-weight:700}.chart .muted-text{fill:var(--ink-2);font-weight:500}
.chart .crosshair{stroke:var(--border);stroke-width:1}.chart .now-line{stroke:var(--grid);stroke-width:1}
.data-table{margin:8px 16px 16px;width:calc(100% - 32px)}
.tooltip{position:fixed;left:0;top:0;z-index:20;pointer-events:none;background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:8px 10px;box-shadow:0 6px 24px rgba(0,0,0,.14);font-size:12px;opacity:0;transition:opacity .1s;min-width:140px}
.tooltip.show{opacity:1}.tip-title{color:var(--ink-2);margin-bottom:4px}
.tip-row{display:flex;align-items:center;gap:8px}.tip-row strong{font-size:13px;font-variant-numeric:tabular-nums}.tip-label{color:var(--ink-2)}
.tip-key{width:12px;height:2px;border-radius:2px;display:inline-block;background:var(--series-2)}.tip-key.key-main{background:var(--series)}
.feed{list-style:none;margin:0;padding:10px 16px 12px;display:grid;gap:10px;max-height:400px;overflow:auto}
.feed li{display:flex;gap:10px}
.feed-icon{width:24px;height:24px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:12px;flex:none;background:var(--surface-2);color:var(--ink-2)}
.feed-icon.tone-good{color:var(--good)}.feed-icon.tone-warning{color:var(--warning)}.feed-icon.tone-serious{color:var(--serious)}.feed-icon.tone-critical{color:var(--critical)}
.feed-title strong{font-weight:700}
.metric-grid{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:1px;background:var(--border);border-bottom:1px solid var(--border)}
.metric{background:var(--surface);padding:8px 12px 10px;min-width:0}
.metric-value{font-size:20px;font-weight:700;line-height:26px;margin:2px 0;color:var(--ink)}
.sub-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:24px;padding:0 16px 12px}
.sub-block h3{font-size:14px;margin:10px 0 4px;font-weight:700;color:var(--ink)}.sub-block h3 .num-link{font-weight:400;font-size:12px;margin-left:8px}
.mini-table td{padding:6px 10px}
.mini-table td{font-variant-numeric:tabular-nums}.mini-table td:first-child{max-width:280px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.empty{color:var(--muted);margin:12px 16px}.empty.ok{color:var(--good-text);margin:6px 0}
details.card summary{cursor:pointer;font-weight:700;padding:10px 16px;color:var(--ink)}details.card[open] summary{border-bottom:1px solid var(--border)}
#sources-body{padding:6px 16px 12px}
body.refreshing main .card{opacity:.6;transition:opacity .2s}
.message{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
.message .card{max-width:520px;padding:20px}.message h1{font-size:20px;margin:12px 0 8px}.message p{color:var(--ink-2);margin:6px 0}
.message code{font-size:12px;background:var(--surface-2);padding:1px 6px;border-radius:4px;word-break:break-all}
@media (max-width:1200px){.snapshot{grid-template-columns:repeat(3,minmax(0,1fr))}.tile.tall{grid-row:auto}.tile.wide{grid-column:span 2}.snapshot .tile:last-child{grid-column:span 2}.metric-grid{grid-template-columns:repeat(4,minmax(0,1fr))}}
@media (max-width:860px){.duo,.sub-grid{grid-template-columns:minmax(0,1fr)}.top{flex-wrap:wrap;height:auto;padding:8px 16px;gap:6px 12px}.clocks{order:3;width:100%}main{padding:12px}
.snapshot{grid-template-columns:repeat(2,minmax(0,1fr))}.tile.wide{grid-column:1/-1}.metric-grid{grid-template-columns:repeat(2,minmax(0,1fr))}
.search input{width:100%}.search{flex:1}.controls{width:100%}
.pager{grid-template-columns:minmax(0,1fr) auto}.pager-links{grid-column:1/-1;justify-content:flex-start}
.product-table thead{display:none}.product-table,.product-table tbody,.product-table tr,.product-table td{display:block;width:100%}
.product-table tr{border:1px solid var(--border);border-radius:8px;margin:0 0 10px;padding:8px 12px}
.product-table td{border:none;padding:4px 0;display:flex;justify-content:space-between;align-items:center;gap:12px;text-align:right}
.product-table td::before{content:attr(data-label);color:var(--muted);font-size:12px;flex:none;text-align:left}
.product-table td:first-child{display:block;width:100%;text-align:left}.product-table td:first-child::before{display:none}
.product{min-width:0}.product-title{width:auto;min-width:0;white-space:normal}
tr.flag-due td:first-child,tr.flag-slow td:first-child,tr.flag-offer td:first-child{box-shadow:none}
tr.flag-due{border-color:var(--critical)!important}tr.flag-slow{border-color:var(--warning)!important}tr.flag-offer{border-color:var(--serious)!important}
.product-table .chips{justify-content:flex-end}.table-wrap{padding:12px}}
@media (max-width:480px){.tile.wide .tile-value{font-size:26px}.status #updated{display:none}.chart .tick{font-size:17px}.chart .end-label{font-size:17px}}
`;

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char);
}

// 内嵌 JSON：转义 < 与行分隔符，防止提前闭合 script 或破坏解析。
export function embedJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

export function contentSecurityPolicy(nonce: string): string {
  return [
    "default-src 'none'", `script-src 'nonce-${nonce}'`, `style-src 'nonce-${nonce}'`, "img-src 'self' data: https:", "connect-src 'self'",
    "base-uri 'none'", "form-action 'self'", "frame-ancestors 'self' https://*.feishu.cn https://*.feishucdn.com https://*.larksuite.com",
  ].join("; ");
}

export const head = (nonce: string, title: string, extraCss = ""): string => `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="no-referrer"><title>${escapeHtml(title)}</title><style nonce="${nonce}">${CSS}${extraCss}</style></head>`;
export const brand = (title: string, id = ""): string => `<div class="brand"><span class="brand-mark" aria-hidden="true">a</span><span${id ? ` id="${id}"` : ""}>${escapeHtml(title)}</span></div>`;

export function renderPortalPage(view: PortalView, nonce: string): string {
  const title = view.title || DEFAULT_TITLE;
  const script = `(${clientMain.toString()})();`.replace(/<\/script/gi, "<\\/script");
  return `${head(nonce, title)}<body>
<header class="top">
${brand(title, "brand-name")}
<nav class="top-nav" aria-label="页面"><a href="/" aria-current="page">首页</a><a href="/report">报告</a></nav>
<div class="clocks" id="clocks"></div><div class="spacer"></div>
<div class="status"><span id="updated"></span><button type="button" class="ghost" id="refresh">刷新</button></div>
<div class="user" id="user"></div>
</header>
<main>
<div class="notice" id="notice"></div>
<div class="banner" id="banner" role="status" hidden></div>
<div class="health-strip" id="health" role="alert" hidden></div>
<section class="card" aria-labelledby="snapshot-title"><div class="card-head"><h2 id="snapshot-title">全局快照</h2></div><div class="snapshot" id="snapshot"></div></section>
<section class="card" aria-labelledby="products-title">
<div class="card-head"><div><div class="title-line"><h2 id="products-title">商品绩效</h2><span class="info" title="最近 30 天＝今天之前 30 个完整日；“今日”按洛杉矶时间" aria-label="最近 30 天＝今天之前 30 个完整日；“今日”按洛杉矶时间">ⓘ</span><span id="sale-chip"></span></div><div class="card-sub">最近 30 天</div></div>
<div class="controls"><select id="product-filter" aria-label="筛选"><option value="buyable">在售</option><option value="all">全部</option><option value="flagged">需留意</option></select>
<div class="search"><input id="product-search" type="search" placeholder="搜索标题、ASIN 或 SKU" aria-label="搜索商品"><button type="button" id="product-search-btn" aria-label="搜索">&#x1F50D;&#xFE0E;</button></div></div></div>
<div id="products-body"></div>
</section>
<section class="duo"><figure class="card" id="chart-pace"></figure><div class="card" id="feed"></div></section>
<section class="card" id="ads"></section>
<details class="card" id="sources"><summary>数据来源与更新时间</summary><div id="sources-body"></div></details>
</main>
<script type="application/json" id="portal-data">${embedJson(view)}</script>
<script nonce="${nonce}">${script}</script>
</body></html>`;
}

export interface MessagePage { title: string; message: string; lines?: string[]; code?: string }

export function renderMessagePage(page: MessagePage, nonce: string, appTitle = DEFAULT_TITLE): string {
  const lines = (page.lines ?? []).map((line) => `<p>${escapeHtml(line)}</p>`).join("");
  const code = page.code ? `<p><code>${escapeHtml(page.code)}</code></p>` : "";
  return `${head(nonce, `${page.title} · ${appTitle}`)}<body><main class="message"><div class="card">
${brand(appTitle)}
<h1>${escapeHtml(page.title)}</h1><p>${escapeHtml(page.message)}</p>${lines}${code}
</div></main></body></html>`;
}
