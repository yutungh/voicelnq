/**
 * VoiceFlow: the tiered privacy decision (spec §4.3). Pure functions only, so
 * every rule is unit-tested (`policy.test.ts`); the snapshot comes from Rust
 * (`src-tauri/src/context.rs`).
 *
 * VoiceFlow 0.9.11, start anywhere:
 * - At the hotkey only a positively identified block-listed app or password
 *   field refuses (Tier B). Everything else records and is transcribed; app
 *   context is allowed only when the field check said "not a password
 *   field". (0.9.10 and earlier held unidentified apps and, under Strict,
 *   unanswered field checks; those `held` dictations keep Send anyway.)
 * - When the text is ready, `decidePaste` looks at what has focus then and
 *   either pastes or copies. The text stays on the clipboard either way.
 *
 * A capture timeout or error can only remove context, never add it.
 */

import {
	BLOCKED_APPS,
	BROWSERS,
	SENSITIVE_TITLE_PATTERN,
	type BlockedApp,
} from './blocklist';
import { profileBlockedApp } from './profile-blocklist';

/**
 * The 0.9.10 privacy modes. Since 0.9.11 the setting is kept in storage but
 * no longer changes anything (Settings no longer shows it).
 */
export const PRIVACY_MODES = ['strict', 'best-effort'] as const;
export type PrivacyMode = (typeof PRIVACY_MODES)[number];

export const PASSWORD_CHECK_RESULTS = [
	'not-password',
	'password',
	'unknown',
	'unavailable',
	'unsupported',
	'timed-out',
	'not-checked',
] as const;
export type PasswordCheckResult = (typeof PASSWORD_CHECK_RESULTS)[number];

/** Mirrors `TargetSnapshot` in `src-tauri/src/context.rs`. */
export type TargetSnapshot = {
	/** "web" is the browser build, which has no target and never pastes. */
	platform: 'windows' | 'macos' | 'other' | 'web';
	resolved: boolean;
	isSelf: boolean;
	appName: string | null;
	exeName: string | null;
	exePath: string | null;
	bundleId: string | null;
	/** Local only: kept in history on this computer, never sent. */
	title: string | null;
	windowId: string | null;
	pid: number | null;
	samples: number;
	identityMs: number;
	passwordCheck: PasswordCheckResult;
	passwordCheckMs: number;
	error: string | null;
	/**
	 * The title matches a window-title pattern from the word lists, checked
	 * by the desktop app when it captured the target (never in the webview).
	 */
	profileTitleDenied?: boolean;
	/**
	 * VoiceFlow 0.9.11: the foreground window's class (Windows), so the paste
	 * rule can tell the desktop, the taskbar and the Start menu from an app.
	 */
	windowClass?: string | null;
	/**
	 * VoiceFlow 0.9.11 (Windows): the app runs above VoiceFlow's integrity
	 * level (as administrator), so Windows drops the paste keys. null: it
	 * couldn't be read. Absent in snapshots rebuilt from History.
	 */
	higherIntegrity?: boolean | null;
	/**
	 * VoiceFlow 0.9.23: whether the focused element takes text, read at paste
	 * time only where that answer is trusted (File Explorer and Finder, which
	 * also owns the macOS desktop). null or absent: not checked.
	 */
	focusField?: FocusField | null;
};

/**
 * VoiceFlow 0.9.23: the focused element at paste time. `not-editable` is a
 * positive answer (a file list, a breadcrumb); `unknown` means the check
 * couldn't tell and never stops a paste.
 */
export type FocusField = 'editable' | 'not-editable' | 'unknown';

