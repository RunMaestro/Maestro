/**
 * Strip ANSI escape sequences and OSC (Operating System Command) sequences from a string.
 *
 * This handles:
 * - Standard ANSI escape sequences (colors, cursor movement, etc.)
 * - OSC sequences like iTerm2 shell integration (]1337;...)
 * - Other terminal control sequences
 *
 * This is necessary when running commands via SSH with interactive shells (-i flag),
 * as the remote shell's .bashrc/.zshrc may emit shell integration escape sequences.
 */

// Match ANSI escape sequences: ESC[ followed by parameters and a letter
const ANSI_ESCAPE_PATTERN = /\x1b\[[0-9;]*[a-zA-Z]/g;

// Match OSC sequences: ESC] followed by content until BEL (\x07) or ST (ESC\)
// This handles iTerm2 shell integration sequences like ]1337;RemoteHost=...
const OSC_PATTERN = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g;

// Match iTerm2 shell integration sequences without ESC prefix
// Format: ]1337;Key=Value where Key is one of: RemoteHost, CurrentDir, ShellIntegrationVersion, etc.
// Real example: ]1337;RemoteHost=user@host]1337;CurrentDir=/home]1337;ShellIntegrationVersion=13;shell=zsh
//
// The pattern matches sequences terminated by the next ] or BEL (\x07)
// For sequences that ARE followed by another ], the value can contain / (like CurrentDir=/Users/pedram)
// For the LAST sequence (not followed by ]), the value ends at the first /
const ITERM2_OSC_WITH_NEXT =
	/\]1337;(?:RemoteHost|CurrentDir|ShellIntegrationVersion|User|HostName|LocalPwd|FileInfo|Mark|Dir|ClearCapturedOutput|AddAnnotation|File|Copy|SetMark|StealFocus|SetBadge|ReportCellSize|ReportDirectory|ReportVariables|RequestAttention|SetBackgroundImageFile|SetHotstringEnd|SetKeyLabel|SetProfile|SetUserVar|SetPrecolorScheme|SetColors)=[^\]\x07]*(?=\])/g;

// Match the LAST sequence (followed by a path starting with /)
// This one can't contain / in its value since that would be ambiguous with the actual path output
const ITERM2_OSC_LAST =
	/\]1337;(?:ShellIntegrationVersion|RemoteHost|User|HostName|FileInfo|Mark|ClearCapturedOutput|AddAnnotation|File|Copy|SetMark|StealFocus|SetBadge|ReportCellSize|ReportDirectory|ReportVariables|RequestAttention|SetBackgroundImageFile|SetHotstringEnd|SetKeyLabel|SetProfile|SetUserVar|SetPrecolorScheme|SetColors)=[^\]\x07/]*(?=\/)/g;

// Match bare OSC sequences terminated by BEL (\x07) - no ESC prefix
// This handles sequences like ]1337;CurrentDir=/home/user\x07
const BARE_OSC_WITH_BEL = /\]1337;[^\x07]*\x07/g;

/**
 * Strip all ANSI and OSC escape sequences from a string.
 * @param str - The string potentially containing escape sequences
 * @returns The cleaned string with escape sequences removed
 */
export function stripAnsi(str: string): string {
	return str
		.replace(OSC_PATTERN, '')
		.replace(BARE_OSC_WITH_BEL, '')
		.replace(ITERM2_OSC_WITH_NEXT, '')
		.replace(ITERM2_OSC_LAST, '')
		.replace(ANSI_ESCAPE_PATTERN, '');
}
