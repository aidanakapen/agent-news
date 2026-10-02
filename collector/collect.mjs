// Сборщик постов из публичных Telegram-каналов через веб-просмотр t.me/s/<канал>.
// Без зависимостей и без аккаунта Telegram.
//
// Используется агентом (agent/run.mjs). Для ручной проверки:
//   node collector/collect.mjs KZgovernment,qr_tjm   — напечатает посты за последние сутки

import { fileURLToPath } from "node:url";

const FIRST_RUN_HOURS = 24; // если канал ещё не читали, берём посты за последние сутки
const MAX_PAGES = 4; // не больше ~80 постов на канал за один сбор

function decode(s) {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");
}

function htmlToText(html) {
  return decode(
    html
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<a [^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gi, (_, href, inner) => {
        const label = inner.replace(/<[^>]+>/g, "");
        return label.startsWith("http") || label === href ? href : `${label} (${href})`;
      })
      .replace(/<[^>]+>/g, "")
  ).replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function parsePage(html, channel) {
  const posts = [];
  for (const chunk of html.split('data-post="').slice(1)) {
    const [ch, idStr] = chunk.slice(0, chunk.indexOf('"')).split("/");
    if (!idStr || ch.toLowerCase() !== channel.toLowerCase()) continue;
    const id = Number(idStr);
    const textMatch = chunk.match(/<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/);
    const timeMatch = chunk.match(/<time datetime="([^"]+)"/);
    const fwdMatch = chunk.match(/tgme_widget_message_forwarded_from_name"[^>]*>(?:<span[^>]*>)?([^<]+)/);
    const linked = [...(textMatch?.[1] ?? "").matchAll(/https:\/\/t\.me\/([A-Za-z0-9_]+\/\d+)/g)].map((m) => m[1]);
    posts.push({
      ref: `${ch}/${id}`,
      channel: ch,
      id,
      url: `https://t.me/${ch}/${id}`,
      datetime: timeMatch?.[1] ?? null,
      forwardedFrom: fwdMatch ? decode(fwdMatch[1]).trim() : null,
      linkedPosts: [...new Set(linked)],
      text: textMatch ? htmlToText(textMatch[1]) : "",
    });
  }
  return posts;
}

async function fetchPage(channel, before, attempt = 1) {
  const url = `https://t.me/s/${channel}${before ? `?before=${before}` : ""}`;
  try {
    const res = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 (news-digest-agent)" }, signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    return await res.text();
  } catch (e) {
    if (attempt >= 3) throw e;
    await new Promise((r) => setTimeout(r, 3000 * attempt));
    return fetchPage(channel, before, attempt + 1);
  }
}

// Новые посты канала после lastId (или за последние сутки, если lastId нет), по возрастанию id.
export async function fetchNewPosts(channel, lastId) {
  const cutoff = Date.now() - FIRST_RUN_HOURS * 3600e3;
  const byId = new Map();
  let before = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const posts = parsePage(await fetchPage(channel, before), channel);
    if (!posts.length) break;
    for (const p of posts) byId.set(p.id, p);
    const oldest = Math.min(...posts.map((p) => p.id));
    const reachedKnown = lastId
      ? oldest <= lastId
      : posts.some((p) => p.datetime && Date.parse(p.datetime) < cutoff);
    if (reachedKnown) break;
    before = oldest;
  }
  return [...byId.values()]
    .filter((p) => (lastId ? p.id > lastId : !p.datetime || Date.parse(p.datetime) >= cutoff))
    .sort((a, b) => a.id - b.id);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const channels = (process.argv[2] ?? "KZgovernment").split(",").map((s) => s.trim().replace(/^@/, ""));
  for (const ch of channels) {
    const posts = await fetchNewPosts(ch, null);
    console.log(`\n=== @${ch}: ${posts.length} постов за сутки ===`);
    for (const p of posts) console.log(`\n[${p.ref}] ${p.datetime}\n${p.text.slice(0, 300)}`);
  }
}
