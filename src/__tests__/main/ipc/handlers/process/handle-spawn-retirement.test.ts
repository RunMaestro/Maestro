import { describe, expect, it } from 'vitest';
import {
	handleProcessSpawn,
	type SpawnHandlerDependencies,
} from '../../../../../main/ipc/handlers/process/handle-spawn';
import { worktreeRetirement } from '../../../../../main/git/worktreeRetirement';

describe('desktop spawn retirement admission', () => {
	it('refuses a reserved checkout before resolving process dependencies', async () => {
		const checkout = { path: process.cwd(), head: 'spawn-test', generation: 1 };
		expect(worktreeRetirement.register(checkout)).toBe(true);
		const reservation = worktreeRetirement.prepare(checkout);
		if (!reservation.ok) throw new Error(reservation.reason);
		try {
			await expect(
				handleProcessSpawn(
					{ sessionId: 'test', toolType: 'terminal', cwd: checkout.path, command: '', args: [] },
					{} as SpawnHandlerDependencies
				)
			).rejects.toThrow('preparing');
		} finally {
			worktreeRetirement.abort(reservation.token);
		}
	});
});
