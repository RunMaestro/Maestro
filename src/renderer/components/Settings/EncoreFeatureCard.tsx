/**
 * EncoreFeatureCard - Shared toggle card for Encore Features.
 *
 * Renders a bordered card with icon, name, description, permission badges,
 * and a toggle switch. When enabled, renders children (settings content).
 * Children unmount when disabled, ensuring cleanup of effects.
 */

import type { ReactNode } from 'react';
import type { Theme } from '../../types';
import type { EncorePermission } from '../../../shared/encore-types';

/** Returns a color for a permission badge based on its risk level */
function getPermissionColor(
	permission: EncorePermission,
	theme: Theme
): { bg: string; text: string } {
	if (permission === 'middleware') {
		return { bg: `${theme.colors.error}20`, text: theme.colors.error };
	}
	if (permission.endsWith(':write') || permission === 'process:write' || permission === 'settings:write') {
		return { bg: `${theme.colors.warning}20`, text: theme.colors.warning };
	}
	return { bg: `${theme.colors.success}20`, text: theme.colors.success };
}

interface EncoreFeatureCardProps {
	theme: Theme;
	icon: ReactNode;
	name: string;
	description: string;
	enabled: boolean;
	onToggle: () => void;
	/** Permission badges to display (e.g., from encore manifests) */
	permissions?: EncorePermission[];
	/** Version string to display next to the name */
	version?: string;
	/** Author line to display below the name */
	author?: string;
	/** Content shown when enabled */
	children?: ReactNode;
}

export function EncoreFeatureCard({
	theme,
	icon,
	name,
	description,
	enabled,
	onToggle,
	permissions,
	version,
	author,
	children,
}: EncoreFeatureCardProps) {
	return (
		<div
			className="rounded-lg border"
			style={{
				borderColor: enabled ? theme.colors.accent : theme.colors.border,
				backgroundColor: enabled ? `${theme.colors.accent}08` : 'transparent',
			}}
		>
			{/* Feature Toggle Header */}
			<button
				className="w-full flex items-center justify-between p-4 text-left"
				onClick={onToggle}
			>
				<div className="flex items-center gap-3">
					<div
						className="w-5 h-5 shrink-0"
						style={{
							color: enabled ? theme.colors.accent : theme.colors.textDim,
						}}
					>
						{icon}
					</div>
					<div>
						<div className="flex items-center gap-2">
							<div className="text-sm font-bold" style={{ color: theme.colors.textMain }}>
								{name}
							</div>
							{version && (
								<span className="text-xs font-mono" style={{ color: theme.colors.textDim }}>
									v{version}
								</span>
							)}
						</div>
						{author && (
							<div className="text-[10px] mt-0.5" style={{ color: theme.colors.textDim }}>
								by {author}
							</div>
						)}
						<div className="text-xs mt-0.5" style={{ color: theme.colors.textDim }}>
							{description}
						</div>
						{/* Permission badges */}
						{permissions && permissions.length > 0 && (
							<div className="flex flex-wrap gap-1 mt-1.5">
								{permissions.map((perm) => {
									const colors = getPermissionColor(perm, theme);
									return (
										<span
											key={perm}
											className="text-[10px] px-1.5 py-0.5 rounded font-mono"
											style={{ backgroundColor: colors.bg, color: colors.text }}
										>
											{perm}
										</span>
									);
								})}
							</div>
						)}
					</div>
				</div>
				<div
					className={`relative w-10 h-5 rounded-full transition-colors shrink-0 ${enabled ? '' : 'opacity-50'}`}
					style={{
						backgroundColor: enabled ? theme.colors.accent : theme.colors.border,
					}}
				>
					<div
						className="absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform"
						style={{
							transform: enabled ? 'translateX(22px)' : 'translateX(2px)',
						}}
					/>
				</div>
			</button>

			{/* Expanded content (unmounts when disabled) */}
			{enabled && children}
		</div>
	);
}
