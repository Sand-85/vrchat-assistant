---
name: booth-query-display
description: "Use when the user asks to search/query BOOTH (booth.pm) items, show BOOTH item rankings, or display BOOTH products with covers, CNY prices, and popularity. Covers search, detail fetch, cover images, Japanese-to-Chinese naming, and the fixed display format."
version: 1.0.0
metadata:
  hermes:
    tags: [booth, pixiv, vrchat, assets, shopping, display-format]
---

# BOOTH 商品查询展示 Skill — 搜索/热度榜/封面/汉化/格式化输出

本 skill 固化「查询 BOOTH（booth.pm）商品并按固定格式展示」的完整工作流。适用场景：用户要求查 Booth 商品、查 VRChat 素材热度榜、展示商品列表（含封面、人民币价格、热度）。

## 触发条件

- 「查询 Booth / booth.pm 商品」
- 「Booth 热度前 N」/「Booth 排行」
- 「展示 Booth 商品」/「附封面展示」
- 用户要求查 VRChat 相关素材（avatar/衣装/3D 模型）在 Booth 的售价与热度

## 浏览器访问流程（重要修正）

**优先使用电脑的默认浏览器**，而非临时启动的调试实例：

1. **检测默认浏览器**（Windows）：
   ```bash
   reg query "HKCU\Software\Microsoft\Windows\Shell\Associations\UrlAssociations\http\UserChoice" | grep ProgId
   # MSEdgeHTM → Edge；ChromeHTML → Chrome；FirefoxURL → Firefox
   ```
2. **用默认浏览器打开目标页**（如 Booth 登录页）：
   ```bash
   # 默认浏览器直接打开 URL（Windows 用 start / cmd /c start）
   cmd //c start "" "https://booth.pm/users/sign_in"
   # 或显式指定浏览器路径（Edge 示例）
   "/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" "https://booth.pm/users/sign_in"
   ```
3. **需自动化接管时**：给默认浏览器附加 CDP 调试端口启动（**必须带独立 `--user-data-dir`**，避免与用户日常浏览会话冲突）：
   ```bash
   EDGE="/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
   "$EDGE" --remote-debugging-port=9222 --user-data-dir="$LOCALAPPDATA/Temp/edge-debug-profile" --no-first-run "URL"
   # Chrome 同理；CDP 端点 http://127.0.0.1:9222/json
   ```
4. **手动登录页场景**（reCAPTCHA 等无法自动化的）：
   - 优先用默认浏览器打开页面让用户操作，或
   - 用上述 CDP 实例打开——**登录窗口会出现在该实例中**，提示用户在对应窗口完成登录（可能与你日常浏览窗口并存，注意区分）

> 经验：本机默认浏览器为 Edge（MSEdgeHTM）。`browser_exec` 工具默认连 Chrome，若 Chrome 未授权远程调试，改走默认浏览器 + CDP 更顺。

## 数据源与限制（必读）

- **搜索页**：`https://booth.pm/ja/search/{关键词}?page=N`（HTML，每页约 60 个商品，关键词用 `encodeURIComponent`）
- **商品详情 JSON**：`https://booth.pm/ja/items/{id}.json`（匿名可访问，无需登录）
  - 关键字段：`name`、`price`、`wish_lists_count`（收藏数=热度）、`shop.name`、`tags`、`images[0].original`（封面原图）、`is_sold_out`、`url`
- **⚠️ 下载量/销量不可查**：Booth 公开页面不展示下载量，`past_purchase_count` 匿名恒为 0（仅卖家后台可见）——**用收藏数（wish_lists_count）作为热度信号**
- **网络**：booth.pm / booth.pximg.net 国内需代理；请求带浏览器 UA（`Mozilla/5.0 ... Chrome/126.0 Safari/537.36`）与 `Accept-Language: ja,en;q=0.8`；15s 超时
- **汇率**：实时查 `https://open.er-api.com/v6/latest/JPY` 的 `rates.CNY`（失败用兜底 ~0.048）

