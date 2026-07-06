// llms.txt / llms-full.txt 校验(自研,替代 npm 不在档的 llms-txt-validator;增补件 A2)。
// 依据 llmstxt.org 规范:H1 + 引言 blockquote + H2 小节 + Markdown 链接列表;链接须为本站绝对地址。
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(resolve(root, p), 'utf8');
const errors = [];

const { site, pages: allPages } = JSON.parse(read('src/data/pages.json'));
// draft 页(无真实数据未发布,如 T2 占位态)不进 llms.txt/llms-full.txt,与生成器一致
const pages = allPages.filter((p) => !p.draft);
const llms = read('dist/llms.txt');
const lines = llms.split('\n');

if (!lines[0]?.startsWith('# ')) errors.push('首行必须是 H1(# )');
if (!lines.some((l) => l.startsWith('> '))) errors.push('缺少引言 blockquote(> )');
if (!lines.some((l) => l.startsWith('## '))) errors.push('缺少 H2 小节(## )');

const linkRe = /^- \[[^\]]+\]\((\S+?)\)(: .+)?$/;
const linkedUrls = [];
for (const l of lines.filter((l) => l.startsWith('- '))) {
  const m = l.match(linkRe);
  if (!m) errors.push(`链接行格式不符: ${l}`);
  else {
    if (!m[1].startsWith(site)) errors.push(`非本站绝对链接: ${m[1]}`);
    linkedUrls.push(m[1]);
  }
}
for (const p of pages) {
  if (!linkedUrls.includes(site + p.route)) errors.push(`注册表页面未收录: ${p.route}`);
}

const full = read('dist/llms-full.txt');
if (full.length < 2000) errors.push(`llms-full.txt 过短(${full.length} chars),正文提取疑似失败`);
for (const p of pages) {
  if (!full.includes(`URL: ${site + p.route}`)) errors.push(`llms-full.txt 缺少页面: ${p.route}`);
}
if (/<[a-z][^>]*>/i.test(full)) errors.push('llms-full.txt 残留 HTML 标签');

if (errors.length) {
  console.error(`llms.txt 校验失败(${errors.length} 项):`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log(`llms.txt 校验通过: ${pages.length} 页全收录;llms-full.txt ${full.length} chars 无标签残留`);
