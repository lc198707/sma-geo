// 生成 dist/sitemap.xml,lastmod 取自页面注册表(主 spec §1.4)。
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { site, pages: allPages } = JSON.parse(readFileSync(resolve(root, 'src/data/pages.json'), 'utf8'));
// 门控:draft 页(无真实数据未发布,如 T2 占位态)不进 sitemap
const pages = allPages.filter((p) => !p.draft);

// E3(r12):每 URL 双语 hreflang 互指注记
const urls = pages
  .map((p) => {
    const alt = pages.find((q) => q.route === p.alternate);
    const links = [
      `    <xhtml:link rel="alternate" hreflang="${p.lang === 'zh' ? 'zh-CN' : 'en'}" href="${site + p.route}"/>`,
      alt ? `    <xhtml:link rel="alternate" hreflang="${alt.lang === 'zh' ? 'zh-CN' : 'en'}" href="${site + alt.route}"/>` : '',
    ].filter(Boolean).join('\n');
    return `  <url>
    <loc>${site + p.route}</loc>
    <lastmod>${p.dateModified}</lastmod>
${links}
  </url>`;
  })
  .join('\n');

const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
${urls}
</urlset>
`;

writeFileSync(resolve(root, 'dist/sitemap.xml'), xml);

// sitemap 索引:部分 AI 爬虫(实测 DeepSeekBot 2026-06-18)会主动探测 /sitemap-index.xml,
// 缺失即 404。站点只有一张 sitemap,索引仅指向它——成本近零,少一次无谓的 404。
const latest = pages.map((p) => p.dateModified).filter(Boolean).sort().at(-1);
const indexXml = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap>
    <loc>${site}/sitemap.xml</loc>${latest ? `
    <lastmod>${latest}</lastmod>` : ''}
  </sitemap>
</sitemapindex>
`;
writeFileSync(resolve(root, 'dist/sitemap-index.xml'), indexXml);

console.log(`sitemap.xml generated: ${pages.length} urls (+ sitemap-index.xml)`);
