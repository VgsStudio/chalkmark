// Administração: visão geral (usuários, último acesso, notificações, retenção) e avisos para todos.
// Só para quem está no grupo "admin" do Cognito (claim cognito:groups do token).
import { CognitoIdentityProviderClient, ListUsersCommand } from '@aws-sdk/client-cognito-identity-provider';
import { PutCommand, QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, HttpError, nowIso, TABLE, USER_POOL_ID } from './common.ts';
import { pushTo } from './push.ts';

const DAY = 86400_000;
export const ANNOUNCE_PK = 'ANNOUNCE';

/** O autorizador do API Gateway entrega grupos como texto ("[admin other]"). */
export const isAdmin = (claims: Record<string, unknown> | undefined) => /(^|[\s\[,"])admin($|[\s\],"])/.test(String(claims?.['cognito:groups'] ?? ''));
export const requireAdmin = (claims: Record<string, unknown> | undefined) => { if (!isAdmin(claims)) throw new HttpError(403, 'FORBIDDEN'); };

type Item = Record<string, any>;
type Login = { sub: string; email?: string; createdAt?: string; status?: string; google?: boolean };

/** Junta tudo por pessoa e calcula os números. Pura (testada em tests/admin.test.ts). */
export function summarize(items: Item[], logins: Login[], now = new Date()) {
  const by = new Map<string, Item>();
  const get = (sub: string) => by.get(sub) ?? by.set(sub, { sub, sessions: [] as string[], climbs: 0, sends: 0, devices: 0 }).get(sub)!;
  const feedback: Item[] = [];
  for (const it of items) {
    if (it.pk === 'FEEDBACK') { feedback.push({ sub: String(it.sk).split('#')[1], stars: it.stars, comment: it.comment, at: it.createdAt }); continue; }
    if (!String(it.pk).startsWith('USER#')) continue;
    const u = get(String(it.pk).slice(5));
    const sk = String(it.sk);
    if (sk === 'PROFILE') Object.assign(u, { handle: it.handle, name: it.name });
    else if (sk === 'SETTINGS') Object.assign(u, { lastSeenAt: it.lastSeenAt, pushOn: it.pushOn, lastPushDay: it.lastPushDay, lastPushTitle: it.lastPushTitle, lastNudgeDay: it.lastNudgeDay });
    else if (sk.startsWith('SESSION#') && it.startedAt) u.sessions.push(it.startedAt);
    else if (sk.startsWith('CLIMB#')) { u.climbs++; if (it.result === 'sent' || it.result === 'flash') u.sends++; if (it.createdAt) u.sessions.push(it.createdAt); }
    else if (sk.startsWith('PUSH#')) u.devices++;
  }
  for (const l of logins) Object.assign(get(l.sub), { email: l.email, signupAt: l.createdAt, status: l.status, google: l.google });

  const t = now.getTime();
  const users: Item[] = [...by.values()].map(({ sessions, ...u }) => {
    const acts = (sessions as string[]).sort();
    const lastActivity = acts.at(-1);
    const lastAccess = [u.lastSeenAt, lastActivity].filter(Boolean).sort().at(-1) ?? null;
    const signupAt = u.signupAt ?? acts[0] ?? null;
    // Semanas (desde o cadastro) em que a pessoa registrou algo: base da retenção.
    const weeks: number[] = signupAt ? [...new Set(acts.map((a) => Math.floor((Date.parse(a) - Date.parse(signupAt)) / (7 * DAY))))].filter((w) => w >= 0) : [];
    return { ...u, signupAt, lastAccess, lastActivity: lastActivity ?? null, activeDays: new Set(acts.map((a) => a.slice(0, 10))).size, weeks };
  }).sort((a, b) => String(b.lastAccess ?? '').localeCompare(String(a.lastAccess ?? '')));

  const within = (iso: string | null, days: number) => !!iso && t - Date.parse(iso) < days * DAY;
  // Retenção por semana de cadastro: de quem já teve tempo, quantos voltaram na semana N.
  const cohorts = new Map<string, Item>();
  for (const u of users) {
    if (!u.signupAt) continue;
    const d = new Date(u.signupAt); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
    const key = d.toISOString().slice(0, 10);
    const c = cohorts.get(key) ?? cohorts.set(key, { week: key, users: 0, w1: [0, 0], w2: [0, 0], w4: [0, 0] }).get(key)!;
    c.users++;
    const age = Math.floor((t - Date.parse(u.signupAt)) / (7 * DAY));
    for (const [k, w] of [['w1', 1], ['w2', 2], ['w4', 4]] as const) if (age >= w) { c[k][1]++; if (u.weeks.some((x: number) => x >= w)) c[k][0]++; }
  }
  return {
    totals: {
      users: users.length,
      active7: users.filter((u) => within(u.lastAccess, 7)).length,
      active30: users.filter((u) => within(u.lastAccess, 30)).length,
      withPush: users.filter((u) => u.devices > 0 && u.pushOn !== false).length,
      devices: users.reduce((n, u) => n + u.devices, 0),
      climbs: users.reduce((n, u) => n + u.climbs, 0),
    },
    retention: [...cohorts.values()].sort((a, b) => b.week.localeCompare(a.week)),
    users: users.map(({ weeks: _w, ...u }) => u),
    feedback: feedback.sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 30),
  };
}

