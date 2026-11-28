import { describe, expect, test } from 'bun:test';
import {
	copiedWhy,
	countCheck,
	decidePaste,
	decideAtRecordStart,
	deliveryNotice,
	deliveryResult,
	emptyCounters,
	findBlockedApp,
	isBrowser,
	pasteShortcutFor,
	recordingPrivacyFor,
	recordNotice,
	sameWindow,
	shellSurface,
	titleLooksSensitive,
	type PasswordCheckResult,
	type PasteDecision,
	type TargetSnapshot,
} from './policy';

function target(overrides: Partial<TargetSnapshot> = {}): TargetSnapshot {
	return {
		platform: 'windows',
		resolved: true,
		isSelf: false,
		appName: 'Code',
		exeName: 'code.exe',
		exePath: 'C:\\Apps\\Code.exe',
		bundleId: null,
		title: 'notes.md - Code',
		windowId: '1234',
		pid: 42,
		samples: 1,
		identityMs: 1,
		passwordCheck: 'not-password',
		passwordCheckMs: 5,
		error: null,
		windowClass: 'Chrome_WidgetWin_1',
		higherIntegrity: false,
		...overrides,
	};
}

const unresolved = target({
	resolved: false,
	appName: null,
	exeName: null,
	exePath: null,
	title: null,
	windowId: null,
	pid: null,
	samples: 3,
	passwordCheck: 'not-checked',
	windowClass: null,
	higherIntegrity: null,
});

const UNANSWERED: PasswordCheckResult[] = [
	'unknown',
	'unavailable',
	'unsupported',
	'timed-out',
	'not-checked',
];

const kite = target({
	appName: 'Kite',
	exeName: 'kite.exe',
	title: 'Kite',
	windowId: '269634',
	pid: 78600,
});

describe('Start anywhere (0.9.11)', () => {
	test('an app VoiceFlow cannot identify records and is sent, with no context', () => {
		const d = decideAtRecordStart(unresolved);
		expect(d).toMatchObject({ action: 'allow', reason: 'unchecked', sendContext: false });
		expect(recordingPrivacyFor(d)).toBe('allowed-no-context');
		expect(recordNotice(d)).toBeNull();
	});

	test('the desktop, the taskbar and Start record', () => {
		for (const t of [
			target({ exeName: 'explorer.exe', appName: 'explorer', windowClass: 'Progman', passwordCheck: 'unknown' }),
			target({ exeName: 'explorer.exe', appName: 'explorer', windowClass: 'Shell_TrayWnd' }),
			target({ exeName: 'startmenuexperiencehost.exe', windowClass: 'Windows.UI.Core.CoreWindow' }),
		]) {
			expect(decideAtRecordStart(t).action).toBe('allow');
		}
	});

	test('a field check that cannot answer records and is sent, with no context', () => {
		for (const passwordCheck of UNANSWERED) {
			const d = decideAtRecordStart(target({ passwordCheck }));
			expect(d).toMatchObject({ action: 'allow', reason: 'unchecked', sendContext: false });
			expect(recordingPrivacyFor(d)).toBe('allowed-no-context');
		}
	});

	test('a checked app records with context', () => {
		const d = decideAtRecordStart(target());
		expect(d).toMatchObject({ action: 'allow', reason: 'checked', sendContext: true, appName: 'Code' });
		expect(recordingPrivacyFor(d)).toBe('allowed');
	});

	test('VoiceFlow itself and the web build record', () => {
		expect(decideAtRecordStart(target({ isSelf: true, passwordCheck: 'not-checked' }))).toMatchObject({
			action: 'allow',
			reason: 'self',
		});
		expect(decideAtRecordStart({ ...unresolved, platform: 'web' })).toMatchObject({
			action: 'allow',
			reason: 'web',
		});
	});

	test('nothing is ever held any more', () => {
		const all = [unresolved, target(), ...UNANSWERED.map((passwordCheck) => target({ passwordCheck }))];
		for (const t of all) {
			expect(decideAtRecordStart(t).action).not.toBe('hold');
			expect(recordingPrivacyFor(decideAtRecordStart(t))).not.toBe('held');
		}
	});
});

