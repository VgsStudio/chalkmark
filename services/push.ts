// Notificações (Web Push, padrão VAPID): até 2 por dia, mais os avisos de eventos (novo seguidor).
// 1) Lembrete diário perto do horário em que a pessoa costuma escalar.
// 2) Segundo aviso no horário em que ela costuma abrir o app (ou no almoço, enquanto não dá para saber):
//    algo importante (sumiu há dias, meta da semana em aberto, semana em branco) ou, em ~2 de cada 3 dias,
//    uma mensagem divertida (estilo iFood). Nos outros dias, nada.
// Barato de propósito:
// - as chaves VAPID são geradas pelo próprio servidor na 1ª vez e ficam na tabela (CONFIG/VAPID);
// - quem recebe às HH (UTC) fica num "balde" NOTIFY#HH: o agendamento de hora em hora faz uma Query, sem Scan;
// - inscrições inválidas (404/410) são apagadas na hora.
import webpush from 'web-push';
import { createHash } from 'node:crypto';
import { DeleteCommand, GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, log, TABLE } from './common.ts';
import { isOpenProject, isSend, projects, sessionsThisWeek, streakWeeks } from '../web/src/stats.js';

const SITE = 'https://chalkmark.vsoller.com.br';
const pkOf = (sub: string) => `USER#${sub}`;

// ---------- chaves VAPID (geradas uma vez, guardadas na tabela) ----------
let vapid: { publicKey: string; privateKey: string } | undefined;
export async function vapidKeys() {
  if (vapid) return vapid;
  const key = { pk: 'CONFIG', sk: 'VAPID' };
  const { Item } = await ddb.send(new GetCommand({ TableName: TABLE, Key: key }));
  if (Item) return (vapid = { publicKey: Item.publicKey, privateKey: Item.privateKey });
  const k = webpush.generateVAPIDKeys();
  try {
    await ddb.send(new PutCommand({ TableName: TABLE, Item: { ...key, ...k, createdAt: new Date().toISOString() }, ConditionExpression: 'attribute_not_exists(pk)' }));
    return (vapid = k);
  } catch {
    // Outra execução gerou ao mesmo tempo: vale a que ficou gravada.
    vapid = undefined;
    return vapidKeys();
  }
}

// ---------- inscrições ----------
/** Só serviços de push conhecidos (o servidor faz a requisição: nada de URL arbitrária). */
const PUSH_HOSTS = [/\.push\.apple\.com$/, /^fcm\.googleapis\.com$/, /^updates\.push\.services\.mozilla\.com$/, /\.notify\.windows\.com$/, /^web\.push\.apple\.com$/];
export function cleanSubscription(v: unknown) {
  const s = (v ?? {}) as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
  let url: URL;
  try { url = new URL(String(s.endpoint)); } catch { return null; }
  const ok = url.protocol === 'https:' && PUSH_HOSTS.some((re) => re.test(url.hostname)) && String(s.endpoint).length < 1024;
  const p256dh = s.keys?.p256dh, auth = s.keys?.auth;
  if (!ok || typeof p256dh !== 'string' || typeof auth !== 'string' || p256dh.length > 200 || auth.length > 100) return null;
  return { endpoint: url.href, keys: { p256dh, auth } };
}
const subKey = (endpoint: string) => `PUSH#${createHash('sha256').update(endpoint).digest('hex').slice(0, 24)}`;
export async function saveSubscription(sub: string, s: { endpoint: string; keys: { p256dh: string; auth: string } }) {
  await ddb.send(new PutCommand({ TableName: TABLE, Item: { pk: pkOf(sub), sk: subKey(s.endpoint), ...s, createdAt: new Date().toISOString() } }));
}
export async function removeSubscription(sub: string, endpoint: string) {
  await ddb.send(new DeleteCommand({ TableName: TABLE, Key: { pk: pkOf(sub), sk: subKey(endpoint) } }));
}

