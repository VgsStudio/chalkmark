// Administração (#/admin): números, retenção, usuários, avaliações e avisos. Só para o grupo "admin".
import { useEffect, useState } from 'react';
import { api, fail, toast } from '../core.js';
import { claims, relTime } from './social.jsx';

export const isAdmin = () => [].concat(claims()['cognito:groups'] ?? []).includes('admin');

const pct = ([n, of]) => (of ? `${Math.round((n / of) * 100)}% (${n}/${of})` : '—');
const when = (iso) => (iso ? relTime(iso) : '—');
const day = (iso) => (iso ? new Date(iso).toLocaleDateString('pt-BR', { day: 'numeric', month: 'short' }) : '—');

export function Admin() {
  const [d, setD] = useState(null);
  const [sort, setSort] = useState('lastAccess');
  const load = () => api('/admin/overview').then(setD, (e) => { fail(e); setD({ error: true }); });
  useEffect(() => { load(); }, []);
  if (!isAdmin()) return <p className="muted">Sem acesso.</p>;
  if (!d) return <p className="muted">Carregando…</p>;
  if (d.error) return <p className="muted">Não deu para carregar.</p>;
  const users = [...d.users].sort((a, b) => (sort === 'climbs' ? b.climbs - a.climbs : String(b[sort] ?? '').localeCompare(String(a[sort] ?? ''))));
  const T = d.totals;
  return (
    <div className="stack admin">
      <div className="row"><button className="link" type="button" onClick={() => history.back()}>‹ Voltar</button></div>
      <h1>Administração</h1>

      <div className="admin-kpis">
        {[[T.users, 'usuários'], [T.active7, 'ativos 7 dias'], [T.active30, 'ativos 30 dias'], [T.withPush, `com notificação (${T.devices} aparelhos)`], [T.climbs, 'boulders']].map(([n, l]) => (
          <div key={l} className="card"><strong className="num">{n}</strong><div className="muted small">{l}</div></div>
        ))}
      </div>

      <Announce onSent={load} />
      {d.announcements.length > 0 && (
        <section className="card stack">
          <h2>Avisos enviados</h2>
          <ul className="list">{d.announcements.map((a) => (
            <li key={a.at}><strong>{a.title}</strong><div className="small">{a.body}</div><div className="muted small">{when(a.at)} · push para {a.people} pessoa(s), {a.sent} aparelho(s)</div></li>
          ))}</ul>
        </section>
      )}

      <section className="card stack">
        <h2>Retenção</h2>
        <p className="muted small">Por semana de cadastro: quem registrou algo de novo depois de 1, 2 e 4 semanas (só conta quem já teve esse tempo).</p>
        <div className="admin-table"><table>
          <thead><tr><th>Semana</th><th>Pessoas</th><th>Sem. 1</th><th>Sem. 2</th><th>Sem. 4</th></tr></thead>
          <tbody>{d.retention.map((c) => <tr key={c.week}><td>{day(c.week)}</td><td>{c.users}</td><td>{pct(c.w1)}</td><td>{pct(c.w2)}</td><td>{pct(c.w4)}</td></tr>)}</tbody>
        </table></div>
      </section>

      <section className="card stack">
        <div className="row"><h2 className="grow">Usuários</h2>
          <select value={sort} onChange={(e) => setSort(e.target.value)} aria-label="Ordenar">
            <option value="lastAccess">Último acesso</option><option value="signupAt">Cadastro</option><option value="climbs">Boulders</option>
          </select>
        </div>
        <div className="admin-table"><table>
          <thead><tr><th>Pessoa</th><th>Último acesso</th><th>Cadastro</th><th>Boulders</th><th>Dias ativos</th><th>Notificação</th></tr></thead>
          <tbody>{users.map((u) => (
            <tr key={u.sub}>
              <td>{u.handle ? <a href={`#/u/${u.handle}`}>{u.name || `@${u.handle}`}</a> : <span className="muted">sem perfil</span>}<div className="muted small">{u.email ?? u.sub.slice(0, 8)}{u.google ? ' · Google' : ''}</div></td>
              <td>{when(u.lastAccess)}</td>
              <td>{day(u.signupAt)}</td>
              <td>{u.climbs} <span className="muted small">({u.sends} mandados)</span></td>
              <td>{u.activeDays}</td>
              <td>{u.devices ? (u.pushOn === false ? 'desligou' : `${u.devices} aparelho(s)`) : '—'}{u.lastPushDay && <div className="muted small">último: {u.lastPushDay}{u.lastPushTitle ? ` · ${u.lastPushTitle}` : ''}</div>}</td>
            </tr>
          ))}</tbody>
        </table></div>
      </section>

      {d.feedback.length > 0 && (
        <section className="card stack">
          <h2>Avaliações</h2>
          <ul className="list">{d.feedback.map((f) => {
            const u = d.users.find((x) => x.sub === f.sub);
            return <li key={`${f.at}${f.sub}`}><strong>{'★'.repeat(f.stars)}</strong> <span className="muted small">{u?.handle ? `@${u.handle}` : f.sub.slice(0, 8)} · {when(f.at)}</span>{f.comment && <div className="small">{f.comment}</div>}</li>;
          })}</ul>
        </section>
      )}
    </div>
  );
}

