# 自建一次性邮箱（Cloudflare Worker 版）

用 Cloudflare 免费额度搭一个**属于你自己的临时邮箱**：打开网页 → 输入任意前缀 → 收验证码。
不需要服务器，不需要装数据库，成本 0 元。

## 它能做什么

- 📬 **任意前缀收信**：`test@你的域名`、`abc@你的域名`、`xyz@你的域名`……不用注册账号
- 🔢 **自动提取验证码**：中文「验证码 123456」、英文「code: ABC123」都能认出来，一键复制
- 🔐 **账号密码登录**：网页有登录门，别人打不开
- ⏱️ **邮件 10 分钟自动销毁**：不留痕
- 🌐 **多个域名可选**：一个 Worker 服务多个域名
- 🚫 **收件白名单**：非白名单域名的邮件直接丢弃，不消耗额度

## 前置条件

| 需要什么 | 说明 |
|---|---|
| Cloudflare 账号 | 免费版即可 |
| 一个域名 | 托管在 Cloudflare（NS 已切过去） |
| Node.js | 用于打包代码（v18+） |

> 没有域名？Cloudflare 只提供**收信**需要域名。域名可以很便宜，也可以从一些免费域名服务获取。

## 五步部署

### 第 1 步：开启 Email Routing

1. Cloudflare 后台 → 选中你的域名
2. 左侧菜单 **Email** → **Email Routing**
3. 点 **Enable Email Routing**
4. 它会让你添加 MX 和 TXT 记录 —— **点「Add records automatically」一键搞定**

### 第 2 步：创建 KV 存储

```bash
npx wrangler kv namespace create MAIL_KV
```

输出会给你一个 `id`，**记下来**，下一步要填。

### 第 3 步：改配置 + 部署

打开 `worker.js`，改开头这几行：

```js
const CONFIG = {
  // 收件白名单（防垃圾邮件灌爆 KV 额度）
  ALLOWED_RECIPIENTS: [
    '@your-domain.com',      // ← 改成你的域名
  ],

  // 网页可选的收信域名
  DOMAINS: [
    'your-domain.com',       // ← 改成你的域名
  ],

  // 网页登录账号密码
  WEB_USERNAME: 'admin',                        // ← 改成你的账号
  WEB_PASSWORD: 'CHANGE_ME_STRONG_PASSWORD',    // ← 改成强密码！

  SESSION_TTL: 604800,   // 登录有效期，7 天
  SESSION_SECRET: '',    // 留空会自动从账号密码派生；建议单独设置一串随机字符
  MAIL_TTL: 600,         // 邮件存活秒数，600 = 10 分钟
  INDEX_LIMIT: 20,       // 每个邮箱最多保留多少封
};
```

然后部署：

```bash
npx wrangler deploy
```

> 如果 `worker.js` 里的 import 路径在你的环境下报错，把 `vendor/postal-mime/src/postal-mime.js`
> 换成 `npm install postal-mime` 后 `import PostalMime from 'postal-mime'` 也可以。

### 第 4 步：绑定域名 + 路由

**4a. 把 Worker 挂到网页域名上**

Cloudflare 后台 → 你的域名 → **Workers Routes**（或 **DNS** → 加一条）
→ 添加路由：`mail.your-domain.com/*` → 选你的 Worker

也可以直接用 `wrangler.toml`（见仓库里的示例文件）。

**4b. 让收信落到 Worker**

Cloudflare 后台 → 你的域名 → **Email** → **Email Routing** → **Routing rules**
→ 找到 **Catch-all address** → **Edit**
→ Action 选 **Send to a Worker** → 选中你的 Worker → **Save**

> ⚠️ **这一步最容易漏。** 只配了网页域名、没配 catch-all，网页能打开但收不到信。

### 第 5 步：验证

```bash
# 1. 测试登录
curl -i -X POST https://mail.your-domain.com/__auth \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"你的密码"}'
# 期望：200 + set-cookie: tm_session=...

# 2. 用任意邮箱发一封信到 test@your-domain.com
# 3. 用返回的 Cookie 查询（注意路径是 /api/check/ 加用户名，不是完整邮箱）
curl -H "Cookie: tm_session=上一步的token" \
  https://mail.your-domain.com/api/check/test
# 期望：{"username":"test","count":1,"messages":[{...,"code":"123456"}]}
```

