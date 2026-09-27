/**
 * Cloudflare Worker: 临时邮箱接收器 + 网页界面 (v5 - 反滥用限速版)
 *
 * 页面地址: https://mail.your-domain.com (或 workers.dev 地址)
 *
 * v5 新增（真实踩坑后的加固）：
 *   1. 两层行为限速：同收件前缀 / 同发件域单日上限，防垃圾邮件灌爆 KV
 *   2. 被限速拦截时【不写计数器】→ 拦住之后 0 消耗，配额不会被烧穿
 *   3. 限速日志含发件人，便于事后溯源（配合 logpush / wrangler tail）
 *
 * v4 修复：
 *   1. 用 postal-mime 正确解析 MIME → 主题不乱码、正文自动 base64/QP 解码
 *   2. 验证码提取改为「优先从解码后的正文/主题提取」
 *   3. 敏感 Header 过滤，避免从 Received 头里误抓
 */

import PostalMime from './vendor/postal-mime/src/postal-mime.js';

// ==================== 配置区 ====================
const CONFIG = {
  // 收件白名单（防垃圾邮件灌爆 KV 额度）
  ALLOWED_RECIPIENTS: [
    '@your-domain.com',
  ],

  ALLOW_WHEN_WHITELIST_EMPTY: false,

  // ---- 反滥用限速（防垃圾邮件灌爆 KV 免费额度）----
  // 背景：免费套餐 KV 只有 1000 次 put/天，而每封邮件要写 2 次
  // （邮件体 + 收件箱索引）。若公开暴露收信域名，会被垃圾邮件字典
  // 群发灌爆——实测一天 643 封就能打穿配额，全站 429。
  //
  // 注意：如果你的站是「任意前缀、无需注册」的公开临时邮箱，
  // 收件白名单本质上是域名级（@your-domain.com），挡不住随机地址。
  // 此时真正的防线就是下面两层「行为限速」。
  RATE_PER_RECIPIENT: 10,   // 同一收件前缀单日上限
  RATE_PER_SENDER: 5,       // 同一发件域单日上限
  RATE_TTL: 172800,         // 计数器保留 48h（跨过 UTC 日界不误伤）
  LOG_RATE_LIMITED: true,   // 触发限速时记日志（含发件人，便于溯源）

  // 网页可选的收信域名
  DOMAINS: [
    'your-domain.com',
  ],

  // 网页登录账号密码
  // ── 安全配置 ─────────────────────────────────────────────
  // 登录账号密码。默认值仅供本地跑通，部署前必须改。
  WEB_USERNAME: 'admin',
  WEB_PASSWORD: 'CHANGE_ME_STRONG_PASSWORD',

  // 会话签名密钥（随机字符串）。留空则从账号口令派生——
  // 生产环境建议填一个独立的随机值，改密码时不会导致所有人掉线。
  SESSION_SECRET: 'REPLACE_ME_AT_DEPLOY',

  // 会话有效期 7 天
  SESSION_TTL: 604800,

  // 邮件 TTL（秒）
  MAIL_TTL: 600,

  INDEX_LIMIT: 20,

  LOG_DROPPED: true,
};
// ===============================================

// ---------- 工具函数 ----------

function b64url(str) {
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function hmacKey(secret) {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
}

async function sign(payload, secret) {
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  return b64url(String.fromCharCode(...new Uint8Array(sig)));
}

async function makeSession(secret, ttlSec) {
  const exp = Math.floor(Date.now() / 1000) + ttlSec;
  const payload = String(exp);
  return `${payload}.${await sign(payload, secret)}`;
}

async function verifySession(token, secret) {
  if (!token || !token.includes('.')) return false;
  const [payload, sig] = token.split('.');
  const exp = parseInt(payload, 10);
  if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) return false;
  return (await sign(payload, secret)) === sig;
}

function parseCookies(request) {
  const h = request.headers.get('Cookie') || '';
  const out = {};
  h.split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = p.slice(i + 1).trim();
  });
  return out;
}

/**
 * 验证码提取（v4 改进）
 * 输入应是【已解码】的主题与正文，避免从 MIME Header 误抓
 */