export type RecordDecision = {
	/** allow: record and upload. refuse: don't record. */
	action: 'allow' | 'refuse';
	tier: 'B' | null;
	reason:
		/** The field check said "not a password field". */
		| 'checked'
		/** Not identified, or the field check couldn't answer. */
		| 'unchecked'
		| 'sensitive-title'
		| 'self'
		| 'web'
		| 'blocked-app'
		| 'password-field';
	/**
	 * Whether context about the app may go with this dictation. M1 sends no
	 * context at all; the decision is recorded for M6.
	 */
	sendContext: boolean;
	/** Display name of the app, when known. */
	appName: string | null;
};

/** What history stores for the recording (front matter `privacy`). */
export type RecordingPrivacy =
	| 'allowed'
	| 'allowed-no-context'
	| 'held'
	| 'sent-anyway';

export function findBlockedApp(
	target: Pick<TargetSnapshot, 'exeName' | 'bundleId'>,
): BlockedApp | null {
	const exe = target.exeName?.toLowerCase() ?? null;
	const bundle = target.bundleId?.toLowerCase() ?? null;
	const builtIn = BLOCKED_APPS.find(
		(app) =>
			(exe !== null && app.exe.includes(exe)) ||
			(bundle !== null && app.bundleIds.includes(bundle)),
	);
	if (builtIn) return builtIn;
	// VoiceFlow B + C2: apps the word lists add (never fewer).
	const listed = profileBlockedApp(exe, bundle);
	return listed
		? {
				name: listed,
				exe: exe === listed ? [listed] : [],
				bundleIds: bundle === listed ? [listed] : [],
			}
		: null;
}

export function isBrowser(
	target: Pick<TargetSnapshot, 'exeName' | 'bundleId'>,
): boolean {
	const exe = target.exeName?.toLowerCase();
	const bundle = target.bundleId?.toLowerCase();
	return (
		(!!exe && (BROWSERS.exe as readonly string[]).includes(exe)) ||
		(!!bundle && (BROWSERS.bundleIds as readonly string[]).includes(bundle))
	);
}

export function titleLooksSensitive(title: string | null): boolean {
	return !!title && SENSITIVE_TITLE_PATTERN.test(title);
}

export function displayName(target: TargetSnapshot | null): string {
	if (!target) return 'this app';
	const blocked = findBlockedApp(target);
	return blocked?.name ?? target.appName ?? target.exeName ?? 'this app';
}

/**
 * Decision at the hotkey, before anything is recorded.
 *
 * VoiceFlow 0.9.11, start anywhere: the only refusal is an app on the block
 * list (password managers, sign-in prompts). A password field does not
 * refuse; its text is copied instead of pasted. The
 * desktop, no text field, an app VoiceFlow can't identify, VoiceFlow itself
 * and a field check that can't answer all record and transcribe; where the
 * text goes is decided when it is ready (`decidePaste`). Context about the
 * app is allowed only when the field check said "not a password field".
 */
export function decideAtRecordStart(target: TargetSnapshot): RecordDecision {
	const appName = target.resolved ? displayName(target) : null;
	const allow = (
		reason: RecordDecision['reason'],
		sendContext: boolean,
	): RecordDecision => ({ action: 'allow', tier: null, reason, sendContext, appName });

	if (target.platform === 'web') return allow('web', false);
	if (!target.resolved) return allow('unchecked', false);
	if (target.isSelf) return allow('self', false);

	// Tier B: listed apps (password managers) only. A password field never
	// refuses a start (0.9.11): the text is copied instead of pasted.
	if (findBlockedApp(target)) {
		return { action: 'refuse', tier: 'B', reason: 'blocked-app', sendContext: false, appName };
	}

	// A browser page with a sensitive title: audio allowed, no context.
	if (
		isBrowser(target) &&
		(titleLooksSensitive(target.title) || target.profileTitleDenied === true)
	) {
		return { ...allow('sensitive-title', false), tier: 'B' };
	}

	const checked = target.passwordCheck === 'not-password';
	return allow(checked ? 'checked' : 'unchecked', checked);
}

export function recordingPrivacyFor(decision: RecordDecision): RecordingPrivacy {
	return decision.sendContext ? 'allowed' : 'allowed-no-context';
}

