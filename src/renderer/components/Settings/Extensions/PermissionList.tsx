/**
 * Shared, risk-colored permission disclosure rows.
 *
 * Single source of truth for how a first-party feature's declared
 * capabilities are rendered, so the tile's Permissions sub-tab
 * (ExtensionDetails) and the pre-enable review modal
 * (FirstPartyEnableModal) can never drift on risk colors, capability
 * descriptions, scope/reason layout, or testids. The trailing status text
 * is the only per-caller variation (`statusLabel`).
 */

import type { Theme } from '../../../types';
import {
	capabilityRisk,
	describeCapability,
	type CapabilityRisk,
	type PermissionRequest,
} from '../../../../shared/plugins/permissions';

/** Risk bucket → theme color key. Shared so every permission surface agrees. */
export const RISK_COLOR: Record<CapabilityRisk, 'success' | 'warning' | 'error'> = {
	low: 'success',
	medium: 'warning',
	high: 'error',
};

interface PermissionListProps {
	theme: Theme;
	permissions: readonly PermissionRequest[];
	/** Trailing status text on each row. Defaults to 'Granted on enable'. */
	statusLabel?: string;
}

/**
 * Renders one risk-colored row per requested capability. Static disclosure:
 * first-party grants are minted host-side by the lifecycle bridge on enable,
 * so there is no per-row grant state - only the shared `statusLabel`.
 */
export function PermissionList({
	theme,
	permissions,
	statusLabel = 'Granted on enable',
}: PermissionListProps) {
	return (
		<div className="space-y-1.5">
			{permissions.map((req) => {
				const risk = capabilityRisk(req.capability);
				const color = theme.colors[RISK_COLOR[risk]];
				return (
					<div
						key={req.capability + (req.scope ?? '')}
						data-testid="extension-permission"
						data-cap={req.capability}
						className="flex items-start gap-2 rounded-lg border p-2"
						style={{ borderColor: theme.colors.border }}
					>
						<span
							className="px-1.5 py-0.5 rounded text-[9px] font-bold uppercase flex-shrink-0 mt-0.5"
							style={{ backgroundColor: color + '22', color }}
						>
							{risk}
						</span>
						<div className="min-w-0 flex-1">
							<div className="text-xs" style={{ color: theme.colors.textMain }}>
								{describeCapability(req.capability)}
							</div>
							{req.scope && (
								<div
									className="text-[10px] font-mono mt-0.5"
									style={{ color: theme.colors.textDim }}
								>
									{req.scope}
								</div>
							)}
							{req.reason && (
								<div className="text-[10px] mt-0.5" style={{ color: theme.colors.textDim }}>
									{req.reason}
								</div>
							)}
						</div>
						<span
							data-testid="extension-permission-status"
							className="text-[10px] font-medium flex-shrink-0 mt-0.5"
							style={{ color: theme.colors.textDim }}
						>
							{statusLabel}
						</span>
					</div>
				);
			})}
		</div>
	);
}
