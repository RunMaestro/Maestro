import type { ContextManagementSettings } from '../../../../../types';

export function getYellowThresholdUpdate(
	settings: ContextManagementSettings,
	yellowThreshold: number
): Partial<ContextManagementSettings> {
	if (yellowThreshold >= settings.contextWarningRedThreshold) {
		return {
			contextWarningYellowThreshold: yellowThreshold,
			contextWarningRedThreshold: Math.min(100, yellowThreshold + 10),
		};
	}

	return { contextWarningYellowThreshold: yellowThreshold };
}

export function getRedThresholdUpdate(
	settings: ContextManagementSettings,
	redThreshold: number
): Partial<ContextManagementSettings> {
	if (redThreshold <= settings.contextWarningYellowThreshold) {
		return {
			contextWarningRedThreshold: redThreshold,
			contextWarningYellowThreshold: Math.max(0, redThreshold - 10),
		};
	}

	return { contextWarningRedThreshold: redThreshold };
}
