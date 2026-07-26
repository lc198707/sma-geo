#!/usr/bin/env node
// 生成机器可读数据端点(dist/data/*.json),供 AI 客户端 / MCP server / 第三方直接取用。
//
// 动机:接入指数目前只有 HTML,机器要取数就得解析页面。提供 JSON 端点后,
// 引擎与工具可以直接引用结构化数据,且每条记录自带 canonical 与口径说明——
// 被转引时不容易丢失「这是哪一期、什么口径」。
//
// 纪律:数据源仍是 geo-report.generated.json(构建管道注入),此处只做格式转换,
// 不新增、不加工任何数字;未发布(published=false)时输出显式的空态,不编造。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { site } = JSON.parse(readFileSync(resolve(root, 'src/data/pages.json'), 'utf8'));
const report = JSON.parse(readFileSync(resolve(root, 'src/data/geo-report.generated.json'), 'utf8'));

const outDir = resolve(root, 'dist/data');
mkdirSync(outDir, { recursive: true });

const published = report.published === true;
const payload = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  name: 'smaapi model access index',
  description:
    'Measured probe availability per connected model x channel for the SMA gateway (smaapi, Slime Mould Tech). ' +
    'Figures are produced by the build pipeline from gateway probe exports and are never hand-filled.',
  publisher: { name: '均路科技 / Slime Mould Tech', url: site },
  canonical: {
    zh: `${site}/zh/reports/model-access-benchmark`,
    en: `${site}/en/reports/model-access-benchmark`,
  },
  transparency: `${site}/zh/transparency`,
  published,
  as_of: report.as_of ?? null,
  window: report.window_days ? `${report.window_days}-day rolling` : 'current probe batch',
  measurement: report.measurement,
  latency_available: report.latencyAvailable === true,
  latency_note: report.p95_definition,
  sample_threshold: report.thresholdSampleCount,
  // 引用约定随数据一起走:被转引时口径不容易丢
  citation_terms: [
    'Availability is a probe success rate, not an SLA.',
    'Always carry the as_of date; do not present one period as a standing claim.',
    'Attribute to www.smaapi.com and link the canonical page above.',
  ],
  rows: published
    ? report.rows.map((r) => ({
        model: r.model_alias,
        channel: r.channel_type,
        availability_pct: r.availability_pct,
        p50_ms: r.p50_ms,
        p95_ms: r.p95_ms,
        sample_count: r.sample_count,
        as_of: r.as_of,
      }))
    : [],
  ...(published ? {} : { empty_reason: report.reason || 'no published measurement' }),
};

writeFileSync(resolve(outDir, 'model-access-index.json'), JSON.stringify(payload, null, 2) + '\n');
console.log(`data endpoints generated: model-access-index.json (${payload.rows.length} rows, published=${published})`);
