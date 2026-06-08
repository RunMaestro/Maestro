export { formatCacheAge } from '../../../../shared/formatters';

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
