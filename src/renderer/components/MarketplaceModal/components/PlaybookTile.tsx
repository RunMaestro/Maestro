import { useEffect, useRef } from 'react';
import { isBeta, isCompatible } from '../../../../shared/marketplace-compatibility';
import type { PlaybookTileProps } from '../types';
import {
	BADGE_FG,
	BETA_BADGE_BG,
	INCOMPAT_BADGE_BG,
	LOCAL_BADGE_BG,
	LOCAL_BADGE_FG,
} from '../helpers';

export function PlaybookTile({
	playbook,
	theme,
	isSelected,
	runningVersion,
	onSelect,
}: PlaybookTileProps) {
	const tileRef = useRef<HTMLButtonElement>(null);

	useEffect(() => {
		if (isSelected && tileRef.current) {
			tileRef.current.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
		}
	}, [isSelected]);

	const compatible = isCompatible(playbook, runningVersion);
	const beta = isBeta(playbook);
	const bodyOpacity = compatible ? 1 : 0.4;
	const iconFilter = compatible ? undefined : 'grayscale(100%)';

	return (
		<button
			ref={tileRef}
			onClick={onSelect}
			className={`relative p-4 rounded-lg border text-left transition-all ${
				compatible ? 'hover:scale-[1.02]' : ''
			} ${isSelected ? 'ring-2' : ''}`}
			style={{
				backgroundColor: theme.colors.bgActivity,
				borderColor: isSelected ? theme.colors.accent : theme.colors.border,
				outlineColor: 'transparent',
				...(isSelected && {
					boxShadow: `0 0 0 2px ${theme.colors.accent}`,
				}),
			}}
		>
			{(beta || !compatible) && (
				<div className="absolute top-2 right-2 flex items-center gap-1.5 z-10">
					{beta && (
						<span
							className="px-2 py-0.5 rounded text-[11px] font-semibold uppercase tracking-wide"
							style={{
								backgroundColor: BETA_BADGE_BG,
								color: BADGE_FG,
							}}
							title="This playbook is still maturing. Expect rough edges and possible breaking changes between releases."
						>
							BETA
						</span>
					)}
					{!compatible && (
						<span
							className="px-2 py-0.5 rounded text-[11px] font-semibold"
							style={{
								backgroundColor: INCOMPAT_BADGE_BG,
								color: BADGE_FG,
							}}
							title={`This playbook needs Maestro ${playbook.minMaestroVersion} or newer. You're running ${runningVersion}. Update Maestro to install this playbook.`}
						>
							Requires Maestro {playbook.minMaestroVersion}+
						</span>
					)}
				</div>
			)}

			<div style={{ opacity: bodyOpacity, filter: iconFilter }}>
				<div className="flex items-center gap-2 mb-2 flex-wrap">
					<span
						className="px-2 py-0.5 rounded text-xs"
						style={{
							backgroundColor: `${theme.colors.accent}20`,
							color: theme.colors.accent,
						}}
					>
						{playbook.category}
					</span>
					{playbook.subcategory && (
						<span className="text-xs" style={{ color: theme.colors.textDim }}>
							/ {playbook.subcategory}
						</span>
					)}
					{playbook.source === 'local' && (
						<span
							className="px-2 py-0.5 rounded text-xs font-medium"
							style={{
								backgroundColor: LOCAL_BADGE_BG,
								color: LOCAL_BADGE_FG,
							}}
							title="Custom local playbook"
						>
							Local
						</span>
					)}
				</div>

				<h3
					className="font-semibold mb-1 line-clamp-1"
					style={{ color: theme.colors.textMain }}
					title={playbook.title}
				>
					{playbook.title}
				</h3>

				<p className="text-sm line-clamp-2 mb-3" style={{ color: theme.colors.textDim }}>
					{playbook.description}
				</p>

				<div
					className="flex items-center justify-between text-xs"
					style={{ color: theme.colors.textDim }}
				>
					<span>{playbook.author}</span>
					<span>{playbook.documents.length} docs</span>
				</div>
			</div>
		</button>
	);
}
