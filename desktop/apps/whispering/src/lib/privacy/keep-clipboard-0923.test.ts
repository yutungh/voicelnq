/**
 * VoiceFlow 0.9.23: a paste keeps the person's clipboard, and a paste with
 * nowhere to go says so.
 *
 * - File Explorer or Finder with no text field focused is nowhere to paste:
 *   the text is copied and the notice says "Couldn't paste — transcription
 *   copied to clipboard." Only a positive "no text field" counts; an answer
 *   that can't tell still pastes.
 * - A confident paste (the field takes text, or a known terminal) puts the
 *   previous clipboard back (Settings: Keep my clipboard after pasting, on
 *   by default); an unsure one leaves the text on the clipboard, so a paste
 *   that silently failed can be pasted by hand. A remote desktop or VM never
 *   gets its clipboard back.
 * - "Paste last transcription" pastes the newest dictation again.
 *
 * delivery.ts and lib.rs can't be imported by `bun test`, so their paths
 * are checked in the source.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	COPIED_INSTEAD,
	copiedWhy,
	decidePaste,
	deliveryNotice,
	deliveryResult,
	isKnownTerminal,
	readsClipboardLate,
	restoreFor,
	type FocusField,
	type TargetSnapshot,
} from './policy';
import { lastTranscriptText } from '../vf/last-transcription';
import { sameKeys, shortcutTakenBy } from '../vf/shortcut-clash';

const read = (...path: string[]) =>
	readFileSync(join(import.meta.dir, ...path), 'utf8').replace(/\r\n/g, '\n');

function target(overrides: Partial<TargetSnapshot> = {}): TargetSnapshot {
	return {
		platform: 'windows',
		resolved: true,
		isSelf: false,
		appName: 'explorer',
		exeName: 'explorer.exe',
		exePath: null,
		bundleId: null,
		title: null,
		windowId: '11',
		pid: 110,
		samples: 1,
		identityMs: 1,
		passwordCheck: 'not-password',
		passwordCheckMs: 1,
		error: null,
		windowClass: 'CabinetWClass',
		higherIntegrity: false,
		...overrides,
	};
}

const finder = (focusField: FocusField | null) =>
	target({
		platform: 'macos',
		appName: 'Finder',
		exeName: 'finder',
		bundleId: 'com.apple.finder',
		windowId: null,
		windowClass: null,
		focusField,
	});

describe('nowhere to paste (0.9.23)', () => {
	test('File Explorer with no text field focused: copied, with why', () => {
		const decision = decidePaste({ current: target({ focusField: 'not-editable' }) });
		expect(decision).toMatchObject({ paste: false, reason: 'no-field' });
		const notice = deliveryNotice(deliveryResult(decision, { pasted: false, copied: true }));
		expect(notice.title).toBe("Couldn't paste — transcription copied to clipboard.");
		expect(notice.description).toBe(
			'No text field was selected in File Explorer. Press Ctrl+V to paste. It is also in History.',
		);
	});

	test("File Explorer's address bar, search box or a rename box: pasted", () => {
		const decision = decidePaste({ current: target({ focusField: 'editable' }) });
		expect(decision).toMatchObject({ paste: true, reason: 'ok' });
	});

	test("Finder with no text field (or the Mac desktop): copied, says Cmd+V", () => {
		const decision = decidePaste({ current: finder('not-editable') });
		expect(decision).toMatchObject({ paste: false, reason: 'no-field' });
		expect(copiedWhy(decision)).toBe('No text field was selected in Finder.');
		const notice = deliveryNotice(deliveryResult(decision, { pasted: false, copied: true }));
		expect(notice.title).toBe(COPIED_INSTEAD);
		expect(notice.description).toContain('Press Cmd+V to paste.');
		expect(decidePaste({ current: finder('editable') }).paste).toBe(true);
	});

	test('a check that couldn\'t tell, or wasn\'t asked, never stops a paste', () => {
		for (const focusField of ['unknown', null, undefined] as const) {
			expect(decidePaste({ current: target({ focusField }) }).paste).toBe(true);
			expect(decidePaste({ current: finder(focusField ?? null) }).paste).toBe(true);
		}
		// Any app the check isn't asked for (Excel, a terminal) pastes as before.
		const excel = target({ exeName: 'excel.exe', appName: 'Excel', windowClass: 'XLMAIN' });
		expect(decidePaste({ current: excel }).paste).toBe(true);
	});

	test('the desktop is still nowhere, unless an icon is being renamed', () => {
		const desktop = (focusField: FocusField | null) =>
			decidePaste({ current: target({ windowClass: 'Progman', focusField }) });
		for (const f of ['not-editable', 'unknown', null] as const) {
			expect(desktop(f)).toMatchObject({ paste: false, reason: 'shell', surface: 'desktop' });
		}
		expect(desktop('editable').paste).toBe(true);
		// The taskbar never takes a paste.
		const taskbar = decidePaste({
			current: target({ windowClass: 'Shell_TrayWnd', focusField: 'editable' }),
		});
		expect(taskbar).toMatchObject({ paste: false, reason: 'shell' });
	});

	test('the guard stopping a paste uses the same words', () => {
		const allowed = decidePaste({ current: target({ focusField: 'editable' }) });
		const result = deliveryResult(allowed, { pasted: false, copied: true, reason: 'target-changed' });
		expect(deliveryNotice(result).title).toBe(COPIED_INSTEAD);
		expect(deliveryNotice(result).description).toContain('Another window came to the front');
	});

	test('a paste that happened is never called a copy', () => {
		const allowed = decidePaste({ current: target({ focusField: 'editable' }) });
		const notice = deliveryNotice(deliveryResult(allowed, { pasted: true, copied: true }));
		expect(notice.title).toBe('Pasted into explorer');
		expect(notice.title).not.toContain("Couldn't");
	});
});

describe('confident, unsure, nowhere (0.9.23)', () => {
	const app = (overrides: Partial<TargetSnapshot>) =>
		decidePaste({ current: target({ exeName: 'app.exe', appName: 'App', windowClass: 'X', ...overrides }) });

	test('a field that takes text: confident, the clipboard comes back if it still does at the keystroke', () => {
		expect(app({ focusField: 'editable' })).toMatchObject({
			paste: true,
			confidence: 'confident',
			restore: 'if-editable',
		});
	});

	test("unsure (not a text field to UI Automation, or it couldn't tell): pasted, the text stays", () => {
		for (const focusField of ['not-editable', 'unknown', null, undefined] as const) {
			const d = app({ focusField });
			expect(d).toMatchObject({ paste: true, confidence: 'unsure' });
			expect(d.restore).toBeUndefined();
			expect(restoreFor(d, true)).toBeUndefined();
		}
		// An Electron app whose focus doesn't read as a text field, an Excel cell.
		expect(app({ exeName: 'obsidian.exe', focusField: 'not-editable' }).confidence).toBe('unsure');
		expect(app({ exeName: 'excel.exe', focusField: 'not-editable' }).confidence).toBe('unsure');
	});

	test('known terminals are confident; the classic console is unsure', () => {
		for (const t of [
			{ exeName: 'WindowsTerminal.exe', windowClass: 'CASCADIA_HOSTING_WINDOW_CLASS' },
			{ exeName: 'mintty.exe', windowClass: 'mintty' },
		]) {
			expect(app({ ...t, focusField: 'unknown' })).toMatchObject({ confidence: 'confident', restore: 'always' });
		}
		for (const bundleId of ['com.apple.Terminal', 'com.googlecode.iterm2']) {
			const d = decidePaste({
				current: target({ platform: 'macos', exeName: null, bundleId, windowId: null, windowClass: null }),
			});
			expect(d).toMatchObject({ paste: true, confidence: 'confident', restore: 'always' });
		}
		expect(isKnownTerminal({ exeName: 'cmd.exe', bundleId: null, windowClass: 'ConsoleWindowClass' })).toBe(false);
		expect(app({ exeName: 'cmd.exe', windowClass: 'ConsoleWindowClass' }).confidence).toBe('unsure');
	});

	test('a remote desktop or VM never gets its clipboard back', () => {
		for (const exeName of ['mstsc.exe', 'msrdc.exe', 'vmconnect.exe', 'VirtualBoxVM.exe', 'anydesk.exe']) {
			const d = app({ exeName, focusField: 'editable' });
			expect(d).toMatchObject({ paste: true, lateReader: true });
			expect(restoreFor(d, true)).toBeUndefined();
			expect(restoreFor(d, true, true)).toBeUndefined();
		}
		expect(readsClipboardLate({ exeName: null, bundleId: 'com.microsoft.rdc.macos' })).toBe(true);
		expect(readsClipboardLate({ exeName: null, bundleId: 'com.apple.TextEdit' })).toBe(false);
	});

	test('the setting off, or nothing pasted: no restore; Paste last transcription: always', () => {
		const confident = app({ focusField: 'editable' });
		expect(restoreFor(confident, true)).toBe('if-editable');
		expect(restoreFor(confident, false)).toBeUndefined();
		const unsure = app({ focusField: 'unknown' });
		expect(restoreFor(unsure, true, true)).toBe('always');
		expect(restoreFor(unsure, false, true)).toBeUndefined();
		const nowhere = decidePaste({ current: target({ focusField: 'not-editable' }) });
		expect(restoreFor(nowhere, true, true)).toBeUndefined();
	});

	test('the setting is on by default and in Settings; delivery passes the restore mode', () => {
		const settings = read('..', 'settings', 'settings.ts');
		expect(settings).toContain("'paste.keepClipboard': 'boolean = true'");
		const delivery = read('..', 'query', 'isomorphic', 'delivery.ts');
		expect(delivery).toContain(
			"restore: restoreFor(decision, settings.value['paste.keepClipboard'], alwaysRestore)",
		);
		const page = read('..', '..', 'routes', '(app)', '(config)', 'settings', '+page.svelte');
		expect(page).toContain("toggle('Keep my clipboard after pasting'");
		expect(page).toContain("settings.value['paste.keepClipboard']");
	});

	test('the paste time capture asks for the field check', () => {
		const paste = read('paste.ts');
		expect(paste.match(/captureTarget\(\{ checkField: true \}\)/g)?.length).toBe(2);
	});

	test('Rust: keys up first, the text written before the window check, put back only after keys were sent', () => {
		const rust = read('..', '..', '..', 'src-tauri', 'src', 'lib.rs');
		const from = rust.indexOf('async fn write_text(');
		const write = rust.slice(from, rust.indexOf('\n/// Which keys paste.', from));
		const verify = write.indexOf('verify_paste_binding');
		expect(write.indexOf('clipboard_keep::write_transient')).toBeLessThan(verify);
		expect(write.indexOf('app.clipboard().write_text(&text)')).toBeLessThan(verify);
		// The person's own keys come up before anything is written.
		expect(write.indexOf('wait_for_modifiers_up')).toBeLessThan(write.indexOf('clipboard_keep::snapshot'));
		// The restore is spawned only in the keys-sent arm, holding the lock,
		// and only as the guard's field answer allows.
		expect(write).toContain('Some((saved, seq)) if keys_sent =>');
		expect(write).toContain('let _held = one_at_a_time;');
		expect(write).toContain('clipboard_keep::restore_allowed(mode, field)');
		// Never restored when nothing was pasted: the text stays.
		expect(write).toContain('clipboard_keep::keep_transcript(&transcript, seq)');
	});
});

describe('Paste last transcription (0.9.23)', () => {
	test('the newest dictation with text, as delivered', () => {
		const at = (m: number) => `2026-11-28T10:${String(m).padStart(2, '0')}:00.000Z`;
		expect(
			lastTranscriptText([
				{ createdAt: at(1), transcribedText: 'buy oat milk', finalText: 'Buy oat milk.' },
				{ createdAt: at(3), transcribedText: 'call the plumber', finalText: 'Call the plumber.' },
				{ createdAt: at(2), transcribedText: 'older', finalText: undefined },
			]),
		).toBe('Call the plumber.');
		// Nothing delivered yet: the words as heard. Deleted and empty ones are skipped.
		expect(
			lastTranscriptText([
				{ createdAt: at(1), transcribedText: 'as heard', finalText: '' },
				{ createdAt: at(4), transcribedText: 'gone', finalText: 'Gone.', deletedAt: at(5) },
				{ createdAt: at(5), transcribedText: '   ', finalText: undefined },
			]),
		).toBe('as heard');
		expect(lastTranscriptText([])).toBeNull();
	});

	test('a global shortcut, on by default, with its own Settings row', () => {
		const settings = read('..', 'settings', 'settings.ts');
		expect(settings).toContain("IS_MACOS ? 'Control+Command+V' : 'Control+Alt+V'");
		const commands = read('..', 'commands.ts');
		expect(commands).toContain("id: 'pasteLastTranscription',\n\t\ttitle: 'Paste last transcription',");
		const page = read('..', '..', 'routes', '(app)', '(config)', 'settings', '+page.svelte');
		expect(page).toContain("{ id: 'pasteLastTranscription', label: 'Paste last transcription'");
		const delivery = read('..', 'query', 'isomorphic', 'delivery.ts');
		expect(delivery).toContain('alwaysRestore: true');
	});

	test("Settings refuses keys another VoiceLnq shortcut uses, whatever the modifiers' order", () => {
		const assigned = {
			toggleManualRecording: 'Control+Shift+;',
			pasteLastTranscription: 'Control+Alt+V',
			startFeedbackRecording: null,
		};
		expect(shortcutTakenBy('Alt+Control+V', 'toggleManualRecording', assigned)).toBe('pasteLastTranscription');
		expect(shortcutTakenBy('control+shift+;', 'pasteLastTranscription', assigned)).toBe('toggleManualRecording');
		// Its own keys again, or free keys: fine.
		expect(shortcutTakenBy('Control+Alt+V', 'pasteLastTranscription', assigned)).toBeNull();
		expect(shortcutTakenBy('Control+Alt+B', 'pasteLastTranscription', assigned)).toBeNull();
		expect(sameKeys('Control+Alt+V', 'Control+Shift+V')).toBe(false);
		const keyRow = read('..', 'vf', 'settings', 'KeyRow.svelte');
		expect(keyRow).toContain('shortcutTakenBy(');
	});
});
