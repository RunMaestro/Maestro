import type { AutoRunTask } from '../../../shared/stats-types';

export interface HourlyTaskData {
	hour: number;
	count: number;
	successCount: number;
}

export function formatHourShort(hour: number): string {
	if (hour === 0) return '12a';
	if (hour === 12) return '12p';
	if (hour < 12) return `${hour}a`;
	return `${hour - 12}p`;
}

export function formatHourFull(hour: number): string {
	const suffix = hour >= 12 ? 'PM' : 'AM';
	const displayHour = hour % 12 || 12;
	return `${displayHour}:00 ${suffix}`;
}

export function buildHourlyTaskData(tasks: AutoRunTask[]): HourlyTaskData[] {
	const hours: HourlyTaskData[] = [];
	for (let hour = 0; hour < 24; hour++) {
		hours.push({ hour, count: 0, successCount: 0 });
	}

	for (const task of tasks) {
		const hour = new Date(task.startTime).getHours();
		hours[hour].count += 1;
		if (task.success) {
			hours[hour].successCount += 1;
		}
	}

	return hours;
}

export function getMaxHourlyTaskCount(hourlyData: HourlyTaskData[]): number {
	return Math.max(...hourlyData.map((hour) => hour.count), 1);
}

export function getPeakHours(hourlyData: HourlyTaskData[], limit = 3): number[] {
	return [...hourlyData]
		.sort((a, b) => b.count - a.count)
		.slice(0, limit)
		.map((hour) => hour.hour);
}
