// Bundles all Scripts/*.ts into one self-contained dist/GameManager.ts for Effect House
// (one paste into a "New Script Component"; no cross-file imports needed).
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);
const order = ['Easing', 'GameConfig', 'Questions', 'QuestionPicker', 'TextLayout', 'GameFlow', 'SceneNode', 'GameManager'];

const strip = (src, keepExport) => src
  // drop (possibly multi-line) import statements
  .replace(/^import[\s\S]*?from\s+['"][^'"]+['"];\s*$/gm, '')
  .replace(/^export (?=(const|function|class|type|interface|abstract)\b)/gm, (m) => (keepExport ? m : ''));

let out = `/**
 * GameManager — "מי פה? 👀" (single-file build for Effect House).
 * GENERATED from Scripts/*.ts by tools/build-single.mjs — edit the sources, not this file.
 * Paste into a "New Script Component" named GameManager and attach it to the GameManager object.
 */
`;
for (const name of order) {
  const src = readFileSync(join(root, 'Scripts', `${name}.ts`), 'utf8');
  out += `\n// ===== ${name}.ts =====\n` + strip(src, name === 'GameManager').replace(/\n{3,}/g, '\n\n');
}
writeFileSync(join(root, 'dist', 'GameManager.ts'), out);
console.log('dist/GameManager.ts', out.length, 'chars');
