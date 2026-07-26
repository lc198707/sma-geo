#!/usr/bin/env node
// 为每个注册页面生成 .md 镜像(dist/<route>.md),供 AI 爬虫直接取干净正文。
//
// 动机:AI 爬虫拿 HTML 要先剥导航/样式/脚本,提取质量取决于它的解析器;
// 直接提供 markdown 少一层损耗。docs.page / firecrawl 等生态已把「同 URL 加 .md」
// 作为事实约定,Cloudflare、Vercel 也在推同类内容协商。
// 本站是静态站,按路径落文件即可,无需服务端协商。
//
// 口径:正文取 <main>(与 generate-llms.mjs 同源),front-matter 带 canonical 与更新时间,
// 让引擎即使只读到 .md 也能回链到正式 URL。draft 页不生成。
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { site, pages: allPages } = JSON.parse(readFileSync(resolve(root, 'src/data/pages.json'), 'utf8'));
const pages = allPages.filter((p) => !p.draft);

const routeToDistHtml = (route) => {
  const clean = route.replace(/\/$/, '');
  return resolve(root, 'dist', clean === '' ? 'index.html' : `${clean.slice(1)}/index.html`);
};

// .md 落点:/ → dist/index.md;/zh/sma → dist/zh/sma.md
const routeToMd = (route) => {
  const clean = route.replace(/\/$/, '');
  return resolve(root, 'dist', clean === '' ? 'index.md' : `${clean.slice(1)}.md`);
};

const htmlToMarkdown = (html) => {
  const main = html.match(/<main[^>]*>([\s\S]*?)<\/main>/i)?.[1] ?? '';
  return main
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    // 合法 markdown 表格需要表头下的分隔行;按 <th> 数量埋占位,行转换完成后再落地
    .replace(/<thead[^>]*>([\s\S]*?)<\/thead>/gi, (_, inner) =>
      `${inner}@@MDSEP:${(inner.match(/<th[\s>]/gi) ?? []).length}@@`)
    // 链接保留为 markdown,站内相对链接补全为绝对 URL(引擎摘走片段后仍可回溯)
    .replace(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href, text) => {
      const url = href.startsWith('/') ? site + href : href;
      return `[${text.replace(/<[^>]+>/g, '').trim()}](${url})`;
    })
    .replace(/<(h[1-6])[^>]*>([\s\S]*?)<\/\1>/gi, (_, tag, text) =>
      `\n\n${'#'.repeat(Number(tag[1]))} ${text.replace(/<[^>]+>/g, '').trim()}\n`)
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_, text) => `- ${text.replace(/<[^>]+>/g, '').trim()}\n`)
    .replace(/<(th|td)[^>]*>([\s\S]*?)<\/\1>/gi, (_, __, text) => `| ${text.replace(/<[^>]+>/g, '').trim()} `)
    .replace(/<\/tr>/gi, '|\n')
    .replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, (_, text) =>
      `\n> ${text.replace(/<[^>]+>/g, '').trim().replace(/\n+/g, '\n> ')}\n`)
    .replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_, code) =>
      `\n\`\`\`\n${code.replace(/<[^>]+>/g, '').trim()}\n\`\`\`\n`)
    .replace(/<\/p>|<br\s*\/?>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/@@MDSEP:(\d+)@@\s*/g, (_, n) => `|${Array(Math.max(1, Number(n))).fill('---').join('|')}|\n`)
    .replace(/[ \t]+/g, ' ')
    // HTML 源码缩进会残留成行首空格,markdown 里 4 空格缩进会被当成代码块 —— 必须清掉
    .replace(/^[ \t]+/gm, '')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
};

let n = 0;
for (const p of pages) {
  const src = routeToDistHtml(p.route);
  if (!existsSync(src)) {
    console.error(`缺构建产物,跳过: ${p.route}`);
    continue;
  }
  const body = htmlToMarkdown(readFileSync(src, 'utf8'));
  const canonical = site + p.route;
  const md = `---
title: ${JSON.stringify(p.title)}
canonical: ${canonical}
lang: ${p.lang}
updated: ${p.dateModified}
source: ${site}
---

${body}

---
本文为 ${canonical} 的 markdown 镜像,内容与该页一致,引用请指向 canonical 地址。
`;
  const out = routeToMd(p.route);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, md);
  n++;
}
console.log(`md mirror generated: ${n} files`);