// ---------------------------------------------------------------------------
// Paste time (0.9.11): decided when the text is ready, on what has focus.
// ---------------------------------------------------------------------------

/** Windows shell surfaces: nowhere to paste. */
export type ShellSurface = 'desktop' | 'taskbar' | 'start' | 'switcher' | 'lock';

const EXPLORER_CLASSES: Readonly<Record<string, ShellSurface>> = {
	progman: 'desktop',
	workerw: 'desktop',
	shell_traywnd: 'taskbar',
	shell_secondarytraywnd: 'taskbar',
	// Alt+Tab and Task View (Windows 11, then Windows 10).
	xamlexplorerhostislandwindow: 'switcher',
	multitaskingviewframe: 'switcher',
	taskswitcherwnd: 'switcher',
	foregroundstaging: 'switcher',
};

const SHELL_EXES: Readonly<Record<string, ShellSurface>> = {
	'startmenuexperiencehost.exe': 'start',
	'searchhost.exe': 'start',
	'searchapp.exe': 'start',
	'searchui.exe': 'start',
	'shellexperiencehost.exe': 'start',
	'lockapp.exe': 'lock',
};

/**
 * The Windows shell surface in front, if any: the desktop, the taskbar, the
 * Start menu or search, the window switcher, the lock screen. Explorer's
 * classes count only for explorer.exe (or an unreadable process), so a File
 * Explorer window (CabinetWClass) is an ordinary app window.
 */
export function shellSurface(
	target: Pick<TargetSnapshot, 'platform' | 'exeName' | 'windowClass'>,
): ShellSurface | null {
	if (target.platform !== 'windows') return null;
	const exe = target.exeName?.toLowerCase() ?? null;
	if (exe && SHELL_EXES[exe]) return SHELL_EXES[exe];
	const windowClass = target.windowClass?.toLowerCase() ?? null;
	if (windowClass && (exe === null || exe === 'explorer.exe')) {
		return EXPLORER_CLASSES[windowClass] ?? null;
	}
	return null;
}

/** Which keys paste: Ctrl+V, or Shift+Insert for mintty (Git Bash). */
export type PasteShortcut = 'ctrl-v' | 'shift-insert';

export function pasteShortcutFor(target: Pick<TargetSnapshot, 'exeName'>): PasteShortcut {
	return target.exeName?.toLowerCase() === 'mintty.exe' ? 'shift-insert' : 'ctrl-v';
}

/** Why the text was copied instead of pasted (or `ok` / `web`: pasted). */
export type PasteReason =
	| 'ok'
	| 'web'
	| 'unresolved'
	| 'self'
	| 'shell'
	| 'blocked-app'
	| 'password-field'
	/** 0.9.23: File Explorer or Finder with no text field focused. */
	| 'no-field'
	| 'moved'
	| 'elevated'
	| 'elevation-unknown'
	| 'target-gone'
	| 'sent-anyway'
	| 'target-changed'
	| 'keys-failed';

export type PasteDecision = {
	paste: boolean;
	reason: PasteReason;
	appName: string | null;
	/** For `shell`: which surface was in front. */
	surface?: ShellSurface;
	/**
	 * Set when the paste is allowed: the window it was allowed for. The
	 * native paste checks it again right before the keystroke and stops if
	 * another window, or a password field, is in front by then.
	 */
	binding?: PasteBinding;
	shortcut?: PasteShortcut;
	/**
	 * 0.9.23, set when the paste is allowed: false for a remote desktop or
	 * virtual machine, whose paste keeps the text on the clipboard.
	 */
	restoresClipboard?: boolean;
	/** "Ctrl+V" or "Cmd+V", for the notice. */
	keys: string;
};

/** The window a paste is bound to (Rust `context::PasteBinding`). */
export type PasteBinding = {
	windowId: string | null;
	pid: number | null;
};

