#!/usr/bin/env node
/**
 * 静态站生成器
 *
 * 把单页应用里的 DEALS 数据展开成搜索引擎与 AI 爬虫可读的静态页面：
 *   dist/index.html            首页（在原始单页上注入 head 元信息与文本目录）
 *   dist/deal/<id>.html        每条情报的详情页
 *   dist/category/<cat>.html   分类列表页
 *   dist/404.html              404 页
 *   dist/sitemap.xml
 *   dist/robots.txt
 *   dist/llms.txt / llms-full.txt
 *
 * 用法：node build/generate.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const ROOT = path.resolve(import.meta.dirname, '..');
const MASTER = path.join(ROOT, '全球羊毛情报中心.html');
const DIST = path.join(ROOT, 'dist');
const SITE = 'https://wool.xiaoyanbao.com';
const BRAND = '全球羊毛情报中心';

const master = fs.readFileSync(MASTER, 'utf8');

/* ---------- 从单页里取出数据 ---------- */

function arrayLiteral(src, name) {
  const start = src.indexOf(`const ${name} = `);
  if (start < 0) throw new Error(`未找到 const ${name}`);
  const open = src.indexOf('[', start);
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let i = open; i < src.length; i += 1) {
    const ch = src[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '[') depth += 1;
    else if (ch === ']') {
      depth -= 1;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  throw new Error(`${name} 数组未闭合`);
}

const SNAPSHOT = /const SNAPSHOT = "([^"]+)"/.exec(master)?.[1];
if (!SNAPSHOT) throw new Error('未找到 SNAPSHOT');

const CATS = vm.runInNewContext(`(${arrayLiteral(master, 'CATS')})`, {});
const DEALS = vm.runInNewContext(`(${arrayLiteral(master, 'DEALS')})`, {});

const SCORE_META = [
  { key: 'quota', label: '额度' },
  { key: 'trust', label: '可信度' },
  { key: 'ease', label: '领取难度' },
  { key: 'useful', label: '实用性' },
  { key: 'audience', label: '适用人群' },
  { key: 'urgency', label: '紧迫性' },
  { key: 'risk', label: '风险' },
];

/* ---------- 工具 ---------- */

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

const cut = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

/** 取第一句；超长时优先在逗号/顿号处收尾，避免描述断在半句 */
const firstSentence = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  const i = t.search(/[。！？!?]/);
  const first = i > 0 ? t.slice(0, i + 1) : t;
  if (first.length <= n) return first;
  const head = t.slice(0, n);
  const stop = Math.max(head.lastIndexOf('，'), head.lastIndexOf('、'), head.lastIndexOf('；'));
  return `${stop > n * 0.5 ? head.slice(0, stop) : head}…`;
};

const DAY = 86400000;
function statusOf(d) {
  if (d.ended) return { key: 'dead', label: '已失效' };
  const p = d.deadline ? d.deadline.split('-').map(Number) : null;
  if (!p) return { key: 'live', label: '有效' };
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dl = new Date(p[0], p[1] - 1, p[2], 23, 59, 59);
  const diff = Math.floor((dl - today) / DAY);
  if (diff < 0) return { key: 'dead', label: '已失效' };
  if (diff <= 7) return { key: 'soon', label: '即将到期' };
  return { key: 'live', label: '有效' };
}

const totalScore = (d) => Object.values(d.scores).reduce((a, b) => a + b, 0);
const catOf = (key) => CATS.find((c) => c.key === key) || CATS[0];
const statusRank = { soon: 0, live: 1, dead: 2 };
const sortedDeals = [...DEALS].sort((a, b) => statusRank[statusOf(a).key] - statusRank[statusOf(b).key]);

const dealUrl = (d) => `${SITE}/deal/${d.id}.html`;
const catUrl = (c) => `${SITE}/category/${c.key}.html`;

function descriptionOf(d) {
  return `${firstSentence(d.summary, 74)} ${catOf(d.cat).name} 免费额度，领取条件、适用地区、成本与风险均已标注，最后核实 ${d.verified}。`;
}

