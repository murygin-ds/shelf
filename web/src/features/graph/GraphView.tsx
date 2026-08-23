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

import { describe } from '@/api/errors';
import * as graphApi from '@/api/graph';
import { m } from '@/i18n';
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
        <p className={styles.empty}>{m.views.graph.drawing}</p>
      </div>
    );
  }

  if (laid.nodes.length === 0) {
    return (
      <div className={styles.pane}>
        <p className={styles.empty}>{m.views.graph.empty}</p>
      </div>
    );
  }

  return (
    <div className={styles.pane}>
      <div className={styles.head}>
        <span className={styles.title}>{m.views.graph.title}</span>
        <span className={styles.spacer} />
        <span className={styles.legend}>
          {graph.locked > 0
            ? m.views.graph.legendLocked(laid.nodes.length, laid.edges.length, graph.locked)
            : m.views.graph.legend(laid.nodes.length, laid.edges.length)}
        </span>
      </div>

      <svg
        className={styles.canvas}
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        role="img"
        aria-label={m.views.graph.canvas}
      >
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
                  <title>{m.views.graph.node(node.name, node.degree)}</title>
                ) : null}
              </g>
            );
          })}
        </g>
      </svg>

      <p className={styles.note}>
        {graph.revealsLocked ? m.views.graph.revealsLocked : m.views.graph.hidesLocked}
      </p>
    </div>
  );
}

function truncate(name: string): string {
  return name.length > 22 ? `${name.slice(0, 21)}…` : name;
}
