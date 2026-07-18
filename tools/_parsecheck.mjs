// Scratch: syntax-only parse check for ESM files that import THREE from a CDN + absolute /shared paths
// (which won't RESOLVE under node). We import each via a data: URL: node PARSES the module source first
// (a SyntaxError throws here), THEN resolves imports (a resolution error is EXPECTED and means the
// syntax is fine). So: SyntaxError => real problem; any other error => parsed OK.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
for (const rel of ['js/scene.js', 'js/main.js']) {
  const src = readFileSync(join(root, rel), 'utf8');
  const url = 'data:text/javascript;base64,' + Buffer.from(src).toString('base64');
  try {
    await import(url);
    console.log(`${rel}: imported (no error at all?!)`);
  } catch (e) {
    if (e instanceof SyntaxError) console.log(`${rel}: ✗ SYNTAX ERROR — ${e.message}`);
    else console.log(`${rel}: ✓ parsed OK (expected resolution error: ${e.code || e.constructor.name})`);
  }
}
