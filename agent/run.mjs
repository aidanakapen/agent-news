// Один выпуск дайджеста: сбор постов → отбор → черновики RU/KZ → файл выпуска.
//
// Все изменяемые данные лежат в папке DATA_DIR (по умолчанию ./store) —
// в GitHub Actions это ветка `data` репозитория:
//   channels.json        список каналов (редактор правит его на сайте)
//   state.json           последний обработанный пост по каждому каналу
//   issues/<выпуск>.json черновики новостей одного выпуска
//
// Нужна переменная окружения ANTHROPIC_API_KEY.

import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { fetchNewPosts } from "../collector/collect.mjs";
import { SELECT_SYSTEM, DRAFT_SYSTEM } from "./prompts.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = process.env.DATA_DIR ?? join(ROOT, "store");
const ISSUES_DIR = join(DATA_DIR, "issues");
const MODEL = process.env.CLAUDE_MODEL || "claude-opus-5";
const MAX_NEWS = 15;
const RECENT_DAYS = 3;
const ASTANA_OFFSET_H = 5;

const client = new Anthropic();

async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, "utf8")); } catch { return fallback; }
}
const writeJson = (path, data) => writeFile(path, JSON.stringify(data, null, 2) + "\n", "utf8");

function astana(date = new Date()) {
  const d = new Date(date.getTime() + ASTANA_OFFSET_H * 3600e3);
  const p = (n) => String(n).padStart(2, "0");
  return {
    day: `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`,
    time: `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`,
  };
}

// ---------- Claude ----------

const Selection = z.object({
  items: z.array(z.object({
    primary_ref: z.string(),
    ru_ref: z.string().nullable(),
    kz_ref: z.string().nullable(),
    posts: z.array(z.string()),
    topic: z.enum(["law", "people", "emergency", "government"]),
    urgent: z.boolean(),
    reason: z.string(),
  })),
});

const LangDraft = z.object({ title: z.string(), paragraphs: z.array(z.string()) });
const Draft = z.object({ ru: LangDraft, kz: LangDraft });

async function ask(system, user, schema) {
  const response = await client.beta.messages.parse({
    model: MODEL,
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    thinking: { type: "adaptive" },
    output_config: { effort: "medium", format: betaZodOutputFormat(schema) },
    system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: user }],
  });
  if (response.stop_reason === "refusal") throw new Error(`Claude отказался: ${response.stop_details?.explanation ?? ""}`);
  if (response.stop_reason === "max_tokens") throw new Error("Ответ Claude обрезан по max_tokens");
  if (!response.parsed_output) throw new Error("Claude вернул ответ не по схеме");
  return response.parsed_output;
}

function postBlock(p, maxChars) {
  const text = p.text.length > maxChars ? p.text.slice(0, maxChars) + " […]" : p.text;
  return [
    `<post ref="${p.ref}" agency="${p.agency}" datetime="${p.datetime}"${p.linkedPosts.length ? ` links="${p.linkedPosts.join(" ")}"` : ""}${p.forwardedFrom ? ` forwarded_from="${p.forwardedFrom}"` : ""}>`,
    text || "(без текста)",
    "</post>",
  ].join("\n");
}

async function select(posts, recentTitles) {
  const user = [
    "Уже опубликовано в дайджесте за последние дни (не повторяй эти темы):",
    recentTitles.length ? recentTitles.map((t) => `- ${t}`).join("\n") : "- (пусто)",
    "",
    `Новые посты (${posts.length}):`,
    posts.map((p) => postBlock(p, 2000)).join("\n\n"),
  ].join("\n");
  return (await ask(SELECT_SYSTEM, user, Selection)).items;
}

async function draft(item, byRef) {
  const ru = item.ru_ref && byRef.get(item.ru_ref);
  const kz = item.kz_ref && byRef.get(item.kz_ref);
  const primary = byRef.get(item.primary_ref);
  const parts = [`Ведомство: ${primary.agency}. Дата поста: ${primary.datetime}.`];
  if (ru) parts.push("Официальный текст на русском:", postBlock(ru, 20000));
  if (kz) parts.push("Официальный текст на казахском:", postBlock(kz, 20000));
  if (!ru && !kz) parts.push("Официальный текст:", postBlock(primary, 20000));
  parts.push(
    "",
    `Русская версия: ${ru ? "есть официальный текст" : "официального текста нет — переведи"}.`,
    `Казахская версия: ${kz ? "есть официальный текст" : "официального текста нет — переведи"}.`,
  );
  return ask(DRAFT_SYSTEM, parts.join("\n"), Draft);
}

// ---------- выпуск ----------

async function loadChannels() {
  const path = join(DATA_DIR, "channels.json");
  let channels = await readJson(path, null);
  if (!channels) {
    channels = await readJson(join(ROOT, "config", "channels.json"), []);
    await writeJson(path, channels);
  }
  return channels;
}

