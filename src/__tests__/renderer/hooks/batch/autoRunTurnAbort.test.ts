/**
 * The abort scope every Auto Run turn is awaited in (document runs and goal runs alike).
 *
 * A force-end must release a runner from a turn that never settles, or the run stays "stopping"
 * until the agent is removed. The runners spawn through `abortableAutoRunSpawn`, which
 * `useBatchProcessor` hands to both loops; `killBatchRun` calls `abortAutoRunTurns`.
 */

import { describe, expect, it, vi } from 'vitest';
import {
	abortableAutoRunSpawn,
	abortAutoRunTurns,
	AUTO_RUN_TURN_ABORTED,
	untilAutoRunTurnAborted,
} from '../../../../renderer/hooks/batch/internal/autoRunTurnAbort';

describe('the Auto Run turn abort scope', () => {
	it('settles a turn that never settles once the run is force-ended, and hands the spawn the signal', async () => {
		const spawn = vi.fn((..._args: unknown[]) => new Promise<never>(() => {}));
		const turn = abortableAutoRunSpawn(spawn as never)('agent-1', 'do it', undefined, {
			autoRunId: 'run-1',
		});

		expect(abortAutoRunTurns('agent-1')).toBe(1);

		await expect(turn).resolves.toEqual({ success: false, error: AUTO_RUN_TURN_ABORTED });
		const settings = spawn.mock.calls[0][3] as { autoRunId: string; abortSignal: AbortSignal };
		expect(settings.autoRunId).toBe('run-1');
		expect(settings.abortSignal.aborted).toBe(true);
	});

	it('passes a turn that settles on its own straight through, and leaves no scope behind', async () => {
		const spawn = vi.fn(async () => ({ success: true, response: 'done' }));
		await expect(abortableAutoRunSpawn(spawn)('agent-1', 'do it')).resolves.toEqual({
			success: true,
			response: 'done',
		});
		expect(abortAutoRunTurns('agent-1')).toBe(0);
	});

	it("ends only the named agent's turns", async () => {
		let otherSettled = false;
		const other = untilAutoRunTurnAborted(
			'agent-2',
			() => new Promise<string>(() => {}),
			() => 'x'
		);
		void other.then(() => {
			otherSettled = true;
		});
		const mine = untilAutoRunTurnAborted(
			'agent-1',
			() => new Promise<string>(() => {}),
			() => 'ended'
		);

		abortAutoRunTurns('agent-1');

		await expect(mine).resolves.toBe('ended');
		await Promise.resolve();
		expect(otherSettled).toBe(false);
		abortAutoRunTurns('agent-2');
		await expect(other).resolves.toBe('x');
	});
});
