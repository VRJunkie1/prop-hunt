// Loads content-as-data config from shared/config. Everything that designers
// might want to tweak (rules, maps, prop catalog) lives in JSON, not code, so
// future maps / abilities / rule changes never touch the engine.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const cfgDir = join(here, '..', 'shared', 'config');

const load = (file) => JSON.parse(readFileSync(join(cfgDir, file), 'utf8'));

export const rules = load('rules.json');
export const maps = load('maps.json');
export const propCatalog = load('props.json');

// Default map used for a freshly created room. Kept as the first defined map so
// adding maps.json entries is enough to make them selectable later.
export const DEFAULT_MAP_ID = Object.keys(maps)[0];
