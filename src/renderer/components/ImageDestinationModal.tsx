/**
 * ImageDestinationModal - asks where a right-clicked image should be written
 * before anything touches disk.
 *
 * Opened by "Save to Project..." in ImageContextMenu. The user sees (and can
 * change) the project-relative folder, the file name, and the format, so a save
 * is never a blind write into a folder they have to go hunting for. Defaults are
 * the common case: `.maestro/diagrams/` and a timestamped name.
 *
 * Not to be confused with FilePreview/ImageSaveModal, which is the annotator's
 * overwrite-vs-save-as prompt for a file already on disk.
 */

import { useMemo, useRef, useState } from 'react';
import { FolderOpen } from 'lucide-react';
import type { Theme } from '../types';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import { Modal, ModalFooter } from './ui/Modal';
import { FormInput } from './ui/FormInput';
import { joinPath } from '../../shared/formatters';
import type { ImageSaveFormat } from '../utils/imageExport';

export interface ImageDestination {
	relativeDir: string;
	fileName: string;
	format: ImageSaveFormat;
}

interface ImageDestinationModalProps {
	theme: Theme;
	/** Project root the image will be written under, for the path preview. */
	projectRoot: string;
	/** Whether the target is an <svg> - only then is the SVG/PNG choice offered. */
	isSvg: boolean;
	/** Seed values (timestamped name, `.maestro/diagrams`). */
	initialDir: string;
	initialFileName: string;
	onSave: (destination: ImageDestination) => void;
	onCancel: () => void;
	isSaving?: boolean;
}

/** Swap a file name's extension, appending one when it has none. */
function withExtension(name: string, ext: string): string {
	const dot = name.lastIndexOf('.');
	return `${dot > 0 ? name.slice(0, dot) : name}.${ext}`;
}

export function ImageDestinationModal({
	theme,
	projectRoot,
	isSvg,
	initialDir,
	initialFileName,
	onSave,
	onCancel,
	isSaving = false,
}: ImageDestinationModalProps) {
	const nameRef = useRef<HTMLInputElement>(null);
	const [relativeDir, setRelativeDir] = useState(initialDir);
	const [fileName, setFileName] = useState(initialFileName);
	// SVG targets can be written as markup or rasterized; raster targets keep
	// whatever they already are, so the choice is meaningless for them.
	const [format, setFormat] = useState<ImageSaveFormat>(isSvg ? 'svg' : 'original');

	const isValid = fileName.trim().length > 0 && fileName.trim() !== '.';

	const previewPath = useMemo(
		() => joinPath(projectRoot, relativeDir.trim() || '.', fileName.trim() || '...'),
		[projectRoot, relativeDir, fileName]
	);

	const handleFormatChange = (next: ImageSaveFormat) => {
		setFormat(next);
		setFileName((current) => withExtension(current, next === 'png' ? 'png' : 'svg'));
	};

	const handleSave = () => {
		if (!isValid || isSaving) return;
		onSave({ relativeDir: relativeDir.trim() || '.', fileName: fileName.trim(), format });
	};

	return (
		<Modal
			theme={theme}
			title="Save image to project"
			priority={MODAL_PRIORITIES.IMAGE_SAVE}
			onClose={onCancel}
			headerIcon={<FolderOpen className="w-4 h-4" style={{ color: theme.colors.accent }} />}
			initialFocusRef={nameRef as React.RefObject<HTMLElement>}
			footer={
				<ModalFooter
					theme={theme}
					onCancel={onCancel}
					onConfirm={handleSave}
					confirmLabel={isSaving ? 'Saving...' : 'Save'}
					confirmDisabled={!isValid || isSaving}
				/>
			}
		>
			<div className="flex flex-col gap-3">
				{isSvg && (
					<div className="flex items-center gap-2">
						{(['svg', 'png'] as const).map((option) => (
							<button
								key={option}
								type="button"
								onClick={() => handleFormatChange(option)}
								className="px-3 py-1.5 rounded border text-xs transition-colors"
								style={{
									borderColor: format === option ? theme.colors.accent : theme.colors.border,
									color: format === option ? theme.colors.accent : theme.colors.textDim,
								}}
							>
								{option.toUpperCase()}
							</button>
						))}
						<span className="text-xs" style={{ color: theme.colors.textDim }}>
							{format === 'svg' ? 'Vector markup, scales cleanly' : 'Rasterized at 2x'}
						</span>
					</div>
				)}

				<FormInput
					theme={theme}
					label="Folder"
					value={relativeDir}
					onChange={setRelativeDir}
					placeholder=".maestro/diagrams"
					helperText="Relative to the project root. Created if it does not exist."
				/>

				<FormInput
					ref={nameRef}
					theme={theme}
					label="File name"
					value={fileName}
					onChange={setFileName}
					onSubmit={handleSave}
					submitEnabled={isValid && !isSaving}
					selectOnFocus
					placeholder="diagram.svg"
					helperText="An existing name gets a -2 suffix rather than being overwritten."
				/>

				<div
					className="text-xs px-2 py-1.5 rounded truncate"
					style={{ backgroundColor: theme.colors.bgActivity, color: theme.colors.textDim }}
					title={previewPath}
				>
					{previewPath}
				</div>
			</div>
		</Modal>
	);
}

export default ImageDestinationModal;
