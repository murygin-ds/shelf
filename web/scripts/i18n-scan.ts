/**
 * Finds English left behind in the interface.
 *
 * The dictionary cannot have a missing key — `satisfies Messages[...]` sees to that — so
 * the failure mode locale work actually has is the opposite one: a string nobody moved,
 * still sitting in a component, still rendering in English. Nothing in the type system
 * knows it is text rather than a class name, so this walks the syntax tree and guesses,
 * with a list of the places where a latin literal is legitimately not prose.
 *
 *     cd web && npm run i18n:scan            # everything
 *     cd web && npm run i18n:scan -- src/features/inspector
 *
 * Exit code is non-zero when anything is found, which makes "this area is done" something
 * a command answers rather than a person.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import ts from 'typescript';

const ROOT = 'src';

/**
 * Whole trees whose latin text is meant to stay: the reference dictionary, the public page,
 * and the english seed documents of a Claude vault. The last one is a path prefix ending in
 * `docs.en` rather than in the directory: `src/lib/claudeos` would also match
 * `src/lib/claudeos.ts`, and the file this scan most needs to see would silently stop being
 * scanned.
 */
const SKIP_PATHS = ['src/i18n/en', 'src/features/share', 'src/lib/claudeos/docs.en'];

/** Attributes whose value is machinery — a class, a route, an input mode — never a sentence. */
const TECHNICAL_ATTRS = new Set([
  'className',
  'id',
  'htmlFor',
  'href',
  'to',
  'src',
  'type',
  'role',
  'rel',
  'target',
  'name',
  'key',
  'autoComplete',
  'inputMode',
  'spellCheck',
  'xmlns',
  'viewBox',
  'd',
  'fill',
  'stroke',
  'strokeLinecap',
  'strokeLinejoin',
  'transform',
  'preserveAspectRatio',
  'method',
  'encType',
  'accept',
  'lang',
  'dir',
  'before',
  'after',
  'tag',
  'defineNodes',
  'icon',
  'kind',
]);

/** Names that are names in every language. */
const KEPT =
  /\b(Shelf|Claude|CLAUDE|SKILL|MCP|OAuth|Anthropic|Markdown|Yjs|CodeMirror|IndexedDB|WebCrypto|UTF|JSON|HTTP|HTTPS|Bearer|URL|URI|API|UUID|ISO|CSS|SVG|PNG|ZIP|PDF|Inter|JetBrains)\b/g;

interface Finding {
  file: string;
  line: number;
  column: number;
  text: string;
}

/**
 * Prose, as opposed to an identifier that happens to be latin.
 *
 * Two words, or one capitalised word followed by a lowercase one — that is the shape of a
 * label. `note-body`, `application/json` and `data-tip` are not.
 */
