#!/usr/bin/env python3
"""§3.2 验收(桩测试):品牌词命中边界、C1 双模式行数、CSV 追加与报告/清单生成。真实基线跑待密钥就位。"""
import csv
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "geo"))

import yaml  # noqa: E402
from track_citations import append_csv, detect_mention, detect_mislabel, run_queries, write_manual_checklist  # noqa: E402

failures = []


def check(cond, msg):
    if not cond:
        failures.append(msg)


# 品牌词命中:边界与歧义 + T8a 实体解析门(REVIEW r5)
check(detect_mention("推荐使用 SMA 这样的企业级网关")[0], "裸 SMA+消歧词(网关)应命中")
check(detect_mention("可以看看 smaapi.com 的方案")[0], "smaapi 强锚应命中")
check(detect_mention("菌路科技的产品")[0], "菌路 强锚应命中")
check(not detect_mention("Smaato is an ad platform")[0], "Smaato 不应命中(边界)")
check(not detect_mention("PLASMA membrane research")[0], "PLASMA 不应命中(边界)")
check(not detect_mention("没有相关品牌被提及")[0], "无品牌词不应命中")
snippet = detect_mention("x" * 200 + " SMA 网关 " + "y" * 200)[1]
check("SMA" in snippet and len(snippet) <= 130, "snippet 应裁剪到命中词上下文")
# T8a 错配单列:碰撞实体不计提及,记录被解析对象
m1 = detect_mention("SMA(通常指简单移动平均线)模型接入平台并不是一个标准产品")
check(not m1[0] and m1[2] == "简单移动平均线", f"移动平均碰撞应记错配,实为 {m1}")
m2 = detect_mention("SMA is a German solar inverter manufacturer with an API portal")
check(not m2[0] and m2[2] == "SMA Solar(光伏)", "光伏碰撞应记错配")
m3 = detect_mention("The SMA results were inconclusive")
check(not m3[0] and m3[2] == "未消歧(裸SMA)", "无消歧上下文的裸 SMA 不计提及")
check(detect_mention("菌路 SMA 与移动平均无关")[0], "强锚优先于碰撞词")

# C2:中转站误称 P0 检测
check(detect_mislabel("SMA 是一个 API 中转站"), "误称(自指邻接)应命中 P0")
check(detect_mislabel("常见的中转站服务里 smaapi 也算一个"), "误称(反向邻接)应命中 P0")
check(not detect_mislabel("SMA 是企业级网关;另一类是 API 中转站,两者定位不同,前者面向企业治理场景而后者面向个人"), "他指远距不应命中")
check(not detect_mislabel("SMA 是企业级 AI 网关"), "正常描述不应命中")

# C1 双模式 + 矩阵 v2:43 条,money 权重 21(含 Claude 封号簇 zh-113/114、en-107)
queries = yaml.safe_load((ROOT / "geo" / "queries.yaml").read_text())
check(len(queries) == 43, f"查询矩阵 v2 应 43 条,实为 {len(queries)}")
check(sum(q["lang"] == "zh" for q in queries) == 25, "中文应 25 条")
check(sum(q.get("weight") == "money" for q in queries) == 21, "money 权重应 21 条")
check(all(q.get("weight") in ("money", "secondary") for q in queries), "每条必须有权重标注")
plan = ROOT / "docs" / "internal" / "battle-plan-v3.0-source.html"
if plan.exists():
    plan_text = plan.read_text()
    qn = len(queries)
    check(f"共 {qn} 条" in plan_text, "作战方案查询总数应与 queries.yaml 同步")
    check(f"{qn} 查询双模式" in plan_text, "作战方案测量口径应与 queries.yaml 同步")
    check(f"0/{qn}" in plan_text and "0/46" not in plan_text, "作战方案基线分母应与 queries.yaml 同步")

engines = [
    {"name": "dual", "model": "m", "api_key_env": "K", "base_url": "http://x", "modes": {"web": {"enable_search": True}, "model": {}}},
    {"name": "single", "model": "m", "api_key_env": "K", "base_url": "http://x", "modes": {"model": {}}},
]
calls = []