describe('The one start-time refusal: a positively identified password context', () => {
	const blocked: Array<Partial<TargetSnapshot>> = [
		{ exeName: '1password.exe' },
		{ exeName: 'bitwarden.exe' },
		{ exeName: 'keepass.exe' },
		{ exeName: 'keepassxc.exe' },
		{ exeName: 'lastpass.exe' },
		{ exeName: 'dashlane.exe' },
		{ exeName: 'keeper password manager.exe' },
		{ exeName: 'proton pass.exe' },
		{ exeName: 'enpass.exe' },
		{ exeName: 'authy desktop.exe' },
		{ exeName: 'consent.exe' },
		{ exeName: 'credentialuibroker.exe' },
		{ exeName: 'logonui.exe' },
		{ platform: 'macos', exeName: null, bundleId: 'com.apple.SecurityAgent' },
		{ platform: 'macos', exeName: null, bundleId: 'com.apple.keychainaccess' },
		{ platform: 'macos', exeName: null, bundleId: 'com.apple.Passwords' },
		{ platform: 'macos', exeName: null, bundleId: 'com.1password.1password' },
	];

	for (const overrides of blocked) {
		const label = overrides.exeName ?? overrides.bundleId;
		test(`${label} is refused, whatever the field check says`, () => {
			for (const passwordCheck of ['not-password', 'timed-out'] as const) {
				const d = decideAtRecordStart(target({ ...overrides, passwordCheck }));
				expect(d).toMatchObject({ action: 'refuse', tier: 'B', reason: 'blocked-app' });
			}
		});
	}

	test('exe matching is case-insensitive and exact', () => {
		expect(findBlockedApp({ exeName: '1Password.exe', bundleId: null })?.name).toBe('1Password');
		expect(findBlockedApp({ exeName: 'not1password.exe', bundleId: null })).toBeNull();
		expect(findBlockedApp({ exeName: 'code.exe', bundleId: null })).toBeNull();
	});

	test('a password field never refuses a start; its text is copied, not pasted', () => {
		const t = target({ passwordCheck: 'password' });
		const d = decideAtRecordStart(t);
		expect(d).toMatchObject({ action: 'allow', reason: 'unchecked', sendContext: false });
		expect(recordNotice(d)).toBeNull();
		expect(decidePaste({ current: t })).toMatchObject({ paste: false, reason: 'password-field' });
	});

	test('no field-check answer ever refuses or holds a start', () => {
		for (const passwordCheck of ['not-password', 'password', 'unknown', 'unavailable', 'unsupported', 'timed-out', 'not-checked'] as const) {
			expect(decideAtRecordStart(target({ passwordCheck })).action).toBe('allow');
		}
	});

	test('a macOS app known only by its executable is still matched', () => {
		const d = decideAtRecordStart(target({ platform: 'macos', exeName: '1password', bundleId: null }));
		expect(d).toMatchObject({ action: 'refuse', reason: 'blocked-app' });
	});

	test('an app with no exe and no bundle id is neither listed nor a browser', () => {
		const t = { exeName: null, bundleId: null };
		expect(findBlockedApp(t)).toBeNull();
		expect(isBrowser(t)).toBe(false);
	});
});

describe('Sensitive browser titles: audio allowed, no context', () => {
	test('known titles and word-list patterns', () => {
		const titles = [
			'Sign in - Google Accounts - Google Chrome',
			'Log in to your account',
			'Enter verification code',
			'Your one-time code',
			'Set up 2FA',
			'Chase Online Banking',
			'Bank of America | Online Banking',
			'Reset your password',
		];
		for (const title of titles) {
			const d = decideAtRecordStart(target({ exeName: 'chrome.exe', appName: 'chrome', title }));
			expect(d).toMatchObject({ action: 'allow', reason: 'sensitive-title', sendContext: false });
		}
		const listed = decideAtRecordStart(
			target({ exeName: 'chrome.exe', title: 'Project Zorb - Chrome', profileTitleDenied: true }),
		);
		expect(listed.reason).toBe('sensitive-title');
		expect(
			decideAtRecordStart(target({ exeName: 'chrome.exe', title: 'Project Zorb - Chrome' })).reason,
		).toBe('checked');
	});

	test('a sensitive title outside a browser changes nothing; ordinary pages keep context', () => {
		expect(decideAtRecordStart(target({ title: 'password ideas.md' })).reason).toBe('checked');
		expect(titleLooksSensitive('Hacker News - Microsoft Edge')).toBe(false);
		expect(titleLooksSensitive(null)).toBe(false);
		expect(isBrowser({ exeName: 'msedge.exe', bundleId: null })).toBe(true);
		expect(isBrowser({ exeName: null, bundleId: 'com.apple.Safari' })).toBe(true);
	});
});

