// Checks on markdown the agent reads: instruction files, rules, skills, agents and commands.
import path from 'node:path';
import { parseImports } from '../../discover.mjs';
import { finding, frontmatter, lineAt, proseOnly, safeSnippet } from './util.mjs';

const ZERO_WIDTH = /[​-‍⁠᠎]|(?!^)﻿/g;
const BIDI = /[‪-‮⁦-⁩]/g;
const TAG_CHARS = /[\u{E0000}-\u{E007F}]/gu;
const COMMENT = /<!--([\s\S]*?)-->/g;
const TOOL_COMMENT = /^\s*(markdownlint|prettier-ignore|toc|eslint|cspell|vale|lint|begin|end|start|stop|omit|include|region|endregion|@|#)/i;
const IMPERATIVE = /\b(ignore|disregard|override|forget|pretend|do not (tell|mention|reveal|show|inform)|don't (tell|mention|reveal)|you (must|should|are now|will)|always|never|execute|run|curl|wget|send|upload|exfiltrat\w*|system prompt|secretly|without (asking|telling))\b/i;
// Each run of base64 characters is visited once (a `{200,}` quantifier rescans every start
// position and is slow on large files); runs shorter than 200 are skipped in code.
const BASE64_RUN = /[A-Za-z0-9+/]+={0,2}/g;

const ALL_KINDS = new Set(['instruction', 'rule', 'skill', 'agent', 'command']);
const docWhere = (d, line) => ({ ...d, line });
const codePoints = (s) => [...new Set([...s].map((c) => `U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`))].slice(0, 4).join(', ');

export const instructionsHiddenText = {
  id: 'instructions-hidden-text', round: 1, severity: 'high',
  title: 'Hidden or encoded text in a file the agent reads',
  why: 'The agent reads invisible characters, HTML comments and encoded blobs that a person reviewing the file never sees, which is how instructions get smuggled into a harness.',
  fix: 'Open the file in an editor that shows invisible characters, delete what you did not write on purpose, and find out how it got there.',
  run(model) {
    const out = [];
    for (const d of model.docs) {
      if (!ALL_KINDS.has(d.kind)) continue;
      const t = d.text;
      for (const [re, label] of [[ZERO_WIDTH, 'zero-width'], [BIDI, 'bidirectional control'], [TAG_CHARS, 'Unicode tag']]) {
        re.lastIndex = 0;
        const hits = [...t.matchAll(re)];
        if (hits.length) out.push(finding(this, docWhere(d, lineAt(t, hits[0].index)), `${hits.length} ${label} character(s) (${codePoints(hits.map((h) => h[0]).join(''))})`));
      }
      COMMENT.lastIndex = 0;
      for (const m of t.matchAll(COMMENT)) {
        const inner = m[1].trim();
        if (!inner || TOOL_COMMENT.test(inner)) continue;
        if (inner.split(/\s+/).length < 4 || !IMPERATIVE.test(inner)) continue;
        out.push(finding(this, docWhere(d, lineAt(t, m.index)), `HTML comment with instructions: "${safeSnippet(inner, model.projectRoot, 100)}"`));
      }
      BASE64_RUN.lastIndex = 0;
      for (const m of t.matchAll(BASE64_RUN)) {
        if (m[0].length < 200) continue;
        const before = t.slice(Math.max(0, m.index - 12), m.index);
        if (/base64,\s*$/i.test(before)) continue; // data: URI of an image
        if (!/[0-9]/.test(m[0]) || !/[A-Z]/.test(m[0]) || !/[a-z]/.test(m[0])) continue;
        out.push(finding(this, docWhere(d, lineAt(t, m.index)), `encoded blob of ${m[0].length} characters starting "${m[0].slice(0, 12)}…"`));
        break;
      }
    }
    return out;
  },
};

const EXTERNAL_IMPORT = /(^|\s)@(https?:\/\/[^\s`'"<>)]+)/gm;
const FETCH_VERB = /\b(read|fetch|load|follow|import|download|curl|wget|retrieve|obey|apply)\b[^.\n]{0,60}?(https?:\/\/[^\s`'"<>)\]]+)/gi;

function urlLabel(u) {
  try { const x = new URL(u); return `${x.host}${x.pathname.length > 40 ? `${x.pathname.slice(0, 40)}…` : x.pathname}`; } catch { return 'unparseable URL'; }
}

export const instructionsExternalImport = {
  id: 'instructions-external-import', round: 1, severity: 'medium',
  title: 'Instructions pull content from outside the machine',
  why: 'Whoever controls that URL can change what your agent is told on the next session, without any change to your files.',
  fix: 'Copy the content you need into a local file you review, and import or point to that file instead.',
  run(model) {
    const out = [];
    for (const d of model.docs) {
      if (d.kind !== 'instruction' && d.kind !== 'rule') continue;
      const prose = d.text.replace(/^(```|~~~)[\s\S]*?^\1[^\n]*$/gm, (b) => b.replace(/[^\n]/g, ' '));
      const seen = new Set();
      for (const re of [EXTERNAL_IMPORT, FETCH_VERB]) {
        re.lastIndex = 0;
        for (const m of prose.matchAll(re)) {
          const label = urlLabel(m[2]);
          if (seen.has(label)) continue;
          seen.add(label);
          const what = re === EXTERNAL_IMPORT ? 'imports' : `says "${m[1]}" for`;
          const at = re === EXTERNAL_IMPORT ? m.index + m[1].length : m.index;
          out.push(finding(this, docWhere(d, lineAt(prose, at)), `${what} ${safeSnippet(label, model.projectRoot, 80)}`));
        }
      }
    }
    return out;
  },
};

const BANG_EXEC = /!`([^`\n]+)`/g;
const ARG_REF = /\$(ARGUMENTS\b|\{ARGUMENTS\}|[1-9]\b|\{[1-9]\})/;

export const skillShellInjection = {
  id: 'skill-shell-injection', round: 1, severity: 'medium',
  title: 'Command or skill puts user arguments straight into a shell',
  why: 'Text typed after the command is pasted into the shell line before it runs, so an argument containing `;` or `$(...)` runs whatever it says.',
  fix: 'Do not interpolate arguments into a pre-run shell line; let the agent read the arguments and pass them as a quoted, validated value instead.',
  run(model) {
    const out = [];
    for (const d of model.docs) {
      if (d.kind !== 'skill' && d.kind !== 'command') continue;
      BANG_EXEC.lastIndex = 0;
      for (const m of d.text.matchAll(BANG_EXEC)) {
        if (!ARG_REF.test(m[1])) continue;
        out.push(finding(this, docWhere(d, lineAt(d.text, m.index)), `pre-run shell line: !\`${safeSnippet(m[1], model.projectRoot, 100)}\``));
      }
      const fence = /^(```|~~~)\s*(bash|sh|shell|zsh|powershell|pwsh|ps1|cmd)?\s*\n([\s\S]*?)^\1/gm;
      for (const m of d.text.matchAll(fence)) {
        const body = m[3];
        const lines = body.split('\n');
        // Only $ARGUMENTS here: positional $1 inside a shell block is usually awk or a function argument.
        const idx = lines.findIndex((l) => /\$(ARGUMENTS\b|\{ARGUMENTS\})/.test(l) && !/["']\$(ARGUMENTS|\{ARGUMENTS\})/.test(l));
        if (idx < 0) continue;
        out.push(finding(this, docWhere(d, lineAt(d.text, m.index) + 1 + idx), `unquoted argument in a shell block: ${safeSnippet(lines[idx], model.projectRoot, 100)}`, { severity: 'low' }));
      }
    }
    return out;
  },
};

const BACKTICK_REF = /`((?:~|\.{1,2})[\\/][^`\s]+)`/g;

export const brokenReference = {
  id: 'broken-reference', round: 2, severity: 'medium',
  title: 'Instruction file points to a file that does not exist',
  why: 'The agent follows the pointer, finds nothing, and either improvises or wastes a turn searching, while the reader believes the rule is in place.',
  fix: 'Fix the path, restore the missing file, or remove the reference.',
  run(model) {
    const out = [];
    for (const d of model.docs) {
      if (d.kind !== 'instruction' && d.kind !== 'rule') continue;
      const seen = new Set();
      const report = (raw, idx, kind) => {
        if (seen.has(raw)) return;
        seen.add(raw);
        out.push(finding(this, docWhere(d, lineAt(d.text, idx)), `${kind} ${safeSnippet(raw, model.projectRoot, 100)} does not resolve`));
      };
      if (d.agent === 'claude') {
        for (const raw of parseImports(d.text)) {
          if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) continue; // URLs: instructions-external-import
          const target = model.resolveRef(raw, d.abs);
          if (!model.fileExists(target)) report(`@${raw}`, Math.max(0, d.text.indexOf(`@${raw}`)), 'import');
        }
      }
      const noFences = d.text.replace(/^(```|~~~)[\s\S]*?^\1[^\n]*$/gm, (b) => b.replace(/[^\n]/g, ' '));
      BACKTICK_REF.lastIndex = 0;
      for (const m of noFences.matchAll(BACKTICK_REF)) {
        const raw = m[1].replace(/[.,;:]+$/, '');
        if (/[<>*{}$|?[\]]/.test(raw)) continue;
        if (!/\.[A-Za-z0-9]{1,8}$/.test(raw) && !/[\\/]$/.test(raw)) continue;
        const isHome = raw.startsWith('~');
        if (!isHome && d.scope !== 'project') continue; // a user file's ./ path depends on the session's folder
        const candidates = [model.resolveRef(raw, d.abs)];
        if (!isHome && model.projectRoot && raw.startsWith('./')) candidates.push(path.resolve(model.projectRoot, raw));
        if (!candidates.some((c) => model.fileExists(c))) report(raw, m.index, 'path');
      }
    }
    return out;
  },
};

export const agentPromptOversized = {
  id: 'agent-prompt-oversized', round: 6, severity: 'medium',
  title: 'Agent definition is very long',
  why: 'A subagent re-reads its whole definition on every call, so a long prompt costs tokens each time and buries the few rules that matter.',
  fix: 'Cut the prose to the role, the inputs, the output shape and the hard rules, and move reference material to files the agent reads only when needed.',
  run(model) {
    const out = [];
    for (const d of model.docs) {
      if (d.kind !== 'agent') continue;
      const n = proseOnly(frontmatter(d.text).body).trim().length;
      if (n > 5000) out.push(finding(this, docWhere(d, 1), `${n} characters of prose outside code blocks and tables (threshold 5000)`));
    }
    return out;
  },
};

const HIJACK = /\b(always use this skill|use this skill (for|on|in) (any|every|all)\b|use (it|this) for (any|every|all) (task|request|question|conversation)s?|(must|should) (always )?be (used|invoked|loaded) (first|before)|before (any|every) (response|reply|task|action|tool call|clarifying question)|use (when|for) (starting )?any conversation|for (any|every) task|use for everything)/i;

export const skillDescriptionHijack = {
  id: 'skill-description-hijack', round: 6, severity: 'medium',
  title: 'Skill description competes for every request',
  why: 'Skill descriptions are loaded into every session and decide which skill fires, so an oversized or catch-all description pulls unrelated work into one skill and costs tokens each turn.',
  fix: 'Rewrite the description as one or two sentences saying when to use the skill and when not to, and move the rest into the skill body.',
  run(model) {
    const out = [];
    for (const d of model.docs) {
      if (d.kind !== 'skill') continue;
      const desc = frontmatter(d.text).data.description;
      if (typeof desc !== 'string' || !desc) continue;
      const line = Math.max(1, d.text.split(/\r?\n/).findIndex((l) => /^description\s*:/.test(l)) + 1);
      const m = HIJACK.exec(desc);
      if (desc.length > 1000) out.push(finding(this, docWhere(d, line), `description is ${desc.length} characters (threshold 1000)`));
      if (m) out.push(finding(this, docWhere(d, line), `description says "${safeSnippet(m[0], model.projectRoot, 60)}"`));
    }
    return out;
  },
};

export const instructionFileOversized = {
  id: 'instruction-file-oversized', round: 2, severity: 'medium',
  title: 'Always-loaded instructions are large',
  why: 'This text is sent at the start of every session before any work, so its size is a fixed cost on every conversation and long files get followed less reliably.',
  fix: 'Keep only rules that apply to nearly every session in the file, and move the rest to skills, rules scoped to paths, or docs the agent opens when needed.',
  run(model) {
    const out = [];
    for (const r of model.rootInstructions) {
      if (!r.alwaysLoaded) continue;
      const tokens = Math.round(r.totalChars / 4);
      if (tokens <= 8000) continue;
      const extra = r.chain.length > 1 ? ` across ${r.chain.length} files (file plus imports)` : '';
      out.push(finding(this, { ...r, line: 1 }, `about ${tokens} tokens${extra} (threshold 8000)`));
    }
    return out;
  },
};

const READ_ONLY_TOOLS = new Set(['read', 'grep', 'glob', 'ls']);

export const agentExpensiveModelReadonly = {
  id: 'agent-expensive-model-readonly', round: 6, severity: 'low',
  title: 'Read-only agent pinned to the most expensive model',
  why: 'An agent that can only read and search does lookup work, which a cheaper and faster model usually does as well.',
  fix: 'Remove the model pin or set a cheaper model, and keep the expensive one for agents that plan, review or write.',
  run(model) {
    const out = [];
    for (const d of model.docs) {
      if (d.kind !== 'agent') continue;
      const fm = frontmatter(d.text).data;
      const modelName = typeof fm.model === 'string' ? fm.model : '';
      if (!/opus/i.test(modelName)) continue;
      const tools = (Array.isArray(fm.tools) ? fm.tools : String(fm.tools || '').split(','))
        .map((t) => String(t).trim()).filter(Boolean);
      if (!tools.length || !tools.every((t) => READ_ONLY_TOOLS.has(t.toLowerCase()))) continue;
      out.push(finding(this, docWhere(d, 1), `model: ${safeSnippet(modelName, model.projectRoot, 40)}; tools: ${tools.join(', ')}`));
    }
    return out;
  },
};

export const CONTENT_CHECKS = [
  instructionsHiddenText, instructionsExternalImport, skillShellInjection, brokenReference,
  agentPromptOversized, skillDescriptionHijack, instructionFileOversized, agentExpensiveModelReadonly,
];
