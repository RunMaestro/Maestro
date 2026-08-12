import { ScrollText } from 'lucide-react';
import type { Theme } from '../../../../../types';
import { ToggleButtonGroup } from '../../../../ToggleButtonGroup';
import { SettingsSectionHeading } from '../../../SettingsSectionHeading';

interface LogLevelSectionProps {
	theme: Theme;
	logLevel: string;
	setLogLevel: (level: string) => void;
}

export function LogLevelSection({ theme, logLevel, setLogLevel }: LogLevelSectionProps) {
	return (
		<div data-setting-id="general-log-level">
			<SettingsSectionHeading icon={ScrollText}>System Log Level</SettingsSectionHeading>
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
			<p className="text-xs opacity-70 mt-2">
				Higher levels show fewer logs. Debug shows all logs, Error shows only errors.
			</p>
		</div>
	);
}
