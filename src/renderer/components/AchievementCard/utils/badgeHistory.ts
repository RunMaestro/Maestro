import type { AutoRunStats } from '../../../types';
import { CONDUCTOR_BADGES } from '../../../constants/conductorBadges';
import type { BadgeHistoryRow } from '../types';

export function formatBadgeHistoryDate(unlockedAt: number): string {
	return new Date(unlockedAt).toLocaleDateString(undefined, {
		month: 'short',
		day: 'numeric',
		year: 'numeric',
	});
}

export function getBadgeHistoryRows(badgeHistory: AutoRunStats['badgeHistory']): BadgeHistoryRow[] {
	return [...(badgeHistory ?? [])]
		.sort((a, b) => a.level - b.level)
		.flatMap((record) => {
			const badge = CONDUCTOR_BADGES.find((candidate) => candidate.level === record.level);
			if (!badge) return [];

			return [
				{
					level: record.level,
					unlockedAt: record.unlockedAt,
					badge,
					dateLabel: formatBadgeHistoryDate(record.unlockedAt),
				},
			];
		});
}

export function shouldShowBadgeHistory(badgeHistory: AutoRunStats['badgeHistory']): boolean {
	return (badgeHistory?.length ?? 0) > 1;
}
