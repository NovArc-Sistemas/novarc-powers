// Builds a synthetic home with agent config dirs and a synthetic project, entirely in os.tmpdir().
// Nothing here reads or copies the real machine's harness.
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir, write, git, trySymlink } from './helpers.mjs';

// 36 x's after the prefix: shaped like a GitHub classic token, obviously fake.
export const FAKE_TOKEN = `ghp_${'x'.repeat(36)}`;
// A unique string placed in every synthetic message, command and tool output. It must never
// reach the probes' stdout or stderr.
export const MARKER = 'ZQXMARKER7731';

export function buildFakeHome() {
  const root = tmpDir('hd-home-');
  const home = path.join(root, 'home');
  const claude = path.join(home, '.claude');
  const second = path.join(root, 'second-config'); // named by CLAUDE_CONFIG_DIR
  const hostAcc = path.join(home, '.hostapp', 'host', 'harness-accounts', 'claude-code', 'acc-1');

  // Default config dir: CLAUDE.md with one resolving and one broken import.
  write(path.join(claude, 'CLAUDE.md'), [
    '# Rules', '', 'Read the extras.', '', '@good.md', '@missing-rules.md', '',
    'Mention `@types/node` and @someone are not imports. Mail me at a@b.example.', '',
    '```', '@inside-code-block.md', '```', '',
  ].join('\n'));
  write(path.join(claude, 'good.md'), 'Good rules: the and is are of to in that it for with this be on not you by from as or can.\n');
  write(path.join(claude, 'settings.json'), JSON.stringify({
    permissions: { allow: ['Bash(git status)', 'Bash(npm test)', 'Read'], deny: ['Bash(rm -rf *)', 'Bash(git push --force)'], ask: ['Bash(git push)'], defaultMode: 'default' },
    hooks: {
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node guard.js' }, { type: 'command', command: 'node log.js' }] }],
      Stop: [{ hooks: [{ type: 'command', command: 'node stop.js' }] }],
    },
    enabledPlugins: { 'alpha@market-one': true, 'beta@market-one': false },
    extraKnownMarketplaces: { 'market-one': { source: { source: 'github', repo: 'example/market-one' } } },
    env: { SOME_TOKEN: FAKE_TOKEN },
  }, null, 2));
  write(path.join(home, '.claude.json'), JSON.stringify({
    mcpServers: { localtool: { command: 'node', args: ['server.js'], env: { API_KEY: FAKE_TOKEN } }, remotetool: { type: 'http', url: 'https://mcp.example.invalid/x' } },
  }));
  write(path.join(claude, 'skills', 'alpha-skill', 'SKILL.md'), '---\nname: alpha-skill\n---\n');
  write(path.join(claude, 'skills', 'not-a-skill', 'README.md'), 'no SKILL.md here');
  write(path.join(claude, 'scripts', 'helper.sh'), `#!/bin/sh\n# helper\nexport GH_TOKEN=${FAKE_TOKEN}\n`);
  write(path.join(claude, 'settings.json.bak'), '{}');

  // A hardlinked file (works without privileges on every OS) and, when allowed, a symlink.
  write(path.join(claude, 'shared.md'), 'shared\n');
  fs.mkdirSync(second, { recursive: true });
  fs.linkSync(path.join(claude, 'shared.md'), path.join(second, 'shared.md'));
  const fileSymlink = trySymlink(path.join(claude, 'good.md'), path.join(second, 'linked-good.md'), 'file');
  // The second dir's CLAUDE.md imports good.md, which lives only in the first dir: broken there.
  write(path.join(second, 'CLAUDE.md'), 'Second account.\n\n@good.md\n');
  write(path.join(second, 'settings.json'), '{ "permissions": { "allow": [] } }');

  // Host-app account dir whose projects/ is a junction/symlink to the default projects dir.
  fs.mkdirSync(path.join(claude, 'projects'), { recursive: true });
  fs.mkdirSync(hostAcc, { recursive: true });
  write(path.join(hostAcc, 'settings.json'), '{}');
  const dirLink = trySymlink(path.join(claude, 'projects'), path.join(hostAcc, 'projects'), 'junction');

  // Codex and shared agents dirs.
  write(path.join(home, '.codex', 'AGENTS.md'), '# Codex rules\n');
  write(path.join(home, '.codex', 'config.toml'), [
    'model = "x"', '', '[mcp_servers.remote_one]', 'url = "https://mcp.example.invalid/y"', '',
    '[mcp_servers.local_one]', 'command = "npx"', '', '[mcp_servers.local_one.env]', 'KEY = "v"', '',
  ].join('\n'));
  write(path.join(home, '.agents', 'skills', 'shared-skill', 'SKILL.md'), '---\nname: shared-skill\n---\n');

  // Desktop app config (Windows location under the fake APPDATA; other OSes via the home paths).
  write(path.join(home, 'AppData', 'Roaming', 'Claude', 'claude_desktop_config.json'), JSON.stringify({ mcpServers: { desk: { command: 'node' } } }));

  return { root, home, claude, second, hostAcc, fileSymlink, dirLink };
}

