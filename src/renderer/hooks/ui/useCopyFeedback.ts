import { useCallback, useEffect, useRef, useState } from 'react';

export interface UseCopyFeedbackOptions {
	/** Duration in milliseconds for which a successful copy is indicated. */
	duration?: number;
}

export interface UseCopyFeedbackReturn {
	copied: boolean;
	copy: (value: string) => Promise<boolean>;
}

/**
 * Owns transient clipboard-success feedback and its timer lifecycle.
 *
 * The caller retains the clipboard writer, copy value, telemetry, and any
 * product-specific error handling. Only the repeated safe-write -> feedback
 * -> reset contract belongs here.
 */
export function useCopyFeedback(
	write: (value: string) => Promise<boolean>,
	{ duration = 2000 }: UseCopyFeedbackOptions = {}
): UseCopyFeedbackReturn {
	const [copied, setCopied] = useState(false);
	const timeoutRef = useRef<number | NodeJS.Timeout | null>(null);
	const mountedRef = useRef(true);
	const requestIdRef = useRef(0);

	const clearFeedbackTimeout = useCallback(() => {
		if (timeoutRef.current !== null) {
			clearTimeout(timeoutRef.current);
			timeoutRef.current = null;
		}
	}, []);

	useEffect(() => {
		mountedRef.current = true;
		return () => {
			mountedRef.current = false;
			clearFeedbackTimeout();
		};
	}, [clearFeedbackTimeout]);

	const copy = useCallback(
		async (value: string): Promise<boolean> => {
			const requestId = ++requestIdRef.current;
			let succeeded = false;
			try {
				succeeded = await write(value);
			} catch {
				succeeded = false;
			}

			if (!succeeded || !mountedRef.current || requestId !== requestIdRef.current) {
				return succeeded;
			}

			clearFeedbackTimeout();
			setCopied(true);
			timeoutRef.current = setTimeout(() => {
				timeoutRef.current = null;
				if (mountedRef.current && requestId === requestIdRef.current) {
					setCopied(false);
				}
			}, duration);
			return true;
		},
		[clearFeedbackTimeout, duration, write]
	);

	return { copied, copy };
}
