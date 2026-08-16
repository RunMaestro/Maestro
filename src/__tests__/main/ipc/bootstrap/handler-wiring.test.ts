/**
 * Wiring parity between the two IPC registration lists (MAESTRO-YV).
 *
 * `src/main/ipc/handlers/index.ts` exports `registerAllHandlers()`, which reads
 * like the authoritative registration list but is dead: nothing calls it. The
 * live path is `setupIpcHandlers()` in `src/main/ipc/bootstrap/index.ts`, which
 * `main/index.ts` invokes at app-ready.
 *
 * The Context Timeline handlers were added to the dead list only, so
 * `contextTimeline:getCaptures` / `contextTimeline:clearCaptures` were never
 * registered in a shipped build. The renderer fires `clearCaptures` as a
 * floating promise, so it surfaced as an unhandled rejection
 * ("No handler registered for 'contextTimeline:clearCaptures'") and the panel
 * silently hydrated empty on every reload.
 *
 * The per-handler unit test could not catch this: it calls
 * `registerContextTimelineHandlers()` directly, so it stayed green while
 * production was broken. This test reads the two sources instead and asserts
 * the invariant that actually held wrong - a registrar in the dead list must
 * also be invoked by the live one.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const SRC = path.resolve(__dirname, '../../../../main/ipc');
const HANDLERS_INDEX = path.join(SRC, 'handlers/index.ts');
const BOOTSTRAP_INDEX = path.join(SRC, 'bootstrap/index.ts');

/**
 * Registrar names that are *invoked* in a file. Requiring the open paren keeps
 * import/export list entries (`registerFooHandlers,` / `export { ... };`) out,
 * and matching anywhere on the line keeps assignment-form calls
 * (`const h = registerPersistenceHandlers({...})`) in.
 */
function invokedRegistrars(filePath: string): Set<string> {
	const source = readFileSync(filePath, 'utf-8');
	const names = source.match(/register[A-Za-z]+Handlers\(/g) ?? [];
	return new Set(names.map((n) => n.slice(0, -1)));
}

describe('IPC handler wiring parity', () => {
	it('registers every handler from the dead registerAllHandlers list in the live setupIpcHandlers', () => {
		const dead = invokedRegistrars(HANDLERS_INDEX);
		const live = invokedRegistrars(BOOTSTRAP_INDEX);

		// Sanity: the extraction found a realistic number of registrars, so a
		// regex that silently stops matching fails loudly instead of passing.
		expect(dead.size).toBeGreaterThan(30);
		expect(live.size).toBeGreaterThan(30);

		const missing = [...dead].filter((name) => !live.has(name)).sort();
		expect(missing).toEqual([]);
	});

	it('wires the Context Timeline handlers into the live bootstrap path', () => {
		expect(invokedRegistrars(BOOTSTRAP_INDEX)).toContain('registerContextTimelineHandlers');
	});
});
