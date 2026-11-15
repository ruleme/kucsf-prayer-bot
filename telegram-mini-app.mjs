import { createHmac, timingSafeEqual } from 'node:crypto';

export function configureMiniApp(url, ids, botToken) {
  if (!url) return undefined;
  const origin = new URL(url);
  const moderators = new Set((ids ?? '').split(',').map(id => id.trim()).filter(Boolean));
  if (origin.protocol !== 'https:' || origin.username || origin.password ||
      origin.pathname !== '/' || origin.search || origin.hash ||
      !moderators.size || [...moderators].some(id => !/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id)))) {
    throw new Error('Set MINI_APP_ORIGIN to an HTTPS origin and MODERATOR_IDS to Telegram user IDs.');
  }
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  return {
    origin: origin.origin,
    host: origin.host,
    url: new URL('/mini', origin).href,
    moderatorIds: [...moderators],
    isModerator: id => moderators.has(String(id)),
    verify(authorization) {
      if (!authorization?.startsWith('tma ') || authorization.length > 8192) return false;
      const fields = new URLSearchParams(authorization.slice(4));
      const hash = fields.get('hash');
      if (!/^[0-9a-f]{64}$/i.test(hash ?? '') || new Set(fields.keys()).size !== fields.size) return false;
      fields.delete('hash');
      fields.sort();
      const check = [...fields].map(([key, value]) => `${key}=${value}`).join('\n');
      const expected = createHmac('sha256', secret).update(check).digest();
      if (!timingSafeEqual(expected, Buffer.from(hash, 'hex'))) return false;

      const issued = Number(fields.get('auth_date'));
      const age = Math.floor(Date.now() / 1000) - issued;
      if (!Number.isSafeInteger(issued) || age < -30 || age > 900) return false;
      try {
        const user = JSON.parse(fields.get('user'));
        return Number.isSafeInteger(user?.id) && moderators.has(String(user.id));
      } catch {
        return false;
      }
    },
  };
}

export const miniAppClient = `
const telegram = globalThis.Telegram?.WebApp;
const panel = document.querySelector('main');
const status = document.querySelector('#connection-status');
const initData = telegram?.initData;
const headers = { Authorization: 'tma ' + initData };
if (/\\.ngrok-free\\.(dev|app)$/.test(location.hostname)) {
  headers['ngrok-skip-browser-warning'] = '1';
}
telegram?.ready();

let busy = false;
async function load(path = '/mini/queue', method = 'GET') {
  if (busy) return;
  busy = true;
  panel.querySelectorAll('button').forEach(button => button.disabled = true);
  status.textContent = 'በመጫን ላይ…';
  try {
    const response = await fetch(path, {
      method,
      credentials: 'omit',
      headers,
      redirect: 'error',
    });
    if (response.status === 401) {
      panel.querySelectorAll('section, form, .notice').forEach(element => element.remove());
      status.textContent = 'ገጹን መክፈት አልተቻለም። ፈቃድ ካለው የቴሌግራም መለያ ገጹን እንደገና ይክፈቱ።';
      return;
    }
    const tunnelError = response.headers.get('ngrok-error-code');
    if (tunnelError) {
      status.textContent = 'የngrok ግንኙነት ችግር (' + tunnelError + ')። ngrok እና ቦቱ እየሠሩ መሆናቸውን ያረጋግጡ።';
      return;
    }
    if (!response.ok || response.headers.get('X-Prayer-Panel') !== '1') {
      throw new Error('The moderation server did not return the queue');
    }
    const page = new DOMParser().parseFromString(await response.text(), 'text/html');
    panel.replaceChildren(...page.querySelector('main').childNodes);
    status.textContent = '';
  } catch {
    status.textContent = method === 'GET'
      ? 'የጥያቄዎቹን ዝርዝር መጫን አልተቻለም። ngrok እና ቦቱ እየሠሩ መሆናቸውን አረጋግጠው «ያድሱ» የሚለውን ይጫኑ።'
      : 'ድርጊቱ መጠናቀቁን ማረጋገጥ አልተቻለም። እንደገና ከመሞከርዎ በፊት ዝርዝሩን ያድሱ።';
  } finally {
    busy = false;
    panel.querySelectorAll('button').forEach(button => button.disabled = false);
  }
}

if (initData) {
  panel.addEventListener('submit', event => {
    event.preventDefault();
    const path = (event.submitter || event.target).getAttribute('formaction') ||
      event.target.getAttribute('action');
    if (path?.startsWith('/mini/moderate/')) load(path, 'POST');
  });
  panel.addEventListener('click', event => {
    const prayer = event.target.closest('[data-prayer]');
    if (prayer && telegram.openTelegramLink) {
      event.preventDefault();
      telegram.openTelegramLink(prayer.href);
      telegram.close();
      return;
    }
    if (!event.target.closest('[data-refresh]')) return;
    event.preventDefault();
    load();
  });
  load();
} else {
  status.textContent = 'ገጹን ከቴሌግራም ቦቱ ውይይት ይክፈቱ።';
}
`;