/** Why the native paste stopped just before the keystroke (Rust `PasteRefusal`). */
export type PasteRefusal = 'target-changed' | 'password-field';

/** Same window: the handle on Windows, the process on macOS. */
export function sameWindow(
	a: Pick<TargetSnapshot, 'windowId' | 'pid'>,
	b: Pick<TargetSnapshot, 'windowId' | 'pid'>,
): boolean {
	if (a.windowId !== null || b.windowId !== null) {
		return a.windowId === b.windowId && a.pid === b.pid;
	}
	return a.pid !== null && a.pid === b.pid;
}

/**
 * Where the text goes when it is ready (0.9.11). Pure, so every rule is unit
 * tested. Not pasting always means copying: the text goes on the clipboard
 * (0.9.23: "Couldn't paste — transcription copied to clipboard.") and stays
 * in History.
 *
 * - Copy: nothing readable in front; VoiceFlow itself; the desktop, taskbar,
 *   Start menu or window switcher; File Explorer or Finder with no text
 *   field focused (0.9.23); a blocked app; a password field; another
 *   window than the one in front at Stop; an app running as administrator
 *   (Windows drops VoiceFlow's keys there) or one whose level can't be read;
 *   a button-started paste whose window is closed; a dictation sent with
 *   Send anyway (0.9.10 and earlier).
 * - Paste: any other app window, even when the field check can't answer
 *   (Electron apps, terminals). Since 0.9.23 the person's own clipboard is
 *   put back after a paste (Settings: Keep my clipboard after pasting); the
 *   text is always in History, so a paste that lands nowhere loses nothing.
 */
export function decidePaste({
	current,
	atStop = null,
	privacy,
	targetGone = false,
}: {
	/** Snapshot taken just now, with the field check. */
	current: TargetSnapshot;
	/** The window in front when the recording stopped, when known. */
	atStop?: TargetSnapshot | null;
	/** How the recording itself was authorized, when there is one. */
	privacy?: RecordingPrivacy;
	/** A button asked to restore the original window and it is gone. */
	targetGone?: boolean;
}): PasteDecision {
	const appName = current.resolved ? displayName(current) : null;
	const keys = current.platform === 'macos' ? 'Cmd+V' : 'Ctrl+V';
	const copy = (reason: PasteReason, extra: Partial<PasteDecision> = {}): PasteDecision => ({
		paste: false,
		reason,
		appName,
		keys,
		...extra,
	});

	if (current.platform === 'web') return { paste: true, reason: 'web', appName, keys };
	if (targetGone) return copy('target-gone');
	// Send anyway never auto-pastes (spec §4.3, test 9).
	if (privacy === 'sent-anyway' || privacy === 'held') return copy('sent-anyway');
	const surface = shellSurface(current);
	// 0.9.23: renaming an icon on the desktop is a text field.
	const renaming = surface === 'desktop' && current.focusField === 'editable';
	if (surface && !renaming) return copy('shell', { surface });
	if (!current.resolved) return copy('unresolved');
	if (current.isSelf) return copy('self');
	if (findBlockedApp(current)) return copy('blocked-app');
	if (current.passwordCheck === 'password') return copy('password-field');
	// 0.9.23: only a positive "no text field" counts; unknown pastes.
	if (current.focusField === 'not-editable') return copy('no-field');
	if (atStop && !sameWindow(atStop, current)) return copy('moved');
	if (current.higherIntegrity === true) return copy('elevated');
	if (current.platform === 'windows' && current.higherIntegrity === null) {
		return copy('elevation-unknown');
	}
	if (current.windowId === null && current.pid === null) return copy('unresolved');
	return {
		paste: true,
		reason: 'ok',
		appName,
		keys,
		binding: { windowId: current.windowId, pid: current.pid },
		shortcut: pasteShortcutFor(current),
		restoresClipboard: !readsClipboardLate(current),
	};
}

