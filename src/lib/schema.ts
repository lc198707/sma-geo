import type {
  WithContext,
  Organization,
  SoftwareApplication,
  FAQPage,
  TechArticle,
  WebSite,
  BreadcrumbList,
  Person,
  Dataset,
} from 'schema-dts';
import pagesData from '../data/pages.json';

// O1:基址单一真源(pages.json site)
const SITE = pagesData.site;

// r8 批次 B:sameAs 结构就位,值随 GitHub 组织 / 百科词条落地回填(只列我方控制的组织级主页)
// 2026-06-11:GitHub 组织 smaapi 建成,回填第一环(T8 实体闭环);百科义项 URL 待 T8c 工商落地后追加
const SAME_AS: string[] = ['https://github.com/smaapi'];

export const organization: WithContext<Organization> = {
  '@context': 'https://schema.org',
  '@type': 'Organization',
  '@id': `${SITE}/#org`,
  name: '菌路科技',
  legalName: '菌路科技', // 待 E-4 工商全称核验后替换为注册全称
  alternateName: ['Slime Mould Tech', 'smaapi'],
  url: SITE,
  ...(SAME_AS.length ? { sameAs: SAME_AS } : {}),
  // T8b 实体消歧(REVIEW r5):与金融指标/光伏厂商等同名实体显式区分
  disambiguatingDescription:
    '菌路科技的 SMA(Slime Mould Architecture)是企业级 AI 网关 / 模型接入平台,域名 www.smaapi.com;与金融指标 SMA、光伏厂商等同名实体无关',
  // R-B 暂裁:logo 指向部署包内真实文件;sameAs 待 P2 组织主页就位后回填,当前不声明
  logo: `${SITE}/logo.png`,
};

export const softwareApplication: WithContext<SoftwareApplication> = {
  '@context': 'https://schema.org',
  '@type': 'SoftwareApplication',
  name: 'SMA 网关',
  alternateName: ['smaapi', 'SMA(Slime Mould Architecture)'],
  url: SITE,
  provider: { '@id': `${SITE}/#org` },
  applicationCategory: 'DeveloperApplication',
  operatingSystem: 'Cloud / Self-hosted',
  description: '企业级 AI 网关:多模型统一接入、智能路由、成本与权限治理、全链路审计(www.smaapi.com)',
  featureList: [
    '多模型统一接入(OpenAI 兼容 API)',
    '智能路由与自动故障切换',
    '成本与权限治理(预算、配额、密钥范围)',
    '全链路审计与可追溯',
  ],
};

// P2:WebSite 实体(强化站点实体识别;publisher 指向 Organization)
export const website: WithContext<WebSite> = {
  '@context': 'https://schema.org',
  '@type': 'WebSite',
  '@id': `${SITE}/#website`,
  url: SITE,
  name: 'SMA 网关 / smaapi Gateway',
  alternateName: ['smaapi', 'SMA(Slime Mould Architecture)', '菌路 SMA'],
  inLanguage: ['zh-CN', 'en'],
  publisher: { '@id': `${SITE}/#org` },
};

// P3(E-E-A-T):首席科学家 Person 实体(worksFor 指向 Organization,affiliation 指向高校)。
// 仅声明可对外、可核验的职务/单位/研究方向;荣誉与指标留在可见正文,不进结构化数据夸大。
export const chiefScientist: WithContext<Person> = {
  '@context': 'https://schema.org',
  '@type': 'Person',
  '@id': `${SITE}/#chief-scientist`,
  name: '谢源',
  alternateName: 'Xie Yuan',
  jobTitle: '首席科学家',
  worksFor: { '@id': `${SITE}/#org` },
  affiliation: {
    '@type': 'CollegeOrUniversity',
    name: '华东师范大学计算机科学与技术学院',
  },
  knowsAbout: ['大模型持续学习', '持续进化智能体', '企业级 AI 网关'],
  description:
    '华东师范大学计算机科学与技术学院教授、博士生导师;研究方向为大模型持续学习与持续进化智能体。',
};

// P2:面包屑(Home > 当前页);最后一项为当前页
export function breadcrumb(items: ReadonlyArray<{ name: string; url: string }>): WithContext<BreadcrumbList> {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map((it, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: it.name,
      item: it.url,
    })),
  };
}

export interface QA {
  q: string;
  a: string;
}

export function faqPage(qa: ReadonlyArray<QA>): WithContext<FAQPage> {
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: qa.map(({ q, a }) => ({
      '@type': 'Question',
      name: q,
      acceptedAnswer: { '@type': 'Answer', text: a },
    })),
  };
}

export function techArticle(opts: {
  headline: string;
  description: string;
  url: string;
  inLanguage: string;
  datePublished: string;
  dateModified: string;
}): WithContext<TechArticle> {
  return {
    '@context': 'https://schema.org',
    '@type': 'TechArticle',
    headline: opts.headline,
    description: opts.description,
    url: opts.url,
    inLanguage: opts.inLanguage,
    datePublished: opts.datePublished,
    dateModified: opts.dateModified,
    author: { '@type': 'Organization', name: '菌路科技' },
  };
}

// T2 数据报告页(增补件 03 §T2 独家实测数据):Dataset schema。
// 仅在真实数据发布(published)时注入;数据源=SMA 网关探活/生产监控,构建时注入,license 声明引用须注明来源
// (被 AI 引用即自带品牌锚点)。temporalCoverage/measurementTechnique 来自真实口径,不手填数字。
export function dataset(opts: {
  name: string;
  description: string;
  url: string;
  inLanguage: string;
  temporalCoverage: string;
  measurementTechnique: string;
  datePublished: string;
  dateModified: string;
  variableMeasured?: ReadonlyArray<string>;
}): WithContext<Dataset> {
  return {
    '@context': 'https://schema.org',
    '@type': 'Dataset',
    name: opts.name,
    description: opts.description,
    url: opts.url,
    inLanguage: opts.inLanguage,
    temporalCoverage: opts.temporalCoverage,
    measurementTechnique: opts.measurementTechnique,
    datePublished: opts.datePublished,
    dateModified: opts.dateModified,
    creator: { '@id': `${SITE}/#org` },
    publisher: { '@id': `${SITE}/#org` },
    license: `${SITE}/zh/reports/model-access-benchmark`,
    ...(opts.variableMeasured?.length ? { variableMeasured: [...opts.variableMeasured] } : {}),
  };
}
