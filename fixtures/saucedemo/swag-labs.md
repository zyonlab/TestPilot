# Swag Labs 电商前台 — 产品规格

> 版本 v1.0 · 适用环境：<https://www.saucedemo.com>
>
> **这份素材是怎么来的，必须先说清楚。** Swag Labs（SauceDemo）是 Sauce Labs 公开的 E2E 练习靶站，
> 它**没有官方产品规格文档**。这份文档由人对着运行中的站点逐项实测后写成（登录六种账号、
> 四种排序、购物车增删、结账三步的每一个必填校验、未登录直接访问受限页），
> 每一条验收标准都有一次实际观测作为出处。
>
> 因此它带着一个**已知的度量偏差**：素材的作者读过实现的行为。用它算出来的 Coverage
> 衡量的是「harness 能不能把素材拆成用例」，**不衡量**「harness 能不能补上素材没写的东西」。
> 要去掉这个偏差，需要一份独立作者写的规格；在那之前，这个数只能当链路指标看。
>
> 靶站是第三方托管的，我们冻结不了它。观测日期：2026-08-27。站点若改版，本文档与
> `gold-checklist.json` 需同步重测，否则用例会因为素材过期而失败——那种红说明不了产品的任何事。

## 1. 背景与角色

Swag Labs 是一个只有前台的服装电商演示站：登录后浏览商品、加入购物车、填写收货信息、下单。
没有注册、没有找回密码、没有搜索、没有真实支付——结账第二步显示的付款方式是固定的
`SauceCard #31337`，第三步只是确认页。

| 角色 | 说明 |
|---|---|
| 未登录访客 | 只能看到登录页；直接访问任何内页会被弹回登录页并给出提示 |
| 已登录顾客 | 浏览商品、排序、加购、结账、退出 |

站点公开列出了六个测试账号，**密码全部是 `secret_sauce`**：

| 账号 | 用途 |
|---|---|
| `standard_user` | 正常账号，全部功能可用 |
| `locked_out_user` | 被锁定，登录必被拒绝 |
| `problem_user` | 故意存在界面缺陷的账号 |
| `performance_glitch_user` | 故意存在加载缓慢的账号 |
| `error_user` / `visual_user` | 故意存在功能与视觉缺陷的账号 |

后四个账号是站点自带的**缺陷注入开关**：同一份用例在 `standard_user` 上应当全绿，
在它们上面应当有用例变红。本规格的验收标准全部以 `standard_user` 为准。

## 2. 用户故事

**US-01 使用有效凭证登录**
作为顾客，我想用账号和密码登录，以便浏览商品。
- AC-01.1 用户名为已列出的账号之一、密码为 `secret_sauce` 时，登录成功。
- AC-01.2 登录成功后跳转到商品列表页，地址为 `/inventory.html`。
- AC-01.3 商品列表页的标题显示 `Products`。

**US-02 凭证不正确时被拒绝**
作为系统，我要在凭证不正确时拒绝登录，以免他人进入他人账户。
- AC-02.1 密码不正确时停留在登录页，显示错误 `Epic sadface: Username and password do not match any user in this service`。
- AC-02.2 用户名不存在时，显示与 AC-02.1 完全相同的错误文案——错误提示不区分「用户不存在」与「密码错误」，以免泄露账号是否存在。
- AC-02.3 被拒绝后地址仍为 `/`，不发生跳转。

**US-03 必填项校验**
作为顾客，我要在漏填时得到明确提示，以便知道该补什么。
- AC-03.1 用户名为空时（无论密码填没填），显示 `Epic sadface: Username is required`。
- AC-03.2 用户名非空、密码为空时，显示 `Epic sadface: Password is required`。
- AC-03.3 两项都为空时，只提示用户名——校验按字段顺序在第一个缺失项上停下。

**US-04 被锁定的账号无法登录**
作为系统，我要拒绝已被锁定的账号，即使它的密码是对的。
- AC-04.1 以 `locked_out_user` + 正确密码登录，显示 `Epic sadface: Sorry, this user has been locked out.`。
- AC-04.2 停留在登录页，不进入商品列表。

**US-05 未登录不能访问内页**
作为系统，我要拦住未登录状态下对内页的直接访问。
- AC-05.1 未登录时直接访问 `/inventory.html`，被弹回登录页。
- AC-05.2 显示错误 `Epic sadface: You can only access '/inventory.html' when you are logged in.`。

**US-06 浏览商品列表**
作为顾客，我想看到在售商品及其价格。
- AC-06.1 商品列表共 **6 件**商品。
- AC-06.2 每件商品显示名称、描述、价格与一个「Add to cart」按钮。
- AC-06.3 六件商品与价格为：Sauce Labs Backpack `$29.99`、Sauce Labs Bike Light `$9.99`、
  Sauce Labs Bolt T-Shirt `$15.99`、Sauce Labs Fleece Jacket `$49.99`、Sauce Labs Onesie `$7.99`、
  Test.allTheThings() T-Shirt (Red) `$15.99`。

