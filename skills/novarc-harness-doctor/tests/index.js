// Entry point so `node --test <skill>/tests/` works on every Node version.
// Node 20 expands a directory argument into its *.test.* files and never runs this file (its name
// matches no test pattern). Node 22+ treats a directory argument as a module and loads this
// index.js, which imports every *.test.mjs file next to it.
// It must load both as CommonJS (skill copied on its own) and as ESM (inside a "type": "module"
// package), so it uses neither `require` nor `import.meta`.
Promise.all([import('node:fs'), import('node:path'), import('node:url')]).then(([fs, path, url]) => {
  let here;
  if (typeof __dirname === 'string') here = __dirname;
  else {
    const m = /(file:\/\/[^\s)]*?\/index\.js)/.exec(new Error().stack || '');
    here = path.dirname(url.fileURLToPath(m[1]));
  }
  const files = fs.readdirSync(here).filter((f) => f.endsWith('.test.mjs')).sort();
  return files.reduce((p, f) => p.then(() => import(url.pathToFileURL(path.join(here, f)).href)), Promise.resolve());
});
