import { useCallback, useEffect, useRef, useState } from 'react';
import { FileText } from 'lucide-react';
import type { Theme } from '../../../../types';
import type { GeneratedDocument } from '../../../Wizard/WizardContext';
import { CreatedFileEntry } from './CreatedFileEntry';

interface CreatedFilesListProps {
	documents: GeneratedDocument[];
	theme: Theme;
}

export function CreatedFilesList({ documents, theme }: CreatedFilesListProps): JSX.Element | null {
	const [expandedFiles, setExpandedFiles] = useState<Set<string>>(new Set());
	const userToggledFilesRef = useRef<Set<string>>(new Set());
	const lastAutoExpandedRef = useRef<string | null>(null);

	const prevFilesCountRef = useRef(documents.length);
	useEffect(() => {
		if (documents.length > prevFilesCountRef.current && documents.length > 0) {
			const newestFile = documents[documents.length - 1];

			setExpandedFiles((prev) => {
				const next = new Set(prev);

				if (
					lastAutoExpandedRef.current &&
					!userToggledFilesRef.current.has(lastAutoExpandedRef.current)
				) {
					next.delete(lastAutoExpandedRef.current);
				}

				next.add(newestFile.filename);
				return next;
			});

			lastAutoExpandedRef.current = newestFile.filename;
		}
		prevFilesCountRef.current = documents.length;
	}, [documents]);

	const toggleFile = useCallback((filename: string) => {
		userToggledFilesRef.current.add(filename);
		setExpandedFiles((prev) => {
			const next = new Set(prev);
			if (next.has(filename)) {
				next.delete(filename);
			} else {
				next.add(filename);
			}
			return next;
		});
	}, []);

	if (documents.length === 0) return null;

	const newestIndex = documents.length - 1;

	return (
		<div
			className="mt-6 mx-auto rounded-lg overflow-hidden"
			style={{
				backgroundColor: theme.colors.bgActivity,
				border: `1px solid ${theme.colors.border}`,
				width: '600px',
				maxWidth: '100%',
			}}
		>
			<div
				className="px-4 py-2.5 border-b flex items-center gap-2"
				style={{
					backgroundColor: `${theme.colors.success}15`,
					borderColor: theme.colors.border,
				}}
			>
				<FileText className="w-4 h-4" style={{ color: theme.colors.success }} />
				<span
					className="text-xs font-medium uppercase tracking-wide"
					style={{ color: theme.colors.success }}
				>
					Work Plans Drafted ({documents.length})
				</span>
			</div>
			<div
				className="overflow-y-auto"
				style={{
					maxHeight: 'calc(40vh - 100px)',
				}}
			>
				{documents.map((doc, index) => (
					<div
						key={doc.filename}
						style={{
							borderBottom:
								index < documents.length - 1 ? `1px solid ${theme.colors.border}` : undefined,
						}}
					>
						<CreatedFileEntry
							doc={doc}
							isExpanded={expandedFiles.has(doc.filename)}
							isNewest={index === newestIndex}
							theme={theme}
							onToggle={() => toggleFile(doc.filename)}
						/>
					</div>
				))}
			</div>
		</div>
	);
}