function looksLikeProse(raw: string): boolean {
  const text = raw.trim();

  if (text.length < 4) return false;
  if (!/[A-Za-z]{3,}/.test(text.replace(KEPT, ' '))) return false;
  if (/^[a-z0-9]+([-_./][a-z0-9]+)+$/.test(text)) return false;
  // A CSS value: a length, a custom property, or a shorthand like «1px solid #333».
  if (/var\(--|^-?[\d.]+(px|em|rem|%|vh|vw|s|ms)\b|^[\d.]+(px|em|rem)\s/.test(text)) return false;
  // A list of class names: every word is an identifier with a hyphen or a dot in it.
  if (text.split(/\s+/).every((word) => /^[a-z0-9]+([-_.][a-z0-9]+)+$/.test(word))) return false;
  if (/^[A-Z][A-Z0-9_]+$/.test(text) && !text.includes(' ')) return false;

  return /[A-Za-z]{2,}\s+[A-Za-z]{2,}/.test(text) || /^[A-Z][a-z]{2,}$/.test(text);
}

function scan(file: string, source: string): Finding[] {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TSX);
  const found: Finding[] = [];

  const lines = source.split('\n');

  const report = (node: ts.Node, text: string): void => {
    if (!looksLikeProse(text)) return;

    const at = tree.getLineAndCharacterOfPosition(node.getStart(tree));

    // `// i18n-ignore`, on the line or the one above it. Without an opt-out the only way
    // past a false positive is to rewrite working code around the heuristic, which is a
    // worse outcome than the false positive was.
    const here = lines[at.line] ?? '';
    const above = lines[at.line - 1] ?? '';
    if (/i18n-ignore/.test(here) || /i18n-ignore/.test(above)) return;

    found.push({ file, line: at.line + 1, column: at.character + 1, text: text.trim() });
  };

  const skipped = (node: ts.Node): boolean => {
    const parent = node.parent;
    if (parent === undefined) return false;

    // A module specifier, a property name, or a `styles['x']` lookup.
    if (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) return true;
    if (ts.isPropertyAssignment(parent) && parent.name === node) return true;
    if (ts.isElementAccessExpression(parent)) return true;
    if (ts.isLiteralTypeNode(parent)) return true;

    if (ts.isThrowStatement(parent)) return true;

    // CodeMirror and Lezer take strings that are not sentences: CSS declarations inside a
    // theme, node names in a grammar. They read as prose to any heuristic — «1px solid»
    // is two latin words — so they are excluded by where they are, not by how they look.
    for (let at: ts.Node | undefined = parent; at !== undefined; at = at.parent) {
      // `throw new CacheUnavailable('…')` — the literal's own parent is the constructor
      // call, so the throw is only visible by walking up.
      if (ts.isThrowStatement(at)) return true;

      // Anything written inside an Error subclass, including a constructor's default
      // message, is diagnostics by construction.
      if (ts.isClassDeclaration(at)) {
        const extended = at.heritageClauses?.some((clause) =>
          clause.types.some((type) => /Error$/.test(type.expression.getText(tree))),
        );

        if (extended === true) return true;
      }

      if (!ts.isCallExpression(at) && !ts.isNewExpression(at)) continue;

      const callee = at.expression.getText(tree);

      // Diagnostics stay English by design, and a message assembled with `+` is still one.
      if (/^console\.|Error$|DOMException$/.test(callee)) return true;
      if (/(^|\.)(theme|baseTheme|defineNodes|matchContext|styleTags|highlightStyle|elt)$/.test(callee)) {
        return true;
      }
    }

    // A string being compared is a value — a key name, a discriminant — not a label.
    if (ts.isBinaryExpression(parent) && ts.isToken(parent.operatorToken)) {
      const op = parent.operatorToken.kind;
      if (
        op === ts.SyntaxKind.EqualsEqualsEqualsToken ||
        op === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
        op === ts.SyntaxKind.EqualsEqualsToken ||
        op === ts.SyntaxKind.ExclamationEqualsToken
      ) {
        return true;
      }
    }
    if (ts.isCaseClause(parent)) return true;

    if (ts.isJsxAttribute(parent) && TECHNICAL_ATTRS.has(parent.name.getText(tree))) return true;

    // The same names as object keys: `{ name: 'Wikilink', before: 'Link' }` is a grammar
    // rule, not a label. Keys that do carry prose — label, title, hint — are not in the set.
    const holder = ts.isArrayLiteralExpression(parent) ? parent.parent : parent;
    if (
      holder !== undefined &&
      ts.isPropertyAssignment(holder) &&
      TECHNICAL_ATTRS.has(holder.name.getText(tree))
    ) {
      return true;
    }

    return false;
  };

  const walk = (node: ts.Node): void => {
    if (ts.isJsxText(node)) report(node, node.text);
    else if (
      (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
      !skipped(node)
    ) {
      report(node, node.text);
    } else if (ts.isTemplateExpression(node) && !skipped(node)) {
      const parts = [node.head.text, ...node.templateSpans.map((span) => span.literal.text)];
      report(node, parts.join(' '));
    }

    ts.forEachChild(node, walk);
  };

  walk(tree);

  return found;
}

function files(at: string): string[] {
  if (statSync(at).isFile()) return [at];

  return readdirSync(at).flatMap((entry) => {
    const path = join(at, entry);
    if (entry === 'node_modules') return [];

    if (statSync(path).isDirectory()) return files(path);

    return /\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry) ? [path] : [];
  });
}

const targets = process.argv.slice(2);
const roots = targets.length > 0 ? targets : [ROOT];
const findings = roots
  .flatMap(files)
  .map((path) => relative('.', path).split(sep).join('/'))
  .filter((path) => !SKIP_PATHS.some((skip) => path.startsWith(skip)))
  .flatMap((path) => scan(path, readFileSync(path, 'utf8')));

for (const one of findings) {
  console.log(`${one.file}:${one.line}:${one.column}  ${one.text.replace(/\s+/g, ' ')}`);
}

console.log(`\n${findings.length} english string${findings.length === 1 ? '' : 's'} left.`);
process.exit(findings.length > 0 ? 1 : 0);
