/**
 * VoiceFlow 0.9.23: a paste keeps the person's clipboard, and a paste with
 * nowhere to go says so.
 *
 * - File Explorer or Finder with no text field focused is nowhere to paste:
 *   the text is copied and the notice says "Couldn't paste — transcription
 *   copied to clipboard." Only a positive "no text field" counts; an answer
 *   that can't tell still pastes.
 * - After a paste the previous clipboard is put back (Settings: Keep my
 *   clipboard after pasting, on by default), except into a remote desktop
 *   or virtual machine, which reads the clipboard late.
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
	readsClipboardLate,
	type FocusField,
	type TargetSnapshot,
} from './policy';

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

describe('the clipboard comes back after a paste (0.9.23)', () => {
	test('an ordinary app gets its clipboard back; a remote desktop or VM does not', () => {
		const notepad = target({ exeName: 'notepad.exe', appName: 'Notepad', windowClass: 'Notepad' });
		expect(decidePaste({ current: notepad }).restoresClipboard).toBe(true);
		for (const exeName of ['mstsc.exe', 'msrdc.exe', 'vmconnect.exe', 'VirtualBoxVM.exe', 'anydesk.exe']) {
			const remote = target({ exeName, appName: exeName, windowClass: 'X' });
			expect(decidePaste({ current: remote })).toMatchObject({ paste: true, restoresClipboard: false });
		}
		expect(readsClipboardLate({ exeName: null, bundleId: 'com.microsoft.rdc.macos' })).toBe(true);
		expect(readsClipboardLate({ exeName: null, bundleId: 'com.apple.TextEdit' })).toBe(false);
	});

	test('the setting is on by default, and the paste asks for it only when pasting', () => {
		const settings = read('..', 'settings', 'settings.ts');
		expect(settings).toContain("'paste.keepClipboard': 'boolean = true'");
		const delivery = read('..', 'query', 'isomorphic', 'delivery.ts');
		expect(delivery).toContain(
			"decision.paste && decision.restoresClipboard !== false && settings.value['paste.keepClipboard']",
		);
		const page = read('..', '..', 'routes', '(app)', '(config)', 'settings', '+page.svelte');
		expect(page).toContain("toggle('Keep my clipboard after pasting'");
		expect(page).toContain("settings.value['paste.keepClipboard']");
	});

	test('the paste time capture asks for the field check', () => {
		const paste = read('paste.ts');
		expect(paste.match(/captureTarget\(\{ checkField: true \}\)/g)?.length).toBe(2);
	});

	test('Rust: the text is written before the window check, and put back only after keys were sent', () => {
		const rust = read('..', '..', '..', 'src-tauri', 'src', 'lib.rs');
		const from = rust.indexOf('async fn write_text(');
		const write = rust.slice(from, rust.indexOf('\n/// Which keys paste.', from));
		const verify = write.indexOf('verify_paste_binding');
		expect(write.indexOf('clipboard_keep::write_transient')).toBeLessThan(verify);
		expect(write.indexOf('app.clipboard().write_text(&text)')).toBeLessThan(verify);
		// The restore is spawned only in the keys-sent arm, holding the lock.
		expect(write).toContain('Some((saved, seq)) if keys_sent =>');
		expect(write).toContain('let _held = one_at_a_time;');
		// Never restored when nothing was pasted: the text stays.
		expect(write).toContain('clipboard_keep::keep_transcript(&transcript, seq)');
	});
});
