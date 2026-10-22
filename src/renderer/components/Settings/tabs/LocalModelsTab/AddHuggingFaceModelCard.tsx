/**
 * AddHuggingFaceModelCard - add a model the catalog does not list, by Hugging
 * Face repo id and GGUF file name.
 *
 * Two steps, so the license is read before anything is fetched or saved:
 * **Look up** asks Hugging Face to describe the repo and shows the model's
 * license (from its card), size, pinned revision and fit; **Add to Library**
 * saves it as a user entry. Neither downloads the model: it appears as a row
 * with its own Download button, labeled "Not verified by Maestro".
 *
 * Mounting sends nothing. Each request is one click, and editing either field
 * drops the answer it no longer describes.
 */

import { useCallback, useState } from 'react';
import { Plus, Search } from 'lucide-react';

import { formatSize } from '../../../../../shared/formatters';
import {
	MODEL_FIT_LABELS,
	modelFit,
	type HardwareProfile,
} from '../../../../../shared/local-models/model-fit';
import {
	USER_MODEL_UNVERIFIED_DETAIL,
	USER_MODEL_UNVERIFIED_LABEL,
} from '../../../../../shared/local-models/user-models';
import type { HuggingFaceModelPreview } from '../../../../../main/local-models/user-models';
import type { Theme } from '../../../../types';
import { ipcErrorMessage } from '../../../../utils/ipcErrorMessage';
import { FormInput } from '../../../ui/FormInput';
import { MiniBadge } from '../../../ui/MiniBadge';
import { SectionCard } from '../DisplayTab/components/SectionCard';
import { CardButton } from './CardButton';

export interface AddHuggingFaceModelCardProps {
	theme: Theme;
	/** The hardware the preview's fit is judged against. Null until it is read. */
	hardware: HardwareProfile | null;
	/** Called after a model joins the Library, so the list is re-read. */
	onAdded: () => void;
}

type Busy = 'lookup' | 'add' | null;

export function AddHuggingFaceModelCard({
	theme,
	hardware,
	onAdded,
}: AddHuggingFaceModelCardProps) {
	const [repo, setRepo] = useState('');
	const [file, setFile] = useState('');
	const [preview, setPreview] = useState<HuggingFaceModelPreview | null>(null);
	const [busy, setBusy] = useState<Busy>(null);
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);

	// An answer describes the repo and file it was asked about, and nothing else.
	const editRepo = (next: string) => {
		setRepo(next);
		setPreview(null);
		setError(null);
		setNotice(null);
	};
	const editFile = (next: string) => {
		setFile(next);
		setPreview(null);
		setError(null);
		setNotice(null);
	};

	const ready = repo.trim() !== '' && file.trim() !== '' && busy === null;

	const lookUp = useCallback(async () => {
		setBusy('lookup');
		setError(null);
		setNotice(null);
		setPreview(null);
		try {
			const result = await window.maestro.localModels.huggingFace.preview(repo, file);
			if (result.ok) setPreview(result.value);
			else setError(result.message);
		} catch (err) {
			setError(ipcErrorMessage(err));
		} finally {
			setBusy(null);
		}
	}, [repo, file]);

	const add = useCallback(async () => {
		setBusy('add');
		setError(null);
		try {
			const result = await window.maestro.localModels.huggingFace.add(repo, file);
			if (!result.ok) {
				setError(result.message);
				return;
			}
			setNotice(
				result.value.added
					? `${result.value.entry.displayName} is in the Library. Download it from its row.`
					: `${result.value.entry.displayName} was already in the Library.`
			);
			setPreview(null);
			setRepo('');
			setFile('');
			onAdded();
		} catch (err) {
			setError(ipcErrorMessage(err));
		} finally {
			setBusy(null);
		}
	}, [repo, file, onAdded]);

	const entry = preview?.entry;
	const fit = entry && hardware ? modelFit(entry, hardware) : null;

	return (
		<SectionCard theme={theme}>
			<div data-setting-id="local-models-add-hf" data-testid="local-models-add-hf">
				<div className="font-medium" style={{ color: theme.colors.textMain }}>
					Add from Hugging Face
				</div>
				<p className="text-xs opacity-70 mt-0.5">
					Add a GGUF text model the Library does not list. Maestro pins the revision and checks the
					download against the hash Hugging Face reports, but has not tested the model.
				</p>
			</div>
			<FormInput
				theme={theme}
				label="Repo id"
				value={repo}
				onChange={editRepo}
				onSubmit={() => void lookUp()}
				submitEnabled={ready}
				placeholder="unsloth/Qwen3.5-2B-GGUF"
				monospace
				testId="local-models-add-hf-repo"
			/>
			<FormInput
				theme={theme}
				label="File name"
				value={file}
				onChange={editFile}
				onSubmit={() => void lookUp()}
				submitEnabled={ready}
				placeholder="Qwen3.5-2B-Q4_K_M.gguf"
				helperText="One part of a split GGUF adds every part."
				monospace
				testId="local-models-add-hf-file"
			/>

			{entry && (
				<div
					className="rounded border p-3 space-y-1 text-xs select-text"
					style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgActivity }}
					data-testid="local-models-add-hf-preview"
				>
					<div className="flex flex-wrap items-center gap-1.5">
						<span className="font-medium text-sm" style={{ color: theme.colors.textMain }}>
							{entry.displayName}
						</span>
						<MiniBadge
							theme={theme}
							label={USER_MODEL_UNVERIFIED_LABEL}
							color={theme.colors.warning}
							title={USER_MODEL_UNVERIFIED_DETAIL}
						/>
					</div>
					<div>
						License:{' '}
						<a
							href={entry.license.url}
							target="_blank"
							rel="noreferrer"
							style={{ color: theme.colors.accent }}
							data-testid="local-models-add-hf-license"
						>
							{entry.license.spdx}
						</a>
					</div>
					<div className="opacity-70">
						{formatSize(entry.bytes)} in{' '}
						{entry.files.length === 1 ? '1 file' : `${entry.files.length} files`} &middot;{' '}
						{entry.source.repo}@{entry.source.revision.slice(0, 7)}
					</div>
					{fit && (
						<div className="opacity-70" data-testid="local-models-add-hf-fit">
							{MODEL_FIT_LABELS[fit.fit]}: {fit.reason}
						</div>
					)}
					{preview.alreadyAdded && (
						<div style={{ color: theme.colors.warning }}>This model is already in the Library.</div>
					)}
				</div>
			)}

			{error && (
				<p
					className="text-xs select-text"
					style={{ color: theme.colors.error }}
					data-testid="local-models-add-hf-error"
				>
					{error}
				</p>
			)}
			{notice && (
				<p
					className="text-xs"
					style={{ color: theme.colors.success }}
					data-testid="local-models-add-hf-notice"
				>
					{notice}
				</p>
			)}

			<div className="flex flex-wrap gap-2">
				{(!preview || preview.alreadyAdded) && (
					<CardButton
						theme={theme}
						icon={Search}
						label={busy === 'lookup' ? 'Looking up...' : 'Look up'}
						disabled={!ready}
						onClick={() => void lookUp()}
						testId="local-models-add-hf-lookup"
					/>
				)}
				{preview && !preview.alreadyAdded && (
					<CardButton
						theme={theme}
						icon={Plus}
						label={busy === 'add' ? 'Adding...' : 'Add to Library'}
						disabled={busy !== null}
						primary
						onClick={() => void add()}
						testId="local-models-add-hf-add"
					/>
				)}
			</div>
		</SectionCard>
	);
}