/** Envia para todos os aparelhos da pessoa; apaga os que não existem mais. Devolve quantos receberam. */
export async function pushTo(sub: string, payload: { title: string; body: string; url?: string; tag?: string }) {
  const { publicKey, privateKey } = await vapidKeys();
  const { Items = [] } = await ddb.send(new QueryCommand({
    TableName: TABLE, KeyConditionExpression: 'pk = :p AND begins_with(sk, :s)', ExpressionAttributeValues: { ':p': pkOf(sub), ':s': 'PUSH#' },
  }));
  let sent = 0;
  for (const it of Items) {
    try {
      await webpush.sendNotification({ endpoint: it.endpoint, keys: it.keys }, JSON.stringify(payload), {
        vapidDetails: { subject: SITE, publicKey, privateKey }, TTL: 6 * 3600, urgency: 'normal', timeout: 5000,
      });
      sent++;
    } catch (e) {
      const status = (e as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) await ddb.send(new DeleteCommand({ TableName: TABLE, Key: { pk: it.pk, sk: it.sk } }));
      else log('push.failed', { status, message: (e as Error).message.slice(0, 200) });
    }
  }
  return sent;
}

// ---------- horário e fuso ----------
/** Hora/data local de um fuso (IANA), sem biblioteca. */
export function localParts(tz: string, d = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', weekday: 'short' })
    .formatToParts(d).map((x) => [x.type, x.value]));
  return { ymd: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) % 24, weekday: String(p.weekday) };
}
export const validTz = (tz: unknown) => {
  if (typeof tz !== 'string' || tz.length > 64) return null;
  try { new Intl.DateTimeFormat('en', { timeZone: tz }); return tz; } catch { return null; }
};
/** Hora UTC em que é `localHour` no fuso `tz` (hoje). */
export function utcHourFor(tz: string, localHour: number, d = new Date()) {
  const off = (localParts(tz, d).hour - d.getUTCHours() + 24) % 24; // fuso em horas inteiras
  return ((localHour - off) % 24 + 24) % 24;
}
/** Horário do lembrete aprendido das sessões: 1 h antes da hora em que a pessoa costuma começar. */
export function learnedHour(sessions: { startedAt: string }[], tz: string) {
  const hours = sessions.slice(-12).map((s) => localParts(tz, new Date(s.startedAt)).hour).sort((a, b) => a - b);
  if (!hours.length) return 18;
  const median = hours[Math.floor(hours.length / 2)];
  return Math.min(21, Math.max(7, median - 1));
}

/** Horário em que a pessoa costuma abrir o app: o mais frequente das últimas aberturas (hora local).
 *  Null com menos de 5 aberturas (ainda não dá para saber). */
export function learnedOpenHour(hours: number[]) {
  if (hours.length < 5) return null;
  const count = new Map<number, number>();
  for (const h of hours) count.set(h, (count.get(h) ?? 0) + 1);
  return [...count].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0][0];
}
const hourGap = (a: number, b: number) => Math.min((a - b + 24) % 24, (b - a + 24) % 24);
/** Hora do segundo aviso: a de abrir o app; sem ela, almoço (12h) ou, perto do lembrete, 20h. Sempre a 3 h+ do lembrete. */
export function secondHour(openHour: number | null, dailyHour: number) {
  for (const h of [openHour, 12, 20, 9]) if (h !== null && hourGap(h, dailyHour) >= 3) return h;
  return null;
}

/** Abriu o app (GET /api/settings): guarda quando e a hora local, no máximo uma vez por hora. */
export async function recordOpen(sub: string, st: Record<string, any>, now = new Date()) {
  if (st.lastSeenAt && now.getTime() - Date.parse(st.lastSeenAt) < 3600_000) return;
  const hours = [...(st.openHours ?? []), localParts(st.pushTz ?? 'America/Sao_Paulo', now).hour].slice(-30);
  await ddb.send(new UpdateCommand({
    TableName: TABLE, Key: { pk: pkOf(sub), sk: 'SETTINGS' },
    UpdateExpression: 'SET lastSeenAt = :t, openHours = :h', ExpressionAttributeValues: { ':t': now.toISOString(), ':h': hours },
  }));
}

