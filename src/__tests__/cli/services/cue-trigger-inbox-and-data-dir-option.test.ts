import { describe as __maestroMicrobenchDescribe } from 'vitest';
import { describe } from 'vitest';
import { it } from 'vitest';
import { expect } from 'vitest';
import { beforeEach } from 'vitest';
import { afterEach } from 'vitest';
import { vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { drainCueTriggerInbox } from '../../../cli/services/cue-trigger-inbox';
import { startCueTriggerInbox } from '../../../cli/services/cue-trigger-inbox';
import { submitCueTrigger } from '../../../cli/services/cue-trigger-inbox';
import { applyDataDirOption } from '../../../cli/services/data-dir-option';
import { describeDataDirSource } from '../../../cli/services/data-dir-option';
import { matchTabId } from '../../../cli/services/session-command';
__maestroMicrobenchDescribe('cue-trigger-inbox', () => {
	describe('cue-trigger-inbox', () => {
		let dataDir: string;

		beforeEach(() => {
			dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cue-inbox-test-'));
		});

		afterEach(() => {
			fs.rmSync(dataDir, { recursive: true, force: true });
		});

		it('delivers a trigger to the engine and returns its answer', async () => {
			const handler = vi.fn(() => true);
			const stop = startCueTriggerInbox(handler, dataDir);
			try {
				const result = await submitCueTrigger(
					{ subscriptionName: 'deploy', prompt: 'staging only', sourceAgentId: 'agent-1' },
					{ dataDir, timeoutMs: 5000 }
				);
				expect(result).toEqual({ success: true, error: undefined });
				expect(handler).toHaveBeenCalledWith('deploy', 'staging only', 'agent-1');
			} finally {
				stop();
			}
			// Nothing is left behind once both sides are done.
			expect(fs.readdirSync(path.join(dataDir, 'cue-trigger-inbox'))).toEqual([]);
		});

		it('reports an unknown subscription as a failure, not a success', async () => {
			const stop = startCueTriggerInbox(() => false, dataDir);
			try {
				const result = await submitCueTrigger({ subscriptionName: 'nope' }, { dataDir });
				expect(result.success).toBe(false);
			} finally {
				stop();
			}
		});

		it('fires each request exactly once even when drained repeatedly', async () => {
			const handler = vi.fn(() => true);
			const pending = submitCueTrigger({ subscriptionName: 'once' }, { dataDir, timeoutMs: 3000 });
			await new Promise((resolve) => setTimeout(resolve, 20));
			drainCueTriggerInbox(handler, dataDir);
			drainCueTriggerInbox(handler, dataDir);
			expect((await pending).success).toBe(true);
			expect(handler).toHaveBeenCalledTimes(1);
		});

		it('times out cleanly and withdraws the request when no engine is serving', async () => {
			const result = await submitCueTrigger({ subscriptionName: 'x' }, { dataDir, timeoutMs: 200 });
			expect(result.success).toBe(false);
			expect(result.error).toMatch(/did not answer/);
			// A late-starting engine must not fire a request its sender gave up on.
			const handler = vi.fn(() => true);
			drainCueTriggerInbox(handler, dataDir);
			expect(handler).not.toHaveBeenCalled();
		});

		it('drops a stale request instead of firing it', () => {
			const dir = path.join(dataDir, 'cue-trigger-inbox');
			fs.mkdirSync(dir, { recursive: true });
			fs.writeFileSync(
				path.join(dir, 'old.request.json'),
				JSON.stringify({ subscriptionName: 'deploy', requestedAt: Date.now() - 5 * 60_000 })
			);
			const handler = vi.fn(() => true);
			drainCueTriggerInbox(handler, dataDir);
			expect(handler).not.toHaveBeenCalled();
			expect(fs.readdirSync(dir)).toEqual([]);
		});
	});
});
__maestroMicrobenchDescribe('data-dir-option', () => {
	afterEach(() => vi.restoreAllMocks());

	describe('applyDataDirOption', () => {
		it('sets MAESTRO_USER_DATA from the flag, overriding an inherited value', () => {
			const env: NodeJS.ProcessEnv = { MAESTRO_USER_DATA: '/srv/old' };
			const result = applyDataDirOption('/srv/maestro', env);
			expect(result).toEqual({ dir: path.resolve('/srv/maestro'), source: 'flag' });
			expect(env.MAESTRO_USER_DATA).toBe(path.resolve('/srv/maestro'));
		});

		it('expands a leading ~ and resolves relative paths against the working directory', () => {
			const env: NodeJS.ProcessEnv = {};
			expect(applyDataDirOption('~/maestro-data', env).dir).toBe(
				path.join(os.homedir(), 'maestro-data')
			);
			vi.spyOn(process, 'cwd').mockReturnValue(path.resolve('/work'));
			expect(applyDataDirOption('data', env).dir).toBe(path.resolve('/work', 'data'));
		});

		it('leaves the environment alone without the flag and reports where the dir came from', () => {
			const env: NodeJS.ProcessEnv = { MAESTRO_USER_DATA: '/srv/env' };
			expect(applyDataDirOption(undefined, env)).toEqual({
				dir: path.resolve('/srv/env'),
				source: 'env',
			});
			expect(env.MAESTRO_USER_DATA).toBe('/srv/env');
			expect(applyDataDirOption('  ', env).source).toBe('env');
			expect(applyDataDirOption(undefined, {}).source).toBe('default');
		});

		it('names each source for the startup log line', () => {
			expect(describeDataDirSource('flag')).toBe('--data-dir');
			expect(describeDataDirSource('env')).toBe('MAESTRO_USER_DATA');
			expect(describeDataDirSource('default')).toBe('platform default');
		});
	});
});
__maestroMicrobenchDescribe('match-tab-id', () => {
	const tabs = [{ id: 'abc123' }, { id: 'abc999' }, { id: 'def456' }, { id: 'abc' }];
	const idOf = (tab: { id: string }) => tab.id;

	describe('matchTabId', () => {
		it('prefers an exact id over a prefix it also matches', () => {
			expect(matchTabId(tabs, 'abc', idOf)).toEqual({ id: 'abc' });
		});

		it('takes a unique prefix', () => {
			expect(matchTabId(tabs, 'def', idOf)).toEqual({ id: 'def456' });
			expect(matchTabId(tabs, 'abc1', idOf)).toEqual({ id: 'abc123' });
		});

		it('refuses an ambiguous prefix and an unknown id', () => {
			const shared = [{ id: 'abc123' }, { id: 'abc999' }];
			expect(() => matchTabId(shared, 'abc', idOf)).toThrow("Ambiguous tab ID 'abc' (2 matches)");
			expect(() => matchTabId(tabs, 'zzz', idOf)).toThrow('Tab not found: zzz');
		});
	});
});
