// Throwaway harness for exercising the new editor and the dialog dismissal outside the
// locked app. Deleted once the behaviour is confirmed.
import { createElement, useEffect } from 'react';
import { createRoot } from 'react-dom/client';

import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';

import { editorTheme, livePreview } from './src/features/editor/livepreview';
import { useNamePrompt } from './src/ui/NamePrompt';
import './src/styles/theme.css';
import '@fontsource/instrument-sans/400.css';
import '@fontsource/instrument-sans/600.css';
import '@fontsource/jetbrains-mono/400.css';

const doc = `# Test

123

321321321
`;

const view = new EditorView({
  parent: document.getElementById('sandbox')!,
  state: EditorState.create({
    doc,
    extensions: [
      history(),
      keymap.of([...defaultKeymap, ...historyKeymap]),
      markdown({ base: markdownLanguage }),
      livePreview,
      editorTheme,
      EditorView.lineWrapping,
    ],
  }),
});

const closed: Array<string | null> = [];

function Dialog() {
  const { ask, dialog } = useNamePrompt();

  useEffect(() => {
    void ask('Folder name', 'New folder').then((name) => closed.push(name));
  }, [ask]);

  return dialog;
}

createRoot(document.getElementById('dialog')!).render(createElement(Dialog));

Object.assign(window as unknown as Record<string, unknown>, { cm: view, closed });