describe('Paste rules: where the text goes when it is ready', () => {
	test('a normal app window: pasted, bound to that window', () => {
		const d = decidePaste({ current: target() });
		expect(d).toMatchObject({
			paste: true,
			reason: 'ok',
			appName: 'Code',
			binding: { windowId: '1234', pid: 42 },
			shortcut: 'ctrl-v',
			keys: 'Ctrl+V',
		});
	});

	test('the 0.9.10 Kite case: same window, field check unanswered: pasted', () => {
		for (const passwordCheck of UNANSWERED) {
			const current = { ...kite, passwordCheck };
			const d = decidePaste({ current, atStop: kite, privacy: 'allowed' });
			expect(d).toMatchObject({ paste: true, reason: 'ok', appName: 'Kite' });
		}
	});

	test('the desktop: copied', () => {
		for (const windowClass of ['Progman', 'WorkerW']) {
			const d = decidePaste({
				current: target({ exeName: 'explorer.exe', appName: 'explorer', windowClass }),
			});
			expect(d).toMatchObject({ paste: false, reason: 'shell', surface: 'desktop' });
			expect(copiedWhy(d)).toBe('The desktop was in front.');
		}
	});

	test('the taskbar, Start, search, the switcher and the lock screen: copied', () => {
		const cases: Array<[Partial<TargetSnapshot>, string]> = [
			[{ exeName: 'explorer.exe', windowClass: 'Shell_TrayWnd' }, 'taskbar'],
			[{ exeName: 'explorer.exe', windowClass: 'Shell_SecondaryTrayWnd' }, 'taskbar'],
			[{ exeName: 'startmenuexperiencehost.exe', windowClass: 'Windows.UI.Core.CoreWindow' }, 'start'],
			[{ exeName: 'searchhost.exe', windowClass: 'Windows.UI.Core.CoreWindow' }, 'start'],
			[{ exeName: 'shellexperiencehost.exe', windowClass: 'Windows.UI.Core.CoreWindow' }, 'start'],
			[{ exeName: 'explorer.exe', windowClass: 'XamlExplorerHostIslandWindow' }, 'switcher'],
			[{ exeName: 'explorer.exe', windowClass: 'MultitaskingViewFrame' }, 'switcher'],
			[{ exeName: 'lockapp.exe', windowClass: 'Windows.UI.Core.CoreWindow' }, 'lock'],
			// Unreadable process, but the class says desktop.
			[{ resolved: false, exeName: null, windowClass: 'Progman' }, 'desktop'],
		];
		for (const [overrides, surface] of cases) {
			const d = decidePaste({ current: target(overrides) });
			expect(d).toMatchObject({ paste: false, reason: 'shell', surface });
		}
	});

	test('File Explorer and other apps sharing a shell class are ordinary windows', () => {
		expect(shellSurface(target({ exeName: 'explorer.exe', windowClass: 'CabinetWClass' }))).toBeNull();
		// The same class in another app is not the shell.
		expect(shellSurface(target({ exeName: 'someapp.exe', windowClass: 'XamlExplorerHostIslandWindow' }))).toBeNull();
		expect(shellSurface(target({ exeName: 'someapp.exe', windowClass: 'Windows.UI.Core.CoreWindow' }))).toBeNull();
		// macOS has no Windows shell.
		expect(shellSurface(target({ platform: 'macos', exeName: 'explorer.exe', windowClass: 'Progman' }))).toBeNull();
		expect(decidePaste({ current: target({ exeName: 'explorer.exe', windowClass: 'CabinetWClass' })}).paste).toBe(true);
	});

	test('nothing readable in front: copied', () => {
		const d = decidePaste({ current: unresolved });
		expect(d).toMatchObject({ paste: false, reason: 'unresolved' });
		expect(copiedWhy(d)).toBe('No window was in front to paste into.');
	});

	test('VoiceFlow itself: copied', () => {
		const d = decidePaste({ current: target({ isSelf: true }) });
		expect(d).toMatchObject({ paste: false, reason: 'self' });
	});

	test('a blocked app or a password field: copied, never pasted', () => {
		const manager = decidePaste({ current: target({ exeName: 'bitwarden.exe', appName: 'Bitwarden' }) });
		expect(manager).toMatchObject({ paste: false, reason: 'blocked-app' });
		expect(copiedWhy(manager)).toBe('Bitwarden is on the block list.');
		const field = decidePaste({ current: target({ passwordCheck: 'password' }) });
		expect(field).toMatchObject({ paste: false, reason: 'password-field' });
		expect(field.binding).toBeUndefined();
	});

	test('another window than the one at Stop: copied', () => {
		const atStop = target({ windowId: '1', pid: 10, appName: 'Notepad' });
		const d = decidePaste({ current: target(), atStop });
		expect(d).toMatchObject({ paste: false, reason: 'moved' });
		// The same window: pasted.
		expect(decidePaste({ current: target(), atStop: target() }).paste).toBe(true);
		// Desktop at Stop, an app later: copied (the user may have moved on).
		const desktop = target({ exeName: 'explorer.exe', windowClass: 'Progman', windowId: '65552', pid: 5 });
		expect(decidePaste({ current: target(), atStop: desktop }).reason).toBe('moved');
		// No window known at Stop: no constraint.
		expect(decidePaste({ current: target(), atStop: null }).paste).toBe(true);
	});

	test('an app run as administrator, or one whose level is unreadable: copied', () => {
		const admin = decidePaste({ current: target({ higherIntegrity: true, appName: 'Terminal' }) });
		expect(admin).toMatchObject({ paste: false, reason: 'elevated' });
		expect(copiedWhy(admin)).toBe("Terminal runs as administrator, so VoiceLnq can't paste into it.");
		expect(decidePaste({ current: target({ higherIntegrity: null }) }).reason).toBe('elevation-unknown');
		// macOS and older snapshots have no level to read.
		expect(decidePaste({ current: target({ platform: 'macos', higherIntegrity: null }) }).paste).toBe(true);
		expect(decidePaste({ current: target({ higherIntegrity: undefined }) }).paste).toBe(true);
	});

	test('Send anyway (a 0.9.10 held dictation) is never pasted', () => {
		for (const privacy of ['held', 'sent-anyway'] as const) {
			expect(decidePaste({ current: target(), privacy })).toMatchObject({ paste: false, reason: 'sent-anyway' });
		}
	});

	test('a button paste whose window is gone: copied', () => {
		expect(decidePaste({ current: target(), targetGone: true })).toMatchObject({
			paste: false,
			reason: 'target-gone',
		});
	});

	test('mintty (Git Bash) pastes with Shift+Insert; everything else Ctrl+V', () => {
		expect(pasteShortcutFor({ exeName: 'mintty.exe' })).toBe('shift-insert');
		expect(pasteShortcutFor({ exeName: 'WindowsTerminal.exe' })).toBe('ctrl-v');
		expect(decidePaste({ current: target({ exeName: 'mintty.exe' }) }).shortcut).toBe('shift-insert');
	});

	test('macOS: bound to the process, Cmd+V', () => {
		const mac = target({ platform: 'macos', windowId: null, pid: 31, higherIntegrity: false });
		expect(decidePaste({ current: mac })).toMatchObject({
			paste: true,
			binding: { windowId: null, pid: 31 },
			keys: 'Cmd+V',
		});
		expect(sameWindow(mac, { windowId: null, pid: 31 })).toBe(true);
		expect(sameWindow(mac, { windowId: null, pid: 32 })).toBe(false);
	});

	test('the web build pastes its own way', () => {
		expect(decidePaste({ current: { ...unresolved, platform: 'web' } })).toMatchObject({
			paste: true,
			reason: 'web',
		});
	});
});

