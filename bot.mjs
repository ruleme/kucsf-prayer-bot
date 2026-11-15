import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { startModeratorPanel } from './moderator.mjs';
import { configureMiniApp } from './telegram-mini-app.mjs';

const { BOT_TOKEN, CHANNEL_ID, DATA_KEY } = process.env;
if (!/^\d+:[A-Za-z0-9_-]+$/.test(BOT_TOKEN ?? '') ||
    !/^-100\d+$/.test(CHANNEL_ID ?? '') ||
    !/^[a-f0-9]{64}$/i.test(DATA_KEY ?? '')) {
  throw new Error('Configure BOT_TOKEN, CHANNEL_ID and a 64-digit hex DATA_KEY.');
}

const key = Buffer.from(DATA_KEY, 'hex');
const miniApp = configureMiniApp(process.env.MINI_APP_ORIGIN, process.env.MODERATOR_IDS, BOT_TOKEN);
const botId = BOT_TOKEN.split(':', 1)[0];
const database = new DatabaseSync(process.env.DB_PATH || 'prayer.sqlite');
database.exec(`
  PRAGMA secure_delete = ON;
  CREATE TABLE IF NOT EXISTS requests (
    id TEXT PRIMARY KEY,
    owner TEXT,
    body TEXT,
    state TEXT NOT NULL,
    created INTEGER NOT NULL,
    channel_message INTEGER
  );
  CREATE TABLE IF NOT EXISTS moderator_menus (
    bot_id TEXT NOT NULL,
    chat_id INTEGER NOT NULL,
    PRIMARY KEY (bot_id, chat_id)
  );
  UPDATE requests SET state = 'unknown', owner = NULL, body = NULL WHERE state = 'sending';
`);
const drafts = new Map();
const minute = 60_000;
const day = 1_440 * minute;
const query = sql => database.prepare(sql);
const buttons = (...rows) => ({ inline_keyboard: rows });
const button = (text, callback_data) => ({ text, callback_data });
const home = buttons([button('አዲስ የጸሎት ጥያቄ', 'new')]);
const moderatorButton = miniApp && {
  text: 'የአስተባባሪ ገጹን ክፈት',
  web_app: { url: miniApp.url },
};
const installedMenus = new Set();

function seal(text) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64');
}

function unseal(text) {
  const data = Buffer.from(text, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12));
  decipher.setAuthTag(data.subarray(12, 28));
  return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString('utf8');
}

async function api(method, payload, timeout = 10_000) {
  let response;
  let result;
  try {
    response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeout),
    });
    result = await response.json();
  } catch {
    throw new Error(`${method}: connection or response failed`);
  }
  if (!response.ok || !result.ok) {
    const error = new Error(`${method}: Telegram error ${result.error_code ?? response.status}`);
    error.definite = [400, 401, 403, 429].includes(result.error_code);
    throw error;
  }
  return result.result;
}

function send(chat_id, text, reply_markup) {
  return api('sendMessage', {
    chat_id, text, reply_markup,
    protect_content: true,
    link_preview_options: { is_disabled: true },
  });
}

async function installModeratorMenu(chat) {
  if (installedMenus.has(chat)) return;
  query('INSERT OR IGNORE INTO moderator_menus (bot_id, chat_id) VALUES (?, ?)').run(botId, chat);
  try {
    await api('setChatMenuButton', {
      chat_id: chat,
      menu_button: { type: 'web_app', text: 'አስተባባሪ', web_app: moderatorButton.web_app },
    });
    installedMenus.add(chat);
  } catch (error) {
    console.warn(`Moderator chat menu unavailable: ${error.message}. The welcome button remains available.`);
  }
}

async function syncModeratorMenus() {
  const previous = query('SELECT chat_id FROM moderator_menus WHERE bot_id = ?').all(botId);
  for (const { chat_id } of previous) {
    if (miniApp?.isModerator(chat_id)) continue;
    try {
      await api('setChatMenuButton', { chat_id, menu_button: { type: 'default' } });
      query('DELETE FROM moderator_menus WHERE bot_id = ? AND chat_id = ?').run(botId, chat_id);
    } catch (error) {
      console.warn(`Could not reset an old moderator chat menu: ${error.message}`);
    }
  }
  for (const id of miniApp?.moderatorIds ?? []) await installModeratorMenu(Number(id));
}

