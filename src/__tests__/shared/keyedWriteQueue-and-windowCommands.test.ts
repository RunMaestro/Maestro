import { describe as __maestroMicrobenchDescribe } from 'vitest';
import { describe } from 'vitest';
import { expect } from 'vitest';
import { it } from 'vitest';
import { createKeyedWriteQueue } from '../../shared/keyedWriteQueue';
import { normalizeWindowCommandResult } from '../../shared/windowCommands';
import { parseWindowCommandRequest } from '../../shared/windowCommands';
import { holdsFileTreeCache } from '../../shared/fileTreeCache';
import { unloadedFileTreeState } from '../../shared/fileTreeCache';
import { withoutFileTreeCache } from '../../shared/fileTreeCache';
import { feedbackReportFingerprint } from '../../shared/feedback';
import { isSqliteCorruptionError } from '../../shared/sqliteErrors';
import { areToastsEnabled } from '../../shared/toastDuration';
import { DEFAULT_TOAST_DURATION } from '../../shared/toastDuration';
import { resolveEnabledToastDuration } from '../../shared/toastDuration';
import { TOAST_DURATION_OFF } from '../../shared/toastDuration';
import { describeModelsRefresh } from '../../shared/agentModelsRefresh';
import { summarizeModelsRefresh } from '../../shared/agentModelsRefresh';
import { THINKING_MODES } from '../../shared/types';
import { nextThinkingMode } from '../../shared/types';
import { asThinkingMode } from '../../shared/types';
__maestroMicrobenchDescribe('keyedWriteQueue', () => {
	const gate = () => {
		let release: () => void = () => {};
		const promise = new Promise<void>((resolve) => {
			release = resolve;
		});
		return { promise, release };
	};

	describe('createKeyedWriteQueue', () => {
		it('runs work on one key in order, and different keys at once', async () => {
			const queue = createKeyedWriteQueue();
			const order: string[] = [];
			const first = gate();
			const a1 = queue.enqueue('a', async () => {
				order.push('a1 start');
				await first.promise;
				order.push('a1 end');
			});
			const a2 = queue.enqueue('a', async () => void order.push('a2'));
			const b1 = queue.enqueue('b', async () => void order.push('b1'));

			await b1;
			expect(order).toEqual(['a1 start', 'b1']);
			first.release();
			await Promise.all([a1, a2]);
			expect(order).toEqual(['a1 start', 'b1', 'a1 end', 'a2']);
		});

		describe('idle', () => {
			it('resolves at once when nothing is queued', async () => {
				await expect(createKeyedWriteQueue().idle()).resolves.toBeUndefined();
			});

			it('waits for every key, including work chained behind a running write', async () => {
				const queue = createKeyedWriteQueue();
				const done: string[] = [];
				const slow = gate();
				void queue.enqueue('a', async () => {
					await slow.promise;
					done.push('a1');
				});
				void queue.enqueue('a', async () => void done.push('a2'));
				void queue.enqueue('b', async () => void done.push('b1'));

				let idle = false;
				const waiting = queue.idle().then(() => {
					idle = true;
				});
				await new Promise((resolve) => setTimeout(resolve, 20));
				expect(idle).toBe(false);

				slow.release();
				await waiting;
				expect(done.sort()).toEqual(['a1', 'a2', 'b1']);
			});

			it('does not reject when a write failed: the caller of that write already heard', async () => {
				const queue = createKeyedWriteQueue();
				const failed = queue.enqueue('a', async () => {
					throw new Error('disk full');
				});
				await expect(failed).rejects.toThrow('disk full');
				await expect(queue.idle()).resolves.toBeUndefined();
			});
		});
	});
});
__maestroMicrobenchDescribe('windowCommands', () => {
	describe('parseWindowCommandRequest', () => {
		it('accepts list with nothing else', () => {
			expect(parseWindowCommandRequest({ action: 'list', targetId: 'ignored' })).toEqual({
				ok: true,
				request: { action: 'list' },
			});
		});

		it('requires a target and a destination for moves', () => {
			expect(parseWindowCommandRequest({ action: 'move-group', to: 'new' })).toEqual({
				ok: false,
				error: 'window move-group requires a group id',
			});
			expect(parseWindowCommandRequest({ action: 'move-agent', targetId: 'a' })).toEqual({
				ok: false,
				error: 'window move-agent requires a destination (--to)',
			});
			expect(
				parseWindowCommandRequest({ action: 'move-agent', targetId: ' a ', to: ' 2 ' })
			).toEqual({ ok: true, request: { action: 'move-agent', targetId: 'a', to: '2' } });
		});

		it('rejects an unknown action', () => {
			const parsed = parseWindowCommandRequest({ action: 'teleport' });
			expect(parsed.ok).toBe(false);
		});
	});

	describe('normalizeWindowCommandResult', () => {
		it('turns a malformed reply into a failure', () => {
			expect(normalizeWindowCommandResult(null).success).toBe(false);
			expect(normalizeWindowCommandResult({ success: 'yes' })).toEqual({
				success: false,
				error: 'Window command failed',
			});
		});

		it('keeps the known fields of a success', () => {
			expect(
				normalizeWindowCommandResult({
					success: true,
					windowId: 'w',
					windowLabel: 'Window 2',
					movedAgentIds: ['a'],
					junk: 1,
				})
			).toEqual({ success: true, windowId: 'w', windowLabel: 'Window 2', movedAgentIds: ['a'] });
		});
	});
});
__maestroMicrobenchDescribe('fileTreeCache', () => {
	describe('fileTreeCache', () => {
		it('reports no cache for an unscanned agent or one in the stored shape', () => {
			expect(holdsFileTreeCache({ id: 'a' })).toBe(false);
			expect(holdsFileTreeCache({ id: 'a', ...unloadedFileTreeState() })).toBe(false);
		});

		it('reports a cache for a scanned tree or a scan marker left beside an empty one', () => {
			expect(holdsFileTreeCache({ fileTree: [{ name: 'src' }] })).toBe(true);
			expect(holdsFileTreeCache({ fileTree: [], fileTreeLoadedCap: 250000 })).toBe(true);
			expect(holdsFileTreeCache({ fileTree: [], fileTreeStats: { fileCount: 0 } })).toBe(true);
			expect(holdsFileTreeCache({ fileTreeLoading: true })).toBe(true);
		});

		it('returns the same object when there is nothing to drop', () => {
			const agent = { id: 'a', name: 'Agent' };
			expect(withoutFileTreeCache(agent)).toBe(agent);
		});

		it('resets every scan field and keeps the rest of the agent', () => {
			const stripped = withoutFileTreeCache({
				id: 'a',
				name: 'Agent',
				fileTree: [{ name: 'src', children: [] }],
				fileTreeStats: { fileCount: 1, folderCount: 1, totalSize: 10 },
				fileTreeLoadedCap: 250000,
				fileTreeTruncated: false,
				fileTreeLastScanTime: 123,
			});
			expect(stripped).toEqual({ id: 'a', name: 'Agent', ...unloadedFileTreeState() });
			expect(JSON.parse(JSON.stringify(stripped))).toEqual({
				id: 'a',
				name: 'Agent',
				fileTree: [],
				fileTreeLoading: false,
			});
		});
	});
});
__maestroMicrobenchDescribe('feedbackReportFingerprint', () => {
	const base = {
		category: 'bug_report' as const,
		summary: 'Player stuck',
		expectedBehavior: 'It moves',
		actualBehavior: 'It does not',
	};

	describe('feedbackReportFingerprint', () => {
		it('is stable across line-ending and surrounding-whitespace differences', () => {
			const first = feedbackReportFingerprint({
				...base,
				reproductionSteps: '1. Open\r\n2. Click',
				additionalContext: '  context  ',
			});
			const second = feedbackReportFingerprint({
				...base,
				reproductionSteps: '1. Open\n2. Click',
				additionalContext: 'context',
			});
			expect(first).toBe(second);
		});

		it('changes when the user changes the report', () => {
			expect(feedbackReportFingerprint({ ...base, summary: 'Other' })).not.toBe(
				feedbackReportFingerprint(base)
			);
			expect(feedbackReportFingerprint({ ...base, includeDebugPackage: true })).not.toBe(
				feedbackReportFingerprint(base)
			);
		});

		it('includes attachment names', () => {
			const withScreenshot = feedbackReportFingerprint({
				...base,
				attachments: [{ name: 'shot.png' }],
			});
			expect(withScreenshot).not.toBe(feedbackReportFingerprint(base));
			expect(feedbackReportFingerprint({ ...base, attachments: [{ name: 'shot.png' }] })).toBe(
				withScreenshot
			);
		});
	});
});
__maestroMicrobenchDescribe('sqliteErrors', () => {
	function sqliteError(code: string): Error {
		return Object.assign(new Error(code), { code });
	}

	describe('isSqliteCorruptionError', () => {
		it('classifies SQLITE_CORRUPT, its extended codes and SQLITE_NOTADB as corruption', () => {
			expect(isSqliteCorruptionError(sqliteError('SQLITE_CORRUPT'))).toBe(true);
			expect(isSqliteCorruptionError(sqliteError('SQLITE_CORRUPT_INDEX'))).toBe(true);
			expect(isSqliteCorruptionError(sqliteError('SQLITE_NOTADB'))).toBe(true);
		});

		it('does not classify lock, I/O or plain errors as corruption', () => {
			expect(isSqliteCorruptionError(sqliteError('SQLITE_BUSY'))).toBe(false);
			expect(isSqliteCorruptionError(sqliteError('SQLITE_IOERR'))).toBe(false);
			expect(isSqliteCorruptionError(new Error('database disk image is malformed'))).toBe(false);
			expect(isSqliteCorruptionError(null)).toBe(false);
			expect(isSqliteCorruptionError('SQLITE_CORRUPT')).toBe(false);
		});

		it('does not classify a native addon that failed to load as corruption', () => {
			const dlopen = Object.assign(
				new Error(
					'was compiled against a different Node.js version using NODE_MODULE_VERSION 147. This version of Node.js requires NODE_MODULE_VERSION 145.'
				),
				{ code: 'ERR_DLOPEN_FAILED' }
			);
			expect(isSqliteCorruptionError(dlopen)).toBe(false);
		});
	});
});
__maestroMicrobenchDescribe('toastDuration', () => {
	describe('areToastsEnabled', () => {
		it('is false only for the off sentinel', () => {
			expect(areToastsEnabled(TOAST_DURATION_OFF)).toBe(false);
			expect(areToastsEnabled(0)).toBe(true);
			expect(areToastsEnabled(5)).toBe(true);
		});
	});

	describe('resolveEnabledToastDuration', () => {
		it('restores a remembered positive duration', () => {
			expect(resolveEnabledToastDuration(5)).toBe(5);
		});

		it('restores "Never" (0) rather than treating it as missing', () => {
			expect(resolveEnabledToastDuration(0)).toBe(0);
		});

		it('falls back to the default for anything unusable', () => {
			expect(resolveEnabledToastDuration(TOAST_DURATION_OFF)).toBe(DEFAULT_TOAST_DURATION);
			expect(resolveEnabledToastDuration(undefined)).toBe(DEFAULT_TOAST_DURATION);
			expect(resolveEnabledToastDuration('10')).toBe(DEFAULT_TOAST_DURATION);
			expect(resolveEnabledToastDuration(Number.NaN)).toBe(DEFAULT_TOAST_DURATION);
		});
	});
});
__maestroMicrobenchDescribe('agentModelsRefresh', () => {
	describe('summarizeModelsRefresh', () => {
		it('reports the new total and which models came and went', () => {
			expect(
				summarizeModelsRefresh(['ollama/a', 'ollama/b'], ['ollama/a', 'ollama/c', 'ollama/d'])
			).toEqual({ total: 3, added: ['ollama/c', 'ollama/d'], removed: ['ollama/b'] });
		});

		it('does not count the "" agent-default sentinel as a model', () => {
			expect(summarizeModelsRefresh([''], ['', 'ollama/a'])).toEqual({
				total: 1,
				added: ['ollama/a'],
				removed: [],
			});
		});
	});

	describe('describeModelsRefresh', () => {
		it('names only the changes that happened', () => {
			expect(describeModelsRefresh({ total: 14, added: [], removed: [] })).toBe('14 models');
			expect(describeModelsRefresh({ total: 1, added: ['a'], removed: [] })).toBe('1 model, 1 new');
			expect(describeModelsRefresh({ total: 3, added: ['a', 'b'], removed: ['c'] })).toBe(
				'3 models, 2 new, 1 gone'
			);
		});
	});
});
__maestroMicrobenchDescribe('thinkingModes', () => {
	describe('thinking mode helpers', () => {
		it('cycles off -> on -> sticky -> off', () => {
			// The composer chip and `maestro-cli tab thinking <id> cycle` share this
			// order; if it changes, a click and a CLI cycle disagree.
			expect(THINKING_MODES).toEqual(['off', 'on', 'sticky']);
			expect(nextThinkingMode('off')).toBe('on');
			expect(nextThinkingMode('on')).toBe('sticky');
			expect(nextThinkingMode('sticky')).toBe('off');
		});

		it('treats an unset mode as off', () => {
			expect(nextThinkingMode(undefined)).toBe('on');
		});

		it('narrows only the three real modes', () => {
			expect(asThinkingMode('sticky')).toBe('sticky');
			expect(asThinkingMode('loud')).toBeUndefined();
			expect(asThinkingMode(true)).toBeUndefined();
			expect(asThinkingMode(null)).toBeUndefined();
			expect(asThinkingMode(undefined)).toBeUndefined();
		});
	});
});
