// T2 数据报告页构建管道(增补件 03 §T2 / T2-data-report-framework.md)。
// 铁律:无真实数据不发布、缺哪项空哪项、手填即违规。
//   输入:geo/data/geo-export.json —— SMA 网关侧导出(GET /internal/metrics/geo-export 的落盘)。
//     顶层:{ status:"live"|"sample"|..., as_of, window_days, p95_definition?, measurement?, rows:[...] }
//     行:  { model_alias, channel_type, availability_pct, p50_ms, p95_ms, sample_count, as_of }
//   处理:sample_count < 阈值 或 缺任一必填字段的行 → 丢弃并记录;status 非 live 或无达标行 → 不发布(占位)。
//   输出:src/data/geo-report.generated.json —— Astro 页面唯一消费源(页面绝不读原始导出/绝不手填)。
// 本脚本在 `astro build` 之前运行;导出文件缺失是常态(网关端点未就绪),此时落安全占位、退出 0,不阻断构建。
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXPORT_PATH = resolve(root, 'geo/data/geo-export.json');
const OUT_PATH = resolve(root, 'src/data/geo-report.generated.json');

// 发布阈值:单模型×通道样本量低于此值不进主表(样本不足的数字不可发布)。
// 导出文件可用 sample_threshold 声明自己的质量门(如探活版样本单位不同),但不得低于硬地板 SAMPLE_FLOOR。
export const SAMPLE_THRESHOLD = 100;
export const SAMPLE_FLOOR = 10;

const DEFAULT_P95 = 'P95 = 30 天滚动窗口内单模型×通道的第 95 百分位端到端延迟(含网络往返,不含客户端排队)。';
const DEFAULT_MEASUREMENT = 'SMA 网关探活与生产监控;构建管道注入,数字不手填。';

// 必填字段:可用率是主指标必须有;延迟(p50/p95)v1 探活版可缺省(缺项留白,不丢整行)。
const REQUIRED_ROW_FIELDS = ['model_alias', 'channel_type', 'availability_pct', 'sample_count', 'as_of'];

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isStr = (v) => typeof v === 'string' && v.length > 0;
// 延迟单元格:缺省→null(留白);存在则必须是合法数字(字符串/负数等非法→判整行非法,防手填)。
const optNum = (v) => (v === undefined || v === null ? null : (isNum(v) ? v : NaN));

function validRow(r) {
  if (!r || typeof r !== 'object') return false;
  for (const f of REQUIRED_ROW_FIELDS) if (!(f in r)) return false;
  if (!isStr(r.model_alias) || !isStr(r.channel_type) || !isStr(r.as_of)) return false;
  if (!isNum(r.availability_pct) || !isNum(r.sample_count)) return false;
  // 延迟给了就必须合法(NaN 表示给了非法值)
  if (Number.isNaN(optNum(r.p50_ms)) || Number.isNaN(optNum(r.p95_ms))) return false;
  return true;
}

// 导出可声明自己的样本门(sample_threshold),但不得低于硬地板,防被调到近零冒充数据。
function resolveThreshold(exportObj, defaultThreshold) {
  if (exportObj && isNum(exportObj.sample_threshold)) return Math.max(SAMPLE_FLOOR, exportObj.sample_threshold);
  return defaultThreshold;
}

// 纯函数:导出对象(或 null)→ 生成产物。无副作用,供测试断言 fail-closed 行为。
export function buildReport(exportObj, defaultThreshold = SAMPLE_THRESHOLD) {
  const threshold = resolveThreshold(exportObj, defaultThreshold);
  const placeholder = (reason) => ({
    published: false,
    reason,
    as_of: null,
    window_days: null,
    p95_definition: DEFAULT_P95,
    measurement: DEFAULT_MEASUREMENT,
    thresholdSampleCount: threshold,
    droppedBelowThreshold: 0,
    droppedInvalid: 0,
    latencyAvailable: false,
    rows: [],
  });

  if (exportObj == null) return placeholder('无导出文件:网关 /internal/metrics/geo-export 端点未就绪');
  if (typeof exportObj !== 'object') return placeholder('导出文件格式非法');
  if (exportObj.status !== 'live') return placeholder(`导出 status=${JSON.stringify(exportObj.status)}(非 live),按占位处理`);
  if (!Array.isArray(exportObj.rows)) return placeholder('导出缺 rows 数组');

  let droppedInvalid = 0;
  let droppedBelowThreshold = 0;
  const kept = [];
  for (const r of exportObj.rows) {
    if (!validRow(r)) { droppedInvalid++; continue; }
    if (r.sample_count < threshold) { droppedBelowThreshold++; continue; }
    kept.push({
      model_alias: r.model_alias,
      channel_type: r.channel_type,
      availability_pct: r.availability_pct,
      p50_ms: optNum(r.p50_ms),  // 缺省→null(页面留白)
      p95_ms: optNum(r.p95_ms),
      sample_count: r.sample_count,
      as_of: r.as_of,
    });
  }
  kept.sort((a, b) => a.model_alias.localeCompare(b.model_alias) || a.channel_type.localeCompare(b.channel_type));

  if (kept.length === 0) {
    const base = placeholder('导出为 live 但无达标行(样本量全部低于阈值或字段不全)');
    return { ...base, droppedBelowThreshold, droppedInvalid };
  }

  return {
    published: true,
    reason: '',
    as_of: isStr(exportObj.as_of) ? exportObj.as_of : kept[0].as_of,
    window_days: isNum(exportObj.window_days) ? exportObj.window_days : null,
    p95_definition: isStr(exportObj.p95_definition) ? exportObj.p95_definition : DEFAULT_P95,
    measurement: isStr(exportObj.measurement) ? exportObj.measurement : DEFAULT_MEASUREMENT,
    thresholdSampleCount: threshold,
    droppedBelowThreshold,
    droppedInvalid,
    // 延迟是否可用:任一行有 P50/P95 才为真;全 null → v1 探活版,页面延迟列留白并注明
    latencyAvailable: kept.some((r) => r.p50_ms !== null || r.p95_ms !== null),
    rows: kept,
  };
}

function main() {
  let exportObj = null;
  if (existsSync(EXPORT_PATH)) {
    try {
      exportObj = JSON.parse(readFileSync(EXPORT_PATH, 'utf8'));
    } catch (e) {
      console.error(`geo-export.json 解析失败,按占位处理: ${e.message}`);
      exportObj = { status: 'parse-error' };
    }
  }
  const report = buildReport(exportObj);
  writeFileSync(OUT_PATH, JSON.stringify(report, null, 2) + '\n');
  if (report.published) {
    console.log(`geo-report: 发布 ${report.rows.length} 行(as_of ${report.as_of});丢弃 低于阈值 ${report.droppedBelowThreshold} / 非法 ${report.droppedInvalid}`);
  } else {
    console.log(`geo-report: 占位(不发布)—— ${report.reason}`);
  }
}

// 仅作为脚本直接运行时执行 IO;被 import(测试)时不触发。
if (import.meta.url === `file://${process.argv[1]}`) main();
