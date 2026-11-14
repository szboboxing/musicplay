// MusicPlay · 网络电视 HLS 代理
// 用法：/tv/s?u=<encodeURIComponent(源地址)>&r=<encodeURIComponent(Referer，可选)>
// 作用：把 http 源、需要 Referer 的源、跨域源统一转成同源 https 地址交给 hls.js 播放
//       m3u8 里的分片/子播放列表地址会被递归改写为同样走本代理

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

function proxify(abs, ref) {
  return '/tv/s?u=' + encodeURIComponent(abs) + (ref ? '&r=' + encodeURIComponent(ref) : '');
}

function cors(status, msg) {
  // 统一用 4xx 返回错误：Cloudflare 会把 Functions 的 5xx 响应体替换成通用错误页，不利于排查
  return new Response(msg, {
    status: status,
    headers: { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' }
  });
}

export async function onRequestGet({ request }) {
  const q = new URL(request.url).searchParams;
  const raw = q.get('u');
  if (!raw) return cors(400, 'missing u');

  let target;
  try { target = new URL(raw); } catch (e) { return cors(400, 'bad u'); }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') return cors(400, 'bad scheme');

  const refQ = q.get('r');
  const headers = {
    'User-Agent': UA,
    'Accept': '*/*',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
  };
  // 只有显式给了 r 才补 Referer/Origin：部分 CDN 收到陌生 Origin 会直接返回空播放列表
  if (refQ) {
    let o = target.origin;
    try { o = new URL(refQ).origin; } catch (e) {}
    headers['Referer'] = refQ;
    headers['Origin'] = o;
  }
  const ref = refQ || '';
  const range = request.headers.get('Range');
  if (range) headers['Range'] = range;

  let resp;
  try {
    resp = await fetch(target.href, { headers: headers, redirect: 'follow' });
  } catch (e) {
    return cors(404, 'ERR:fetch ' + (e && e.message ? e.message : String(e)));
  }
  if (!resp.ok) return cors(404, 'ERR:upstream ' + resp.status);

  const ctype = (resp.headers.get('content-type') || '').toLowerCase();
  const base = resp.url || target.href;
  let isPlaylist = /mpegurl|mpeg-url|vnd\.apple/.test(ctype) ||
    /\.m3u8(\?|$)/i.test(target.pathname + target.search) ||
    /\.m3u8(\?|$)/i.test(base);

  // 有些源（如 cdn6.cc.cd/163189/fct）没有 .m3u8 后缀、Content-Type 还是 text/plain，
  // 只能看正文开头是不是 #EXTM3U。所以在可疑的类型下先取 body 做嗅探。
  const sniffable = !isPlaylist && (/^text\//.test(ctype) || !ctype || /octet-stream/.test(ctype));
  let buf = null;
  if (sniffable) {
    buf = new Uint8Array(await resp.arrayBuffer());
    if (buf.length >= 7) {
      const head = String.fromCharCode(buf[0], buf[1], buf[2], buf[3], buf[4], buf[5], buf[6]);
      if (head === '#EXTM3U') isPlaylist = true;
    }
  }

  if (!isPlaylist) {
    const out = new Headers({
      'Content-Type': ctype || 'video/mp2t',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=10'
    });
    // 已经缓冲过的 body 长度以实际字节为准：上游可能带 Content-Encoding，
    // Workers 的 fetch 会自动解压，但 Content-Length 仍是压缩前的值，直接透传会把分片截断
    const enc = resp.headers.get('content-encoding');
    const len = resp.headers.get('content-length');
    if (buf) out.set('Content-Length', String(buf.length));
    else if (len && !enc) out.set('Content-Length', len);
    const cr = resp.headers.get('content-range');
    if (cr) out.set('Content-Range', cr);
    return new Response(buf ? buf : resp.body, { status: resp.status, headers: out });
  }

  const text = buf ? new TextDecoder('utf-8').decode(buf) : await resp.text();
  const lines = text.split(/\r?\n/);
  const outLines = [];
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t) { outLines.push(''); continue; }
    if (t.charAt(0) === '#') {
      outLines.push(t.replace(/URI="([^"]+)"/g, function (m, u) {
        try { return 'URI="' + proxify(new URL(u, base).href, ref) + '"'; } catch (e) { return m; }
      }));
      continue;
    }
    try { outLines.push(proxify(new URL(t, base).href, ref)); }
    catch (e) { outLines.push(t); }
  }
  return new Response(outLines.join('\n'), {
    status: 200,
    headers: {
      'Content-Type': 'application/vnd.apple.mpegurl',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store'
    }
  });
}