async function recentIssues() {
  let files = [];
  try { files = (await readdir(ISSUES_DIR)).filter((f) => f.endsWith(".json")).sort(); } catch {}
  const since = astana(new Date(Date.now() - RECENT_DAYS * 86400e3)).day;
  const issues = [];
  for (const f of files) if (f.slice(0, 10) >= since) issues.push(await readJson(join(ISSUES_DIR, f), null));
  return issues.filter(Boolean);
}

async function main() {
  await mkdir(ISSUES_DIR, { recursive: true });
  const channels = await loadChannels();
  const enabled = channels.filter((c) => c.enabled);
  const state = await readJson(join(DATA_DIR, "state.json"), { lastIds: {} });

  const posts = [];
  const errors = {};
  for (const ch of enabled) {
    try {
      for (const p of await fetchNewPosts(ch.handle, state.lastIds[ch.handle])) {
        posts.push({ ...p, agency: ch.agency, agencyKz: ch.agencyKz ?? ch.agency });
      }
    } catch (e) {
      errors[ch.handle] = String(e.message ?? e);
    }
  }
  console.log(`Каналов: ${enabled.length}, новых постов: ${posts.length}, ошибок: ${Object.keys(errors).length}`);

  const now = astana();
  const issueId = `${now.day}-${now.time.replace(":", "")}`;
  const news = [];

  // Посты с текстом. Пустые (только фото/видео) сразу пропускаем.
  const candidates = posts.filter((p) => p.text.trim().length >= 40);
  if (candidates.length) {
    const recent = await recentIssues();
    const recentTitles = recent.flatMap((i) => i.news.map((n) => n.ru.title));
    const recentRefs = new Set(recent.flatMap((i) => i.news.flatMap((n) => n.sources.map((s) => s.ref))));
    const fresh = candidates.filter((p) => !recentRefs.has(p.ref));
    const byRef = new Map(fresh.map((p) => [p.ref, p]));

    const used = new Set();
    const items = (fresh.length ? await select(fresh, recentTitles) : [])
      .filter((it) => byRef.has(it.primary_ref) && !used.has(it.primary_ref))
      .map((it) => {
        const refs = [...new Set([it.primary_ref, it.ru_ref, it.kz_ref, ...it.posts])].filter((r) => r && byRef.has(r) && !used.has(r));
        refs.forEach((r) => used.add(r));
        return {
          ...it,
          ru_ref: refs.includes(it.ru_ref) ? it.ru_ref : null,
          kz_ref: refs.includes(it.kz_ref) ? it.kz_ref : null,
          posts: refs,
        };
      })
      .sort((a, b) => Number(b.urgent) - Number(a.urgent))
      .slice(0, MAX_NEWS);
    console.log(`Отобрано новостей: ${items.length}`);

    for (const [i, it] of items.entries()) {
      const d = await draft(it, byRef);
      const primary = byRef.get(it.primary_ref);
      const lang = (ref, text) => ({
        title: text.title.trim(),
        text: text.paragraphs.map((s) => s.trim()).filter(Boolean).join("\n\n"),
        translated: !ref,
        status: "new",
        sourceUrl: byRef.get(ref ?? it.primary_ref).url,
      });
      news.push({
        id: `${issueId}-${String(i + 1).padStart(2, "0")}`,
        urgent: it.urgent || it.topic === "emergency",
        topic: it.topic,
        reason: it.reason,
        agency: primary.agency,
        agencyKz: primary.agencyKz,
        channel: primary.channel,
        postDate: primary.datetime,
        sources: it.posts.map((r) => ({ ref: r, url: byRef.get(r).url, agency: byRef.get(r).agency })),
        ru: lang(it.ru_ref, d.ru),
        kz: lang(it.kz_ref, d.kz),
      });
      console.log(`  ${it.urgent ? "СРОЧНО " : ""}${d.ru.title}`);
    }
  }

  if (news.length) {
    await writeJson(join(ISSUES_DIR, `${issueId}.json`), {
      id: issueId,
      day: now.day,
      time: now.time,
      createdAt: new Date().toISOString(),
      model: MODEL,
      stats: { posts: posts.length, news: news.length, errors },
      news,
    });
  }

  // Состояние сдвигаем только после успешной записи выпуска.
  for (const p of posts) state.lastIds[p.channel] = Math.max(state.lastIds[p.channel] ?? 0, p.id);
  state.lastRun = { at: new Date().toISOString(), day: now.day, time: now.time, posts: posts.length, news: news.length, issue: news.length ? issueId : null, errors };
  await writeJson(join(DATA_DIR, "state.json"), state);
  console.log(news.length ? `Выпуск ${issueId}: ${news.length} новостей` : "Новых важных новостей нет");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
