#!/usr/bin/env python3
"""引用率追踪(主 spec §3.2 + 增补件 C1 双模式测量)。

- 输入:geo/queries.yaml 查询矩阵 + geo/engines.json 引擎配置(由 engines.example.json 复制,密钥走环境变量)。
- C1:支持开关的引擎每条 query 跑 web(联网检索,先行指标)与 model(纯模型记忆,品牌资产指标)两种模式,分列统计双曲线。
- 检测:品牌词命中(SMA 边界匹配排除 Smaato 类歧义、smaapi、均路/菌路[旧称]),大小写不敏感。
- 输出:geo/data/citations.csv 追加行(date,engine,mode,query_id,mentioned,snippet)+ 周度趋势报告。
- 无公开 API 的引擎走人工月检清单(--manual-checklist 生成),报告如实标注覆盖范围,抽样不冒充全量。
"""
import argparse
import csv
import hashlib
import json
import os
import re
import ssl
import sys
import urllib.request
from datetime import date
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
CSV_PATH = ROOT / "geo" / "data" / "citations.csv"
# r8 批次 A 测量分层 schema v3:三层(提及/来源引用/推荐),失败行计入分母
CSV_FIELDS = ["run_id", "date", "engine", "mode", "query_id", "query_intent", "query_weight",
              "status", "error", "mentioned", "cited_smaapi", "recommended", "level", "source_urls",
              "snippet", "sentiment", "accuracy", "mislabel", "entity_mismatch", "answer_hash"]
# E1(r12):mentioned/cited_smaapi/recommended 三布尔为真源;level 仅为派生展示字段

OUR_HOST = "www.smaapi.com"
# 推荐层启发式(宽口径,人工抽检兜底)
RECOMMEND_RE = re.compile(r"推荐|建议(使用|选)|首选|优先考虑|recommend|best (option|choice|fit)", re.IGNORECASE)
# r9 §3:根域上游站混同观察子类
ROOT_SITE_RE = re.compile(r"AI\s*API\s*服务平台")

# T8a(REVIEW r5 §2)实体解析:命中仅当消歧到我方实体;裸 SMA 碰撞多重同名实体
# 2026-07-06 公司更名 菌路→均路:双锚并存,旧称仍需命中(引擎侧存量引用清退需要时间)
STRONG_RES = [re.compile(r"smaapi", re.IGNORECASE), re.compile(r"均路|菌路"), re.compile(r"slime\s*mould", re.IGNORECASE)]
BARE_SMA_RE = re.compile(r"(?<![A-Za-z])SMA(?![A-Za-z])")
DISAMBIG_RE = re.compile(r"网关|接入|模型路由|(?<![A-Za-z])API(?![A-Za-z])|AI gateway|model access", re.IGNORECASE)
COLLISION_RES = [
    (re.compile(r"移动平均|moving average", re.IGNORECASE), "简单移动平均线"),
    (re.compile(r"光伏|太阳能|逆变器|solar|inverter", re.IGNORECASE), "SMA Solar(光伏)"),
    (re.compile(r"射频|同轴|连接器|connector|coaxial", re.IGNORECASE), "SMA 射频接头"),
    (re.compile(r"形状记忆|shape[- ]memory", re.IGNORECASE), "形状记忆合金"),
    (re.compile(r"肌萎缩|muscular atrophy", re.IGNORECASE), "脊髓性肌萎缩症"),
    (re.compile(r"AI\s*API\s*服务平台"), "root_site(根域上游站)"),
]

# C2 专项:AI 把 SMA 描述为"中转站"= P0 级纠偏事件(addendum 02v2)
# 邻接窗口 16 字符,与 terminology v2 自指/并置启发式同构(r3 §3 裁定模式)
MISLABEL_RES = [
    re.compile(r"(SMA|smaapi|均路|菌路)[^。\n]{0,16}中转", re.IGNORECASE),
    re.compile(r"中转[^。\n]{0,16}(SMA|smaapi|均路|菌路)", re.IGNORECASE),
]