async function checkChannel() {
  const [chat, bot] = await Promise.all([
    api('getChat', { chat_id: CHANNEL_ID }),
    api('getMe', {}),
  ]);
  if (chat.type !== 'channel' || chat.username || chat.active_usernames?.length || chat.linked_chat_id) {
    throw new Error('The destination must be a private channel with no linked discussion.');
  }
  const member = await api('getChatMember', { chat_id: CHANNEL_ID, user_id: bot.id });
  if (member.status !== 'administrator' || !member.can_post_messages) {
    throw new Error('The bot needs permission to post in the channel.');
  }
  return bot;
}

function prune() {
  const now = Date.now();
  for (const [owner, draft] of drafts) {
    if (draft.expires < now) drafts.delete(owner);
  }
  query("UPDATE requests SET state = 'expired', body = NULL WHERE state = 'pending' AND created < ?")
    .run(now - 7 * day);
  query("UPDATE requests SET owner = NULL WHERE state != 'pending' AND created < ?").run(now - day);
  query("DELETE FROM requests WHERE created < ? AND state IN ('expired','rejected','withdrawn')")
    .run(now - 7 * day);
}

function startDraft(chat, owner) {
  if (drafts.size >= 200 && !drafts.has(owner)) return send(chat, 'እባክዎ ቆይተው ይሞክሩ።');
  const draft = drafts.get(owner);
  drafts.set(owner, { ...draft, expires: Date.now() + 30 * minute });
  return send(chat, 'ጥያቄዎን እስከ 1,000 ቁምፊ በአንድ መልዕክት ይጻፉ።',
    buttons([button('ረቂቁን ይሰርዙ', 'cancel')]));
}

async function handle(update) {
  const callback = update.callback_query;
  const message = callback?.message ?? update.message;
  const sender = callback?.from ?? message?.from;
  if (message?.chat.type !== 'private' || !sender || sender.is_bot ||
      message.chat.id !== sender.id) return;

  const chat = message.chat.id;
  const owner = createHmac('sha256', key).update(`owner:${sender.id}`).digest('hex');
  const canModerate = miniApp?.isModerator(sender.id);
  const draft = drafts.get(owner);
  if (callback) {
    await api('answerCallbackQuery', { callback_query_id: callback.id }).catch(() => {});
    const [action, id] = (callback.data ?? '').split(':');
    if (action === 'new') {
      return startDraft(chat, owner);
    }
    if (action === 'cancel') {
      drafts.delete(owner);
      return send(chat, 'ረቂቁ ተሰርዟል።', home);
    }
    if (action === 'submit') {
      if (query('SELECT id FROM requests WHERE id = ? AND owner = ?').get(id ?? '', owner)) {
        return send(chat, 'ጥያቄዎ ከዚህ በፊት ተልኳል።',
          buttons([button('ጥያቄውን ይሰርዙ', `withdraw:${id}`)]));
      }
      if (!draft?.body || draft.id !== id) return send(chat, 'እባክዎ አዲስ ጥያቄ ይጀምሩ።', home);
      const recent = query('SELECT count(*) AS n FROM requests WHERE owner = ? AND created >= ?')
        .get(owner, Date.now() - day).n;
      const dailyLimit = canModerate ? 10 : 3;
      if (recent >= dailyLimit) {
        return send(chat, `ባለፉት 24 ሰዓታት ውስጥ ${dailyLimit} ጥያቄዎችን ልከዋል። የቀን ገደቡ እስኪነሳ ይጠብቁ።`);
      }
      const pending = query("SELECT count(*) AS n FROM requests WHERE state IN ('pending','unknown')").get().n;
      if (pending >= 100) {
        return send(chat, 'የሚጠባበቁ ጥያቄዎች ቦታ ሞልቷል። እባክዎ ቆይተው ይሞክሩ።');
      }
      query("INSERT INTO requests (id, owner, body, state, created) VALUES (?, ?, ?, 'pending', ?)")
        .run(id, owner, seal(draft.body), Date.now());
      drafts.delete(owner);
      return send(chat, 'የጸሎት ርዕሶ ተልኳል',
        buttons([button('ጥያቄውን ይሰርዙ', `withdraw:${id}`)]));
    }
    if (action === 'withdraw') {
      const result = query("UPDATE requests SET state = 'withdrawn', body = NULL WHERE id = ? AND owner = ? AND state = 'pending'")
        .run(id ?? '', owner);
      return send(chat, result.changes ? 'ጥያቄው ተሰርዟል።' : 'ይህን ጥያቄ ከዚህ መሰረዝ አይቻልም።', home);
    }
    return;
  }

  const body = message.text?.trim();
  const [commandText, startParam] = body?.split(/\s+/u, 2) ?? [];
  const command = commandText?.split('@', 1)[0];
  if (command === '/prayer' || (command === '/start' && startParam === 'prayer')) {
    return startDraft(chat, owner);
  }
  if (canModerate && (command === '/start' || command === '/moderator')) {
    await installModeratorMenu(chat);
  }
  if (command === '/moderator' && canModerate) {
    return send(chat, 'የአስተባባሪ ገጽ', buttons([moderatorButton]));
  }
  if (command === '/start' || command === '/privacy') {
    const keyboard = command === '/start' && canModerate
      ? buttons(...home.inline_keyboard, [moderatorButton])
      : home;
    return send(chat, 'እንኳን ወደ ጸሎት ጥያቄ መላኪያ በደህና መጡ።\n\nአስተባባሪዎች ጥያቄዎን ያነባሉ። ከተፈቀደ፣ የቴሌግራም መለያዎን ሳያሳይ በግል ቻናል ላይ ይጋራል። ቴሌግራም እና ቦቱ የመለያ መረጃ ይቀበላሉ። እባክዎ ስም፣ ስልክ ቁጥር ወይም አድራሻ አያካትቱ። ይህ የሙከራ ቦት ነው። ለሙከራ የተዘጋጀ መልዕክት ብቻ ይላኩ።', keyboard);
  }
  if (command === '/cancel') {
    drafts.delete(owner);
    return send(chat, 'ረቂቁ ተሰርዟል።', home);
  }
  if (!draft) return send(chat, 'አዲስ ጥያቄ ለመጻፍ ከታች ያለውን ቁልፍ ይጫኑ።', home);
  if (!body || body.startsWith('/') || body.length > 1000 || message.forward_origin ||
      message.entities?.some(entity => ['url', 'text_link', 'mention', 'email', 'phone_number'].includes(entity.type))) {
    return send(chat, 'እስከ 1,000 ቁምፊ የሆነ ጽሑፍ ብቻ ይላኩ። አገናኝ ወይም የመገናኛ መረጃ አያካትቱ።');
  }
  const id = randomBytes(12).toString('hex');
  drafts.set(owner, { id, body, expires: Date.now() + 30 * minute });
  return send(chat, `ጥያቄዎን ይመልከቱ። ለማስተካከል አዲሱን ጽሑፍ ይላኩ።\n\n${body}`,
    buttons([button('ይላኩ', `submit:${id}`), button('ረቂቁን ይሰርዙ', 'cancel')]));
}