function faqOf(d) {
  return [
    { q: `${d.vendor} 的免费额度是多少？`, a: d.quota },
    { q: '领取这条免费额度需要什么条件？', a: d.requirements },
    { q: '免费额度什么时候截止？', a: `${d.deadlineLabel}${d.deadline ? `（官方截止 ${d.deadline}）` : ''}` },
    { q: '这条情报是怎么核实的？', a: `${d.verified} 核实：${d.verifiedNote}` },
  ];
}

/* ---------- 详情页样式 ---------- */

const SUB_CSS = `
*,*::before,*::after{box-sizing:border-box}
:root{--bg:#070b14;--panel:#111a2e;--panel-2:#16203a;--line:#22304f;--line-soft:#1a2540;
--txt:#e6edf9;--txt-2:#9fb0cc;--txt-3:#6b7d9c;--acc:#2fe6b0;--warn:#ffb547;--danger:#ff5f6d;
--r:14px;--r-sm:9px}
html,body{margin:0;padding:0}
body{background:var(--bg);color:var(--txt);font:15px/1.7 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;-webkit-font-smoothing:antialiased}
a{color:var(--acc);text-decoration:none}a:hover{text-decoration:underline}
.wrap{max-width:880px;margin:0 auto;padding:0 18px 64px}
.nav{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:center;gap:12px;
padding:20px 0 16px;border-bottom:1px solid var(--line-soft);font-size:13px;color:var(--txt-3)}
.nav a{color:var(--txt-2)}
.nav .brand{color:var(--acc);font-weight:700;letter-spacing:.16em;font-size:12px;text-transform:uppercase}
.crumb{display:flex;flex-wrap:wrap;gap:6px;font-size:12px;color:var(--txt-3);padding:16px 0 0}
.crumb a{color:var(--txt-3)}
h1{font-size:clamp(22px,4.4vw,30px);line-height:1.32;margin:12px 0 10px;letter-spacing:-.01em}
.meta{display:flex;flex-wrap:wrap;gap:8px;align-items:center;font-size:12px;color:var(--txt-3);margin:0 0 20px}
.badge{border:1px solid var(--line);border-radius:999px;padding:2px 9px;font-size:11.5px;color:var(--txt-2)}
.badge.live{color:var(--acc);border-color:rgba(47,230,176,.42);background:rgba(47,230,176,.08)}
.badge.soon{color:var(--warn);border-color:rgba(255,181,71,.42);background:rgba(255,181,71,.08)}
.badge.dead{color:var(--danger);border-color:rgba(255,95,109,.42);background:rgba(255,95,109,.08)}
.lead{background:var(--panel);border:1px solid var(--line-soft);border-radius:var(--r);padding:16px 18px;margin:0 0 8px;color:var(--txt-2)}
.lead b{color:var(--txt)}
h2{font-size:16px;margin:30px 0 10px;padding-top:4px}
p{margin:0 0 10px;color:var(--txt-2)}
.facts{margin:12px 0 4px;border:1px solid var(--line-soft);border-radius:var(--r);overflow:hidden}
.fact{padding:12px 16px;border-bottom:1px solid var(--line-soft);background:var(--panel)}
.fact:last-child{border-bottom:0}
.fact dt{font-size:12px;color:var(--txt-3);margin:0 0 4px}
.fact dd{margin:0;font-size:14px;color:var(--txt)}
.risk{border-left:3px solid var(--danger);background:rgba(255,95,109,.06);padding:12px 16px;
border-radius:0 var(--r-sm) var(--r-sm) 0;color:var(--txt-2);margin:12px 0 0}
.cta{display:flex;flex-wrap:wrap;gap:10px;margin:24px 0 6px}
.btn{display:inline-flex;align-items:center;border-radius:var(--r-sm);padding:10px 16px;
font-size:13px;font-weight:600;border:1px solid transparent}
.btn.p{background:var(--acc);color:#04241a}
.btn.s{border-color:var(--line);color:var(--txt-2)}
table.scores{width:100%;border-collapse:collapse;font-size:13px;margin-top:8px}
table.scores th{text-align:left;color:var(--txt-3);font-weight:500;padding:6px 0;border-bottom:1px solid var(--line-soft)}
table.scores td{padding:8px 0;border-bottom:1px solid var(--line-soft);color:var(--txt-2);vertical-align:middle}
table.scores td.num{text-align:right;white-space:nowrap;color:var(--txt)}
.bar{height:6px;border-radius:999px;background:var(--panel-2);overflow:hidden;min-width:80px}
.bar i{display:block;height:100%;background:var(--acc)}
.faq h3{font-size:14px;margin:16px 0 4px;color:var(--txt)}
.related{list-style:none;padding:0;margin:12px 0 0;display:grid;gap:8px}
.related a{display:block;border:1px solid var(--line-soft);background:var(--panel);border-radius:var(--r-sm);
padding:11px 14px;color:var(--txt)}
.related a:hover{text-decoration:none;border-color:var(--line)}
.related span{display:block;color:var(--txt-3);font-size:12px;margin-top:3px}
.foot{margin-top:36px;padding-top:16px;border-top:1px solid var(--line-soft);font-size:12px;color:var(--txt-3)}
.foot a{color:var(--txt-3);text-decoration:underline}
`;

