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
console.log(`sitemap.xml generated: ${pages.length} urls`);
