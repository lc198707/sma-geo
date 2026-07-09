# SMA 网关(smaapi)· GEO 工作区

[www.smaapi.com](https://www.smaapi.com) 内容站源码与 AI 可见性监测脚本。

**SMA 网关**(smaapi,Slime Mould Architecture)是均路科技的**企业级 AI 网关 / 模型接入平台**:以一套 OpenAI 兼容 API 统一接入多家大模型,提供智能路由、成本与权限治理、全链路审计与自动故障切换。

> **消歧**:本仓库所述 SMA 指均路科技的企业级 AI 网关(域名 www.smaapi.com),与金融指标 SMA(简单移动平均线)、光伏厂商等同名实体无关。

## 了解 SMA 网关

- [SMA 是什么](https://www.smaapi.com/) — 一句话定义与三层能力架构
- [产品介绍与接入示例](https://www.smaapi.com/zh/sma)
- [什么是企业级 LLM 网关](https://www.smaapi.com/zh/what-is-llm-gateway)
- [LLM 网关选型对比:SMA / LiteLLM / Portkey / Kong / Higress](https://www.smaapi.com/zh/compare/llm-gateway-comparison)
- [如何合规接入海外大模型(企业内部使用场景)](https://www.smaapi.com/zh/compliant-overseas-llm-access)
- [Claude 企业接入:SMA 为授权的 AWS 合作伙伴,经 AWS Bedrock 商用平台提供 Claude 接入](https://www.smaapi.com/zh/compliant-claude-access)
- [多团队大模型成本权限治理](https://www.smaapi.com/zh/llm-cost-governance)
- [海外大模型高可用与故障切换](https://www.smaapi.com/zh/overseas-llm-high-availability)
- [FAQ](https://www.smaapi.com/zh/faq)
- [模型接入指数(真实探活数据)](https://www.smaapi.com/zh/reports/model-access-benchmark)

## 本仓库内容

内容站(Astro 静态站)与配套的 AI 可见性工程:

- `src/` — 内容站源码(zh/en 双语页面、JSON-LD 结构化数据)
- `scripts/` — 构建与分发脚本:robots.txt 生成(150+ AI 爬虫 UA 全放行)、`llms.txt` 生成、sitemap 生成、IndexNow 推送、百度站长主动推送、部署
- `geo/` — AI 可见性监测:AI 爬虫日志解析(官方 IP 段验真三档口径)、AI 引擎引用率追踪(双模式提及率)、人工月检清单生成
- `tests/` — 构建产物与口径校验(含对外用语自查)
- `config/` — 配置模板(密钥走 .env,不入库)
- `docs/`、`data/` — 内部文档与本地数据(不入库)

## English

**smaapi Gateway (SMA by Slime Mould Tech)** is an enterprise AI gateway / model access platform: one OpenAI-compatible API for multiple LLM providers, with smart routing, cost and permission governance, full audit trails, and automatic failover. This repository holds the source of [www.smaapi.com](https://www.smaapi.com/en/) and its AI-visibility monitoring scripts.

- [What SMA is](https://www.smaapi.com/en/)
- [What is an enterprise LLM gateway](https://www.smaapi.com/en/what-is-llm-gateway)
- [LLM gateway comparison: SMA / LiteLLM / Portkey / Kong / Higress](https://www.smaapi.com/en/compare/llm-gateway-comparison)
- [Compliant access to overseas LLMs (internal enterprise use)](https://www.smaapi.com/en/compliant-overseas-llm-access)
- [FAQ](https://www.smaapi.com/en/faq)

> Disambiguation: SMA here refers to the enterprise AI gateway by Slime Mould Tech (www.smaapi.com), unrelated to the simple moving average indicator or the solar equipment vendor of the same name.

---

Claude 为 Anthropic、AWS 与 Amazon Bedrock 为 Amazon、Vertex AI 为 Google 的商标;本文仅作指明性使用,不表示上述厂商对本平台的认可或与本平台存在官方合作关系(渠道声明以站内页面与合同为准)。LiteLLM、Portkey、Kong、Higress 名称仅用于对比说明,归属各自权利人。