function listRequests() {
  const rows = query("SELECT id, body, state FROM requests WHERE state IN ('pending','unknown') ORDER BY created").all();
  return rows.map(({ id, body, state }) => ({ id, body: body ? unseal(body) : '', state }));
}

async function moderate(action, id) {
  prune();
  if (action === 'resolve') {
    return query("UPDATE requests SET state = 'reconciled' WHERE id = ? AND state = 'unknown'").run(id).changes
      ? 'resolved' : 'unavailable';
  }
  if (action === 'reject') {
    return query("UPDATE requests SET state = 'rejected', body = NULL WHERE id = ? AND state = 'pending'").run(id).changes
      ? 'rejected' : 'unavailable';
  }
  try {
    await checkChannel();
  } catch {
    return 'channel';
  }
  const request = query("SELECT body FROM requests WHERE id = ? AND state = 'pending'").get(id);
  if (!request) return 'unavailable';
  const approved = unseal(request.body);
  const claimed = query("UPDATE requests SET state = 'sending' WHERE id = ? AND state = 'pending'").run(id);
  if (!claimed.changes) return 'unavailable';
  let post;
  try {
    post = await send(CHANNEL_ID, `የጸሎት ጥያቄ\n\n${approved}\n\n#P${id}`);
  } catch (error) {
    if (error.definite) {
      query("UPDATE requests SET state = 'pending' WHERE id = ?").run(id);
      return 'retry';
    }
    query("UPDATE requests SET state = 'unknown', owner = NULL, body = NULL WHERE id = ?").run(id);
    return 'unknown';
  }
  query("UPDATE requests SET state = 'published', body = NULL, channel_message = ? WHERE id = ?")
    .run(post.message_id, id);
  return 'published';
}

const bot = await checkChannel();
await startModeratorPanel({ listRequests, moderate, miniApp, botUsername: bot.username });
await syncModeratorMenus();
console.log('Prayer bot is polling Telegram.');
let offset;
while (true) {
  try {
    prune();
    const updates = await api('getUpdates', {
      offset, timeout: 25, allowed_updates: ['message', 'callback_query'],
    }, 32_000);
    for (const update of updates) {
      prune();
      await handle(update);
      offset = update.update_id + 1;
    }
  } catch {
    console.error('Bot operation failed. Retrying in five seconds.');
    await new Promise(resolve => setTimeout(resolve, 5000));
  }
}
