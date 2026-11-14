// 云端媒体中心接口：GET 公开列表；POST/PATCH/DELETE 需后台会话
import { json, isAdmin, callMedia } from './_shared.js';

// 老数据没有 type 字段时按 key 后缀推断
function guessType(t) {
  const raw = String(t.type || '').split(';')[0].trim().toLowerCase();
  if (raw) return raw;
  const key = String(t.key || '').toLowerCase();
  if (/\.(mp4|m4v)$/.test(key)) return 'video/mp4';
  if (/\.webm$/.test(key)) return 'video/webm';
  if (/\.mov$/.test(key)) return 'video/quicktime';
  if (/\.ogv$/.test(key)) return 'video/ogg';
  if (/\.(m4a|aac)$/.test(key)) return 'audio/mp4';
  if (/\.wav$/.test(key)) return 'audio/wav';
  if (/\.ogg$/.test(key)) return 'audio/ogg';
  if (/\.flac$/.test(key)) return 'audio/flac';
  return 'audio/mpeg';
}

// 媒体直出开关：配置 MEDIA_PUBLIC_URL（R2 桶的自定义域名）后，前端直接读该域名，
// 不再经过 Pages Function + Worker；留空则回落到原来的 /media/ 代理链路。
function publicBase(env) {
  const raw = String((env && env.MEDIA_PUBLIC_URL) || '').trim().replace(/\/+$/, '');
  return /^https?:\/\/[^/]/i.test(raw) ? raw : '';
}

function publicTrack(t, env) {
  const type = guessType(t);
  const base = publicBase(env);
  return {
    id: t.id,
    name: t.name,
    key: t.key,
    duration: t.duration,
    size: t.size,
    type: type,
    video: /^video\//.test(type),
    createdAt: t.createdAt || 0,
    enabled: !!t.enabled,
    src: (base ? base + '/' + t.key : '/media/' + t.key)
  };
}

// 把云端用量与上限透出给后台（读响应头，不改列表 JSON 结构）
function usageHeaders(data, env) {
  const u = (data && data.usage) || {};
  return {
    'X-Media-Max-Upload-Bytes': String(Number(u.maxUploadBytes) || 0),
    'X-Media-Max-Storage-Bytes': String(Number(u.maxStorageBytes) || 0),
    'X-Media-Storage-Used-Bytes': String(Number(u.bytes) || 0),
    'X-Media-Direct': publicBase(env) ? '1' : '0'
  };
}

export async function onRequestGet({ request, env }) {
  try {
    const res = await callMedia(env, '/list');
    if (!res.ok) return json({ error: { message: '云端媒体服务不可用' } }, 502);
    const data = await res.json();
    const admin = await isAdmin(request, env);
    const tracks = (data.tracks || []).filter(t => admin || t.enabled).map(t => publicTrack(t, env));
    return json(tracks, 200, usageHeaders(data, env));
  } catch (e) {
    return json({ error: { message: e.message } }, 500);
  }
}

export async function onRequestPost({ request, env }) {
  if (!(await isAdmin(request, env))) return json({ error: { message: '需要先登录后台' } }, 401);
  try {
    if (!request.body) return json({ error: { message: '缺少媒体文件' } }, 400);

    const url = new URL(request.url);
    const name = String(url.searchParams.get('name') || '未命名').slice(0, 80);
    const duration = Number(url.searchParams.get('duration')) || 0;
    const type = String(url.searchParams.get('type') || request.headers.get('Content-Type') || '')
      .split(';')[0].trim().toLowerCase();

    // 原始二进制流式转发：不读入内存、不设体积上限（视频原样上传）
    const qs = '/upload?name=' + encodeURIComponent(name) +
      '&duration=' + (isFinite(duration) ? duration : 0) +
      '&type=' + encodeURIComponent(type);
    const res = await callMedia(env, qs, {
      method: 'POST',
      headers: { 'Content-Type': type || 'application/octet-stream' },
      body: request.body
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) return json({ error: { message: out.error || '上传失败' } }, res.status);
    const u = out.usage || {};
    return json({ ok: true, track: publicTrack(out.track, env) }, 200, {
      'X-Media-Max-Upload-Bytes': String(Number(u.maxUploadBytes) || 0),
      'X-Media-Max-Storage-Bytes': String(Number(u.maxStorageBytes) || 0),
      'X-Media-Storage-Used-Bytes': String(Number(u.bytes) || 0),
      'X-Media-Direct': publicBase(env) ? '1' : '0'
    });
  } catch (e) {
    return json({ error: { message: e.message } }, 500);
  }
}

export async function onRequestPatch({ request, env }) {
  if (!(await isAdmin(request, env))) return json({ error: { message: '需要先登录后台' } }, 401);
  try {
    const body = await request.json();
    const res = await callMedia(env, '/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tracks: body.tracks || [] })
    });
    const out = await res.json().catch(() => ({}));
    return json(out, res.status);
  } catch (e) {
    return json({ error: { message: e.message } }, 500);
  }
}

export async function onRequestDelete({ request, env }) {
  if (!(await isAdmin(request, env))) return json({ error: { message: '需要先登录后台' } }, 401);
  try {
    const url = new URL(request.url);
    const key = url.searchParams.get('key') || '';
    const res = await callMedia(env, '/delete?key=' + encodeURIComponent(key), { method: 'POST' });
    return json(await res.json().catch(() => ({})), res.status);
  } catch (e) {
    return json({ error: { message: e.message } }, 500);
  }
}
