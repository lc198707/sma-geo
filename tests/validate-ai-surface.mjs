// AI 原生分发面校验:.md 镜像 / 机器可读数据端点 / ai.txt。
//
// 动机:这三样是 2026-07-26 那批「AI 原生分发面」的产物,上线时只做了一次人工 curl,
// 之后没有任何闸门看着它们。生成器一旦改坏(镜像缺页、front-matter 丢 canonical、
// 数据端点口径漂移、ai.txt 少了入口),构建照样绿灯,而这些文件正是给引擎看的那一面。
// 与 robots/llms/sitemap 三个既有闸门同级:fail-closed,构建期就拦住。
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(resolve(root, p), 'utf8');
const has = (p) => existsSync(resolve(root, p));
const errors = [];

const { site, pages: allPages } = JSON.parse(read('src/data/pages.json'));
const pages = allPages.filter((p) => !p.draft);

// ---------- ① .md 镜像 ----------
// 落点规则与 scripts/generate-md-mirror.mjs、Base.astro 的 mdMirror 三处必须同源
const mdPathOf = (route) => {
  const clean = route.replace(/\/$/, '');
  return clean === '' ? 'dist/index.md' : `dist${clean}.md`;
};

let mdChecked = 0;
for (const page of pages) {
  const rel = mdPathOf(page.route);
  if (!has(rel)) {
    errors.push(`.md 镜像缺失: ${rel}(注册页 ${page.route})`);
    continue;
  }
  const md = read(rel);
  mdChecked += 1;
  // front-matter 是镜像被摘走后唯一的回链凭据,缺一项都算失效
  if (!md.startsWith('---\n')) errors.push(`${rel}: 缺 front-matter`);
  const fm = md.slice(4, md.indexOf('\n---', 4));
  const canonical = site + page.route;
  if (!fm.includes(canonical)) errors.push(`${rel}: front-matter 未指向 canonical ${canonical}`);
  if (!fm.includes(page.dateModified)) errors.push(`${rel}: front-matter 未带更新时间 ${page.dateModified}`);
  // 正文得有东西:空镜像比没有镜像更糟(引擎会认为该页无内容)
  const body = md.slice(md.indexOf('\n---', 4) + 4).trim();
  if (body.length < 200) errors.push(`${rel}: 正文仅 ${body.length} 字符,疑似抽取失败`);
  // 站内链接在镜像里必须是绝对地址,否则片段被摘走后无法回溯
  for (const m of body.matchAll(/\]\((\/[^)]*)\)/g)) {
    errors.push(`${rel}: 相对链接未补全为绝对地址: ${m[1]}`);
  }
}

// draft 页不得生成镜像(未发布的数字不该以任何形态出去)
for (const page of allPages.filter((p) => p.draft)) {
  if (has(mdPathOf(page.route))) errors.push(`draft 页不应生成 .md 镜像: ${page.route}`);
}

// 每个页面的 HTML 里要声明镜像存在,否则镜像只能靠爬虫猜路径
for (const page of pages) {
  const clean = page.route.replace(/\/$/, '');
  const html = `dist${clean === '' ? '' : clean}/index.html`;
  if (!has(html)) continue;
  const doc = read(html);
  const expected = `${site}${clean === '' ? '/index.md' : `${clean}.md`}`;
  if (!doc.includes(`rel="alternate" type="text/markdown" href="${expected}"`)) {
    errors.push(`${html}: head 缺 .md 镜像声明(应指向 ${expected})`);
  }
}

// ---------- ② 机器可读数据端点 ----------
const endpoint = 'dist/data/model-access-index.json';
if (!has(endpoint)) {
  errors.push(`数据端点缺失: ${endpoint}`);
} else {
  let data;
  try {
    data = JSON.parse(read(endpoint));
  } catch (e) {
    errors.push(`${endpoint}: JSON 解析失败 ${e.message}`);
  }
  if (data) {
    const report = JSON.parse(read('src/data/geo-report.generated.json'));
    // 端点只做格式转换,不得成为第二个数据源——行数与 as_of 必须与构建产物一致
    if (report.published === true) {
      if (!Array.isArray(data.rows)) errors.push(`${endpoint}: 缺 rows 数组`);
      else if (data.rows.length !== report.rows.length) {
        errors.push(`${endpoint}: 行数 ${data.rows.length} ≠ 报告 ${report.rows.length}(端点不得自行增减行)`);
      }
      if (report.as_of && data.as_of !== report.as_of) {
        errors.push(`${endpoint}: as_of ${data.as_of} ≠ 报告 ${report.as_of}`);
      }
      // 引用约定要随数据走,否则转引时口径会掉
      const termsKey = Object.keys(data).find((k) => /citation|terms|usage/i.test(k));
      if (!termsKey) errors.push(`${endpoint}: 缺引用约定字段(citation_terms / terms / usage 至少其一)`);
      const disclaimer = JSON.stringify(data);
      if (!/SLA/i.test(disclaimer)) errors.push(`${endpoint}: 未声明「非 SLA」口径`);
    } else if (Array.isArray(data.rows) && data.rows.length > 0) {
      errors.push(`${endpoint}: 报告未发布(published=false)却输出了 ${data.rows.length} 行`);
    }
  }
}

// ---------- ③ ai.txt ----------
const aiTxtPath = 'dist/.well-known/ai.txt';
if (!has(aiTxtPath)) {
  errors.push(`ai.txt 缺失: ${aiTxtPath}`);
} else {
  const ai = read(aiTxtPath);
  // 入口清单:少一个,声明里说的「都在这」就不成立
  for (const entry of ['sitemap.xml', 'llms.txt', '.md', 'model-access-index.json']) {
    if (!ai.includes(entry)) errors.push(`ai.txt: 未列出入口 ${entry}`);
  }
  // 引用约定的三条实质要求
  if (!/as[-_ ]of|口径日期|统计时点/i.test(ai)) errors.push('ai.txt: 未要求保留 as-of 口径日期');
  if (!/SLA/i.test(ai)) errors.push('ai.txt: 未声明可用率不得表述为 SLA');
  if (!/smaapi/i.test(ai)) errors.push('ai.txt: 缺实体消歧说明');
  // 抓取放行以 robots.txt 为准,ai.txt 不得自称放行来源(两处口径打架会让引擎无所适从)
  if (!/robots\.txt/i.test(ai)) errors.push('ai.txt: 未指明抓取放行以 robots.txt 为准');
}

if (errors.length) {
  console.error('AI 分发面校验失败:');
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log(
  `AI 分发面校验通过: .md 镜像 ${mdChecked} 页(front-matter/正文/绝对链接/head 声明)、` +
    '数据端点与构建产物同源、ai.txt 入口与引用约定齐备'
);