/**
 * VoiceFlow 0.9.23: remote-desktop and virtual-machine windows send the
 * clipboard to the other computer when it asks for it, which can be long
 * after the keystroke. Putting the clipboard back there could paste the old
 * one, so their paste leaves the text on the clipboard (as before 0.9.23).
 * A remote session inside a browser tab can't be told apart; it gets the
 * restore like any page.
 */
const LATE_READER_EXES: ReadonlySet<string> = new Set([
	'mstsc.exe',
	'msrdc.exe',
	'msrdcw.exe',
	'windowsapp.exe',
	'vmconnect.exe',
	'wfica32.exe',
	'cdviewer.exe',
	'vmware.exe',
	'vmware-vmx.exe',
	'vmware-remotemks.exe',
	'virtualboxvm.exe',
	'anydesk.exe',
	'teamviewer.exe',
	'parsecd.exe',
	'rustdesk.exe',
	'vncviewer.exe',
	'tvnviewer.exe',
	'remoting_desktop.exe',
	'nxplayer.bin',
]);

const LATE_READER_BUNDLES: ReadonlySet<string> = new Set([
	'com.microsoft.rdc.macos',
	'com.microsoft.rdc.osx.beta',
	'com.microsoft.windowsapp',
	'com.citrix.receiver.icaviewer.mac',
	'com.vmware.fusion',
	'com.parallels.desktop.console',
	'org.virtualbox.app.virtualboxvm',
	'com.utmapp.utm',
	'com.philandro.anydesk',
	'com.teamviewer.teamviewer',
	'tv.parsec.www',
	'com.realvnc.vncviewer',
	'com.apple.screensharing',
	'com.carriez.rustdesk',
]);

export function readsClipboardLate(
	target: Pick<TargetSnapshot, 'exeName' | 'bundleId'>,
): boolean {
	const exe = target.exeName?.toLowerCase();
	const bundle = target.bundleId?.toLowerCase();
	return (!!exe && LATE_READER_EXES.has(exe)) || (!!bundle && LATE_READER_BUNDLES.has(bundle));
}

/** What `write_text` reports (Rust `PasteResult`): facts, not a verdict. */
export type NativePasteResult = {
	/** The paste keys were sent. */
	pasted: boolean;
	/** The text is on the clipboard. */
	copied: boolean;
	/** The re-check stopped the keystroke. */
	reason?: PasteRefusal | null;
	/** Something failed; no keys were sent. */
	error?: string | null;
};

/** How a delivery ended, derived only from what actually happened. */
export type DeliveryResult =
	| { result: 'pasted'; decision: PasteDecision }
	| { result: 'copied'; decision: PasteDecision }
	| { result: 'not-pasted'; decision: PasteDecision; error: string };

/**
 * The outcome from the decision and the native facts. `pasted` only when the
 * keys were sent; `copied` whenever the text is on the clipboard without a
 * paste; `not-pasted` only when neither happened. So the notice can't say
 * "Not pasted" after a paste, nor leave out that the text is on the
 * clipboard.
 */
export function deliveryResult(
	decision: PasteDecision,
	native: NativePasteResult | null,
	failure: string | null = null,
): DeliveryResult {
	if (native?.pasted) return { result: 'pasted', decision };
	let why = decision;
	if (decision.paste) {
		// It was going to paste; say why it didn't.
		// The web build can only copy; that is expected, not a failure.
		const reason = native?.reason ?? (decision.reason === 'web' ? 'web' : 'keys-failed');
		why = { ...decision, paste: false, reason, binding: undefined };
	}
	if (native?.copied) return { result: 'copied', decision: why };
	return {
		result: 'not-pasted',
		decision: why,
		error: native?.error ?? failure ?? 'The text could not be put on the clipboard.',
	};
}

const SURFACE_WORDS: Readonly<Record<ShellSurface, string>> = {
	desktop: 'The desktop was in front.',
	taskbar: 'The taskbar was in front.',
	start: 'The Start menu or search was open.',
	switcher: 'The window switcher was open.',
	lock: 'The lock screen was in front.',
};

