import type { Theme } from '../../../types';

interface TaskCountBadgeProps {
	theme: Theme;
	count: number;
	loading: boolean;
	zeroTone: 'dim' | 'error';
	className?: string;
}

export function TaskCountBadge({
	theme,
	count,
	loading,
	zeroTone,
	className = '',
}: TaskCountBadgeProps) {
	const isZero = count === 0;
	const zeroColor = zeroTone === 'error' ? theme.colors.error : theme.colors.textDim;

	return (
		<span
			className={`text-xs px-2 py-0.5 rounded shrink-0 ${className}`.trim()}
			style={{
				backgroundColor: isZero ? zeroColor + '20' : theme.colors.success + '20',
				color: isZero ? zeroColor : theme.colors.success,
			}}
		>
			{loading ? '...' : `${count} ${count === 1 ? 'task' : 'tasks'}`}
		</span>
	);
}
