import type { ReactNode } from 'react';
import type { UsageDashboardViewMode as ViewMode } from '../../../../types';

interface DashboardTabPanelProps {
	viewMode: ViewMode;
	children: ReactNode;
}

export function DashboardTabPanel({ viewMode, children }: DashboardTabPanelProps) {
	return (
		<div
			key={viewMode}
			className="space-y-6 dashboard-content-enter"
			data-testid="usage-dashboard-content"
			role="tabpanel"
			id={`tabpanel-${viewMode}`}
			aria-labelledby={`tab-${viewMode}`}
			tabIndex={0}
		>
			{children}
		</div>
	);
}
