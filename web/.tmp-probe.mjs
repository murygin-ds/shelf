import { parser as base, GFM, Subscript, Superscript, Emoji } from '@lezer/markdown';
const p = base.configure([GFM, Subscript, Superscript, Emoji]);
const doc = process.argv[2];
const tree = p.parse(doc);
const out = [];
tree.iterate({ enter: (n) => { out.push(`${' '.repeat(0)}${n.name} ${n.from}-${n.to} ${JSON.stringify(doc.slice(n.from,n.to))}`); } });
console.log(out.join('\n'));