QUALITY_PROMPT = (
    "你是品牌提及质量分类器。SMA 的标准称谓是\"企业级 AI 网关 / 模型接入平台\"。"
    "判断下面这段 AI 回答中对 SMA 的描述:1) 情绪是 正/中/负 哪一档;2) 描述是否与标准称谓与定位一致(准确/失实)。"
    "只输出 JSON,如 {\"sentiment\":\"中\",\"accuracy\":\"准确\"}。回答片段:\n"
)


def _save_answer(rec, answer):
    """把完整答案落到 geo/data/answers/<date>.jsonl,供后续反推引擎偏好。

    动机(2026-07-26):CSV 只在命中时留 120 字片段,未命中行没有任何答案文本,
    因此无法回答「引擎到底偏好什么内容形态」——AutoGEO 类规则抽取缺原料。
    答案全文体量大且含引擎措辞,不进 CSV、不入库(geo/data/answers/ 已 gitignore),
    只作为本地分析原料;攒够几轮后可做偏好抽取。
    路径由 CSV_PATH 派生:测试替换 CSV_PATH 时自动跟随,不会写进真实数据目录。
    """
    out_dir = CSV_PATH.parent / "answers"
    out_dir.mkdir(parents=True, exist_ok=True)
    line = {
        "run_id": rec["run_id"], "date": rec["date"], "engine": rec["engine"], "mode": rec["mode"],
        "query_id": rec["query_id"], "query_intent": rec["query_intent"], "query_weight": rec["query_weight"],
        "mentioned": rec["mentioned"], "cited": rec["cited_smaapi"], "recommended": rec["recommended"],
        "answer_hash": rec["answer_hash"], "answer": answer,
    }
    with (out_dir / f"{rec['date']}.jsonl").open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(line, ensure_ascii=False) + "\n")


def detect_mislabel(text):
    return any(rx.search(text) for rx in MISLABEL_RES)


def classify_quality(answer):
    """经 SMA 网关低成本模型自动打标;无密钥时返回空标注(抽样人工复核兜底)。"""
    if not os.environ.get("SMA_API_KEY"):
        return "", ""
    engine = {"model": "sma-domestic-fast", "base_url": "https://demo.smaapi.com/v1", "api_key_env": "SMA_API_KEY"}
    try:
        raw = ask_openai_compatible(engine, QUALITY_PROMPT + answer[:1500], {})
        data = json.loads(re.search(r"\{.*\}", raw, re.S).group(0))
        return str(data.get("sentiment", "")), str(data.get("accuracy", ""))
    except Exception as exc:
        print(f"  ! 质量打标失败(留空待人工): {exc}", file=sys.stderr)
        return "", ""

try:
    import certifi

    SSL_CTX = ssl.create_default_context(cafile=certifi.where())
except ImportError:
    SSL_CTX = ssl.create_default_context()


def _snip(text, m):
    lo, hi = max(0, m.start() - 60), min(len(text), m.end() + 60)
    return text[lo:hi].replace("\n", " ").strip()


def detect_mention(text):
    """返回 (mentioned, snippet, entity_mismatch)。

    T8a 规则:smaapi/均路(旧称菌路)/Slime Mould 为强锚直接计入;裸 SMA 须满足
    ① 无同名实体标记(碰撞词先判,错配单列)且 ② 上下文含消歧词,方计入提及。
    """
    for rx in STRONG_RES:
        m = rx.search(text)
        if m:
            return True, _snip(text, m), ""
    m = BARE_SMA_RE.search(text)
    if not m:
        return False, "", ""
    for rx, label in COLLISION_RES:
        if rx.search(text):
            return False, _snip(text, m), label
    if DISAMBIG_RE.search(text):
        return True, _snip(text, m), ""
    return False, _snip(text, m), "未消歧(裸SMA)"


def ask_openai_compatible(engine, query, mode_params):
    payload = {
        "model": engine["model"],
        "messages": [{"role": "user", "content": query}],
        **mode_params,
    }
    req = urllib.request.Request(
        engine["base_url"].rstrip("/") + "/chat/completions",
        data=json.dumps(payload).encode(),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {os.environ[engine['api_key_env']]}",
        },
    )
    with urllib.request.urlopen(req, timeout=120, context=SSL_CTX) as resp:
        data = json.loads(resp.read().decode())
    citations = data.get("citations") or data.get("search_results") or []
    urls = [c if isinstance(c, str) else (c.get("url") or "") for c in citations]
    return data["choices"][0]["message"]["content"], [u for u in urls if u]