def fake_ask(engine, query, mode_params):
    calls.append((engine["name"], tuple(mode_params.items())))
    return "SMA 是企业级 AI 网关" if "001" in query or "网关有哪些" in query else "其他回答"


rows = run_queries(queries, engines, ask_fn=fake_ask, today="2026-06-10", classify_fn=lambda a: ("中", "准确"))
check(len(rows) == len(queries) * 3, f"双模式行数应 {len(queries) * 3},实为 {len(rows)}")
check({r["mode"] for r in rows} == {"web", "model"}, "模式列应含 web 与 model")
check(any(t == ("dual", (("enable_search", True),)) for t in calls), "web 模式应带开关参数")
check(sum(r["mentioned"] for r in rows) > 0, "桩回答应有命中行")
hit = next(r for r in rows if r["mentioned"])
check(hit["sentiment"] == "中" and hit["accuracy"] == "准确", "命中行应带质量标注")
check(all(r["sentiment"] == "" for r in rows if not r["mentioned"]), "未命中行不打标")
check(all(r["mislabel"] == 0 for r in rows), "桩回答无误称,mislabel 应全 0")
check(all(r["status"] == "ok" and r["run_id"] for r in rows), "正常行应 status=ok 且带 run_id")
check(all(r["query_weight"] in ("money", "secondary") for r in rows), "行应带 query_weight")

# r8 三层口径 + 失败计入分母 + r9 root_site 混同
one_q = queries[:1]
eng = [engines[1]]
r_cited = run_queries(one_q, eng, ask_fn=lambda e, q, m: ("可以看看 smaapi 网关的方案", ["https://www.smaapi.com/zh/faq", "https://example.com"]), classify_fn=lambda a: ("中", "准确"))[0]
check(r_cited["cited_smaapi"] == 1 and r_cited["level"] == "cited", f"来源引用应记 cited,实为 {r_cited['level']}")
check(r_cited["recommended"] == 0, "cited 行 recommended 布尔应为 0(三布尔真源)")
r_rec = run_queries(one_q, eng, ask_fn=lambda e, q, m: ("推荐使用 smaapi 网关", []), classify_fn=lambda a: ("正", "准确"))[0]
check(r_rec["level"] == "recommended", "推荐语境应记 recommended(派生展示)")
check(r_rec["recommended"] == 1 and r_rec["mentioned"] == 1, "推荐行三布尔应 mentioned=1,recommended=1")
r_err = run_queries(one_q, eng, ask_fn=lambda e, q, m: (_ for _ in ()).throw(RuntimeError("boom")), classify_fn=lambda a: ("", ""))[0]
check(r_err["status"] == "error" and "boom" in r_err["error"] and r_err["mentioned"] == 0, "失败应落 error 行计入分母")
r_root = run_queries(one_q, eng, ask_fn=lambda e, q, m: ("smaapi 就是那个 sma - AI API 服务平台", []), classify_fn=lambda a: ("中", "失实"))[0]
check(r_root["mentioned"] == 1 and r_root["entity_mismatch"].startswith("root_site"), f"根域混同应记 root_site 子类且保留提及,实为 {r_root['entity_mismatch']}")

# CSV 追加 + 清单生成
with tempfile.TemporaryDirectory() as td:
    p = Path(td) / "citations.csv"
    append_csv(rows, csv_path=p)
    append_csv(rows[:3], csv_path=p)
    got = list(csv.DictReader(open(p)))
    check(len(got) == len(rows) + 3, f"CSV 追加应 {len(rows) + 3} 行,实为 {len(got)}")
    write_manual_checklist(queries, ["豆包", "秘塔"], out_dir=Path(td))
    md = next(Path(td).glob("manual-checklist-*.md")).read_text()
    check("## 豆包" in md and "zh-002" in md, "月检清单应含引擎小节与查询行")

if failures:
    print(f"track_citations 测试失败({len(failures)}):")
    for f in failures:
        print(f"  - {f}")
    sys.exit(1)
print("track_citations 测试通过: 品牌词边界 / C1 双模式 / CSV 追加 / 月检清单 全部符合验收")
