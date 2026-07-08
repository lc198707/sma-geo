// 公网哨兵(r8 批次 A + r9 §4 口径)
// www = 门禁:全量 smoke 任一失败即非零退出。
// 根域 = 监视哨:上游站点为常态基线,仅记录留证;升级告警(GitHub warning 注记,不门禁)仅限:
//   ① 出现我方标识(假冒) ② 301/302 指向非我方目标 ③ 钓鱼/挂马特征(此处以①②为自动化代理,人工月检兜底)
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { site } = JSON.parse(readFileSync(resolve(root, 'src/data/pages.json'), 'utf8'));

const get = async (url) => {
  const res = await fetch(url, { redirect: 'manual', headers: { 'User-Agent': 'sma-geo-sentinel' } });
  return { status: res.status, type: res.headers.get('content-type') ?? '', location: res.headers.get('location') ?? '', body: res.status < 300 ? await res.text() : '' };
};

const errors = [];
const gate = (cond, msg) => { if (!cond) errors.push(msg); };

// —— www 门禁 ——
const home = await get(`${site}/`);
gate(home.status === 200, `首页 ${home.status}`);
gate(home.type.includes('text/html'), `首页 content-type: ${home.type}`);
gate(home.body.includes(`rel="canonical" href="${site}/"`), '首页 canonical 缺失或不符');
gate(home.body.includes('企业级 AI 网关'), '首页关键词缺失');

const robots = await get(`${site}/robots.txt`);
gate(robots.status === 200 && robots.body.includes(`Sitemap: ${site}/sitemap.xml`), 'robots.txt 异常');
const sitemap = await get(`${site}/sitemap.xml`);
gate(sitemap.status === 200 && sitemap.body.includes('<urlset'), 'sitemap.xml 异常');
const llms = await get(`${site}/llms.txt`);
gate(llms.status === 200 && llms.body.startsWith('# '), 'llms.txt 异常');
const article = await get(`${site}/zh/what-is-llm-gateway`);
gate(article.status === 200 && article.body.includes('TechArticle'), '定义页或 TechArticle 异常');

// —— 根域监视哨(不门禁) ——
try {
  const r = await get('https://smaapi.com/');
  const title = r.body.match(/<title[^>]*>([^<]*)<\/title>/)?.[1] ?? '';
  const digest = createHash('sha256').update(r.body || r.location).digest('hex').slice(0, 12);
  console.log(`[根域监视] status=${r.status} title="${title.slice(0, 40)}" location="${r.location}" digest=${digest}`);
  if (/smaapi\s*Gateway|均路|菌路|SMA 网关/i.test(r.body)) {
    console.log('::warning::根域内容出现我方标识 —— 假冒风险,需人工核查(r9 §4 ①)');
  }
  if ([301, 302, 308].includes(r.status) && r.location && !r.location.startsWith(site)) {
    console.log(`::warning::根域重定向至非我方目标: ${r.location}(r9 §4 ③)`);
  }
} catch (err) {
  console.log(`[根域监视] 抓取失败: ${err.message}(留证,不门禁)`);
}

if (errors.length) {
  console.error(`公网哨兵门禁失败(${errors.length}):`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log(`公网哨兵通过: ${site} 全量 smoke 正常`);
