import { useMemo, useState } from 'react';

import type { NoteNode } from '@/api/workspace';
import {
  attributeToClaude,
  readClaudeVault,
  type ClaudeModel,
  type Project,
  type ProjectStatus,
} from '@/lib/claudeview';
import { useSession } from '@/store/session';
import { usePrefs } from '@/store/prefs';
import { useWorkspace } from '@/store/workspace';
import { Icon, type IconName } from '@/ui/Icon';
import { useNamePrompt } from '@/ui/NamePrompt';

import styles from './claudeview.module.css';

/**
 * The Claude vault, read as what it holds rather than as where it holds it.
 *
 * A tree answers "which files exist", which is the wrong question for a vault used as a
 * model's memory: what somebody wants to see is which projects are moving, what was decided,
 * what the model wrote since they last looked, and which of the standing facts are still
 * blank. The folders are how that is stored, and this view is the part that stops making
 * them the interface.
 *
 * It reads only what the tab already has — the tree and the decrypted search index — so it
 * costs nothing to open and shows exactly what the connector can see.
 */
export default function ClaudeView() {
  const { identity } = useSession();
  const readOnly = usePrefs((state) => state.readOnly);
  const tree = useWorkspace((state) => state.tree);
  const index = useWorkspace((state) => state.index);
  const coverage = useWorkspace((state) => state.coverage);
  const openNote = useWorkspace((state) => state.openNote);
  const setView = useWorkspace((state) => state.setView);
  const createProject = useWorkspace((state) => state.createClaudeProject);
  const createSkill = useWorkspace((state) => state.createClaudeSkill);

  const connector = useWorkspace((state) => state.connector);
  const [error, setError] = useState<string | null>(null);
  const { ask, dialog } = useNamePrompt();

  const model = useMemo<ClaudeModel>(
    () => attributeToClaude(readClaudeVault(tree, index), tree, connector?.userId ?? null),
    [tree, index, connector],
  );

  const open = (noteId: number | null) => {
    const note = tree.notes.find((candidate) => candidate.id === noteId);

    if (note) {
      void openNote(note as NoteNode);
      setView('editor');
    }
  };

  const start = (kind: 'project' | 'skill') => {
    void ask(kind === 'project' ? 'Project name' : 'Skill name', '').then((name) => {
      if (!name || !identity) return;

      setError(null);

      const run = kind === 'project' ? createProject : createSkill;

      void run(name, identity).catch((cause: unknown) =>
        setError(cause instanceof Error ? cause.message : 'that did not work'),
      );
    });
  };

  // The index is what every card is read out of, so a partly-hydrated vault has to say so
  // rather than quietly showing a project as empty.
  const hydrating = coverage.total > 0 && coverage.covered < coverage.total;

  return (
    <div className={styles.view}>
      <div className={styles.head}>
        <div>
          <div className={styles.title}>Claude</div>
          <div className={styles.subtitle}>
            {connector
              ? `Connected as ${connector.role} · ${connector.fingerprint}`
              : 'No connector on this vault — Claude cannot see it'}
          </div>
        </div>

        {model.rootId ? (
          <button type="button" className={styles.ghost} onClick={() => open(model.rootId)}>
            <Icon name="book" size={13} />
            Instructions
          </button>
        ) : null}
      </div>

      {error ? <div className={styles.error}>{error}</div> : null}
      {hydrating ? (
        <div className={styles.hint}>
          Reading the vault — {coverage.covered} of {coverage.total} notes open so far.
        </div>
      ) : null}

      <Section
        title="Projects"
        count={model.projects.length}
        action={readOnly ? undefined : { label: 'New project', onClick: () => start('project') }}
      >
        {model.projects.length === 0 ? (
          <Empty>Nothing on the go. A project is a folder with a CLAUDE.md in it.</Empty>
        ) : (
          <div className={styles.cards}>
            {model.projects.map((project) => (
              <ProjectCard key={project.folderId} project={project} onOpen={open} />
            ))}
          </div>
        )}
      </Section>

      <Section title="What Claude changed" count={model.byClaude.length}>
        {model.byClaude.length === 0 ? (
          <Empty>Nothing yet. Anything the connector writes shows up here first.</Empty>
        ) : (
          <ul className={styles.rows}>
            {model.byClaude.slice(0, 8).map((item) => (
              <li key={item.noteId}>
                <button type="button" className={styles.row} onClick={() => open(item.noteId)}>
                  <Icon name="doc" size={13} className={styles.rowIcon} />
                  <span className={styles.rowName}>{item.name}</span>
                  <span className={styles.rowMeta}>{item.path || 'root'}</span>
                  <span className={styles.rowWhen}>{ago(item.updatedAt)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Memory" count={model.memory.length}>
        {model.memory.length === 0 ? (
          <Empty>No log yet. Months live in memory/ as YYYY-MM.md.</Empty>
        ) : (
          <ul className={styles.rows}>
            {model.memory.map((month) => (
              <li key={month.noteId}>
                <button type="button" className={styles.row} onClick={() => open(month.noteId)}>
                  <span className={styles.month}>{month.month}</span>
                  <span className={styles.bar} aria-hidden>
                    {'▍'.repeat(Math.min(month.entries, 12))}
                  </span>
                  <span className={styles.rowMeta}>
                    {month.entries} {month.entries === 1 ? 'entry' : 'entries'}
                  </span>
                  <span className={styles.rowWhen}>{month.latest[0] ?? ''}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section
        title="Skills"
        count={model.skills.length}
        action={readOnly ? undefined : { label: 'New skill', onClick: () => start('skill') }}
      >
        {model.skills.length === 0 ? (
          <Empty>None written. A skill is a procedure worth repeating exactly.</Empty>
        ) : (
          <ul className={styles.rows}>
            {model.skills.map((skill) => (
              <li key={skill.folderId}>
                <button type="button" className={styles.row} onClick={() => open(skill.noteId)}>
                  <Icon name="bulb" size={13} className={styles.rowIcon} />
                  <span className={styles.rowName}>{skill.name}</span>
                  <span className={styles.rowMeta}>
                    {skill.blank ? 'not written yet' : skill.description}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Context" count={model.context.length}>
        {model.context.length === 0 ? (
          <Empty>No standing facts. These are what Claude reads before answering.</Empty>
        ) : (
          <div className={styles.chips}>
            {model.context.map((doc) => (
              <button
                key={doc.noteId}
                type="button"
                className={`${styles.chip} ${doc.filled ? styles.chipFilled : ''}`}
                onClick={() => open(doc.noteId)}
              >
                <Icon name={doc.filled ? 'check' : 'circle'} size={11} />
                {doc.name}
                {doc.filled ? null : <span className={styles.chipHint}>blank</span>}
              </button>
            ))}
          </div>
        )}
      </Section>

      {model.inbox.length > 0 ? (
        <Section title="Inbox" count={model.inbox.length}>
          <ul className={styles.rows}>
            {model.inbox.map((item) => (
              <li key={item.noteId}>
                <button type="button" className={styles.row} onClick={() => open(item.noteId)}>
                  <Icon name="inbox" size={13} className={styles.rowIcon} />
                  <span className={styles.rowName}>{item.name}</span>
                  <span className={styles.rowMeta}>{item.preview}</span>
                  <span className={styles.rowWhen}>{ago(item.updatedAt)}</span>
                </button>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {model.elsewhere.length > 0 ? (
        <Section title="Outside the five areas" count={model.elsewhere.length}>
          <ul className={styles.rows}>
            {model.elsewhere.slice(0, 12).map((item) => (
              <li key={item.noteId}>
                <button type="button" className={styles.row} onClick={() => open(item.noteId)}>
                  <Icon name="doc" size={13} className={styles.rowIcon} />
                  <span className={styles.rowName}>{item.name}</span>
                  <span className={styles.rowMeta}>{item.path || 'root'}</span>
                </button>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {dialog}
    </div>
  );
}

function ProjectCard({ project, onOpen }: { project: Project; onOpen: (id: number | null) => void }) {
  return (
    <button
      type="button"
      className={`${styles.card} ${project.blank ? styles.cardBlank : ''}`}
      onClick={() => onOpen(project.noteId)}
    >
      <div className={styles.cardHead}>
        <span className={styles.cardName}>{project.name}</span>
        <Status status={project.status} blank={project.blank} />
      </div>

      <div className={styles.cardSummary}>
        {project.blank ? 'Nobody has filled this in yet.' : project.summary || 'No description.'}
      </div>

      {project.next.length > 0 ? (
        <ul className={styles.next}>
          {project.next.slice(0, 3).map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ul>
      ) : null}

      <div className={styles.cardFoot}>
        <span>
          {project.notes} {project.notes === 1 ? 'note' : 'notes'}
        </span>
        {project.decisions > 0 ? <span>{project.decisions} decided</span> : null}
        {project.done > 0 ? <span>{project.done} done</span> : null}
        <span className={styles.cardWhen}>{ago(project.updatedAt)}</span>
      </div>
    </button>
  );
}

const STATUS_ICON: Record<ProjectStatus, IconName> = {
  active: 'bolt',
  planning: 'target',
  paused: 'clock',
  done: 'check',
  unset: 'circle',
};

function Status({ status, blank }: { status: ProjectStatus; blank: boolean }) {
  const label = blank ? 'new' : status === 'unset' ? 'no status' : status;

  return (
    <span className={`${styles.status} ${styles[`status_${status}`] ?? ''}`}>
      <Icon name={STATUS_ICON[status]} size={10} />
      {label}
    </span>
  );
}

function Section({
  title,
  count,
  action,
  children,
}: {
  title: string;
  count: number;
  action?: { label: string; onClick: () => void } | undefined;
  children: React.ReactNode;
}) {
  return (
    <section className={styles.section}>
      <div className={styles.sectionHead}>
        <span className={styles.sectionTitle}>{title}</span>
        <span className={styles.sectionCount}>{count}</span>
        <span className={styles.sectionSpacer} />
        {action ? (
          <button type="button" className={styles.ghost} onClick={action.onClick}>
            <Icon name="plus" size={12} />
            {action.label}
          </button>
        ) : null}
      </div>
      {children}
    </section>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className={styles.empty}>{children}</div>;
}

/** Coarse on purpose: this view is about what is moving, not about timestamps. */
function ago(iso: string): string {
  if (!iso) return '';

  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60000);

  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)}h`;

  return `${Math.round(minutes / (60 * 24))}d`;
}
