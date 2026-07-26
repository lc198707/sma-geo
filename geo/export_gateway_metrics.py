#!/usr/bin/env python3
"""T2 v1 导出:SMA 网关主动探活 → geo-export.json(探活可用率版,不含延迟分位数)。

数据源:网关 scoring_probe 落盘的 probe-results.json(结构见 sma_gateway/scoring_probe.py):
  {"models": {"<real_id>": {"alias": ..., "updated_at": ...,
     "domains": {"<domain>": {availability, latency_ms, samples, questions, last_run, last_success, ...}}}}}
- availability(∈[0,1])= 探针成功率(独立于用户侧错误),按 samples 加权跨域汇总为单模型可用率。
- sample_count = Σ(samples × questions)= 该模型真实探针调用总次数(样本量,供发布阈值判定)。
- 延迟:v1 不导出。探针只有平均 latency_ms、无分位数;P50/P95 待网关补 per-request 延迟后由 v2 发布(缺项留白)。
- channel_type / model_alias:经脱敏标签映射(--labels)转公开口径,避免暴露内部 channel id/供应商账号(§F-1)。
诚实红线:只汇总真实探活数字,一律不手填;无 last_success 或无 samples 的模型不进表;
本脚本产出的 geo-export.json 交内容站 build-geo-report.mjs 二次把关(样本阈值 + 缺项留白)。

真实数据须来自**生产网关**的探活产出;本地 demo 无 probe-results.json 时按无数据处理(退出非零,不产假数据)。
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

# 口径纪律:可用率=探针成功率,而"是否成功"取决于单次调用的超时上限——换超时会换结论,
# 故超时值必须随数字一起对外披露。此处文本须与实际探活所用 run_probes(timeout_s=...) 保持一致;
# 改探活参数必须同步改本行(否则公开口径与测量事实脱节)。
PROBE_TIMEOUT_S = 90
MEASUREMENT = (
    f"SMA 网关主动探活(生产);可用率 = 探针成功率(单次调用超时上限 {PROBE_TIMEOUT_S} 秒),"
    "独立于用户侧错误。"
)
P95_NOTE = "v1 探活可用率版:不含延迟分位数;P50/P95 待网关补 per-request 延迟记录后由 v2 发布。"
DEFAULT_CHANNEL = "云端直连(探活口径)"


def _as_of(last_run: str | None) -> str:
    """ISO 时间戳 → 日期(YYYY-MM-DD);无则空串。"""
    if not isinstance(last_run, str) or len(last_run) < 10:
        return ""
    return last_run[:10]


def _label(labels: dict, real_id: str, alias: str, field: str, fallback: str) -> str:
    """脱敏标签:优先按 real_id 再按 alias 命中映射;未命中用 fallback。"""
    m = labels.get(real_id) or labels.get(alias) or {}
    v = m.get(field)
    return v if isinstance(v, str) and v else fallback


def _merge_duplicate_aliases(rows: list[dict]) -> tuple[list[dict], int]:
    """同一对外口径(model_alias + channel_type)对应多个内部 real_id 时合并为一行。

    网关同一个对外模型名可能挂多条后端通道(不同 real_id),逐条输出会让同一模型在
    公开表里出现多行互相矛盾的可用率(真实数据端到端才暴露的缺陷)。
    合并口径:可用率按探活轮数加权平均、样本量求和、as_of 取最新一次探活日期。
    仍不手填任何数字——合并只是同口径聚合。
    """
    grouped: dict[tuple[str, str], list[dict]] = {}
    for r in rows:
        grouped.setdefault((r["model_alias"], r["channel_type"]), []).append(r)
    out: list[dict] = []
    dupes = 0
    for (alias, channel), items in grouped.items():
        if len(items) == 1:
            r = dict(items[0])
            r.pop("_w", None)
            out.append(r)
            continue
        dupes += len(items) - 1
        wtot = sum(max(1, int(i.get("_w") or 1)) for i in items)
        avail = sum(i["availability_pct"] * max(1, int(i.get("_w") or 1)) for i in items) / wtot
        out.append({
            "model_alias": alias,
            "channel_type": channel,
            "availability_pct": round(avail, 2),
            "sample_count": sum(int(i["sample_count"]) for i in items),
            "as_of": max(i["as_of"] for i in items),
        })
    return out, dupes


def build_export(probe_results: dict, labels: dict | None = None, min_samples: int = 30) -> dict:
    """probe-results.json 内容 → geo-export.json 结构(纯函数,无 IO,供测试)。"""
    labels = labels or {}
    models = (probe_results or {}).get("models") or {}
    rows = []
    dates = []
    for real_id, rec in models.items():
        if not isinstance(rec, dict):
            continue
        domains = rec.get("domains")
        if not isinstance(domains, dict) or not domains:
            continue
        alias = str(rec.get("alias") or real_id)
        wsum = 0.0        # Σ availability×samples
        nsamples = 0      # Σ samples(用于加权)
        ncalls = 0        # Σ samples×questions(样本量)
        any_success = False
        model_dates = []
        for d in domains.values():
            if not isinstance(d, dict):
                continue
            s = int(d.get("samples") or 0)
            q = int(d.get("questions") or 1)
            if s <= 0:
                continue
            avail = d.get("availability")
            if not isinstance(avail, (int, float)):
                continue
            wsum += float(avail) * s
            nsamples += s
            ncalls += s * max(1, q)
            any_success = any_success or bool(d.get("last_success"))
            dt = _as_of(d.get("last_run"))
            if dt:
                model_dates.append(dt)
        if nsamples <= 0 or not any_success:
            continue  # 无有效探活/从未成功 → 不进表(不把 0 样本冒充数据)
        as_of = max(model_dates) if model_dates else _as_of(rec.get("updated_at"))
        if not as_of:
            continue
        dates.append(as_of)
        rows.append({
            "model_alias": _label(labels, real_id, alias, "model", alias),
            "channel_type": _label(labels, real_id, alias, "channel", DEFAULT_CHANNEL),
            "availability_pct": round(wsum / nsamples * 100.0, 2),
            "sample_count": ncalls,
            "as_of": as_of,
            "_w": nsamples,  # 合并权重(轮数),合并后删除,不进对外产物
            # 延迟:v1 不导出(留给 build-geo-report 留白;绝不手填)
        })
    rows, merged_dupes = _merge_duplicate_aliases(rows)
    rows.sort(key=lambda r: (r["model_alias"], r["channel_type"]))
    return {
        "status": "live" if rows else "no-data",
        "as_of": max(dates) if dates else None,
        "window_days": None,
        "measurement": MEASUREMENT,
        "p95_definition": P95_NOTE,
        "sample_threshold": int(min_samples),
        "merged_duplicate_rows": merged_dupes,
        "rows": rows,
    }


def _load_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    default_probe = os.environ.get("SMA_PROBE_RESULTS", "")
    ap.add_argument("--probe", default=default_probe,
                    help="probe-results.json 路径(或设 SMA_PROBE_RESULTS);须为生产探活产出")
    ap.add_argument("--labels", default="", help="脱敏标签映射 json:{real_id|alias: {model, channel}}")
    ap.add_argument("--min-samples", type=int, default=30, help="发布样本门(探针调用数),写入 sample_threshold")
    ap.add_argument("--out", default=str(Path(__file__).resolve().parent / "data" / "geo-export.json"))
    ap.add_argument("--dry-run", action="store_true", help="只打印摘要,不落盘")
    args = ap.parse_args()

    if not args.probe:
        print("缺 --probe / SMA_PROBE_RESULTS:未指定探活结果文件,拒绝产出(不造假数据)", file=sys.stderr)
        return 2
    probe_path = Path(args.probe).expanduser()
    if not probe_path.exists():
        print(f"探活结果不存在: {probe_path} —— 需生产网关探活先产出,不产假数据", file=sys.stderr)
        return 2
    probe = _load_json(probe_path)
    labels = _load_json(Path(args.labels).expanduser()) if args.labels else {}

    export = build_export(probe, labels, min_samples=args.min_samples)
    n = len(export["rows"])
    print(f"探活导出: {n} 个模型可用率(as_of {export['as_of']}, 样本门 {export['sample_threshold']}, 延迟 v1 留白)")
    if n == 0:
        print("  ! 无达标模型 → status=no-data(内容站按占位处理,不发布)", file=sys.stderr)
    if args.dry_run:
        print(json.dumps(export, ensure_ascii=False, indent=2))
        return 0
    out = Path(args.out).expanduser()
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(export, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"已写: {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
