/**
 * Run one `tabWindows:*` call from a tab window. A refusal (the call answered
 * with an error) is expected and shown as a toast. A rejection is not: it is
 * shown the same way and also reported to Sentry.
 *
 * Resolves true when the call succeeded, so a caller can settle what it showed
 * optimistically.
 */

import { notifyToast } from '../../stores/notificationStore';
import { ipcErrorMessage } from '../../utils/ipcErrorMessage';
import { captureException } from '../../utils/sentry';

export async function runTabWindowCall<T>(
	operation: string,
	call: () => Promise<T>,
	refusal: (result: T) => string | null
): Promise<boolean> {
	try {
		const error = refusal(await call());
		if (!error) return true;
		notifyToast({ color: 'red', title: 'Tab Window', message: error });
		return false;
	} catch (error) {
		notifyToast({ color: 'red', title: 'Tab Window', message: ipcErrorMessage(error) });
		captureException(error instanceof Error ? error : new Error(String(error)), {
			extra: { operation: `tabWindows.${operation}` },
		});
		return false;
	}
}
