import { ArrowLeft } from 'lucide-react';
import { isBeta, isCompatible } from '../../../../shared/marketplace-compatibility';
import { GhostIconButton } from '../../ui/GhostIconButton';
import { openUrl } from '../../../utils/openUrl';
import type { PlaybookDetailViewProps } from '../types';
import {
	BADGE_FG,
	BETA_BADGE_BG,
	INCOMPAT_BADGE_BG,
	LOCAL_BADGE_BG,
	LOCAL_BADGE_FG,
} from '../helpers';
import { DocumentSelector } from './DocumentSelector';
import { MarkdownPreviewPane } from './MarkdownPreviewPane';
import { PlaybookImportFooter } from './PlaybookImportFooter';
import { PlaybookMetadataSidebar } from './PlaybookMetadataSidebar';

export function PlaybookDetailView({
	theme,
	playbook,
	readmeContent,
	selectedDocFilename,
	documentContent,
	isLoadingDocument,
	targetFolderName,
	isImporting,
	isRemoteSession,
	runningVersion,
	onBack,
	onSelectDocument,
	onTargetFolderChange,
	onBrowseFolder,
	onImport,
}: PlaybookDetailViewProps) {
	const compatible = isCompatible(playbook, runningVersion);
	const beta = isBeta(playbook);

	return (
		<div className="flex flex-col h-full overflow-hidden">
			<div
				className="flex items-center gap-4 px-4 py-3 border-b shrink-0"
				style={{ borderColor: theme.colors.border }}
			>
				<GhostIconButton onClick={onBack} padding="p-1.5" title="Back to list (Esc)">
					<ArrowLeft className="w-5 h-5" style={{ color: theme.colors.textDim }} />
				</GhostIconButton>

				<div className="flex-1 min-w-0">
					<div className="flex items-center gap-2 mb-0.5">
						<span
							className="px-2 py-0.5 rounded text-xs"
							style={{ backgroundColor: `${theme.colors.accent}20`, color: theme.colors.accent }}
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
						{beta && (
							<span
								className="px-2 py-0.5 rounded text-xs font-semibold uppercase tracking-wide"
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
								className="px-2 py-0.5 rounded text-xs font-semibold"
								style={{
									backgroundColor: INCOMPAT_BADGE_BG,
									color: BADGE_FG,
								}}
								title={`This playbook needs Maestro ${playbook.minMaestroVersion} or newer. You're running ${runningVersion}.`}
							>
								Requires Maestro {playbook.minMaestroVersion}+
							</span>
						)}
					</div>
					<h2 className="text-lg font-semibold truncate" style={{ color: theme.colors.textMain }}>
						{playbook.title}
					</h2>
				</div>
			</div>

			{!compatible && (
				<div
					className="px-4 py-3 border-b shrink-0 flex items-center gap-3"
					style={{
						backgroundColor: `${INCOMPAT_BADGE_BG}15`,
						borderColor: theme.colors.border,
					}}
				>
					<span aria-hidden="true" style={{ color: INCOMPAT_BADGE_BG, fontSize: '1.1rem' }}>
						⚠
					</span>
					<div className="flex-1 text-sm" style={{ color: theme.colors.textMain }}>
						This playbook requires Maestro <strong>{playbook.minMaestroVersion}</strong> or newer.
						You're running <strong>{runningVersion}</strong>.
					</div>
					<button
						onClick={() => openUrl('https://github.com/RunMaestro/Maestro/releases')}
						className="px-3 py-1.5 rounded text-xs font-semibold transition-opacity hover:opacity-90"
						style={{ backgroundColor: INCOMPAT_BADGE_BG, color: BADGE_FG }}
					>
						Update Maestro
					</button>
				</div>
			)}

			{beta && (
				<div
					className="px-4 py-2 border-b shrink-0 flex items-center gap-2 text-xs"
					style={{
						backgroundColor: `${BETA_BADGE_BG}15`,
						borderColor: theme.colors.border,
						color: theme.colors.textMain,
					}}
				>
					<span aria-hidden="true" style={{ color: BETA_BADGE_BG }}>
						ℹ
					</span>
					<span>This playbook is in beta. Expect rough edges and possible breaking changes.</span>
				</div>
			)}

			<div className="flex-1 flex min-h-0 overflow-hidden">
				<PlaybookMetadataSidebar
					theme={theme}
					playbook={playbook}
					selectedDocFilename={selectedDocFilename}
					onSelectDocument={onSelectDocument}
				/>

				<div className="flex-1 flex flex-col min-w-0 min-h-0 overflow-hidden">
					<DocumentSelector
						theme={theme}
						playbook={playbook}
						selectedDocFilename={selectedDocFilename}
						onSelectDocument={onSelectDocument}
					/>
					<MarkdownPreviewPane
						theme={theme}
						readmeContent={readmeContent}
						selectedDocFilename={selectedDocFilename}
						documentContent={documentContent}
						isLoadingDocument={isLoadingDocument}
					/>
				</div>
			</div>

			<PlaybookImportFooter
				theme={theme}
				playbook={playbook}
				targetFolderName={targetFolderName}
				isImporting={isImporting}
				isRemoteSession={isRemoteSession}
				runningVersion={runningVersion}
				onTargetFolderChange={onTargetFolderChange}
				onBrowseFolder={onBrowseFolder}
				onImport={onImport}
			/>
		</div>
	);
}
