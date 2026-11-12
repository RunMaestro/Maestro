import { useState } from 'react';
import type { SymphonyRegistryState } from '../types';
import { validateRegistryUrl } from '../utils';

interface UseSymphonyRegistryStateOptions {
	symphonyRegistryUrls: string[];
	setSymphonyRegistryUrls: (urls: string[]) => void;
}

export function useSymphonyRegistryState({
	symphonyRegistryUrls,
	setSymphonyRegistryUrls,
}: UseSymphonyRegistryStateOptions): SymphonyRegistryState {
	const [newRegistryUrl, setNewRegistryUrlState] = useState('');
	const [registryUrlError, setRegistryUrlError] = useState<string | null>(null);

	const setNewRegistryUrl = (value: string) => {
		setNewRegistryUrlState(value);
		setRegistryUrlError(null);
	};

	const addRegistryUrl = () => {
		const result = validateRegistryUrl(newRegistryUrl, symphonyRegistryUrls);
		if (result.error) {
			setRegistryUrlError(result.error);
			return;
		}
		if (!result.canonical) return;
		setSymphonyRegistryUrls([...symphonyRegistryUrls, result.canonical]);
		setNewRegistryUrlState('');
		setRegistryUrlError(null);
	};

	const removeRegistryUrl = (url: string) => {
		setSymphonyRegistryUrls(symphonyRegistryUrls.filter((existingUrl) => existingUrl !== url));
	};

	return {
		newRegistryUrl,
		registryUrlError,
		setNewRegistryUrl,
		addRegistryUrl,
		removeRegistryUrl,
	};
}
