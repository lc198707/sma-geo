#!/usr/bin/env node
// 可引用性审计(citability audit):度量「页面被生成式引擎引用的难易」,与现有 robots/llms/sitemap 闸门互补。
//
// 定位:现有闸门解决「能不能被抓到」(robots 放行、llms.txt、sitemap、JSON-LD);
//       本脚本解决「抓到之后会不会被引用」——即 GEO 文献中真正驱动引用的文档级属性。
//
// 权重依据(实证,非拍脑袋):
//   - Aggarwal et al., GEO: Generative Engine Optimization, ACM SIGKDD 2024 (arXiv:2311.09735)
//     九类改写方法横评:Cite Sources / Statistics Addition / Quotation Addition 三类稳定居前,
//     最优组合在 Position-Adjusted Word Count 上较基线 +41%。
//   - FeatGEO (arXiv:2604.19113, 2026-04):引用行为由「文档级内容属性」驱动,
//     显著强于孤立的词句级改写 —— 故本脚本按属性打分,不做措辞检查。
//
// 用法:
//   node scripts/audit-citability.mjs                 # 审计 dist/ 构建产物
//   node scripts/audit-citability.mjs --dir <目录>     # 审计任意 HTML 快照目录(如线上抓取)
//   node scripts/audit-citability.mjs --json <文件>    # 额外输出 JSON
//   node scripts/audit-citability.mjs --min-score 60  # 低于阈值即非零退出(绝对闸门)
//   node scripts/audit-citability.mjs --baseline <文件> [--tolerance 2]
//                                                     # 回归闸门:任一页低于基线即失败(默认容差 2 分)
//   node scripts/audit-citability.mjs --write-baseline <文件>   # 记录当前分数为基线
//
// 闸门选型:当前全站远未达标,绝对阈值会全红;先用 --baseline 锁「不许倒退」,
// 随整改推进再逐步上调 --min-score(与 robots/llms 闸门同为构建期 fail-closed)。
//
// 纪律:本脚本只测量、只报缺口,不生成任何对外数字;整改必须用真实数据回填(见 §统计数据维度)。
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const argOf = (name, fallback = null) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const SITE_HOST = 'www.smaapi.com';
// 自有资产域:计入实体锚定,但不算「第三方来源引用」(避免自引自证抬分)
const OWN_DOMAINS = [SITE_HOST, 'smaapi.com', 'github.com/smaapi'];
// 非引证性外链:备案/统计等,不计入来源引用
const NON_CITE_DOMAINS = ['beian.miit.gov.cn', 'beian.gov.cn'];

// 维度权重合计 100。排序即优先级:上两项是文献中收益最高、本站缺口最大的两项。
const WEIGHTS = { cite: 25, stats: 25, quote: 15, answer: 10, chunk: 10, fresh: 10, entity: 5 };

// ---------- HTML → 结构化 ----------
const stripTags = (s) => s.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/\s+/g, ' ').trim();

