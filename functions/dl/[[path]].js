// 云端媒体下载：/dl/music/xxx.mp3|mp4 → Worker /audio → R2
// 与 /media/ 的区别：强制浏览器「另存为」（Content-Disposition: attachment），仅后台登录可用
import { isAdmin } from '../api/_shared.js';

function extOf(key) {
  const m = /\.([a-z0-9]{1,5})$/i.exec(String(key || ''));
  return m ? '.' + m[1].toLowerCase() : '';
}

export async function onRequestGet({ request, env, params }) {
  if (!env.MEDIA_URL || !env.MEDIA_TOKEN) return new Response('云端媒体服务未配置', { status: 501 });
  if (!(await isAdmin(request, env))) return new Response('需要先登录后台', { status: 401 });

  const key = (params.path || []).join('/');
  if (key.indexOf('music/') !== 0) return new Response('Not Found', { status: 404 });

  const q = new URL(request.url).searchParams;
  let name = String(q.get('n') || '')
    .replace(/[\\/:*?"<>|\r\n\t]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  if (!name) name = key.split('/').pop();
  if (!/\.[a-z0-9]{1,5}$/i.test(name)) name += extOf(key);

  const upstream = await fetch(env.MEDIA_URL + '/audio?key=' + encodeURIComponent(key), {
    headers: { 'X-Media-Token': env.MEDIA_TOKEN }
  });
  if (!upstream.ok) return new Response('Not Found', { status: upstream.status });

  const ascii = (name.replace(/[^\x20-\x7e]/g, '_') || 'media').replace(/"/g, '');
  const out = new Headers();
  const ct = upstream.headers.get('content-type');
  if (ct) out.set('Content-Type', ct);
  const len = upstream.headers.get('content-length');
  if (len) out.set('Content-Length', len);
  out.set('Content-Disposition', 'attachment; filename="' + ascii + '"; filename*=UTF-8\'\'' + encodeURIComponent(name));
  out.set('Cache-Control', 'no-store');
  return new Response(upstream.body, { status: 200, headers: out });
}
