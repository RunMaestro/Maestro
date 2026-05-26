import React, { useEffect, useState } from 'react';
import { Clock, RotateCw } from 'lucide-react';
import type { Theme } from '../../../types';

interface RetryCountdownProps {
	retryAt: number;
	theme: Theme;
	onRetryNow: () => void;
}

export function RetryCountdown({ retryAt, theme, onRetryNow }: RetryCountdownProps) {
	const [secondsLeft, setSecondsLeft] = useState(() =>
		Math.max(0, Math.ceil((retryAt - Date.now()) / 1000))
	);

	useEffect(() => {
		const interval = setInterval(() => {
			const remaining = Math.max(0, Math.ceil((retryAt - Date.now()) / 1000));
			setSecondsLeft(remaining);
		}, 1000);

		return () => clearInterval(interval);
	}, [retryAt]);

	return (
		<div className="flex flex-col items-center gap-2 mt-3">
			<div className="flex items-center gap-1.5 text-xs" style={{ color: theme.colors.textDim }}>
				<Clock className="w-3.5 h-3.5" />
				<span>Retrying in {secondsLeft}s...</span>
			</div>
			<button
				onClick={onRetryNow}
				className="flex items-center gap-1.5 px-2.5 py-1.5 rounded text-xs hover:bg-white/10 transition-colors"
				style={{ color: theme.colors.accent }}
			>
				<RotateCw className="w-3.5 h-3.5" />
				Retry Now
			</button>
		</div>
	);
}