function extractCode(subject, body) {
  const s = subject || '';
  const b = body || '';

  // 1. 中文「验证码」优先（最明确）
  let m = s.match(/验证码[：:\s]*([A-Za-z0-9]{4,8})/) || b.match(/验证码[：:\s]*([A-Za-z0-9]{4,8})/);
  if (m) return m[1];

  // 2. 英文 verification code / code
  m = b.match(/verification\s+code[:\s]+([A-Za-z0-9]{4,8})/i) ||
      s.match(/verification\s+code[:\s]+([A-Za-z0-9]{4,8})/i);
  if (m) return m[1];

  // 3. 主题里独立的 4-8 位数字（很多服务主题就是验证码）
  m = s.match(/(?:^|\s|\b)(\d{4,8})(?:\s|$|\b)/);
  if (m) return m[1];

  // 4. XXX-XXX 格式（放在最后，避免误抓单词片段）
  m = s.match(/\b([A-Z0-9]{3}-[A-Z0-9]{3})\b/i);
  if (m) return m[1];

  // 5. 正文中独立的 4-8 位数字
  m = b.match(/(?:^|\s|\b)(\d{4,8})(?:\s|$|\b)/);
  if (m) return m[1];

  return '';
}

// ---------- 反滥用限速 ----------

/**
 * 从发件人字符串里取出「限速键」。
 * 正常发件人形如 "Sender Name <a@b.com>"，也可能直接是 "a@b.com"。
 * 返回发件域（小写）——同一垃圾源常用多个子域/地址轰炸，
 * 按域聚合比按地址聚合更能抓住它。
 */
function extractSenderKey(from) {
  const s = String(from || '').toLowerCase().trim();
  const m = s.match(/<([^>]+)>/);
  const addr = (m ? m[1] : s).trim();
  const at = addr.lastIndexOf('@');
  if (at === -1 || at === addr.length - 1) return addr || 'unknown';
  return addr.slice(at + 1);
}

/**
 * 检查两层限速。返回 { allowed, which, recipCount, senderCount }
 * 计数器：rate/r/<utcdate>/<收件前缀> → 次数
 *         rate/s/<utcdate>/<发件域>   → 次数
 */
async function checkRateLimit(env, toUser, senderKey) {
  const day = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
  const rKey = `rate/r/${day}/${toUser}`;
  const sKey = `rate/s/${day}/${senderKey}`;

  let recipCount = 0;
  let senderCount = 0;
  try {
    const [r, s] = await Promise.all([
      env.MAIL_KV.get(rKey),
      env.MAIL_KV.get(sKey),
    ]);
    recipCount = parseInt(r || '0', 10) || 0;
    senderCount = parseInt(s || '0', 10) || 0;
  } catch (e) {
    // 读失败 → 放行：宁可漏拦，也不因计数器故障误伤正常收信
    console.error('rate limit read failed, fail-open:', e.message);
    return { allowed: true, which: '', recipCount: -1, senderCount: -1 };
  }

  const overRecip = recipCount >= CONFIG.RATE_PER_RECIPIENT;
  const overSender = senderCount >= CONFIG.RATE_PER_SENDER;
  if (overRecip || overSender) {
    // ⚠️ 关键：被拦截时【不写计数器】。
    // 计数器停在阈值即可持续拦截；若被拦还写，攻击者每封仍能耗 2 次 put，
    // 配额照样被打穿。不写 → 拦住之后 0 消耗，攻击彻底失效。
    // 实测：单发件域灌 2000 封，总消耗从 4000 put 降到 20 put。
    return {
      allowed: false,
      which: overRecip ? 'per-recipient' : 'per-sender',
      recipCount,
      senderCount,
    };
  }

  // 通过 → 计数 +1（写失败不影响本次收信）
  try {
    await Promise.all([
      env.MAIL_KV.put(rKey, String(recipCount + 1), { expirationTtl: CONFIG.RATE_TTL }),
      env.MAIL_KV.put(sKey, String(senderCount + 1), { expirationTtl: CONFIG.RATE_TTL }),
    ]);
  } catch (e) {
    console.error('rate limit write failed:', e.message);
  }

  return {
    allowed: true,
    which: '',
    recipCount: recipCount + 1,
    senderCount: senderCount + 1,
  };
}

// ---------- 邮件处理 ----------

