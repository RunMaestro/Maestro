import { Check, Settings, X } from 'lucide-react';
import { isBetaAgent } from '../../../../../../shared/agentMetadata';
import type { Theme } from '../../../../../types';
import type { AgentTile } from '../types';
import { AgentLogo } from './AgentLogo';

interface AgentTileButtonProps {
	tile: AgentTile;
	index: number;
	theme: Theme;
	isDetected: boolean;
	isSelected: boolean;
	isFocused: boolean;
	colSpanClass: string;
	onTileClick: (tile: AgentTile, index: number) => void;
	onOpenConfig: (agentId: string) => void;
	onFocusTile: (index: number) => void;
	setTileRef: (index: number, element: HTMLButtonElement | null) => void;
}

export function AgentTileButton({
	tile,
	index,
	theme,
	isDetected,
	isSelected,
	isFocused,
	colSpanClass,
	onTileClick,
	onOpenConfig,
	onFocusTile,
	setTileRef,
}: AgentTileButtonProps): JSX.Element {
	const canSelect = tile.supported && isDetected;

	return (
		<button
			key={tile.id}
			ref={(element) => setTileRef(index, element)}
			onClick={() => onTileClick(tile, index)}
			onFocus={() => onFocusTile(index)}
			disabled={!canSelect}
			className={`
				relative flex flex-col items-center justify-center pt-6 px-6 pb-10 rounded-xl
				border-2 transition-all duration-200 outline-none min-w-[160px]
				${colSpanClass}
				${canSelect ? 'cursor-pointer' : 'cursor-not-allowed'}
			`}
			style={{
				backgroundColor: isSelected
					? `${tile.brandColor || theme.colors.accent}15`
					: theme.colors.bgSidebar,
				borderColor: isSelected
					? tile.brandColor || theme.colors.accent
					: isFocused && canSelect
						? theme.colors.accent
						: theme.colors.border,
				opacity: tile.supported ? 1 : 0.5,
				boxShadow: isSelected
					? `0 0 0 3px ${tile.brandColor || theme.colors.accent}30`
					: isFocused && canSelect
						? `0 0 0 2px ${theme.colors.accent}40`
						: 'none',
			}}
			aria-label={`${tile.name}${canSelect ? '' : tile.supported ? ' (not installed)' : ' (coming soon)'}`}
			aria-pressed={isSelected}
		>
			{isSelected && (
				<div
					className="absolute top-2 right-2 w-5 h-5 rounded-full flex items-center justify-center"
					style={{ backgroundColor: tile.brandColor || theme.colors.accent }}
				>
					<Check className="w-3 h-3" style={{ color: '#fff' }} />
				</div>
			)}

			{tile.supported && !isSelected && (
				<div
					className="absolute top-2 right-2 w-5 h-5 rounded-full flex items-center justify-center"
					style={{ backgroundColor: isDetected ? '#22c55e20' : '#ef444420' }}
					title={isDetected ? 'Installed' : 'Not found'}
				>
					{isDetected ? (
						<Check className="w-3 h-3" style={{ color: '#22c55e' }} />
					) : (
						<X className="w-3 h-3" style={{ color: '#ef4444' }} />
					)}
				</div>
			)}

			<div className="mb-3">
				<AgentLogo
					agentId={tile.id}
					supported={tile.supported}
					detected={isDetected}
					brandColor={tile.brandColor}
					theme={theme}
				/>
			</div>

			<h4
				className="text-base font-medium mb-0.5"
				style={{ color: tile.supported ? theme.colors.textMain : theme.colors.textDim }}
			>
				{tile.name}
			</h4>

			<p className="text-xs text-center" style={{ color: theme.colors.textDim }}>
				{tile.supported ? (isDetected ? tile.description : 'Not installed') : 'Coming soon'}
			</p>

			{!tile.supported && (
				<span
					className="absolute top-2 left-2 px-1.5 py-0.5 text-[10px] rounded-full font-medium"
					style={{
						backgroundColor: theme.colors.border,
						color: theme.colors.textDim,
					}}
				>
					Soon
				</span>
			)}

			{tile.supported && isBetaAgent(tile.id) && (
				<span
					className="absolute top-2 left-2 px-1.5 py-0.5 text-[9px] rounded font-bold uppercase"
					style={{
						backgroundColor: theme.colors.warning + '30',
						color: theme.colors.warning,
					}}
				>
					Beta
				</span>
			)}

			{tile.supported && (
				<div
					role="button"
					onClick={(event) => {
						event.stopPropagation();
						onOpenConfig(tile.id);
					}}
					onKeyDown={(event) => {
						if (event.key === 'Enter' || event.key === ' ') {
							event.preventDefault();
							event.stopPropagation();
							onOpenConfig(tile.id);
						}
					}}
					className="absolute bottom-2 left-1/2 -translate-x-1/2 flex items-center gap-1 px-2 py-1 mt-2 rounded text-[10px] hover:bg-white/10 transition-colors cursor-pointer"
					style={{ color: theme.colors.textDim }}
					title="Customize agent settings"
					tabIndex={0}
					aria-label="Customize agent settings"
				>
					<Settings className="w-3 h-3" />
					Customize
				</div>
			)}
		</button>
	);
}