export function buildFakeProject(root) {
  const proj = path.join(root, 'proj-alpha');
  fs.mkdirSync(proj, { recursive: true });
  git(proj, ['init', '-q', '-b', 'main']);
  write(path.join(proj, 'package.json'), JSON.stringify({ name: 'proj-alpha', dependencies: { '@supabase/supabase-js': '1.0.0' } }));
  write(path.join(proj, 'CLAUDE.md'), 'Project rules.\n\n@docs/guide.md\n@docs/nowhere.md\n');
  write(path.join(proj, 'README.md'), '# Proj alpha\n\nThis is the readme of the project and it is written in English for the people who use it. You can run it with the script that is in the folder, and it will print the result to the screen when it is done.\n');
  write(path.join(proj, 'docs', 'guide.md'), '# Guide\n\nThis guide is for the agent. It explains how the project is built and what you should do when a test fails. The scripts are in the folder and they can be run with npm. If the build is not green, do not push. Use the fast checks first and then the full suite, which is slower and should be run before a release.\n');
  write(path.join(proj, 'docs', 'guia.md'), '# Guia\n\nEste guia é para o agente. Ele explica como o projeto é construído e o que você deve fazer quando um teste falha. Os scripts estão na pasta e podem ser executados com npm. Se a build não estiver verde, não faça push. Use as verificações rápidas primeiro e depois a suíte completa, que é mais lenta, quando for fazer uma release. Isso também vale para os hotfixes da semana.\n');
  write(path.join(proj, 'docs', 'adr', '0001-record.md'), '# ADR 1\n\nShort.\n');
  write(path.join(proj, 'supabase', 'config.toml'), 'project_id = "x"\n');
  write(path.join(proj, '.github', 'workflows', 'ci.yml'), 'name: ci\n');
  write(path.join(proj, '.mcp.json'), JSON.stringify({ mcpServers: { supabase: { command: 'npx' } } }));
  write(path.join(proj, '.claude', 'settings.json'), JSON.stringify({ hooks: { PostToolUse: [{ hooks: [{ type: 'command', command: 'echo hi' }] }] } }));
  write(path.join(proj, '.env'), 'NOTHING=1\n');
  write(path.join(proj, '.gitignore'), '.env\n');
  write(path.join(proj, '.git', 'hooks', 'pre-push'), '#!/bin/sh\nexit 0\n');
  write(path.join(proj, 'graphify-out', 'graph.json'), '{}');
  git(proj, ['add', '-A']);
  git(proj, ['commit', '-q', '-m', 'init']);
  return proj;
}

