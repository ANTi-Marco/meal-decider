# 饭点有解 · 今天吃什么

每到饭点还在纠结吃什么？「饭点有解」是一个轻量级 H5 决策工具，帮你根据当下的口味和用餐场景快速找到一个选择。可以选附近餐厅、自己做一道菜，也可以把候选项交给随机抽签。

## 你可以用它做什么

### 挑一家今天想吃的餐厅

- 选择口味、用餐人数、距离范围、人均预算和营养偏好
- 配置 DeepSeek 后，AI 会先一次规划最多两个搜索词，高德对宽泛词和偏好词并行搜索，再由 AI 从真实 POI 中选出最多三家；搜索结果会短时缓存，AI 选店失败时会直接从已查到的候选中兜底
- 距离、人均价格、餐饮类型均来自高德；没有均价的店会明确标注
- 点击「高德查看」按 POI ID 打开高德中的具体店铺
- 点击「美团搜这家」复制店名和地址并打开美团，粘贴搜索后查看评分、评论和菜单；不保证直接跳到具体门店
- 不满意当前结果时，可以换一组选项

### 决定自己做什么

- 按口味和营养偏好推荐快手家常菜
- 查看预计耗时、难度和热量区间
- 点击「去 B 站学」跳转到 B 站搜索这道菜的做法

### 让随机抽签替你做决定

- 输入 2–10 个餐厅或饭菜候选项
- 系统随机抽出一个；再次抽取时会避开刚才的结果
- 候选项会自动去重，空项会被忽略

### 记录这一顿

- 选好后先进入「用餐中」；如果临时改变主意，可以取消这顿，取消的选择不会记进用餐记录
- 真正吃完后再记录感受
- 查看最近吃过的内容，餐厅和菜谱都会进入最近 3 天的去重逻辑
- 「喜欢」会在 3 天去重期后略微提高同类别的推荐权重；「下次别推」会显著降低同类别及同一项目的权重，但不绝对禁止；「还可以」不改变权重。偏好权重保留 90 天，早期未保存类别的记录仍可影响同一项目
- 偏好、用餐状态和历史记录保存在当前浏览器本地

### 给项目留下反馈

- 页面底部「给我们提意见」可提交推荐、自己做饭、抽签或页面体验反馈
- 反馈私密保存在项目维护者的 Supabase 数据库中；联系方式为选填
- 用餐后的个人记录仍只保存在当前浏览器，不会自动上传

## 数据与隐私说明

- 餐厅搜索可通过服务端函数调用高德 Web 服务 API；高德 Key 只保存在部署平台的环境变量中，不放进网页代码
- AI 搜索使用服务端 DeepSeek API。DeepSeek Key 同样仅放在环境变量里；浏览器定位会先转换为高德坐标，精确经纬度不会传给 AI
- AI 只能决定搜索词和候选顺序，不能扩大距离或预算。最终结果由后端再次校验 POI ID、距离、预算和最近三天去重
- 餐厅距离、人均价格等以高德实际返回为准，部分商户可能没有均价数据
- 自制菜谱库由开源项目 [YunYouJun/cook](https://github.com/YunYouJun/cook) 的 CSV 数据在构建时清洗生成，当前包含约 600 道菜；来源许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)
- 菜谱原始数据不提供可靠的精确热量和烹饪时间，因此页面仅展示食材、难度、厨具和粗粒度营养标签，不编造精确数字
- 偏好、用餐状态和用餐记录仅保存在当前浏览器的 `localStorage` 中；AI 餐厅推荐请求只临时携带由记录汇总出的类别和店铺偏好权重，不传完整用餐记录，服务端不持久化这些权重；独立提交的产品建议会发送至配置的 Supabase 项目
- 联系方式选填。反馈正文及联系方式仅项目维护者可通过 Supabase 控制台查看；请勿提交密码、支付信息等敏感内容

这是一个产品 MVP 和作品集项目，不提供外卖、团购或在线点餐。

## 本地预览

项目不需要安装依赖或构建。在仓库根目录启动本地静态服务器：

```bash
python -m http.server 8080
```

然后访问 <http://localhost:8080/dist/>。

不要直接双击 `dist/index.html`。`file://` 页面无法调用 `/api/restaurants`，也可能读不到 `recipes.json`。页面会明确提示餐厅接口不可用。

静态服务器不会运行 `/api/recommend`、`/api/restaurants` 或 `/api/feedback`；餐厅搜索和反馈提交需要部署到 Vercel 后才能使用。

## 部署到 Vercel

1. 在 Vercel 导入此 GitHub 仓库，Framework Preset 选择 `Other`，Build Command 留空，Output Directory 留空。
2. 在项目 `Settings → Environment Variables` 中添加 `AMAP_WEB_KEY`（高德 Web 服务 Key）和 `DEEPSEEK_API_KEY`（DeepSeek API Key）。不要把 Key 写进源码或提交到 GitHub。
3. 选择 Production、Preview 等需要的环境后重新部署。
4. 部署后可访问 `/api/restaurants?address=上海静安寺&range=3` 检查接口是否能返回餐厅；未配置 Key 时会返回 `AMAP_NOT_CONFIGURED`。
5. 在网页选完需求后，`/api/recommend` 让 AI 一次规划关键词，并行查询高德后再让 AI 选店。一次搜索最多两次 AI 请求和 8 次高德周边查询；重复查询会尝试命中 3 分钟进程内缓存。查询仍会产生 API 调用费用，正式公开前建议查看高德与 DeepSeek 用量。
6. 配置反馈收集：在 Supabase 创建项目，在 **SQL Editor** 执行 [`supabase/feedback.sql`](supabase/feedback.sql)；然后从 Supabase **Settings → API Keys** 复制 **Project URL** 和仅服务端使用的 **Secret key**，分别保存为 Vercel 环境变量 `SUPABASE_URL`、`SUPABASE_SECRET_KEY`，再重新部署。后端也兼容旧版 `service_role` Key（环境变量 `SUPABASE_SERVICE_ROLE_KEY`）。**不要把任何 Secret/service role Key 放进网页或提交到 GitHub。**
7. 查看用户反馈：登录 Supabase → **Table Editor** → `meal_feedback`。数据表启用了 RLS，访客不能读取；网站后端只负责写入。可选联系方式也会保存在该私有表中。

运行后端模拟测试：`node --test tests/*.test.mjs`。本项目没有把任何个人 Key 放在仓库里。

Vercel 可作为快速公开体验和作品集预览，但不保证中国大陆网络的稳定访问。若大陆可访问是硬性要求，建议后续把正式站点部署到中国大陆云厂商，并完成域名 ICP 备案及相关合规配置；也可以先用 Vercel 作为海外预览版。

## 技术与数据

- 原生 HTML、CSS 和 JavaScript
- 用餐偏好、历史记录等保存在浏览器 `localStorage` 中
- 用户无需账号；反馈通过 Vercel 服务端函数写入 Supabase，服务密钥只存在部署环境变量中
- 不要将高德 Key、服务端密钥或其他凭据提交到公开仓库；通过后端函数和部署平台环境变量管理密钥

## 参与改进

欢迎提交 Issue 分享使用反馈、推荐逻辑建议或你发现的问题，也欢迎通过 Pull Request 贡献改进。

## License

本项目基于 [MIT License](LICENSE) 开源。
