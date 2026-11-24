// The run's log is kept as events (log.jsonl); `build` turns each one into the line the board
// shows, in the language of the run. Keeping events rather than sentences is what lets a rebuild
// in another language, or a later wording fix, stay deterministic.
//
// The same goes for what a review leaves behind to be read: the `.md` next to each review record
// and the listing of `run.mjs history` are written here, in English and in Portuguese.

import { STRINGS, LOCALES, compactTokens, plural, fill, label } from '../i18n.mjs';
import { gradeFor } from '../scoring.mjs';

const clip = (s, n = 240) => {
  const t = String(s).replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

const VIA = { en: { board: 'on the board', chat: 'in chat' }, pt: { board: 'no painel', chat: 'no chat' } };
const ACTION = {
  en: { approve: 'Approved', decline: 'Declined', defer: 'Deferred', ask: 'Question asked' },
  pt: { approve: 'Aprovado', decline: 'Recusado', defer: 'Adiado', ask: 'Pergunta feita' },
};

const WAS = {
  en: { approved: 'approved', declined: 'declined', deferred: 'deferred' },
  pt: { approved: 'aprovada', declined: 'recusada', deferred: 'adiada' },
};

const T = {
  en: {
    started: (e) => `Run started with ${e.harnesses} harness(es).`,
    unit: (e) => `Review unit ${e.unit} completed by ${e.session}: ${e.items} item(s).`,
    decisionGroup: (e, a, v) => `${a} ${v} for group ${e.target} (${e.count} item(s)).`,
    decision: (e, a, v) => `${a} ${v}.`,
    staleGroup: (e, a, v) => `Decision not applied (${a} ${v}) for group ${e.target}: it was made on an earlier version of the group.`,
    stale: (e, a, v) => `Decision not applied (${a} ${v}): it was made on an earlier version of this proposal.`,
    invalidated: (e, was) => `The proposal changed after it was ${was}: that decision no longer applies and the item is open again.`,
    reopened: (e, was) => `Open again: after it was ${was}, another decision arrived that was made on an earlier version of this proposal.`,
    primary: (e) => `Primary account set to ${e.account}.`,
    answered: () => 'Question answered.',
    applying: (e) => (e.auto ? 'Applying automatically (doctor mode, safe class).' : 'Applying.'),
    fixed: 'Fixed.',
    failed: 'Failed.',
    verified: 'Verified',
    notVerified: 'Not verified',
    undo: (e) => `Change undone: ${e.restored} file(s) restored${e.conflicts ? `, ${e.conflicts} left alone because they were edited since` : ''}.`,
    closed: () => 'Run closed.',
  },
  pt: {
    started: (e) => `Revisão iniciada com ${e.harnesses} harness(es).`,
    unit: (e) => `Unidade de revisão ${e.unit} concluída por ${e.session}: ${e.items} item(ns).`,
    decisionGroup: (e, a, v) => `${a} ${v} para o grupo ${e.target} (${e.count} item(ns)).`,
    decision: (e, a, v) => `${a} ${v}.`,
    staleGroup: (e, a, v) => `Decisão não aplicada (${a} ${v}) para o grupo ${e.target}: foi tomada sobre uma versão anterior do grupo.`,
    stale: (e, a, v) => `Decisão não aplicada (${a} ${v}): foi tomada sobre uma versão anterior desta proposta.`,
    invalidated: (e, was) => `A proposta mudou depois de ${was}: essa decisão deixou de valer e o item voltou a ficar em aberto.`,
    reopened: (e, was) => `Em aberto de novo: depois de ${was}, chegou outra decisão tomada sobre uma versão anterior desta proposta.`,
    primary: (e) => `Conta principal definida: ${e.account}.`,
    answered: () => 'Pergunta respondida.',
    applying: (e) => (e.auto ? 'Aplicando automaticamente (modo doctor, classe segura).' : 'Aplicando.'),
    fixed: 'Corrigido.',
    failed: 'Falhou.',
    verified: 'Verificado',
    notVerified: 'Não verificado',
    undo: (e) => `Mudança desfeita: ${e.restored} arquivo(s) restaurado(s)${e.conflicts ? `, ${e.conflicts} mantido(s) porque foram editados depois` : ''}.`,
    closed: () => 'Revisão encerrada.',
  },
};

/** The board's log line for one event, or null for an event the board does not show. */
export function logText(e, language) {
  const lang = language === 'pt' ? 'pt' : 'en';
  const t = T[lang];
  switch (e.event) {
    case 'run-started': return t.started(e);
    case 'unit-complete': return t.unit(e);
    case 'decision': {
      const a = ACTION[lang][e.action];
      if (!a) return null;
      const v = VIA[lang][e.via === 'chat' ? 'chat' : 'board'];
      const base = e.count !== undefined ? t.decisionGroup(e, a, v) : t.decision(e, a, v);
      return e.note ? `${base} ${clip(e.note)}` : base;
    }
    case 'stale-decision': {
      const a = ACTION[lang][e.action];
      if (!a) return null;
      const v = VIA[lang][e.via === 'chat' ? 'chat' : 'board'];
      return typeof e.target === 'string' ? t.staleGroup(e, a, v) : t.stale(e, a, v);
    }
    case 'decision-invalidated': {
      const was = WAS[lang][e.was];
      return was ? t.invalidated(e, was) : null;
    }
    case 'decision-reopened': {
      const was = WAS[lang][e.was];
      return was ? t.reopened(e, was) : null;
    }
    case 'primary': return t.primary(e);
    case 'answered': return t.answered(e);
    case 'mark': {
      if (e.status === 'in-progress') return t.applying(e);
      if (e.status !== 'fixed' && e.status !== 'failed') return null;
      const parts = [e.status === 'fixed' ? t.fixed : t.failed];
      if (e.verified) parts.push(`${t.verified}: ${clip(e.verified)}`);
      if (e.notVerified) parts.push(`${t.notVerified}: ${clip(e.notVerified)}`);
      return parts.join(' ');
    }
    case 'undo': return t.undo(e);
    case 'run-closed': return t.closed(e);
    default: return null;
  }
}

// ---------------------------------------------------------------------------------------------
// A review record, to read (history/<harness>/<run>.md), and the listing of `run.mjs history`
//
// Both are for people. Measures, units, verdicts, checks, severities, classes and statuses carry
// the names the board gives them (scripts/lib/i18n.mjs), and numbers are compact the way the
// board writes them (57.2M, 111.2k, 5%; in Portuguese 57,2 mi, 111,2 mil, 5%). What only these
// two texts say is worded here, in English and in Portuguese.
// ---------------------------------------------------------------------------------------------

const day = (at) => String(at).slice(0, 10);
const upperFirst = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const lowerFirst = (s) => (s ? s[0].toLowerCase() + s.slice(1) : s);
const unitOf = (metric) => (metric === 'waste-share' ? 'percent' : metric === 'tool-output' ? 'chars/session' : 'tokens/session');
/** A text inside a table cell or a list line: one line, no cell separator. */
const cell = (s) => clip(s).replace(/\|/g, '/');

/** The number formats of one language, the same as the board's. */
function formats(lang) {
  const num1 = (n) => (Math.round(n * 10) / 10).toLocaleString(LOCALES[lang], { maximumFractionDigits: 1 });
  const sign = (n) => (n > 0 ? '+' : n < 0 ? '-' : '');
  return {
    tokens: (n) => compactTokens(n, lang),
    signedTokens: (n) => `${sign(n)}${compactTokens(Math.abs(n), lang)}`,
    // A score is floored, never rounded up.
    score: (n) => (Math.floor(n * 10 + 1e-7) / 10).toLocaleString(LOCALES[lang], { maximumFractionDigits: 1 }),
    metric: (v, unit) => (typeof v !== 'number' ? null : unit === 'percent' ? `${num1(v)}%` : compactTokens(v, lang)),
    change: (pct) => (typeof pct !== 'number' ? '-' : `${sign(pct)}${num1(Math.abs(pct))}%`),
  };
}

const REC = {
  en: {
    title: 'Review of {name}, {date}',
    harness: 'Harness: {name} ({kind}), `{path}`',
    started: 'started {date}',
    asFound: '{baseline} as found, {current} after this review, {projected} once what was approved is applied',
    applied: 'Last change applied: {date}',
    nothingApplied: 'No change was applied.',
    followUpFrom: 'Follow-up from: {date}',
    thisReview: 'This review',
    measured: 'Measured',
    days: { one: '1 day', other: '{n} days' },
    sessions: { one: '1 session', other: '{n} sessions' },
    perSession: 'Every number is per session.',
    value: 'Value',
    notMeasured: { 'shared-sessions': 'Not measured here: this account shares its sessions with another harness of the run.', 'not-measured': 'Not measured in this review.' },
    sections: [
      ['fixed', 'Fixed'], ['failed', 'Failed'], ['approved', 'Approved, not applied yet'], ['in-progress', 'Being applied'],
      ['declined', 'Declined'], ['deferred', 'Deferred'], ['open', 'Open'], ['ok', 'Nothing to change'], ['not-applicable', 'Does not apply'],
    ],
    decided: '{word} on {date}.',
    fixedOn: 'Fixed on {date}.',
    changed: 'Changed',
    seenBefore: 'Same finding as {item} of run {run}.',
    none: 'No item in this review.',
    history: {
      title: { one: 'Review history: 1 harness', other: 'Review history: {n} harnesses' },
      empty: 'No review recorded yet.',
      emptyFor: 'No review recorded for that harness.',
      fixed: { one: '1 fixed', other: '{n} fixed' },
      due: 'Follow-up due since {date}.',
      notDue: { one: 'Follow-up from {date} (in 1 day).', other: 'Follow-up from {date} (in {n} days).' },
      unrecorded: 'Runs without a review record: {ids}. Write them with: run.mjs history --write --run <id>',
    },
  },
  pt: {
    title: 'Revisão de {name}, {date}',
    harness: 'Harness: {name} ({kind}), `{path}`',
    started: 'iniciada em {date}',
    asFound: '{baseline} como foi encontrado, {current} depois desta revisão, {projected} quando o que foi aprovado estiver aplicado',
    applied: 'Última mudança aplicada: {date}',
    nothingApplied: 'Nenhuma mudança foi aplicada.',
    followUpFrom: 'Acompanhamento a partir de: {date}',
    thisReview: 'Esta revisão',
    measured: 'Medido',
    days: { one: '1 dia', other: '{n} dias' },
    sessions: { one: '1 sessão', other: '{n} sessões' },
    perSession: 'Todo número é por sessão.',
    value: 'Valor',
    notMeasured: { 'shared-sessions': 'Não medido aqui: esta conta divide as sessões com outro harness da revisão.', 'not-measured': 'Não medido nesta revisão.' },
    sections: [
      ['fixed', 'Corrigidos'], ['failed', 'Falharam'], ['approved', 'Aprovados, ainda não aplicados'], ['in-progress', 'Em aplicação'],
      ['declined', 'Recusados'], ['deferred', 'Adiados'], ['open', 'Em aberto'], ['ok', 'Nada a mudar'], ['not-applicable', 'Não se aplica'],
    ],
    decided: '{word} em {date}.',
    fixedOn: 'Corrigido em {date}.',
    changed: 'Alterado',
    seenBefore: 'Mesmo achado que {item} da execução {run}.',
    none: 'Nenhum item nesta revisão.',
    history: {
      title: { one: 'Histórico de revisões: 1 harness', other: 'Histórico de revisões: {n} harnesses' },
      empty: 'Nenhuma revisão registrada ainda.',
      emptyFor: 'Nenhuma revisão registrada para esse harness.',
      fixed: { one: '1 corrigido', other: '{n} corrigidos' },
      due: 'Acompanhamento pendente desde {date}.',
      notDue: { one: 'Acompanhamento a partir de {date} (em 1 dia).', other: 'Acompanhamento a partir de {date} (em {n} dias).' },
      unrecorded: 'Execuções sem registro de revisão: {ids}. Para gravar: run.mjs history --write --run <id>',
    },
  },
};

/**
 * "Since the last review": what a follow-up is read for. The comparison of the record's `outcome`
 * (the `followUp` object of the state) as text: the lead, the scores, the metric table with its
 * verdicts, the totals, each fixed item with its on-disk check, what was left undone, and the
 * note on what a comparison is.
 */
function sinceLastReview(o, lang) {
  const T = STRINGS[lang];
  const F = T.fu;
  const f = formats(lang);
  const out = [`## ${F.h}`, ''];
  const sample = o.sample || {};
  const waiting = sample.enough === false;

  const lead = [plural(F.sub, o.days, { date: day(o.of.reviewedAt) })];
  if (typeof sample.sessions === 'number') lead.push(`${upperFirst(plural(F.sessions, sample.sessions))}.`);
  const expected = o.metrics.filter((m) => typeof m.expected === 'number');
  if (waiting) lead.push(`${F.waitH}: ${sample.readyAt ? fill(F.readyAt, { date: day(sample.readyAt) }) : label(F.reason, sample.reason)}.`);
  else if (expected.length) lead.push(`${upperFirst(plural(F.effects, expected.length, { confirmed: expected.filter((m) => m.verdict === 'confirmed').length }))}.`);
  else lead.push(`${upperFirst(F.noExpectation)}.`);
  out.push(lead.join(' '), '');

  const score = (v) => (typeof v === 'number' ? `${f.score(v)} (${gradeFor(v)})` : T.notScored);
  const sc = o.score || {};
  if ([sc.then, sc.expected, sc.now].some((v) => typeof v === 'number')) {
    out.push(`${upperFirst(F.scoreThen)}: ${score(sc.then)} · ${F.scoreExpected}: ${score(sc.expected)} · ${F.scoreNow}: ${score(sc.now)}`, '');
  }

  if (o.metrics.length) {
    const C = F.col;
    out.push(`| ${C.metric} | ${C.before} | ${C.expected} | ${C.now} | ${C.change} | ${C.verdict} |`, '|---|---|---|---|---|---|');
    // What was expected comes first: it is what the reader came back to check.
    for (const m of [...expected, ...o.metrics.filter((x) => typeof x.expected !== 'number')]) {
      const unit = m.unit || unitOf(m.metric);
      out.push(`| ${label(F.metric, m.metric)} (${label(F.unit, unit)}) | ${f.metric(m.before, unit) ?? T.notMeasured} | ${f.metric(m.expected, unit) ?? '-'} | ${f.metric(m.after, unit) ?? T.notMeasured} | ${f.change(m.changePct)} | ${label(F.verdict, m.verdict)} |`);
    }
    out.push('');
  } else out.push(F.metricsNone, '');

  const sum = o.summary || {};
  const totals = [];
  if (typeof sum.expectedTokensPerSession === 'number') totals.push(`${F.sumExpected}: ${f.tokens(sum.expectedTokensPerSession)}`);
  if (typeof sum.observedTokensPerSession === 'number') totals.push(`${F.sumObserved}: ${f.signedTokens(sum.observedTokensPerSession)}`);
  for (const [key, forms] of [['inPlace', F.sumInPlace], ['reverted', F.sumReverted], ['cameBack', F.sumCameBack]]) {
    if (typeof sum[key] === 'number') totals.push(`${sum[key]} ${plural(forms, sum[key])}`);
  }
  if (totals.length) out.push(`${upperFirst(totals.join(' · '))}`, '');

  const nowOf = (i) => (i.now ? ` · ${lowerFirst(F.col.nowItem)}: ${i.now}` : '');
  const fixed = o.items.filter((i) => i.status === 'fixed');
  out.push(`### ${F.fixedH}`, '');
  if (!fixed.length) out.push(F.fixedNone);
  for (const i of fixed) {
    const bits = [label(F.check, i.check || 'not-checked')];
    if (Array.isArray(i.paths) && i.paths.length) bits.push(i.paths.map((p) => `\`${p}\``).join(', '));
    if (typeof i.saves === 'number') bits.push(`${lowerFirst(F.col.saving)} ${fill(F.saved, { tokens: f.tokens(i.saves) })}`);
    out.push(`- **${i.id}** ${cell(i.title)}: ${bits.join(' · ')}${nowOf(i)}`);
  }
  out.push('');
  const carried = o.items.filter((i) => i.status !== 'fixed');
  if (carried.length) {
    out.push(`### ${plural(F.carriedH, carried.length)}`, '');
    for (const i of carried) out.push(`- **${i.id}** ${cell(i.title)}: ${label(T.status, i.status)}${nowOf(i)}`);
    out.push('');
  }
  out.push(F.note, '');
  return out;
}

/**
 * The `.md` that sits next to a review record: the same content, to read. The record of a
 * follow-up leads with the comparison, since that is what its reader came back for.
 */
export function recordMarkdown(record, language) {
  const lang = language === 'pt' ? 'pt' : 'en';
  const T = STRINGS[lang];
  const t = REC[lang];
  const f = formats(lang);
  const o = record.outcome;
  const out = [`# ${fill(t.title, { name: record.name, date: day(record.reviewedAt) })}`, ''];
  if (o) out.push(...sinceLastReview(o, lang), `## ${t.thisReview}`, '');

  const s = record.scores;
  const score = (v) => (typeof v === 'number' ? f.score(v) : T.notScored);
  out.push(`- ${fill(t.harness, { name: record.name, kind: label(T.harnessKindLong, record.kind), path: record.path })}`);
  out.push(`- ${T.by.run}: ${record.runId}, ${fill(t.started, { date: day(record.startedAt) })}${o ? `. ${T.fu.runOf} ${day(o.of.reviewedAt)} (${o.of.runId})` : ''}`);
  out.push(`- ${T.col.score}: ${[s.baseline, s.current, s.projected].some((v) => typeof v === 'number')
    ? `${fill(t.asFound, { baseline: score(s.baseline), current: score(s.current), projected: score(s.projected) })}${s.grade ? ` (${lowerFirst(T.col.grade)} ${s.grade})` : ''}`
    : T.notScored}`);
  out.push(`- ${record.changesAppliedAt ? fill(t.applied, { date: day(record.changesAppliedAt) }) : t.nothingApplied}`);
  out.push(`- ${fill(t.followUpFrom, { date: day(record.followUpAfter) })}`, '');

  out.push(`## ${t.measured}`, '');
  const m = record.measure;
  if (m) {
    out.push(`${plural(t.days, m.window.days)}, ${plural(t.sessions, m.sessions)}. ${t.perSession}`, '');
    const rows = Object.entries(m.metrics);
    if (rows.length) {
      out.push(`| ${T.fu.col.metric} | ${t.value} |`, '|---|---|');
      for (const [metric, value] of rows) out.push(`| ${label(T.fu.metric, metric)} (${label(T.fu.unit, unitOf(metric))}) | ${f.metric(value, unitOf(metric))} |`);
      out.push('');
    }
  } else out.push(record.measureSkipped === 'no-transcript-reader' ? T.imp.skippedNoReader : (t.notMeasured[record.measureSkipped] || t.notMeasured['not-measured']), '');

  if (!record.items.length) out.push(t.none, '');
  for (const [status, heading] of t.sections) {
    const items = record.items.filter((i) => i.status === status);
    if (!items.length) continue;
    out.push(`## ${heading} (${items.length})`, '');
    for (const i of items) {
      out.push(`- **${i.id}** ${cell(i.title)} (${label(T.severity, i.severity)}, ${label(T.class, i.class)})`);
      if (i.decision) {
        const word = (ACTION[lang][i.decision.action] || i.decision.action).toLowerCase();
        out.push(`  - ${T.field.decision}: ${fill(t.decided, { word, date: day(i.decision.at) })}${i.decision.note ? ` "${clip(i.decision.note)}"` : ''}`);
      }
      if (i.fixedAt) out.push(`  - ${fill(t.fixedOn, { date: day(i.fixedAt) })}`);
      if (i.verified) out.push(`  - ${T.field.verified}: ${clip(i.verified)}`);
      if (i.notVerified) out.push(`  - ${T.field.notVerified}: ${clip(i.notVerified)}`);
      if (i.saves) {
        const where = i.saves.metric ? `; ${fill(T.fu.checkedIn, { metric: label(T.fu.metric, i.saves.metric) })}` : '';
        out.push(`  - ${T.field.saves}: ${fill(T.fu.saved, { tokens: f.tokens(i.saves.tokens) })} (${label(T.basis, i.saves.basis)})${where}`);
      }
      if (i.principle) out.push(`  - ${T.lesson.principle}: ${clip(i.principle)}`);
      if (i.changes && i.changes.length) out.push(`  - ${t.changed}: ${[...new Set(i.changes.map((c) => c.path))].map((p) => `\`${p}\``).join(', ')}`);
      if (i.previous) out.push(`  - ${fill(t.seenBefore, { item: i.previous.item, run: i.previous.run })}`);
    }
    out.push('');
  }
  return `${out.join('\n').replace(/\n+$/, '')}\n`;
}

/**
 * What `run.mjs history` prints for a person. `report` is its JSON output: `{ at, harnesses:
 * [{ key, kind, name, path, reviews, followUpAfter, due }], unrecordedRuns }`.
 */
export function historyText(report, language, { filtered = false } = {}) {
  const lang = language === 'pt' ? 'pt' : 'en';
  const T = STRINGS[lang];
  const h = REC[lang].history;
  const f = formats(lang);
  const out = [];
  if (!report.harnesses.length) out.push(filtered ? h.emptyFor : h.empty);
  else {
    out.push(plural(h.title, report.harnesses.length));
    const now = Date.parse(report.at);
    for (const x of report.harnesses) {
      out.push('', `${x.name} (${label(T.harnessKindLong, x.kind)}) ${x.path} [${x.key}]`);
      for (const r of x.reviews) {
        const bits = [day(r.reviewedAt), `${lowerFirst(T.by.run)} ${r.runId}`];
        bits.push(typeof r.score === 'number' ? `${lowerFirst(T.col.score)} ${f.score(r.score)}${r.grade ? ` (${r.grade})` : ''}` : T.notScored);
        bits.push(plural(h.fixed, r.fixed));
        if (r.expectedTokens > 0) bits.push(`${lowerFirst(T.field.saves)} ${fill(T.fu.saved, { tokens: f.tokens(r.expectedTokens) })}`);
        out.push(`  ${bits.join('  ')}`);
      }
      out.push(`  ${x.due ? fill(h.due, { date: day(x.followUpAfter) }) : plural(h.notDue, Math.max(1, Math.ceil((Date.parse(x.followUpAfter) - now) / 86400000)), { date: day(x.followUpAfter) })}`);
    }
  }
  if (report.unrecordedRuns && report.unrecordedRuns.length) out.push('', fill(h.unrecorded, { ids: report.unrecordedRuns.join(', ') }));
  return `${out.join('\n')}\n`;
}