// ---------- preferências (liga/desliga, fuso, hora) ----------
export async function setPrefs(sub: string, prefs: { on?: boolean; tz?: string; hour?: number | null; lang?: string }) {
  const { Item: st = {} } = await ddb.send(new GetCommand({ TableName: TABLE, Key: { pk: pkOf(sub), sk: 'SETTINGS' } }));
  const next = {
    pushOn: prefs.on ?? st.pushOn ?? true,
    pushTz: prefs.tz ?? st.pushTz ?? 'America/Sao_Paulo',
    pushHour: prefs.hour === undefined ? st.pushHour ?? null : prefs.hour, // null = automático (aprendido)
    pushLang: prefs.lang ?? st.pushLang ?? 'pt',
  };
  const sessions = (await ddb.send(new QueryCommand({
    TableName: TABLE, KeyConditionExpression: 'pk = :p AND begins_with(sk, :s)', ExpressionAttributeValues: { ':p': pkOf(sub), ':s': 'SESSION#' },
  }))).Items ?? [];
  const hour = next.pushHour ?? learnedHour(sessions as { startedAt: string }[], next.pushTz);
  const bucketOf = (h: number) => `NOTIFY#${String(utcHourFor(next.pushTz, h)).padStart(2, '0')}`;
  const bucket = next.pushOn ? bucketOf(hour) : null;
  const openHour = learnedOpenHour(st.openHours ?? []);
  const hour2 = secondHour(openHour, hour);
  const bucket2 = next.pushOn && hour2 !== null ? bucketOf(hour2) : null;
  // Troca de balde: tira do antigo, põe no novo. No balde, `sub` = lembrete diário e `sub#open` = segundo aviso.
  if (st.pushBucket && st.pushBucket !== bucket) await ddb.send(new DeleteCommand({ TableName: TABLE, Key: { pk: st.pushBucket, sk: sub } }));
  if (bucket) await ddb.send(new PutCommand({ TableName: TABLE, Item: { pk: bucket, sk: sub } }));
  if (st.pushBucket2 && st.pushBucket2 !== bucket2) await ddb.send(new DeleteCommand({ TableName: TABLE, Key: { pk: st.pushBucket2, sk: `${sub}#open` } }));
  if (bucket2) await ddb.send(new PutCommand({ TableName: TABLE, Item: { pk: bucket2, sk: `${sub}#open` } }));
  await ddb.send(new UpdateCommand({
    TableName: TABLE, Key: { pk: pkOf(sub), sk: 'SETTINGS' },
    UpdateExpression: 'SET pushOn = :on, pushTz = :tz, pushHour = :h, pushLang = :l, pushBucket = :b, pushBucket2 = :b2',
    ExpressionAttributeValues: { ':on': next.pushOn, ':tz': next.pushTz, ':h': next.pushHour, ':l': next.pushLang, ':b': bucket, ':b2': bucket2 },
  }));
  return { ...next, effectiveHour: hour, bucket, openHour, secondHour: hour2, bucket2 };
}

// ---------- mensagem do dia ----------
const COLOR = {
  pt: { green: 'verde', purple: 'roxo', yellow: 'amarelo', white: 'branco', wood: 'madeira', red: 'vermelho', blue: 'azul', black: 'preto', orange: 'laranja', pink: 'rosa', other: '' },
  en: { green: 'green', purple: 'purple', yellow: 'yellow', white: 'white', wood: 'wood', red: 'red', blue: 'blue', black: 'black', orange: 'orange', pink: 'pink', other: '' },
} as const;
type Ctx = { name: string; lang: 'pt' | 'en'; tz: string; now: Date };
type Msg = { title: string; body: string; url: string };