/* ---------- 页面骨架 ---------- */

function shell({ title, description, canonical, jsonLd = [], body, extraHead = '' }) {
  const ld = jsonLd
    .map((obj) => `<script type="application/ld+json">${JSON.stringify(obj)}</script>`)
    .join('\n');
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${esc(canonical)}">
<meta name="robots" content="index,follow,max-image-preview:large">
<meta property="og:type" content="article">
<meta property="og:site_name" content="${BRAND}">
<meta property="og:locale" content="zh_CN">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${esc(canonical)}">
<meta property="og:image" content="${SITE}/assets/logo/logo-mark-180.png">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(description)}">
<meta name="twitter:image" content="${SITE}/assets/logo/logo-mark-180.png">
<link rel="icon" href="/assets/logo/logo-mark.webp" type="image/webp">
<link rel="icon" href="/favicon.ico" sizes="48x48">
<link rel="apple-touch-icon" href="/assets/logo/logo-mark-180.png">
${extraHead}
${ld}
<style>${SUB_CSS}</style>
</head>
<body>
<div class="wrap">
<div class="nav">
  <a class="brand" href="/">Global Deal Hunter</a>
  <a href="/">← 返回情报看板</a>
</div>
${body}
<div class="foot">
  <p>本站只收录能从厂商官方页面追溯到的免费额度，标注核实日期与来源；额度与规则以厂商页面实时展示为准。</p>
  <p><a href="/">情报看板</a> · <a href="/sitemap.xml">站点地图</a> · 数据快照 ${SNAPSHOT}</p>
</div>
</div>
</body>
</html>
`;
}

/* ---------- 详情页 ---------- */

function dealPage(d) {
  const st = statusOf(d);
  const cat = catOf(d.cat);
  const total = totalScore(d);
  const related = DEALS.filter((x) => x.id !== d.id && x.cat === d.cat)
    .sort((a, b) => statusRank[statusOf(a).key] - statusRank[statusOf(b).key])
    .slice(0, 3);
  const faq = faqOf(d);

  const scoreRows = SCORE_META.map((m) => {
    const v = d.scores[m.key];
    return `<tr><td>${m.label}</td><td><div class="bar"><i style="width:${v / 5 * 100}%"></i></div></td><td class="num">${v}.0</td></tr>`;
  }).join('');

  const body = `
<nav class="crumb" aria-label="面包屑">
  <a href="/">首页</a><span>/</span><a href="/category/${cat.key}.html">${esc(cat.name)}</a><span>/</span><span>${esc(cut(d.title, 24))}</span>
</nav>
<h1>${esc(d.title)}</h1>
<div class="meta">
  <span class="badge ${st.key}">${st.label}</span>
  <span>${esc(cat.name)}</span><span>·</span><span>${esc(d.vendor)}</span>
  <span>·</span><span>最后核实 ${esc(d.verified)}</span>
</div>
<div class="lead"><b>一句话结论：</b>${esc(d.summary)}</div>
<dl class="facts">
  <div class="fact"><dt>免费额度</dt><dd>${esc(d.quota)}</dd></div>
  <div class="fact"><dt>领取条件</dt><dd>${esc(d.requirements)}</dd></div>
  <div class="fact"><dt>适用地区</dt><dd>${esc(d.region)}</dd></div>
  <div class="fact"><dt>成本</dt><dd>${esc(d.cost)}</dd></div>
  <div class="fact"><dt>到期时间</dt><dd>${esc(d.deadlineLabel)}</dd></div>