describe('Outcome and notice match what happened', () => {
	const allowed = decidePaste({ current: kite });
	const desktop = decidePaste({
		current: target({ exeName: 'explorer.exe', windowClass: 'Progman' }),
	});

	test('keys sent: pasted, and the notice says so', () => {
		const r = deliveryResult(allowed, { pasted: true, copied: true });
		expect(r.result).toBe('pasted');
		expect(deliveryNotice(r).title).toBe('Pasted into Kite');
	});

	test(`nowhere to paste: copied, "Couldn't paste — transcription copied to clipboard."`, () => {
		const r = deliveryResult(desktop, { pasted: false, copied: true });
		expect(r.result).toBe('copied');
		const notice = deliveryNotice(r);
		expect(notice.title).toBe("Couldn't paste — transcription copied to clipboard.");
		expect(notice.description).toBe(
			'The desktop was in front. Press Ctrl+V to paste. It is also in History.',
		);
		expect(notice.title).not.toContain('Not pasted');
	});

	test('the window changed just before the keystroke: copied, with why', () => {
		const r = deliveryResult(allowed, { pasted: false, copied: true, reason: 'target-changed' });
		expect(r.result).toBe('copied');
		expect(r.decision.reason).toBe('target-changed');
		expect(deliveryNotice(r).description).toContain('Another window came to the front');
	});

	test('a password field found just before the keystroke: copied', () => {
		const r = deliveryResult(allowed, { pasted: false, copied: true, reason: 'password-field' });
		expect(r).toMatchObject({ result: 'copied', decision: { reason: 'password-field' } });
	});

	test('the keys could not be sent but the text is on the clipboard: copied, not "Not pasted"', () => {
		const r = deliveryResult(allowed, { pasted: false, copied: true, error: 'no keyboard' });
		expect(r.result).toBe('copied');
		expect(deliveryNotice(r).description).toContain("couldn't send the paste keys");
	});

	test('only when nothing reached the clipboard: not pasted', () => {
		const r = deliveryResult(allowed, { pasted: false, copied: false, error: 'Clipboard busy.' });
		expect(r.result).toBe('not-pasted');
		expect(deliveryNotice(r).title).toBe('Not pasted');
		expect(deliveryNotice(r).description).toContain('Clipboard busy.');
		const none = deliveryResult(allowed, null, 'IPC failed.');
		expect(none).toMatchObject({ result: 'not-pasted', error: 'IPC failed.' });
	});

	test('"Not pasted" never follows keys that were sent', () => {
		for (const native of [
			{ pasted: true, copied: true },
			{ pasted: true, copied: false, error: 'a key release failed' },
		]) {
			expect(deliveryResult(allowed, native).result).toBe('pasted');
		}
	});

	test('every copy reason has words, and pasted reasons have none', () => {
		const reasons: PasteDecision['reason'][] = [
			'unresolved', 'self', 'shell', 'blocked-app', 'password-field', 'no-field', 'moved', 'elevated',
			'elevation-unknown', 'target-gone', 'sent-anyway', 'target-changed', 'keys-failed',
		];
		for (const reason of reasons) {
			expect(copiedWhy({ ...desktop, reason })).toBeTruthy();
		}
		expect(copiedWhy({ ...allowed, reason: 'ok' })).toBeNull();
	});

	test('macOS says Cmd+V', () => {
		const mac = decidePaste({ current: target({ platform: 'macos', isSelf: true }) });
		const notice = deliveryNotice(deliveryResult(mac, { pasted: false, copied: true }));
		expect(notice.title).toBe("Couldn't paste — transcription copied to clipboard.");
		expect(notice.description).toContain('Press Cmd+V to paste.');
	});
});

describe('Counters', () => {
	test('each outcome is counted apart; not-checked is not counted', () => {
		let c = emptyCounters();
		for (const r of [
			'not-password',
			'not-password',
			'password',
			'unknown',
			'unavailable',
			'unsupported',
			'timed-out',
			'not-checked',
		] as const) {
			c = countCheck(c, r);
		}
		expect(c).toEqual({
			'not-password': 2,
			password: 1,
			unknown: 1,
			unavailable: 1,
			unsupported: 1,
			'timed-out': 1,
		});
	});
});
