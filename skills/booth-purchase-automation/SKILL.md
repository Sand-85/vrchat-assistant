---
name: booth-purchase-automation
description: "Buy a real BOOTH item: search, add to cart, confirm, pay, download via browser CDP."
version: 1.0.0
metadata:
  hermes:
    tags: [booth, purchase, shopping, vrchat, ecommerce, browser-automation]
    related_skills: [booth-query-display]
---

# BOOTH 真实购买自动化 Skill — 搜索定位 / 加购 / 结账 / 支付 / 素材下载

当使用者明确要求**真实购买** BOOTH（booth.pm）商品时使用。本 skill 覆盖「搜索定位 → 加购 → 结账 → 支付 → 素材下载」完整闭环。纯查询/展示（封面、人民币价、热度榜）另见 `booth-query-display`。

> **注意：真实扣款。** 涉及用户真实货币，每一步推进前必须让用户明确确认，尤其支付方式选择与最后的「进行支付」。支付凭据由用户绑定在账号里，代理不应也不应尝试触碰。

> 🔽 **警告缩减条款（全自动购买授权）**：若用户**主动明确**要求全自动购买（如说「直接买」「直接」「全自动」「不用问我」等），分散的逐步警告缩减为**一次最终确认**——仅在「加入购物车 + 支付」前一次性确认 商品(名称/变体/价格) + 支付方式 + 总金额，确认后连续执行 加购→结账→支付，不再逐步打断。**仅此一种缩减**；未获该明确授权前始终按逐步 警告→确认 执行。任何情况下都不触碰用户支付凭据。

## 前置条件（环境）

- 受控浏览器常开调试端口（如 Edge `--remote-debugging-port=9222` + 独立持久 profile），`browser.cdp_url` 指向该端口
- `browser_exec` 附着该浏览器，登录态持久
- **登录**：BOOTH 登录走 pixiv 账号（浏览器窗口内用户本人登录，代理不碰密码）。若用户提到 passkey / 密码管理器扩展，先确认受控浏览器里对应扩展是否存在，否则让用户直接在该窗口手动登录 pixiv 更快。

## 第一步：搜索定位商品

### 搜索页解析（拿商品 ID）
```
GET https://booth.pm/ja/search/{encodeURIComponent(关键词)}?page={1..N}
```
- 商品链接正则：`/href="(?:https:\/\/booth\.pm)?\/ja\/items\/(\d+)"[^>]*>([\s\S]*?)<\/a>/g`
- 跳过空链接块（缩略图 `<a></a>`），取含文本的链接，去重 ID
- 默认综合排序，热门商品集中在前列，取前 3 页足够

### 商品详情（拿价格/热度/变体）
```
GET https://booth.pm/ja/items/{id}.json   # 匿名可访问；间隔 ~0.4s 防限流
```
关键字段：`name`、`price`、`wish_lists_count`（收藏数=热度，BOOTH 唯一公开热度信号）、`shop.name`、`tags`、`is_sold_out`、`url`。下载量/销量不可查（`past_purchase_count` 匿名恒 0，仅卖家后台可见）。

### 变体与金额确认
商品可能有多档变体（素体/尺寸/单件-全套等）。加购前向用户确认**要哪一档**，并核对对应金额。

## 第二步：登录态判断（关键）

BOOTH 界面**语言随账号 locale 变化**（中文/日文/英文等，不一定是中文），判断登录态不能用单一语言硬编码。可先读页面 `<html lang>`，并覆盖常见语言变体：
- 已登录 → 页头出现**用户名** + 登出/ログアウト/Log out + 购买的商品・资料库/購入した商品・ライブラリ/Purchases・Library
- 未登录 → 页头是 登录/ログイン/Login 按钮

```python
# browser_exec 里
lang = js("document.documentElement.lang")                    # 'zh-CN' / 'ja' / 'en' ...
# 只扫页头导航区（header），避免页脚/引导区「登录后购买」诱导链接造成误判
header_txt = js("(document.querySelector('header')||document.body).innerText || ''")
logged_out_keys = ['登录', 'ログイン', 'Login', 'Sign in']      # 出现则未登录
logged_in_keys  = ['登出','我的页面','购买的商品','ログアウト','購入した商品','Log out','Purchases','Library']
# 结构锚点优先：页头有登出按钮=已登录；有登录按钮=未登录；判定冲突时以登出按钮为准
has_logout = js("!!(document.querySelector('header') && /登出|ログアウト|Log\\s*out/i.test(document.querySelector('header').innerText))")
has_login  = js("!!(document.querySelector('header') && /登录|ログイン|Login|Sign\\s*in/i.test(document.querySelector('header').innerText))")
logged = has_logout or (not has_login and any(k in header_txt for k in logged_in_keys))
```

