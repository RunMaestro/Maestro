/**
 * AdditionalDirectoriesSection - manage the extra directories an agent may
 * access beyond its working directory.
 *
 * Shared by the create (NewInstanceModal), edit (EditAgentModal), and Wizard
 * directory surfaces so all three produce the same `AdditionalDirectory[]`.
 *
 * Each row is a path plus two square toggles: R (read) and W (write). They are
 * independent, so a directory can be reference-only (R), a drop box the agent
 * must never read back (W), or both. A row with neither toggle lit is inert and
 * is not sent to the agent - the row is kept so toggling off doesn't destroy
 * the path the user typed.
 *
 * Grants always reach the agent through the {{ADDITIONAL_DIRECTORIES}} block in
 * the Maestro system prompt. Providers that declare `supportsAdditionalDirectories`
 * ALSO get them as native CLI flags (`--add-dir`), which the provider actually
 * enforces. `nativelyEnforced` picks which of those two promises we make to the
 * user - do not let the copy claim enforcement the selected provider can't deliver.
 */

import React, { useCallback } from 'react';
import { Folder, Plus, Trash2 } from 'lucide-react';

import { FormInput } from '../ui/FormInput';
import { GhostIconButton } from '../ui/GhostIconButton';
import type { AdditionalDirectory, Theme } from '../../types';

interface AdditionalDirectoriesSectionProps {
	theme: Theme;
	directories: AdditionalDirectory[];
	onChange: (directories: AdditionalDirectory[]) => void;
	/**
	 * SSH agents run on a remote host, where the local folder picker is
	 * meaningless. Hide the Browse buttons and let the user type remote paths.
	 */
	disableBrowse?: boolean;
	/**
	 * Whether the selected provider enforces these grants at the CLI level
	 * (`capabilities.supportsAdditionalDirectories`). Drives the copy only.
	 */
	nativelyEnforced?: boolean;
}

interface PermissionSquareProps {
	theme: Theme;
	label: string;
	title: string;
	active: boolean;
	onToggle: () => void;
}

/** One square permission toggle (R or W). Lit = granted. */
function PermissionSquare({
	theme,
	label,
	title,
	active,
	onToggle,
}: PermissionSquareProps): React.ReactElement {
	return (
		<button
			type="button"
			role="switch"
			aria-checked={active}
			aria-label={title}
			title={title}
			onClick={onToggle}
			className="w-9 shrink-0 rounded border text-xs font-bold transition-colors focus:outline-none focus:ring-1"
			style={{
				borderColor: active ? theme.colors.accent : theme.colors.border,
				backgroundColor: active ? theme.colors.accent : 'transparent',
				color: active ? theme.colors.bgMain : theme.colors.textDim,
				['--tw-ring-color' as any]: theme.colors.accent,
			}}
		>
			{label}
		</button>
	);
}

export function AdditionalDirectoriesSection({
	theme,
	directories,
	onChange,
	disableBrowse = false,
	nativelyEnforced = false,
}: AdditionalDirectoriesSectionProps): React.ReactElement {
	const updateAt = useCallback(
		(index: number, patch: Partial<AdditionalDirectory>) => {
			onChange(directories.map((dir, i) => (i === index ? { ...dir, ...patch } : dir)));
		},
		[directories, onChange]
	);

	const removeAt = useCallback(
		(index: number) => {
			onChange(directories.filter((_, i) => i !== index));
		},
		[directories, onChange]
	);

	// New rows default to read-only: the safe grant, and the one users want most
	// (reference material). Write is a deliberate second click.
	const addDirectory = useCallback(() => {
		onChange([...directories, { path: '', read: true, write: false }]);
	}, [directories, onChange]);

	const browseAt = useCallback(
		async (index: number) => {
			const folder = await window.maestro.dialog.selectFolder();
			if (folder) updateAt(index, { path: folder });
		},
		[updateAt]
	);

	return (
		<div>
			<div
				className="block text-xs font-bold opacity-70 uppercase mb-2"
				style={{ color: theme.colors.textMain }}
			>
				Additional Directories
			</div>
			<p className="text-xs mb-2" style={{ color: theme.colors.textDim }}>
				Directories the agent may use beyond its working directory. Toggle{' '}
				<span className="font-bold">R</span> for read and <span className="font-bold">W</span> for
				write on each.{' '}
				{nativelyEnforced ? (
					<>
						This provider enforces these grants itself. The read/write split is carried by the
						agent's instructions.
					</>
				) : (
					<>
						This provider has no directory-permission flag, so the grants are instructions in the
						agent's system prompt, not a sandbox.
					</>
				)}
			</p>

			<div className="space-y-2">
				{directories.map((dir, index) => {
					const inert = !dir.read && !dir.write;
					return (
						<div key={index}>
							<FormInput
								theme={theme}
								value={dir.path}
								onChange={(value) => updateAt(index, { path: value })}
								placeholder={
									disableBrowse ? 'Enter remote path...' : '/path/to/directory or ~/path'
								}
								monospace
								heightClass="p-2"
								addon={
									<>
										{!disableBrowse && (
											<button
												type="button"
												onClick={() => void browseAt(index)}
												className="p-2 rounded border transition-colors hover:bg-white/5"
												style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
												title="Browse folders"
												aria-label="Browse folders"
											>
												<Folder className="w-4 h-4" />
											</button>
										)}
										<PermissionSquare
											theme={theme}
											label="R"
											title="Read access"
											active={dir.read}
											onToggle={() => updateAt(index, { read: !dir.read })}
										/>
										<PermissionSquare
											theme={theme}
											label="W"
											title="Write access"
											active={dir.write}
											onToggle={() => updateAt(index, { write: !dir.write })}
										/>
										<GhostIconButton
											onClick={() => removeAt(index)}
											padding="p-2"
											color={theme.colors.textDim}
											title="Remove directory"
											ariaLabel="Remove directory"
										>
											<Trash2 className="w-4 h-4" />
										</GhostIconButton>
									</>
								}
							/>
							{inert && dir.path.trim() && (
								<p className="mt-1 text-xs" style={{ color: theme.colors.warning }}>
									No access selected - this directory will not be given to the agent.
								</p>
							)}
						</div>
					);
				})}
			</div>

			<button
				type="button"
				onClick={addDirectory}
				className="mt-2 flex items-center gap-1.5 text-xs px-2 py-1.5 rounded border transition-colors hover:bg-white/5"
				style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
			>
				<Plus className="w-3.5 h-3.5" />
				Add Directory
			</button>
		</div>
	);
}
