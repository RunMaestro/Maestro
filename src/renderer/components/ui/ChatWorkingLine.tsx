import { useEffect, useState } from 'react';
import { formatDurationHuman } from '../../../shared/duration';
import type { Theme } from '../../types';
import { Spinner } from './Spinner';

/** Shared elapsed indicator for Quick Chat and embedded document chat. */
export function ChatWorkingLine({
	since,
	theme,
	testId = 'quick-chat-working',
}: {
	since: number | null;
	theme: Theme;
	testId?: string;
}) {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (since === null) return;
		setNow(Date.now());
		const id = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(id);
	}, [since]);
	const elapsed = since === null ? 0 : Math.max(0, Math.floor((now - since) / 1000));
	return (
		<div
			className="flex items-center gap-2"
			style={{ color: theme.colors.textDim }}
			data-testid={testId}
		>
			<Spinner size={12} decorative />
			{since === null ? 'Working…' : `Working for ${formatDurationHuman(elapsed * 1000)}`}
		</div>
	);
}