/** Escolhe a mensagem pela situação da pessoa (sequência, semana, projeto, meta). Null = hoje não precisa. */
export function dailyMessage(sessions: Record<string, any>[], climbs: Record<string, any>[], settings: Record<string, any>, ctx: Ctx): Msg | null {
  const { name, lang, tz, now } = ctx;
  // As contas de semana do stats.js usam o fuso do processo: aqui, o da pessoa.
  const prevTz = process.env.TZ;
  process.env.TZ = tz;
  try {
    const today = localParts(tz, now).ymd;
    if (sessions.some((s) => localParts(tz, new Date(s.startedAt)).ymd === today)) return null; // já escalou hoje
    const streak = streakWeeks(sessions as any, now);
    const week = sessionsThisWeek(sessions as any, now);
    const goal = Number(settings.weeklySessions ?? 0);
    const weekday = localParts(tz, now).weekday; // Mon..Sun
    const lateWeek = ['Fri', 'Sat', 'Sun'].includes(weekday);
    const open = projects(climbs as any).filter((p: any) => isOpenProject(p, now.getTime())).sort((a: any, b: any) => String(b.lastAt).localeCompare(String(a.lastAt)));
    const g = (n: number) => (settings.scale === 'font' ? ['4', '5', '5+', '6A+', '6B+', '6C+', '7A', '7A+', '7B+', '7C', '7C+', '8A', '8A+', '8B', '8B+', '8C', '8C+', '9A'][n] : `V${n}`);
    const pt = lang === 'pt';
    const n = name ? `${name}, ` : '';
    const N = name || (pt ? 'Ei' : 'Hey');
    const day = Math.floor(now.getTime() / 86400_000);
    const options: Msg[] = [];
    if (week === 0 && streak > 0 && lateWeek) {
      options.push(pt
        ? { title: `🔥 ${n}sua sequência de ${streak} ${streak === 1 ? 'semana' : 'semanas'} está em risco`, body: 'Uma sessão até domingo e ela continua viva. Bora pra parede?', url: '/#/' }
        : { title: `🔥 ${n}your ${streak}-week streak is at risk`, body: 'One session by Sunday keeps it alive. Wall time?', url: '/#/' });
    }
    const p = open[0];
    if (p) {
      const c = COLOR[lang][p.root.color as keyof typeof COLOR.pt] ?? '';
      options.push(pt
        ? { title: `👀 ${N}, aquele ${c} ${g(p.root.grade)} ainda te espera`, body: p.sessions > 1 ? `Você já tentou em ${p.sessions} sessões. Hoje ele sai!` : 'Projeto aberto é projeto pra mandar. Hoje é o dia?', url: `/#/climb/${p.root.id}` }
        : { title: `👀 ${N}, that ${c} ${g(p.root.grade)} is still waiting`, body: p.sessions > 1 ? `You've tried it in ${p.sessions} sessions. Today's the day!` : 'An open project is a project to send. Today?', url: `/#/climb/${p.root.id}` });
    }
    if (goal > 0 && week < goal) {
      const left = goal - week;
      options.push(pt
        ? { title: `🎯 ${n}${left === 1 ? 'falta 1 sessão' : `faltam ${left} sessões`} pra sua meta da semana`, body: 'Cada sessão vale XP e mantém o foguinho aceso.', url: '/#/' }
        : { title: `🎯 ${n}${left} ${left === 1 ? 'session' : 'sessions'} to hit this week's goal`, body: 'Every session earns XP and keeps the flame alive.', url: '/#/' });
    }
    if (week === 0 && streak > 0 && !lateWeek) {
      options.push(pt
        ? { title: `🧗 ${N}, bora manter as ${streak} ${streak === 1 ? 'semana' : 'semanas'}?`, body: 'Sua semana ainda está em branco. Hoje é um ótimo dia pra parede.', url: '/#/' }
        : { title: `🧗 ${N}, keep the ${streak}-week streak going?`, body: "Your week is still empty. Today's a great wall day.", url: '/#/' });
    }
    if (streak === 0) {
      options.push(pt
        ? { title: `💪 ${N}, que tal acender o foguinho hoje?`, body: 'Uma sessão e sua sequência começa. A parede não vai se escalar sozinha.', url: '/#/' }
        : { title: `💪 ${N}, light the flame today?`, body: "One session starts your streak. The wall won't climb itself.", url: '/#/' });
    }
    const sends = climbs.filter(isSend).length;
    if (!options.length) {
      options.push(pt
        ? { title: `✅ ${N}, semana garantida!`, body: sends ? `Já são ${sends} vias mandadas. Mais uma sessão rende XP extra.` : 'Mais uma sessão rende XP extra.', url: '/#/' }
        : { title: `✅ ${N}, week secured!`, body: sends ? `${sends} sends so far. One more session earns extra XP.` : 'One more session earns extra XP.', url: '/#/' });
    }
    // Variadas: só entram em alguns dias, para o lembrete não ficar repetido (custo zero: continua 1 por dia).
    const extras: Msg[] = [];
    const last = sessions.length ? new Date(sessions[sessions.length - 1].startedAt) : null;
    const idle = last ? Math.floor((now.getTime() - last.getTime()) / 86400_000) : 0;
    if (idle >= 4) extras.push(pt
      ? { title: `⏳ ${N}, já são ${idle} dias sem parede`, body: 'Seus dedos estão sentindo falta da magnésio.', url: '/#/' }
      : { title: `⏳ ${N}, ${idle} days without the wall`, body: 'Your fingers miss the chalk.', url: '/#/' });
    const max = Math.max(-1, ...climbs.filter(isSend).map((c) => Number(c.grade)));
    if (max >= 0 && max < 17) extras.push(pt
      ? { title: `📈 ${N}, seu máximo é ${g(max)}`, body: `Que tal tentar um ${g(max + 1)} hoje? Projeto novo, XP novo.`, url: '/#/' }
      : { title: `📈 ${N}, your max is ${g(max)}`, body: `Try a ${g(max + 1)} today? New project, new XP.`, url: '/#/' });
    if (sends >= 3) {
      const next = Math.ceil((sends + 1) / 5) * 5;
      extras.push(pt
        ? { title: `🏆 ${N}, ${sends} vias mandadas até aqui`, body: `Faltam ${next - sends} pra chegar em ${next}. Bora?`, url: '/#/progress' }
        : { title: `🏆 ${N}, ${sends} sends so far`, body: `${next - sends} more to reach ${next}. Let's go?`, url: '/#/progress' });
    }
    extras.push(pt
      ? { title: `🤝 ${N}, chama alguém pra escalar hoje?`, body: 'Escalar junto rende mais (e vale ranking da semana).', url: '/#/feed' }
      : { title: `🤝 ${N}, bring a friend to climb today?`, body: 'Climbing together goes further (and counts for the weekly ranking).', url: '/#/feed' });
    // Sequência em risco no fim de semana sempre vence. Nos outros dias, a mais importante na maioria das vezes,
    // às vezes a segunda e, 1 dia em 4, uma das variadas.
    if (options[0].title.startsWith('🔥')) return options[0];
    const r = day % 4;
    if (r === 3) return extras[Math.floor(day / 4) % extras.length];
    return options[r === 2 && options.length > 1 ? 1 : 0];
  } finally {
    if (prevTz === undefined) delete process.env.TZ; else process.env.TZ = prevTz;
  }
}

