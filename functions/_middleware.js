// MusicPlay · Pages Functions 中间件：只保护后台页面（站点本身公开访问）
const COOKIE_NAME = 'mp_admin';
const SESSION_TTL = 8 * 60 * 60;
const enc = new TextEncoder();

function b64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function sign(secret, msg) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(msg));
  return b64url(new Uint8Array(sig));
}
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
function readCookie(req, name) {
  const raw = req.headers.get('Cookie') || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return '';
}
async function sessionValid(req, env) {
  const tok = readCookie(req, COOKIE_NAME);
  if (!tok || !env.SESSION_SECRET) return false;
  const dot = tok.lastIndexOf('.');
  if (dot <= 0) return false;
  const exp = tok.slice(0, dot);
  const sig = tok.slice(dot + 1);
  const expNum = Number(exp);
  if (!expNum || expNum < Math.floor(Date.now() / 1000)) return false;
  return safeEqual(sig, await sign(env.SESSION_SECRET, exp));
}

/* 简易内存限流：登录失败防护 */
const attempts = new Map();
function tooMany(key, max, windowMs) {
  const now = Date.now();
  let b = attempts.get(key);
  if (!b || now - b.start > windowMs) { b = { start: now, n: 0 }; attempts.set(key, b); }
  b.n += 1;
  if (attempts.size > 4000) { for (const [k, v] of attempts) { if (now - v.start > windowMs) attempts.delete(k); } }
  return b.n > max;
}

function jsonBody(obj, status, headers) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, headers || {})
  });
}

function loginPage(message) {
  return new Response(`<!DOCTYPE html>
<html lang="zh-CN" data-theme="light">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#EFF7F1">
<title>后台登录 · MusicPlay</title>
<link rel="stylesheet" href="assets/theme.css">
<link rel="stylesheet" href="assets/app.css">
<style>
  body{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
  .login-card{max-width:400px;width:100%;padding:30px}
  .login-card h1{font-size:24px;margin:6px 0 8px}
  .login-card input{width:100%;min-height:54px;border-radius:14px;border:1px solid var(--line);
    background:var(--panel-2);color:var(--text);padding:0 16px;font-size:16px;margin:10px 0 16px;font-family:inherit}
  .login-err{color:var(--accent);font-size:13px;min-height:20px;margin:12px 0 0}
</style>
</head>
<body>
<div class="card login-card">
  <p class="eyebrow">MusicPlay · Admin</p>
  <h1>后台登录</h1>
  <p class="sub">输入管理密码，管理云端曲库（站点首页公开访问）</p>
  <input id="pw" type="password" autocomplete="current-password" placeholder="请输入管理密码">
  <button id="go" class="btn primary block" type="button">进入后台</button>
  <p class="login-err" id="err">${message || ''}</p>
  <p class="hint" style="margin-top:14px"><a href="index.html">← 返回首页</a></p>
</div>
<script>
(function(){
  var pw = document.getElementById('pw'), err = document.getElementById('err'), btn = document.getElementById('go');
  function submit(){
    var v = pw.value.trim();
    if (!v) { err.textContent = '请输入密码'; return; }
    btn.disabled = true; err.textContent = '';
    fetch('/admin/login', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({password:v})})
      .then(function(r){
        if (r.ok) { location.href = '/admin.html'; return null; }
        return r.json().then(function(j){ err.textContent = (j && j.error && j.error.message) || '密码错误'; })
          .catch(function(){ err.textContent = '密码错误'; });
      })
      .catch(function(){ err.textContent = '网络异常，请重试'; })
      .then(function(){ btn.disabled = false; });
  }
  btn.addEventListener('click', submit);
  pw.addEventListener('keydown', function(e){ if (e.key === 'Enter') submit(); });
  pw.focus();
})();
</script>
</body>
</html>`, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' }
  });
}

async function handleLogin(request, env) {
  if (!env.ADMIN_PASSWORD || !env.SESSION_SECRET) return jsonBody({ error: { message: '服务端未配置密码' } }, 500);

  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  if (tooMany('login:' + ip, 10, 10 * 60 * 1000)) {
    return jsonBody({ error: { message: '尝试次数过多，请 10 分钟后再试' } }, 429);
  }

  let password = '';
  const ct = request.headers.get('Content-Type') || '';
  try {
    if (ct.includes('application/json')) {
      const b = await request.json();
      password = String((b && b.password) || '');
    } else {
      const fd = await request.formData();
      password = String(fd.get('password') || '');
    }
  } catch (e) {
    return jsonBody({ error: { message: '请求格式错误' } }, 400);
  }

  const expected = String(env.ADMIN_PASSWORD || '').trim();
  if (!safeEqual(password.trim(), expected)) {
    return jsonBody({ error: { message: '密码错误' } }, 401);
  }

  const exp = String(Math.floor(Date.now() / 1000) + SESSION_TTL);
  const token = exp + '.' + await sign(env.SESSION_SECRET, exp);
  return jsonBody({ ok: true }, 200, {
    'Set-Cookie': `${COOKIE_NAME}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_TTL}`
  });
}

function handleLogout() {
  return new Response(null, {
    status: 302,
    headers: {
      'Location': 'https://cloudmusic.chinacn.eu.org/',
      'Set-Cookie': `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`,
      'Cache-Control': 'no-store'
    }
  });
}

export async function onRequest(context) {
  const { request, env, next } = context;
  const url = new URL(request.url);
  const path = url.pathname;

  if (path === '/admin/login' && request.method === 'POST') return handleLogin(request, env);
  if (path === '/admin/logout') return handleLogout();

  const isAdmin = path === '/admin' || path === '/admin/' || path === '/admin.html';
  if (isAdmin && !(await sessionValid(request, env))) {
    return loginPage('');
  }
  return next();
}
