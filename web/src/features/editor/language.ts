import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags } from '@lezer/highlight';

import { Wikilink } from './wikilink';

/**
 * One markdown dialect, shared by the editor and by the tests that reason about what it
 * parses. Anything configured here has to hold in both, or a decoration test is checking a
 * grammar the editor does not run.
 */
export const noteLanguage = markdown({
  base: markdownLanguage,
  extensions: [Wikilink],
  // Every language CodeMirror ships a parser for, loaded on demand: `languages` holds
  // descriptions, and the parser for one is fetched the first time a fence names it. So a
  // note with a Go block costs a Go parser, and a note with none costs nothing.
  codeLanguages: languages,
  // A note is prose, not a web page. With autocompletion switched on, this would pop a list
  // of HTML tags at every `<` typed in a sentence.
  completeHTMLTags: false,
});

/**
 * Colours for what the code parsers find inside a fenced block.
 *
 * Deliberately nothing for the markdown tags themselves: the prose around the block is
 * styled by live preview's own decorations, and a highlight style reaching the same text
 * would be a second opinion about how a heading looks.
 */
const codeHighlight = HighlightStyle.define([
  { tag: [tags.keyword, tags.moduleKeyword, tags.controlKeyword], color: '#c3a6e8' },
  { tag: [tags.string, tags.special(tags.string), tags.regexp], color: '#9ec894' },
  { tag: [tags.number, tags.bool, tags.null, tags.atom], color: '#e0a878' },
  { tag: [tags.comment, tags.lineComment, tags.blockComment], color: '#6a6a75', fontStyle: 'italic' },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: '#8fb8f0' },
  { tag: [tags.typeName, tags.className, tags.namespace], color: '#7fc4c0' },
  { tag: [tags.propertyName, tags.attributeName], color: '#b7c0e8' },
  { tag: [tags.operator, tags.punctuation, tags.separator, tags.bracket], color: '#7e7e8c' },
  { tag: [tags.definition(tags.variableName), tags.variableName], color: '#d0d4e4' },
  { tag: tags.invalid, color: '#e08a8a' },
]);

export const codeColours = syntaxHighlighting(codeHighlight);
