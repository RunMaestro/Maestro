import { FileText } from 'lucide-react';
import type { Theme } from '../../../../../types';
import {
	FILE_PREVIEW_TOOLBAR_BUTTON_KEYS,
	type FilePreviewToolbarButton,
	type FilePreviewToolbarVisibility,
} from '../../../../../stores/settingsStore';
import { SettingsSectionHeading } from '../../../SettingsSectionHeading';
import { TOOLBAR_BUTTON_LABELS } from '../utils';
import { SectionCard } from './SectionCard';
import { ToggleSettingRow } from './ToggleSettingRow';

interface FileEditPreviewSectionProps {
	theme: Theme;
	fileEditShowLineNumbers: boolean;
	setFileEditShowLineNumbers: (enabled: boolean) => void;
	fileEditWordWrap: boolean;
	setFileEditWordWrap: (enabled: boolean) => void;
	filePreviewToolbarVisibility: FilePreviewToolbarVisibility;
	setFilePreviewToolbarButtonVisibility: (
		button: FilePreviewToolbarButton,
		visible: boolean
	) => void;
}

export function FileEditPreviewSection({
	theme,
	fileEditShowLineNumbers,
	setFileEditShowLineNumbers,
	fileEditWordWrap,
	setFileEditWordWrap,
	filePreviewToolbarVisibility,
	setFilePreviewToolbarButtonVisibility,
}: FileEditPreviewSectionProps) {
	return (
		<div data-setting-id="display-file-edit-preview">
			<SettingsSectionHeading icon={FileText}>File Edit &amp; Preview</SettingsSectionHeading>
			<SectionCard theme={theme}>
				<ToggleSettingRow
					theme={theme}
					title="Show line numbers in the editor"
					description="Render a line-number gutter on the left edge of the file editor. Right-clicking a line copies a maestro:// deep link to that line."
					checked={fileEditShowLineNumbers}
					onChange={setFileEditShowLineNumbers}
					ariaLabel="Show line numbers in the editor"
				/>
				<ToggleSettingRow
					theme={theme}
					title="Wrap long lines in the editor"
					description="When on, long lines wrap at whitespace. When off, the editor scrolls horizontally. Toggle live from the editor toolbar."
					checked={fileEditWordWrap}
					onChange={setFileEditWordWrap}
					ariaLabel="Wrap long lines in the editor"
					borderTop
				/>

				<div className="pt-3 border-t" style={{ borderColor: theme.colors.border }}>
					<p className="text-sm" style={{ color: theme.colors.textMain }}>
						Toolbar buttons
					</p>
					<p className="text-xs opacity-50 mt-0.5">
						Hide buttons you never use. Hidden actions stay reachable via command palette and
						keyboard shortcuts.
					</p>
					<div className="grid grid-cols-2 gap-2 mt-3">
						{FILE_PREVIEW_TOOLBAR_BUTTON_KEYS.map((key) => {
							const label = TOOLBAR_BUTTON_LABELS[key];
							const enabled = filePreviewToolbarVisibility[key];
							return (
								<label
									key={key}
									className="flex items-center justify-between gap-2 px-2 py-1 rounded cursor-pointer hover:bg-white/5 transition-colors"
								>
									<span className="text-xs" style={{ color: theme.colors.textMain }}>
										{label}
									</span>
									<button
										type="button"
										onClick={() => setFilePreviewToolbarButtonVisibility(key, !enabled)}
										className="relative w-8 h-4 rounded-full transition-colors flex-shrink-0 outline-none"
										tabIndex={0}
										style={{
											backgroundColor: enabled ? theme.colors.accent : theme.colors.bgActivity,
										}}
										role="switch"
										aria-checked={enabled}
										aria-label={`Show ${label} button`}
									>
										<span
											className={`absolute left-0 top-0.5 w-3 h-3 rounded-full bg-white transition-transform ${
												enabled ? 'translate-x-4' : 'translate-x-0.5'
											}`}
										/>
									</button>
								</label>
							);
						})}
					</div>
				</div>
			</SectionCard>
		</div>
	);
}
