// T2 数据报告页 fail-closed 门控校验:验证 buildReport 只在真实 live 数据 + 达标样本下发布,
// 其余一律占位(无真实数据不发布、缺项留白、低于阈值丢弃、字段不全丢弃)。
// v1 探活版:延迟(p50/p95)可缺省——缺则留白(null),不丢整行;可用率/样本量仍必填。
import { buildReport, SAMPLE_THRESHOLD as T, SAMPLE_FLOOR } from '../scripts/build-geo-report.mjs';

const fails = [];
const check = (cond, msg) => { if (!cond) fails.push(msg); };

// 默认整行(含延迟);传 over 覆盖或删字段
const fullRow = (over = {}) => ({
  model_alias: 'model-x', channel_type: '云商用平台',
  availability_pct: 99.5, p50_ms: 420, p95_ms: 1300, sample_count: T + 50, as_of: '2026-07-01', ...over,
});
// v1 探活行:无延迟字段
const availOnlyRow = (over = {}) => ({
  model_alias: 'model-p', channel_type: '探活口径',
  availability_pct: 99.9, sample_count: T + 5, as_of: '2026-07-01', ...over,
});

// ① 无导出文件(null)→ 占位,不发布,无数字
const a = buildReport(null);
check(a.published === false && a.rows.length === 0, '① null 导出应占位不发布、无行');
check(a.as_of === null && a.window_days === null, '① 占位不得捏造 as_of/window_days');

// ② status != live(如 sample)→ 占位
const b = buildReport({ status: 'sample', as_of: '2026-07-01', window_days: 30, rows: [fullRow()] });
check(b.published === false && b.rows.length === 0, '② status=sample 应占位不发布、无行');

// ③ live + 达标行 → 发布,数字透传,按 model_alias 排序
const c = buildReport({ status: 'live', as_of: '2026-07-01', window_days: 30, rows: [fullRow(), fullRow({ model_alias: 'model-a' })] });
check(c.published === true && c.rows.length === 2, '③ live+达标应发布 2 行');
check(c.rows[0].model_alias === 'model-a', '③ 行应按 model_alias 排序');
check(c.window_days === 30 && c.latencyAvailable === true, '③ window_days 透传且 latencyAvailable=true(有延迟)');

// ④ 低于样本阈值的行丢弃并记录
const d = buildReport({ status: 'live', as_of: '2026-07-01', window_days: 30, rows: [fullRow(), fullRow({ sample_count: T - 1 })] });
check(d.published === true && d.rows.length === 1 && d.droppedBelowThreshold === 1, '④ 低于阈值行应被丢弃并计数');

// ⑤ live 但全部低于阈值 → 占位(fail-closed)
const e = buildReport({ status: 'live', as_of: '2026-07-01', window_days: 30, rows: [fullRow({ sample_count: 5 })] });
check(e.published === false && e.droppedBelowThreshold === 1, '⑤ live 但无达标行应占位不发布');

// ⑥ v1:缺延迟(p50/p95)→ 有效留白,不丢行;p50_ms/p95_ms=null;latencyAvailable=false
const f = buildReport({ status: 'live', as_of: '2026-07-01', window_days: null, sample_threshold: T, rows: [availOnlyRow()] });
check(f.published === true && f.rows.length === 1, '⑥ 探活行(无延迟)应保留,不丢');
check(f.rows[0].p50_ms === null && f.rows[0].p95_ms === null, '⑥ 缺延迟应留白为 null,不捏造');
check(f.latencyAvailable === false, '⑥ 全无延迟应 latencyAvailable=false(页面留白版)');
check(f.droppedInvalid === 0, '⑥ 缺延迟不算非法');

// ⑦ 手填防线:字符串型可用率视为非法,不进表
const g = buildReport({ status: 'live', as_of: '2026-07-01', window_days: 30, rows: [fullRow({ availability_pct: '99.5' })] });
check(g.published === false && g.droppedInvalid === 1, '⑦ 字符串可用率应判非法丢弃');

// ⑧ 延迟给了但非法(字符串)→ 判非法丢弃(防手填假延迟)
const h = buildReport({ status: 'live', as_of: '2026-07-01', window_days: 30, rows: [fullRow(), fullRow({ model_alias: 'm2', p95_ms: '1300' })] });
check(h.rows.length === 1 && h.droppedInvalid === 1, '⑧ 非法延迟值应判整行非法');

// ⑨ 缺可用率(主指标)→ 非法丢弃
const { availability_pct, ...noAvail } = availOnlyRow();
const i = buildReport({ status: 'live', as_of: '2026-07-01', window_days: 30, rows: [noAvail] });
check(i.published === false && i.droppedInvalid === 1, '⑨ 缺可用率(主指标)应判非法');

// ⑩ 导出声明 sample_threshold(探活样本单位不同)→ 采用其门(不低于地板)
const j = buildReport({ status: 'live', as_of: '2026-07-01', window_days: null, sample_threshold: SAMPLE_FLOOR + 5, rows: [availOnlyRow({ sample_count: SAMPLE_FLOOR + 6 })] }, T);
check(j.published === true && j.thresholdSampleCount === SAMPLE_FLOOR + 5, '⑩ 应采用导出声明的 sample_threshold');

// ⑪ 地板:导出把门调到近零也不生效,硬地板兜底
const k = buildReport({ status: 'live', as_of: '2026-07-01', window_days: null, sample_threshold: 1, rows: [availOnlyRow({ sample_count: SAMPLE_FLOOR - 1 })] }, T);
check(k.thresholdSampleCount === SAMPLE_FLOOR && k.published === false, '⑪ sample_threshold 不得低于硬地板 SAMPLE_FLOOR');

if (fails.length) {
  console.error(`geo-report 门控校验失败(${fails.length}):`);
  for (const m of fails) console.error(`  - ${m}`);
  process.exit(1);
}
console.log('geo-report 门控校验通过: 无数据/非 live/欠样本/缺主指标/手填 全部 fail-closed;v1 缺延迟留白不丢行;阈值地板生效');
