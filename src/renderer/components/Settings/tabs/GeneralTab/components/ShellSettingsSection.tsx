import type { CSSProperties } from 'react';
import { Check, ChevronDown, Terminal } from 'lucide-react';
import type { Theme } from '../../../../../types';
import type { ShellSettingsState } from '../types';

interface ShellSettingsSectionProps {
	theme: Theme;
	defaultShell: string;
	setCustomShellPath: (path: string) => void;
	customShellPath: string;
	setShellArgs: (args: string) => void;
	shellArgs: string;
	shellState: ShellSettingsState;
}

export function ShellSettingsSection({
	theme,
	defaultShell,
	setCustomShellPath,
	customShellPath,
	setShellArgs,
	shellArgs,
	shellState,
}: ShellSettingsSectionProps) {
	const {
		shells,
		shellsLoading,
		shellsLoaded,
		shellConfigExpanded,
		setShellConfigExpanded,
		handleShellInteraction,
		selectShell,
	} = shellState;

	return (
		<div data-setting-id="general-default-shell">
			<div className="block text-xs font-bold opacity-70 uppercase mb-1 flex items-center gap-2">
				<Terminal className="w-3 h-3" />
				Default Terminal Shell
			</div>
			<p className="text-xs opacity-50 mb-2">
				Choose which shell to use for terminal sessions. Select any shell and configure a custom
				path if needed.
			</p>
			{shellsLoading ? (
				<div className="text-sm opacity-50 p-2">Loading shells...</div>
			) : (
				<div className="space-y-2">
					{shellsLoaded && shells.length > 0 ? (
						shells.map((shell) => (
							<button
								key={shell.id}
								onClick={() => selectShell(shell)}
								onMouseEnter={handleShellInteraction}
								onFocus={handleShellInteraction}
								className={`w-full text-left p-3 rounded border transition-all ${
									defaultShell === shell.id ? 'ring-2' : ''
								} hover:bg-opacity-10`}
								style={
									{
										borderColor: theme.colors.border,
										backgroundColor:
											defaultShell === shell.id ? theme.colors.accentDim : theme.colors.bgMain,
										'--tw-ring-color': theme.colors.accent,
										color: theme.colors.textMain,
									} as CSSProperties
								}
							>
								<div className="flex items-center justify-between">
									<div>
										<div className="font-medium">{shell.name}</div>
										{shell.path && (
											<div className="text-xs opacity-50 font-mono mt-1">{shell.path}</div>
										)}
									</div>
									{shell.available ? (
										defaultShell === shell.id ? (
											<Check className="w-4 h-4" style={{ color: theme.colors.accent }} />
										) : (
											<span
												className="text-xs px-2 py-0.5 rounded"
												style={{
													backgroundColor: theme.colors.success + '20',
													color: theme.colors.success,
												}}
											>
												Available
											</span>
										)
									) : defaultShell === shell.id ? (
										<div className="flex items-center gap-2">
											<span
												className="text-xs px-2 py-0.5 rounded"
												style={{
													backgroundColor: theme.colors.warning + '20',
													color: theme.colors.warning,
												}}
											>
												Custom Path Required
											</span>
											<Check className="w-4 h-4" style={{ color: theme.colors.accent }} />
										</div>
									) : (
										<span
											className="text-xs px-2 py-0.5 rounded"
											style={{
												backgroundColor: theme.colors.warning + '20',
												color: theme.colors.warning,
											}}
										>
											Not Found
										</span>
									)}
								</div>
							</button>
						))
					) : (
						<div className="space-y-2">
							<button
								className="w-full text-left p-3 rounded border ring-2"
								style={
									{
										borderColor: theme.colors.border,
										backgroundColor: theme.colors.accentDim,
										'--tw-ring-color': theme.colors.accent,
										color: theme.colors.textMain,
									} as CSSProperties
								}
							>
								<div className="flex items-center justify-between">
									<div>
										<div className="font-medium">
											{defaultShell.charAt(0).toUpperCase() + defaultShell.slice(1)}
										</div>
										<div className="text-xs opacity-50 font-mono mt-1">Current default</div>
									</div>
									<Check className="w-4 h-4" style={{ color: theme.colors.accent }} />
								</div>
							</button>
							<button
								onClick={handleShellInteraction}
								className="w-full text-left p-3 rounded border hover:bg-white/5 transition-colors"
								style={{
									borderColor: theme.colors.border,
									backgroundColor: theme.colors.bgMain,
									color: theme.colors.textDim,
								}}
							>
								<div className="flex items-center gap-2">
									<Terminal className="w-4 h-4" />
									<span>Detect other available shells...</span>
								</div>
							</button>
						</div>
					)}
				</div>
			)}

			<button
				onClick={() => setShellConfigExpanded(!shellConfigExpanded)}
				className="w-full flex items-center justify-between p-3 rounded border mt-3 hover:bg-white/5 transition-colors"
				style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgMain }}
			>
				<span className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
					Shell Configuration
				</span>
				<ChevronDown
					className={`w-4 h-4 transition-transform ${shellConfigExpanded ? 'rotate-180' : ''}`}
					style={{ color: theme.colors.textDim }}
				/>
			</button>

			{shellConfigExpanded && (
				<div
					className="mt-2 space-y-3 p-3 rounded border"
					style={{
						borderColor: theme.colors.border,
						backgroundColor: theme.colors.bgMain,
					}}
				>
					<div>
						<div className="block text-xs opacity-60 mb-1">Custom Path (optional)</div>
						<div className="flex gap-2">
							<input
								type="text"
								value={customShellPath}
								onChange={(e) => setCustomShellPath(e.target.value)}
								placeholder="/path/to/shell"
								className="flex-1 p-2 rounded border bg-transparent outline-none text-sm font-mono"
								style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
							/>
							{customShellPath && (
								<button
									onClick={() => setCustomShellPath('')}
									className="px-2 py-1.5 rounded text-xs"
									style={{
										backgroundColor: theme.colors.bgMain,
										color: theme.colors.textDim,
									}}
								>
									Clear
								</button>
							)}
						</div>
						<p className="text-xs opacity-50 mt-1">
							Override the auto-detected shell path. Leave empty to use the detected path.
						</p>
					</div>

					<div>
						<div className="block text-xs opacity-60 mb-1">Additional Arguments (optional)</div>
						<div className="flex gap-2">
							<input
								type="text"
								value={shellArgs}
								onChange={(e) => setShellArgs(e.target.value)}
								placeholder="--flag value"
								className="flex-1 p-2 rounded border bg-transparent outline-none text-sm font-mono"
								style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
							/>
							{shellArgs && (
								<button
									onClick={() => setShellArgs('')}
									className="px-2 py-1.5 rounded text-xs"
									style={{
										backgroundColor: theme.colors.bgMain,
										color: theme.colors.textDim,
									}}
								>
									Clear
								</button>
							)}
						</div>
						<p className="text-xs opacity-50 mt-1">
							Additional CLI arguments passed to every shell session (e.g., --login, -c).
						</p>
					</div>
				</div>
			)}
		</div>
	);
}
