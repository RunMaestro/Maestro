import { useCallback, useEffect, useRef, useState } from 'react';
import { captureException } from '../../../../../utils/sentry';
import type { WakatimeCliStatus, WakatimeSettingsState } from '../types';

interface UseWakatimeSettingsStateOptions {
	isOpen: boolean;
	wakatimeEnabled: boolean;
	wakatimeApiKey: string;
	setWakatimeApiKey: (value: string) => void;
}

export function useWakatimeSettingsState({
	isOpen,
	wakatimeEnabled,
	wakatimeApiKey,
	setWakatimeApiKey,
}: UseWakatimeSettingsStateOptions): WakatimeSettingsState {
	const [wakatimeCliStatus, setWakatimeCliStatus] = useState<WakatimeCliStatus | null>(null);
	const [wakatimeKeyValid, setWakatimeKeyValid] = useState<boolean | null>(null);
	const [wakatimeKeyValidating, setWakatimeKeyValidating] = useState(false);
	const wakatimeApiKeyRef = useRef(wakatimeApiKey);
	wakatimeApiKeyRef.current = wakatimeApiKey;

	const handleWakatimeApiKeyChange = useCallback(
		(value: string) => {
			setWakatimeApiKey(value);
			setWakatimeKeyValid(null);
			setWakatimeKeyValidating(false);
		},
		[setWakatimeApiKey]
	);

	useEffect(() => {
		if (!isOpen || !wakatimeEnabled) return;
		let cancelled = false;
		let retryTimer: ReturnType<typeof setTimeout> | null = null;

		const handleCliError = (err: unknown) => {
			captureException(err instanceof Error ? err : new Error(String(err)), {
				extra: { context: 'WakaTime CLI check' },
			});
			if (!cancelled) setWakatimeCliStatus({ available: false });
		};

		const retryCheck = () => {
			retryTimer = setTimeout(() => {
				if (!cancelled) {
					window.maestro.wakatime
						.checkCli()
						.then((retryStatus) => {
							if (!cancelled) setWakatimeCliStatus(retryStatus);
						})
						.catch(handleCliError);
				}
			}, 3000);
		};

		window.maestro.wakatime
			.checkCli()
			.then((status) => {
				if (cancelled) return;
				setWakatimeCliStatus(status);
				if (!status.available) retryCheck();
			})
			.catch((err) => {
				if (cancelled) return;
				handleCliError(err);
				retryCheck();
			});

		return () => {
			cancelled = true;
			if (retryTimer) clearTimeout(retryTimer);
			setWakatimeCliStatus(null);
		};
	}, [isOpen, wakatimeEnabled]);

	const validateWakatimeApiKey = useCallback(() => {
		const keyAtBlur = wakatimeApiKey;
		if (!keyAtBlur) return;

		setWakatimeKeyValidating(true);
		setWakatimeKeyValid(null);
		window.maestro.wakatime
			.validateApiKey(keyAtBlur)
			.then((result) => {
				if (wakatimeApiKeyRef.current === keyAtBlur) {
					setWakatimeKeyValid(result.valid);
				}
			})
			.catch((err) => {
				captureException(err instanceof Error ? err : new Error(String(err)), {
					extra: { context: 'WakaTime API key validation' },
				});
				if (wakatimeApiKeyRef.current === keyAtBlur) {
					setWakatimeKeyValid(false);
				}
			})
			.finally(() => {
				if (wakatimeApiKeyRef.current === keyAtBlur) {
					setWakatimeKeyValidating(false);
				}
			});
	}, [wakatimeApiKey]);

	return {
		wakatimeCliStatus,
		wakatimeKeyValid,
		wakatimeKeyValidating,
		handleWakatimeApiKeyChange,
		validateWakatimeApiKey,
	};
}
