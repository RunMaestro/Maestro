import { createKeyedWriteQueue } from '../../shared/keyedWriteQueue';
import { yieldToEventLoop } from '../utils/concurrency';
import { execGitReadOnly } from '../utils/remote-git';

const starts = createKeyedWriteQueue();

/** Spread background PR process starts across turns; keep their I/O concurrent. */
export async function scheduleWorktreePullRequestRead<T>(read: () => Promise<T>): Promise<T> {
	const { pending } = await starts.enqueue('start', async () => {
		await yieldToEventLoop();
		// Do not return/await the read itself inside the queue: a slow network
		// request must not hold up starts for every other checkout.
		return { pending: read() };
	});
	return pending;
}

export function execWorktreeGitReadOnly(args: string[], cwd: string) {
	const capturedArgs = [...args];
	return execGitReadOnly(
		capturedArgs,
		cwd,
		undefined,
		undefined,
		undefined,
		scheduleWorktreePullRequestRead
	);
}
