import { describe, expect, it } from 'vitest';

import type { FolderNode, NoteNode, Tree } from '@/api/workspace';
import type { IndexedNote } from '@/lib/search';

import {
  attributeToClaude,
  bare,
  entries,
  field,
  readClaudeVault,
  status,
  summary,
  todos,
} from './claudeview';

let next = 0;

function folder(name: string, parentId: number | null = null, updatedAt = '2026-08-01T00:00:00Z'): FolderNode {
  next += 1;

  return {
    id: next, clientId: `f${next}`, vaultId: 1, keyScopeClientId: 's', name,
    icon: undefined, tags: [], locked: false, permission: 'own', keyScopeId: 1, keyVersion: 1,
    ownScope: false, grantCount: 1, updatedAt, updatedBy: null,
    parentId, depth: parentId === null ? 0 : 1, position: 0,
  } as FolderNode;
}

function note(name: string, folderId: number | null, updatedAt = '2026-08-01T00:00:00Z', updatedBy: number | null = null): NoteNode {
  next += 1;

  return {
    id: next, clientId: `n${next}`, vaultId: 1, keyScopeClientId: 's', name,
    icon: undefined, tags: [], locked: false, permission: 'own', keyScopeId: 1, keyVersion: 1,
    ownScope: false, grantCount: 1, updatedAt, updatedBy,
    folderId, contentSeq: 1, contentSize: 0,
  } as NoteNode;
}

function indexed(note: NoteNode, body: string): IndexedNote {
  return { id: note.id, title: note.name, body, folderId: note.folderId, path: '', tags: [], updatedAt: note.updatedAt, haystack: '' };
}

describe('reading a Claude vault', () => {
  const projects = folder('projects');
  const skills = folder('skills');
  const memory = folder('memory');
  const context = folder('context');
  const inbox = folder('inbox');

  const alpha = folder('alpha', projects.id, '2026-08-20T00:00:00Z');
  const beta = folder('beta', projects.id, '2026-08-10T00:00:00Z');
  const release = folder('release-checklist', skills.id);
  const scratch = folder('scratch');

  const root = note('CLAUDE.md', null);
  const alphaDoc = note('CLAUDE.md', alpha.id, '2026-08-20T00:00:00Z');
  const alphaDecisions = note('decisions.md', alpha.id);
  const alphaNote = note('api.md', alpha.id);
  const betaDoc = note('CLAUDE.md', beta.id);
  const skillDoc = note('SKILL.md', release.id);
  const august = note('2026-08.md', memory.id, '2026-08-22T00:00:00Z', 99);
  const july = note('2026-07.md', memory.id);
  const profile = note('profile.md', context.id);
  const environment = note('environment.md', context.id);
  const captured = note('a thought.md', inbox.id);
  const stray = note('somewhere.md', scratch.id);

  const tree: Tree = {
    folders: [projects, skills, memory, context, inbox, alpha, beta, release, scratch],
    notes: [root, alphaDoc, alphaDecisions, alphaNote, betaDoc, skillDoc, august, july, profile, environment, captured, stray],
  };

  const index: IndexedNote[] = [
    indexed(alphaDoc, '# Alpha\n\n**Status:** active\n**Updated:** 2026-08-20\n\nThe billing rewrite.\n\n## What to do next\n\n- [ ] Ship the migration\n- [x] Pick a queue\n- [ ] Write the runbook\n'),
    indexed(alphaDecisions, '# Decisions\n\n## 2026-08-19 — queue\n\nchose one\n\n## 2026-08-12 — storage\n\nchose another\n'),
    indexed(betaDoc, '# <!-- Project name -->\n\n**Status:** <!-- planning -->\n\n## What this is\n\n<!-- Two or three sentences. -->\n'),
    indexed(skillDoc, '---\nname: release-checklist\ndescription: Everything to do before tagging a release.\n---\n\n# Release checklist\n\nSteps here.\n'),
    indexed(august, '# 2026-08\n\n## 2026-08-01\n\n- Vault created.\n- Connector wired up.\n- Billing rewrite started.\n'),
    indexed(profile, '# Profile\n\n- **Name:** Rita\n- **Role:** staff engineer, works on billing and owns the release process\n'),
    indexed(environment, '# Environment\n\n<!-- What is true of the machines. -->\n\n## Machines\n\n- <!-- e.g. MacBook -->\n'),
    indexed(captured, '# A thought\n\nWorth turning into a project later on, probably.\n'),
  ];

  const model = readClaudeVault(tree, index);

  it('finds the document the model reads first', () => {
    expect(model.rootId).toBe(root.id);
  });

  it('reads a project out of its folder rather than listing its files', () => {
    const found = model.projects.find((project) => project.name === 'alpha');

    expect(found).toBeDefined();
    expect(found?.status).toBe('active');
    expect(found?.summary).toBe('The billing rewrite.');
    expect(found?.next).toEqual(['Ship the migration', 'Write the runbook']);
    expect(found?.done).toBe(1);
    expect(found?.decisions).toBe(2);
    // Its own CLAUDE.md, its decisions log and one working note.
    expect(found?.notes).toBe(3);
    expect(found?.blank).toBe(false);
  });

  it('knows a project nobody has filled in yet', () => {
    const found = model.projects.find((project) => project.name === 'beta');

    expect(found?.blank).toBe(true);
    expect(found?.status).toBe('unset');
    expect(found?.next).toEqual([]);
  });

  it('puts what is being worked on first', () => {
    expect(model.projects.map((project) => project.name)).toEqual(['alpha', 'beta']);
  });

  it('reads a skill from its frontmatter', () => {
    expect(model.skills).toHaveLength(1);
    expect(model.skills[0]?.name).toBe('release-checklist');
    expect(model.skills[0]?.description).toBe('Everything to do before tagging a release.');
    expect(model.skills[0]?.blank).toBe(false);
  });

  it('turns the log into a timeline, newest month first', () => {
    expect(model.memory.map((month) => month.month)).toEqual(['2026-08', '2026-07']);
    expect(model.memory[0]?.entries).toBe(3);
    expect(model.memory[0]?.latest[0]).toBe('Billing rewrite started.');
  });

  it('says which standing facts are still blank', () => {
    const filled = Object.fromEntries(model.context.map((doc) => [doc.name, doc.filled]));

    expect(filled['profile.md']).toBe(true);
    expect(filled['environment.md']).toBe(false);
  });

  it('shows the inbox and whatever sits outside the five areas', () => {
    expect(model.inbox.map((item) => item.name)).toEqual(['a thought.md']);
    expect(model.inbox[0]?.preview).toContain('Worth turning into a project');
    expect(model.elsewhere.map((item) => item.name)).toEqual(['somewhere.md']);
  });

  it('does not count the root document as loose', () => {
    expect(model.elsewhere.some((item) => item.name === 'CLAUDE.md')).toBe(false);
  });

  it('marks what the connector wrote, and nothing when there is no connector', () => {
    expect(attributeToClaude(model, tree, 99).byClaude.map((item) => item.name)).toEqual(['2026-08.md']);
    expect(attributeToClaude(model, tree, null).byClaude).toEqual([]);
  });
});