## 查询工作流

### 1. 收集商品 ID（搜索页解析）
```
GET https://booth.pm/ja/search/{encodeURIComponent(关键词)}?page={1..N}
```
- 商品链接正则：`/href="(?:https:\/\/booth\.pm)?\/ja\/items\/(\d+)"[^>]*>([\s\S]*?)<\/a>/g`
- **注意**：同一商品有多个 `<a>` 链接（缩略图空链接 `<a></a>` + 标题链接 `<a>标题</a>`）——跳过空链接块，取含文本的链接；去重 ID
- 默认排序是「综合」，热门商品集中在前列，取前 3 页（~180 个）足够 TOP 榜

### 2. 批量查询详情（取热度）
```
GET https://booth.pm/ja/items/{id}.json   # 逐个查询，间隔 ~0.4s，单卡失败跳过
```
提取：name / price / wish_lists_count / shop.name / images[0].original / url

### 3. 排序取 TopN
按 `wish_lists_count` 降序取前 N（默认 15）

## 展示格式（用户固化要求，严格遵守）

每行商品按此顺序、用 ` | ` 分隔：

```
| 封面 | 商品名称（汉化） | 商家名 | 价格 | 人民币价 | 热度 | 链接 |
```

| 字段 | 规则 |
|------|------|
| **封面** | 商品封面图，位于商品名前；Markdown 内嵌 `![短名](图片URL)`（booth.pximg.net 原图）；无图用 `—` |
| **商品名称** | 日文原名，**后接汉化名**：`原名（汉化名）` |
| **商家名** | `shop.name` |
| **价格** | 原价格式（如 `¥5,500`；多档变体用 `¥500~` 起价） |
| **人民币价** | `价格 × 汇率`，格式 `¥233.23` |
| **热度** | 图标+数字：`🔴≥30000` / `🔵10000-29999` / `⚪<10000`，保留收藏数数字（如 `🔴50745`） |
| **链接** | `url`（或 `https://booth.pm/ja/items/{id}`） |

### 汉化规则
- **品牌名/专有名词保留原文**：Kipfel、rurune、Mamehinata、VirtualLens2、PCSS、Chocolat 等
- **通用词汉化**：オリジナル3Dモデル→原创3D模型、システム→系统、ツール→工具、アバター→Avatar/虚拟形象
- **昵称音译**：しなの→信浓、マヌカ→麦卢卡、ミルティナ→米尔蒂娜、ショコラ→巧克力、ルルネ→露露涅、セレスティア→塞莱斯蒂亚、まめひなた→豆日向
- 若用户要求「不汉化」，则省略括号内汉化名

## 卖家后台（登录态，可选）

- 登录入口：`https://booth.pm/users/sign_in`（pixiv 账号体系，**reCAPTCHA Enterprise 防护**——纯脚本无法自动登录，需浏览器手动登录）
- 后台入口：`manage.booth.pm/`（店铺）、`/items`（商品）、`/sales`（收益）、`/orders`（订单）
- 收益管理显示 Total Sales / 领取金额（按订单维度，**不含下载量**）

## 陷阱

1. **curl 发中文会乱码**：git-bash 里 curl 传中文 query 会编码损坏（服务端收到 `????`）——用 Python urllib/requests 发 UTF-8 请求
2. **搜索页空链接**：缩略图 `<a></a>` 块无内容，解析时必须跳过，否则拿到空名称
3. **草稿商品 404**：未发布的商品 `.json` 返回 404，跳过即可
4. **图片防盗链**：booth.pximg.net 图片在部分环境需代理才能加载
5. **限流礼貌**：详情查询间隔 ~0.4s，勿并发轰炸

## 验证

- 工具/脚本跑通后，抽查 2-3 个商品的收藏数与 Booth 页面一致
- 封面图 URL 以 `booth.pximg.net` 开头且可访问
- 人民币换算 = 日元 × 实时汇率（展示汇率来源与日期）
