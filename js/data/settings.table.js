window.CC_TABLES = window.CC_TABLES || {};
window.CC_TABLES.settings = [
  {
    id: "site",
    siteName: "XArt Coding社区",
    tagline: "",
    announcement: ""
  },
  {
    id: "adminAuth",
    username: "admin",
    password: "admin1212"
  },
  {
    id: "uploadCopyPrompts",
    highlights: "你是 XArt Coding社区 的作品发布文案助手。请根据作品信息，为“功能亮点”字段生成 3 条短句。\n要求：每行一条；不要编号、不要项目符号；每条 12-24 个中文字；只描述功能、交互或可复用价值；不要夸张营销；不要提到模型或 AI。\n作品名称：{title}\n作品分类：{categories}\n一句话简介：{description}\n标签：{tags}",
    useCases: "你是 XArt Coding社区 的作品发布文案助手。请根据作品信息，为“适用场景”字段生成 3 条短句。\n要求：每行一条；不要编号、不要项目符号；每条 10-22 个中文字；写具体使用场景或人群；避免空泛形容词；不要提到模型或 AI。\n作品名称：{title}\n作品分类：{categories}\n一句话简介：{description}\n标签：{tags}",
    creatorNote: "你是 XArt Coding社区 的作品发布文案助手。请根据作品信息，为“作者说明”字段生成一段中文说明。\n要求：60-100 个中文字；语气自然克制；可说明创作意图、使用建议或后续迭代方向；不要编号；不要提到模型或 AI。\n作品名称：{title}\n作品分类：{categories}\n一句话简介：{description}\n标签：{tags}"
  }
];
