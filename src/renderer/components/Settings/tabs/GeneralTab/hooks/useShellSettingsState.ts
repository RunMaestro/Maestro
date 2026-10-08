import { useCallback, useState } from 'react';
import type { ShellInfo } from '../../../../../types';
import { logger } from '../../../../../utils/logger';
import { captureException } from '../../../../../utils/sentry';
import type { ShellSettingsState } from '../types';

interface UseShellSettingsStateArgs {
	setDefaultShell: (shellId: string) => void;
}

export function useShellSettingsState({
	setDefaultShell,
}: UseShellSettingsStateArgs): ShellSettingsState {
	const [shells, setShells] = useState<ShellInfo[]>([]);
	const [shellsLoading, setShellsLoading] = useState(false);
	const [shellsLoaded, setShellsLoaded] = useState(false);
	const [shellConfigExpanded, setShellConfigExpanded] = useState(false);

	const loadShells = useCallback(async () => {
		if (shellsLoaded) return;
		setShellsLoading(true);
		try {
			const detected = await window.maestro.shells.detect();
			setShells(detected);
			if (detected.length > 0) {
				setShellsLoaded(true);
			}
		} catch (error) {
			logger.error('Failed to load shells:', undefined, error);
			captureException(error instanceof Error ? error : new Error(String(error)), {
				extra: { action: 'maestro.shells.detect' },
			});
		} finally {
			setShellsLoading(false);
		}
	}, [shellsLoaded]);

	const handleShellInteraction = useCallback(() => {
		if (!shellsLoaded && !shellsLoading) {
			void loadShells();
		}
	}, [loadShells, shellsLoaded, shellsLoading]);

	const selectShell = useCallback(
		(shell: ShellInfo) => {
			setDefaultShell(shell.id);
			if (!shell.available) {
				setShellConfigExpanded(true);
			}
		},
		[setDefaultShell]
	);

	return {
		shells,
		shellsLoading,
		shellsLoaded,
		shellConfigExpanded,
		setShellConfigExpanded,
		handleShellInteraction,
		selectShell,
	};
}
