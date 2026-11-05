import { beginGlobalWorktreeActivity } from './worktreeActivity';
import { startTurn, TurnNotStartedError } from '../../shared/maestro-lib/run/start-turn';
import {
	spawn,
	type ChildProcess,
	type ChildProcessWithoutNullStreams,
	type SpawnOptionsWithoutStdio,
} from 'child_process';

export type WorktreeChildSpawner = (
	command: string,
	args: readonly string[],
	options: SpawnOptionsWithoutStdio
) => ChildProcessWithoutNullStreams;

/** Admit a retained portable callback and observe a returned native Promise. */
export function withWorktreeCallbackActivity<T>(
	operation: () => T,
	reportError: (error: unknown) => void | Promise<void>
): T {
	return withWorktreeTurnActivity((_start, observe) => {
		const result = operation();
		if (result instanceof Promise) observe(result);
		return result;
	}, reportError);
}

/**
 * Run one synchronous native-turn setup under conservative global admission.
 * Retain activity until setup, independently observed child close and all
 * explicitly observed promises settle. A missing handle/observer stays blocked;
 * only TurnNotStartedError proves that a failed launch created no child.
 *
 * This covers one local child, not descendants or future callbacks. Callers must
 * observe their setup/control work while the lifetime is still held. Returned
 * diagnostic promises are retained even if reporting rejects; diagnostic
 * failures are consumed without recursively reporting or changing outcomes.
 * Missing native/client/OS/external coverage remains a cleanup blocker.
 */
export function withWorktreeTurnActivity<T>(
	operation: (
		start: typeof startTurn,
		observe: <Result>(completion: Promise<Result>) => Promise<Result>,
		spawnChild: WorktreeChildSpawner
	) => T,
	reportError: (error: unknown) => void | Promise<void>
): T {
	// Refuse before invoking any caller setup or fallback/recovery.
	const release = beginGlobalWorktreeActivity();
	let setupSettled = false;
	let launchAttempted = false;
	let nativeMayExist = false;
	let closed = false;
	let pending = 0;
	const releaseIfSettled = (): void => {
		if (setupSettled && (!nativeMayExist || closed) && !pending) release();
	};
	const reportFailure = (error: unknown): void => {
		pending++;
		try {
			const reporting = reportError(error);
			if (reporting) {
				void Promise.resolve(reporting)
					.catch(() => {})
					.finally(() => {
						pending--;
						releaseIfSettled();
					});
				return;
			}
		} catch {
			// Diagnostics cannot replace the original error or break bookkeeping.
		}
		pending--;
		releaseIfSettled();
	};
	const observe = <Result>(completion: Promise<Result>): Promise<Result> => {
		pending++;
		void completion.catch(reportFailure).finally(() => {
			pending--;
			releaseIfSettled();
		});
		return completion;
	};
	const launch = <Handle>(
		create: () => Handle,
		childOf: (handle: Handle) => ChildProcess
	): Handle => {
		if (setupSettled || launchAttempted)
			throw new Error('Native turn activity permits one launch during synchronous setup.');
		launchAttempted = true;
		nativeMayExist = true;
		let handle: Handle;
		try {
			handle = create();
		} catch (error) {
			if (error instanceof TurnNotStartedError) nativeMayExist = false;
			throw error;
		}
		// done may settle on error; only close proves the child/stdio ended.
		childOf(handle).on('close', () => {
			closed = true;
			releaseIfSettled();
		});
		return handle;
	};
	const start: typeof startTurn = (spec, handlers, options) =>
		launch(
			() => startTurn(spec, handlers, options),
			(turn) => turn.child
		);
	// SDKs own their stream decoding and cancellation. Preserve their native
	// options without attaching a second reader or changing their stop behavior.
	const spawnChild: WorktreeChildSpawner = (command, args, options) =>
		launch(
			() => {
				try {
					return spawn(command, args, { ...options, stdio: ['pipe', 'pipe', 'pipe'] });
				} catch (error) {
					throw new TurnNotStartedError(error);
				}
			},
			(child) => child
		);
	try {
		return operation(start, observe, spawnChild);
	} catch (error) {
		reportFailure(error);
		throw error;
	} finally {
		setupSettled = true;
		releaseIfSettled();
	}
}
