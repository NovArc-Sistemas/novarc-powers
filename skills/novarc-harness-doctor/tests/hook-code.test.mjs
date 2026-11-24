// How a hook's source is read (lib/snapshot/hookcode.mjs) and what hookBlocking makes of it:
// code is evidence, a comment never is, a string literal settles nothing, and "could not tell"
// is null, which no caller may read as "blocks" or as "does not block".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitSource, sourceLang, hookSource } from '../scripts/lib/snapshot/hookcode.mjs';
import { hookBlocking } from '../scripts/lib/snapshot/elements.mjs';

test('splitSource blanks comments in `text`, and string contents too in `code`, keeping every position', () => {
  assert.deepEqual(splitSource('echo "a b" # c', 'shell'), { text: 'echo "a b"    ', code: 'echo "   "    ', ok: true });
  assert.deepEqual(splitSource("f('x'); // y\n/* z */ g(`w`);", 'javascript'), {
    text: "f('x');     \n        g(`w`);", code: "f(' ');     \n        g(` `);", ok: true,
  });
  assert.deepEqual(splitSource('x = "a#b"  # c\n"""doc\nexit(2)"""\n', 'python'), {
    text: 'x = "a#b"     \n"""doc\nexit(2)"""\n', code: 'x = "   "     \n"""   \n       """\n', ok: true,
  });
  assert.deepEqual(splitSource("<# a\nb #>\nWrite-Host 'it''s' # c\n", 'powershell'), {
    text: "    \n    \nWrite-Host 'it''s'    \n", code: "    \n    \nWrite-Host '     '    \n", ok: true,
  });
  // Whatever the language, both texts keep the length and the line breaks of the source.
  const samples = [
    ['shell', '#!/bin/sh\nmsg=\'it is\' # note\ncat <<EOF\nbody # not a comment\nEOF\n[ "${#1}" -gt 0 ] && exit 0\n'],
    ['powershell', '$x = @"\nhere # text\n"@\nexit 0 # done\n'],
    ['javascript', 'const re = /["\']#/g; // quotes inside a regular expression\nconst s = `a\n${b}`;\n'],
    ['python', "r = r'\\d+'  # raw\ns = '''a\n# not a comment\n'''\n"],
    ['hash', 'puts "a # b" # c\n'],
  ];
  for (const [lang, src] of samples) {
    const out = splitSource(src, lang);
    assert.equal(out.ok, true, lang);
    for (const t of [out.text, out.code]) {
      assert.equal(t.length, src.length, lang);
      assert.deepEqual([...t].map((c, i) => (c === '\n' ? i : -1)).filter((i) => i >= 0), [...src].map((c, i) => (c === '\n' ? i : -1)).filter((i) => i >= 0), lang);
    }
  }
});

test('splitSource knows a comment from what only looks like one', () => {
  const sh = splitSource('n=${#1}; echo $# a#b "x # y"\ncat <<EOF\n# kept\nEOF\necho done # gone\n', 'shell');
  assert.ok(sh.text.includes('${#1}') && sh.text.includes('$# a#b') && sh.text.includes('"x # y"') && sh.text.includes('# kept'));
  assert.ok(!sh.text.includes('gone'));
  const js = splitSource('const u = "http://x.invalid"; const r = /\\/\\/ y/; // gone\n', 'javascript');
  assert.ok(js.text.includes('"http://x.invalid"') && js.text.includes('/\\/\\/ y/') && !js.text.includes('gone'));
  const py = splitSource('s = "# kept"  # gone\n', 'python');
  assert.ok(py.text.includes('"# kept"') && !py.text.includes('gone'));
  const ps = splitSource('$s = "# kept" # gone\n', 'powershell');
  assert.ok(ps.text.includes('"# kept"') && !ps.text.includes('gone'));
});

test('a string or here-document that is itself code is read in its own language', () => {
  assert.match(splitSource('sh -c "exit 2" || true', 'shell').code, /exit 2/);
  assert.doesNotMatch(splitSource('echo "exit 2"', 'shell').code, /exit 2/);
  assert.doesNotMatch(splitSource('grep -e "exit 2" log.txt', 'shell').code, /exit 2/, 'a flag of a program that runs nothing');
  const node = splitSource("node -e 'process.exit(2) // stop here'", 'shell');
  assert.match(node.code, /process\.exit\(2\)/);
  assert.doesNotMatch(node.text, /stop here/, 'the comment inside it is a comment');
  assert.match(splitSource("trap 'exit 2' ERR", 'shell').code, /exit 2/);
  assert.match(splitSource('pwsh -NoProfile -Command "if ($bad) { exit 2 }"', 'shell').code, /exit 2/);
  const fed = splitSource("python3 - <<'PY'\nimport sys  # exit(2) is not here\nsys.exit(2)\nPY\necho after\n", 'shell');
  assert.match(fed.code, /sys\.exit\(2\)/);
  assert.doesNotMatch(fed.text, /is not here/);
  const printed = splitSource('cat <<EOF\nexit 2\nEOF\n', 'shell');
  assert.doesNotMatch(printed.code, /exit 2/);
  assert.match(printed.text, /exit 2/);
});

