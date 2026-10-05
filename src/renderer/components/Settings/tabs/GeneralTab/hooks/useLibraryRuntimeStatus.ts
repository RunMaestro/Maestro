import { useEffect, useState } from 'react';
import type { LibraryRuntimeStatus } from '../../../../../../shared/libraryRuntime';
import { loadLibraryRuntimeStatus } from '../../../../../services/libraryRuntime';

/**
 * What main is doing this run (`hosting`), for the "Restart Maestro to apply" line under the toggle.
 * `null` until main answers.
 */
export function useLibraryRuntimeStatus(): LibraryRuntimeStatus | null {
	const [status, setStatus] = useState<LibraryRuntimeStatus | null>(null);

	useEffect(() => {
		let active = true;
		void loadLibraryRuntimeStatus().then((next) => {
			if (active) setStatus(next);
		});
		return () => {
			active = false;
		};
	}, []);

	return status;
}
