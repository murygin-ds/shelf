// Throwaway harness for eyeballing the live-preview extension outside the locked app.
// Deleted once the behaviour is confirmed.
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';

import { editorTheme, livePreview } from './src/features/editor/livepreview';
import './src/styles/theme.css';
import '@fontsource/instrument-sans/400.css';
import '@fontsource/jetbrains-mono/400.css';

const doc = `# Test

123

321321321

## Second level

Some **bold** and *em* and \`code\` and [a link](https://example.com).

> quoted line one
> quoted line two

- one
- two

\`\`\`js
const x = 1;
\`\`\`

---

Setext title
============
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

// Handles for driving it from the console.
Object.assign(window as unknown as Record<string, unknown>, {
  cm: view,
  put: (pos: number) => {
    view.focus();
    view.dispatch({ selection: { anchor: pos } });
  },
});