function parse(html) {
  // 正文只取 <main>(与 generate-llms.mjs 同源口径);缺 main 时退回 body 并剥离 nav/footer
  let main = html.match(/<main[^>]*>([\s\S]*?)<\/main>/i)?.[1];
  if (!main) {
    main = (html.match(/<body[^>]*>([\s\S]*?)<\/body>/i)?.[1] ?? html)
      .replace(/<nav[\s\S]*?<\/nav>/gi, '').replace(/<footer[\s\S]*?<\/footer>/gi, '');
  }
  main = main.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '');

  const jsonld = [...html.matchAll(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)]
    .map((m) => { try { return JSON.parse(m[1]); } catch { return null; } }).filter(Boolean);

  const links = [...main.matchAll(/<a\b[^>]*href="(https?:\/\/[^"]+)"/gi)].map((m) => m[1]);
  const h1 = stripTags(main.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ?? '');
  const h2s = [...main.matchAll(/<h2[^>]*>([\s\S]*?)<\/h2>/gi)].map((m) => stripTags(m[1]));
  const h3s = [...main.matchAll(/<h3[^>]*>([\s\S]*?)<\/h3>/gi)].map((m) => stripTags(m[1]));
  const blockquotes = [...main.matchAll(/<blockquote[\s\S]*?<\/blockquote>/gi)].map((m) => stripTags(m[0]));
  // 答案块:站内约定用 class="answer" 显式标注;缺失时退回 h1 之后的首个段落。
  // (首页等视觉落地页 h1 后紧跟的是标语,取首段会误判——以显式标注为准)
  const marked = main.match(/<p[^>]*class="[^"]*\banswer\b[^"]*"[^>]*>([\s\S]*?)<\/p>/i)?.[1]
    ?? main.match(/<div[^>]*class="[^"]*\banswer\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i)?.[1];
  const afterH1 = main.split(/<\/h1>/i)[1] ?? main;
  const firstP = stripTags(marked ?? afterH1.match(/<p[^>]*>([\s\S]*?)<\/p>/i)?.[1] ?? '');
  // 按 h2 切块,量化每块可提取长度
  const chunks = main.split(/<h2[^>]*>/i).slice(1).map((c) => stripTags(c));
  const text = stripTags(main);
  return { text, h1, h2s, h3s, links, jsonld, blockquotes, firstP, chunks, tables: (main.match(/<table/gi) ?? []).length };
}

