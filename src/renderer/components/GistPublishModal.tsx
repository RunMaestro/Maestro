import React, { useRef, useState, useCallback } from 'react';
import { Share2, Copy, Check, ExternalLink } from 'lucide-react';
import type { Theme } from '../types';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import { Modal } from './ui/Modal';

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

	const handleCopyUrl = useCallback(() => {
		if (existingGist?.gistUrl) {
			navigator.clipboard.writeText(existingGist.gistUrl);
			setCopied(true);
			setTimeout(() => setCopied(false), 2000);
		}
	}, [existingGist?.gistUrl]);

	const handleOpenGist = useCallback(() => {
		if (existingGist?.gistUrl) {
			window.maestro.shell.openExternal(existingGist.gistUrl);
		}
	}, [existingGist?.gistUrl]);

	const formatPublishedDate = (timestamp: number) => {
		const date = new Date(timestamp);
		return date.toLocaleDateString(undefined, {
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
				title="Published Gist"
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
							Close
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
								Re-publish
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
								{copied ? 'Copied!' : 'Copy URL'}
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
						is published as a {existingGist.isPublic ? 'public' : 'secret'} gist.
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
							title="Copy URL"
						>
							{copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
						</button>
						<button
							type="button"
							onClick={handleOpenGist}
							className="p-1.5 rounded hover:bg-white/10 transition-colors"
							style={{ color: theme.colors.textDim }}
							title="Open in browser"
						>
							<ExternalLink className="w-4 h-4" />
						</button>
					</div>

					<p className="text-xs" style={{ color: theme.colors.textDim }}>
						Published {formatPublishedDate(existingGist.publishedAt)}
					</p>
				</div>
			</Modal>
		);
	}

	// Standard publish view (new publish or re-publish mode)
	return (
		<Modal
			theme={theme}
			title={showRepublishOptions ? 'Re-publish as GitHub Gist' : 'Publish as GitHub Gist'}
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
						{showRepublishOptions ? 'Back' : 'Cancel'}
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
							Publish Public
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
							{isPublishing ? 'Publishing...' : 'Publish Secret'}
						</button>
					</div>
				</div>
			}
		>
			<div className="space-y-4">
				<p className="text-sm leading-relaxed" style={{ color: theme.colors.textMain }}>
					{showRepublishOptions ? 'Create a new gist for ' : 'Publish '}
					<span className="font-medium" style={{ color: theme.colors.accent }}>
						{filename}
					</span>
					{showRepublishOptions ? '?' : ' as a GitHub Gist?'}
				</p>

				{showRepublishOptions && (
					<p className="text-xs" style={{ color: theme.colors.warning }}>
						This will create a new gist. The existing gist URL will be replaced.
					</p>
				)}

				<div className="text-xs space-y-2" style={{ color: theme.colors.textDim }}>
					<p>
						<span className="font-medium" style={{ color: theme.colors.textMain }}>
							Secret:
						</span>{' '}
						Not searchable, only accessible via direct link
					</p>
					<p>
						<span className="font-medium" style={{ color: theme.colors.textMain }}>
							Public:
						</span>{' '}
						Visible on your public profile and searchable
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