</dl>
<h2>风险与限制</h2>
<p class="risk">${esc(d.risk)}</p>
<h2>七项评分（合计 ${total} / 35）</h2>
<table class="scores">
  <thead><tr><th>维度</th><th>评分</th><th></th></tr></thead>
  <tbody>${scoreRows}</tbody>
</table>
<p>定性判断，非事实陈述。领取难度与风险为反向计分（越高越易领、越安全）。</p>
<div class="cta">
  <a class="btn p" href="${esc(d.official.url)}" target="_blank" rel="noopener noreferrer">${st.key === 'dead' ? '免费窗口已关闭（官方页）' : '前往官方领取入口'}</a>
  <a class="btn s" href="${esc(d.source.url)}" target="_blank" rel="noopener noreferrer">查看来源（${esc(d.source.name)}）</a>
</div>
<h2>核实说明</h2>
<p>${esc(d.verifiedNote)}（核实日期 ${esc(d.verified)}；官方来源：${esc(d.official.label)}）</p>
<div class="faq">
  <h2>常见问题</h2>
  ${faq.map((f) => `<h3>${esc(f.q)}</h3><p>${esc(f.a)}</p>`).join('\n  ')}
</div>
${related.length ? `<h2>同类情报</h2>
<ul class="related">
${related.map((r) => `  <li><a href="/deal/${r.id}.html">${esc(r.title)}<span>${esc(r.vendor)} · ${statusOf(r).label} · 最后核实 ${esc(r.verified)}</span></a></li>`).join('\n')}
</ul>` : ''}
`;

  const jsonLd = [{
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'Article',
        headline: d.title,
        description: descriptionOf(d),
        datePublished: d.verified,
        dateModified: d.verified,
        inLanguage: 'zh-CN',
        mainEntityOfPage: dealUrl(d),
        articleSection: cat.name,
        keywords: [d.vendor, cat.name, '免费额度', '免费 API'],
        author: { '@type': 'Organization', name: BRAND, url: SITE },
        publisher: {
          '@type': 'Organization',
          name: BRAND,
          url: SITE,
          logo: { '@type': 'ImageObject', url: `${SITE}/assets/logo/logo-mark-180.png` },
        },
        offers: [{
          '@type': 'Offer',
          name: d.title,
          price: '0',
          priceCurrency: 'CNY',
          availability: st.key === 'dead'
            ? 'https://schema.org/Discontinued'
            : 'https://schema.org/InStock',
          url: d.official.url,
          seller: { '@type': 'Organization', name: d.vendor },
        }],
      },
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: '首页', item: `${SITE}/` },
          { '@type': 'ListItem', position: 2, name: cat.name, item: catUrl(cat) },
          { '@type': 'ListItem', position: 3, name: d.title, item: dealUrl(d) },
        ],
      },
      {
        '@type': 'FAQPage',
        mainEntity: faq.map((f) => ({
          '@type': 'Question',
          name: f.q,
          acceptedAnswer: { '@type': 'Answer', text: f.a },
        })),
      },
    ],
  }];

  return shell({
    title: `${d.title}｜${BRAND}`,
    description: descriptionOf(d),
    canonical: dealUrl(d),
    jsonLd,
    body,
    extraHead: `<meta property="article:modified_time" content="${d.verified}">\n<meta property="article:section" content="${esc(cat.name)}">`,
  });
}

/* ---------- 分类页 ---------- */

function categoryPage(cat) {
  const items = sortedDeals.filter((d) => d.cat === cat.key);
  const live = items.filter((d) => statusOf(d).key !== 'dead').length;
  const body = `
<nav class="crumb" aria-label="面包屑">
  <a href="/">首页</a><span>/</span><span>${esc(cat.name)}</span>