## 第三步：定位并加购（DOM 定位）

> ⚠ **加购前严格确认商品。** 点击「加入购物车」前，先读取已定位商品的 **名称 + 所选变体 + 价格**，向用户明确展示「将要加入购物车的是：<商品名> / <变体档> / <价格>」，得到用户确认后才能点击。绝不在未确认目标商品的情况下直接加购（易加错变体/误买其他商品）。

> 🔽 **全自动购买授权时（见顶部警告缩减条款）**：此步不再单独确认，加购与支付前的**一次最终确认**合并于此——一次性向用户展示 商品(名称/变体/价格) + 支付方式 + 总金额，得到这一**唯一确认**后连续执行 加购→结账→支付，不再逐步打断。

> ⏸ **每步可打断，打断按 询问→警告→执行。** 加购流程**每一步均可被用户随时中止/打断**（换商品、改变体、退出到列表、取消加购等）。一旦用户要求打断：先**询问**其意图（要做什么/取消什么），再**警告**此举后果（已定位的商品/购物车内容是否保留、是否清空），得到用户再次确认后**执行**。用户要求打断后不得继续推进当前操作，也不得在未确认时就擅自执行。

> 📌 **详情页可随时返回。** 进入任意商品详情页后，须始终能回到来源（浏览器 back，或记录并重开此前的搜索列表 URL）。浏览多个候选变体/商品时保留返回路径，不丢失搜索位置；用户想换/看别的商品时能立即退出详情回到列表。

商品变体列表里每个变体一个区块。定位变体名（日文）所在叶节点，向上找包含「加入购物车」按钮的容器，点击：

```python
clicked = js("(()=>{const nodes=Array.from(document.querySelectorAll('*')).filter(e=>e.children.length===0 && /目标素体关键词/.test(e.textContent||'') && (e.textContent||'').length<80);
let el=nodes[0],item=el;
for(let k=0;k<8&&item;k++){item=item.parentElement;if(item&&(item.innerText||'').indexOf('加入购物车')>=0)break;}
const btn=item?Array.from(item.querySelectorAll('button,input[type=submit]')).find(b=>/加入购物车/.test(b.textContent+' '+b.getAttribute('aria-label'))):null;
if(btn){btn.click();return 'CLICKED '+btn.textContent.trim();}
return 'no cart btn';})()")
```
- 把 `目标素体关键词` 换成目标变体名（如匹配目标素体的日文名称）
- 「加入购物车」按钮文本随界面语言变化：`加入购物车` / `カートに入れる` / `Add to cart`，点击正则需同时匹配这些变体
- 加购成功会跳 `/cart?added_to_cart=true`（标题 Shopping Cart / カート / 购物车，随 locale）

## 第四步：结账流程（booth → pixiv → 支付网关）

> **支付方式不止 PayPal/信用卡。** BOOTH 支持多种支付：`PayPal`、`信用卡`、`コンビニ決済（便利店）`、`银行振込（银行转账）` 等。默认确认 **PayPal / 信用卡**；**便利店支付不主动询问**——部分店铺/商品不可用，且有地域限制。下方步骤 3-6 的 PayPal 3DS 流程只适用于 PayPal/信用卡；其他方式（便利店/银行转账）是离线支付，不会跳 3DS，仅作兜底。

> ⚠ **支付段每步强制 警告→确认。** 进入支付后，**每一步（下方 1-6）都不能连续推进**：先向用户说明该步将发生什么（真实扣款/页面跳转/发卡行授权等）及后果，得到用户明确「确认/继续」后才执行该步；用户未确认则停下等待，不得自行连点或跳到下一步。

> 🔽 **全自动购买授权时（见顶部警告缩减条款）**：本段 1-6 的各 ⚠确认 **不再逐步执行**——已在第三步「加入购物车+支付前一次最终确认」中一次性确认并获授权，此后连续推进 1-6 结账与支付，不再打断。

步骤 1-6 的按钮文本随界面语言变化（中文/日文/英文）：「结账付款」=結帳/レジに進む/Checkout/Proceed to checkout；「确认订单」=注文を確定/Confirm order；「进行支付」=支払いを確定/支払う/Pay。DOM 定位时按 `lang` 选用对应词，勿只匹配中文。
1. ⚠确认：说明将进入 checkout 与支付方式选择 → `/cart` 页点「结账付款」→ `checkout.booth.pm/checkout/step1`（选择支付方式）
2. ⚠确认：说明所选支付方式及对应扣款路径 → step1 **默认确认 PayPal / 信用卡**（已绑卡显示 `card████/YYYY`）→ 走下方步骤 3-6 线上扣款
   - **便利店/银行转账（不主动询问，仅兜底）**：兜底顺序 = **PayPal/信用卡 → 便利店/银行转账**；触发条件 = 用户主动要求、或该商品/页面不提供 PayPal/信用卡（线上扣款不可用）时才走。页面会显示便利店代码或汇款账号，为**离线支付**：由用户自行去便利店/网银完成，确认支付/到账后回到 `checkout.booth.pm/orders/<订单号>` 成功页；此类**不会进入 PayPal 3DS**
   - 点标签后页下方出现「确认订单」submit
