import { Check, Key, Timer, X } from 'lucide-react';
import type { Theme } from '../../../../../types';
import type { WakatimeSettingsState } from '../types';

interface WakatimeSettingsProps {
	theme: Theme;
	wakatimeEnabled: boolean;
	setWakatimeEnabled: (enabled: boolean) => void;
	wakatimeApiKey: string;
	wakatimeDetailedTracking: boolean;
	setWakatimeDetailedTracking: (enabled: boolean) => void;
	wakatimeState: WakatimeSettingsState;
}

export function WakatimeSettings({
	theme,
	wakatimeEnabled,
	setWakatimeEnabled,
	wakatimeApiKey,
	wakatimeDetailedTracking,
	setWakatimeDetailedTracking,
	wakatimeState,
}: WakatimeSettingsProps) {
	return (
		<>
			<div className="flex items-center justify-between">
				<div>
					<p className="text-sm flex items-center gap-2" style={{ color: theme.colors.textMain }}>
						<Timer className="w-3.5 h-3.5 opacity-60" />
						Enable WakaTime tracking
					</p>
					<p className="text-xs opacity-50 mt-0.5">
						Track coding activity in Maestro sessions via WakaTime.
					</p>
				</div>
				<button
					onClick={() => setWakatimeEnabled(!wakatimeEnabled)}
					className="relative w-10 h-5 rounded-full transition-colors"
					style={{
						backgroundColor: wakatimeEnabled ? theme.colors.accent : theme.colors.bgActivity,
					}}
					role="switch"
					aria-checked={wakatimeEnabled}
					aria-label="Enable WakaTime tracking"
				>
					<span
						className={`absolute left-0 top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
							wakatimeEnabled ? 'translate-x-5' : 'translate-x-0.5'
						}`}
					/>
				</button>
			</div>

			{wakatimeEnabled &&
				wakatimeState.wakatimeCliStatus &&
				!wakatimeState.wakatimeCliStatus.available && (
					<p className="text-xs mt-1" style={{ color: theme.colors.warning }}>
						WakaTime CLI is being installed automatically...
					</p>
				)}

			{wakatimeEnabled && (
				<div className="flex items-center justify-between">
					<div>
						<p className="text-sm" style={{ color: theme.colors.textMain }}>
							Detailed file tracking
						</p>
						<p className="text-xs opacity-50 mt-0.5">
							Track per-file write activity. Sends file paths (not content) to WakaTime.
						</p>
					</div>
					<button
						onClick={() => setWakatimeDetailedTracking(!wakatimeDetailedTracking)}
						className="relative w-10 h-5 rounded-full transition-colors flex-shrink-0 outline-none"
						tabIndex={0}
						style={{
							backgroundColor: wakatimeDetailedTracking
								? theme.colors.accent
								: theme.colors.bgActivity,
						}}
						role="switch"
						aria-checked={wakatimeDetailedTracking}
						aria-label="Detailed file tracking"
					>
						<span
							className={`absolute left-0 top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
								wakatimeDetailedTracking ? 'translate-x-5' : 'translate-x-0.5'
							}`}
						/>
					</button>
				</div>
			)}

			{wakatimeEnabled && (
				<div>
					<label htmlFor="wakatime-api-key" className="block text-xs opacity-60 mb-1">
						API Key
					</label>
					<div
						className="flex items-center border rounded px-3 py-2"
						style={{
							backgroundColor: theme.colors.bgMain,
							borderColor: theme.colors.border,
						}}
					>
						<Key className="w-4 h-4 mr-2 opacity-50" />
						<input
							id="wakatime-api-key"
							type="password"
							value={wakatimeApiKey}
							onChange={(event) => wakatimeState.handleWakatimeApiKeyChange(event.target.value)}
							onBlur={wakatimeState.validateWakatimeApiKey}
							className="bg-transparent flex-1 text-sm outline-none"
							style={{ color: theme.colors.textMain }}
							placeholder="waka_..."
						/>
						{wakatimeState.wakatimeKeyValidating && (
							<span className="ml-2 text-xs opacity-50">...</span>
						)}
						{!wakatimeState.wakatimeKeyValidating && wakatimeState.wakatimeKeyValid === true && (
							<Check className="w-4 h-4 ml-2" style={{ color: theme.colors.success }} />
						)}
						{wakatimeApiKey && (
							<button
								type="button"
								aria-label="Clear WakaTime API key"
								onClick={() => wakatimeState.handleWakatimeApiKeyChange('')}
								className="ml-2 opacity-50 hover:opacity-100"
								title="Clear API key"
								style={
									!wakatimeState.wakatimeKeyValidating && wakatimeState.wakatimeKeyValid === false
										? { color: theme.colors.error, opacity: 1 }
										: undefined
								}
							>
								<X className="w-3 h-3" />
							</button>
						)}
					</div>
					<p className="text-[10px] mt-1.5 opacity-50">
						Get your API key from wakatime.com/settings/api-key. Keys are stored locally in
						~/.maestro/settings.json.
					</p>
				</div>
			)}
		</>
	);
}
