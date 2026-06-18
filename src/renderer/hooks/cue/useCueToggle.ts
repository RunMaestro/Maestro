/**
 * useCueToggle — master enable/disable toggle for Cue engine.
 *
 * Wraps useCue's `enable` / `disable` with a `toggling` boolean (NOT a ref —
 * the state flip is what disables the UI button so double-clicks are blocked).
 * Error handling: surfaces failures as toasts; `toggling` is always restored
 * to false in the finally branch.
 */

import { useCallback, useState } from 'react';
import { notifyToast } from '../../stores/notificationStore';

export interface UseCueToggleParams {
	isEnabled: boolean;
	enable: () => Promise<void>;
	disable: () => Promise<void>;
}

export interface UseCueToggleReturn {
	toggling: boolean;
	handleToggle: () => Promise<void>;
}

export function useCueToggle({
	isEnabled,
	enable,
	disable,
}: UseCueToggleParams): UseCueToggleReturn {
	const [toggling, setToggling] = useState(false);

	const handleToggle = useCallback(async () => {
		if (toggling) return;
		setToggling(true);
		try {
			if (isEnabled) {
				await disable();
			} else {
				await enable();
			}
		} catch (err) {
			notifyToast({
				type: 'error',
				title: 'Cue',
				message:
					err instanceof Error
						? err.message
						: isEnabled
							? 'Failed to disable Cue engine'
							: 'Failed to enable Cue engine',
			});
		} finally {
			setToggling(false);
		}
	}, [isEnabled, enable, disable, toggling]);

	return { toggling, handleToggle };
}
