// Bundles a Node entrypoint with esbuild. Workspace packages (@bh/*) are compiled
// into the bundle; third-party dependencies stay external and are installed at runtime.
import { build } from 'esbuild';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const [entry, outfile] = process.argv.slice(2);
if (!entry || !outfile) {
  console.error('usage: build-node.mjs <entry> <outfile>');
  process.exit(1);
}

const repoRoot = path.resolve(import.meta.dirname, '..');
const workspaceDir = (name) => {
  const short = name.slice('@bh/'.length);
  for (const group of ['packages', 'apps']) {
    const dir = path.join(repoRoot, group, short);
    if (existsSync(path.join(dir, 'package.json'))) return dir;
  }
  throw new Error(`workspace package not found: ${name}`);
};

const external = new Set();
const seen = new Set();
const collect = (pkgDir) => {
  if (seen.has(pkgDir)) return;
  seen.add(pkgDir);
  const pkg = JSON.parse(readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
  for (const dep of Object.keys(pkg.dependencies ?? {})) {
    if (dep.startsWith('@bh/')) collect(workspaceDir(dep));
    else external.add(dep);
  }
};
collect(process.cwd());

await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  external: [...external],
  banner: {
    js: "import { createRequire as __bhCreateRequire } from 'node:module'; const require = __bhCreateRequire(import.meta.url);",
  },
  logLevel: 'info',
});