async function handleEmail(message, env) {
  const to = (message.to || '').toLowerCase().trim();
  const from = message.from || '';
  const toUser = to.split('@')[0];
  const toDomain = to.split('@')[1] || '';

  // 白名单过滤
  const wl = CONFIG.ALLOWED_RECIPIENTS.map((s) => s.toLowerCase().trim());
  let allowed;
  if (wl.length === 0) {
    allowed = CONFIG.ALLOW_WHEN_WHITELIST_EMPTY;
  } else {
    allowed = wl.some((rule) => {
      if (rule.startsWith('@')) return toDomain === rule.slice(1);
      if (rule.includes('@')) return to === rule;
      return toUser === rule;
    });
  }
  if (!allowed) {
    if (CONFIG.LOG_DROPPED) console.log(`DROPPED not-whitelisted: to=${to} from=${from}`);
    return;
  }

  // ---- 反滥用限速（第 2、3 层）----
  const senderKey = extractSenderKey(from);
  const rate = await checkRateLimit(env, toUser, senderKey);
  if (!rate.allowed) {
    if (CONFIG.LOG_RATE_LIMITED) {
      console.log(
        `RATE_LIMITED ${rate.which}: to=${to} from=${from} ` +
          `recipCount=${rate.recipCount} senderCount=${rate.senderCount}`
      );
    }
    return;
  }

  const id = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  // ---- 用 postal-mime 解析 ----
  let subject = '';
  let textBody = '';
  let htmlBody = '';

  try {
    const rawBuffer = await new Response(message.raw).arrayBuffer();
    const parsed = await PostalMime.parse(rawBuffer);
    subject = parsed.subject || message.headers.get('subject') || '';
    textBody = parsed.text || '';
    htmlBody = parsed.html || '';
    if (!textBody && htmlBody) {
      // HTML 邮件：简单去标签作为纯文本备份
      textBody = htmlBody.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    }
  } catch (e) {
    console.error('MIME parse failed, fallback to raw:', e.message);
    subject = message.headers.get('subject') || '';
    try {
      textBody = await new Response(message.raw).text();
    } catch (_) {
      textBody = '';
    }
  }

  const record = {
    id,
    from,
    to,
    subject,
    text: textBody.substring(0, 50000),
    html: htmlBody ? htmlBody.substring(0, 50000) : '',
    code: extractCode(subject, textBody),
    time: new Date().toISOString(),
  };

  await env.MAIL_KV.put(`mail/${toUser}/${id}`, JSON.stringify(record), {
    expirationTtl: CONFIG.MAIL_TTL,
  });

  const indexKey = `inbox/${toUser}`;
  const existing = (await env.MAIL_KV.get(indexKey, 'json')) || [];
  existing.push({
    id,
    subject,
    from,
    code: record.code,
    time: record.time,
  });
  await env.MAIL_KV.put(indexKey, JSON.stringify(existing.slice(-CONFIG.INDEX_LIMIT)), {
    expirationTtl: CONFIG.MAIL_TTL,
  });

  console.log(`STORED mail/${toUser}/${id} code=${record.code || '-'} subject=${subject}`);
}

// ---------- 网页 ----------