// Mensagens divertidas do segundo aviso (estilo iFood). {N} = primeiro nome.
const FUN = {
  pt: [
    ['🧗 {N}, a parede mandou um oi', 'Disse que tá com saudade das suas agarras favoritas.'],
    ['🍕 Pizza é bom, {N}…', 'Mas já mandou um boulder hoje? Depois pode pedir a pizza.'],
    ['🤏 {N}, seus dedos ligaram', 'Querem saber quando é o próximo treino. Respondemos que hoje.'],
    ['🧂 Magnésio em alta', 'Os pés de gato estão no armário fazendo greve. Liberta eles, {N}.'],
    ['🦎 {N}, lagartixa não tira folga', 'Ela escala parede todo dia. Só tô dizendo.'],
    ['📉 Alerta de sofá detectado', '{N}, o sofá está ganhando de 1 a 0. Hora da virada.'],
    ['🎯 Fato aleatório', 'Quem registra os boulders melhora mais rápido. Fonte: confia, {N}.'],
    ['🔥 {N}, o foguinho tá com frio', 'Uma sessãozinha esquenta ele rapidinho.'],
    ['🧠 Beta do dia', 'Pé alto, quadril perto da parede e respira. De nada, {N}.'],
    ['🦍 Modo gorila: ON', 'Hoje é dia de mandar aquela via que você fica só olhando, {N}.'],
    ['⏰ {N}, lembrete nada urgente', 'Mas a parede continua lá, esperando você.'],
    ['🍌 {N}, comeu sua banana?', 'Energia carregada = projeto mandado.'],
  ],
  en: [
    ['🧗 {N}, the wall says hi', 'It misses your favorite holds.'],
    ['🍕 Pizza is great, {N}…', 'But did you send a boulder today? Pizza after.'],
    ['🤏 {N}, your fingers called', 'They want to know when the next session is. We said today.'],
    ['🧂 Chalk is trending', 'Your climbing shoes are on strike in the closet. Free them, {N}.'],
    ['🦎 {N}, geckos never take a day off', 'They climb walls every day. Just saying.'],
    ['📉 Couch alert', '{N}, the couch is winning 1-0. Time for a comeback.'],
    ['🎯 Random fact', 'People who log their boulders improve faster. Source: trust me, {N}.'],
    ['🔥 {N}, the flame is cold', 'One little session warms it right up.'],
    ['🧠 Beta of the day', 'High feet, hips close to the wall, breathe. You are welcome, {N}.'],
    ['🦍 Gorilla mode: ON', "Today's the day to send that problem you keep staring at, {N}."],
    ['⏰ {N}, a non-urgent reminder', 'But the wall is still there, waiting for you.'],
    ['🍌 {N}, had your banana?', 'Charged up = project sent.'],
  ],
} as const;
/** Número estável por pessoa e dia (sorteio que muda todo dia, sem guardar estado). */
const dayHash = (seed: string, day: number) => [...`${seed}:${day}`].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) >>> 0, 7);