## API 一览

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/__auth` | 登录，body: `{"username":"...","password":"..."}` |
| GET | `/__logout` | 退出登录 |
| GET | `/` | 网页界面 |
| GET | `/api/check/{username}` | **查某前缀的邮件（最常用）**，返回含 `code` 字段 |
| GET | `/api/inbox/{username}` | 只返回邮件索引（轻量） |
| GET | `/api/mail/{username}/{id}` | 读某封邮件正文 |
| GET | `/api/` | 服务状态 + 域名列表 |

> 注意：`{username}` 是**邮箱 @ 前面的前缀**，不是完整邮箱地址。
> 所有 `/api/*` 都需要登录后的 `tm_session` Cookie。

## 常见坑（都是实际踩过的）

1. **部署后所有接口 500（error 1101）**
   部署时 `metadata.bindings` 里漏了 KV 绑定，Cloudflare 会把绑定清空。
   用 `wrangler deploy` 走 `wrangler.toml` 一般不会有这个问题；
   如果用 REST API 手动部署，务必在 metadata 里带上 bindings。

2. **网页能开但收不到信**
   catch-all 规则没配。见第 4 步 b。

3. **主题乱码、验证码抓错**
   直接读原始邮件源码会拿到 `=?utf-8?b?...?=` 这种 MIME 编码串，
   还可能从签名/页脚里误抓出 `are-ema` 之类的假验证码。
   **必须用 postal-mime 之类库先解码 MIME**，再在解码后的文本里匹配。

4. **curl 测试返回 403 Forbidden**
   Cloudflare 会拦没有 User-Agent 的请求。测试时加上
   `-H "User-Agent: Mozilla/5.0"`。

5. **改了账号密码后旧登录还有效**
   因为会话签名密钥没变。要么设置独立的 `SESSION_SECRET`，
   要么改完密码后重启 Worker（换密钥 = 所有旧 Cookie 失效）。

6. **KV 额度被垃圾邮件吃光（真实踩坑，2026-09）**
   一开始以为 `ALLOWED_RECIPIENTS` 白名单能挡住，结果**没用**。

   原因是：如果你的站是「任意前缀、无需注册」的公开临时邮箱，
   白名单就只能写成域名级 `@your-domain.com`——**只要域名被垃圾邮件
   字典收录，任何随机地址 `zf7k2@your-domain.com` 都会通过白名单**，
   每封仍写 2 次 KV。实测一天被灌 **643 封 → 1287 次 put**，
   直接打穿 1000 次配额，全站接口开始 429。

   **正确做法是两层「行为限速」**（本项目已内置，见下方说明）：
   - 同一收件前缀单日上限 `RATE_PER_RECIPIENT`（默认 10）
   - 同一发件域单日上限 `RATE_PER_SENDER`（默认 5）

   ⚠️ 最关键的一点：**被限速拦截时必须直接 `return`，不能写计数器**。
   计数器本身也消耗 put；如果被拦还写，攻击者每封仍能耗 2 次 put，
   配额照样被打穿。拦住之后 0 消耗，攻击才真正失效。

   实测效果（本地模拟真实 handler）：

   | 场景 | 无防护 | 加限速后 |
   |---|---|---|
   | 单发件域灌 2000 封 | 4000 put（第 500 封打穿）| **20 put** |
   | 3 个正常用户各收 2 封 | 12 put | 12 put（0 误伤）|

7. **想知道"是谁在灌"却发现查不到**
   发件人地址只存在于 Worker 的 `console.log` 里，而 **Worker 日志
   默认不落盘**（免费版保留时间极短），KV 里的邮件又会被 TTL
   自动删除。等发现超限再去查，**发件人信息已经永久丢失**。

   想下次能溯源，需要**提前**做两件事：
   - 开启 **logpush** 把 Worker 日志落盘（或用 `wrangler tail` 实时盯）
   - Worker 里保留 `RATE_LIMITED` / `DROPPED` 日志（本项目已含发件人字段）

## 反滥用：两层限速（v5 新增）

免费套餐 KV **只有 1000 次写/天**，而每收一封邮件要写 2 次
（邮件体 + 收件箱索引）。公开的临时邮箱很容易被垃圾邮件灌爆，
一旦超限，**整个站所有接口都会 429**。

本项目内置了两层基于**行为**的限速，不需要预先知道会收到什么邮件，
也不依赖白名单猜地址：

| 层 | 规则 | 拦住什么 |
|---|---|---|
| 收件层 | 同一收件前缀单日 ≤ `RATE_PER_RECIPIENT` | 灌爆某个具体地址 |
| 发件层 | 同一发件域单日 ≤ `RATE_PER_SENDER` | 单个垃圾源批量群发 |

配置项（`worker.js` 顶部 `CONFIG`）：

```js
RATE_PER_RECIPIENT: 10,   // 同一收件前缀单日上限
RATE_PER_SENDER: 5,       // 同一发件域单日上限
RATE_TTL: 172800,         // 计数器保留 48h
LOG_RATE_LIMITED: true,   // 触发时记日志（含发件人，便于溯源）
```

**设计要点（踩坑换来的）**：

1. **被拦截时不写计数器**（0 put）。计数器停在阈值即可持续拦截；
   若被拦还写，攻击者每封仍烧 2 次 put，配额照样被打穿。
2. **计数器读写失败时放行**（fail-open）。宁可在极端情况下漏拦，
   也不能因为计数器故障把正常收信全掐了。
3. **按发件「域」聚合而非完整地址**。垃圾源常用同域下的大量不同
   本地名轰炸，按地址计数会漏；按域聚合才抓得住。
4. 计数器 TTL 设 **48h**（跨过 UTC 日界），避免临界时刻误伤。

需要更严可以调小阈值；如果你的域名不公开，把
`ALLOWED_RECIPIENTS` 收窄到**具体地址**是最彻底的做法（零消耗丢弃）。

## 安全提醒

- `WEB_PASSWORD` **一定要设强密码**，页面是公网可访问的
- 建议设置独立的 `SESSION_SECRET`（随机字符串），而不是从密码派生
- 如需更严格，可加登录失败次数限制

## 成本

Cloudflare 免费额度：
- Workers：10 万次请求/天
- KV：读 10 万次/天，写 1000 次/天

个人使用完全够，**0 元**。

## 目录结构

```
.
├── worker.js                      # Worker 主程序（改配置在这里）
├── wrangler.toml.example          # wrangler 配置示例
├── vendor/
│   └── postal-mime/               # MIME 解析库（已内置，可直接用）
└── README.md
```

## 关于作者

这个项目在公众号 **「飞来飞去的安伯伯」** 首次公开。

公众号会写一些自建服务、白嫖 Cloudflare 免费额度、以及踩坑记录。
有问题或想聊，欢迎在公众号留言。

- 公众号：**飞来飞去的安伯伯**
- GitHub：[@iamkingab](https://github.com/iamkingab)

## 许可

MIT License —— 随便用，随便改，改成你自己的拿去用就好。
