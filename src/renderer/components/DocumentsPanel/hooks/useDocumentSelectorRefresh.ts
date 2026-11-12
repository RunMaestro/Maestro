import { useCallback, useEffect, useRef, useState } from 'react';

interface UseDocumentSelectorRefreshArgs {
	allDocumentsLength: number;
	onRefresh: () => Promise<void>;
}

export function useDocumentSelectorRefresh({
	allDocumentsLength,
	onRefresh,
}: UseDocumentSelectorRefreshArgs) {
	const [refreshing, setRefreshing] = useState(false);
	const [refreshMessage, setRefreshMessage] = useState<string | null>(null);
	const prevDocCountRef = useRef(allDocumentsLength);

	const handleRefresh = useCallback(async () => {
		setRefreshing(true);
		setRefreshMessage(null);

		try {
			await onRefresh();
		} catch {
			// The caller owns user-facing error handling; this hook must always release the spinner.
		} finally {
			setTimeout(() => {
				setRefreshing(false);
			}, 500);
		}
	}, [onRefresh]);

	useEffect(() => {
		if (refreshing === false && prevDocCountRef.current !== allDocumentsLength) {
			const diff = allDocumentsLength - prevDocCountRef.current;
			let message: string;
			if (diff > 0) {
				message = `Found ${diff} new document${diff === 1 ? '' : 's'}`;
			} else if (diff < 0) {
				message = `${Math.abs(diff)} document${Math.abs(diff) === 1 ? '' : 's'} removed`;
			} else {
				message = 'No changes';
			}
			setRefreshMessage(message);
			prevDocCountRef.current = allDocumentsLength;

			const timer = setTimeout(() => setRefreshMessage(null), 3000);
			return () => clearTimeout(timer);
		}
	}, [allDocumentsLength, refreshing]);

	return {
		refreshing,
		refreshMessage,
		handleRefresh,
	};
}
