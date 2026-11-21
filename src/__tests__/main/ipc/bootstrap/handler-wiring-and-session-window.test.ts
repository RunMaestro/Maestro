import { describe as __maestroMicrobenchDescribe } from 'vitest';
import { describe } from 'vitest';
import { it } from 'vitest';
import { expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { vi } from 'vitest';
import { resolveSessionWindow } from '../../../../main/ipc/bootstrap/session-window';
__maestroMicrobenchDescribe('handler-wiring', () => {
	const SRC = path.resolve(__dirname, '../../../../main/ipc');
	const HANDLERS_INDEX = path.join(SRC, 'handlers/index.ts');
	const BOOTSTRAP_INDEX = path.join(SRC, 'bootstrap/index.ts');

	/** Strip line and block comments so prose cannot be mistaken for a call. */
	function stripComments(source: string): string {
		return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, '');
	}

	/**
	 * Registrar names that are *invoked* in a file. Requiring the open paren keeps
	 * import/export list entries (`registerFooHandlers,` / `export { ... };`) out,
	 * and matching anywhere on the line keeps assignment-form calls
	 * (`const h = registerPersistenceHandlers({...})`) in.
	 *
	 * Comments are stripped first and declarations are excluded, because both look
	 * exactly like calls to a regex. Without that this test passes for the wrong
	 * reason: `registerAllHandlers(` matches its own `function` declaration in the
	 * handlers file, and a comment in the bootstrap file mentioning
	 * `registerAllHandlers()` matches there, so the two cancel out. Editing that
	 * comment would then fail the test, and a registrar-shaped comment could hide a
	 * genuinely missing live registration.
	 */
	function invokedRegistrars(filePath: string): Set<string> {
		const source = stripComments(readFileSync(filePath, 'utf-8'));
		const names = source.match(/(?<!function\s)register[A-Za-z]+Handlers\(/g) ?? [];
		return new Set(names.map((n) => n.slice(0, -1)));
	}

	describe('IPC handler wiring parity', () => {
		it('registers every handler from the dead registerAllHandlers list in the live setupIpcHandlers', () => {
			// The wrapper is the dead list itself, not a member of it. Nothing is
			// expected to call it - that is the whole premise of this test.
			const dead = invokedRegistrars(HANDLERS_INDEX);
			dead.delete('registerAllHandlers');
			const live = invokedRegistrars(BOOTSTRAP_INDEX);

			// Sanity: the extraction found a realistic number of registrars, so a
			// regex that silently stops matching fails loudly instead of passing.
			expect(dead.size).toBeGreaterThan(30);
			expect(live.size).toBeGreaterThan(30);

			const missing = [...dead].filter((name) => !live.has(name)).sort();
			expect(missing).toEqual([]);
		});

		it('uses the composed post-flush Pianola consumer in the live bootstrap', () => {
			const source = stripComments(readFileSync(BOOTSTRAP_INDEX, 'utf8'));
			expect(source).toContain(
				'onSessionsPersisted: pianolaPersistenceConsumer(deps.getPianolaSupervisor)'
			);
			expect(source).toContain("from './pianola-persistence'");
		});

		it('registers the same plugin create/delete implementation as the adapter composition', () => {
			const source = stripComments(readFileSync(path.resolve(SRC, '../index.ts'), 'utf8'));
			expect(source).toContain("from './plugins/plugin-session-lifecycle'");
			expect(source).toMatch(
				/create: pluginSessionsCreate, remove: pluginSessionsDelete[\s\S]*?createPluginSessionLifecycle\(/
			);
			expect(source).toContain('flush: flushPendingSessionWrites');
			expect(source).toContain('sessionsCreate: pluginSessionsCreate');
			expect(source).toContain('sessionsDelete: pluginSessionsDelete');
		});

		it('wires the Context Timeline handlers into the live bootstrap path', () => {
			expect(invokedRegistrars(BOOTSTRAP_INDEX)).toContain('registerContextTimelineHandlers');
		});
	});
});
__maestroMicrobenchDescribe('session-window', () => {
	function fixture(ownerId: string | null, ownerPresent = true) {
		const primary = { name: 'primary' };
		const secondary = { name: 'secondary' };
		const deps = {
			windowRegistry: {
				getWindowForSession: vi.fn(() => ownerId),
				get: vi.fn(() => (ownerPresent ? { browserWindow: secondary } : undefined)),
			},
			getMainWindow: vi.fn(() => primary),
		};
		return { primary, secondary, deps };
	}

	describe('resolveSessionWindow', () => {
		it('resolves unclaimed agents to the primary catch-all window', () => {
			const { primary, deps } = fixture(null);
			expect(resolveSessionWindow('new-agent', deps as never)).toBe(primary);
		});

		it('preserves explicit secondary ownership', () => {
			const { secondary, deps } = fixture('window-2');
			expect(resolveSessionWindow('claimed-agent', deps as never)).toBe(secondary);
			expect(deps.getMainWindow).not.toHaveBeenCalled();
		});

		it('does not reroute a stale explicit owner to the primary window', () => {
			const { deps } = fixture('window-missing', false);
			expect(resolveSessionWindow('claimed-agent', deps as never)).toBeNull();
			expect(deps.getMainWindow).not.toHaveBeenCalled();
		});
	});
});
