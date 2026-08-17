import { useEffect } from 'react';

import { useWorkspace } from '@/store/workspace';
import { MOD, type MenuEntry, useContextMenu } from '@/ui/ContextMenu';
import { useNamePrompt } from '@/ui/NamePrompt';

/**
 * The right button everywhere the app has not already claimed it.
 *
 * A tree row, the note body and a table cell each answer the event where it happens and stop
 * it there, so what reaches the window is the chrome around them: the topbar, the tab strip,
 * the page a note is laid out on, the empty canvas, every text field in the app. The platform
 * menu is suppressed there too, and until now nothing took its place — which is the one thing
 * suppressing it cannot be worth. This is what takes its place.
 */
export function RootMenu() {
  const { open: openMenu, menu } = useContextMenu();
  const { ask, dialog } = useNamePrompt();

  useEffect(() => {
    const onMenu = (event: MouseEvent) => {
      // Someone closer to the click already answered it. A locked tree row and a dismissed
      // vault list both prevent the default and deliberately offer nothing; opening this over
      // them would overrule a decision that has already been made.
      if (event.defaultPrevented) return;

      const field = fieldAt(event.target);
      const head = field ? fieldItems(field) : copyItems();
      const items = [...head, ...appItems(ask, head.length > 0)];

      if (items.length) openMenu(event, items);
    };

    window.addEventListener('contextmenu', onMenu);

    return () => window.removeEventListener('contextmenu', onMenu);
  }, [openMenu, ask]);

  return (
    <>
      {dialog}
      {menu}
    </>
  );
}

type Field = HTMLInputElement | HTMLTextAreaElement;

const clipboard = typeof navigator !== 'undefined' && Boolean(navigator.clipboard);

/**
 * Input types that hold editable text. The rest — checkboxes, colours, the numeric and date
 * pickers — have no selection to cut or paste into, and asking them for one throws.
 */
const TEXT_TYPES = new Set(['text', 'search', 'url', 'tel', 'password']);

function fieldAt(target: EventTarget | null): Field | null {
  const element = target instanceof HTMLElement ? target.closest('input, textarea') : null;

  if (element instanceof HTMLTextAreaElement) return element;

  return element instanceof HTMLInputElement && TEXT_TYPES.has(element.type) ? element : null;
}

/** Cut, copy and paste for a plain text field, which is all the platform menu offered there. */
function fieldItems(field: Field): MenuEntry[] {
  // Read now rather than on select: the menu takes focus on its way open, and the field's
  // selection goes with it.
  const start = field.selectionStart ?? 0;
  const end = field.selectionEnd ?? 0;
  const writable = !field.readOnly && !field.disabled;
  // Browsers refuse to hand a password to the clipboard, so offering to take one would be a
  // verb that quietly does nothing.
  const readable = end > start && field.type !== 'password';

  const restore = () => {
    field.focus();
    field.setSelectionRange(start, end);
  };

  const verbs: MenuEntry[] = [
    ...(readable && writable
      ? [
          {
            label: 'Cut',
            icon: 'cut' as const,
            hint: `${MOD}X`,
            onSelect: () => {
              restore();
              document.execCommand('cut');
            },
          },
        ]
      : []),
    ...(readable
      ? [
          {
            label: 'Copy',
            icon: 'copy' as const,
            hint: `${MOD}C`,
            onSelect: () => {
              restore();
              document.execCommand('copy');
            },
          },
        ]
      : []),
    ...(writable && clipboard
      ? [
          {
            label: 'Paste',
            icon: 'paste' as const,
            hint: `${MOD}V`,
            onSelect: () => {
              // Inserted as an editing command rather than written to `value`: React owns
              // these fields, and a direct write never reaches its onChange.
              void navigator.clipboard
                .readText()
                .then((text) => {
                  restore();
                  if (text) document.execCommand('insertText', false, text);
                })
                .catch(() => restore());
            },
          },
        ]
      : []),
  ];

  return [
    ...verbs,
    {
      label: 'Select all',
      icon: 'text',
      hint: `${MOD}A`,
      separated: verbs.length > 0,
      onSelect: () => {
        field.focus();
        field.select();
      },
    },
  ];
}

/** A selection over text that belongs to no field — a meta line, a status readout, a banner. */
function copyItems(): MenuEntry[] {
  const text = window.getSelection()?.toString() ?? '';

  if (!text.trim() || !clipboard) return [];

  return [
    {
      label: 'Copy',
      icon: 'copy',
      hint: `${MOD}C`,
      onSelect: () => void navigator.clipboard.writeText(text).catch(() => undefined),
    },
  ];
}

/**
 * The verbs the shell has wherever the pointer is. Read from the store rather than through
 * the hook: this is built when the menu opens, not when the component renders.
 */
function appItems(
  ask: (label: string, initial: string) => Promise<string | null>,
  separated: boolean,
): MenuEntry[] {
  const { vaultId, addNote, addFolder, setView } = useWorkspace.getState();

  // Signed out, or the vault list has not arrived yet: none of these would do anything.
  if (vaultId === null) return [];

  return [
    {
      label: 'New note',
      icon: 'plus',
      separated,
      onSelect: () =>
        void ask('Note title', 'Untitled').then((title) => {
          if (title) void addNote(null, title);
        }),
    },
    {
      label: 'New folder',
      icon: 'folder',
      onSelect: () =>
        void ask('Folder name', 'New folder').then((name) => {
          if (name) void addFolder(null, name);
        }),
    },
    { label: 'Search', icon: 'search', separated: true, onSelect: () => setView('search') },
    { label: 'Graph', icon: 'graph', onSelect: () => setView('graph') },
    { label: 'Trash', icon: 'trash', onSelect: () => setView('trash') },
  ];
}
