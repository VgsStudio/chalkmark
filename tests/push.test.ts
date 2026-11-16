import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanSubscription, dailyMessage, learnedHour, learnedOpenHour, nudgeMessage, secondHour, utcHourFor } from '../services/push.ts';

const TZ = 'America/Sao_Paulo'; // UTC-3, sem horário de verão
const at = (iso: string) => new Date(iso);

test('utcHourFor: 17h em São Paulo = 20h UTC', () => {
  assert.equal(utcHourFor(TZ, 17, at('2026-11-12T12:00:00Z')), 20);
  assert.equal(utcHourFor(TZ, 22, at('2026-11-12T12:00:00Z')), 1);
});

test('learnedHour: 1 h antes da hora em que costuma começar, entre 7 e 21', () => {
  const s = ['2026-11-03T21:10:00Z', '2026-11-05T21:40:00Z', '2026-11-10T22:05:00Z'].map((startedAt) => ({ startedAt })); // 18h-19h local
  assert.equal(learnedHour(s, TZ), 17);
  assert.equal(learnedHour([], TZ), 18);
  assert.equal(learnedHour([{ startedAt: '2026-11-10T09:00:00Z' }], TZ), 7); // 6h local → mínimo 7
});

test('cleanSubscription: só serviços de push conhecidos', () => {
  const keys = { p256dh: 'abc', auth: 'def' };
  assert.ok(cleanSubscription({ endpoint: 'https://web.push.apple.com/QGxyz', keys }));
  assert.ok(cleanSubscription({ endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys }));
  assert.equal(cleanSubscription({ endpoint: 'https://evil.example.com/x', keys }), null);
  assert.equal(cleanSubscription({ endpoint: 'http://fcm.googleapis.com/x', keys }), null);
  assert.equal(cleanSubscription({ endpoint: 'https://fcm.googleapis.com/x', keys: {} }), null);
});

test('dailyMessage: personalizada, pula quem já escalou hoje, prioriza sequência em risco no fim da semana', () => {
  const ctx = { name: 'Vitor', lang: 'pt' as const, tz: TZ, now: at('2026-11-14T20:00:00Z') }; // sábado 17h local
  const lastWeek = [{ startedAt: '2026-11-04T21:00:00Z' }, { startedAt: '2026-10-28T21:00:00Z' }];
  const risk = dailyMessage(lastWeek, [], {}, ctx)!;
  assert.match(risk.title, /Vitor, sua sequência de 2 semanas está em risco/);
  assert.equal(dailyMessage([...lastWeek, { startedAt: '2026-11-14T13:00:00Z' }], [], {}, ctx), null); // escalou hoje
  const project = [{ id: 'p1', color: 'purple', grade: 2, result: 'project', attempts: 1, createdAt: '2026-11-10T22:00:00Z' }];
  const tue = { ...ctx, now: at('2026-11-11T20:00:00Z') }; // quarta
  const msg = dailyMessage([{ startedAt: '2026-11-04T21:00:00Z' }], project, {}, tue)!;
  assert.match(msg.title, /Vitor, aquele roxo V2 ainda te espera/);
  assert.equal(msg.url, '/#/climb/p1');
});

test('dailyMessage: 1 dia em 4 vem uma variada (grau máximo, dias sem parede, marcos, amigo)', () => {
  const ctx = { name: 'Vitor', lang: 'pt' as const, tz: TZ, now: at('2026-11-10T20:00:00Z') }; // terça, dia "variado"
  const sends = [1, 2, 3].map((g, i) => ({ id: `c${i}`, color: 'blue', grade: g, result: 'sent', attempts: 1, createdAt: '2026-11-02T22:00:00Z' }));
  const msg = dailyMessage([{ startedAt: '2026-11-02T21:00:00Z' }], sends, {}, ctx)!;
  assert.match(msg.title, /^(⏳|📈|🏆|🤝) Vitor/);
  assert.doesNotMatch(msg.title + msg.body, /undefined|NaN/);
  const wed = dailyMessage([{ startedAt: '2026-11-02T21:00:00Z' }], sends, {}, { ...ctx, now: at('2026-11-11T20:00:00Z') })!;
  assert.match(wed.title, /^🧗 Vitor, bora manter/);
});

test('segundo aviso: horário de abrir o app (ou almoço), sempre a 3 h+ do lembrete', () => {
  assert.equal(learnedOpenHour([8, 8, 21, 8, 13]), 8);
  assert.equal(learnedOpenHour([8, 8]), null); // poucas aberturas
  assert.equal(secondHour(8, 17), 8);
  assert.equal(secondHour(16, 17), 12); // perto demais do lembrete: almoço
  assert.equal(secondHour(null, 11), 20);
});

test('nudgeMessage: sumido, meta da semana, divertida em alguns dias e folga nos outros', () => {
  const ctx = { name: 'Vitor', lang: 'pt' as const, tz: TZ, now: at('2026-11-13T15:00:00Z'), seed: 'u1' }; // sexta 12h
  const old = [{ startedAt: '2026-11-04T21:00:00Z' }];
  assert.match(nudgeMessage(old, { lastSeenAt: '2026-11-08T12:00:00Z' }, ctx)!.title, /Vitor, faz 5 dias que você não aparece/);
  assert.equal(nudgeMessage(old, { lastSeenAt: '2026-11-13T11:00:00Z' }, ctx), null); // já abriu hoje
  assert.match(nudgeMessage([{ startedAt: '2026-11-10T21:00:00Z' }], { weeklySessions: 3, lastSeenAt: '2026-11-12T12:00:00Z' }, ctx)!.body, /Faltam 2 sessões/);
  // Semana em dia e nada urgente: em 30 dias, algumas divertidas e alguns dias de folga, sem texto quebrado.
  const ok = [{ startedAt: '2026-11-10T21:00:00Z' }];
  const days = [...Array(30)].map((_, i) => nudgeMessage(ok, {}, { ...ctx, now: new Date(Date.parse('2026-11-10T15:00:00Z') + i * 86400_000) }));
  const sent = days.filter(Boolean);
  assert.ok(sent.length >= 12 && sent.length <= 26, String(sent.length));
  for (const m of sent) assert.doesNotMatch(m!.title + m!.body, /\{N\}|undefined/);
});