3. （PayPal/信用卡分支）⚠确认：核对商品合计/金额/支付方式 → 点「确认订单」→ `checkout.booth.pm/checkout/step3`（订单内容确认：此处明确写「购买手续尚未完成」= 下一步才真付款）
4. ⚠确认：将跳转 pixiv 支付网关 / 真实扣款 → 再点「确认订单」（value=确认订单）→ 跳 **pixiv 支付网关** `payment.pixiv.net/paypal/advancedCheckout/v2/confirm?token=...`（最终确认页：使用服务=BOOTH/支付方法=信用卡/金额=xxxx JPY/按钮=进行支付）
5. ⚠确认：将进行真实支付 → 点「进行支付」→ 跳 **PayPal 3DS** `paypal.com/heliosnext/threeDS?action=verify...` = 信用卡发卡行安全验证（可能需卡主本人短信/银行 app 授权）
6. ⚠确认：支付/授权完成 → 3DS 通过 → `checkout.booth.pm/orders/<订单号>` **Thanks for your order!** 成功页

## 第五步：数字素材下载（购买后）

多数数字商品（如 VRChat 衣装）购买后需在**资料库**下载素材，通常含 贴图 + MaterialPack + 对应素体的 zip 等多个文件：

1. 打开 `https://accounts.booth.pm/library`（购买的商品/资料库），找到刚买的商品
2. **先设定下载目录**：执行下载前用 CDP `Browser.setDownloadBehavior` 显式指定可预期目录（或先向用户确认浏览器默认下载路径），避免收尾时满盘找文件
3. 每个文件对应一个 **Download** 按钮（`button`，非 a 标签）——点击触发浏览器下载
4. 下载文件落在设定目录，下载中显示 `未确认 NNNN.crdownload` 临时名，完成后改名。**Chrome 对重名文件会追加 ` (1)` 后缀**——查找按文件名前缀匹配，勿精确全名匹配
5. 目标素体对应的文件通常含制作方或素体名关键词；常见还有一个 `最初にインポート...MaterialPack.zip` 需**最先导入**

**注意：** 下载文件用 `.crdownload` 临时名，**下载中勿删**；确认下载完成后才收走/移动。进度慢属 BOOTH 限速，正常。

## 陷阱

- **点「确认订单」后跳 pixiv/paypal，页面跳转时 `browser_exec` 的 JS 求值会超时（Runtime.evaluate timed out / TimeoutError）**——这是**正常过渡**不是失败。重新读取当前 URL 即可，别误判为支付失败。
- **「确认订单」按钮**：`input[type=submit] value=确认订单`，在 step1（选支付）和 step3（确认内容）各出现一次。误判层级会导致没真正下单。
- 最终确认页（step3 + pixiv confirm）**金额不一定显示 ¥ 符号**，注意核对数字（如 `1,200 JPY`）。结账/汇款展示金额以**实际货币**为准——BOOTH 原生 JPY，依账号币种设置也可能显示 USD；**呈现给用户用表格：`实际JPY | 换算后价格`**，换算按用户语言变换（中文→人民币 / 日文→日元 / 英文→美元），勿一律默认人民币。
- **支付 URL/按钮可能过时**：pixiv 支付网关（`payment.pixiv.net/paypal/advancedCheckout/...`）、PayPal 3DS、便利店/转账按钮文本均由第三方维护、随线上变更。页面结构与文档不符时**以实测为准兜底**，勿死套旧路径/旧词误判支付状态。
- 搜索/查询走 `booth-query-display` skill；购买走本 skill。

## 验证

- 成功标志：`Thanks for your order!` + URL `/orders/<number>` + `xrcloud:event=purchased`
- 订单号、商品 ID、金额记录给用户；金额展示用表格 `| 实际 JPY | 换算后价格 |`，换算按用户语言（中文→人民币 / 日文→日元 / 英文→美元），汇率参考 `https://open.er-api.com/v6/latest/JPY`
- 下载：BOOTH「购买的商品/资料库」`https://accounts.booth.pm/library`
- 本 skill 范围：搜索 → 购买 → 素材下载完整闭环。