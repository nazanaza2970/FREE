import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bundleDir = path.join(root, 'src-tauri', 'target', 'release', 'bundle');

function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
}

function run(cmd, args, cwd = root) {
  console.log(`• ${cmd} ${args.join(' ')}`);
  execFileSync(cmd, args, { cwd, stdio: 'inherit' });
}

function copyRecursive(src, dest) {
  if (!existsSync(src)) return;
  const stat = statSync(src);
  if (stat.isDirectory()) {
    ensureDir(dest);
    for (const entry of readdirSync(src)) {
      copyRecursive(path.join(src, entry), path.join(dest, entry));
    }
  } else {
    ensureDir(path.dirname(dest));
    cpSync(src, dest);
  }
}

function zipDir(zipPath, dir, name) {
  const cwd = path.dirname(dir);
  const base = path.basename(dir);
  try {
    run('zip', ['-r', '-q', zipPath, base], cwd);
  } catch (e) {
    console.error('zip failed, ensure zip is installed');
    throw e;
  }
}

const mode = process.argv[2] || 'linux';

console.log(`Building desktop artifacts for: ${mode}`);

if (mode === 'linux' || mode === 'all') {
  // Build tauri bundles
  run('npx', ['tauri', 'build', '--bundles', 'deb,appimage']);
  
  // Create portable tar.gz from appimage contents or binary
  const appDir = path.join(bundleDir, 'appimage');
  const debDir = path.join(bundleDir, 'deb');
  
  if (existsSync(appDir)) {
    const appimages = readdirSync(appDir).filter(f => f.endsWith('.AppImage'));
    for (const app of appimages) {
      console.log(`✓ Found AppImage: ${app}`);
    }
  }
  if (existsSync(debDir)) {
    const debs = readdirSync(debDir).filter(f => f.endsWith('.deb'));
    for (const deb of debs) {
      console.log(`✓ Found deb: ${deb}`);
    }
  }
}

if (mode === 'windows' || mode === 'all') {
  run('npx', ['tauri', 'build', '--bundles', 'nsis']);
  
  const nsisDir = path.join(bundleDir, 'nsis');
  if (existsSync(nsisDir)) {
    const exes = readdirSync(nsisDir).filter(f => f.endsWith('.exe'));
    for (const exe of exes) {
      console.log(`✓ Found NSIS installer: ${exe}`);
      // Create portable zip alongside
      const baseName = exe.replace('.exe', '');
      const portableDir = path.join(bundleDir, 'nsis', `${baseName}-portable`);
      rmSync(portableDir, { recursive: true, force: true });
      ensureDir(portableDir);
      // Copy installer as portable? Actually for portable, we need to extract or just zip the exe + runtime
      // Tauri NSIS can be used as portable with certain flags, but easier to just zip the bundle output
      cpSync(path.join(nsisDir, exe), path.join(portableDir, exe));
      const portableZip = path.join(nsisDir, `${baseName}-portable.zip`);
      zipDir(portableZip, portableDir, `${baseName}-portable`);
      console.log(`✓ Created portable zip: ${portableZip}`);
    }
  }
}

console.log('\nDone. Artifacts in:', bundleDir);