def run_queries(queries, engines, ask_fn=ask_openai_compatible, today=None, classify_fn=classify_quality, run_id=None, save_answers=True):
    """对每个 api 引擎 × query × 支持的模式各跑一次,返回结果行列表(schema v3)。

    三层口径(r8):mention(回答提及) ⊂ cited(来源引用含我方 www 主机) / recommended(推荐语境)。
    失败请求落 status=error 行,计入分母——失败不可隐身。
    """
    rows = []
    today = today or date.today().isoformat()
    run_id = run_id or f"{today}-{hashlib.sha256(repr(engines).encode()).hexdigest()[:6]}"
    for engine in engines:
        for mode, mode_params in engine["modes"].items():
            for q in queries:
                base = {"run_id": run_id, "date": today, "engine": engine["name"], "mode": mode,
                        "query_id": q["id"], "query_intent": q.get("intent", ""),
                        "query_weight": q.get("weight", ""), "status": "ok", "error": "",
                        "mentioned": 0, "cited_smaapi": 0, "recommended": 0, "level": "", "source_urls": "",
                        "snippet": "", "sentiment": "", "accuracy": "", "mislabel": 0,
                        "entity_mismatch": "", "answer_hash": ""}
                try:
                    result = ask_fn(engine, q["query"], mode_params)
                except Exception as exc:  # 失败行计入分母
                    print(f"  ! {engine['name']}/{mode}/{q['id']}: {exc}", file=sys.stderr)
                    base.update(status="error", error=str(exc)[:160])
                    rows.append(base)
                    continue
                answer, source_urls = result if isinstance(result, tuple) else (result, [])
                mentioned, snippet, mismatch = detect_mention(answer)
                cited = any(_host(u) == OUR_HOST for u in source_urls)
                recommended = bool(mentioned and RECOMMEND_RE.search(answer))
                level = "recommended" if recommended else ("cited" if cited else ("mention" if mentioned else ""))
                if mentioned and not mismatch and ROOT_SITE_RE.search(answer):
                    mismatch = "root_site(混同,保留提及)"
                sentiment, accuracy = classify_fn(answer) if mentioned else ("", "")
                base.update(mentioned=int(mentioned), cited_smaapi=int(cited),
                            recommended=int(recommended), level=level,
                            source_urls=" ".join(source_urls[:8]), snippet=snippet,
                            sentiment=sentiment, accuracy=accuracy,
                            mislabel=int(mentioned and detect_mislabel(answer)),
                            entity_mismatch=mismatch,
                            answer_hash=hashlib.sha256(answer.encode()).hexdigest()[:12])
                if save_answers:
                    try:
                        _save_answer(base, answer)
                    except Exception as exc:  # 落盘失败不影响主测量
                        print(f"  ! 答案落盘失败 {q['id']}: {exc}", file=sys.stderr)
                rows.append(base)
    return rows


def _host(url):
    try:
        return re.match(r"https?://([^/]+)", url).group(1).lower()
    except AttributeError:
        return ""


def append_csv(rows, csv_path=CSV_PATH):
    csv_path.parent.mkdir(parents=True, exist_ok=True)
    new_file = not csv_path.exists()
    with open(csv_path, "a", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=CSV_FIELDS)
        if new_file:
            w.writeheader()
        w.writerows(rows)


