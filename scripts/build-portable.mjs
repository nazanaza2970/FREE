import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'portable');

console.log('• vite build (client)');
execFileSync(process.execPath, ['node_modules/vite/bin/vite.js', 'build'], { cwd: root, stdio: 'inherit' });

console.log('• bundling server (esbuild, inlined sql.js wasm)');
rmSync(outDir, { recursive: true, force: true });
mkdirSync(path.join(outDir, 'server'), { recursive: true });
await esbuild.build({
  entryPoints: [path.join(root, 'server', 'index.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'es2022',
  outfile: path.join(outDir, 'server', 'index.mjs'),
  external: ['cpu-features'],
  banner: {
    js: [
      "import { createRequire as __tfCreateRequire } from 'node:module';",
      "import { dirname as __tfDirname } from 'node:path';",
      "import { fileURLToPath as __tfF2P } from 'node:url';",
      'const require = __tfCreateRequire(import.meta.url);',
      'const __dirname = __tfDirname(__tfF2P(import.meta.url));',
      'const __filename = __tfF2P(import.meta.url);',
    ].join('\n'),
  },
});

console.log('• assembling portable layout');
cpSync(path.join(root, 'dist'), path.join(outDir, 'dist'), { recursive: true });

console.log(`\ndone → ${outDir}`);
console.log('run:  node portable/server/index.mjs   (PORT/HOST env optional, NODE_ENV=production)');
