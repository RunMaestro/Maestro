import { X } from 'lucide-react';
import type { Theme } from '../../../../../types';

export function LaunchErrorBanner({
	error,
	theme,
	onDismiss,
}: {
	error: string | null;
	theme: Theme;
	onDismiss: () => void;
}): JSX.Element | null {
	if (!error) return null;

	return (
		<div
			className="mx-6 mb-2 px-4 py-2 rounded-lg flex items-center gap-2"
			style={{
				backgroundColor: `${theme.colors.error}20`,
				borderColor: theme.colors.error,
				border: '1px solid',
			}}
		>
			<svg className="w-4 h-4 shrink-0" fill="none" stroke={theme.colors.error} viewBox="0 0 24 24">
				<path
					strokeLinecap="round"
					strokeLinejoin="round"
					strokeWidth={2}
					d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
				/>
			</svg>
			<span className="text-sm" style={{ color: theme.colors.error }}>
				{error}
			</span>
			<button
				onClick={onDismiss}
				aria-label="Dismiss launch error"
				className="ml-auto p-1 hover:opacity-80 focus:outline-none focus:ring-2 focus:ring-offset-1 rounded"
				style={{
					color: theme.colors.error,
					['--tw-ring-color' as any]: theme.colors.error,
					['--tw-ring-offset-color' as any]: theme.colors.bgMain,
				}}
			>
				<X className="w-4 h-4" />
			</button>
		</div>
	);
}
