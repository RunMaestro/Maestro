import { useEffect, useState } from 'react';
import type { LibraryRuntimeStatus } from '../../../shared/libraryRuntime';
import { loadLibraryRuntimeStatus } from '../../services/libraryRuntime';

/**
 * What main is doing this run (`hosting`). `null` until main answers.
 *
 * The answer is fixed for the run (DM2), so the hook renders once more when it arrives and never
 * again. Read it where a mounted component has to CHOOSE between the renderer-owned path and the
 * runtime's (the "Restart Maestro to apply" line, the remote CRUD listeners); a handler that runs
 * later can ask `isLibraryRuntimeHosting()` instead. Treat `null` as OFF: that is today's code,
 * and it is the safe reading while main has not answered.
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
