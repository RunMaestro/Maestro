/**
 * Runtime-resolution tests for the bundled coworking MCP server.
 *
 * Contract under test (resolveNodeCommand / buildMcpServerSpec):
 *   - An absolute `node` from which/where is used verbatim, WITHOUT the
 *     Electron-as-node flag.
 *   - When the lookup throws, or yields a non-absolute / empty path, resolution
 *     falls back to THIS Electron binary (process.execPath) and marks
 *     runAsElectronNode, which makes buildMcpServerSpec inject
 *     ELECTRON_RUN_AS_NODE=1 while preserving the caller's env.
 *   - The resolved runtime is cached at module scope after the first lookup.
 *
 * The source uses promisify(execFile), so we mock child_process with a custom
 * promisified form (util.promisify.custom) that delegates to `execFileImpl`,
 * mirroring pid-resolution-windows.test.ts. The module-level cache means each
 * test re-imports a fresh module via vi.resetModules() (documented cache-reset
 * exception).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as path from 'path';
import type * as ServerPathsModule from '../../../main/coworking/coworking-server-paths';

const USER_DATA = '/tmp/coworking-test-userdata';
const SCRIPT_PATH = path.join(USER_DATA, 'coworking-mcp-server.js');

// Hoisted so the vi.mock factory (evaluated above these declarations) can close
// over it. The custom promisified form returns { stdout } or throws, standing in
// for the promisified execFile body.
const { execFileImpl } = vi.hoisted(() => ({ execFileImpl: vi.fn() }));

vi.mock('child_process', () => {
	const execFile = () => {
		throw new Error('coworking-server-paths must use the promisified execFile');
	};
	(execFile as unknown as Record<symbol, unknown>)[Symbol.for('nodejs.util.promisify.custom')] =
		async (file: string, args: string[], options: unknown) => execFileImpl(file, args, options);
	return { execFile, default: { execFile } };
});

vi.mock('electron', () => ({
	app: { getPath: () => USER_DATA },
}));

vi.mock('../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/** Fresh module instance so the module-level `resolvedNode` cache resets. A
 *  static import would share one cached runtime across every test, making the
 *  polarity and caching assertions meaningless. */
async function importFresh(): Promise<typeof ServerPathsModule> {
	vi.resetModules();
	return import('../../../main/coworking/coworking-server-paths');
}

describe('resolveNodeCommand', () => {
	beforeEach(() => {
		execFileImpl.mockReset();
	});

	it('uses the first absolute node path from which/where, without the Electron-as-node flag', async () => {
		// Leading blank line + surrounding whitespace + a second candidate: the
		// resolver must trim and take the first non-empty absolute line.
		execFileImpl.mockResolvedValue({ stdout: '\n  /usr/local/bin/node  \n/second/node\n' });
		const mod = await importFresh();

		expect(await mod.resolveNodeCommand()).toEqual({
			command: '/usr/local/bin/node',
			runAsElectronNode: false,
		});
	});

	it('falls back to the Electron binary in node mode when the lookup throws', async () => {
		execFileImpl.mockRejectedValue(new Error('which: node not found'));
		const mod = await importFresh();

		expect(await mod.resolveNodeCommand()).toEqual({
			command: process.execPath,
			runAsElectronNode: true,
		});
	});

	it('falls back to the Electron binary when the lookup yields a non-absolute path', async () => {
		// A bare `node` (PATH-relative) must not be trusted as the command.
		execFileImpl.mockResolvedValue({ stdout: 'node\n' });
		const mod = await importFresh();

		expect(await mod.resolveNodeCommand()).toEqual({
			command: process.execPath,
			runAsElectronNode: true,
		});
	});

	it('falls back to the Electron binary when the lookup yields empty output', async () => {
		execFileImpl.mockResolvedValue({ stdout: '\n  \n' });
		const mod = await importFresh();

		expect(await mod.resolveNodeCommand()).toEqual({
			command: process.execPath,
			runAsElectronNode: true,
		});
	});

	it('caches the resolved runtime, so a second call does not re-invoke the lookup', async () => {
		execFileImpl.mockResolvedValue({ stdout: '/usr/local/bin/node\n' });
		const mod = await importFresh();

		const first = await mod.resolveNodeCommand();
		const second = await mod.resolveNodeCommand();

		expect(second).toBe(first); // same cached object reference
		expect(execFileImpl).toHaveBeenCalledTimes(1);
	});
});

describe('buildMcpServerSpec', () => {
	beforeEach(() => {
		execFileImpl.mockReset();
	});

	it('absolute node: command is that node, args target the server script, env is passed through untouched', async () => {
		execFileImpl.mockResolvedValue({ stdout: '/usr/local/bin/node\n' });
		const mod = await importFresh();

		const spec = await mod.buildMcpServerSpec({ FOO: 'bar', PATH: '/x' });

		expect(spec.command).toBe('/usr/local/bin/node');
		expect(spec.args).toEqual([SCRIPT_PATH]);
		expect(spec.env).toEqual({ FOO: 'bar', PATH: '/x' });
		expect(spec.env.ELECTRON_RUN_AS_NODE).toBeUndefined();
	});

	it('Electron fallback: command is the Electron binary and env gains ELECTRON_RUN_AS_NODE=1 while keeping caller keys', async () => {
		execFileImpl.mockRejectedValue(new Error('no system node'));
		const mod = await importFresh();

		const input = { FOO: 'bar', PATH: '/x' };
		const spec = await mod.buildMcpServerSpec(input);

		expect(spec.command).toBe(process.execPath);
		expect(spec.args).toEqual([SCRIPT_PATH]);
		expect(spec.env).toEqual({ FOO: 'bar', PATH: '/x', ELECTRON_RUN_AS_NODE: '1' });
		// The flag lands on a NEW object; the caller's env is never mutated.
		expect(input).toEqual({ FOO: 'bar', PATH: '/x' });
	});
});
