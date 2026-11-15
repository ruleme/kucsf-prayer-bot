import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { miniAppClient } from './telegram-mini-app.mjs';

const statuses = new Map([
  ['published', 'የጸሎት ጥያቄው በግል ቻናሉ ላይ ተጋርቷል።'],
  ['rejected', 'የጸሎት ጥያቄው ውድቅ ተደርጓል።'],
  ['resolved', 'የልጥፉ ማረጋገጫ ተዘግቷል።'],
  ['unavailable', 'ይህ ጥያቄ ከዚህ በፊት ተስተናግዷል ወይም ተሰርዟል።'],
  ['channel', 'የግል ቻናሉን ማረጋገጥ አልተቻለም። ቦቱ የመለጠፍ ፈቃድ እንዳለው ያረጋግጡ።'],
  ['retry', 'ቴሌግራም ልጥፉን አልተቀበለም። ጥያቄው አሁንም በመጠባበቅ ላይ ነው።'],
  ['unknown', 'ልጥፉ መጋራቱ አልተረጋገጠም። ማረጋገጫውን ከመዝጋትዎ በፊት ቻናሉን ይመልከቱ።'],
]);

function escapeHtml(text) {
  const characters = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return text.replace(/[&<>"']/g, character => characters[character]);
}

function render(requests, status, { prefix = '', nonce, prayerUrl } = {}) {
  const pending = requests.filter(request => request.state === 'pending');
  const uncertain = requests.filter(request => request.state === 'unknown');
  const cards = pending.map(({ id, body }) => `
    <article>
      <p class="prayer" lang="am">${escapeHtml(body)}</p>
      <form method="post" action="${prefix}/moderate/${id}">
        <button formaction="${prefix}/moderate/${id}/approve" class="primary">ይፍቀዱ እና ያጋሩ</button>
        <button formaction="${prefix}/moderate/${id}/reject">ውድቅ ያድርጉ</button>
      </form>
    </article>`).join('');
  const checks = uncertain.map(({ id }) => `
    <article><p>በግል ቻናሉ ላይ <code>#P${id}</code> ይፈልጉ።</p>
      <form method="post" action="${prefix}/moderate/${id}/resolve"><button>ማረጋገጫውን ይዝጉ</button></form>
    </article>`).join('');
  return `<!doctype html>
<html lang="am"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>የጸሎት ጥያቄዎች አስተዳደር</title>
${nonce ? '<script src="https://telegram.org/js/telegram-web-app.js?65"></script>' : ''}
<style>
  :root { color-scheme: light dark; font: 16px/1.55 system-ui, "Noto Sans Ethiopic", Nyala, sans-serif }
  body { margin: 0; background: light-dark(#f2f6f5,#101c1a); color: light-dark(#172d29,#e7f4ee) }
  main { max-width: 680px; margin: auto; padding: 32px 18px }
  header { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap }
  h1 { font-size: 1.5rem; margin: 0 }
  h2 { font-size: 1.05rem }
  article, .notice { background: light-dark(#fff,#1c302b); border: 1px solid light-dark(#cbdcd5,#3b554e); padding: 16px; border-radius: 12px; margin: 12px 0 }
  p { margin: 0 0 12px }
  .prayer { white-space: pre-wrap; overflow-wrap: anywhere }
  form { display: flex; flex-wrap: wrap; gap: 8px }
  button, a { font: inherit; color: inherit; border: 1px solid light-dark(#8ea9a0,#719188); border-radius: 8px; padding: 7px 12px; background: transparent; cursor: pointer; text-decoration: none }
  .primary { background: #146653; border-color: #146653; color: white }
</style>
<main>
  <header><h1>የጸሎት ጥያቄዎች አስተዳደር</h1><a data-refresh href="${prefix || '/'}">ያድሱ</a></header>
  ${prayerUrl ? `<p><a data-prayer href="${prayerUrl}">አዲስ የጸሎት ጥያቄ</a></p>` : ''}
  ${status ? `<p class="notice" role="status">${status}</p>` : ''}
  ${nonce ? '' : `<section><h2>በመጠባበቅ ላይ ያሉ ጥያቄዎች (${pending.length})</h2>
    ${cards ? '<p>ከመፍቀድዎ በፊት ስም ወይም ማንነትን የሚገልጽ ሌላ መረጃ እንዳልተካተተ ያረጋግጡ።</p>' + cards : '<p>በመጠባበቅ ላይ ያለ ጥያቄ የለም።</p>'}
  </section>
  ${checks ? `<section><h2>ያልተረጋገጡ ልጥፎች</h2>${checks}</section>` : ''}`}
</main>
${nonce ? '<p id="connection-status" class="notice" role="status">ከቴሌግራም ጋር በመገናኘት ላይ…</p>' : ''}
${nonce ? `<script nonce="${nonce}">${miniAppClient}</script>` : ''}
</html>`;
}

export async function startModeratorPanel({ listRequests, moderate, miniApp, botUsername }) {
  const port = Number(process.env.PANEL_PORT ?? '8787');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PANEL_PORT must be a valid port.');
  const host = `127.0.0.1:${port}`;
  const origin = `http://${host}`;
  const password = randomBytes(18).toString('base64url');
  const prayerUrl = /^[A-Za-z0-9_]+$/.test(botUsername ?? '')
    ? `https://t.me/${botUsername}?start=prayer` : undefined;
  const credential = Buffer.from('Basic ' + Buffer.from(`moderator:${password}`).toString('base64'));
  const server = createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
    const miniHost = miniApp && request.headers.host === miniApp.host;
    if (!miniHost && request.headers.host !== host) {
      response.writeHead(403).end();
      return;
    }
    try {
      if (miniHost) {
        const { pathname } = new URL(request.url, miniApp.origin);
        const htmlHeaders = { 'Content-Type': 'text/html; charset=utf-8' };
        const isLaunch = pathname === '/' || pathname === '/mini' || pathname === '/mini/';
        if (request.method === 'GET' && isLaunch) {
          const nonce = randomBytes(18).toString('base64url');
          response.setHeader('Content-Security-Policy',
            `default-src 'none'; script-src 'nonce-${nonce}' https://telegram.org; connect-src 'self'; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'; frame-ancestors 'self' https://web.telegram.org`);
          response.writeHead(200, htmlHeaders).end(render([], '', { prefix: '/mini', nonce, prayerUrl }));
          return;
        }
        const action = /^\/mini\/moderate\/([a-f0-9]{24})\/(approve|reject|resolve)$/.exec(pathname);
        const isQueue = request.method === 'GET' && pathname === '/mini/queue';
        const isAction = request.method === 'POST' && action;
        if (!isQueue && !isAction) {
          return response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
            .end('ገጹ አልተገኘም። ከቴሌግራም ውይይቱ «አስተባባሪ» የሚለውን እንደገና ይጫኑ።');
        }
        if (!miniApp.verify(request.headers.authorization)) return response.writeHead(401).end();
        if (isAction && request.headers.origin !== miniApp.origin) return response.writeHead(403).end();
        const status = isAction ? statuses.get(await moderate(action[2], action[1])) : '';
        response.writeHead(200, { ...htmlHeaders, 'X-Prayer-Panel': '1' })
          .end(render(listRequests(), status, { prefix: '/mini', prayerUrl }));
        return;
      }
      const authorization = Buffer.from(request.headers.authorization ?? '');
      if (authorization.length !== credential.length || !timingSafeEqual(authorization, credential)) {
        response.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Prayer moderator", charset="UTF-8"', 'Content-Type': 'text/plain; charset=utf-8' })
          .end('እንደ አስተባባሪ ይግቡ።');
        return;
      }
      const url = new URL(request.url, origin);
      if (request.method === 'GET' && url.pathname === '/') {
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
          .end(render(listRequests(), statuses.get(url.searchParams.get('status'))));
        return;
      }
      const action = /^\/moderate\/([a-f0-9]{24})\/(approve|reject|resolve)$/.exec(url.pathname);
      if (request.method === 'POST' && action) {
        if (request.headers.origin !== origin) {
          response.writeHead(403).end();
          return;
        }
        const status = await moderate(action[2], action[1]);
        response.writeHead(303, { Location: `/?status=${status}` }).end();
        return;
      }
      response.writeHead(404).end();
    } catch {
      response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }).end('ድርጊቱን ማጠናቀቅ አልተቻለም።');
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  console.log(`Moderator panel: ${origin}`);
  console.log(`Panel username: moderator\nPanel password: ${password}`);
  if (miniApp) console.log(`Telegram moderator panel: ${miniApp.url}`);
}
