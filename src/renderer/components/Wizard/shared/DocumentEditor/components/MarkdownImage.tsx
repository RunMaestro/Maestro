import { useEffect, useRef, useState } from 'react';
import { Spinner } from '../../../../ui/Spinner';
import type { Theme } from '../../../../../types';
import { captureException } from '../../../../../utils/sentry';

interface MarkdownImageProps {
	src?: string;
	alt?: string;
	folderPath?: string;
	theme: Theme;
}

function isExpectedImageLoadError(err: unknown): boolean {
	const message = err instanceof Error ? err.message : String(err ?? '');
	return /enoent|not found|no such file|missing|invalid image/i.test(message);
}

export function MarkdownImage({
	src,
	alt,
	folderPath,
	theme,
}: MarkdownImageProps): JSX.Element | null {
	const [dataUrl, setDataUrl] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const requestIdRef = useRef(0);

	useEffect(() => {
		const requestId = ++requestIdRef.current;
		const isCurrentRequest = () => requestIdRef.current === requestId;

		setDataUrl(null);
		setError(null);

		if (!src) {
			setLoading(false);
			return () => {
				if (requestIdRef.current === requestId) {
					requestIdRef.current += 1;
				}
			};
		}

		if (src.startsWith('images/') && folderPath) {
			setLoading(true);
			const absolutePath = `${folderPath}/${src}`;
			window.maestro.fs
				.readFile(absolutePath)
				.then((result) => {
					if (!isCurrentRequest()) return;

					if (result && result.startsWith('data:')) {
						setDataUrl(result);
					} else {
						setError('Invalid image data');
					}
					setLoading(false);
				})
				.catch((err: unknown) => {
					if (!isCurrentRequest()) return;

					const error = err instanceof Error ? err : new Error(String(err));
					setError(`Failed to load: ${error.message}`);
					setLoading(false);
					if (!isExpectedImageLoadError(error)) {
						captureException(error, {
							extra: {
								context: 'MarkdownImage.readFile',
								src,
								folderPath,
								absolutePath,
							},
						});
					}
				});
		} else if (src.startsWith('data:') || src.startsWith('http')) {
			setDataUrl(src);
			setLoading(false);
		} else {
			setLoading(false);
		}

		return () => {
			if (requestIdRef.current === requestId) {
				requestIdRef.current += 1;
			}
		};
	}, [src, folderPath]);

	if (loading) {
		return (
			<span
				className="inline-flex items-center gap-2 px-3 py-2 rounded"
				style={{ backgroundColor: theme.colors.bgActivity }}
			>
				<Spinner size={16} color={theme.colors.textDim} />
				<span className="text-xs" style={{ color: theme.colors.textDim }}>
					Loading...
				</span>
			</span>
		);
	}

	if (error || !dataUrl) {
		return null;
	}

	return (
		<img
			src={dataUrl}
			alt={alt || ''}
			className="rounded border my-2"
			style={{
				maxHeight: '200px',
				maxWidth: '100%',
				objectFit: 'contain',
				borderColor: theme.colors.border,
			}}
		/>
	);
}
