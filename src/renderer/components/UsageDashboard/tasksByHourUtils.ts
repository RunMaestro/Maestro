import type { AutoRunTurnsByHour } from '../../../shared/stats-types';

export function getMaxHourlyTaskCount(hourlyData: AutoRunTurnsByHour[]): number {
	return Math.max(...hourlyData.map((hour) => hour.count), 1);
}

/** The busiest hours (most turns first), leaving out hours with none. */
export function getPeakHours(hourlyData: AutoRunTurnsByHour[], limit = 3): number[] {
	return [...hourlyData]
		.filter((hour) => hour.count > 0)
		.sort((a, b) => b.count - a.count || a.hour - b.hour)
		.slice(0, limit)
		.map((hour) => hour.hour);
}