function Announce({ onSent }) {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [ask, setAsk] = useState('');
  const [drafting, setDrafting] = useState(false);
  const draft = async () => {
    setDrafting(true);
    try { const r = await api('/admin/draft', { method: 'POST', body: { prompt: ask } }); setTitle(r.title); setBody(r.body); } catch (e) { fail(e); } finally { setDrafting(false); }
  };
  const send = async (test) => {
    if (!test && !confirm(`Mandar "${title}" para todo mundo? Vai como notificação e fica no sininho.`)) return;
    setBusy(true);
    try {
      const r = await api('/admin/announce', { method: 'POST', body: { title, body, test } });
      toast(test ? `Teste enviado (${r.sent} aparelho(s))` : `Enviado: ${r.people} pessoa(s), ${r.sent} aparelho(s)`);
      if (!test) { setTitle(''); setBody(''); onSent(); }
    } catch (e) { fail(e); } finally { setBusy(false); }
  };
  const ok = title.trim() && body.trim() && !busy;
  return (
    <section className="card stack">
      <h2>Novo aviso</h2>
      <label className="field"><span>Gerar com IA: diga o que quer avisar</span><textarea value={ask} maxLength={500} rows={2} onChange={(e) => setAsk(e.target.value)} placeholder="ex.: chamar a galera pra treinar no fim de semana e lembrar do ranking" /></label>
      <button className="btn block" type="button" disabled={!ask.trim() || drafting} onClick={draft}>{drafting ? 'Gerando…' : '✨ Gerar título e texto'}</button>
      <label className="field"><span>Título</span><input type="text" value={title} maxLength={60} onChange={(e) => setTitle(e.target.value)} placeholder="Chalkmark ficou mais rápido ⚡" /></label>
      <label className="field"><span>Texto</span><textarea value={body} maxLength={240} rows={3} onChange={(e) => setBody(e.target.value)} placeholder="O que mudou e um convite para abrir o app." /></label>
      {title && <div className="admin-preview"><img src="/icon.svg" alt="" width={36} height={36} /><div><strong>{title}</strong><div className="small">{body}</div></div></div>}
      <p className="muted small">Vai como notificação para quem ativou e aparece em Novidades (🔔) para todo mundo.</p>
      <div className="row">
        <button className="btn grow" type="button" disabled={!ok} onClick={() => send(true)}>Testar em mim</button>
        <button className="btn primary grow" type="button" disabled={!ok} onClick={() => send(false)}>Mandar para todos</button>
      </div>
    </section>
  );
}
