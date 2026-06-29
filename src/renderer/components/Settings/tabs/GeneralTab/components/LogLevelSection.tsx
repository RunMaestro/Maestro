import type { Theme } from '../../../../../types';
import { ToggleButtonGroup } from '../../../../ToggleButtonGroup';

interface LogLevelSectionProps {
	theme: Theme;
	logLevel: string;
	setLogLevel: (level: string) => void;
}

export function LogLevelSection({ theme, logLevel, setLogLevel }: LogLevelSectionProps) {
	return (
		<div data-setting-id="general-log-level">
			<div className="block text-xs font-bold opacity-70 uppercase mb-2">System Log Level</div>
			<ToggleButtonGroup
				options={[
					{ value: 'debug', label: 'Debug', activeColor: '#6366f1' },
					{ value: 'info', label: 'Info', activeColor: '#3b82f6' },
					{ value: 'warn', label: 'Warn', activeColor: '#f59e0b' },
					{ value: 'error', label: 'Error', activeColor: '#ef4444' },
				]}
				value={logLevel}
				onChange={setLogLevel}
				theme={theme}
			/>
			<p className="text-xs opacity-50 mt-2">
				Higher levels show fewer logs. Debug shows all logs, Error shows only errors.
			</p>
		</div>
	);
}
