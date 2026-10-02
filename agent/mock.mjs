// Мокап-режим: работает без ключа Claude API.
// Отбор по ключевым словам, черновик = очищенный текст исходного поста.
// Нужен, чтобы посмотреть весь путь (сбор → выпуск → редактор) до подключения Claude.

const URGENT = /штормов\w* предупрежд|эвакуац|паводк|наводнен|землетрясен|чрезвычайн\w* ситуаци\w* (?:введ|объявл)|лавиноопасн|дауылды ескерту|эвакуация|су тасқын|жер сілкін|төтенше жағдай (?:режимі|енгізіл|жариял)/i;
const RULES = [
  { topic: "government", re: /назначен|освобожд[её]н от должност|отставк|тағайындалды|лауазымынан босатыл/i },
  { topic: "people", re: /пенси|пособи|выплат|тариф|налог|штраф|льгот|стипенди|зарплат|ипотек|жәрдемақы|зейнетақы|салық|айыппұл|төлем|жалақы|жеңілдік/i },
  { topic: "law", re: /закон|кодекс|постановлени|\bуказ|подписал|поправк|заң|қаулы|жарлық|қол қойды|түзету/i },
];
const SKIP = /поздравля|с праздником|құттықта|мерекес|памят|провел[аи]? встречу|встретился|кездесті|кездесу өткізді|переговор|келіссөз|#\w+_көзімен/i;
const PER_CHANNEL = 3;
const MAX_NEWS = 15;

const isKz = (t) => (t.match(/[әғқңөұүһі]/gi) ?? []).length >= 5;
const stripMarks = (s) => s.replace(/^[\p{Extended_Pictographic}\p{So}️‍\s▪•—-]+/u, "").replace(/\s+/g, " ").trim();
const junk = (p) => !p || /^(@\w+|https?:\/\/t\.me\/\S+)(\s*\(https?:\/\/\S+\))?$/.test(p) || /подписывайтесь|жазылыңыз/i.test(p);

function split(post) {
  const [first, ...rest] = post.text.split("\n");
  let title = stripMarks(first).replace(/\s*\(https?:\/\/[^)]+\)/g, "").replace(/\s*https?:\/\/\S+/g, "");
  if (title.length > 140) title = title.slice(0, 137).replace(/\s+\S*$/, "") + "…";
  const paragraphs = rest.join("\n").split(/\n+/).map(stripMarks).filter((p) => !junk(p));
  return { title: title.replace(/\.$/, ""), paragraphs: (paragraphs.length ? paragraphs : [title]).slice(0, 5) };
}

function classify(text) {
  if (URGENT.test(text)) return "emergency";
  return RULES.find((r) => r.re.test(text))?.topic ?? null;
}

export function mockSelect(posts) {
  const used = new Set();
  const perChannel = {};
  const seenHeads = new Set();
  const items = [];
  const lang = (p) => (isKz(p.text) ? "kz" : "ru");
  for (const p of [...posts].sort((a, b) => Date.parse(b.datetime) - Date.parse(a.datetime))) {
    if (used.has(p.ref) || SKIP.test(p.text)) continue;
    const head = p.text.split("\n")[0].trim();
    if (seenHeads.has(head)) continue;
    seenHeads.add(head);
    const topic = classify(p.text);
    if (!topic) continue;
    if (topic !== "emergency" && (perChannel[p.channel] ?? 0) >= PER_CHANNEL) continue;
    // пара на другом языке: тот же канал, явная ссылка или ближайший по времени пост в пределах часа
    const pair = posts
      .filter((q) => q !== p && !used.has(q.ref) && q.channel === p.channel && lang(q) !== lang(p))
      .map((q) => ({ q, dt: p.linkedPosts.includes(q.ref) || q.linkedPosts.includes(p.ref) ? 0 : Math.abs(Date.parse(q.datetime) - Date.parse(p.datetime)) }))
      .filter(({ dt }) => dt <= 60 * 60e3)
      .sort((a, b) => a.dt - b.dt)[0]?.q;
    used.add(p.ref);
    if (pair) used.add(pair.ref);
    perChannel[p.channel] = (perChannel[p.channel] ?? 0) + 1;
    const ru = lang(p) === "ru" ? p : pair;
    const kz = lang(p) === "kz" ? p : pair;
    items.push({
      primary_ref: (ru ?? kz).ref,
      ru_ref: ru?.ref ?? null,
      kz_ref: kz?.ref ?? null,
      posts: [p.ref, pair?.ref].filter(Boolean),
      topic,
      urgent: topic === "emergency",
      reason: "Мокап: отобрано по ключевым словам, без Claude.",
    });
  }
  return items.sort((a, b) => Number(b.urgent) - Number(a.urgent)).slice(0, MAX_NEWS);
}

export function mockDraft(item, byRef) {
  const ru = item.ru_ref ? split(byRef.get(item.ru_ref)) : null;
  const kz = item.kz_ref ? split(byRef.get(item.kz_ref)) : null;
  const stub = (from, note, text) => ({ title: `${note} ${from.title}`, paragraphs: [text, ...from.paragraphs] });
  return {
    ru: ru ?? stub(kz, "[нужен перевод]", "Мокап: с ключом Claude API здесь будет перевод агента на русский. Ниже текст на казахском."),
    kz: kz ?? stub(ru, "[аударма керек]", "Мокап: Claude API кілтімен мұнда агенттің қазақша аудармасы болады. Төменде орысша мәтін."),
  };
}
