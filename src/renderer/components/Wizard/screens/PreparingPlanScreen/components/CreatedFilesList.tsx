import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, FileText } from 'lucide-react';
import type { Theme } from '../../../../../types';
import { formatSize } from '../../../../../../shared/formatters';
import type { CreatedFileInfo } from '../types';

function CreatedFileEntry({
	file,
	isExpanded,
	isNewest,
	theme,
	onToggle,
}: {
	file: CreatedFileInfo;
	isExpanded: boolean;
	isNewest: boolean;
	theme: Theme;
	onToggle: () => void;
}): JSX.Element {
	return (
		<div
			className="overflow-hidden transition-all duration-300"
			style={{ animation: isNewest ? 'fadeSlideIn 0.3s ease-out' : undefined }}
		>
			<button
				onClick={onToggle}
				className="w-full px-4 py-2.5 flex items-center justify-between text-sm text-left hover:opacity-80 transition-opacity"
				style={{ backgroundColor: isExpanded ? `${theme.colors.accent}10` : 'transparent' }}
			>
				<div className="flex items-center gap-2 min-w-0">
					{isExpanded ? (
						<ChevronDown
							className="w-4 h-4 shrink-0 transition-transform duration-200"
							style={{ color: theme.colors.textDim }}
						/>
					) : (
						<ChevronRight
							className="w-4 h-4 shrink-0 transition-transform duration-200"
							style={{ color: theme.colors.textDim }}
						/>
					)}
					<span style={{ color: theme.colors.success }}>✓</span>
					<span
						className="truncate font-medium"
						style={{ color: theme.colors.textMain }}
						title={file.filename}
					>
						{file.filename}
					</span>
				</div>
				<div className="flex items-center gap-3 shrink-0 ml-2">
					{file.taskCount !== undefined && file.taskCount > 0 && (
						<span
							className="text-xs font-medium px-1.5 py-0.5 rounded"
							style={{ backgroundColor: `${theme.colors.accent}20`, color: theme.colors.accent }}
						>
							{file.taskCount} {file.taskCount === 1 ? 'task' : 'tasks'}
						</span>
					)}
					<span className="text-xs" style={{ color: theme.colors.textDim }}>
						{formatSize(file.size)}
					</span>
				</div>
			</button>

			<div
				className="overflow-hidden transition-all duration-300 ease-out"
				style={{ maxHeight: isExpanded ? '120px' : '0px', opacity: isExpanded ? 1 : 0 }}
			>
				{file.description && (
					<div
						className="px-4 pb-3 pl-12 text-xs leading-relaxed"
						style={{ color: theme.colors.textDim }}
					>
						{file.description}
					</div>
				)}
			</div>
		</div>
	);
}

export function CreatedFilesList({
	files,
	theme,
}: {
	files: CreatedFileInfo[];
	theme: Theme;
}): JSX.Element | null {
	const [expandedFiles, setExpandedFiles] = useState<Set<string>>(new Set());
	const userToggledFilesRef = useRef<Set<string>>(new Set());
	const lastAutoExpandedRef = useRef<string | null>(null);
	const prevFilesCountRef = useRef(files.length);

	useEffect(() => {
		if (files.length > prevFilesCountRef.current && files.length > 0) {
			const newestFile = files[files.length - 1];

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
		prevFilesCountRef.current = files.length;
	}, [files]);

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

	if (files.length === 0) return null;

	const newestIndex = files.length - 1;

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
				style={{ backgroundColor: `${theme.colors.success}15`, borderColor: theme.colors.border }}
			>
				<FileText className="w-4 h-4" style={{ color: theme.colors.success }} />
				<span
					className="text-xs font-medium uppercase tracking-wide"
					style={{ color: theme.colors.success }}
				>
					Work Plans Drafted ({files.length})
				</span>
			</div>
			<div className="overflow-y-auto" style={{ maxHeight: 'calc(40vh - 100px)' }}>
				{files.map((file, index) => (
					<div
						key={file.path}
						style={{
							borderBottom:
								index < files.length - 1 ? `1px solid ${theme.colors.border}` : undefined,
						}}
					>
						<CreatedFileEntry
							file={file}
							isExpanded={expandedFiles.has(file.filename)}
							isNewest={index === newestIndex}
							theme={theme}
							onToggle={() => toggleFile(file.filename)}
						/>
					</div>
				))}
			</div>
		</div>
	);
}
