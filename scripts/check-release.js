// Проверява файловете за GitHub, без да показва намерените тайни стойности.
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

const output = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'utf8' });
const files = [...new Set(output.split('\0').filter(Boolean))];
const problems = [];
const secretPattern = /AIza[0-9A-Za-z_-]{35}|sk-(?:proj-)?[A-Za-z0-9_-]{40,}/;
for (const file of files) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) continue;
  if ((/(^|\/)\.env(?:\.|$)/.test(file) && file !== '.env.example') || /(^|\/)node_modules\//.test(file)) {
    problems.push(`${file}: private or generated file must be ignored`);
    continue;
  }
  if (/\.(?:png|jpe?g|webp|pdf|ico)$/i.test(file)) continue;
  if (secretPattern.test(fs.readFileSync(file, 'utf8'))) problems.push(`${file}: possible API key`);
}
if (problems.length) {
  console.error(problems.join('\n'));
  process.exitCode = 1;
} else {
  console.log(`Checked ${files.length} files: no recognized API keys or forbidden files found.`);
}