async function scanAll() {
  const out: Item[] = [];
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  // ponytail: Scan da tabela toda (só o que precisa); com milhares de contas, contadores por pessoa.
  do {
    const r = await ddb.send(new ScanCommand({
      TableName: TABLE, ExclusiveStartKey,
      FilterExpression: 'begins_with(pk, :u) OR pk = :f',
      ProjectionExpression: 'pk, sk, handle, #n, lastSeenAt, pushOn, lastPushDay, lastPushTitle, lastNudgeDay, startedAt, createdAt, #r, stars, #c',
      ExpressionAttributeNames: { '#n': 'name', '#r': 'result', '#c': 'comment' },
      ExpressionAttributeValues: { ':u': 'USER#', ':f': 'FEEDBACK' },
    }));
    out.push(...(r.Items ?? []));
    ExclusiveStartKey = r.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return out;
}

const cognito = new CognitoIdentityProviderClient({});
async function logins(): Promise<Login[]> {
  if (!USER_POOL_ID) return [];
  const out: Login[] = [];
  let PaginationToken: string | undefined;
  do {
    const r = await cognito.send(new ListUsersCommand({ UserPoolId: USER_POOL_ID, PaginationToken }));
    for (const u of r.Users ?? []) {
      const attr = (n: string) => u.Attributes?.find((a) => a.Name === n)?.Value;
      out.push({ sub: attr('sub')!, email: attr('email'), createdAt: u.UserCreateDate?.toISOString(), status: u.UserStatus, google: !!attr('identities') });
    }
    PaginationToken = r.PaginationToken;
  } while (PaginationToken);
  return out.filter((l) => l.sub);
}

export async function announcements(limit = 20) {
  const r = await ddb.send(new QueryCommand({ TableName: TABLE, KeyConditionExpression: 'pk = :p', ExpressionAttributeValues: { ':p': ANNOUNCE_PK }, ScanIndexForward: false, Limit: limit }));
  return (r.Items ?? []).map(({ sk, title, body, sent, people }) => ({ at: sk, title, body, sent, people }));
}

export async function overview() {
  const [items, ls, news] = await Promise.all([scanAll(), logins(), announcements()]);
  return { ...summarize(items, ls), announcements: news };
}

/** Aviso: push para quem tem notificação ligada e, se não for teste, fica no sininho de todo mundo. */
export async function announce(sub: string, a: { title: string; body: string; test: boolean }) {
  const payload = { title: a.title, body: a.body, url: '/', tag: `aviso-${Date.now()}` };
  if (a.test) return { people: 1, sent: await pushTo(sub, payload) };
  const subs = new Set<string>();
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const r = await ddb.send(new ScanCommand({ TableName: TABLE, ExclusiveStartKey, FilterExpression: 'begins_with(sk, :p)', ProjectionExpression: 'pk', ExpressionAttributeValues: { ':p': 'PUSH#' } }));
    for (const it of r.Items ?? []) subs.add(String(it.pk).slice(5));
    ExclusiveStartKey = r.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  // Quem desligou as notificações nos Ajustes não recebe o push (mas vê no sininho).
  let sent = 0, people = 0;
  for (const s of subs) {
    const st = await ddb.send(new QueryCommand({ TableName: TABLE, KeyConditionExpression: 'pk = :p AND sk = :s', ExpressionAttributeValues: { ':p': `USER#${s}`, ':s': 'SETTINGS' }, ProjectionExpression: 'pushOn' }));
    if (st.Items?.[0]?.pushOn === false) continue;
    people++;
    sent += await pushTo(s, payload);
  }
  await ddb.send(new PutCommand({ TableName: TABLE, Item: { pk: ANNOUNCE_PK, sk: nowIso(), title: a.title, body: a.body, by: sub, sent, people } }));
  return { people, sent };
}
