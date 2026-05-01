import { memo } from 'react';
import type { Theme } from '../../types';
import { DeliveryPlannerDashboard } from './Dashboard';

interface DeliveryPlannerRightPanelProps {
	theme: Theme;
}

export const DeliveryPlannerRightPanel = memo(function DeliveryPlannerRightPanel({
	theme,
}: DeliveryPlannerRightPanelProps) {
	return <DeliveryPlannerDashboard theme={theme} compact />;
});
