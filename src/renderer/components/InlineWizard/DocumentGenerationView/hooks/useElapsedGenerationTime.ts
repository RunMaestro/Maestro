import { useEffect, useRef, useState } from 'react';

export function useElapsedGenerationTime(isGenerating: boolean, startedAt?: number): number {
	const fallbackStartRef = useRef<number>(Date.now());
	const startTime = startedAt ?? fallbackStartRef.current;
	const [elapsedMs, setElapsedMs] = useState(() => Math.max(0, Date.now() - startTime));

	useEffect(() => {
		const updateElapsedMs = () => {
			setElapsedMs(Math.max(0, Date.now() - startTime));
		};

		if (!isGenerating) {
			updateElapsedMs();
			return;
		}

		updateElapsedMs();

		const interval = setInterval(() => {
			updateElapsedMs();
		}, 1000);

		return () => clearInterval(interval);
	}, [isGenerating, startTime]);

	return elapsedMs;
}
