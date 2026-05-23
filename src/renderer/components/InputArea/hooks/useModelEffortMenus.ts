import { useRef, useState } from 'react';
import { useEventListener } from '../../../hooks/utils/useEventListener';

export function useModelEffortMenus() {
	const [modelMenuOpen, setModelMenuOpen] = useState(false);
	const [effortMenuOpen, setEffortMenuOpen] = useState(false);
	const modelMenuRef = useRef<HTMLDivElement>(null);
	const effortMenuRef = useRef<HTMLDivElement>(null);

	useEventListener(
		'mousedown',
		(event) => {
			const target = event.target as Node;
			if (modelMenuOpen && modelMenuRef.current && !modelMenuRef.current.contains(target)) {
				setModelMenuOpen(false);
			}
			if (effortMenuOpen && effortMenuRef.current && !effortMenuRef.current.contains(target)) {
				setEffortMenuOpen(false);
			}
		},
		{
			target: typeof document !== 'undefined' ? document : null,
			enabled: modelMenuOpen || effortMenuOpen,
		}
	);

	return {
		modelMenuOpen,
		setModelMenuOpen,
		modelMenuRef,
		effortMenuOpen,
		setEffortMenuOpen,
		effortMenuRef,
	};
}