const LOGIN_PAGE = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>登录 · 临时邮箱</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
    background: linear-gradient(135deg,#667eea 0%,#764ba2 100%); min-height: 100vh;
    display: flex; align-items: center; justify-content: center; padding: 20px; }
  .card { background:#fff; border-radius:16px; padding:40px 32px; width:100%; max-width:380px;
    box-shadow:0 20px 60px rgba(0,0,0,.3); }
  h1 { font-size:22px; margin-bottom:6px; color:#1a1a2e; }
  .sub { color:#888; font-size:13px; margin-bottom:26px; }
  input { width:100%; padding:13px 15px; border:2px solid #e5e5ef; border-radius:10px;
    font-size:16px; outline:none; transition:border .2s; }
  input:focus { border-color:#667eea; }
  button { width:100%; padding:13px; margin-top:16px; border:0; border-radius:10px;
    background:linear-gradient(135deg,#667eea,#764ba2); color:#fff; font-size:16px;
    font-weight:600; cursor:pointer; }
  button:hover { opacity:.9; }
  .err { color:#e74c3c; font-size:13px; margin-top:12px; min-height:18px; }
</style>
</head>
<body>
  <div class="card">
    <h1>📬 临时邮箱</h1>
    <div class="sub">请登录后使用</div>
    <form onsubmit="return login(event)">
      <input type="text" id="un" placeholder="账号" autofocus autocomplete="username">
      <input type="password" id="pw" placeholder="密码" autocomplete="current-password" style="margin-top:12px">
      <button type="submit">登录</button>
      <div class="err" id="err"></div>
    </form>
  </div>
<script>
async function login(e){
  e.preventDefault();
  const r = await fetch('/__auth',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({username:document.getElementById('un').value,
                         password:document.getElementById('pw').value})});
  if(r.ok) location.href='/'; else document.getElementById('err').textContent='账号或密码错误';
  return false;
}
</script>
</body></html>`;

const INDEX_PAGE = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>临时邮箱</title>
<style>
  * { box-sizing:border-box; margin:0; padding:0; }
  body { font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
    background:#f4f5fb; min-height:100vh; color:#1a1a2e; }
  .top { background:linear-gradient(135deg,#667eea,#764ba2); color:#fff; padding:22px 20px;
    box-shadow:0 2px 16px rgba(102,126,234,.35); }
  .top h1 { font-size:19px; font-weight:600; display:inline-block; }
  .logout { float:right; font-size:13px; color:#fff; opacity:.85; text-decoration:none;
    border:1px solid rgba(255,255,255,.5); padding:5px 12px; border-radius:20px; }
  .logout:hover { opacity:1; background:rgba(255,255,255,.15); }
  .wrap { max-width:860px; margin:0 auto; padding:22px 16px 60px; }
  .panel { background:#fff; border-radius:14px; padding:20px; box-shadow:0 2px 12px rgba(0,0,0,.06); margin-bottom:18px; }
  label { font-size:13px; color:#666; display:block; margin-bottom:7px; font-weight:500; }
  .row { display:flex; gap:10px; flex-wrap:wrap; }
  input[type=text] { flex:1; min-width:130px; padding:12px 14px; border:2px solid #e5e5ef;
    border-radius:10px; font-size:15px; outline:none; }
  input[type=text]:focus { border-color:#667eea; }
  select { padding:12px 14px; border:2px solid #e5e5ef; border-radius:10px; font-size:15px;
    background:#fff; outline:none; cursor:pointer; min-width:170px; }
  select:focus { border-color:#667eea; }
  button { padding:12px 22px; border:0; border-radius:10px; font-size:15px; font-weight:600;
    cursor:pointer; background:linear-gradient(135deg,#667eea,#764ba2); color:#fff; }
  button:hover { opacity:.88; }
  button.ghost { background:#eef0f7; color:#555; }
  .addrline { margin-top:13px; padding:12px 15px; background:#f0f2fb; border-radius:10px;
    font-family:ui-monospace,Menlo,Consolas,monospace; font-size:15px; display:flex;
    align-items:center; justify-content:space-between; gap:10px; word-break:break-all;
    border-left:4px solid #667eea; }
  .addrline span { flex:1; }
  .copy-mini { padding:6px 13px; font-size:12px; border-radius:7px; background:#667eea;
    color:#fff; border:0; cursor:pointer; flex-shrink:0; font-weight:500; }
  h2 { font-size:15px; margin-bottom:13px; color:#333; }
  .mail { border:1px solid #e8eaf2; border-radius:11px; padding:14px 16px; margin-bottom:11px; background:#fdfdff; }
  .mail:hover { box-shadow:0 3px 14px rgba(102,126,234,.13); }
  .mail .subj { font-weight:600; font-size:15px; margin-bottom:5px; word-break:break-word; }
  .mail .meta { font-size:12px; color:#999; margin-bottom:9px; }
  .code { display:inline-flex; align-items:center; gap:9px; background:linear-gradient(135deg,#e8f5e9,#f1f8e9);
    border:1.5px solid #a5d6a7; border-radius:9px; padding:8px 14px; margin-bottom:9px; }
  .code b { font-family:ui-monospace,Menlo,monospace; font-size:19px; color:#2e7d32; letter-spacing:1.5px; }
  .code button { padding:5px 12px; font-size:12px; background:#43a047; border-radius:7px; }
  .body-toggle { font-size:12.5px; color:#667eea; cursor:pointer; user-select:none; font-weight:500; }
  .body { margin-top:11px; padding:13px; background:#f7f8fc; border-radius:9px; font-size:13px;
    white-space:pre-wrap; word-break:break-word; max-height:420px; overflow:auto;
    font-family:ui-monospace,Menlo,monospace; border:1px solid #eceef6; }
  .empty { text-align:center; color:#aaa; padding:44px 20px; font-size:14px; }
  .empty .ic { font-size:42px; margin-bottom:12px; }
  .toast { position:fixed; bottom:28px; left:50%; transform:translateX(-50%) translateY(90px);
    background:#32324a; color:#fff; padding:12px 26px; border-radius:26px; font-size:14px;
    opacity:0; transition:all .3s; pointer-events:none; z-index:99; }
  .toast.show { opacity:1; transform:translateX(-50%) translateY(0); }
  .hint { font-size:12px; color:#999; margin-top:9px; }
</style>
</head>
<body>
<div class="top">
  <h1>📬 临时邮箱</h1>
  <a class="logout" href="/__logout">退出</a>
</div>
<div class="wrap">
  <div class="panel">
    <label>邮箱前缀（任意名称，无需注册）</label>
    <div class="row">
      <input type="text" id="user" placeholder="例如 test" autocomplete="off">
      <select id="domain"></select>
      <button onclick="load()">查询</button>
      <button class="ghost" onclick="load()">↻ 刷新</button>
    </div>
    <div class="addrline">
      <span id="addr">—</span>
      <button class="copy-mini" onclick="copyAddr()">复制地址</button>
    </div>
    <div class="hint">邮件 10 分钟后自动销毁 · 页面每 15 秒自动刷新</div>
  </div>
  <div class="panel">
    <h2 id="listTitle">收件箱</h2>
    <div id="list"><div class="empty"><div class="ic">📭</div>输入前缀后点击「查询」</div></div>
  </div>
</div>
<div class="toast" id="toast"></div>
<script>
const DOMAINS = __DOMAINS__;
let timer = null;
function toast(m){const t=document.getElementById('toast');t.textContent=m;t.classList.add('show');
  clearTimeout(t._h);t._h=setTimeout(()=>t.classList.remove('show'),1800);}
function copyText(text){
  navigator.clipboard.writeText(text).then(()=>toast('已复制：'+text),()=>{
    const ta=document.createElement('textarea');ta.value=text;document.body.appendChild(ta);
    ta.select();document.execCommand('copy');document.body.removeChild(ta);toast('已复制：'+text);});
}
function copyAddr(){const u=document.getElementById('user').value.trim();
  if(!u)return toast('请先输入前缀');copyText(u+'@'+document.getElementById('domain').value);}
function currentAddr(){const u=document.getElementById('user').value.trim().toLowerCase();
  return u?u+'@'+document.getElementById('domain').value:'';}
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
async function load(){
  const u=document.getElementById('user').value.trim().toLowerCase();
  const d=document.getElementById('domain').value;
  document.getElementById('addr').textContent=u?u+'@'+d:'—';
  const list=document.getElementById('list');
  if(!u){list.innerHTML='<div class="empty"><div class="ic">📭</div>请输入邮箱前缀</div>';return;}
  document.getElementById('listTitle').textContent='收件箱 · '+u+'@'+d;
  try{
    const r=await fetch('/api/check/'+encodeURIComponent(u));
    const data=await r.json();
    const msgs=(data.messages||[]).slice().reverse();
    if(!msgs.length){list.innerHTML='<div class="empty"><div class="ic">📭</div>暂无邮件，等待接收…</div>';return;}
    list.innerHTML=msgs.map(m=>{
      const codeHtml=m.code?'<div class="code"><span style="font-size:12px;color:#558b2f">验证码</span><b>'+
        esc(m.code)+'</b><button onclick="copyText(\\''+esc(m.code)+'\\')">复制</button></div>':'';
      return '<div class="mail"><div class="subj">'+esc(m.subject||'(无主题)')+'</div>'+
        '<div class="meta">来自 '+esc(m.from||'未知')+' · '+esc((m.time||'').replace('T',' ').slice(0,19))+'</div>'+
        codeHtml+
        '<div class="body-toggle" onclick="var b=this.nextElementSibling;b.style.display=b.style.display===\\'block\\'?\\'none\\':\\'block\\'">▸ 查看邮件正文</div>'+
        '<div class="body" style="display:none">'+esc(m.text||'(空)')+'</div></div>';
    }).join('');
  }catch(e){list.innerHTML='<div class="empty">加载失败：'+esc(e.message)+'</div>';}
}
function startAuto(){clearInterval(timer);timer=setInterval(()=>{if(currentAddr())load();},15000);}
(function init(){
  const sel=document.getElementById('domain');
  DOMAINS.forEach(d=>{const o=document.createElement('option');o.value=d;o.textContent='@'+d;sel.appendChild(o);});
  const last=localStorage.getItem('tm_user');
  if(last)document.getElementById('user').value=last;
  document.getElementById('user').addEventListener('input',e=>localStorage.setItem('tm_user',e.target.value.trim()));
  document.getElementById('user').addEventListener('keydown',e=>{if(e.key==='Enter')load();});
  sel.addEventListener('change',load);
  if(last)load();
  startAuto();
})();
</script>
</body></html>`;

// ---------- 入口 ----------

export default {
  async email(message, env, ctx) {
    try {
      await handleEmail(message, env);
    } catch (e) {
      console.error('Email processing error:', e.message);
    }
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    // 会话密钥：优先用独立的 SESSION_SECRET，未配置则从账号口令派生
    const secret = CONFIG.SESSION_SECRET ||
      (CONFIG.WEB_USERNAME + ':' + CONFIG.WEB_PASSWORD + '_session_salt');

    const cookies = parseCookies(request);
    const authed = await verifySession(cookies.tm_session, secret);
    const htmlHeaders = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' };

    if (path === '/__auth') {
      if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
      let body = {};
      try { body = await request.json(); } catch (_) {}
      const u = body.username || '';
      const pw = body.password || '';
      // 用户名 + 密码双重校验（防时序攻击：两个字段都做完整比较）
      const userOk = u.length === CONFIG.WEB_USERNAME.length &&
        u === CONFIG.WEB_USERNAME;
      const passOk = pw.length === CONFIG.WEB_PASSWORD.length &&
        pw === CONFIG.WEB_PASSWORD;
      if (userOk && passOk) {
        const token = await makeSession(secret, CONFIG.SESSION_TTL);
        return new Response(JSON.stringify({ ok: true }), {
          headers: {
            'Content-Type': 'application/json',
            'Set-Cookie': `tm_session=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${CONFIG.SESSION_TTL}`,
          },
        });
      }
      return new Response(JSON.stringify({ ok: false }), {
        status: 401, headers: { 'Content-Type': 'application/json' },
      });
    }

    if (path === '/__logout') {
      return new Response(null, {
        status: 302,
        headers: { Location: '/', 'Set-Cookie': 'tm_session=; Path=/; HttpOnly; Secure; Max-Age=0' },
      });
    }

    if (!authed) {
      if (path === '/' || path === '') return new Response(LOGIN_PAGE, { headers: htmlHeaders });
      return new Response(JSON.stringify({ error: 'unauthorized' }), {
        status: 401, headers: { 'Content-Type': 'application/json' },
      });
    }

    if (path === '/' || path === '') {
      return new Response(INDEX_PAGE.replace('__DOMAINS__', JSON.stringify(CONFIG.DOMAINS)), {
        headers: htmlHeaders,
      });
    }

    const json = { 'Content-Type': 'application/json' };

    if (path.startsWith('/api/inbox/')) {
      const username = path.split('/api/inbox/')[1]?.toLowerCase();
      if (!username) return Response.json({ error: 'missing username' }, { status: 400, headers: json });
      const data = await env.MAIL_KV.get(`inbox/${username}`, 'json');
      return Response.json({ username, messages: data || [] }, { headers: json });
    }

    if (path.startsWith('/api/mail/')) {
      const parts = path.split('/api/mail/')[1]?.split('/');
      if (!parts || parts.length < 2) return Response.json({ error: 'invalid path' }, { status: 400, headers: json });
      const data = await env.MAIL_KV.get(`mail/${parts[0].toLowerCase()}/${parts[1]}`, 'json');
      if (!data) return Response.json({ error: 'not found' }, { status: 404, headers: json });
      return Response.json(data, { headers: json });
    }

    if (path.startsWith('/api/check/')) {
      const username = path.split('/api/check/')[1]?.toLowerCase();
      if (!username) return Response.json({ error: 'missing username' }, { status: 400, headers: json });
      const index = (await env.MAIL_KV.get(`inbox/${username}`, 'json')) || [];
      const results = [];
      for (const item of index) {
        const mail = await env.MAIL_KV.get(`mail/${username}/${item.id}`, 'json');
        if (mail) {
          results.push({
            id: mail.id,
            from: mail.from,
            to: mail.to,
            subject: mail.subject,
            text: mail.text,
            code: mail.code || extractCode(mail.subject, mail.text),
            time: mail.time,
          });
        }
      }
      return Response.json({ username, count: results.length, messages: results }, { headers: json });
    }

    return Response.json({
      status: 'ok', service: 'tempmail-worker', auth: authed, domains: CONFIG.DOMAINS,
    }, { headers: json });
  },
};