def write_report(csv_path=CSV_PATH, out_dir=None, manual_engines=()):
    out_dir = out_dir or ROOT / "geo" / "reports"
    out_dir.mkdir(parents=True, exist_ok=True)
    year, week, _ = date.today().isocalendar()
    rows = list(csv.DictReader(open(csv_path))) if csv_path.exists() else []
    lines = [f"# 引用率周报 {year}-W{week:02d}", ""]
    lines.append("三层口径(r8):提及 ⊃ 来源引用 / 推荐;失败行计入分母。双模式(C1):web=联网检索;model=纯模型记忆。")
    lines.append("脚本覆盖:以上 API 引擎仅统计官方直连或厂商官方 API 测量结果;经我方网关、代理、人设注入或白标通道的结果不计入本表。")
    lines.append("")
    is_brand = lambda r: r.get("query_intent", "") == "品牌"
    for seg_name, seg in [("非品牌", lambda r: not is_brand(r)), ("品牌", is_brand)]:
        for mode in ("web", "model"):
            sub_all = [r for r in rows if seg(r) and r["mode"] == mode]
            if not sub_all:
                continue
            lines += [f"## {seg_name} × {mode}", "",
                      "| 日期 | 引擎 | 提及 | 来源引用 | 推荐 | 失败 | 分母 | 提及率 | 来源引用率 | 推荐率 |",
                      "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|"]
            for key in sorted({(r["date"], r["engine"]) for r in sub_all}):
                s = [r for r in sub_all if (r["date"], r["engine"]) == key]
                n = len(s)
                m = sum(int(r.get("mentioned", 0) or 0) for r in s)
                c = sum(int(r.get("cited_smaapi", 0) or 0) for r in s)
                rec = sum(int(r.get("recommended", 0) or 0) for r in s)
                err = sum(r.get("status") == "error" for r in s)
                lines.append(f"| {key[0]} | {key[1]} | {m} | {c} | {rec} | {err} | {n} | {m / n:.0%} | {c / n:.0%} | {rec / n:.0%} |")
            lines.append("")
    money = [r for r in rows if not is_brand(r) and r.get("query_weight") == "money"]
    if money:
        n = len(money)
        mm = sum(int(r.get("mentioned", 0) or 0) for r in money)
        cc = sum(int(r.get("cited_smaapi", 0) or 0) for r in money)
        rr = sum(int(r.get("recommended", 0) or 0) for r in money)
        lines.append(f"**主 KPI(非品牌 money,三率并列): 提及 {mm}/{n}={mm / n:.0%} · 来源引用 {cc}/{n}={cc / n:.0%} · 推荐 {rr}/{n}={rr / n:.0%}**")
    else:
        lines.append("**主 KPI(非品牌 money,三率并列): 本期无 money 查询运行数据(矩阵 v2 自下期运行生效)——三率均待测,不以旧矩阵数据冒充。**")
    if not rows:
        lines.append("暂无数据。")
    # C2:提及质量子标注 + 中转站误称 P0 单列
    hits = [r for r in rows if r.get("mentioned") == "1"]
    if hits:
        lines += ["", "## 提及质量(C2 子标注)", "",
                  f"- 情绪分布: " + " / ".join(f"{s or '未标'}×{sum(1 for r in hits if r.get('sentiment','') == s)}"
                                              for s in sorted({r.get('sentiment', '') for r in hits})),
                  f"- 准确性: " + " / ".join(f"{a or '未标'}×{sum(1 for r in hits if r.get('accuracy','') == a)}"
                                            for a in sorted({r.get('accuracy', '') for r in hits}))]
    # T8a:实体错配独立统计(不计入提及率);root_site 固定保留行(一审:0 也显式列出防漏报)
    mismatches = [r for r in rows if r.get("entity_mismatch")]
    lines += ["", "## 实体错配（不计入提及）", ""]
    for label in sorted({r["entity_mismatch"] for r in mismatches if not r["entity_mismatch"].startswith("root_site")}):
        sub = [r for r in mismatches if r["entity_mismatch"] == label]
        lines.append(f"- {label} ×{len(sub)}({', '.join(r['query_id'] for r in sub[:6])})")
    rs = sum(1 for r in mismatches if (r.get("entity_mismatch") or "").startswith("root_site"))
    lines.append(f"- root_site(根域上游站混同) ×{rs}")
    lines += ["", "## 效果挂钩表(T 动作 ↔ 记分牌,自 2026-W25 起回填)", "",
              "| T 动作 | 外发/上线日 | 关联查询簇 | 提及率变化 | 备注 |", "|---|---|---|---|---|",
              "| (下期起回填) | | | | |"]
    p0 = [r for r in rows if r.get("mislabel") == "1"]
    lines += ["", "## ⚠️ P0 纠偏事件(AI 误称 SMA 为中转类)", ""]
    if p0:
        lines += [f"- {r['date']} {r['engine']}/{r['mode']} {r['query_id']}: {r['snippet'][:80]}" for r in p0]
        lines.append("")
        lines.append("处置:触发内容修正循环——定位页强化 + 对应查询内容补强(addendum 02v2 §C2)。")
    else:
        lines.append("本期无。")
    lines += ["", "## 覆盖口径(三档,r12 E2;无官方 UA/IP 的平台不得称\"已覆盖\")", "",
              "| 档 | 口径 | 范围 |", "|---|---|---|",
              "| 自动·API 直连 | 程序化提问,回答全文检测 | 上表所列引擎 |",
              f"| 人工·回答检测 | 同一矩阵人工月检 | {('、'.join(manual_engines)) or '见 engines.json'} |",
              "| 未覆盖 | 无 API 且未入月检的引擎 | 如实留白 |"]
    out = out_dir / f"citations-{year}-W{week:02d}.md"
    out.write_text("\n".join(lines) + "\n")
    print(f"报告: {out}")