</nav>
<h1>${esc(cat.name)} 免费额度情报（${items.length} 条）</h1>
<div class="meta"><span>当前可领 ${live} 条</span><span>·</span><span>数据快照 ${SNAPSHOT}</span></div>
<p>${esc(cat.name)}方向的免费额度与试用活动，逐条标注额度、领取门槛、适用地区、成本与风险，并附厂商官方来源与核实日期。额度随时可能变化，以官方页面为准。</p>
<ul class="related">
${items.map((d) => `  <li><a href="/deal/${d.id}.html">${esc(d.title)}<span>${esc(d.vendor)} · ${statusOf(d).label} · 最后核实 ${esc(d.verified)} · ${esc(cut(d.quota, 46))}</span></a></li>`).join('\n')}
</ul>
<h2>其它分类</h2>
<p>${CATS.filter((c) => c.key !== cat.key).map((c) => `<a href="/category/${c.key}.html">${esc(c.name)}</a>`).join(' · ')}</p>
`;
  const jsonLd = [{
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'CollectionPage',
        name: `${cat.name}免费额度情报`,
        description: `${cat.name}方向的免费额度情报共 ${items.length} 条，含额度、领取条件与风险标注。`,
        url: catUrl(cat),
        inLanguage: 'zh-CN',
        isPartOf: { '@type': 'WebSite', name: BRAND, url: SITE },
      },
      {
        '@type': 'ItemList',
        itemListElement: items.map((d, i) => ({
          '@type': 'ListItem', position: i + 1, name: d.title, url: dealUrl(d),
        })),
      },
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: '首页', item: `${SITE}/` },
          { '@type': 'ListItem', position: 2, name: cat.name, item: catUrl(cat) },
        ],
      },
    ],
  }];
  return shell({
    title: `${cat.name} 免费额度情报｜${BRAND}`,
    description: `${cat.name}免费额度与试用活动共 ${items.length} 条，逐条标注额度、领取门槛、地区限制、风险与官方来源，数据快照 ${SNAPSHOT}。`,
    canonical: catUrl(cat),
    jsonLd,
    body,
    extraHead: '',
  });
}

/* ---------- 首页注入 ---------- */

function directorySection() {
  const catLinks = CATS.map((c) => {
    const n = DEALS.filter((d) => d.cat === c.key).length;
    return `<a href="/category/${c.key}.html">${esc(c.name)} <b>${n}</b></a>`;
  }).join('');
  const rows = sortedDeals.map((d) => {
    const st = statusOf(d);
    return `<li><a href="/deal/${d.id}.html"><b>${esc(d.title)}</b><span>${esc(d.vendor)} · ${esc(catOf(d.cat).name)} · ${st.label} · 最后核实 ${esc(d.verified)}</span></a></li>`;
  }).join('\n');
  return `<div class="wrap">
<!-- SECTION: seo-directory -->
<section class="seo-dir" id="directory" aria-labelledby="seoDirTitle">
  <h2 id="seoDirTitle">全部情报 · 逐条详情</h2>
  <p class="seo-dir-sub">每条情报都有独立详情页，含额度、领取门槛、适用地区、成本、风险、七项评分与官方来源，便于逐条核对与分享。</p>
  <div class="seo-dir-cats">${catLinks}</div>
  <ol class="seo-dir-list">
${rows}
  </ol>