describe('the conventions it reads', () => {
  it('takes a field however it was written', () => {
    expect(field('**Status:** active', 'Status')).toBe('active');
    expect(field('Status: paused', 'Status')).toBe('paused');
    expect(field('- **Name:** Rita', 'Name')).toBe('Rita');
    expect(field('nothing here', 'Status')).toBe('');
  });

  it('refuses a status it does not know', () => {
    expect(status('**Status:** active')).toBe('active');
    expect(status('**Status:** whenever')).toBe('unset');
    expect(status('**Status:** <!-- planning -->')).toBe('unset');
  });

  it('separates what is left from what is finished', () => {
    const { open, done } = todos('- [ ] one\n* [x] two\n- [X] three\n- [ ] <!-- placeholder -->\n');

    expect(open).toEqual(['one']);
    expect(done).toBe(2);
  });

  it('counts dated decisions but not the heading above them', () => {
    expect(entries('# Decisions\n\n## 2026-08-19 — a\n\n## 2026-01-02 — b\n')).toBe(2);
    expect(entries('# Decisions\n\n## YYYY-MM-DD — <!-- what -->\n')).toBe(0);
  });

  // The document a new project is created with is entirely scaffolding, and a card that
  // showed "[ ]" as its description was the tell that this was getting through.
  it('knows the document a new project starts as', () => {
    const seed =
      '# billing-rewrite\n\n**Status:** <!-- planning -->\n**Updated:** <!-- YYYY-MM-DD -->\n\n' +
      '## What this is\n\n<!-- Two or three sentences. -->\n\n## What to do next\n\n' +
      '- [ ] <!-- The next concrete step. -->\n';

    expect(bare(seed)).toBe(true);
    expect(summary(seed)).toBe('');
    expect(todos(seed).open).toEqual([]);
  });

  it('tells scaffolding from something somebody wrote', () => {
    expect(bare('# Title\n\n<!-- fill this in -->\n')).toBe(true);
    expect(bare('---\nname:\ndescription:\n---\n')).toBe(true);
    expect(bare('# Title\n\nThis is a real paragraph that says something.\n')).toBe(false);
  });

  // An empty label is an empty label in any alphabet. While the pattern was ASCII-only,
  // «**Статус:**» counted as content and an untouched Russian template looked filled in.
  it('reads an empty label the same way whatever it is written in', () => {
    const seed =
      '# Переписать биллинг\n\n**Статус:**\n**Обновлено:**\n\n## Что это\n\n' +
      '<!-- Два-три предложения. -->\n\n## Что дальше\n\n- [ ] <!-- Следующий шаг. -->\n';

    expect(bare(seed)).toBe(true);
    expect(bare('# Заголовок\n\n**Статус:** в работе\n')).toBe(false);
  });
});
