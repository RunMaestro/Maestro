import { useMemo } from 'react';
import { MermaidRenderer } from '../../../../MermaidRenderer';
import type { Theme } from '../../../../../types';
import { useSettingsStore } from '../../../../../stores/settingsStore';
import { createMarkdownComponents, generateProseStyles } from '../../../../../utils/markdownConfig';
import { openUrl } from '../../../../../utils/openUrl';
import { MarkdownImage } from '../components/MarkdownImage';

interface UseMarkdownPreviewArgs {
	folderPath: string;
	proseClassPrefix: string;
	theme: Theme;
}

export function useMarkdownPreview({
	folderPath,
	proseClassPrefix,
	theme,
}: UseMarkdownPreviewArgs) {
	const bionifyReadingMode = useSettingsStore((state) => state.bionifyReadingMode);

	const proseStyles = useMemo(
		() =>
			generateProseStyles({
				theme,
				coloredHeadings: true,
				compactSpacing: false,
				includeCheckboxStyles: true,
				scopeSelector: `.${proseClassPrefix}`,
			}),
		[theme, proseClassPrefix]
	);

	const imageRenderer = useMemo(() => {
		return function WizardImage({ src, alt }: { src?: string; alt?: string }) {
			return <MarkdownImage src={src} alt={alt} folderPath={folderPath} theme={theme} />;
		};
	}, [folderPath, theme]);

	const mermaidRenderer = useMemo(() => {
		return function Mermaid({ code }: { code: string }) {
			return <MermaidRenderer chart={code} theme={theme} />;
		};
	}, [theme]);

	const markdownComponents = useMemo(
		() =>
			createMarkdownComponents({
				theme,
				enableBionifyReadingMode: bionifyReadingMode,
				imageRenderer,
				customLanguageRenderers: {
					mermaid: mermaidRenderer,
				},
				onExternalLinkClick: (href, opts) => openUrl(href, opts),
			}),
		[bionifyReadingMode, theme, imageRenderer, mermaidRenderer]
	);

	return {
		proseStyles,
		markdownComponents,
	};
}
