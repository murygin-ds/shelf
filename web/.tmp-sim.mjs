import { Text } from '@codemirror/state';
import { Decoration } from '@codemirror/view';
import { parser as base, GFM, Subscript, Superscript, Emoji } from '@lezer/markdown';

const parser = base.configure([GFM, Subscript, Superscript, Emoji]);

const HEADING = {
  ATXHeading1:'cm-md-h1',ATXHeading2:'cm-md-h2',ATXHeading3:'cm-md-h3',
  ATXHeading4:'cm-md-h4',ATXHeading5:'cm-md-h5',ATXHeading6:'cm-md-h6',
  SetextHeading1:'cm-md-h1',SetextHeading2:'cm-md-h2',
};
const INLINE = {
  StrongEmphasis:'cm-md-strong',Emphasis:'cm-md-em',Strikethrough:'cm-md-strike',
  InlineCode:'cm-md-code',Link:'cm-md-link',Image:'cm-md-link',
};

function cursorSpans(view){ if(!view.hasFocus) return []; return view.selection.map(r=>({from:r.from,to:r.to})); }
function isRaw(spans,line){ return spans.some(s=>s.from<=line.to&&s.to>=line.from); }

export function build(view){
  const doc = view.doc;
  const state = { doc, sliceString:(a,b)=>doc.sliceString(a,b) };
  const tree = view.tree;
  const spans = cursorSpans(view);
  const all=[], hidden=[], log=[];

  const line=(at,cls)=>{ all.push({kind:'line',from:doc.lineAt(at).from,to:doc.lineAt(at).from,cls}); };
  const block=(from,to,cls,edges)=>{
    const first=doc.lineAt(from).number, last=doc.lineAt(to).number;
    for(let pos=from; pos<=to;){
      const at=doc.lineAt(pos);
      line(at.from,cls);
      if(edges&&at.number===first) line(at.from,edges[0]);
      if(edges&&at.number===last) line(at.from,edges[1]);
      pos=at.to+1;
    }
  };
  const mark=(from,to,cls)=>{ if(from>=to) return; all.push({kind:'mark',from,to,cls}); };
  const conceal=(from,to)=>{ if(from>=to) return; all.push({kind:'replace',from,to}); hidden.push({from,to}); };
  const marker=(from,to,raw)=>{ if(raw) mark(from,to,'cm-md-marker'); else conceal(from,to); };

  for(const range of view.visibleRanges){
    tree.iterate({from:range.from,to:range.to,enter:(node)=>{
      const name=node.name;
      const from=Math.max(node.from,range.from);
      const to=Math.min(node.to,range.to);
      const heading=HEADING[name];
      if(heading){ block(from,to,heading); return; }
      if(name==='Blockquote'){ block(from,to,'cm-md-quote'); return; }
      if(name==='ListItem'){ line(node.from,'cm-md-li'); return; }
      if(name==='FencedCode'||name==='CodeBlock'){ block(from,to,'cm-md-codeline',['cm-md-codefirst','cm-md-codelast']); return; }
      const inline=INLINE[name];
      if(inline){ mark(node.from,node.to,inline); return; }
      if(name==='ListMark'||name==='TaskMarker'){ mark(node.from,node.to,'cm-md-marker'); return; }
      const at=doc.lineAt(node.from);
      const raw=isRaw(spans,at);
      switch(name){
        case 'HorizontalRule': line(at.from,'cm-md-hr'); marker(node.from,node.to,raw); return;
        case 'HeaderMark': {
          if(node.matchContext(['SetextHeading1'])||node.matchContext(['SetextHeading2'])){ mark(node.from,node.to,'cm-md-marker'); return; }
          if(node.from===at.from){
            const pad=state.sliceString(node.to,node.to+1)===' '?1:0;
            marker(node.from,Math.min(node.to+pad,at.to),raw);
          } else {
            const pad=state.sliceString(node.from-1,node.from)===' '?1:0;
            marker(node.from-pad,node.to,raw);
          }
          return;
        }
        case 'QuoteMark': {
          const pad=state.sliceString(node.to,node.to+1)===' '?1:0;
          marker(node.from,Math.min(node.to+pad,at.to),raw);
          return;
        }
        case 'EmphasisMark': case 'StrikethroughMark': marker(node.from,node.to,raw); return;
        case 'CodeMark':
          if(node.matchContext(['InlineCode'])) marker(node.from,node.to,raw);
          else mark(node.from,node.to,'cm-md-marker');
          return;
        case 'LinkMark': case 'LinkTitle': case 'LinkLabel':
          if(node.matchContext(['LinkReference'])) mark(node.from,node.to,'cm-md-marker');
          else marker(node.from,node.to,raw);
          return;
        case 'URL':
          if(node.matchContext(['Link'])||node.matchContext(['Image'])||node.matchContext(['Autolink'])) marker(node.from,node.to,raw);
          return;
        default: return;
      }
    }});
  }
  return {all,hidden};
}

export function check(text, opts={}){
  const doc = Text.of(text.split('\n'));
  const tree = parser.parse(text);
  const view = {
    doc, tree,
    hasFocus: opts.hasFocus ?? false,
    selection: opts.selection ?? [{from:0,to:0}],
    visibleRanges: opts.visibleRanges ?? [{from:0,to:text.length}],
  };
  const {all,hidden} = build(view);
  const problems=[];
  for(const d of all){
    try{
      if(d.kind==='line') Decoration.line({class:d.cls}).range(d.from,d.to);
      if(d.kind==='mark') Decoration.mark({class:d.cls}).range(d.from,d.to);
      if(d.kind==='replace') Decoration.replace({}).range(d.from,d.to);
    }catch(e){ problems.push(`${e.message} :: ${JSON.stringify(d)}`); }
    if(d.kind==='replace' && d.to > doc.lineAt(d.from).to)
      problems.push(`REPLACE SPANS LINE BREAK ${d.from}-${d.to} (line ends at ${doc.lineAt(d.from).to}) text=${JSON.stringify(text.slice(d.from,d.to))}`);
  }
  // sortability
  try { Decoration.set(all.map(d=> d.kind==='line'?Decoration.line({class:d.cls}).range(d.from):d.kind==='mark'?Decoration.mark({class:d.cls}).range(d.from,d.to):Decoration.replace({}).range(d.from,d.to)), true); }
  catch(e){ problems.push('SET: '+e.message); }
  return {all,hidden,problems};
}
