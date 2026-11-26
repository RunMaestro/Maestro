/**
 * PathPickerModal - the Maestro-drawn folder or file picker for a path that lives on a remote.
 *
 * Opened only through `pickDirectory()` / `pickFile()` in `services/pathPicker.ts`, which open
 * the native OS dialog for a local agent instead. It lists one folder at a time through
 * `window.maestro.fs.readDir(path, sshRemoteId)`, the IPC the Files panel reads a remote with.
 * Its copy never names the transport: to the user it is just the folder picker.
 *
 * Keys: Up/Down walk the rows, Enter opens a folder (or picks a file), Backspace goes up a folder,
 * Escape cancels. The path box takes a typed path; Enter there goes to it.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUp, File as FileIcon, Folder, FolderOpen } from 'lucide-react';
import type { Theme } from '../../types';
import type { DirectoryEntry } from '../../../shared/types';
import { MODAL_PRIORITIES } from '../../constants/modalPriorities';
import { getParentDir } from '../../../shared/formatters';
import { ipcErrorMessage } from '../../../shared/serializeError';
import { useListNavigation } from '../../hooks/keyboard/useListNavigation';
import { useScrollIntoView } from '../../hooks/ui/useScrollIntoView';
import { isCoarsePointer } from '../../utils/touch';
import { Modal, ModalFooter } from '../ui/Modal';
import { Spinner } from '../ui/Spinner';
import { REMOTE_PICKER_HOME, usePathPickerStore } from '../../services/pathPicker';
import type { PathPickerRequest } from '../../services/pathPicker';

/** The folder above `path` on a POSIX host. The home alias (`~`) has no listed parent. */
export function remoteParentPath(path: string): string | null {
	const trimmed = path.length > 1 ? path.replace(/\/+$/, '') : path;
	if (trimmed === '/' || trimmed === REMOTE_PICKER_HOME) return null;
	if (!trimmed.includes('/')) return null;
	const parent = getParentDir(trimmed);
	// `getParentDir('/home')` strips to '' and hands the input back; the parent there is the root.
	if (parent === trimmed) return trimmed.startsWith('/') ? '/' : null;
	return parent;
}

function matchesFilters(name: string, filters: PathPickerRequest['filters']): boolean {
	if (!filters || filters.length === 0) return true;
	const lower = name.toLowerCase();
	return filters.some((filter) =>
		filter.extensions.some((ext) => ext === '*' || lower.endsWith(`.${ext.toLowerCase()}`))
	);
}

/** Mounts the picker while a remote Browse is open. One per app (AppShell). */
export function PathPickerHost({ theme }: { theme: Theme }) {
	const request = usePathPickerStore((s) => s.request);
	const settle = usePathPickerStore((s) => s.settle);
	if (!request) return null;
	return <PathPickerModal theme={theme} request={request} onSettle={settle} />;
}

interface PathPickerModalProps {
	theme: Theme;
	request: PathPickerRequest;
	onSettle: (path: string | null) => void;
}

