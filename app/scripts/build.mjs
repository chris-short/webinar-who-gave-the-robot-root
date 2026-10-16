import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
rmSync('dist', { recursive: true, force: true });
mkdirSync('dist');
cpSync('src', 'dist/src', { recursive: true });
writeFileSync('dist/release.json', JSON.stringify({
  version,
  commit: process.env.CODEBUILD_RESOLVED_SOURCE_VERSION ?? 'local',
  builtAt: new Date().toISOString(),
}, null, 2));
console.log(`Built ${version} into dist/`);
