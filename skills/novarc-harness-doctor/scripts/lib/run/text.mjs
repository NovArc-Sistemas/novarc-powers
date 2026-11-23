// The run's log is kept as events (log.jsonl); `build` turns each one into the line the board
// shows, in the language of the run. Keeping events rather than sentences is what lets a rebuild
// in another language, or a later wording fix, stay deterministic.

const clip = (s, n = 240) => {
  const t = String(s).replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

const VIA = { en: { board: 'on the board', chat: 'in chat' }, pt: { board: 'no painel', chat: 'no chat' } };
const ACTION = {
  en: { approve: 'Approved', decline: 'Declined', defer: 'Deferred', ask: 'Question asked' },
  pt: { approve: 'Aprovado', decline: 'Recusado', defer: 'Adiado', ask: 'Pergunta feita' },
};

const T = {
  en: {
    started: (e) => `Run started with ${e.harnesses} harness(es).`,
    unit: (e) => `Review unit ${e.unit} completed by ${e.session}: ${e.items} item(s).`,
    decisionGroup: (e, a, v) => `${a} ${v} for group ${e.target} (${e.count} item(s)).`,
    decision: (e, a, v) => `${a} ${v}.`,
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
