/**
 * 课前推送 —— 由 GitHub Actions 每 5 分钟跑一次
 *
 * 读 scripts/plan.json（课表）、scripts/subscription.json（推送订阅）、
 * 环境变量 VAPID_PRIVATE_JWK（私钥，存在仓库 Secret 里）。
 * 判断有没有「10~25 分钟后要上的课」，有就发一条 Web Push。
 * 发过的记在 scripts/sent.json，同一节课当天只发一次。
 *
 * 不依赖任何 npm 包：加密和签名全用 Node 自带的 WebCrypto。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { webcrypto as crypto } from 'node:crypto';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const readJson = (f) => JSON.parse(fs.readFileSync(path.join(HERE, f), 'utf8'));

const LEAD_MAX = 25;   // 最多提前多少分钟（窗口上沿）
const LEAD_MIN = 10;   // 至少提前多少分钟（窗口下沿）
const TZ = 8 * 3600 * 1000;

const enc = new TextEncoder();
const b64u = (b) => Buffer.from(b).toString('base64url');

function b64uDec(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return new Uint8Array(Buffer.from(s, 'base64'));
}

const concat = (...arrs) => {
  const out = new Uint8Array(arrs.reduce((n, a) => n + a.length, 0));
  let p = 0;
  for (const a of arrs) { out.set(a, p); p += a.length; }
  return out;
};

async function hkdf(salt, ikm, info, len) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info }, key, len * 8);
  return new Uint8Array(bits);
}

/* ---------- 课表 ---------- */
const toMin = (t) => {
  const p = String(t || '0:0').split(':');
  return (parseInt(p[0], 10) || 0) * 60 + (parseInt(p[1], 10) || 0);
};

function parseWeeks(s) {
  const out = [];
  String(s == null ? '' : s).split(/[,，、]/).forEach((part) => {
    part = part.trim();
    const m = part.match(/^(\d+)\s*[-–—~]\s*(\d+)$/);
    if (m) { for (let i = +m[1]; i <= +m[2]; i++) if (!out.includes(i)) out.push(i); }
    else { const n = parseInt(part, 10); if (n > 0 && !out.includes(n)) out.push(n); }
  });
  return out;
}

function weekNumber(iso, sh) {
  const p = String(iso || '').split('-');
  const a = Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
  const b = Date.UTC(sh.getUTCFullYear(), sh.getUTCMonth(), sh.getUTCDate());
  return Math.floor((b - a) / 86400000 / 7) + 1;
}

const ymd = (d) => d.getUTCFullYear() + '-' +
  String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0');

/* ---------- Web Push ---------- */
async function vapidJwt(endpoint, privJwk, subject) {
  const header = { typ: 'JWT', alg: 'ES256' };
  const payload = {
    aud: new URL(endpoint).origin,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: subject
  };
  const h = b64u(enc.encode(JSON.stringify(header)));
  const p = b64u(enc.encode(JSON.stringify(payload)));
  const key = await crypto.subtle.importKey(
    'jwk', privJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(`${h}.${p}`));
  return `${h}.${p}.${b64u(sig)}`;
}

async function encryptPayload(plaintext, uaRaw, authSecret) {
  const uaPub = await crypto.subtle.importKey('raw', uaRaw, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const asKeys = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asRaw = new Uint8Array(await crypto.subtle.exportKey('raw', asKeys.publicKey));
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'ECDH', public: uaPub }, asKeys.privateKey, 256));

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const info1 = concat(enc.encode('WebPush: info'), new Uint8Array([0]), uaRaw, asRaw);
  const ikm = await hkdf(authSecret, ecdh, info1, 32);
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce'), 12);

  const body = concat(enc.encode(plaintext), new Uint8Array([2]));
  const k = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, k, body));

  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, 4096);
  return concat(salt, rs, new Uint8Array([asRaw.length]), asRaw, ct);
}

async function sendPush(sub, payload, vapid) {
  const jwt = await vapidJwt(sub.endpoint, vapid.privateJwk, vapid.subject);
  const body = await encryptPayload(JSON.stringify(payload), b64uDec(sub.keys.p256dh), b64uDec(sub.keys.auth));
  const res = await fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Encoding': 'aes128gcm',
      TTL: '3600',
      Urgency: 'high',
      Authorization: `vapid t=${jwt}, k=${vapid.publicKey}`
    },
    body
  });
  let text = '';
  try { text = (await res.text()).slice(0, 200); } catch (e) {}
  return { ok: res.ok, status: res.status, gone: res.status === 404 || res.status === 410, text };
}

/* ---------- 主流程 ---------- */
const now = Date.now();
const sh = new Date(now + TZ);
const dayIdx = (sh.getUTCDay() + 6) % 7;          // 0 = 周一
const nowMin = sh.getUTCHours() * 60 + sh.getUTCMinutes();
const today = ymd(sh);

const plan = readJson('plan.json');
const vapidPub = readJson('vapid.json');
const sub = readJson('subscription.json');

const vapid = {
  publicKey: vapidPub.publicKey,
  subject: vapidPub.subject,
  privateJwk: JSON.parse(process.env.VAPID_PRIVATE_JWK || '{}')
};

let sent = {};
try { sent = readJson('sent.json'); } catch (e) { sent = {}; }

if (!sub || !sub.endpoint || !sub.keys || !sub.keys.p256dh) {
  console.log('scripts/subscription.json 还没填，什么都不做');
  process.exit(0);
}
if (!vapid.privateJwk || !vapid.privateJwk.d) {
  console.log('仓库 Secret VAPID_PRIVATE_JWK 还没设，什么都不做');
  process.exit(0);
}

const wk = weekNumber(plan.startDate, sh);
console.log(`北京 ${today} ${String(sh.getUTCHours()).padStart(2, '0')}:${String(sh.getUTCMinutes()).padStart(2, '0')} 周${'一二三四五六日'[dayIdx]} 第${wk}周`);

const fresh = {};
for (const k of Object.keys(sent)) if (k.startsWith(today)) fresh[k] = sent[k];
sent = fresh;

let changed = false;
const due = [];

if (wk >= 1) {
  for (const c of plan.courses) {
    if (c.day !== dayIdx) continue;
    if (!parseWeeks(c.weeks).includes(wk)) continue;
    const t = plan.times[c.slot] || ['', ''];
    const diff = toMin(t[0]) - nowMin;
    if (diff < LEAD_MIN || diff > LEAD_MAX) continue;
    const key = `${today}|${c.slot}|${c.name}`;
    if (sent[key]) continue;
    due.push({ c, t, diff, key });
  }
}

if (!due.length) {
  console.log('窗口内没有要上的课');
} else {
  for (const d of due) {
    const label = d.c.short || d.c.name;
    const payload = {
      title: `大肥鱼：${label}要上课啦`,
      body: `${d.t[0]} 在 ${d.c.room || '教室'}` +
            (d.c.campus ? `（${d.c.campus}）` : '') +
            `，还有 ${d.diff} 分钟`,
      tag: `class-${d.c.slot}-${today}`,
      url: './#today'
    };
    const r = await sendPush(sub, payload, vapid);
    console.log(`  ${label} ${d.t[0]} 还有${d.diff}分钟 -> ${r.status} ${r.ok ? 'OK' : 'FAIL ' + r.text}`);
    if (r.ok || r.gone) { sent[d.key] = Date.now(); changed = true; }
  }
}

fs.writeFileSync(path.join(HERE, 'sent.json'), JSON.stringify(sent, null, 2));
console.log(changed ? 'sent.json 已更新' : 'sent.json 无变化');
