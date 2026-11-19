import { useMemo } from 'react';
import { ExternalLink } from 'lucide-react';
import type { MarketplacePlaybook } from '../../../../shared/marketplace-types';
import { resolvePlaybookParamSpecs } from '../../../../shared/playbookParams';
import type { Theme } from '../../../types';
import { openUrl } from '../../../utils/openUrl';
import { MiniBadge } from '../../ui/MiniBadge';
import { LOCAL_BADGE_BG, LOCAL_BADGE_FG } from '../helpers';

export interface PlaybookMetadataSidebarProps {
	theme: Theme;
	playbook: MarketplacePlaybook;
	selectedDocFilename: string | null;
	onSelectDocument: (filename: string) => void;
}

export function PlaybookMetadataSidebar({
	theme,
	playbook,
	selectedDocFilename,
	onSelectDocument,
}: PlaybookMetadataSidebarProps) {
	// The same specs both Auto Run engines resolve against: prose form plus manifest overlay.
	const paramSpecs = useMemo(
		() => resolvePlaybookParamSpecs(playbook.prompt ?? '', playbook.parameters),
		[playbook.prompt, playbook.parameters]
	);
	const assets = playbook.assets ?? [];

	return (
		<div
			className="w-64 shrink-0 p-4 border-r overflow-y-auto"
			style={{ borderColor: theme.colors.border }}
		>
			<div className="mb-4">
				<h4
					className="text-xs font-semibold mb-1 uppercase tracking-wide"
					style={{ color: theme.colors.textDim }}
				>
					Description
				</h4>
				<p className="text-sm" style={{ color: theme.colors.textMain }}>
					{playbook.description}
					{selectedDocFilename ? (
						<>
							{' '}
							<button
								onClick={() => onSelectDocument('')}
								className="hover:opacity-80 transition-colors px-1 rounded"
								style={{ color: theme.colors.accent }}
							>
								Read more...
							</button>
						</>
					) : null}
				</p>
			</div>

			<div className="mb-4">
				<h4
					className="text-xs font-semibold mb-1 uppercase tracking-wide"
					style={{ color: theme.colors.textDim }}
				>
					Author
				</h4>
				{playbook.authorLink ? (
					<button
						onClick={() => openUrl(playbook.authorLink!)}
						tabIndex={0}
						className="text-sm hover:underline inline-flex items-center gap-1 outline-none"
						style={{ color: theme.colors.accent }}
					>
						{playbook.author}
						<ExternalLink className="w-3 h-3" />
					</button>
				) : (
					<p className="text-sm" style={{ color: theme.colors.textMain }}>
						{playbook.author}
					</p>
				)}
			</div>

			{playbook.tags && playbook.tags.length > 0 && (
				<div className="mb-4">
					<h4
						className="text-xs font-semibold mb-1 uppercase tracking-wide"
						style={{ color: theme.colors.textDim }}
					>
						Tags
					</h4>
					<div className="flex flex-wrap gap-1.5">
						{playbook.tags.map((tag) => (
							<span
								key={tag}
								className="px-2 py-0.5 rounded-full text-xs font-medium"
								style={{
									backgroundColor: `${theme.colors.accent}20`,
									color: theme.colors.accent,
									border: `1px solid ${theme.colors.accent}40`,
								}}
							>
								{tag}
							</span>
						))}
					</div>
				</div>
			)}

			<div className="mb-4">
				<h4
					className="text-xs font-semibold mb-1 uppercase tracking-wide"
					style={{ color: theme.colors.textDim }}
				>
					Documents ({playbook.documents.length})
				</h4>
				<ul className="space-y-0.5">
					{playbook.documents.map((doc, index) => {
						const isActive = selectedDocFilename === doc.filename;
						return (
							<li key={doc.filename}>
								<button
									onClick={() => onSelectDocument(doc.filename)}
									className="text-sm text-left transition-colors hover:opacity-80 w-full px-2 py-1 rounded"
									style={{
										color: theme.colors.accent,
										fontWeight: isActive ? 600 : 400,
										backgroundColor: isActive ? `${theme.colors.accent}20` : 'transparent',
									}}
								>
									{index + 1}. {doc.filename}.md
								</button>
							</li>
						);
					})}
				</ul>
			</div>

			<div className="mb-4">
				<h4
					className="text-xs font-semibold mb-1 uppercase tracking-wide"
					style={{ color: theme.colors.textDim }}
				>
					Assets{assets.length > 0 ? ` (${assets.length})` : ''}
				</h4>
				{assets.length > 0 ? (
					<ul className="space-y-0.5 select-text">
						{assets.map((asset) => (
							<li
								key={asset}
								className="text-sm font-mono px-2 truncate"
								style={{ color: theme.colors.textMain }}
								title={`assets/${asset}`}
							>
								{asset}
							</li>
						))}
					</ul>
				) : (
					<p className="text-sm" style={{ color: theme.colors.textDim }}>
						Not listed in the manifest. Any files in the playbook's assets folder are discovered at
						install.
					</p>
				)}
			</div>

			<div className="mb-4" data-testid="playbook-configuration">
				<h4
					className="text-xs font-semibold mb-1 uppercase tracking-wide"
					style={{ color: theme.colors.textDim }}
				>
					Configuration{paramSpecs.length > 0 ? ` (${paramSpecs.length})` : ''}
				</h4>
				{paramSpecs.length > 0 ? (
					<ul className="space-y-2 select-text">
						{paramSpecs.map((spec) => (
							<li key={spec.name} title={spec.help} data-testid={`playbook-param-${spec.name}`}>
								<div className="flex items-center gap-1.5 min-w-0">
									<span
										className="text-sm font-mono truncate"
										style={{ color: theme.colors.textMain }}
									>
										{spec.name}
									</span>
									{spec.required && (
										<span
											className="text-sm font-semibold"
											style={{ color: theme.colors.error }}
											title="Required: the run cannot start without a value"
											aria-label="Required"
										>
											*
										</span>
									)}
									<MiniBadge label={spec.type} theme={theme} title={`Type: ${spec.type}`} />
								</div>
								<div className="text-xs truncate" style={{ color: theme.colors.textDim }}>
									{spec.default !== undefined ? (
										<>
											Default: <span className="font-mono">{spec.default}</span>
										</>
									) : (
										'No default'
									)}
								</div>
							</li>
						))}
					</ul>
				) : (
					<p className="text-sm" style={{ color: theme.colors.textDim }}>
						No parameters to configure.
					</p>
				)}
			</div>

			<div className="mb-4">
				<h4
					className="text-xs font-semibold mb-1 uppercase tracking-wide"
					style={{ color: theme.colors.textDim }}
				>
					Settings
				</h4>
				<p className="text-sm" style={{ color: theme.colors.textMain }}>
					Loop:{' '}
					{playbook.loopEnabled
						? playbook.maxLoops
							? `Yes (max ${playbook.maxLoops})`
							: 'Yes (unlimited)'
						: 'No'}
				</p>
				<p className="text-sm" style={{ color: theme.colors.textMain }}>
					Fresh context per: {playbook.taskSelectionMode === 'document' ? 'Document' : 'Task'}
				</p>
			</div>

			<div className="mb-6">
				<h4
					className="text-xs font-semibold mb-1 uppercase tracking-wide"
					style={{ color: theme.colors.textDim }}
				>
					Last Updated
				</h4>
				<p className="text-sm" style={{ color: theme.colors.textMain }}>
					{playbook.lastUpdated}
				</p>
			</div>

			{playbook.source === 'local' && (
				<div className="mb-4">
					<h4
						className="text-xs font-semibold mb-1 uppercase tracking-wide"
						style={{ color: theme.colors.textDim }}
					>
						Source
					</h4>
					<span
						className="px-2 py-0.5 rounded text-xs font-medium inline-block"
						style={{
							backgroundColor: LOCAL_BADGE_BG,
							color: LOCAL_BADGE_FG,
						}}
						title="Custom local playbook"
					>
						Local
					</span>
				</div>
			)}
		</div>
	);
}
