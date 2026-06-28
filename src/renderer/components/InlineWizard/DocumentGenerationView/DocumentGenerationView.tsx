import { AustinFactsDisplay } from '../AustinFactsDisplay';
import {
	CreatedFilesList,
	EmptyGenerationState,
	GenerationActions,
	GenerationStatus,
} from './components';
import { useElapsedGenerationTime } from './hooks/useElapsedGenerationTime';
import type { DocumentGenerationViewProps } from './types';
import { countTotalTasks } from './utils/documentStats';

export function DocumentGenerationView({
	theme,
	documents,
	currentDocumentIndex: _currentDocumentIndex,
	isGenerating,
	streamingContent: _streamingContent,
	onComplete,
	onCompleteAndStartAutoRun,
	onDocumentSelect: _onDocumentSelect,
	folderPath: _folderPath,
	onContentChange: _onContentChange,
	progressMessage: _progressMessage,
	currentGeneratingIndex: _currentGeneratingIndex,
	totalDocuments: _totalDocuments,
	onCancel,
	subfolderName,
	startedAt,
}: DocumentGenerationViewProps): JSX.Element {
	const totalTasks = countTotalTasks(documents);
	const elapsedMs = useElapsedGenerationTime(isGenerating, startedAt);
	const isComplete = !isGenerating && documents.length > 0;

	if (!isGenerating && documents.length === 0) {
		return <EmptyGenerationState theme={theme} onCancel={onCancel} />;
	}

	return (
		<div
			className="flex flex-col h-full items-center justify-center p-6 overflow-y-auto"
			style={{ backgroundColor: theme.colors.bgMain }}
		>
			<div className="flex flex-col items-center">
				<GenerationStatus
					theme={theme}
					isComplete={isComplete}
					totalTasks={totalTasks}
					elapsedMs={elapsedMs}
					subfolderName={subfolderName}
				/>

				<CreatedFilesList documents={documents} theme={theme} />

				{isComplete ? (
					<GenerationActions
						theme={theme}
						documentsLength={documents.length}
						onComplete={onComplete}
						onCompleteAndStartAutoRun={onCompleteAndStartAutoRun}
					/>
				) : (
					<>
						{onCancel && (
							<button
								type="button"
								onClick={onCancel}
								className="mt-4 px-4 py-2 text-sm rounded transition-colors hover:opacity-80"
								style={{
									backgroundColor: theme.colors.bgActivity,
									color: theme.colors.textDim,
									border: `1px solid ${theme.colors.border}`,
								}}
							>
								Cancel
							</button>
						)}

						<div className="mt-8">
							<AustinFactsDisplay theme={theme} isVisible={true} centered />
						</div>
					</>
				)}
			</div>

			<style>{`
				@keyframes fadeSlideIn {
					from {
						opacity: 0;
						transform: translateY(-8px);
					}
					to {
						opacity: 1;
						transform: translateY(0);
					}
				}

				@keyframes bounce-dot {
					0%, 100% {
						transform: translateY(0);
					}
					50% {
						transform: translateY(-6px);
					}
				}
			`}</style>
		</div>
	);
}