test('source the scanner cannot follow is reported, not guessed at', () => {
  assert.equal(splitSource("echo 'never closed\nexit 2\n", 'shell').ok, false);
  assert.equal(splitSource('cat <<EOF\nno end\n', 'shell').ok, false);
  assert.equal(splitSource('/* never closed\nprocess.exit(2)\n', 'javascript').ok, false);
  assert.equal(splitSource('"""never closed\n', 'python').ok, false);
  assert.equal(splitSource('<# never closed\n', 'powershell').ok, false);
  // A lone quote on a line of a language whose strings end with the line is just a character.
  assert.equal(splitSource("// it's fine\nconst a = 1; // don't\nprocess.exit(2);\n", 'javascript').ok, true);
});

test('sourceLang and hookSource pick the language from the file, the command or the first line', () => {
  assert.equal(sourceLang('~/.claude/hooks/guard.mjs'), 'javascript');
  assert.equal(sourceLang('hooks/guard.ts'), 'javascript');
  assert.equal(sourceLang('hooks/Guard.PS1'), 'powershell');
  assert.equal(sourceLang('hooks/guard.py'), 'python');
  assert.equal(sourceLang('hooks/guard.zsh'), 'shell');
  assert.equal(sourceLang('hooks/guard', '#!/usr/bin/env python3\n'), 'python');
  assert.equal(sourceLang('hooks/guard', '#!/bin/bash\n'), 'shell');
  assert.equal(sourceLang('hooks/guard.rb'), 'hash');
  const py = '# sys.exit(2)\nprint("ok")\n';
  for (const h of [{ command: 'python3 hooks/guard.py', scriptText: py }, { command: 'run-it', scriptText: py, scriptDisplay: '~/.claude/hooks/guard.py' }, { command: 'run-it', scriptText: py, scriptAbs: 'guard.py' }]) {
    const src = hookSource(h);
    assert.equal(src.read, true);
    assert.doesNotMatch(src.text, /exit/);
    assert.match(src.text, /print\("ok"\)/);
  }
  assert.deepEqual(hookSource({ command: 'echo hi # there' }), { read: false, ok: true, text: 'echo hi        \n', code: 'echo hi        \n' });
});

const blocking = (command, scriptText, extra = {}) => hookBlocking({ source: 'agent', type: 'command', event: 'PreToolUse', command, scriptText, outside: false, ...extra });

test('hookBlocking: `exit 2` in a comment is not evidence, in any hook language', () => {
  const cases = [
    ['sh hook.sh', '#!/bin/sh\n# exit 2 would block the call, this hook only logs\necho ok\n'],
    ['sh hook.sh', 'echo ok # exit 2\n'],
    ['bash hook.bash', ': <<EOF\nnothing\nEOF\necho ok # exit 2\n'],
    ['pwsh -File hook.ps1', '# exit 2\n<#\n  exit 2\n#>\nWrite-Output "ok"\n'],
    ['node hook.mjs', '// process.exit(2) would block\n/* exit(2);\n   process.exitCode = 2; */\nconsole.log("ok");\n'],
    ['node hook.ts', '#!/usr/bin/env node\n// exit 2\nconsole.log("ok");\n'],
    ['python3 hook.py', '# sys.exit(2) would block\nprint("ok")\n'],
  ];
  for (const [command, script] of cases) assert.equal(blocking(command, script), false, `${command}: ${JSON.stringify(script)}`);
  // The same hooks with the statement in the code do block.
  assert.equal(blocking('sh hook.sh', 'if bad; then exit 2; fi # exit 2 blocks\n'), true);
  assert.equal(blocking('pwsh -File hook.ps1', 'if ($bad) { exit 2 } # stop\n'), true);
  assert.equal(blocking('node hook.mjs', 'if (bad) process.exit(2); // block\n'), true);
  assert.equal(blocking('python3 hook.py', 'import sys\nif bad:\n    sys.exit(2)  # block\n'), true);
  // A decision in a comment is no decision either; printed from a string, it is one.
  assert.equal(blocking('sh hook.sh', '# {"decision":"block"} would stop it\necho ok\n'), false);
  assert.equal(blocking('node hook.mjs', '// permissionDecision: "deny"\nconsole.log("{}");\n'), false);
  assert.equal(blocking('sh hook.sh', 'echo \'{"hookSpecificOutput":{"permissionDecision":"deny"}}\' # refuse\n'), true);
  // Inline commands are read the same way.
  assert.equal(blocking('echo checked # exit 2', undefined), false);
  assert.equal(blocking('sh -c "exit 2"', undefined), true);
  assert.equal(blocking("node -e 'process.exit(2)'", undefined), true);
  assert.equal(blocking('my-guard --strict # exit 2', undefined), null, 'the program itself was not read');
});

