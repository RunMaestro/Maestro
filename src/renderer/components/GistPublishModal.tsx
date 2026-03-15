import { useRef, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Share2, Copy, Check, ExternalLink } from 'lucide-react';
import type { Theme } from '../types';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import { Modal } from './ui/Modal';
import { safeClipboardWrite } from '../utils/clipboard';
import { getActiveLocale } from '../utils/formatters';

export interface GistInfo {
	gistUrl: string;
	isPublic: boolean;
	publishedAt: number; // timestamp
}

interface GistPublishModalProps {
	theme: Theme;
	filename: string;
	content: string;
	onClose: () => void;
	onSuccess: (gistUrl: string, isPublic: boolean) => void;
	/** Existing gist info if the file was previously published */
	existingGist?: GistInfo;
}

/**
 * Modal for publishing a file as a GitHub Gist.
 * If the file was previously published, shows the existing URL with options to copy or re-publish.
 * Otherwise, offers three options: Publish Secret (default), Publish Public, or Cancel.
 */
export function GistPublishModal({
	theme,
	filename,
	content,
	onClose,
	onSuccess,
	existingGist,
}: GistPublishModalProps) {
	const { t } = useTranslation('modals');
	const secretButtonRef = useRef<HTMLButtonElement>(null);
	const copyButtonRef = useRef<HTMLButtonElement>(null);
	const [isPublishing, setIsPublishing] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [copied, setCopied] = useState(false);
	const [showRepublishOptions, setShowRepublishOptions] = useState(false);

	const handlePublish = useCallback(
		async (isPublic: boolean) => {
			setIsPublishing(true);
			setError(null);

			try {
				const result = await window.maestro.git.createGist(
					filename,
					content,
					'', // No description - file name serves as context
					isPublic
				);

				if (result.success && result.gistUrl) {
					onSuccess(result.gistUrl, isPublic);
					onClose();
				} else {
					setError(result.error || 'Failed to create gist');
					setIsPublishing(false);
				}
			} catch (err) {
				setError(err instanceof Error ? err.message : 'Failed to create gist');
				setIsPublishing(false);
			}
		},
		[filename, content, onSuccess, onClose]
	);

	const handlePublishSecret = useCallback(() => {
		handlePublish(false);
	}, [handlePublish]);

	const handlePublishPublic = useCallback(() => {
		handlePublish(true);
	}, [handlePublish]);

	const handleCopyUrl = useCallback(async () => {
		if (existingGist?.gistUrl) {
			const ok = await safeClipboardWrite(existingGist.gistUrl);
			if (ok) {
				setCopied(true);
				setTimeout(() => setCopied(false), 2000);
			}
		}
	}, [existingGist?.gistUrl]);

	const handleOpenGist = useCallback(() => {
		if (existingGist?.gistUrl) {
			window.maestro.shell.openExternal(existingGist.gistUrl);
		}
	}, [existingGist?.gistUrl]);

	const formatPublishedDate = (timestamp: number) => {
		const date = new Date(timestamp);
		return date.toLocaleDateString(getActiveLocale(), {
			year: 'numeric',
			month: 'short',
			day: 'numeric',
			hour: '2-digit',
			minute: '2-digit',
		});
	};

	// If there's an existing gist and we're not in republish mode, show the existing gist view
	if (existingGist && !showRepublishOptions) {
		return (
			<Modal
				theme={theme}
				title={t('gist_publish.published_title')}
				headerIcon={<Share2 className="w-4 h-4" style={{ color: theme.colors.accent }} />}
				priority={MODAL_PRIORITIES.GIST_PUBLISH}
				onClose={onClose}
				width={500}
				zIndex={10000}
				initialFocusRef={copyButtonRef}
				footer={
					<div className="flex items-center justify-between w-full">
						<button
							type="button"
							onClick={onClose}
							className="px-4 py-2 rounded border hover:bg-white/5 transition-colors outline-none focus:ring-2 focus:ring-offset-1 whitespace-nowrap text-sm"
							style={{
								borderColor: theme.colors.border,
								color: theme.colors.textMain,
							}}
						>
							{t('gist_publish.close_button')}
						</button>
						<div className="flex gap-2">
							<button
								type="button"
								onClick={() => setShowRepublishOptions(true)}
								className="px-4 py-2 rounded border hover:bg-white/5 transition-colors outline-none focus:ring-2 focus:ring-offset-1 whitespace-nowrap text-sm"
								style={{
									borderColor: theme.colors.border,
									color: theme.colors.textMain,
								}}
							>
								{t('gist_publish.republish_button')}
							</button>
							<button
								ref={copyButtonRef}
								type="button"
								onClick={handleCopyUrl}
								className="px-4 py-2 rounded transition-colors outline-none focus:ring-2 focus:ring-offset-1 whitespace-nowrap text-sm flex items-center gap-2"
								style={{
									backgroundColor: theme.colors.accent,
									color: theme.colors.accentForeground,
								}}
							>
								{copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
								{copied ? t('gist_publish.copied_button') : t('gist_publish.copy_url_button')}
							</button>
						</div>
					</div>
				}
			>
				<div className="space-y-4">
					<p className="text-sm leading-relaxed" style={{ color: theme.colors.textMain }}>
						<span className="font-medium" style={{ color: theme.colors.accent }}>
							{filename}
						</span>{' '}
						{t('gist_publish.is_published_as', {
							visibility: existingGist.isPublic
								? t('gist_publish.visibility_public')
								: t('gist_publish.visibility_secret'),
						})}
					</p>

					{/* Gist URL with copy/open buttons */}
					<div
						className="flex items-center gap-2 p-3 rounded"
						style={{ backgroundColor: theme.colors.bgActivity }}
					>
						<input
							type="text"
							value={existingGist.gistUrl}
							readOnly
							className="flex-1 bg-transparent text-sm outline-none"
							style={{ color: theme.colors.textMain }}
							onClick={(e) => (e.target as HTMLInputElement).select()}
						/>
						<button
							type="button"
							onClick={handleCopyUrl}
							className="p-1.5 rounded hover:bg-white/10 transition-colors"
							style={{ color: copied ? theme.colors.success : theme.colors.textDim }}
							title={t('gist_publish.copy_url_tooltip')}
						>
							{copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
						</button>
						<button
							type="button"
							onClick={handleOpenGist}
							className="p-1.5 rounded hover:bg-white/10 transition-colors"
							style={{ color: theme.colors.textDim }}
							title={t('gist_publish.open_in_browser_tooltip')}
						>
							<ExternalLink className="w-4 h-4" />
						</button>
					</div>

					<p className="text-xs" style={{ color: theme.colors.textDim }}>
						{t('gist_publish.published_date', {
							date: formatPublishedDate(existingGist.publishedAt),
						})}
					</p>
				</div>
			</Modal>
		);
	}

	// Standard publish view (new publish or re-publish mode)
	return (
		<Modal
			theme={theme}
			title={
				showRepublishOptions ? t('gist_publish.republish_title') : t('gist_publish.publish_title')
			}
			headerIcon={<Share2 className="w-4 h-4" style={{ color: theme.colors.accent }} />}
			priority={MODAL_PRIORITIES.GIST_PUBLISH}
			onClose={onClose}
			width={450}
			zIndex={10000}
			initialFocusRef={secretButtonRef}
			footer={
				<div className="flex items-center justify-between w-full">
					<button
						type="button"
						onClick={showRepublishOptions ? () => setShowRepublishOptions(false) : onClose}
						disabled={isPublishing}
						className="px-4 py-2 rounded border hover:bg-white/5 transition-colors outline-none focus:ring-2 focus:ring-offset-1 whitespace-nowrap text-sm"
						style={{
							borderColor: theme.colors.border,
							color: theme.colors.textMain,
							opacity: isPublishing ? 0.5 : 1,
						}}
					>
						{showRepublishOptions ? t('gist_publish.back_button') : t('gist_publish.cancel_button')}
					</button>
					<div className="flex gap-2">
						<button
							type="button"
							onClick={handlePublishPublic}
							disabled={isPublishing}
							className="px-4 py-2 rounded border hover:bg-white/5 transition-colors outline-none focus:ring-2 focus:ring-offset-1 whitespace-nowrap text-sm"
							style={{
								borderColor: theme.colors.border,
								color: theme.colors.textMain,
								opacity: isPublishing ? 0.5 : 1,
							}}
						>
							{t('gist_publish.publish_public_button')}
						</button>
						<button
							ref={secretButtonRef}
							type="button"
							onClick={handlePublishSecret}
							disabled={isPublishing}
							className="px-4 py-2 rounded transition-colors outline-none focus:ring-2 focus:ring-offset-1 whitespace-nowrap text-sm"
							style={{
								backgroundColor: theme.colors.accent,
								color: theme.colors.accentForeground,
								opacity: isPublishing ? 0.5 : 1,
							}}
						>
							{isPublishing
								? t('gist_publish.publishing_button')
								: t('gist_publish.publish_secret_button')}
						</button>
					</div>
				</div>
			}
		>
			<div className="space-y-4">
				<p className="text-sm leading-relaxed" style={{ color: theme.colors.textMain }}>
					{showRepublishOptions
						? t('gist_publish.republish_prompt_prefix')
						: t('gist_publish.publish_prefix')}
					<span className="font-medium" style={{ color: theme.colors.accent }}>
						{filename}
					</span>
					{showRepublishOptions
						? t('gist_publish.republish_prompt_suffix')
						: ' ' + t('gist_publish.publish_prompt')}
				</p>

				{showRepublishOptions && (
					<p className="text-xs" style={{ color: theme.colors.warning }}>
						{t('gist_publish.republish_warning')}
					</p>
				)}

				<div className="text-xs space-y-2" style={{ color: theme.colors.textDim }}>
					<p>
						<span className="font-medium" style={{ color: theme.colors.textMain }}>
							{t('gist_publish.secret_label')}
						</span>{' '}
						{t('gist_publish.secret_desc')}
					</p>
					<p>
						<span className="font-medium" style={{ color: theme.colors.textMain }}>
							{t('gist_publish.public_label')}
						</span>{' '}
						{t('gist_publish.public_desc')}
					</p>
				</div>

				{error && (
					<div
						className="px-3 py-2 rounded text-sm"
						style={{
							backgroundColor: `${theme.colors.error}20`,
							color: theme.colors.error,
						}}
					>
						{error}
					</div>
				)}
			</div>
		</Modal>
	);
}
