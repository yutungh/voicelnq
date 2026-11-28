<script lang="ts">
	import * as Popover from '@epicenter/ui/popover';
	import type { Command } from '$lib/commands';
	import type { KeyboardEventSupportedKey } from '$lib/constants/keyboard';
	import { IS_MACOS } from '$lib/constants/platform';
	import { desktopRpc } from '$lib/query';
	import {
		type Accelerator,
		pressedKeysToTauriAccelerator,
	} from '$lib/services/desktop/global-shortcut-manager';
	import { settings } from '$lib/stores/settings.svelte';
	import { createPressedKeys } from '$lib/utils/createPressedKeys.svelte';
	import { commands } from '$lib/commands';
	import { shortcutTakenBy } from '$lib/vf/shortcut-clash';
	import { createKeyRecorder } from '$routes/(app)/(config)/settings/shortcuts/keyboard-shortcut-recorder/create-key-recorder.svelte';
	import Icon from '../Icon.svelte';
	import Kc from '../Kc.svelte';

	/**
	 * One "Dictation keys" row (B3.1): what the keys do, the keycaps, and
	 * Change. The new keys are registered with the system right away; a
	 * problem is said in the row, not in a pop-up notice.
	 */
	let {
		command,
		label,
		help,
	}: { command: Command; label: string; help?: string } = $props();

	const value = $derived(settings.value[`shortcuts.global.${command.id}`]);
	let open = $state(false);
	let message = $state<{ tone: 'ok' | 'bad'; text: string } | null>(null);

	const pressedKeys = createPressedKeys({
		onUnsupportedKey: (key) => {
			message = { tone: 'bad', text: `“${key}” can't be used. Try another key.` };
		},
	});

	const recorder = createKeyRecorder({
		pressedKeys,
		onRegister: async (keys: KeyboardEventSupportedKey[]) => {
			const { data: accelerator, error } = pressedKeysToTauriAccelerator(keys);
			if (error) {
				message = { tone: 'bad', text: `${keys.join(' + ')} can't be used. Try another combination.` };
				return;
			}
			// 0.9.23: keys another VoiceLnq shortcut already uses.
			const takenBy = shortcutTakenBy(
				accelerator,
				command.id,
				Object.fromEntries(commands.map((c) => [c.id, settings.value[`shortcuts.global.${c.id}`]])),
				IS_MACOS,
			);
			if (takenBy) {
				const other = commands.find((c) => c.id === takenBy)?.title ?? 'another shortcut';
				message = { tone: 'bad', text: `Those keys are already used for “${other}”. Try another combination.` };
				return;
			}
			// VoiceFlow A2: keys used only while dictating are saved now and
			// registered when a dictation starts.
			if ('whileDictating' in command && command.whileDictating) {
				settings.updateKey(`shortcuts.global.${command.id}`, accelerator);
				message = { tone: 'ok', text: 'Saved. Works while you dictate' };
				open = false;
				setTimeout(() => (message = null), 2500);
				return;
			}
			if (value) {
				await desktopRpc.globalShortcuts.unregisterCommand.execute({
					accelerator: value as Accelerator,
				});
			}
			const { error: registerError } =
				await desktopRpc.globalShortcuts.registerCommand.execute({
					command,
					accelerator,
				});
			if (registerError) {
				message = {
					tone: 'bad',
					text: `Those keys are taken by another app or ${IS_MACOS ? 'macOS' : 'Windows'}. Try another combination.`,
				};
				if (value) {
					await desktopRpc.globalShortcuts.registerCommand.execute({
						command,
						accelerator: value as Accelerator,
					});
				}
				return;
			}
			settings.updateKey(`shortcuts.global.${command.id}`, accelerator);
			message = { tone: 'ok', text: 'Saved' };
			open = false;
			setTimeout(() => (message = null), 2500);
		},
		onClear: async () => {
			if (value && !('whileDictating' in command && command.whileDictating)) {
				await desktopRpc.globalShortcuts.unregisterCommand.execute({
					accelerator: value as Accelerator,
				});
			}
			settings.updateKey(`shortcuts.global.${command.id}`, null);
			message = { tone: 'ok', text: 'Turned off' };
			open = false;
			setTimeout(() => (message = null), 2500);
		},
	});
</script>

<div class="srow">
	<div>
		<b>{label}</b>
		{#if message}
			<span class={message.tone === 'ok' ? 'okline' : 'err'} role="status"
				><Icon name={message.tone === 'ok' ? 'check-circle' : 'warning-circle'} weight="fill" class="i sm" />{message.text}</span
			>
		{:else if help}<span>{help}</span>{/if}
	</div>
	{#if value}<Kc shortcut={value} />{:else}<span class="sub">Off</span>{/if}
	<Popover.Root
		bind:open
		onOpenChange={(isOpen) => {
			message = null;
			if (isOpen) recorder.start();
			else recorder.stop();
		}}
	>
		<Popover.Trigger class="btn sec">Change</Popover.Trigger>
		<Popover.Content align="end" class="vf w-72">
			<p class="m-h">{label}</p>
			<div class="keycap-box" class:on={recorder.isListening} aria-live="polite">
				{#if recorder.isListening}
					<b>Press the keys you want</b>
					<span class="sub">Esc to stop</span>
				{:else}
					<button class="btn text" type="button" onclick={() => recorder.start()}>Press to record keys</button>
				{/if}
			</div>
			<div class="acts">
				{#if value}
					<button class="btn text" type="button" onclick={() => recorder.clear()}>Turn off</button>
				{/if}
				<button class="btn text" type="button" onclick={() => (open = false)}>Cancel</button>
			</div>
		</Popover.Content>
	</Popover.Root>
</div>
