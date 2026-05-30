export function formatCacheAge(cacheAgeMs: number | null): string {
	if (cacheAgeMs === null || cacheAgeMs === 0) return 'just now';
	const seconds = Math.floor(cacheAgeMs / 1000);
	const minutes = Math.floor(seconds / 60);
	const hours = Math.floor(minutes / 60);
	if (hours > 0) return `${hours}h ago`;
	if (minutes > 0) return `${minutes}m ago`;
	return 'just now';
}

export function formatDate(isoString: string): string {
	return new Date(isoString).toLocaleDateString('en-US', {
		month: 'short',
		day: 'numeric',
		year: 'numeric',
	});
}

export const compactNumber = new Intl.NumberFormat('en', {
	notation: 'compact',
	maximumFractionDigits: 1,
});
