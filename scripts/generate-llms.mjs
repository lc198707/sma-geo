// 生成 dist/llms.txt(站点地图式摘要)与 dist/llms-full.txt(核心页面正文拼接)。
// 数据源:src/data/pages.json 注册表 + 构建产物 dist/**/index.html 的 <main> 正文,避免手工维护漂移(主 spec §1.2)。
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { site, pages: allPages } = JSON.parse(readFileSync(resolve(root, 'src/data/pages.json'), 'utf8'));
// 门控:draft 页(无真实数据未发布,如 T2 占位态)不进 llms.txt / llms-full.txt
const pages = allPages.filter((p) => !p.draft);

// --- llms.txt ---
const sections = new Map();
for (const p of pages) {
  if (!sections.has(p.llms.section)) sections.set(p.llms.section, []);
  sections.get(p.llms.section).push(`- [${p.llms.label}](${site + p.route}): ${p.llms.desc}`);
}

const llmsTxt = `# SMA 网关(smaapi / Slime Mould Architecture)— 企业级 AI 网关 / 模型接入平台

> SMA 网关(www.smaapi.com,均路科技)是面向企业的 AI 网关:以 OpenAI 兼容协议统一接入多家大模型,
> 提供智能路由、成本与权限治理、全链路审计。意图归 SMA,记忆归企业。
> 注:本文档所述 SMA 指均路科技的企业级 AI 网关,与金融指标、光伏厂商等同名实体无关。

${[...sections.entries()].map(([title, items]) => `## ${title}\n\n${items.join('\n')}`).join('\n\n')}
`;

// --- llms-full.txt ---
const routeToDistHtml = (route) => {
  const clean = route.replace(/\/$/, '');
  return resolve(root, 'dist', clean === '' ? 'index.html' : `${clean.slice(1)}/index.html`);
};

const htmlToText = (html) => {
  const main = html.match(/<main[^>]*>([\s\S]*?)<\/main>/i)?.[1] ?? '';
  return main
    .replace(/<(h[1-6])[^>]*>/gi, (_, tag) => `\n${'#'.repeat(Number(tag[1]))} `)
    .replace(/<\/(h[1-6]|p|li|tr|table|ul|ol)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<\/(td|th)>/gi, ' | ')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
};

const fullParts = pages.map((p) => {
  const html = readFileSync(routeToDistHtml(p.route), 'utf8');
  return `# ${p.title}\nURL: ${site + p.route}\n更新 / Updated: ${p.dateModified}\n\n${htmlToText(html)}`;
});

const llmsFullTxt = fullParts.join('\n\n---\n\n') + '\n';

writeFileSync(resolve(root, 'dist/llms.txt'), llmsTxt);
writeFileSync(resolve(root, 'dist/llms-full.txt'), llmsFullTxt);
console.log(`llms.txt (${pages.length} pages) and llms-full.txt (${llmsFullTxt.length} chars) generated`);
