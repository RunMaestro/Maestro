/**
 * useHomeDir - the user's home directory, for tilde expansion in path fields.
 *
 * Wraps the module-level cache in `utils/homeDir` so the value is synchronous on
 * every render after the first IPC fetch, and components stop hand-rolling
 * `useState('') + useEffect(() => window.maestro.fs.homeDir().then(setHomeDir))`.
 *
 * Returns '' until the fetch resolves. Treat that as "cannot expand `~` yet"
 * rather than "home is empty" - the shared path helpers leave `~` untouched
 * when no home directory is supplied.
 */

import { useEffect, useState } from 'react';

import { getHomeDir, getHomeDirAsync } from '../../utils/homeDir';

export function useHomeDir(): string {
	const [homeDir, setHomeDir] = useState<string>(() => getHomeDir() ?? '');

	useEffect(() => {
		if (homeDir) return;
		let cancelled = false;
		void getHomeDirAsync()?.then((dir) => {
			if (!cancelled) setHomeDir(dir);
		});
		return () => {
			cancelled = true;
		};
	}, [homeDir]);

	return homeDir;
}