// 中文按字计、英文按词计,统一折算为「等效字数」用于密度口径
const weight = (text) => {
  const cjk = (text.match(/[一-鿿]/g) ?? []).length;
  const words = (text.match(/[A-Za-z][A-Za-z'-]*/g) ?? []).length;
  return cjk + words * 1.6; // 1 英文词 ≈ 1.6 汉字信息量(粗口径,仅用于密度归一)
};

// ---------- 各维度评分 ----------
// ① 来源引用:指向第三方可核验来源的链接(排除自有域与备案域)
function scoreCite(p) {
  const ext = [...new Set(p.links
    .filter((u) => !OWN_DOMAINS.some((d) => u.includes(d)))
    .filter((u) => !NON_CITE_DOMAINS.some((d) => u.includes(d)))
    .map((u) => { try { return new URL(u).hostname; } catch { return null; } })
    .filter(Boolean))];
  // 归一:每千等效字应至少 2 个独立第三方来源域;满分需 ≥3 个域
  const per1k = ext.length / Math.max(1, weight(p.text) / 1000);
  const ratio = Math.min(1, (Math.min(ext.length, 3) / 3) * 0.7 + Math.min(1, per1k / 2) * 0.3);
  return { ratio, detail: ext.length ? `${ext.length} 个第三方来源域: ${ext.slice(0, 5).join(', ')}` : '无第三方来源引用' };
}

// ② 统计数据:可被引擎摘出的具体数字(带单位/百分比),排除年份与版本号
// 单位表分中英两组:此前只有中文量词,导致同一批实测数字在中文页命中、英文页判零——
// 「8 个模型 / 384 次真实请求」得分,而同源同事实的「8 connected models / 384 real requests」不得分,
// 失分来自语言而非内容。英文侧单位需词边界收尾(中文无需),避免 "8 modelsomething" 类误命中。
const UNIT_ZH = '%|％|毫秒|秒|分钟|小时|天|倍|万|亿|千|个|家|条|次|项|类|人|元|美元';
const UNIT_EN = 'ms|milliseconds?|seconds?|secs?|minutes?|mins?|hours?|days?|weeks?|months?'
  + '|models?|providers?|engines?|requests?|calls?|queries|query|samples?|rounds?|pages?|sources?|domains?'
  + '|keys?|teams?|projects?|regions?|items?|users?|fields?|steps?|checks?|rules?|tokens?'
  + '|times|percent|percentage points?|TPS|QPS|req\\/s|USD|RMB|CNY|x|×';
// 英文常见连字符定语(90-second timeout / 8-model matrix)也应计入,故间隔允许 "-"
const STAT_RE = new RegExp(
  String.raw`(?<![\w.])\d{1,3}(?:[,，]\d{3})*(?:\.\d+)?[\s-]*(?:(?:${UNIT_ZH})|(?:${UNIT_EN})\b)`, 'gi');
const YEAR_RE = /(19|20)\d{2}\s*(?:年|-)/g;
function scoreStats(p) {
  const raw = p.text.replace(YEAR_RE, ' ');
  const hits = raw.match(STAT_RE) ?? [];
  const per1k = hits.length / Math.max(1, weight(p.text) / 1000);
  // 目标密度:每千等效字 ≥4 个可引用数字
  const ratio = Math.min(1, per1k / 4);
  return { ratio, detail: hits.length ? `${hits.length} 处数字(${per1k.toFixed(1)}/千字): ${[...new Set(hits)].slice(0, 5).join(' / ')}` : '无可引用统计数字' };
}

// ③ 引述:blockquote 或引号包裹的实质陈述(≥12 字),需邻近来源标注才算高质量
const ATTRIB_RE = /据|来源|引自|参见|表示|指出|according to|source:|cited/i;
function scoreQuote(p) {
  const inline = [...p.text.matchAll(/[“"]([^”"]{12,})[”"]/g)].map((m) => m[1]);
  const all = [...p.blockquotes, ...inline];
  // 出处判定同样按语言对称:中文看「来源」,英文看 source/sources(此前只有中文兜底)
  const hasSourceNote = /来源/.test(p.text) || /\bsources?\b/i.test(p.text);
  const attributed = all.filter((q) => ATTRIB_RE.test(q) || hasSourceNote);
  const ratio = Math.min(1, (Math.min(all.length, 2) / 2) * 0.6 + (Math.min(attributed.length, 2) / 2) * 0.4);
  return { ratio, detail: all.length ? `${all.length} 处引述(${attributed.length} 处带出处)` : '无引述' };
}

// ④ 答案前置:h1 后首段是否为可直接摘用的定义句
const DEF_RE = /是|指的?是|为一(种|类)|means|refers to|is an?\s/i;
function scoreAnswer(p) {
  const w = weight(p.firstP);
  const ok = DEF_RE.test(p.firstP);
  // 理想 60~220 等效字:太短无信息,太长引擎难整段摘用
  const lenScore = w === 0 ? 0 : w < 40 ? 0.3 : w <= 220 ? 1 : 0.6;
  const ratio = ok ? lenScore : lenScore * 0.5;
  return { ratio, detail: w === 0 ? '缺答案段' : `首段 ${Math.round(w)} 等效字${ok ? '·含定义句式' : '·非定义句式'}` };
}

// ⑤ 可提取块:按 h2 切分后每块长度是否适合 RAG 分块摘用
function scoreChunk(p) {
  if (!p.chunks.length) return { ratio: 0, detail: '无 h2 分块' };
  const ws = p.chunks.map(weight);
  const good = ws.filter((w) => w >= 80 && w <= 600).length;
  const q = p.h2s.filter((h) => /[?？]$|^(如何|什么|为什么|怎么|哪些|能否|是否)|^(how|what|why|which|can|does|is)\b/i.test(h)).length;
  const ratio = Math.min(1, (good / ws.length) * 0.6 + (p.h2s.length ? Math.min(1, q / p.h2s.length) : 0) * 0.4);
  return { ratio, detail: `${p.chunks.length} 块,${good} 块长度达标,${q}/${p.h2s.length} 个 h2 为问句式` };
}

// ⑥ 新鲜度:dateModified 距今天数(引擎偏好近期更新的来源)
function scoreFresh(days) {
  if (days == null) return { ratio: 0.5, detail: '无 dateModified' };
  const ratio = days <= 30 ? 1 : days <= 60 ? 0.7 : days <= 120 ? 0.4 : 0.15;
  return { ratio, detail: `${days} 天前更新` };
}

// ⑦ 实体锚定:标准称谓与消歧在可见正文中的出现(非仅埋在 JSON-LD)
function scoreEntity(p) {
  const brand = (p.text.match(/smaapi|均路|SMA\s*网关/gi) ?? []).length;
  const disambig = /与金融指标|与.{0,6}同名|移动平均|光伏|unrelated to/i.test(p.text);
  const hasOrg = p.jsonld.some((o) => o['@type'] === 'Organization');
  const ratio = Math.min(1, Math.min(brand, 3) / 3 * 0.6 + (disambig ? 0.2 : 0) + (hasOrg ? 0.2 : 0));
  return { ratio, detail: `正文品牌词 ${brand} 次${disambig ? '·含消歧' : '·无消歧句'}${hasOrg ? '·Organization 就位' : ''}` };
}

// ---------- 主流程 ----------
const registry = JSON.parse(readFileSync(resolve(root, 'src/data/pages.json'), 'utf8'));
const today = new Date(argOf('--today', new Date().toISOString().slice(0, 10)));
const daysSince = (d) => (d ? Math.round((today - new Date(d)) / 86400000) : null);

const dir = argOf('--dir', resolve(root, 'dist'));
if (!existsSync(dir)) {
  console.error(`目录不存在: ${dir}(先 npm run build,或用 --dir 指定 HTML 快照目录)`);
  process.exit(2);
}

const walk = (d) => readdirSync(d).flatMap((f) => {
  const p = join(d, f);
  return statSync(p).isDirectory() ? walk(p) : p.endsWith('.html') ? [p] : [];
});

// 快照目录用文件名反推路由;dist 用相对路径反推
const routeOf = (file) => {
  const rel = file.slice(dir.length + 1);
  if (rel.endsWith('index.html')) return '/' + rel.slice(0, -'index.html'.length);
  return '/' + rel.replace(/\.html$/, '').replace(/^_/, '').replace(/_/g, '/').replace(/^\/?home$/, '');
};

const auditAll = argv.includes('--all');
const results = [];
const skipped = [];
for (const file of walk(dir).sort()) {
  const html = readFileSync(file, 'utf8');
  const p = parse(html);
  if (!p.h1 && !p.text) continue;
  let route = routeOf(file);
  if (route !== '/' && route.endsWith('/')) route = route.slice(0, -1);
  const reg = registry.pages.find((x) => x.route === route || x.route === route + '/');
  // 注册表单一真源:未注册的产物(百度/IndexNow 验证文件等)不是内容页,不进审计
  if (!reg && !auditAll) { skipped.push(route); continue; }
  const dims = {
    cite: scoreCite(p), stats: scoreStats(p), quote: scoreQuote(p), answer: scoreAnswer(p),
    chunk: scoreChunk(p), fresh: scoreFresh(daysSince(reg?.dateModified)), entity: scoreEntity(p),
  };
  const score = Object.entries(WEIGHTS).reduce((s, [k, w]) => s + dims[k].ratio * w, 0);
  results.push({ route, score: Math.round(score), words: Math.round(weight(p.text)), dims, draft: reg?.draft ?? null });
}

results.sort((a, b) => a.score - b.score);

const bar = (v, w) => { const n = Math.round((v / w) * 5); return '█'.repeat(n) + '·'.repeat(5 - n); };
console.log(`\n可引用性审计 — ${results.length} 页(目录 ${dir})`);
console.log('权重: 来源25 数字25 引述15 答案10 分块10 新鲜10 实体5\n');
console.log(`${'页面'.padEnd(40)} ${'分'.padStart(3)} ${'字数'.padStart(5)}  来源  数字  引述  答案  分块  新鲜  实体`);
for (const r of results) {
  const d = r.dims;
  console.log(
    `${r.route.padEnd(40)} ${String(r.score).padStart(3)} ${String(r.words).padStart(5)}  ` +
    `${bar(d.cite.ratio * WEIGHTS.cite, WEIGHTS.cite)} ${bar(d.stats.ratio * WEIGHTS.stats, WEIGHTS.stats)} ` +
    `${bar(d.quote.ratio * WEIGHTS.quote, WEIGHTS.quote)} ${bar(d.answer.ratio * WEIGHTS.answer, WEIGHTS.answer)} ` +
    `${bar(d.chunk.ratio * WEIGHTS.chunk, WEIGHTS.chunk)} ${bar(d.fresh.ratio * WEIGHTS.fresh, WEIGHTS.fresh)} ` +
    `${bar(d.entity.ratio * WEIGHTS.entity, WEIGHTS.entity)}`
  );
}

const avg = results.reduce((s, r) => s + r.score, 0) / Math.max(1, results.length);
const dimAvg = Object.fromEntries(Object.keys(WEIGHTS).map((k) => [k, results.reduce((s, r) => s + r.dims[k].ratio, 0) / Math.max(1, results.length)]));
console.log(`\n全站均分: ${avg.toFixed(1)}/100`);
console.log('维度达成率(越低越是杠杆点):');
for (const [k, w] of Object.entries(WEIGHTS).sort((a, b) => dimAvg[a[0]] - dimAvg[b[0]])) {
  console.log(`  ${k.padEnd(7)} ${(dimAvg[k] * 100).toFixed(0).padStart(3)}%   丢分 ${((1 - dimAvg[k]) * w).toFixed(1)} 分/页`);
}

const worst = results.slice(0, 5);
console.log('\n最需整改的 5 页:');
for (const r of worst) {
  console.log(`\n  ${r.route}  (${r.score} 分)`);
  for (const k of ['cite', 'stats', 'quote', 'answer', 'chunk']) {
    if (r.dims[k].ratio < 0.6) console.log(`    ✗ ${k}: ${r.dims[k].detail}`);
  }
}

const jsonOut = argOf('--json');
if (jsonOut) {
  writeFileSync(jsonOut, JSON.stringify({ generatedFor: dir, today: today.toISOString().slice(0, 10), weights: WEIGHTS, average: Number(avg.toFixed(1)), dimensionAverage: dimAvg, pages: results }, null, 2));
  console.log(`\nJSON 已写出: ${jsonOut}`);
}

if (skipped.length) console.log(`\n(跳过 ${skipped.length} 个非注册产物: ${skipped.slice(0, 3).join(', ')}${skipped.length > 3 ? ' …' : ''};--all 可纳入)`);

// 基线记录:把当前分数固化为「不许倒退」的参照
const writeBaseline = argOf('--write-baseline');
if (writeBaseline) {
  const base = Object.fromEntries(results.map((r) => [r.route, r.score]));
  writeFileSync(writeBaseline, JSON.stringify({ today: today.toISOString().slice(0, 10), average: Number(avg.toFixed(1)), scores: base }, null, 2));
  console.log(`\n基线已写出: ${writeBaseline}(${results.length} 页,均分 ${avg.toFixed(1)})`);
}

let failed = false;

// 回归闸门:整改期间先锁「不许倒退」,比绝对阈值更适合当前分数水位
const baselineFile = argOf('--baseline');
if (baselineFile) {
  if (!existsSync(baselineFile)) {
    console.error(`\n基线文件不存在: ${baselineFile}(先用 --write-baseline 生成)`);
    process.exit(2);
  }
  const tol = Number(argOf('--tolerance', 2));
  const base = JSON.parse(readFileSync(baselineFile, 'utf8')).scores ?? {};
  const regressed = results.filter((r) => base[r.route] != null && r.score < base[r.route] - tol);
  const added = results.filter((r) => base[r.route] == null);
  if (regressed.length) {
    console.error(`\n可引用性回归闸门失败: ${regressed.length} 页低于基线(容差 ${tol} 分)`);
    for (const r of regressed) console.error(`  - ${r.route}: ${base[r.route]} → ${r.score}`);
    failed = true;
  } else {
    console.log(`\n可引用性回归闸门通过: 无页面低于基线(容差 ${tol} 分)${added.length ? `;新增 ${added.length} 页未入基线` : ''}`);
  }
}

const min = Number(argOf('--min-score', 0));
if (min > 0) {
  const below = results.filter((r) => r.score < min && !r.draft);
  if (below.length) {
    console.error(`\n可引用性闸门失败: ${below.length} 页低于 ${min} 分`);
    for (const r of below) console.error(`  - ${r.route} (${r.score})`);
    failed = true;
  } else {
    console.log(`\n可引用性闸门通过: 全部 ≥ ${min} 分`);
  }
}

if (failed) process.exit(1);