/** Segundo aviso do dia. Null = hoje não manda: já abriu o app ou escalou hoje, ou caiu num dia de folga. */
export function nudgeMessage(sessions: Record<string, any>[], settings: Record<string, any>, ctx: Ctx & { seed?: string }): Msg | null {
  const { name, lang, tz, now, seed = '' } = ctx;
  const prevTz = process.env.TZ;
  process.env.TZ = tz;
  try {
    const today = localParts(tz, now).ymd;
    if (settings.lastSeenAt && localParts(tz, new Date(settings.lastSeenAt)).ymd === today) return null; // já abriu hoje
    if (sessions.some((s) => localParts(tz, new Date(s.startedAt)).ymd === today)) return null;
    const pt = lang === 'pt';
    const N = name || (pt ? 'Ei' : 'Hey');
    const streak = streakWeeks(sessions as any, now);
    const week = sessionsThisWeek(sessions as any, now);
    const goal = Number(settings.weeklySessions ?? 0);
    const weekday = localParts(tz, now).weekday;
    const away = settings.lastSeenAt ? Math.floor((now.getTime() - Date.parse(settings.lastSeenAt)) / 86400_000) : 0;
    if (away >= 3) {
      return pt
        ? { title: `😴 ${N}, faz ${away} dias que você não aparece`, body: streak > 0 ? `Sua sequência de ${streak} ${streak === 1 ? 'semana' : 'semanas'} ainda dá pra salvar.` : 'Seus amigos estão escalando. Bora marcar o próximo treino?', url: '/#/feed' }
        : { title: `😴 ${N}, ${away} days without stopping by`, body: streak > 0 ? `Your ${streak}-week streak can still be saved.` : 'Your friends are climbing. Plan your next session?', url: '/#/feed' };
    }
    if (goal > 0 && week < goal && ['Thu', 'Fri', 'Sat', 'Sun'].includes(weekday)) {
      const left = goal - week;
      return pt
        ? { title: `🎯 ${N}, a semana está acabando`, body: `${left === 1 ? 'Falta 1 sessão' : `Faltam ${left} sessões`} pra fechar sua meta.`, url: '/#/' }
        : { title: `🎯 ${N}, the week is almost over`, body: `${left} ${left === 1 ? 'session' : 'sessions'} left to hit your goal.`, url: '/#/' };
    }
    if (week === 0 && streak > 0 && ['Wed', 'Thu', 'Fri', 'Sat', 'Sun'].includes(weekday)) {
      return pt
        ? { title: `🔥 ${N}, sua semana ainda está em branco`, body: `Uma sessão mantém as ${streak} ${streak === 1 ? 'semana' : 'semanas'} de sequência.`, url: '/#/' }
        : { title: `🔥 ${N}, your week is still empty`, body: `One session keeps your ${streak}-week streak.`, url: '/#/' };
    }
    // Nada importante: divertida em ~2 de cada 3 dias; no resto, folga (para não virar spam).
    const day = Math.floor(now.getTime() / 86400_000);
    const h = dayHash(seed, day);
    if (h % 3 === 0) return null;
    const list = FUN[lang];
    const [title, body] = list[(h >>> 2) % list.length];
    const fill = (s: string) => s.replaceAll('{N}', N);
    return { title: fill(title), body: fill(body), url: '/#/' };
  } finally {
    if (prevTz === undefined) delete process.env.TZ; else process.env.TZ = prevTz;
  }
}

