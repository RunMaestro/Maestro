// Command examples - one registry of runnable invocations, keyed by command path.
//
// `--help` prints them under "Examples:" and `maestro-cli reference` lists them
// under each command, so an agent that asks a verb for help sees how to call it.
// src/__tests__/cli/command-tree.test.ts walks the live Commander tree and fails
// when a runnable command has no entry here, when an entry names a command that
// does not exist, and when an example uses a flag its command does not declare.
// A verb added without an example, or renamed without its example, fails there.
//
// The key is the command path without the program name ("models server start").
// Keep an example short and real: placeholders in angle brackets, one line each.

import type { Command } from 'commander';

export const COMMAND_EXAMPLES: Readonly<Record<string, readonly string[]>> = {
	// RC surfaces and the detached runtime host
	'throughput-gauge show': ['maestro-cli throughput-gauge show'],
	'throughput-gauge hide': ['maestro-cli throughput-gauge hide'],
	'throughput-gauge toggle': ['maestro-cli throughput-gauge toggle'],
	'throughput-gauge set': ['maestro-cli throughput-gauge set --metric out --style vu --window 10'],
	'throughput-gauge reset-peak': ['maestro-cli throughput-gauge reset-peak'],
	'throughput-gauge status': ['maestro-cli throughput-gauge status --json'],
	'host start': ['maestro-cli host start --dev'],
	'host status': ['maestro-cli host status --dev --json'],
	'host stop': ['maestro-cli host stop --dev --wait'],
	// Dataview commands introduced by RC also participate in the CLI help audit.
	'dataview query': ['maestro-cli dataview query <file> --agent <agent-id> --json'],
	'dataview eval': ['maestro-cli dataview eval <file> "LIST FROM #meeting" --json'],
	'dataview index status': ['maestro-cli dataview index status --json'],
	'dataview index rebuild': ['maestro-cli dataview index rebuild <vault-root>'],
	'dataview trust': ['maestro-cli dataview trust <vault-root>'],
	'dataview untrust': ['maestro-cli dataview untrust <vault-root>'],
	'dataview trusted': ['maestro-cli dataview trusted --json'],
	// RC queue steering, notifications and Quick Chat controls
	'queue hold': ['maestro-cli queue hold <item-id> --agent <agent-id>'],
	'queue resume': ['maestro-cli queue resume <item-id> --agent <agent-id>'],
	'queue merge': ['maestro-cli queue merge <item-id> --agent <agent-id>'],
	'group-chat steer': ['maestro-cli group-chat steer <chat> "Focus on the failing test"'],
	'steer-auto-run send': [
		'maestro-cli steer-auto-run send "Keep the public API unchanged" --agent <agent-id>',
	],
	'steer-auto-run list': ['maestro-cli steer-auto-run list --agent <agent-id>'],
	'steer-auto-run cancel': ['maestro-cli steer-auto-run cancel <note-id> --agent <agent-id>'],
	'quick-chat tab': ['maestro-cli quick-chat tab new'],
	'quick-chat thinking': ['maestro-cli quick-chat thinking sticky'],
	'quick-chat steer': ['maestro-cli quick-chat steer <message-id>'],
	'group-chat archive': [
		'maestro-cli group-chat archive <chat>',
		'maestro-cli group-chat archive <chat> --restore',
	],
	'quick-chat history': ['maestro-cli quick-chat history'],
	'quick-chat recall': ['maestro-cli quick-chat recall <chat>'],
	'notify inbox list': ['maestro-cli notify inbox list'],
	'notify inbox open': ['maestro-cli notify inbox open'],
	'notify inbox close': ['maestro-cli notify inbox close'],
	'notify inbox read-all': ['maestro-cli notify inbox read-all'],
	'notify inbox clear': ['maestro-cli notify inbox clear'],
	'notify inbox collapse': ['maestro-cli notify inbox collapse'],
	'notify inbox dismiss': ['maestro-cli notify inbox dismiss <id>'],
	'notify inbox read': ['maestro-cli notify inbox read <id>'],
	'notify inbox activate': ['maestro-cli notify inbox activate <id>'],
	'notify inbox link': ['maestro-cli notify inbox link <id>'],
	'notify inbox detail': ['maestro-cli notify inbox detail <id>'],

	// Agent runs and campaigns
	'agent-run record': ['maestro-cli agent-run record --file run.json'],
	'agent-run append-event': [
		'maestro-cli agent-run append-event <run-id> --type progress --message "Tests passed"',
	],
	'agent-run list': ['maestro-cli agent-run list --status running --limit 10 --json'],
	'agent-run show': ['maestro-cli agent-run show <run-id> --json'],
	'campaign record': ['maestro-cli campaign record --file campaign.json'],
	'campaign list': ['maestro-cli campaign list --limit 10 --json'],
	'campaign show': ['maestro-cli campaign show <campaign-id> --json'],

	// Read agents, groups, playbooks, sessions
	'list groups': ['maestro-cli list groups --json'],
	'list agents': ['maestro-cli list agents --group <group-id> --json'],
	'list playbooks': ['maestro-cli list playbooks --agent <agent-id>'],
	'list sessions': ['maestro-cli list sessions <agent-id> --limit 10 --search "auth"'],
	'list ssh-remotes': ['maestro-cli list ssh-remotes --json'],
	'list terminals': ['maestro-cli list terminals --agent <agent-id>'],
	'show agent': [
		'maestro-cli show agent <agent-id> --json',
		'maestro-cli show agent <agent-id> --show-secrets',
	],
	'show playbook': ['maestro-cli show playbook <playbook-id>'],

	// Run work
	playbook: [
		'maestro-cli playbook <playbook-id> --dry-run',
		'maestro-cli playbook <playbook-id> --wait --json',
	],
	'goal-run': [
		'maestro-cli goal-run <agent-id> "Make the build pass" --exit-criteria "npm test exits 0" --max-iterations 5',
	],
	'run-doc': ['maestro-cli run-doc ./tasks.md --agent <agent-id> --wait'],
	'clean playbooks': ['maestro-cli clean playbooks --dry-run'],
	send: [
		'maestro-cli send <agent-id> "Summarize the open TODOs" --json',
		'maestro-cli send <agent-id> "Now fix the first one" --session <session-id>',
		'maestro-cli send <agent-id> "Review the diff" --read-only',
	],
	dispatch: [
		'maestro-cli dispatch <agent-id> "Run the tests"',
		'maestro-cli dispatch <agent-id> "Start a review pass" --new-tab',
	],
	ask: ['maestro-cli ask <agent-id> "Which module owns retries?" --from <your-agent-id>'],

	// Execution queue
	'queue list': ['maestro-cli queue list --agent <agent-id>'],
	'queue remove': ['maestro-cli queue remove <item-id> --agent <agent-id>'],
	'queue steer': ['maestro-cli queue steer <item-id> --agent <agent-id>'],

	// Windows, snoozes, sessions
	'window list': ['maestro-cli window list'],
	'window move-agent': ['maestro-cli window move-agent <agent-id> --to new'],
	'window move-group': ['maestro-cli window move-group <group-id> --to main'],
	'snooze tab': [
		'maestro-cli snooze tab <tab-id> 2h --note "Check the deploy"',
		'maestro-cli snooze tab <tab-id> "tomorrow 9am" --wake-prompt "Continue where you left off"',
	],
	'snooze list': ['maestro-cli snooze list --agent <agent-id>'],
	'snooze wake': ['maestro-cli snooze wake <snooze-id>'],
	'snooze dismiss': ['maestro-cli snooze dismiss <snooze-id>'],
	'snooze reschedule': ['maestro-cli snooze reschedule <snooze-id> "next fri 3pm"'],
	'snooze history': ['maestro-cli snooze history --limit 20'],
	unsnooze: ['maestro-cli unsnooze <snooze-id>'],
	'session list': ['maestro-cli session list --json'],
	'session show': ['maestro-cli session show <tab-id> --tail 20'],

	// Group chat
	'group-chat start': [
		'maestro-cli group-chat start "API review" --participant <agent-id> --participant <agent-id> --message "Review the new endpoint"',
	],
	'group-chat send': ['maestro-cli group-chat send <chat> "Summarize where you landed"'],
	'group-chat status': ['maestro-cli group-chat status <chat> --tail 10'],
	'group-chat list': ['maestro-cli group-chat list --json'],
	'group-chat stop': ['maestro-cli group-chat stop <chat>'],

	// Open things in the desktop app
	'open-file': ['maestro-cli open-file ./README.md --agent <agent-id> --background'],
	'open-graph': ['maestro-cli open-graph ./docs --agent <agent-id>'],
	'open-browser': ['maestro-cli open-browser https://example.com --agent <agent-id> --background'],
	'close-browser': ['maestro-cli close-browser <tab-id>'],
	open: [
		'maestro-cli open --list',
		'maestro-cli open settings --tab models --sub-tab library',
		'maestro-cli open delegation-graph --group <group-id>',
		'maestro-cli open agent-settings --agent <agent-id> --tab peers',
	],
	'image list': ['maestro-cli image list --agent <agent-id> --limit 10'],
	'image save': ['maestro-cli image save latest --output ./screenshot.png'],
	'open-terminal': [
		'maestro-cli open-terminal --agent <agent-id> --name "Dev server" --command "npm run dev" --background',
	],
	'send-terminal': [
		'maestro-cli send-terminal --tab "Dev server" "npm run build"',
		'maestro-cli send-terminal --tab "Dev server" --control C',
	],
	'read-terminal': ['maestro-cli read-terminal --tab "Dev server" --tail 50'],
	'refresh-files': ['maestro-cli refresh-files --agent <agent-id>'],
	'refresh-auto-run': ['maestro-cli refresh-auto-run --agent <agent-id>'],

	// Auto Run
	'auto-run': [
		'maestro-cli auto-run ./phase-01.md ./phase-02.md --agent <agent-id> --launch',
		'maestro-cli auto-run ./phase-01.md --agent <agent-id> --save-as "Release prep"',
	],
	'stop-auto-run': ['maestro-cli stop-auto-run --agent <agent-id>'],
	'resume-auto-run': ['maestro-cli resume-auto-run --agent <agent-id>'],
	'skip-auto-run': ['maestro-cli skip-auto-run --agent <agent-id>'],
	'abort-auto-run': ['maestro-cli abort-auto-run --agent <agent-id>'],
	'reset-auto-run-tasks': ['maestro-cli reset-auto-run-tasks phase-01.md --agent <agent-id>'],
	'auto-run-status': ['maestro-cli auto-run-status --agent <agent-id> --json'],
	'auto-run-folder': ['maestro-cli auto-run-folder ~/playbooks --agent <agent-id>'],

	// Playbook Exchange
	'marketplace list': ['maestro-cli marketplace list --category testing --search "e2e"'],
	'marketplace show': ['maestro-cli marketplace show <playbook-id>'],
	'marketplace import': ['maestro-cli marketplace import <playbook-id> --agent <agent-id>'],
	'remove-playbook': ['maestro-cli remove-playbook <agent-id> <playbook-id>'],

	// Cue
	'cue trigger': ['maestro-cli cue trigger "Nightly review" --prompt "Focus on the auth module"'],
	'cue list': ['maestro-cli cue list --json'],
	'cue model': [
		'maestro-cli cue model "Nightly review" --tier high --effort low',
		'maestro-cli cue model "Nightly review" --clear-model',
	],
	'cue enable': ['maestro-cli cue enable "Nightly review" --agent <agent-id>'],
	'cue disable': ['maestro-cli cue disable "Nightly review" --agent <agent-id>'],
	'cue gate': [
		'maestro-cli cue gate "PR opened" --set "The PR touches the auth module" --on-unavailable skip',
		'maestro-cli cue gate "PR opened" --clear',
	],
	'cue screen': ['maestro-cli cue screen "PR opened" --mode on --threshold 0.8'],
	'cue activity': ['maestro-cli cue activity --agent <agent-id> --limit 20'],
	'cue schedule': [
		'maestro-cli cue schedule --in 20m --agent <agent-id> --prompt "Check the deploy status"',
		'maestro-cli cue schedule --daily-at 09:00 --days mon,tue,wed,thu,fri --agent <agent-id> --prompt "Draft the standup"',
		'maestro-cli cue schedule --list --kind daily',
	],
	'cue pipeline list': ['maestro-cli cue pipeline list --json'],
	'cue pipeline get': ['maestro-cli cue pipeline get "Nightly review" --json'],
	'cue pipeline export': ['maestro-cli cue pipeline export "Nightly review" > pipeline.json'],
	'cue pipeline add': ['maestro-cli cue pipeline add "Nightly review" --from pipeline.json'],
	'cue pipeline replace': [
		'maestro-cli cue pipeline replace "Nightly review" --from pipeline.json',
	],
	'cue pipeline remove': ['maestro-cli cue pipeline remove "Nightly review" --force'],
	'cue engine start': ['maestro-cli cue engine start'],
	'cue engine check': ['maestro-cli cue engine check --json'],
	'cue engine stop': ['maestro-cli cue engine stop --wait-ms 5000'],
	'cue engine status': ['maestro-cli cue engine status --json'],
	'cue engine inspect': ['maestro-cli cue engine inspect --json'],
	'bundle export': [
		'maestro-cli bundle export --agent <agent-id> --output agent.maestro-bundle.zip',
		'maestro-cli bundle export --agent <agent-id> --exact --output exact-agent.maestro-bundle.zip',
	],
	'bundle validate': ['maestro-cli bundle validate agent.maestro-bundle.zip'],
	'bundle inspect': ['maestro-cli bundle inspect agent.maestro-bundle.zip --json'],
	'bundle import': ['maestro-cli bundle import agent.maestro-bundle.zip --dry-run'],

	// Director's Notes
	'director-notes history': [
		'maestro-cli director-notes history --days 7 --filter agent --limit 50',
	],
	'director-notes synopsis': ['maestro-cli director-notes synopsis --days 7 --format markdown'],

	// CLI itself
	status: ['maestro-cli status --json'],
	version: ['maestro-cli version --json'],
	doctor: ['maestro-cli doctor --json'],
	completions: ['maestro-cli completions zsh > ~/.zfunc/_maestro-cli'],
	reference: ['maestro-cli reference --format json'],

	// Agents and groups
	'create-agent': [
		'maestro-cli create-agent "API Worker" --cwd ~/code/api --type claude-code --group <group-id>',
		'maestro-cli create-agent "Local Coder" --cwd . --run-on maestro-server:<model-id>',
	],
	'create-group': ['maestro-cli create-group "Backend" --emoji "🛠️" --color "#9146FF"'],
	'remove-group': ['maestro-cli remove-group <group-id> --force'],
	'rename-group': ['maestro-cli rename-group <group-id> "Platform"'],
	'update-group': ['maestro-cli update-group <group-id> --name "Platform" --hide'],
	'delegation graph': [
		'maestro-cli delegation graph',
		'maestro-cli delegation graph --group <group-id> --json',
	],
	'group-settings': ['maestro-cli group-settings <group-id> --json'],
	'update-group-settings': [
		'maestro-cli update-group-settings <group-id> --provider claude-code --model opus',
		'maestro-cli update-group-settings <group-id> --short-label "API" --publish --yes',
	],
	'create-worktree': [
		'maestro-cli create-worktree --agent <agent-id> --branch feat/search --base-branch main',
	],
	'remove-agent': ['maestro-cli remove-agent <agent-id>'],
	'update-agent': [
		'maestro-cli update-agent <agent-id> --model opus --effort high',
		'maestro-cli update-agent <agent-id> --provider codex --convert --accept-translation-limitations',
		'maestro-cli update-agent <agent-id> --run-on maestro-server:<model-id> --run-on-context 65536',
		'maestro-cli update-agent <agent-id> --peer docs-agent:r --remove-peer legacy-agent',
	],
	'agent test-run-on': ['maestro-cli agent test-run-on <agent-id> --json'],
	'rename-agent': ['maestro-cli rename-agent <agent-id> "API Worker"'],
	bookmark: ['maestro-cli bookmark <agent-id>'],
	unbookmark: ['maestro-cli unbookmark <agent-id>'],
	'focus-agent': ['maestro-cli focus-agent <agent-id> --tab <tab-id>'],
	'switch-mode': ['maestro-cli switch-mode <agent-id> terminal --background'],

	// Tabs
	'tab new': [
		'maestro-cli tab new --agent <agent-id> --prompt "Review the API layer" --background',
	],
	'tab close': ['maestro-cli tab close <tab-id>'],
	'tab rename': ['maestro-cli tab rename <tab-id> "Docs"'],
	'tab star': ['maestro-cli tab star <tab-id>'],
	'tab unstar': ['maestro-cli tab unstar <tab-id>'],
	'tab unread': ['maestro-cli tab unread <tab-id>'],
	'tab read': ['maestro-cli tab read <tab-id>'],
	'tab save-to-history': ['maestro-cli tab save-to-history <tab-id> false'],
	'tab show': ['maestro-cli tab show active --agent <agent-id>'],
	'tab thinking': ['maestro-cli tab thinking <tab-id> sticky'],
	'tab read-only': ['maestro-cli tab read-only <tab-id> true'],
	'tab model': ['maestro-cli tab model <tab-id> opus', 'maestro-cli tab model <tab-id> inherit'],
	'tab effort': ['maestro-cli tab effort <tab-id> high'],
	'tab enter-to-send': ['maestro-cli tab enter-to-send <tab-id> false'],
	'tab move': ['maestro-cli tab move <tab-id> first'],
	'tab suggest-cleanup': ['maestro-cli tab suggest-cleanup --json'],

	// SSH remotes
	'create-ssh-remote': [
		'maestro-cli create-ssh-remote "Build box" --host build.example.com --username deploy --key ~/.ssh/id_ed25519',
	],
	'update-ssh-remote': ['maestro-cli update-ssh-remote <remote-id> --port 2222 --set-default'],
	'remove-ssh-remote': ['maestro-cli remove-ssh-remote <remote-id>'],
	'test-ssh-remote': ['maestro-cli test-ssh-remote <remote-id> --timeout 30'],

	// Display, settings, theme, Encore
	'display font': [
		'maestro-cli display font',
		'maestro-cli display font terminal "JetBrains Mono"',
	],
	'display size': ['maestro-cli display size chat 15'],
	'display zoom': ['maestro-cli display zoom 125%'],
	'display preset': ['maestro-cli display preset default'],
	'display fonts': ['maestro-cli display fonts --json'],
	'settings list': ['maestro-cli settings list --category appearance --defaults'],
	'settings get': ['maestro-cli settings get encoreFeatures.directorNotes --verbose'],
	'settings set': [
		'maestro-cli settings set fontSize 16',
		'maestro-cli settings set localIgnorePatterns --raw \'["node_modules",".git"]\'',
	],
	'settings reset': ['maestro-cli settings reset fontSize'],
	'settings media-status': ['maestro-cli settings media-status --json'],
	'settings agent list': ['maestro-cli settings agent list <agent-id> --verbose'],
	'settings agent get': ['maestro-cli settings agent get <agent-id> model'],
	'settings agent set': ['maestro-cli settings agent set <agent-id> model opus'],
	'settings agent reset': ['maestro-cli settings agent reset <agent-id> model'],
	'set-theme': ['maestro-cli set-theme --list', 'maestro-cli set-theme monokai'],
	gloss: ['maestro-cli gloss sheen'],
	'theme show': ['maestro-cli theme show --json'],
	'theme export': ['maestro-cli theme export --file ./my-theme.json'],
	'theme import': ['maestro-cli theme import ./my-theme.json'],
	'theme set': ['maestro-cli theme set accent=#ff0000 --base dracula --activate'],
	'encore list': ['maestro-cli encore list'],
	'encore enable': ['maestro-cli encore enable aCappella'],
	'encore disable': ['maestro-cli encore disable pianola'],

	// Computer History
	'computer-history status': ['maestro-cli computer-history status'],
	'computer-history list': ['maestro-cli computer-history list --since 2h --app Slack'],
	'computer-history query': [
		'maestro-cli computer-history query --since 30m --kind text --grep "invoice"',
	],
	'computer-history apps': ['maestro-cli computer-history apps --since 1d'],
	'computer-history digests': ['maestro-cli computer-history digests --since 1d --kind 6h'],
	'computer-history pause': ['maestro-cli computer-history pause --for 2h'],
	'computer-history resume': ['maestro-cli computer-history resume'],
	'computer-history rules list': ['maestro-cli computer-history rules list'],
	'computer-history rules mode': ['maestro-cli computer-history rules mode exclude'],
	'computer-history rules add': [
		'maestro-cli computer-history rules add --app com.apple.Passwords',
		'maestro-cli computer-history rules add --domain bank.example.com',
	],
	'computer-history rules remove': ['maestro-cli computer-history rules remove <rule-id>'],
	'computer-history clear': ['maestro-cli computer-history clear --since 1h'],
	'computer-history enable-accessibility': ['maestro-cli computer-history enable-accessibility'],
	'computer-history config': [
		'maestro-cli computer-history config --retention-days 30 --digests on',
		'maestro-cli computer-history config --digest-source local',
	],

	// Pianola
	'pianola watch': ['maestro-cli pianola watch <tab-id> --agent <agent-id> --dry-run --once'],
	'pianola rules': ['maestro-cli pianola rules --json'],
	'pianola add-rule': [
		'maestro-cli pianola add-rule --action auto_answer --answer "Yes, continue" --max-risk low --kinds question',
	],
	'pianola learn': [
		'maestro-cli pianola learn --agent claude-code --since 2026-06-01 --out corpus.json',
	],
	'pianola profile': ['maestro-cli pianola profile --project ~/code/api'],
	'pianola set-profile': [
		'maestro-cli pianola set-profile --project ~/code/api --file profile.md --pair-count 120',
	],
	'pianola log': ['maestro-cli pianola log --limit 20'],
	'pianola plan set': ['maestro-cli pianola plan set --file plan.json'],
	'pianola plan list': ['maestro-cli pianola plan list'],
	'pianola plan show': ['maestro-cli pianola plan show <plan-id>'],
	'pianola orchestrate': ['maestro-cli pianola orchestrate <plan-id> --concurrency 2 --once'],
	'pianola supervise watch': ['maestro-cli pianola supervise watch <tab-id> --agent <agent-id>'],
	'pianola supervise orchestrate': [
		'maestro-cli pianola supervise orchestrate <plan-id> --concurrency 2',
	],
	'pianola supervise list': ['maestro-cli pianola supervise list'],
	'pianola supervise remove': ['maestro-cli pianola supervise remove <id>'],
	'pianola supervise enable': ['maestro-cli pianola supervise enable <id>'],
	'pianola supervise disable': ['maestro-cli pianola supervise disable <id>'],

	// Prompts, gist, notify, search
	'prompts list': ['maestro-cli prompts list --json'],
	'prompts get': ['maestro-cli prompts get _maestro-cli'],
	'gist create': ['maestro-cli gist create <agent-id> --description "Auth bug investigation"'],
	'notify toast': [
		'maestro-cli notify toast "Build" "Compiled in 3.2s" --color green --timeout 10',
		'maestro-cli notify toast "Review ready" "Open the diff" --agent <agent-id> --open-file ./diff.md',
	],
	'notify flash': ['maestro-cli notify flash "Tests passed" --color green'],
	'notify speak': ['maestro-cli notify speak "The deploy finished and the smoke tests pass."'],
	search: [
		'maestro-cli search "retry backoff" --source history',
		'maestro-cli search "how we handled rate limits" --semantic',
	],

	// A Cappella voice
	'voice status': ['maestro-cli voice status --json'],
	'voice start': [
		'maestro-cli voice start --conductor',
		'maestro-cli voice start --agent <agent-id> --paused',
		'maestro-cli voice start --quick-chat',
	],
	'voice stop': ['maestro-cli voice stop'],
	'voice listen': ['maestro-cli voice listen on', 'maestro-cli voice listen off --send'],
	'voice send': ['maestro-cli voice send'],
	'voice stop-reply': ['maestro-cli voice stop-reply'],
	'voice scope': ['maestro-cli voice scope agent --agent <agent-id>'],
	'voice wait': ['maestro-cli voice wait 1500', 'maestro-cli voice wait default'],
	'voice volume': ['maestro-cli voice volume 0.6'],
	'voice mute': ['maestro-cli voice mute'],
	'voice unmute': ['maestro-cli voice unmute'],
	'voice latency': ['maestro-cli voice latency --json'],
	'voice self-test': ['maestro-cli voice self-test'],
	'voice setup': ['maestro-cli voice setup --download'],
	'voice input list': ['maestro-cli voice input list'],
	'voice input set': ['maestro-cli voice input set default'],
	'voice providers list': ['maestro-cli voice providers list'],
	'voice providers set': ['maestro-cli voice providers set stt <provider-id>'],
	'voice voices list': ['maestro-cli voice voices list'],
	'voice voices set': ['maestro-cli voice voices set <voice-id>'],
	'voice voices preview': ['maestro-cli voice voices preview <voice-id> --text "Build finished."'],
	'voice credentials list': ['maestro-cli voice credentials list'],
	'voice credentials set': ['pbpaste | maestro-cli voice credentials set openai'],
	'voice credentials test': ['maestro-cli voice credentials test openai'],
	'voice credentials clear': ['maestro-cli voice credentials clear openai'],
	'voice devices list': ['maestro-cli voice devices list --json'],
	'voice devices rename': ['maestro-cli voice devices rename <device> "Pedram iPhone"'],
	'voice devices revoke': ['maestro-cli voice devices revoke <device> --yes'],
	'voice devices forget': ['maestro-cli voice devices forget <device> --yes'],
	'voice devices revoke-all': ['maestro-cli voice devices revoke-all --yes'],
	'voice devices disconnect': ['maestro-cli voice devices disconnect'],
	'voice devices discovery': ['maestro-cli voice devices discovery on'],
	'voice devices test-connection': ['maestro-cli voice devices test-connection'],
	'voice wake-phrase list': ['maestro-cli voice wake-phrase list'],
	'voice wake-phrase set': ['maestro-cli voice wake-phrase set <agent-id> "hey scout"'],
	'voice wake-phrase clear': ['maestro-cli voice wake-phrase clear <agent-id>'],
	'voice wake test': ['maestro-cli voice wake test "hey scout" --seconds 10 --sensitivity 0.6'],
	'voice wake list': ['maestro-cli voice wake list'],
	'voice wake status': ['maestro-cli voice wake status "hey scout"'],
	'voice wake record': [
		'maestro-cli voice wake record "hey scout"',
		'maestro-cli voice wake record --other-speech',
	],
	'voice wake stop': ['maestro-cli voice wake stop'],
	'voice wake add': [
		'maestro-cli voice wake add "hey scout" take1.wav take2.wav',
		'maestro-cli voice wake add "hey scout" talking.wav --other-speech',
	],
	'voice wake undo': ['maestro-cli voice wake undo "hey scout"'],
	'voice wake clear-background': ['maestro-cli voice wake clear-background "hey scout"'],
	'voice wake train': ['maestro-cli voice wake train "hey scout"'],
	'voice wake remove': ['maestro-cli voice wake remove "hey scout"'],

	// Local Models
	'models list': ['maestro-cli models list --kind text-gen --fit'],
	'models add-hf': [
		'maestro-cli models add-hf <repo> <file>.gguf --dry-run',
		'maestro-cli models add-hf <repo> <file>.gguf',
	],
	'models remove-hf': ['maestro-cli models remove-hf <model-id> --force'],
	'models install': ['maestro-cli models install <model-id>'],
	'models runtimes list': ['maestro-cli models runtimes list --json'],
	'models runtimes install': ['maestro-cli models runtimes install onnx'],
	'models pause': ['maestro-cli models pause <model-id>'],
	'models cancel': ['maestro-cli models cancel <model-id>'],
	'models remove': ['maestro-cli models remove <model-id> --force'],
	'models verify': ['maestro-cli models verify <model-id>'],
	'models assign': [
		'maestro-cli models assign tab-naming local:<model-id>',
		'maestro-cli models assign model-routing endpoint:<endpoint>:<model>',
		'maestro-cli models assign cue-gate off',
	],
	'models tasks': ['maestro-cli models tasks --json'],
	'models run': [
		'maestro-cli models run <task-id> --input "Name this tab: fix the login redirect"',
		'maestro-cli models run git-drafts --cwd ~/code/api --base main',
		'maestro-cli models run dictation --audio note.wav',
	],
	'models status': ['maestro-cli models status model-routing'],
	'models index': ['maestro-cli models index --json'],
	'models proxy status': ['maestro-cli models proxy status --json'],
	'models proxy block': ['maestro-cli models proxy block <hash> --original'],
	'models server status': ['maestro-cli models server status --json'],
	'models server start': ['maestro-cli models server start'],
	'models server stop': ['maestro-cli models server stop'],
	'models server set': ['maestro-cli models server set --bind local --max-models 2'],
	'models server key': ['maestro-cli models server key'],
	'models tiers list': ['maestro-cli models tiers list --harness claude-code'],
	'models tiers options': ['maestro-cli models tiers options claude-code --refresh'],
	'models tiers suggest': ['maestro-cli models tiers suggest claude-code --apply'],
	'models tiers set': ['maestro-cli models tiers set claude-code high provider:opus'],
	'models tiers reset': ['maestro-cli models tiers reset claude-code --tier low'],
	'models config show': ['maestro-cli models config show'],
	'models config set': [
		'maestro-cli models config set download-base https://hf-mirror.example.com',
	],
	'models endpoints list': ['maestro-cli models endpoints list --json'],
	'models endpoints add': [
		'maestro-cli models endpoints add --kind ollama',
		'maestro-cli models endpoints add --kind openai-compatible --url https://llm.example.com/v1 --name "Team LLM" --api-key-env TEAM_LLM_KEY',
	],
	'models endpoints update': [
		'maestro-cli models endpoints update <endpoint> --name "Studio Ollama" --disable',
	],
	'models endpoints remove': ['maestro-cli models endpoints remove <endpoint>'],
	'models endpoints models': ['maestro-cli models endpoints models <endpoint>'],
	'models endpoints test': ['maestro-cli models endpoints test <endpoint> --model <model>'],
	'models endpoints detect': ['maestro-cli models endpoints detect'],

	// System One
	's1 status': ['maestro-cli s1 status --json'],
	's1 set engine': [
		'maestro-cli s1 set engine local-judge --model local:<model-id>',
		'maestro-cli s1 set engine openjev --url https://jev.example.com',
	],
	's1 set timeout': ['maestro-cli s1 set timeout 2000'],
	's1 set fail-policy': ['maestro-cli s1 set fail-policy cue-gate open'],
	's1 set keep-inputs': ['maestro-cli s1 set keep-inputs on'],
	's1 set agents': ['maestro-cli s1 set agents off'],
	's1 set budget': ['maestro-cli s1 set budget 2 --per-agent 0.5'],
	's1 key set': ['pbpaste | maestro-cli s1 key set --engine jev-cloud'],
	's1 key clear': ['maestro-cli s1 key clear --engine jev-cloud'],
	's1 test': ['maestro-cli s1 test --json'],
	's1 ledger': ['maestro-cli s1 ledger --task model-routing --since 2h --limit 20'],
	's1 route': [
		'maestro-cli s1 route "Rename the config key across the repo"',
		'maestro-cli s1 route "Rename the config key" --correct low',
	],
	's1 yes': ['maestro-cli s1 yes "Does this diff change public API?" --state-file change.diff'],
	's1 pick': [
		'maestro-cli s1 pick "Which team owns this?" "backend=API or database,frontend=UI,infra=build and deploy" --state "Login page returns 500"',
	],
	's1 rate': [
		'maestro-cli s1 rate "How severe is this?" "cosmetic,annoying,blocks a user,data loss" --state-file report.md',
	],
	's1 ask': [
		'maestro-cli s1 ask --state-file report.md --noul urgent "Is it urgent?" --choice team "Which team?" backend frontend infra',
	],
	's1 rank': [
		'maestro-cli s1 rank --query "token refresh bug" --candidates-file commits.txt --top 5',
	],
	's1 batch': [
		'maestro-cli s1 batch --input notes.jsonl --state-key text --noul spam "Is this spam?" --out answers.jsonl',
	],
	's1 usage': ['maestro-cli s1 usage --agent <agent-id> --since 7d'],
	's1 cost': ['maestro-cli s1 cost --state-file report.md --questions 3'],
	's1 guide': ['maestro-cli s1 guide --list', 'maestro-cli s1 guide batch'],
	's1 examples': ['maestro-cli s1 examples'],

	// Profiling, MaestroRun, Quick Chat
	'profiling start': ['maestro-cli profiling start'],
	'profiling stop': ['maestro-cli profiling stop --output ./trace.json'],
	'profiling status': ['maestro-cli profiling status'],
	'maestro-run status': ['maestro-cli maestro-run status --check-latest'],
	'maestro-run install': ['maestro-cli maestro-run install'],
	'maestro-run grant': ['maestro-cli maestro-run grant --reveal'],
	'quick-chat show': ['maestro-cli quick-chat show'],
	'quick-chat hide': ['maestro-cli quick-chat hide'],
	'quick-chat return': ['maestro-cli quick-chat return'],
	'quick-chat toggle': ['maestro-cli quick-chat toggle'],
	'quick-chat status': ['maestro-cli quick-chat status --json'],
	'quick-chat send': ['maestro-cli quick-chat send "What changed on main today?"'],
	'quick-chat new': ['maestro-cli quick-chat new'],
	'quick-chat keep': ['maestro-cli quick-chat keep on'],
	'quick-chat pin': ['maestro-cli quick-chat pin on'],
	'quick-chat font': ['maestro-cli quick-chat font 120%', 'maestro-cli quick-chat font reset'],
	'quick-chat agent': ['maestro-cli quick-chat agent <agent-id>'],
	'quick-chat reveal': ['maestro-cli quick-chat reveal'],
	'quick-chat new-tab': ['maestro-cli quick-chat new-tab <message-id>'],
	'quick-chat stop': ['maestro-cli quick-chat stop'],
	'quick-chat bounds': ['maestro-cli quick-chat bounds --x 200 --y 120 --width 640'],

	// Cadenza and Movement
	'cadenza open': [
		'maestro-cli cadenza open build --type tracker --title "Build" --body "Compiling..." --color orange',
	],
	'cadenza update': ['maestro-cli cadenza update build --body "Compiled in 3.2s" --color green'],
	'cadenza close': ['maestro-cli cadenza close build'],
	'movement begin': ['maestro-cli movement begin release --title "Release board"'],
	'movement add': [
		'maestro-cli movement add status --type view --body-file status.json --x 0 --y 0',
	],
	'movement update': ['maestro-cli movement update status --title "Status (live)"'],
	'movement move': ['maestro-cli movement move status --x 520 --y 0'],
	'movement remove': ['maestro-cli movement remove status'],
	'movement clear': ['maestro-cli movement clear'],
	'movement progress': [
		'maestro-cli movement progress track-1 --title "Auth rewrite" --phase refining --step 2 --steps 4',
	],
	'movement state': ['maestro-cli movement state --json'],
	'movement inspect': ['maestro-cli movement inspect mockup --output ./mockup.png'],
	'movement interact': ['maestro-cli movement interact mockup --click "#save"'],

	// Support, feedback, stats, plugins, MCP
	'support-package': ['maestro-cli support-package --output ~/Desktop --no-sessions'],
	'feedback auth': ['maestro-cli feedback auth --json'],
	'feedback login': ['maestro-cli feedback login'],
	'feedback accounts': ['maestro-cli feedback accounts --json'],
	'feedback diagnose': ['maestro-cli feedback diagnose --json'],
	'feedback search': ['maestro-cli feedback search "queue drops a message"'],
	'feedback submit': [
		'maestro-cli feedback submit --category bug --summary "Queue drops a message" --expected "It runs" --actual "It vanishes"',
	],
	'feedback subscribe': ['maestro-cli feedback subscribe 1234 --comment "Also seen on 1.4"'],
	stats: ['maestro-cli stats --range month --json'],
	'stats-indexing': [
		'maestro-cli stats-indexing --json',
		'maestro-cli stats-indexing --wait --timeout 300',
	],
	'stats-tokens': ['maestro-cli stats-tokens --range week --json'],
	'stats models': ['maestro-cli stats models --range week --json'],
	'stats-query': [
		'maestro-cli stats-query "SELECT agent_id, COUNT(*) FROM query_events WHERE start_time > ? GROUP BY agent_id" --param 1760000000000',
	],
	'plugin list': ['maestro-cli plugin list --json'],
	'plugin update': ['maestro-cli plugin update ./my-plugin'],
	'plugin init': ['maestro-cli plugin init ./my-plugin --tier 1 --id my-plugin'],
	'plugin validate': ['maestro-cli plugin validate ./my-plugin'],
	'plugin sign': ['maestro-cli plugin sign ./my-plugin --key ./signing.pem'],
	'plugin pack': ['maestro-cli plugin pack ./my-plugin --out my-plugin-1.0.0.tgz'],
	'mcp serve': ['maestro-cli mcp serve'],

	// Maestro Lite (a remote client of another computer's Maestro)
	'lite status': ['maestro-cli lite status --json'],
	'lite connect': ['maestro-cli lite connect <profile-id>'],
	'lite reconnect': ['maestro-cli lite reconnect'],
	'lite disconnect': ['maestro-cli lite disconnect'],
	'lite connections': ['maestro-cli lite connections'],
	'lite commands': ['maestro-cli lite commands'],
	'lite dismiss': ['maestro-cli lite dismiss'],
	'lite close': ['maestro-cli lite close --yes'],
	'lite profile list': ['maestro-cli lite profile list --json'],
	'lite profile read': ['maestro-cli lite profile read <profile-id> --json'],
	'lite profile save': ['maestro-cli lite profile save --file profile.json'],
	'lite profile remove': ['maestro-cli lite profile remove <profile-id> --yes'],
	'lite profile reset-identity': ['maestro-cli lite profile reset-identity <profile-id> --yes'],
	'lite discovery show': ['maestro-cli lite discovery show'],
	'lite discovery start': [
		'maestro-cli lite discovery start',
		'maestro-cli lite discovery start --no-tailscale',
	],
	'lite discovery status': ['maestro-cli lite discovery status'],
	'lite discovery stop': ['maestro-cli lite discovery stop'],
	'lite discovery import': ['maestro-cli lite discovery import < invitation.txt'],
	'lite pair request': [
		'maestro-cli lite pair request <host-key> --generation 3 --name "Work laptop"',
	],
	'lite pair submit': ['maestro-cli lite pair submit --pin-stdin < pin.txt'],
	'lite pair read': ['maestro-cli lite pair read'],
	'lite pair cancel': ['maestro-cli lite pair cancel'],
};

/** The command's path without the program name: `models server start`. */
export function commandPath(cmd: Command): string {
	const names: string[] = [];
	for (let node: Command | null = cmd; node && node.parent; node = node.parent) {
		names.unshift(node.name());
	}
	return names.join(' ');
}

/** The examples registered for one command path (empty when there are none). */
export function examplesFor(path: string): readonly string[] {
	return COMMAND_EXAMPLES[path] ?? [];
}

/** The block `--help` prints after a command's options. */
export function formatExamplesHelp(examples: readonly string[]): string {
	return `\nExamples:\n${examples.map((example) => `  ${example}`).join('\n')}\n`;
}

/** Attach each registered example to its command's `--help`, walking the whole tree. */
export function applyCommandExamples(program: Command): void {
	const visit = (cmd: Command): void => {
		const examples = examplesFor(commandPath(cmd));
		if (examples.length > 0) {
			cmd.addHelpText('after', formatExamplesHelp(examples));
		}
		for (const sub of cmd.commands) visit(sub as Command);
	};
	for (const sub of program.commands) visit(sub as Command);
}
