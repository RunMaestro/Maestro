import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { Theme } from '../types';
import { Modal } from './ui/Modal';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import {
	finishHostFolderSelection,
	getHostFolderRequest,
	readHostFolder,
	subscribeHostFolderRequest,
	type HostFolderListing,
	type HostFolderRequest,
} from '../../web-desktop/remote-file-dialog';
import { joinPath } from '../../shared/formatters';

export function HostFolderPicker({ theme }: { theme: Theme }) {
	const pending = useSyncExternalStore(subscribeHostFolderRequest, getHostFolderRequest);
	return pending ? <Picker theme={theme} pending={pending} /> : null;
}

function Picker({ theme, pending }: { theme: Theme; pending: HostFolderRequest }) {
	const [listing, setListing] = useState<HostFolderListing | null>(null);
	const [path, setPath] = useState('');
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const [filename, setFilename] = useState(pending.saveName ?? '');
	const generation = useRef(0);
	const navigate = useCallback(
		async (target?: string) => {
			const current = ++generation.current;
			setLoading(true);
			setError(null);
			try {
				const next = await readHostFolder(pending, target);
				if (generation.current !== current) return;
				setListing(next);
				setPath(next.path);
			} catch (cause) {
				if (generation.current === current) {
					setListing(null);
					setError(cause instanceof Error ? cause.message : String(cause));
				}
			} finally {
				if (generation.current === current) setLoading(false);
			}
		},
		[pending]
	);
	useEffect(() => {
		void navigate();
		return () => {
			generation.current++;
		};
	}, [navigate]);
	const close = useCallback(() => finishHostFolderSelection(null), []);
	const choose = async () => {
		if (!listing || loading || error) return;
		try {
			if (
				pending.saveName !== undefined &&
				(!filename.trim() || /[/\\:\0]/.test(filename) || filename === '.' || filename === '..')
			) {
				throw new Error('Enter a file name, not a path');
			}
			// Recheck existence at acceptance; the host may have moved the directory.
			const selected = await readHostFolder(pending, listing.path);
			finishHostFolderSelection(
				pending.saveName === undefined ? selected.path : joinPath(selected.path, filename)
			);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		}
	};
	return (
		<Modal
			theme={theme}
			title={pending.saveName === undefined ? 'Select Host Directory' : 'Save File on Host'}
			subtitle="Browse the filesystem of the connected Maestro host"
			priority={MODAL_PRIORITIES.CONFIRM}
			onClose={close}
			width={640}
			footer={
				<div className="flex justify-end gap-3 p-3">
					<button onClick={close}>Cancel</button>
					<button
						onClick={() => void choose()}
						disabled={!listing || loading}
						style={{ color: theme.colors.accent }}
					>
						{pending.saveName === undefined ? 'Select this host directory' : 'Save on host'}
					</button>
				</div>
			}
		>
			<form
				className="flex gap-2 p-3"
				onSubmit={(event) => {
					event.preventDefault();
					void navigate(path);
				}}
			>
				<input
					aria-label="Absolute host directory path"
					value={path}
					onChange={(event) => setPath(event.target.value)}
					className="flex-1 min-w-0 rounded border px-2 py-1"
					style={{
						background: theme.colors.bgMain,
						color: theme.colors.textMain,
						borderColor: theme.colors.border,
					}}
				/>
				<button type="submit" disabled={loading}>
					Go
				</button>
			</form>
			{pending.saveName !== undefined && (
				<label className="block px-3 pb-3">
					File name on host
					<input
						aria-label="File name on host"
						value={filename}
						onChange={(event) => {
							setFilename(event.target.value);
							setError(null);
						}}
						className="w-full rounded border px-2 py-1"
						style={{
							background: theme.colors.bgMain,
							color: theme.colors.textMain,
							borderColor: theme.colors.border,
						}}
					/>
					{pending.filters && (
						<span className="text-xs">
							Formats:{' '}
							{pending.filters
								.map((filter) => filter.extensions.map((extension) => `.${extension}`).join(', '))
								.join('; ')}
						</span>
					)}
				</label>
			)}
			<div className="flex flex-wrap gap-3 px-3 pb-2">
				<button
					disabled={loading || !listing?.parent}
					onClick={() => listing?.parent && void navigate(listing.parent)}
				>
					Parent
				</button>
				<button disabled={loading} onClick={() => void navigate()}>
					Host home
				</button>
				{listing?.roots.map((root) => (
					<button key={root} disabled={loading} onClick={() => void navigate(root)}>
						{root}
					</button>
				))}
			</div>
			{error && (
				<p role="alert" className="px-3 pb-2" style={{ color: theme.colors.error }}>
					{error}
				</p>
			)}
			{loading ? (
				<p role="status" className="p-3">
					Reading host directory…
				</p>
			) : (
				<div className="overflow-auto max-h-80 p-3" aria-label="Host directories">
					{listing?.entries.map((entry) => (
						<button
							key={entry.path}
							className="block w-full text-left rounded px-2 py-2 hover:bg-white/10"
							onClick={() => void navigate(entry.path)}
						>
							{entry.name}
							{entry.isSymlink ? ' ↗' : ''}
						</button>
					))}
					{listing && listing.entries.length === 0 && <p>No subdirectories</p>}
				</div>
			)}
		</Modal>
	);
}
