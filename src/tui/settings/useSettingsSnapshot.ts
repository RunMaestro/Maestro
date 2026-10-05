import { useCallback, useEffect, useRef, useState } from 'react';
import {
	loadSettingsSnapshot,
	readSettingsSnapshotFromFiles,
	SETTINGS_SNAPSHOT_KEYS,
	type MaestroClient,
	type MaestroPaths,
	type SettingsSnapshot,
} from '../../shared/maestro-lib';

type SettingsPaths = Pick<MaestroPaths, 'userDataDir' | 'settingsFile' | 'agentConfigsFile'>;

/**
 * The settings the desktop holds, kept current (ST-1). The first frame reads the
 * files, so the Encore gate (ST-2) is answered before any host has; once a
 * desktop is attached the host's values replace them, and a `settings.changed`
 * event for one of the keys read re-reads. `reload` is the view's `r`.
 */
export function useSettingsSnapshot(
	paths: SettingsPaths,
	client: MaestroClient | undefined,
	live: boolean
): { snapshot: SettingsSnapshot; reload: () => void } {
	const [snapshot, setSnapshot] = useState(() => readSettingsSnapshotFromFiles(paths));
	// The newest load wins: a slow host answer must not overwrite a later one.
	const loadSeq = useRef(0);
	const pathsRef = useRef(paths);
	pathsRef.current = paths;

	const reload = useCallback(() => {
		const seq = ++loadSeq.current;
		void loadSettingsSnapshot(pathsRef.current, live ? client : undefined).then((next) => {
			if (seq === loadSeq.current) setSnapshot(next);
		});
	}, [client, live]);

	useEffect(() => {
		reload();
		if (!client || !live) return;
		return client.settings.subscribe(SETTINGS_SNAPSHOT_KEYS, reload);
	}, [client, live, reload]);

	return { snapshot, reload };
}
