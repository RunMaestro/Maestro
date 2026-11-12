import { useCallback, useState } from 'react';
import type { ForcedParallelWarningState } from '../types';

interface UseForcedParallelWarningStateArgs {
	forcedParallelExecution: boolean;
	forcedParallelAcknowledged: boolean;
	setForcedParallelExecution: (enabled: boolean) => void;
	setForcedParallelAcknowledged: (acknowledged: boolean) => void;
}

export function useForcedParallelWarningState({
	forcedParallelExecution,
	forcedParallelAcknowledged,
	setForcedParallelExecution,
	setForcedParallelAcknowledged,
}: UseForcedParallelWarningStateArgs): ForcedParallelWarningState {
	const [showWarning, setShowWarning] = useState(false);

	const handleToggle = useCallback(() => {
		if (!forcedParallelExecution && !forcedParallelAcknowledged) {
			setShowWarning(true);
		} else {
			setForcedParallelExecution(!forcedParallelExecution);
		}
	}, [forcedParallelExecution, forcedParallelAcknowledged, setForcedParallelExecution]);

	const handleConfirm = useCallback(() => {
		setForcedParallelAcknowledged(true);
		setForcedParallelExecution(true);
		setShowWarning(false);
	}, [setForcedParallelAcknowledged, setForcedParallelExecution]);

	const handleCancel = useCallback(() => {
		setShowWarning(false);
	}, []);

	return {
		showWarning,
		handleToggle,
		handleConfirm,
		handleCancel,
	};
}