test('hookBlocking: null when the code does not settle it', () => {
  const unknown = [
    // `exit 2` only inside a message: printed, maybe; evaluated, maybe.
    ['sh hook.sh', 'echo "to block the call, exit 2"\n'],
    ['pwsh -File hook.ps1', 'Write-Error "use exit 2 to block"\n'],
    ['node hook.mjs', 'console.log("process.exit(2)");\n'],
    ['python3 hook.py', '"""exit(2) is described in this docstring"""\nprint("ok")\n'],
    ['sh hook.sh', 'cat <<EOF\nexit 2\nEOF\n'],
    // An exit status that is not written in the source.
    ['sh hook.sh', 'check "$1"\nrc=$?\nexit $rc\n'],
    ['sh hook.sh', 'exit "$status"\n'],
    ['sh hook.sh', 'exec other-guard "$@"\n'],
    ['pwsh -File hook.ps1', 'exit $LASTEXITCODE\n'],
    ['node hook.mjs', 'process.exit(code);\n'],
    ['node hook.mjs', 'process.exitCode = bad ? 2 : 0;\n'],
    ['python3 hook.py', 'import sys\nsys.exit(1 if bad else 0)\n'],
    ['python3 hook.py', 'raise SystemExit(rc)\n'],
    // A decision whose value is not written in the source.
    ['node hook.mjs', 'console.log(JSON.stringify({ hookSpecificOutput: { permissionDecision: verdict } }));\n'],
    ['node hook.mjs', 'const out = { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: ok ? "allow" : "deny" } };\nconsole.log(JSON.stringify(out));\n'],
    ['node hook.mjs', 'console.log(JSON.stringify({ decision }));\n'],
    ['sh hook.sh', 'jq -n --arg d "$verdict" \'{hookSpecificOutput: {permissionDecision: $d}}\'\n'],
    ['sh hook.sh', 'echo "{\\"decision\\": \\"$d\\"}"\n'],
    // Source the scanner lost track of.
    ['sh hook.sh', "echo 'never closed\nexit 2\n"],
  ];
  for (const [command, script] of unknown) assert.equal(blocking(command, script), null, `${command}: ${JSON.stringify(script)}`);
  // What is written out stays an answer.
  assert.equal(blocking('sh hook.sh', 'echo "not allowed" >&2\nexit 1\n'), false);
  assert.equal(blocking('node hook.mjs', 'console.log(JSON.stringify({ hookSpecificOutput: { permissionDecision: "allow" } }));\nprocess.exit(0);\n'), false);
  assert.equal(blocking('python3 hook.py', 'import sys\nsys.exit("usage: hook.py")\n'), false, 'a message: status 1');
  assert.equal(blocking('node hook.mjs', 'process.on("exit", (code) => console.log(code));\n'), false);
  // A command that throws its status away cannot block through it, computed or not ...
  assert.equal(blocking('sh hook.sh || true', 'exit $rc\n'), false);
  assert.equal(blocking('sh hook.sh || true', 'echo "exit 2"\n'), false);
  // ... but a decision it may still print keeps the answer open.
  assert.equal(blocking('node hook.mjs || true', 'console.log(JSON.stringify({ decision }));\nprocess.exit(2);\n'), null);
  // PermissionRequest reads no exit status at all: only its decision counts.
  assert.equal(blocking('sh hook.sh', 'exit $rc\n', { event: 'PermissionRequest' }), false);
  assert.equal(blocking('node hook.mjs', 'console.log(JSON.stringify({ hookSpecificOutput: { decision: { behavior } } }));\n', { event: 'PermissionRequest' }), null);
});
