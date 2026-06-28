import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import type { Theme } from '../../../../../types';

interface EncoreFeatureCardProps {
	theme: Theme;
	enabled: boolean;
	onToggle: () => void;
	icon: LucideIcon;
	title: ReactNode;
	description: ReactNode;
	children?: ReactNode;
	toggleClassName?: string;
	contentClassName?: string;
}

export function EncoreFeatureCard({
	theme,
	enabled,
	onToggle,
	icon: Icon,
	title,
	description,
	children,
	toggleClassName = '',
	contentClassName = 'space-y-3',
}: EncoreFeatureCardProps) {
	return (
		<div
			className="rounded-lg border"
			style={{
				borderColor: enabled ? theme.colors.accent : theme.colors.border,
				backgroundColor: enabled ? `${theme.colors.accent}08` : 'transparent',
			}}
		>
			<button
				className="w-full flex items-center justify-between p-4 text-left"
				onClick={onToggle}
				aria-pressed={enabled}
			>
				<div className="flex items-center gap-3">
					<Icon
						className="w-5 h-5"
						style={{ color: enabled ? theme.colors.accent : theme.colors.textDim }}
					/>
					<div>
						<div className="text-sm font-bold" style={{ color: theme.colors.textMain }}>
							{title}
						</div>
						<div className="text-xs mt-0.5" style={{ color: theme.colors.textDim }}>
							{description}
						</div>
					</div>
				</div>
				<div
					aria-hidden="true"
					className={`relative w-10 h-5 rounded-full transition-colors ${
						enabled ? '' : 'opacity-50'
					} ${toggleClassName}`}
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
			{enabled && children && (
				<div
					className={`px-4 pb-4 border-t ${contentClassName}`}
					style={{ borderColor: theme.colors.border }}
				>
					{children}
				</div>
			)}
		</div>
	);
}
