import { useCallback, useEffect, useRef, useState } from 'react';
import { setRetirementDialogOpen } from '../../services/worktreeRetirementStoreGuard';

/** File-explorer draft ownership precedes React's asynchronous modal rendering. */
export function useRetirementDialogState<T>() {
	const owner = useRef({});
	const mounted = useRef(true);
	const [value, setValue] = useState<T | null>(null);
	useEffect(() => {
		mounted.current = true;
		const identity = owner.current;
		return () => {
			mounted.current = false;
			setRetirementDialogOpen(identity, false);
		};
	}, []);
	const update = useCallback((next: T | null) => {
		// An asynchronous read that outlived its panel must not resurrect a dialog.
		if (!mounted.current) return;
		setRetirementDialogOpen(owner.current, next !== null);
		setValue(next);
	}, []);
	return [value, update] as const;
}
