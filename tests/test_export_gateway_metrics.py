#!/usr/bin/env python3
"""T2 v1 探活导出验收:probe-results.json → geo-export.json 聚合/脱敏/fail-closed。"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "geo"))

from export_gateway_metrics import build_export, DEFAULT_CHANNEL  # noqa: E402

failures = []


def check(cond, msg):
    if not cond:
        failures.append(msg)


def domain(avail, samples, questions=1, last_run="2026-07-01T00:00:00+00:00", last_success=True):
    return {"availability": avail, "samples": samples, "questions": questions,
            "last_run": last_run, "last_success": last_success, "latency_ms": 500}


# ① 跨域按 samples 加权汇总可用率 + sample_count = Σ(samples×questions)
probe = {"models": {
    "real-x": {"alias": "model-x", "updated_at": "2026-07-01T00:00:00+00:00",
               "domains": {"code": domain(1.0, 6, 2), "chat": domain(0.5, 2, 2)}},
}}
exp = build_export(probe, min_samples=10)
check(exp["status"] == "live" and len(exp["rows"]) == 1, "① 有效模型应产出 1 行 live")
row = exp["rows"][0]
# 加权:(1.0*6 + 0.5*2)/(6+2) = 7/8 = 87.5%
check(abs(row["availability_pct"] - 87.5) < 1e-6, f"① 可用率应 samples 加权 87.5,实为 {row['availability_pct']}")
# sample_count = 6*2 + 2*2 = 16
check(row["sample_count"] == 16, f"① sample_count 应 Σ(samples×questions)=16,实为 {row['sample_count']}")
check("p50_ms" not in row and "p95_ms" not in row, "① v1 不得导出延迟字段")
check(exp["sample_threshold"] == 10 and exp["window_days"] is None, "① 应写 sample_threshold 且 window_days=None")

# ② 脱敏标签映射:model/channel 转公开口径(按 real_id 命中)
labels = {"real-x": {"model": "GPT-X", "channel": "Azure 商用平台"}}
row2 = build_export(probe, labels, min_samples=10)["rows"][0]
check(row2["model_alias"] == "GPT-X" and row2["channel_type"] == "Azure 商用平台", "② 脱敏标签应生效")

# ③ 无映射 → channel 用默认口径,model 用 alias(不暴露 real_id)
check(row["channel_type"] == DEFAULT_CHANNEL and row["model_alias"] == "model-x", "③ 无映射应回退默认口径/alias")

# ④ 从未成功(last_success 全 false)→ 不进表(不把死模型冒充可用)
dead = {"models": {"real-d": {"alias": "m-d", "domains": {"code": domain(0.0, 4, 1, last_success=False)}}}}
check(len(build_export(dead)["rows"]) == 0 and build_export(dead)["status"] == "no-data", "④ 从未成功应不进表、status=no-data")

# ⑤ 无 samples / 无 domains → 跳过(不造 0 样本行)
empty = {"models": {
    "real-e": {"alias": "m-e", "domains": {}},
    "real-z": {"alias": "m-z", "domains": {"code": domain(1.0, 0, 1)}},
}}
check(build_export(empty)["status"] == "no-data", "⑤ 无 samples/domains 应无行、no-data")

# ⑥ as_of 取各域 last_run 最大日期
multi = {"models": {"real-m": {"alias": "m-m", "domains": {
    "a": domain(1.0, 5, 1, last_run="2026-06-20T00:00:00+00:00"),
    "b": domain(1.0, 5, 1, last_run="2026-07-03T00:00:00+00:00")}}}}
check(build_export(multi)["rows"][0]["as_of"] == "2026-07-03", "⑥ as_of 应取最新探活日期")
check(build_export(multi)["as_of"] == "2026-07-03", "⑥ 顶层 as_of 应为全体最大")

# ⑦ 非法 availability(字符串)域跳过;该模型无其他有效域 → 不进表
bad = {"models": {"real-b": {"alias": "m-b", "domains": {"code": {"availability": "0.9", "samples": 5, "questions": 1, "last_success": True, "last_run": "2026-07-01T00:00:00+00:00"}}}}}
check(build_export(bad)["status"] == "no-data", "⑦ 非法 availability 域应跳过")

if failures:
    print(f"export_gateway_metrics 测试失败({len(failures)}):")
    for f in failures:
        print(f"  - {f}")
    sys.exit(1)
print("export_gateway_metrics 测试通过: 加权可用率 / sample_count / 脱敏映射 / 死模型剔除 / as_of / 手填防线 全部符合验收")
