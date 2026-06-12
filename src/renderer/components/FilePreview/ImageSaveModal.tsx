/**
 * ImageSaveModal - Destination picker for saving an edited image back to disk.
 *
 * Shown after the user saves from the image annotator while editing a file
 * (FilePreview's "Edit" button). Two phases:
 *   1. choose   - Overwrite the existing file, or save to a new file.
 *   2. name     - Enter the new file name (only when "save to new file" is picked).
 *
 * The component owns no persistence: it just reports the chosen destination via
 * `onOverwrite` / `onSaveAs(name)` and lets the caller write the bytes.
 */

import { useMemo, useRef, useState } from 'react';
import { FilePlus2, FileWarning, Save } from 'lucide-react';
import type { Theme } from '../../types';
import { MODAL_PRIORITIES } from '../../constants/modalPriorities';
import { Modal, ModalFooter } from '../ui/Modal';
import { FormInput } from '../ui/FormInput';
import { Spinner } from '../ui/Spinner';

interface ImageSaveModalProps {
	theme: Theme;
	/** Original file name (e.g. "icon-wand.png"), used to seed the new-file name. */
	fileName: string;
	/** Extension the edited image is encoded as (e.g. "png"), from its data URL. */
	outputExtension: string;
	/** Whether the original file can be replaced in place - true only when its
	 *  format matches what the editor can write (PNG). When false, "Overwrite"
	 *  can't reproduce the original format and falls back to `fallbackFileName`. */
	canOverwrite: boolean;
	/** Name written when the original format can't be reproduced (e.g. "photo.png"). */
	fallbackFileName: string;
	/** Original file's extension, shown in the can't-write notice (e.g. "jpg"). */
	originalExtension: string;
	onOverwrite: () => void;
	onSaveAs: (newFileName: string) => void;
	onCancel: () => void;
	isSaving?: boolean;
}

/** Split a file name into its base (no extension) and extension. */
function splitExtension(name: string): { base: string; ext: string } {
	const dot = name.lastIndexOf('.');
	if (dot <= 0) return { base: name, ext: '' };
	return { base: name.slice(0, dot), ext: name.slice(dot + 1) };
}

export function ImageSaveModal({
	theme,
	fileName,
	outputExtension,
	canOverwrite,
	fallbackFileName,
	originalExtension,
	onOverwrite,
	onSaveAs,
	onCancel,
	isSaving = false,
}: ImageSaveModalProps) {
	const [phase, setPhase] = useState<'choose' | 'name'>('choose');
	const inputRef = useRef<HTMLInputElement>(null);

	const defaultName = useMemo(() => {
		const { base } = splitExtension(fileName);
		return `${base}-edited.${outputExtension}`;
	}, [fileName, outputExtension]);

	const [newName, setNewName] = useState(defaultName);

	const isValid = newName.trim().length > 0 && newName.trim() !== '.';

	const handleSaveAs = () => {
		const trimmed = newName.trim();
		if (trimmed) onSaveAs(trimmed);
	};

	if (phase === 'name') {
		return (
			<Modal
				theme={theme}
				title="Save to a new file"
				priority={MODAL_PRIORITIES.IMAGE_SAVE}
				onClose={onCancel}
				headerIcon={<FilePlus2 className="w-4 h-4" style={{ color: theme.colors.accent }} />}
				initialFocusRef={inputRef as React.RefObject<HTMLElement>}
				footer={
					<ModalFooter
						theme={theme}
						onCancel={() => setPhase('choose')}
						onConfirm={handleSaveAs}
						cancelLabel="Back"
						confirmLabel={isSaving ? 'Saving...' : 'Save'}
						confirmDisabled={!isValid || isSaving}
					/>
				}
			>
				<FormInput
					ref={inputRef}
					theme={theme}
					label="File name"
					value={newName}
					onChange={setNewName}
					onSubmit={handleSaveAs}
					submitEnabled={isValid && !isSaving}
					selectOnFocus
					placeholder="Enter file name..."
					helperText="Saved alongside the original file, in the same folder."
				/>
			</Modal>
		);
	}

	return (
		<Modal
			theme={theme}
			title="Save edited image"
			priority={MODAL_PRIORITIES.IMAGE_SAVE}
			onClose={onCancel}
			headerIcon={<Save className="w-4 h-4" style={{ color: theme.colors.accent }} />}
			footer={
				<button
					type="button"
					onClick={onCancel}
					className="px-4 py-2 rounded border hover:bg-white/5 transition-colors outline-none"
					style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
				>
					Cancel
				</button>
			}
		>
			<div className="flex flex-col gap-3">
				<button
					type="button"
					disabled={isSaving}
					onClick={onOverwrite}
					className="flex items-start gap-3 p-3 rounded-lg border text-left transition-colors hover:bg-white/5 disabled:opacity-50 disabled:cursor-not-allowed"
					style={{ borderColor: theme.colors.border }}
				>
					{isSaving ? (
						<Spinner size={18} />
					) : canOverwrite ? (
						<Save
							className="w-[18px] h-[18px] mt-0.5 shrink-0"
							style={{ color: theme.colors.accent }}
						/>
					) : (
						<FileWarning
							className="w-[18px] h-[18px] mt-0.5 shrink-0"
							style={{ color: theme.colors.warning }}
						/>
					)}
					<span className="min-w-0">
						<span className="block text-sm font-medium" style={{ color: theme.colors.textMain }}>
							Overwrite the existing file
						</span>
						<span
							className="block text-xs mt-0.5 truncate"
							style={{ color: canOverwrite ? theme.colors.textDim : theme.colors.warning }}
						>
							{canOverwrite
								? `Replace ${fileName}`
								: `Can't write ${originalExtension.toUpperCase()}, will create ${fallbackFileName} instead`}
						</span>
					</span>
				</button>

				<button
					type="button"
					disabled={isSaving}
					onClick={() => setPhase('name')}
					className="flex items-start gap-3 p-3 rounded-lg border text-left transition-colors hover:bg-white/5 disabled:opacity-50 disabled:cursor-not-allowed"
					style={{ borderColor: theme.colors.border }}
				>
					<FilePlus2
						className="w-[18px] h-[18px] mt-0.5 shrink-0"
						style={{ color: theme.colors.textMain }}
					/>
					<span className="min-w-0">
						<span className="block text-sm font-medium" style={{ color: theme.colors.textMain }}>
							Save to a new file
						</span>
						<span className="block text-xs mt-0.5" style={{ color: theme.colors.textDim }}>
							Keep the original and write a copy
						</span>
					</span>
				</button>
			</div>
		</Modal>
	);
}

export default ImageSaveModal;
