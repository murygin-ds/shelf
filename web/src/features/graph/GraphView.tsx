import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  type Simulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from 'd3-force';
import { useEffect, useMemo, useRef, useState } from 'react';

import { ApiError } from '@/api/client';
import * as graphApi from '@/api/graph';
import { useWorkspace } from '@/store/workspace';

import styles from './graph.module.css';

const WIDTH = 1000;
const HEIGHT = 620;
/** Long enough to settle, short enough that a large vault does not spin for seconds. */
const TICKS = 240;

interface Node extends SimulationNodeDatum {
  ref: string;
  id: number | null;
  name: string;
  locked: boolean;
  degree: number;
}

type Edge = SimulationLinkDatum<Node>;

export function GraphView() {
  const { vaultId, keyring, tree, openNote, setView } = useWorkspace();
  const [graph, setGraph] = useState<graphApi.Graph | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const simulation = useRef<Simulation<Node, Edge> | null>(null);

  useEffect(() => {
    if (vaultId === null || !keyring) return;

    let live = true;

    // Cleared before every attempt: latching the first failure would keep the pane blank
    // long after the graph could be drawn again.
    setError(null);

    graphApi
      .graph(vaultId, keyring)
      .then((next) => {
        if (live) setGraph(next);
      })
      .catch((cause: unknown) => {
        if (live) setError(describe(cause));
      });

    return () => {
      live = false;
    };
  }, [vaultId, keyring]);

  // The layout is computed once per graph and then frozen: a note graph is read, not
  // played with, and a simulation that keeps ticking makes labels impossible to click.
  const laid = useMemo(() => {
    if (!graph) return null;

    const nodes: Node[] = graph.nodes.map((node) => ({ ...node }));
    const byRef = new Map(nodes.map((node) => [node.ref, node]));

    const edges: Edge[] = graph.edges
      .map((edge) => ({ source: byRef.get(edge.from), target: byRef.get(edge.to) }))
      .filter((edge): edge is { source: Node; target: Node } => Boolean(edge.source && edge.target));

    const sim = forceSimulation(nodes)
      .force('link', forceLink<Node, Edge>(edges).distance(90).strength(0.5))
      .force('charge', forceManyBody().strength(-320))
      .force('center', forceCenter(WIDTH / 2, HEIGHT / 2))
      .force('collide', forceCollide(34))
      .stop();

    sim.tick(TICKS);
    simulation.current = sim;

    return { nodes, edges };
  }, [graph]);

  useEffect(
    () => () => {
      simulation.current?.stop();
    },
    [],
  );

  if (error) {
    return (
      <div className={styles.pane}>
        <div className={styles.error}>{error}</div>
      </div>
    );
  }

  if (!graph || !laid) {
    return (
      <div className={styles.pane}>
        <p className={styles.empty}>Drawing the graph…</p>
      </div>
    );
  }

  if (laid.nodes.length === 0) {
    return (
      <div className={styles.pane}>
        <p className={styles.empty}>
          No notes yet. Links appear here once notes reference each other with [[a title]].
        </p>
      </div>
    );
  }

  return (
    <div className={styles.pane}>
      <div className={styles.head}>
        <span className={styles.title}>GRAPH</span>
        <span className={styles.spacer} />
        <span className={styles.legend}>
          {laid.nodes.length} NOTES · {laid.edges.length} LINKS
          {graph.locked > 0 ? ` · ${graph.locked} LOCKED` : ''}
        </span>
      </div>

      <svg className={styles.canvas} viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label="Note graph">
        <g>
          {laid.edges.map((edge, index) => {
            const from = edge.source as Node;
            const to = edge.target as Node;
            const masked = from.locked || to.locked;

            return (
              <line
                key={index}
                x1={from.x ?? 0}
                y1={from.y ?? 0}
                x2={to.x ?? 0}
                y2={to.y ?? 0}
                className={masked ? styles.edgeMasked : styles.edge}
              />
            );
          })}
        </g>

        <g>
          {laid.nodes.map((node) => {
            const radius = 6 + Math.min(node.degree, 8) * 1.6;
            const target = node.id === null ? null : tree.notes.find((n) => n.id === node.id);

            return (
              <g
                key={node.ref}
                transform={`translate(${node.x ?? 0}, ${node.y ?? 0})`}
                className={node.locked ? styles.nodeMasked : styles.node}
                onMouseEnter={() => setHover(node.ref)}
                onMouseLeave={() => setHover(null)}
                onClick={() => {
                  if (!target) return;

                  void openNote(target);
                  setView('editor');
                }}
              >
                <circle r={radius} className={node.locked ? styles.dotMasked : styles.dot} />
                <text y={radius + 13} className={styles.label}>
                  {node.locked ? '••••••' : truncate(node.name)}
                </text>
                {hover === node.ref && !node.locked ? (
                  <title>
                    {node.name} · {node.degree} link{node.degree === 1 ? '' : 's'}
                  </title>
                ) : null}
              </g>
            );
          })}
        </g>
      </svg>

      <p className={styles.note}>
        {graph.revealsLocked
          ? 'Dashed nodes are notes you hold no key for. They are drawn without a name or an id, because a graph that hid them would show connected notes as isolated.'
          : 'This vault does not draw notes you cannot open, so the picture is your slice of the graph rather than its shape.'}
      </p>
    </div>
  );
}

function truncate(name: string): string {
  return name.length > 22 ? `${name.slice(0, 21)}…` : name;
}

function describe(cause: unknown): string {
  if (cause instanceof ApiError) return cause.message || `HTTP ${cause.status}`;
  if (cause instanceof Error) return cause.message || cause.name;

  return 'the graph could not be drawn';
}