export function PathPickerModal({ theme, request, onSettle }: PathPickerModalProps) {
	const { kind, sshRemoteId, title, startPath, filters } = request;
	const [currentPath, setCurrentPath] = useState(startPath);
	const [pathDraft, setPathDraft] = useState(startPath);
	const [entries, setEntries] = useState<DirectoryEntry[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const listRef = useRef<HTMLDivElement>(null);
	const loadSeq = useRef(0);

	const load = useCallback(
		async (path: string) => {
			const seq = ++loadSeq.current;
			setLoading(true);
			setError(null);
			try {
				const listed = await window.maestro.fs.readDir(path, sshRemoteId);
				if (seq !== loadSeq.current) return;
				setCurrentPath(path);
				setPathDraft(path);
				setEntries(listed);
			} catch (err) {
				if (seq !== loadSeq.current) return;
				setError(`Could not open ${path}: ${ipcErrorMessage(err, 'folder not found')}`);
			} finally {
				if (seq === loadSeq.current) setLoading(false);
			}
		},
		[sshRemoteId]
	);

	useEffect(() => {
		void load(startPath);
	}, [load, startPath]);

	const rows = useMemo(() => {
		const visible = entries.filter(
			(entry) => entry.isDirectory || (kind === 'file' && matchesFilters(entry.name, filters))
		);
		return visible.sort((a, b) => {
			if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
			return a.name.localeCompare(b.name);
		});
	}, [entries, kind, filters]);

	const parent = remoteParentPath(currentPath);
	const goUp = useCallback(() => {
		if (parent) void load(parent);
	}, [parent, load]);

	const openRow = useCallback(
		(index: number) => {
			const row = rows[index];
			if (!row) return;
			if (row.isDirectory) void load(row.path);
			else onSettle(row.path);
		},
		[rows, load, onSettle]
	);

	const { selectedIndex, setSelectedIndex, handleKeyDown } = useListNavigation({
		listLength: rows.length,
		onSelect: openRow,
	});
	const rowRefs = useScrollIntoView<HTMLButtonElement>(true, selectedIndex, rows.length, 'auto');

	// A new folder starts with its first row highlighted.
	useEffect(() => {
		setSelectedIndex(0);
	}, [currentPath, setSelectedIndex]);

	const selectedRow = rows[selectedIndex];
	const canConfirm =
		!loading && !error && (kind === 'directory' || (!!selectedRow && !selectedRow.isDirectory));
	const confirm = () => {
		if (!canConfirm) return;
		onSettle(kind === 'directory' ? currentPath : selectedRow.path);
	};

	const onListKeyDown = (e: React.KeyboardEvent) => {
		if (e.key === 'Backspace') {
			e.preventDefault();
			goUp();
			return;
		}
		handleKeyDown(e);
	};

	return (
		<Modal
			theme={theme}
			title={title}
			priority={MODAL_PRIORITIES.PATH_PICKER}
			onClose={() => onSettle(null)}
			headerIcon={<FolderOpen className="w-4 h-4" style={{ color: theme.colors.accent }} />}
			width={560}
			resizeKey="pathPicker"
			defaultSize={{ width: 560, height: 480 }}
			minSize={{ width: 380, height: 300 }}
			initialFocusRef={listRef as React.RefObject<HTMLElement>}
			testId="path-picker"
			contentClassName="p-4 flex-1 min-h-0 flex flex-col gap-3 select-none"
			footer={
				<ModalFooter
					theme={theme}
					onCancel={() => onSettle(null)}
					onConfirm={confirm}
					confirmLabel={kind === 'directory' ? 'Select Folder' : 'Select File'}
					confirmDisabled={!canConfirm}
				/>
			}
		>
			<div className="flex items-center gap-2">
				<button
					type="button"
					onClick={goUp}
					disabled={!parent || loading}
					className="p-2 rounded border transition-colors hover:bg-white/5 disabled:opacity-40 disabled:cursor-not-allowed"
					style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
					title="Up one folder (Backspace)"
					aria-label="Up one folder"
					data-testid="path-picker-up"
				>
					<ArrowUp className="w-4 h-4" />
				</button>
				<input
					type="text"
					value={pathDraft}
					onChange={(e) => setPathDraft(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === 'Enter' && pathDraft.trim()) {
							e.preventDefault();
							e.stopPropagation();
							void load(pathDraft.trim());
						}
					}}
					spellCheck={false}
					aria-label="Folder path"
					className="flex-1 min-w-0 p-2 rounded border bg-transparent outline-none font-mono text-sm select-text"
					style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
					data-testid="path-picker-path"
				/>
			</div>
			<div
				ref={listRef}
				tabIndex={0}
				role="listbox"
				aria-label={kind === 'directory' ? 'Folders' : 'Folders and files'}
				onKeyDown={onListKeyDown}
				className="flex-1 min-h-0 overflow-y-auto rounded border outline-none"
				style={{ borderColor: theme.colors.border }}
				data-testid="path-picker-list"
			>
				{loading ? (
					<div
						className="flex items-center gap-2 p-3 text-sm"
						style={{ color: theme.colors.textDim }}
					>
						<Spinner size={14} /> Loading...
					</div>
				) : error ? (
					<div
						className="p-3 text-sm select-text"
						style={{ color: theme.colors.error }}
						data-testid="path-picker-error"
					>
						{error}
					</div>
				) : rows.length === 0 ? (
					<div className="p-3 text-sm" style={{ color: theme.colors.textDim }}>
						{kind === 'directory' ? 'No folders here.' : 'No matching files here.'}
					</div>
				) : (
					rows.map((row, index) => {
						const selected = index === selectedIndex;
						const Icon = row.isDirectory ? Folder : FileIcon;
						return (
							<button
								key={row.path}
								ref={(el) => {
									rowRefs.current[index] = el;
								}}
								type="button"
								role="option"
								aria-selected={selected}
								tabIndex={-1}
								onClick={() => (isCoarsePointer() ? openRow(index) : setSelectedIndex(index))}
								onDoubleClick={() => openRow(index)}
								className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-left"
								style={{
									backgroundColor: selected ? theme.colors.accent + '30' : undefined,
									color: theme.colors.textMain,
								}}
								data-testid="path-picker-row"
							>
								<Icon
									className="w-4 h-4 shrink-0"
									style={{ color: row.isDirectory ? theme.colors.accent : theme.colors.textDim }}
								/>
								<span className="truncate">{row.name}</span>
							</button>
						);
					})
				)}
			</div>
		</Modal>
	);
}