</section>
</div>
`;
}

const DIR_CSS = `
/* SECTION: seo-directory */
.seo-dir{margin:38px 0 0;padding:22px 0 0;border-top:1px solid var(--line-soft)}
.seo-dir h2{font-size:18px;margin:0 0 6px;letter-spacing:-.01em}
.seo-dir-sub{margin:0 0 14px;color:var(--txt-3);font-size:12.5px;max-width:78ch}
.seo-dir-cats{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:14px}
.seo-dir-cats a{border:1px solid var(--line-soft);background:var(--panel);border-radius:999px;
padding:5px 12px;font-size:12px;color:var(--txt-2)}
.seo-dir-cats a:hover{text-decoration:none;border-color:var(--line);color:var(--txt)}
.seo-dir-cats b{color:var(--acc);font-weight:600;margin-left:2px}
.seo-dir-list{list-style:none;margin:0;padding:0;display:grid;gap:6px}
.seo-dir-list a{display:block;border:1px solid var(--line-soft);background:var(--panel);border-radius:var(--r-sm);
padding:10px 13px;color:var(--txt)}
.seo-dir-list a:hover{text-decoration:none;border-color:var(--line)}
.seo-dir-list b{display:block;font-size:13.5px;font-weight:600;line-height:1.5}
.seo-dir-list span{display:block;color:var(--txt-3);font-size:11.5px;margin-top:2px}
`;

function buildIndex() {
  const title = `${BRAND}｜免费 API 额度与 AI 试用情报（${SNAPSHOT} 快照）`;
  const desc = `只收录能从厂商官方页面追溯到的免费额度：${DEALS.length} 条大模型 API、AI 应用与云服务情报，逐条标注额度、门槛、成本、风险与核实日期，数据快照 ${SNAPSHOT}。`;
  const canonical = `${SITE}/`;
  const jsonLd = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'WebSite',
        name: BRAND,
        alternateName: 'Global Deal Hunter',
        url: canonical,
        inLanguage: 'zh-CN',
        description: desc,
      },
      {
        '@type': 'Organization',
        name: BRAND,
        url: canonical,
        logo: { '@type': 'ImageObject', url: `${SITE}/assets/logo/logo-mark-180.png` },
        sameAs: ['https://github.com/Aimi-Ding'],
      },
      {
        '@type': 'ItemList',
        name: '免费额度情报列表',
        itemListElement: sortedDeals.map((d, i) => ({
          '@type': 'ListItem', position: i + 1, name: d.title, url: dealUrl(d),
        })),
      },
    ],
  };

  const headInject = `<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${canonical}">
<meta name="robots" content="index,follow,max-image-preview:large">
<meta property="og:type" content="website">
<meta property="og:site_name" content="${BRAND}">
<meta property="og:locale" content="zh_CN">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${canonical}">
<meta property="og:image" content="${SITE}/assets/logo/logo-mark-180.png">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(desc)}">
<meta name="twitter:image" content="${SITE}/assets/logo/logo-mark-180.png">
<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
<style>${DIR_CSS}</style>`;

  const iconAnchor = '<link rel="apple-touch-icon" href="/assets/logo/logo-mark-180.png">';
  if (!master.includes(iconAnchor)) throw new Error('首页缺少图标声明，无法定位注入点');
  let out = master.replace(iconAnchor, `${iconAnchor}\n${headInject}`);

  const beacon = '<!-- SECTION: visit-beacon -->';
  if (!out.includes(beacon)) throw new Error('首页缺少 visit-beacon 标记，无法插入目录');
  out = out.replace(beacon, `${directorySection()}\n${beacon}`);

  out = out.replace('<title>GLOBAL DEAL HUNTER｜全球羊毛情报中心</title>', `<title>${esc(title)}</title>`);
  return out;
}

/* ---------- 站点文件 ---------- */

function sitemap() {
  const urls = [
    { loc: `${SITE}/`, pr: '1.0' },
    ...CATS.map((c) => ({ loc: catUrl(c), pr: '0.8' })),
    ...sortedDeals.map((d) => ({ loc: dealUrl(d), pr: '0.7' })),
  ];
  const body = urls.map((u) => `  <url>
    <loc>${u.loc}</loc>
    <lastmod>${SNAPSHOT}</lastmod>
    <changefreq>daily</changefreq>
    <priority>${u.pr}</priority>
  </url>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${body}
</urlset>
`;
}

function robots() {
  const aiBots = ['GPTBot', 'OAI-SearchBot', 'ChatGPT-User', 'ClaudeBot', 'Claude-SearchBot',
    'PerplexityBot', 'Perplexity-User', 'Google-Extended', 'Applebot-Extended', 'Bytespider', 'CCBot'];
  return `# ${BRAND}
User-agent: *
Allow: /

# 允许生成式引擎抓取与引用
${aiBots.map((b) => `User-agent: ${b}\nAllow: /`).join('\n\n')}