/** One sentence: why the text was copied instead of pasted. */
export function copiedWhy(decision: PasteDecision): string | null {
	const app = decision.appName ?? 'This app';
	switch (decision.reason) {
		case 'ok':
		case 'web':
			return null;
		case 'unresolved':
			return 'No window was in front to paste into.';
		case 'self':
			return 'VoiceLnq itself was in front.';
		case 'shell':
			return SURFACE_WORDS[decision.surface ?? 'desktop'];
		case 'blocked-app':
			return `${app} is on the block list.`;
		case 'password-field':
			return `${app} looks like a password field.`;
		case 'no-field': {
			// explorer.exe reads as "explorer"; people know it as File Explorer.
			const where = decision.appName?.toLowerCase() === 'explorer' ? 'File Explorer' : decision.appName;
			return `No text field was selected in ${where ?? 'that window'}.`;
		}
		case 'moved':
			return 'Another window was in front than when you pressed Stop.';
		case 'elevated':
			return `${app} runs as administrator, so VoiceLnq can't paste into it.`;
		case 'elevation-unknown':
			return `VoiceLnq couldn't tell whether it may paste into ${app}.`;
		case 'target-gone':
			return 'The window you dictated into is closed.';
		case 'sent-anyway':
			return 'A dictation sent with Send anyway is never pasted automatically.';
		case 'target-changed':
			return 'Another window came to the front just before the paste.';
		case 'keys-failed':
			return "VoiceLnq couldn't send the paste keys.";
	}
}

/**
 * VoiceFlow 0.9.23: the notice whenever a paste was meant to happen and the
 * text was copied instead (nowhere to paste, or the guard stopped it).
 */
export const COPIED_INSTEAD = "Couldn't paste — transcription copied to clipboard.";

/** What the person is told, by delivery result. */
export function deliveryNotice(delivered: DeliveryResult): {
	title: string;
	description: string;
} {
	const { decision } = delivered;
	switch (delivered.result) {
		case 'pasted':
			return {
				title: decision.appName ? `Pasted into ${decision.appName}` : 'Pasted',
				description: '',
			};
		case 'copied':
			return {
				title: COPIED_INSTEAD,
				description: [copiedWhy(decision), `Press ${decision.keys} to paste. It is also in History.`]
					.filter(Boolean)
					.join(' '),
			};
		case 'not-pasted':
			return {
				title: 'Not pasted',
				description: `${delivered.error} Your text is saved in History.`,
			};
	}
}

/** The user-facing notice for a refusal at the hotkey. */
export function recordNotice(decision: RecordDecision): {
	title: string;
	description: string;
} | null {
	const app = decision.appName ?? 'this app';
	switch (decision.reason) {
		case 'blocked-app':
			return {
				title: `Not recording: ${app} is on the block list.`,
				description:
					'VoiceLnq never records in password managers, authenticators or sign-in prompts.',
			};
		case 'password-field':
			return {
				title: `Not recording: ${app} looks like a password field.`,
				description:
					'VoiceLnq never records into a password field. Nothing was recorded or sent.',
			};
		default:
			return null;
	}
}

/** Counter buckets (spec §4.3): checked-not-password apart from the rest. */
export type PasswordCheckCounters = Record<
	Exclude<PasswordCheckResult, 'not-checked'>,
	number
>;

export function emptyCounters(): PasswordCheckCounters {
	return {
		'not-password': 0,
		password: 0,
		unknown: 0,
		unavailable: 0,
		unsupported: 0,
		'timed-out': 0,
	};
}

export function countCheck(
	counters: PasswordCheckCounters,
	result: PasswordCheckResult,
): PasswordCheckCounters {
	if (result === 'not-checked') return counters;
	return { ...counters, [result]: counters[result] + 1 };
}