/** Monta e envia a mensagem do dia de uma pessoa (o agendamento usa isto). */
export async function sendDaily(sub: string) {
  const q = (prefix: string) => ddb.send(new QueryCommand({
    TableName: TABLE, KeyConditionExpression: 'pk = :p AND begins_with(sk, :s)', ExpressionAttributeValues: { ':p': pkOf(sub), ':s': prefix },
  })).then((r) => r.Items ?? []);
  const [{ Item: st = {} }, { Item: prof }, sessions, climbs] = await Promise.all([
    ddb.send(new GetCommand({ TableName: TABLE, Key: { pk: pkOf(sub), sk: 'SETTINGS' } })),
    ddb.send(new GetCommand({ TableName: TABLE, Key: { pk: pkOf(sub), sk: 'PROFILE' } })),
    q('SESSION#'), q('CLIMB#'),
  ]);
  const tz = st.pushTz ?? 'America/Sao_Paulo';
  const today = localParts(tz).ymd;
  if (st.pushOn === false || st.lastPushDay === today) return { sent: 0, reason: 'skip' };
  const name = String(prof?.name ?? '').trim().split(/\s+/)[0] ?? '';
  const sorted = [...sessions].sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
  const msg = dailyMessage(sorted, climbs.map((c) => ({ ...c, id: String(c.sk).split('#')[1] })), st, { name, lang: st.pushLang === 'en' ? 'en' : 'pt', tz, now: new Date() })
;
  if (!msg) return { sent: 0, reason: 'climbed-today' };
  const sent = await pushTo(sub, { ...msg, tag: 'daily' });
  await ddb.send(new UpdateCommand({ TableName: TABLE, Key: { pk: pkOf(sub), sk: 'SETTINGS' }, UpdateExpression: 'SET lastPushDay = :d, lastPushTitle = :t', ExpressionAttributeValues: { ':d': today, ':t': msg.title } }));
  return { sent, title: msg.title };
}

/** Segundo aviso do dia (balde `sub#open`). */
export async function sendNudge(sub: string) {
  const [{ Item: st = {} }, { Item: prof }, { Items: sessions = [] }] = await Promise.all([
    ddb.send(new GetCommand({ TableName: TABLE, Key: { pk: pkOf(sub), sk: 'SETTINGS' } })),
    ddb.send(new GetCommand({ TableName: TABLE, Key: { pk: pkOf(sub), sk: 'PROFILE' } })),
    ddb.send(new QueryCommand({ TableName: TABLE, KeyConditionExpression: 'pk = :p AND begins_with(sk, :s)', ExpressionAttributeValues: { ':p': pkOf(sub), ':s': 'SESSION#' } })),
  ]);
  const tz = st.pushTz ?? 'America/Sao_Paulo';
  const today = localParts(tz).ymd;
  if (st.pushOn === false || st.lastNudgeDay === today) return { sent: 0, reason: 'skip' };
  const name = String(prof?.name ?? '').trim().split(/\s+/)[0] ?? '';
  const sorted = [...sessions].sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
  const msg = nudgeMessage(sorted, st, { name, lang: st.pushLang === 'en' ? 'en' : 'pt', tz, now: new Date(), seed: sub });
  if (!msg || (st.lastPushDay === today && st.lastPushTitle === msg.title)) return { sent: 0, reason: 'nothing' };
  const sent = await pushTo(sub, { ...msg, tag: 'nudge' });
  await ddb.send(new UpdateCommand({ TableName: TABLE, Key: { pk: pkOf(sub), sk: 'SETTINGS' }, UpdateExpression: 'SET lastNudgeDay = :d', ExpressionAttributeValues: { ':d': today } }));
  return { sent, title: msg.title };
}

/** Agendamento de hora em hora: quem está no balde desta hora UTC recebe a mensagem do dia. */
export async function notifyHandler() {
  const hour = String(new Date().getUTCHours()).padStart(2, '0');
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  let people = 0, sent = 0;
  do {
    const r = await ddb.send(new QueryCommand({ TableName: TABLE, KeyConditionExpression: 'pk = :p', ExpressionAttributeValues: { ':p': `NOTIFY#${hour}` }, ExclusiveStartKey }));
    for (const it of r.Items ?? []) {
      people++;
      const [who, kind] = String(it.sk).split('#');
      try {
        // Reaprende os horários (sessões novas, aberturas, horário de verão): se mudou de balde, recebe no novo amanhã.
        const p = await setPrefs(who, {});
        if ((kind === 'open' ? p.bucket2 : p.bucket) !== `NOTIFY#${hour}`) continue;
        sent += (await (kind === 'open' ? sendNudge(who) : sendDaily(who))).sent;
      } catch (e) { log('notify.failed', { message: (e as Error).message.slice(0, 200) }); }
    }
    ExclusiveStartKey = r.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  log('notify.hour', { hour, people, sent });
  return { hour, people, sent };
}