Sitemap: ${SITE}/sitemap.xml
`;
}

function llms() {
  const lines = [
    `# ${BRAND}`,
    '',
    `> 免费额度情报站：只收录能从厂商官方页面追溯到的免费额度，逐条标注额度、领取门槛、适用地区、成本、风险与核实日期。数据快照 ${SNAPSHOT}，共 ${DEALS.length} 条。`,
    '',
    '## 站点结构',
    `- [情报看板](${SITE}/)：全部条目、筛选、UV 概览`,
    ...CATS.map((c) => `- [${c.name}](${catUrl(c)})：${DEALS.filter((d) => d.cat === c.key).length} 条`),
    '',
    '## 情报条目',
    ...sortedDeals.map((d) => {
      const st = statusOf(d);
      return `- [${d.title}](${dealUrl(d)})：${d.vendor}，${st.label}，额度 ${cut(d.quota, 60)}（核实 ${d.verified}）`;
    }),
    '',
    '## 收录原则',
    '- 只有厂商官方页面能追溯到的额度才会收录，查不到官方依据的一律标「未核实」，不编数字。',
    '- 每条标注最后核实日期与官方来源链接；额度与规则以厂商页面实时展示为准。',
    '- 七项评分（额度/可信度/领取难度/实用性/适用人群/紧迫性/风险）为定性判断，非事实陈述。',
    '',
  ];
  return `${lines.join('\n')}\n`;
}

function llmsFull() {
  const blocks = sortedDeals.map((d) => {
    const st = statusOf(d);
    const cat = catOf(d.cat);
    return [
      `### ${d.title}`,
      `- 链接：${dealUrl(d)}`,
      `- 厂商：${d.vendor}（分类：${cat.name}；状态：${st.label}）`,
      `- 免费额度：${d.quota}`,
      `- 领取条件：${d.requirements}`,
      `- 适用地区：${d.region}`,
      `- 成本：${d.cost}`,
      `- 到期：${d.deadlineLabel}`,
      `- 风险：${d.risk}`,
      `- 七项评分：${SCORE_META.map((m) => `${m.label} ${d.scores[m.key]}/5`).join('，')}（合计 ${totalScore(d)}/35）`,
      `- 核实：${d.verified}，${d.verifiedNote}`,
      `- 官方来源：${d.official.label} ${d.official.url}`,
      `- 线索来源：${d.source.name} ${d.source.url}`,
      '',
    ].join('\n');
  });
  return `# ${BRAND} 全量情报\n\n数据快照 ${SNAPSHOT}，共 ${DEALS.length} 条。额度与规则以厂商官方页面实时展示为准。\n\n${blocks.join('\n')}`;
}

function notFound() {
  return shell({
    title: `页面不存在｜${BRAND}`,
    description: '页面不存在，返回情报看板查看全部免费额度情报。',
    canonical: `${SITE}/`,
    body: `<h1>页面不存在</h1>
<p>你访问的地址没有对应内容，可能已调整或写错。</p>
<ul class="related">
  <li><a href="/">返回情报看板<span>全部 ${DEALS.length} 条免费额度情报</span></a></li>
  ${CATS.map((c) => `<li><a href="/category/${c.key}.html">${esc(c.name)}<span>${DEALS.filter((d) => d.cat === c.key).length} 条</span></a></li>`).join('\n  ')}
</ul>`,
  }).replace('<meta name="robots" content="index,follow,max-image-preview:large">', '<meta name="robots" content="noindex,follow">');
}

/* ---------- 输出 ---------- */

fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(path.join(DIST, 'deal'), { recursive: true });
fs.mkdirSync(path.join(DIST, 'category'), { recursive: true });

fs.writeFileSync(path.join(DIST, 'index.html'), buildIndex());
for (const d of DEALS) fs.writeFileSync(path.join(DIST, 'deal', `${d.id}.html`), dealPage(d));
for (const c of CATS) fs.writeFileSync(path.join(DIST, 'category', `${c.key}.html`), categoryPage(c));
fs.writeFileSync(path.join(DIST, '404.html'), notFound());
fs.writeFileSync(path.join(DIST, 'sitemap.xml'), sitemap());
fs.writeFileSync(path.join(DIST, 'robots.txt'), robots());
fs.writeFileSync(path.join(DIST, 'llms.txt'), llms());
fs.writeFileSync(path.join(DIST, 'llms-full.txt'), llmsFull());

fs.cpSync(path.join(ROOT, 'assets'), path.join(DIST, 'assets'), { recursive: true });
fs.copyFileSync(path.join(ROOT, 'favicon.ico'), path.join(DIST, 'favicon.ico'));

console.log(`生成完成：${DEALS.length} 条情报、${CATS.length} 个分类 -> ${path.relative(ROOT, DIST)}/`);
