#!/usr/bin/env node
import { appendFile, cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';

const repoRoot = resolve(import.meta.dirname, '..');
const [destination, ...extra] = process.argv.slice(2);
if (!destination || extra.length) {
  throw new Error('usage: node scripts/prepare-compatibility.mjs <new-workspace-outside-checkout>');
}
const workspace = resolve(destination);
if (workspace === repoRoot || workspace.startsWith(`${repoRoot}${sep}`)) {
  throw new Error('compatibility workspace must be outside the source checkout');
}
await mkdir(workspace);
await cp(repoRoot, workspace, {
  recursive: true,
  filter: source => {
    const parts = relative(repoRoot, source).split(sep);
    return !parts.includes('.git') && !parts.includes('node_modules') && parts[0] !== 'lib';
  },
});

// Runtime tests import this separate consumer; updating only the root would
// keep exercising the old host even when typechecking against a new one.
const manifestPaths = ['package.json', '.verification/contracts/package.json'];
const manifests = await Promise.all(manifestPaths.map(async path =>
  JSON.parse(await readFile(resolve(workspace, path), 'utf8')),
));
const sections = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
const isDsh = name => name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-');
const isCordis = name => name === '@deepseek-ai/cordis' || name.startsWith('@deepseek-ai/cordis-');
const declaredPeerDependencies = { ...manifests[0].peerDependencies };
const [dsh, cordis] = await Promise.all([
  latestManifest('@deepseek-ai/dsh'), latestManifest('@deepseek-ai/cordis'),
]);
const names = [...new Set([
  ...manifests.flatMap(manifest => sections.flatMap(section => Object.keys(manifest[section] ?? {}))),
  ...Object.keys(dsh.dependencies ?? {}).filter(isCordis),
  ...Object.keys(cordis.peerDependencies ?? {}).filter(isCordis),
])].filter(name => isDsh(name) || isCordis(name)).sort();
const versions = Object.fromEntries(await Promise.all(names.map(async name => [
  name,
  // DSH publishes a synchronized family; individual service dist-tags can lag.
  isDsh(name) ? dsh.version : name === cordis.name ? cordis.version : (await latestManifest(name)).version,
])));
const cordisOverrides = Object.fromEntries(Object.entries(versions).filter(([name]) => isCordis(name)));
for (const [index, manifest] of manifests.entries()) {
  for (const section of sections) {
    for (const name of Object.keys(manifest[section] ?? {})) {
      if (versions[name]) manifest[section][name] = versions[name];
    }
  }
  // Force the runtime consumer onto the target Cordis, including its companions,
  // rather than allowing the host's older range to install another copy.
  if (index === 1) manifest.overrides = { ...manifest.overrides, ...cordisOverrides };
  await writeFile(resolve(workspace, manifestPaths[index]), `${JSON.stringify(manifest, null, 2)}\n`);
}
// This isolated latest-upstream probe must accept freshly published versions.
// Normal checkout/release installs retain the strict workspace cooldown.
// pnpm 11 reads overrides from the workspace configuration, not package.json.
await writeFile(resolve(workspace, 'pnpm-workspace.yaml'), `minimumReleaseAge: 0\noverrides:\n${
  Object.entries(cordisOverrides).map(([name, version]) => `  ${JSON.stringify(name)}: ${JSON.stringify(version)}`).join('\n')
}\n`);
await writeFile(resolve(workspace, 'upstream-versions.json'), `${JSON.stringify({
  checkedAt: new Date().toISOString(),
  channel: 'latest',
  package: `${manifests[0].name}@${manifests[0].version}`,
  declaredPeerDependencies,
  versions,
}, null, 2)}\n`);
if (process.env.GITHUB_OUTPUT) {
  await appendFile(process.env.GITHUB_OUTPUT, `dsh=${dsh.version}\ncordis=${cordis.version}\n`);
}
console.log(JSON.stringify({ workspace, versions }, null, 2));

async function latestManifest(name) {
  const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}/latest`, {
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`npm latest resolution failed for ${name}: HTTP ${response.status}`);
  const manifest = await response.json();
  if (manifest.name !== name || typeof manifest.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(manifest.version)) {
    throw new Error(`npm returned an invalid package version for ${name}`);
  }
  return manifest;
}