/** Synthetic Claude Code + Codex transcripts for `proj`, every text field carrying MARKER. */
export function buildFakeTranscripts(home, proj) {
  const enc = proj.replace(/[^A-Za-z0-9]/g, '-');
  const pdir = path.join(home, '.claude', 'projects', enc);
  const wdir = path.join(home, '.claude', 'projects', `${enc}--claude-worktrees-feature-x`);
  const other = path.join(home, '.claude', 'projects', `${enc}-sibling`); // a different project
  const t = (min) => new Date(Date.UTC(2026, 0, 5, 10, min)).toISOString();
  const lines = [];
  const push = (o) => lines.push(JSON.stringify(o));
  push({ type: 'user', timestamp: t(0), sessionId: 's1', message: { role: 'user', content: `Please build the thing ${MARKER}` } });
  // Three failing `npm test` runs (a retry), one failing git push blocked by a hook, one not found.
  for (let i = 0; i < 3; i++) {
    push({ type: 'assistant', timestamp: t(1 + i), message: { role: 'assistant', content: [{ type: 'text', text: `Running tests ${MARKER}` }, { type: 'tool_use', id: `tu${i}`, name: 'Bash', input: { command: `cd /tmp/${MARKER} && npm test -- --grep ${MARKER}` } }] } });
    push({ type: 'user', timestamp: t(1 + i), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `tu${i}`, is_error: true, content: `Exit code 1\nFAIL ${MARKER}` }] }, toolUseResult: { stdout: MARKER, stderr: MARKER } });
  }
  push({ type: 'assistant', timestamp: t(5), message: { content: [{ type: 'tool_use', id: 'tu5', name: 'Bash', input: { command: `git push origin ${MARKER} --force` } }] } });
  push({ type: 'user', timestamp: t(5), message: { content: [{ type: 'tool_result', tool_use_id: 'tu5', is_error: true, content: `PreToolUse:Bash hook error: blocked by policy ${MARKER}` }] } });
  push({ type: 'assistant', timestamp: t(6), message: { content: [{ type: 'tool_use', id: 'tu6', name: 'Bash', input: { command: `supabase db push ${MARKER}` } }] } });
  push({ type: 'user', timestamp: t(6), message: { content: [{ type: 'tool_result', tool_use_id: 'tu6', is_error: true, content: `bash: supabase: command not found ${MARKER}` }] } });
  push({ type: 'assistant', timestamp: t(7), message: { content: [{ type: 'tool_use', id: 'tu7', name: 'Read', input: { file_path: `/x/${MARKER}` } }, { type: 'tool_use', id: 'tu8', name: 'Skill', input: { skill: 'alpha-skill', args: MARKER } }] } });
  push({ type: 'user', timestamp: t(7), message: { content: [{ type: 'tool_result', tool_use_id: 'tu7', content: MARKER }, { type: 'tool_result', tool_use_id: 'tu8', content: MARKER }] } });
  push({ type: 'user', timestamp: t(8), message: { role: 'user', content: `no, that's wrong ${MARKER}` } });
  push({ type: 'user', timestamp: t(8), isMeta: true, message: { role: 'user', content: `no meta ${MARKER}` } });
  push({ type: 'user', timestamp: t(9), message: { role: 'user', content: `<command-name>/alpha-skill</command-name><command-args>${MARKER}</command-args>` } });
  push({ type: 'attachment', timestamp: t(9), attachment: { type: 'hook_blocking_error', hookName: 'x', content: MARKER } });
  push({ type: 'attachment', timestamp: t(9), attachment: { type: 'hook_non_blocking_error', content: MARKER } });
  lines.push(`{"type":"user","message":{"content":"broken json ${MARKER}"`); // unparsable on purpose
  // Session ends on an error.
  push({ type: 'assistant', timestamp: t(10), message: { content: [{ type: 'tool_use', id: 'tu9', name: 'PowerShell', input: { command: `Get-ChildItem ${MARKER}` } }] } });
  push({ type: 'user', timestamp: t(10), message: { content: [{ type: 'tool_result', tool_use_id: 'tu9', is_error: true, content: MARKER }] } });
  write(path.join(pdir, 'session-one.jsonl'), lines.join('\n') + '\n');

  // A worktree session (counts) and a sibling project session (must not count).
  const wt = [
    JSON.stringify({ type: 'user', timestamp: t(20), message: { content: `Pare com isso ${MARKER}` } }),
    JSON.stringify({ type: 'assistant', timestamp: t(21), message: { content: [{ type: 'tool_use', id: 'w1', name: 'Bash', input: { command: `npm run build ${MARKER}` } }] } }),
    JSON.stringify({ type: 'user', timestamp: t(21), message: { content: [{ type: 'tool_result', tool_use_id: 'w1', is_error: false, content: MARKER }] } }),
  ];
  write(path.join(wdir, 'session-two.jsonl'), wt.join('\n') + '\n');
  write(path.join(other, 'session-other.jsonl'), JSON.stringify({ type: 'assistant', timestamp: t(30), message: { content: [{ type: 'tool_use', id: 'o1', name: 'Bash', input: { command: 'make' } }] } }) + '\n');

  // Codex rollout for this project and one for another directory.
  const cx = [
    { timestamp: t(40), type: 'session_meta', payload: { cwd: proj, id: 'x' } },
    { timestamp: t(41), type: 'event_msg', payload: { type: 'item_completed', item: { type: 'UserMessage', content: [{ type: 'text', text: `de novo, ${MARKER}` }] } } },
    { timestamp: t(41), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `de novo, ${MARKER}` }] } },
    { timestamp: t(42), type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', input: MARKER } },
    { timestamp: t(42), type: 'event_msg', payload: { type: 'item_completed', item: { type: 'CommandExecution', command: ['bash', '-lc', `cargo build ${MARKER}`], exit_code: 101, status: 'failed', stderr: MARKER, aggregated_output: MARKER } } },
  ].map((o) => JSON.stringify(o));
  const cdir = path.join(home, '.codex', 'sessions', '2026', '01', '05');
  write(path.join(cdir, 'rollout-2026-01-05T10-40-00-01a1aaaa-bbbb-7ccc-8ddd-eeeeffff0000.jsonl'), cx.join('\n') + '\n');
  write(path.join(cdir, 'rollout-2026-01-05T11-00-00-01a1aaaa-bbbb-7ccc-8ddd-eeeeffff0001.jsonl'), JSON.stringify({ timestamp: t(50), type: 'session_meta', payload: { cwd: path.join(path.dirname(proj), 'elsewhere') } }) + '\n');
  return { enc };
}
