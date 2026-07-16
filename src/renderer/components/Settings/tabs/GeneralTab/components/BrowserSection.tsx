import { ExternalLink } from 'lucide-react';
import type { Theme } from '../../../../../types';
import { SettingCheckbox } from '../../../../SettingCheckbox';
import { ToggleButtonGroup } from '../../../../ToggleButtonGroup';
import { ToggleSettingRow } from '../../DisplayTab/components/ToggleSettingRow';
import { DEFAULT_BROWSER_HOME_URL } from '../utils';

type BrowserKeepAliveMode = 'off' | 'recent' | 'all';

interface BrowserSectionProps {
	theme: Theme;
	useSystemBrowser: boolean;
	setUseSystemBrowser: (enabled: boolean) => void;
	browserHomeUrl: string;
	setBrowserHomeUrl: (url: string) => void;
	htmlDoubleClickOpensInBrowser: boolean;
	setHtmlDoubleClickOpensInBrowser: (enabled: boolean) => void;
	browserTabKeepAlive: BrowserKeepAliveMode;
	setBrowserTabKeepAlive: (mode: BrowserKeepAliveMode) => void;
	browserTabKeepAliveLimit: number;
	setBrowserTabKeepAliveLimit: (limit: number) => void;
}

export function BrowserSection({
	theme,
	useSystemBrowser,
	setUseSystemBrowser,
	browserHomeUrl,
	setBrowserHomeUrl,
	htmlDoubleClickOpensInBrowser,
	setHtmlDoubleClickOpensInBrowser,
	browserTabKeepAlive,
	setBrowserTabKeepAlive,
	browserTabKeepAliveLimit,
	setBrowserTabKeepAliveLimit,
}: BrowserSectionProps) {
	return (
		<div data-setting-id="general-browser">
			<SettingCheckbox
				icon={ExternalLink}
				sectionLabel="Default Browser"
				title="Use system browser for links"
				description="Controls the default browser for clicking links. Use Ctrl+Click on URLs to get a context menu and choose the specific browser."
				checked={useSystemBrowser}
				onChange={setUseSystemBrowser}
				theme={theme}
			/>
			<ToggleSettingRow
				theme={theme}
				title={
					<span className="font-medium" style={{ color: theme.colors.textMain }}>
						Open HTML files in Maestro Browser on double-click
					</span>
				}
				description={
					<span style={{ color: theme.colors.textDim }}>
						When enabled, double-clicking an HTML file in the file explorer opens it in the Maestro
						browser instead of the file preview. Right-click for the full menu either way.
					</span>
				}
				checked={htmlDoubleClickOpensInBrowser}
				onChange={setHtmlDoubleClickOpensInBrowser}
				ariaLabel="Open HTML files in Maestro Browser on double-click"
				clickableRow
				dataSettingId="general-html-double-click"
				className="mt-3 p-3 rounded border hover:bg-opacity-10"
			/>
			<div
				className="mt-3 p-3 rounded border"
				style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgMain }}
			>
				<div className="block text-xs opacity-60 mb-1">Browser Home URL</div>
				<div className="flex gap-2">
					<input
						type="text"
						value={browserHomeUrl}
						onChange={(e) => setBrowserHomeUrl(e.target.value)}
						placeholder={DEFAULT_BROWSER_HOME_URL}
						className="flex-1 p-1.5 rounded border bg-transparent outline-none text-xs font-mono"
						style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
					/>
					{browserHomeUrl !== DEFAULT_BROWSER_HOME_URL && (
						<button
							onClick={() => setBrowserHomeUrl(DEFAULT_BROWSER_HOME_URL)}
							className="px-2 py-1 rounded text-xs"
							style={{
								backgroundColor: theme.colors.bgActivity,
								color: theme.colors.textDim,
							}}
						>
							Reset
						</button>
					)}
				</div>
				<p className="text-xs opacity-40 mt-2">
					The URL loaded when opening a new browser tab (Cmd+B).
				</p>
			</div>
			<div
				data-setting-id="general-browser-keepalive"
				className="mt-3 p-3 rounded border"
				style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgMain }}
			>
				<div className="font-medium" style={{ color: theme.colors.textMain }}>
					Background browser tabs
				</div>
				<div className="text-xs opacity-50 mt-0.5 mb-2" style={{ color: theme.colors.textDim }}>
					An inactive browser tab is unloaded by default, so its page reloads and loses any
					in-memory state when you return. Keep recent or all tabs alive to preserve their state at
					the cost of memory (each live tab holds a full browser process).
				</div>
				<ToggleButtonGroup
					options={[
						{ value: 'off' as const, label: 'Unload when inactive' },
						{ value: 'recent' as const, label: 'Keep recent alive' },
						{ value: 'all' as const, label: 'Keep all alive' },
					]}
					value={browserTabKeepAlive}
					onChange={setBrowserTabKeepAlive}
					theme={theme}
				/>
				{browserTabKeepAlive === 'recent' && (
					<div className="mt-3 flex items-center gap-2">
						<label className="text-xs opacity-60" style={{ color: theme.colors.textDim }}>
							Keep this many recent tabs alive
						</label>
						<input
							type="number"
							min={1}
							max={100}
							value={browserTabKeepAliveLimit}
							onChange={(e) =>
								setBrowserTabKeepAliveLimit(
									Math.min(100, Math.max(1, parseInt(e.target.value, 10) || 1))
								)
							}
							className="w-20 p-1.5 rounded border bg-transparent outline-none text-xs"
							style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
						/>
					</div>
				)}
			</div>
		</div>
	);
}
