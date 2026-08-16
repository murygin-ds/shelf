import { check } from './.tmp-sim.mjs';
const cases = {
  'multiline link title': '[foo](/url "multi\nline title") tail',
  'multiline ref link title': '[foo]: /url "multi\nline"\n\n[foo]',
  'nested emphasis': '**bold *ital* bold** end',
  'unclosed fence': '```js\ncode here\nmore',
  'heading only hash': '#\n\nnext',
  'hash no space': '#foo\n\n#',
  'hash space only': '# \n',
  'closing hash run': '# h #\n',
  'bare hash pair': '# #\n',
  'link spanning lines': '[foo\nbar](/url)',
  'list in blockquote': '> - one\n> - two\n',
  'crlf': '# head\r\n\r\ntext\r\n',
  'empty': '',
  'one huge line': '**a** '.repeat(3),
  'setext': 'Title\n=====\n',
  'setext dash': 'Title\n-----\n',
  'hr': '---\n\ntext',
  'hr star': '***\n',
  'autolink': 'see <https://x.dev/a> ok',
  'gfm autolink': 'see https://x.dev/a ok',
  'image': '![alt](/i.png "t")',
  'inline code multiline': 'a `code\nspan` b',
  'ref def': '[ref]: /url "title"\n\nuse [ref]\n',
  'task list': '- [x] done\n- [ ] todo\n',
  'quote with heading': '> # inside\n> text\n',
  'nested quote': '> > deep\n',
  'table': '| a | b |\n|---|---|\n| 1 | 2 |\n',
  'indented code': '    code\n    more\n',
  'link title parens': "[a](/u (multi\nline))",
  'linklabel multiline': '[foo\nbar]: /url\n',
};
for(const [name,text] of Object.entries(cases)){
  for (const focus of [false,true]) {
    const r = check(text,{hasFocus:focus, selection:[{from:0,to:0}]});
    if(r.problems.length) console.log(`### ${name} (focus=${focus})\n  input=${JSON.stringify(text)}\n  ` + r.problems.join('\n  '));
  }
}
console.log('done');
