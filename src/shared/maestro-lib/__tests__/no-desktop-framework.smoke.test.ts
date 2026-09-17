/**
 * Maestro-lib Part One smoke test.
 *
 * Proves the boundary is honest: a plain program with no Electron/desktop
 * framework present can load and use the library's provider knowledge,
 * parsers, and launch (env/binary-detection/remote-wrapping) surfaces.
 *
 * This does NOT assert the library is fully free of `src/main/**` imports -
 * see Plans/maestro-lib-part-one-checklist.md for the known residual
 * dependencies on plain Node utilities (logger, sentry, execFile, etc.) that
 * still live under `src/main/utils`. It asserts the one thing that must never
 * regress: nothing in the require graph is `electron` itself.
 */
import { describe, it, expect } from 'vitest';
import Module from 'module';

describe('maestro-lib: no desktop framework dependency', () => {
	it('loads provider definitions, capabilities, parsers, and launch helpers with no `electron` in the require graph', async () => {
		const moduleInternals = Module as any;
		const originalResolve = moduleInternals._resolveFilename;
		const requestedElectron: string[] = [];

		moduleInternals._resolveFilename = function patched(request: string, ...rest: any[]) {
			if (request === 'electron' || request.startsWith('electron/')) {
				requestedElectron.push(request);
			}
			return originalResolve.call(this, request, ...rest);
		};

		try {
			const definitions = await import('../providers/definitions');
			const capabilities = await import('../providers/capabilities');
			const parsers = await import('../parsers');
			const pathProber = await import('../launch/path-prober');
			const getShellPathModule = await import('../launch/getShellPath');
			const agentArgs = await import('../launch/agent-args');
			const sshSpawnWrapper = await import('../launch/ssh-spawn-wrapper');

			// Exercise a handful of pure entry points to confirm the modules are
			// actually usable, not just importable.
			expect(definitions.getAgentIds().length).toBeGreaterThan(0);
			expect(typeof capabilities.hasCapability).toBe('function');
			expect(typeof parsers.createOutputParser).toBe('function');
			expect(typeof pathProber.checkBinaryExists).toBe('function');
			expect(typeof getShellPathModule.getShellPath).toBe('function');
			expect(typeof agentArgs.buildAgentArgs).toBe('function');
			expect(typeof sshSpawnWrapper.wrapSpawnWithSsh).toBe('function');
		} finally {
			moduleInternals._resolveFilename = originalResolve;
		}

		expect(requestedElectron).toEqual([]);
	});
});
