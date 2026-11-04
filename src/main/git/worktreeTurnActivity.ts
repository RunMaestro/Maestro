import { beginGlobalWorktreeActivity } from './worktreeActivity';
import { startTurn, TurnNotStartedError } from '../../shared/maestro-lib/run/start-turn';

/**
 * Run one synchronous native-turn setup under conservative global admission.
 * Retain activity until setup, independently observed child close and all
 * explicitly observed promises settle. A missing handle/observer stays blocked;
 * only TurnNotStartedError proves that a failed launch created no child.
 *
 * This covers one local child, not descendants or future callbacks. Callers must
 * observe their setup/control/reporting work while the lifetime is still held.
 * Missing native/client/OS/external coverage remains a cleanup blocker.
 */
export function withWorktreeTurnActivity<T>(
	operation: (
		start: typeof startTurn,
		observe: <Result>(completion: Promise<Result>) => Promise<Result>
	) => T,
	reportError: (error: unknown) => void
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
		try {
			reportError(error);
		} catch {
			// Diagnostics cannot replace the original error or break bookkeeping.
		}
	};
	const observe = <Result>(completion: Promise<Result>): Promise<Result> => {
		pending++;
		void completion.catch(reportFailure).finally(() => {
			pending--;
			releaseIfSettled();
		});
		return completion;
	};
	const start: typeof startTurn = (spec, handlers, options) => {
		if (setupSettled || launchAttempted)
			throw new Error('Native turn activity permits one launch during synchronous setup.');
		launchAttempted = true;
		nativeMayExist = true;
		let turn;
		try {
			turn = startTurn(spec, handlers, options);
		} catch (error) {
			if (error instanceof TurnNotStartedError) nativeMayExist = false;
			throw error;
		}
		// done may settle on error; only close proves the child/stdio ended.
		turn.child.on('close', () => {
			closed = true;
			releaseIfSettled();
		});
		return turn;
	};
	try {
		return operation(start, observe);
	} catch (error) {
		reportFailure(error);
		throw error;
	} finally {
		setupSettled = true;
		releaseIfSettled();
	}
}