def write_manual_checklist(queries, manual_engines, out_dir=None):
    out_dir = out_dir or ROOT / "geo" / "reports"
    out_dir.mkdir(parents=True, exist_ok=True)
    today = date.today()
    # money 优先:这些联网检索引擎决定真实引流,自动脚本不覆盖;时间不够先测 money
    order = {"money": 0, "secondary": 1}
    ordered = sorted(queries, key=lambda q: (order.get(q.get("weight", ""), 2), q["id"]))
    n_money = sum(1 for q in ordered if q.get("weight") == "money")
    lines = [f"# 人工月检清单 {today:%Y-%m}", "",
             "同一查询矩阵,逐引擎人工提问并记录。`提及` 填 是/否;`引用源` 记录回答中给出的链接。",
             f"这 {len(manual_engines)} 个联网检索引擎决定真实引流,自动脚本不覆盖——每引擎 {len(ordered)} 条,"
             f"money {n_money} 条置顶,时间不够先测 money。", ""]
    for eng in manual_engines:
        lines += [f"## {eng}", "", "| query_id | 权重 | 查询 | 提及 | 引用源 | 备注 |", "|---|---|---|---|---|---|"]
        lines += [f"| {q['id']} | {q.get('weight', '')} | {q['query']} |  |  |  |" for q in ordered]
        lines.append("")
    out = out_dir / f"manual-checklist-{today:%Y-%m}.md"
    out.write_text("\n".join(lines) + "\n")
    print(f"清单: {out}")


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--engines", default=str(ROOT / "geo" / "engines.json"))
    ap.add_argument("--queries", default=str(ROOT / "geo" / "queries.yaml"))
    ap.add_argument("--dry-run", action="store_true", help="只校验配置与计划,不发请求")
    ap.add_argument("--manual-checklist", action="store_true", help="生成人工月检清单后退出")
    args = ap.parse_args()

    queries = yaml.safe_load(Path(args.queries).read_text())
    cfg = json.loads(Path(args.engines).read_text())
    engines, manual = cfg["api_engines"], cfg.get("manual_engines", [])

    if args.manual_checklist:
        write_manual_checklist(queries, manual)
        return 0
    skipped = [e["name"] for e in engines if not os.environ.get(e["api_key_env"])]
    engines = [e for e in engines if os.environ.get(e["api_key_env"])]
    if skipped:
        print(f"跳过(缺密钥环境变量): {', '.join(skipped)} —— 覆盖范围按实际申报")
    plan = sum(len(e["modes"]) for e in engines) * len(queries)
    print(f"计划: {len(engines)} 引擎 × {len(queries)} 查询(含双模式)= {plan} 次调用")
    if args.dry_run:
        for e in engines:
            missing = "" if os.environ.get(e["api_key_env"]) else f"(缺环境变量 {e['api_key_env']})"
            print(f"  - {e['name']}: modes={list(e['modes'])} {missing}")
        return 0
    rows = run_queries(queries, engines)
    append_csv(rows)
    write_report(manual_engines=manual)
    return 0


if __name__ == "__main__":
    sys.exit(main())
