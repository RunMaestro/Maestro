import type { RefObject } from 'react';
import type { Theme } from '../../../../../types';

interface DirectoryContinueButtonProps {
	theme: Theme;
	show: boolean;
	isValid: boolean;
	isValidating: boolean;
	buttonRef: RefObject<HTMLButtonElement>;
	onContinue: () => void;
}

export function DirectoryContinueButton({
	theme,
	show,
	isValid,
	isValidating,
	buttonRef,
	onContinue,
}: DirectoryContinueButtonProps): JSX.Element | null {
	if (!show) return null;

	const enabled = isValid && !isValidating;

	return (
		<div className="flex justify-center">
			<button
				ref={buttonRef}
				onClick={onContinue}
				disabled={!enabled}
				className="px-12 py-3 rounded-lg font-medium transition-all focus:outline-none focus:ring-2 focus:ring-offset-2"
				style={{
					backgroundColor: enabled ? theme.colors.accent : theme.colors.border,
					color: enabled ? theme.colors.accentForeground : theme.colors.textDim,
					cursor: enabled ? 'pointer' : 'not-allowed',
					opacity: enabled ? 1 : 0.6,
					minWidth: '200px',
					['--tw-ring-color' as any]: theme.colors.accent,
					['--tw-ring-offset-color' as any]: theme.colors.bgMain,
				}}
			>
				Continue
			</button>
		</div>
	);
}
