import { describe, expect, it, vi } from 'vitest';
import { ProcessManager } from '../../../main/process-manager';
import { LocalCommandRunner } from '../../../main/process-manager/runners/LocalCommandRunner';
import { worktreeRetirement } from '../../../main/git/worktreeRetirement';

describe('command retirement admission', () => {
	it('holds the checkout until the runner settles and refuses a reserved checkout', async () => {
		const checkout = { path: process.cwd(), head: 'test-head', generation: 1 };
		expect(worktreeRetirement.register(checkout)).toBe(true);
		let finish!: (result: { exitCode: number }) => void;
		const run = vi.spyOn(LocalCommandRunner.prototype, 'run').mockReturnValueOnce(
			new Promise((resolve) => {
				finish = resolve;
			})
		);
		const manager = new ProcessManager();
		const command = manager.runCommand('test', 'test', checkout.path);
		expect(worktreeRetirement.prepare(checkout)).toMatchObject({ ok: false });
		finish({ exitCode: 0 });
		await command;
		const reservation = worktreeRetirement.prepare(checkout);
		expect(reservation.ok).toBe(true);
		if (!reservation.ok) throw new Error(reservation.reason);
		await expect(manager.runCommand('test', 'test', checkout.path)).rejects.toThrow('preparing');
		expect(run).toHaveBeenCalledTimes(1);
		expect(worktreeRetirement.abort(reservation.token)).toBe(true);
		run.mockRestore();
	});
});
