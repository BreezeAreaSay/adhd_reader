/*
 * Builds the browser packages:
 *   dist/chrome/   + dist/adhd-reader-chrome-<version>.zip   (Chrome, Edge, Brave, Opera, Orion…)
 *   dist/firefox/  + dist/adhd-reader-firefox-<version>.zip  (Firefox 140+)
 *
 * The repository itself loads as it is in both browsers: its manifest names a service worker for
 * Chrome and the same code as event-page scripts for Firefox (each browser ignores the other's key),
 * plus Firefox's add-on settings. The packages keep only what each browser reads, for the stores.
 *
 * Usage: npm run build
 */
const fs = require('node:fs');
const path = require('node:path');
const { zipSync } = require('fflate');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const INCLUDE = ['manifest.json', '_locales', 'icons', 'fonts', 'src'];

function copy(from, to) {
  const stat = fs.statSync(from);
  if (stat.isDirectory()) {
    fs.mkdirSync(to, { recursive: true });
    for (const name of fs.readdirSync(from)) if (!name.startsWith('.')) copy(path.join(from, name), path.join(to, name));
  } else {
    fs.copyFileSync(from, to);
  }
}

function files(dir, base = dir, out = {}) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) files(full, base, out);
    else out[path.relative(base, full).split(path.sep).join('/')] = fs.readFileSync(full);
  }
  return out;
}

function chromeManifest(manifest) {
  const out = { ...manifest, background: { service_worker: manifest.background.service_worker } };
  delete out.browser_specific_settings;
  return out;
}

function firefoxManifest(manifest) {
  const out = { ...manifest, background: { scripts: manifest.background.scripts } };
  delete out.minimum_chrome_version;
  return out;
}

function build(target, transform) {
  const outDir = path.join(DIST, target);
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  for (const entry of INCLUDE) copy(path.join(ROOT, entry), path.join(outDir, entry));
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  fs.writeFileSync(path.join(outDir, 'manifest.json'), `${JSON.stringify(transform(manifest), null, 2)}\n`);

  const zipPath = path.join(DIST, `adhd-reader-${target}-${manifest.version}.zip`);
  fs.writeFileSync(zipPath, zipSync(files(outDir), { level: 9, mtime: new Date('2025-01-01T00:00:00Z') }));
  const size = (fs.statSync(zipPath).size / 1024 / 1024).toFixed(1);
  console.log(`${target}: ${path.relative(ROOT, outDir)}/ and ${path.relative(ROOT, zipPath)} (${size} MB)`);
}

fs.mkdirSync(DIST, { recursive: true });
build('chrome', chromeManifest);
build('firefox', firefoxManifest);