**US-07 商品排序**
作为顾客，我想按名称或价格排序，以便更快找到想要的东西。
- AC-07.1 排序下拉框提供四项：`Name (A to Z)`、`Name (Z to A)`、`Price (low to high)`、`Price (high to low)`。
- AC-07.2 默认排序为 `Name (A to Z)`，第一件是 `Sauce Labs Backpack`。
- AC-07.3 选 `Name (Z to A)` 后第一件是 `Test.allTheThings() T-Shirt (Red)`。
- AC-07.4 选 `Price (low to high)` 后第一件是 `Sauce Labs Onesie`（`$7.99`）。
- AC-07.5 选 `Price (high to low)` 后第一件是 `Sauce Labs Fleece Jacket`（`$49.99`）。

**US-08 查看商品详情**
作为顾客，我想点开一件商品看它的详情。
- AC-08.1 点击商品名称进入详情页，地址形如 `/inventory-item.html?id=<n>`。
- AC-08.2 详情页显示与列表一致的名称、价格与完整描述。
- AC-08.3 详情页提供「Back to products」返回列表。

**US-09 加入购物车**
作为顾客，我想把商品加入购物车。
- AC-09.1 点击某件商品的「Add to cart」后，该按钮变为「Remove」。
- AC-09.2 购物车图标上出现角标，数字等于已加入的商品件数。
- AC-09.3 加入两件不同商品后，角标显示 `2`。
- AC-09.4 未加入任何商品时，购物车图标上没有角标（不是显示 `0`，是不显示）。

**US-10 查看与修改购物车**
作为顾客，我想核对购物车里的东西，并能移除不要的。
- AC-10.1 点击购物车图标进入 `/cart.html`，标题显示 `Your Cart`。
- AC-10.2 每一行显示商品名称、单价与数量，数量为 `1`。
- AC-10.3 每一行提供「Remove」按钮；移除后该行消失，角标数字相应减少。
- AC-10.4 页面提供「Continue Shopping」返回商品列表，以及「Checkout」进入结账。

**US-11 填写收货信息**
作为顾客，我要填写姓名与邮编才能继续下单。
- AC-11.1 结账第一步地址为 `/checkout-step-one.html`，标题 `Checkout: Your Information`。
- AC-11.2 三个必填项：First Name、Last Name、Zip/Postal Code。
- AC-11.3 三项都为空时点继续，显示 `Error: First Name is required`。
- AC-11.4 只填 First Name 时点继续，显示 `Error: Last Name is required`。
- AC-11.5 填了姓名、邮编为空时点继续，显示 `Error: Postal Code is required`。
- AC-11.6 三项都填写后点继续，进入 `/checkout-step-two.html`。

**US-12 核对订单金额**
作为顾客，我要在付款前看到明细与总价。
- AC-12.1 结账第二步标题为 `Checkout: Overview`，列出本次购买的商品行。
- AC-12.2 显示付款方式 `SauceCard #31337` 与配送方式 `Free Pony Express Delivery!`。
- AC-12.3 显示 `Item total`（商品小计）、`Tax`（税）、`Total`（合计）三个数。
- AC-12.4 税为商品小计的 **8%**，四舍五入到分；合计 = 小计 + 税。
  例：小计 `$39.98` 时税为 `$3.20`、合计为 `$43.18`。

**US-13 完成下单**
作为顾客，我想确认下单并得到成功反馈。
- AC-13.1 在第二步点「Finish」后进入 `/checkout-complete.html`，标题 `Checkout: Complete!`。
- AC-13.2 页面显示 `Thank you for your order!`。
- AC-13.3 下单后购物车清空，角标不再显示。
- AC-13.4 页面提供「Back Home」回到商品列表。

**US-14 退出登录**
作为顾客，我想退出，以免别人用我的账号。
- AC-14.1 左上角菜单按钮打开侧边菜单，含 All Items、About、Logout、Reset App State 四项。
- AC-14.2 点击 Logout 后回到登录页（地址 `/`），重新显示登录表单。
- AC-14.3 退出后再直接访问 `/inventory.html`，按 US-05 被拦下。

## 3. 明确不在范围内

注册、找回密码、记住我、第三方登录、搜索、商品评价、优惠券、真实支付、
`About` 链接指向的外部站点、`Reset App State` 之外的任何数据管理功能。

## 4. 已知的非功能约定

- 站点为第三方托管，网络往返计入耗时；性能基线只在同一网络条件下可比。
- 商品图片来自站点自身的静态资源，视觉基线对图片加载时机敏感。
- `problem_user` 等四个账号会**故意**表现出缺陷，任何以它们为前提的用例都应显式写明账号。
