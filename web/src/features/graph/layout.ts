import {
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type Simulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from 'd3-force';

import type { Graph, GraphNode } from '@/api/graph';

/**
 * The graph as geometry, with no DOM in sight.
 *
 * Everything here is a pure function of what the server sent, which is what makes it
 * testable at all: the view around it owns a canvas, a pointer and a simulation running on
 * animation frames, and none of those exist under vitest.
 *
 * The world has no edges. Positions are absolute and centred on the origin, and how much of
 * them is on screen is the viewport's business — the old layout was solved inside a fixed
 * 1000×620 box, which is why a vault past a couple of hundred notes drew a knot with half of
 * itself outside the picture.
 */

export interface LaidNode extends SimulationNodeDatum, GraphNode {}

export type LaidEdge = SimulationLinkDatum<LaidNode>;

export interface Layout {
  nodes: LaidNode[];
  edges: LaidEdge[];
  /** ref → everything one hop away, in either direction. Drives the hover highlight. */
  neighbours: Map<string, Set<string>>;
  /** ref → indices into `edges`, so lighting a node can light its lines without a scan. */
  incident: Map<string, number[]>;
  /** Notes left out for having no links. A number the legend says out loud. */
  hidden: number;
  /** Degree from which a node keeps its name at middle zoom. */
  hub: number;
}

export interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface Forces {
  link: number;
  charge: number;
  chargeMax: number;
  gravity: number;
  ticks: number;
}

/** Radius of one dot. Degree past this many links stops making it bigger. */
const MAX_DEGREE = 24;

/** Roughly how many names may stay lit at middle zoom before they overlap again. */
const HUB_LABELS = 12;

export function nodeRadius(degree: number): number {
  return 4 + Math.sqrt(Math.min(Math.max(degree, 0), MAX_DEGREE)) * 2.4;
}

/**
 * Force constants as a function of how much there is to lay out.
 *
 * A charge that arranges twenty notes pleasantly throws a thousand of them across the plane,
 * and a collision radius that keeps twenty apart is simply larger than the room a thousand
 * have. Both shrink with the square root of the count, which is the rate at which the packed
 * width of the graph grows.
 */
export function forceParams(count: number): Forces {
  const n = Math.max(count, 1);
  const root = Math.sqrt(n);

  return {
    link: 30 + 40 / Math.pow(n, 0.25),
    charge: -(60 + 2600 / root),
    // Without a cutoff every node feels every other one, which is both slower and a worse
    // picture: distant clusters push each other into a ring instead of settling.
    chargeMax: 600,
    gravity: 0.04,
    // Ticks run before the first frame, only to skip the explosion. The rest is animated.
    ticks: Math.min(200, Math.max(60, Math.round(3000 / root))),
  };
}

/**
 * The picture the reader gets, one arrangement of the response.
 *
 * A note with no links is dropped unless asked for. It is the single biggest reason the
 * graph used to be unreadable: the server hands back every note in the vault, linked or not
 * (`graphNodes` selects from `files`, not from `note_links`), so a vault of six hundred notes
 * with forty links drew forty lines inside a cloud of five hundred and sixty loose dots.
 *
 * Degree comes from the server and is never recomputed here: it is already counted over the
 * edges this reader is allowed to see, and a second opinion would disagree with the legend.
 */
export function buildLayout(graph: Graph, opts: { orphans: boolean }): Layout {
  const kept: LaidNode[] = [];
  let hidden = 0;

  for (const node of graph.nodes) {
    if (!opts.orphans && node.degree === 0) {
      hidden += 1;
      continue;
    }

    kept.push({ ...node });
  }

  const byRef = new Map(kept.map((node) => [node.ref, node]));
  const edges: LaidEdge[] = [];
  const neighbours = new Map<string, Set<string>>();
  const incident = new Map<string, number[]>();

  const touch = (ref: string, other: string, index: number) => {
    const near = neighbours.get(ref) ?? new Set<string>();
    near.add(other);
    neighbours.set(ref, near);

    const lines = incident.get(ref) ?? [];
    lines.push(index);
    incident.set(ref, lines);
  };

  for (const edge of graph.edges) {
    const source = byRef.get(edge.from);
    const target = byRef.get(edge.to);

    if (!source || !target) continue;

    const index = edges.length;
    edges.push({ source, target });

    touch(source.ref, target.ref, index);
    touch(target.ref, source.ref, index);
  }

  return { nodes: kept, edges, neighbours, incident, hidden, hub: hubDegree(kept) };
}

/**
 * Where "well connected enough to keep its name at a distance" starts.
 *
 * A fixed threshold is wrong in both directions — in a flat vault nothing reaches it, in a
 * dense one everything does — so it is a quantile: whatever degree the busiest dozen have.
 */
export function hubDegree(nodes: LaidNode[]): number {
  if (nodes.length === 0) return 2;

  const wanted = Math.max(HUB_LABELS, Math.round(nodes.length * 0.08));
  const degrees = nodes.map((node) => node.degree).sort((a, b) => b - a);

  return Math.max(degrees[Math.min(wanted, degrees.length) - 1] ?? 0, 2);
}

/** What the laid-out graph occupies, dots included. Null when there is nothing to bound. */
export function bounds(nodes: LaidNode[]): Box | null {
  let box: Box | null = null;

  for (const node of nodes) {
    const x = node.x ?? 0;
    const y = node.y ?? 0;
    const r = nodeRadius(node.degree);

    if (!box) {
      box = { minX: x - r, minY: y - r, maxX: x + r, maxY: y + r };
      continue;
    }

    box.minX = Math.min(box.minX, x - r);
    box.minY = Math.min(box.minY, y - r);
    box.maxX = Math.max(box.maxX, x + r);
    box.maxY = Math.max(box.maxY, y + r);
  }

  return box;
}

/**
 * The simulation, warmed up but not frozen.
 *
 * `forceX`/`forceY` rather than `forceCenter`: centring is not a pull but a translation of
 * the whole system every tick, and it fights anything held in place — a node the reader is
 * dragging would slide out from under the pointer as its neighbours settle.
 */
export function simulate(layout: Layout): Simulation<LaidNode, LaidEdge> {
  const forces = forceParams(layout.nodes.length);

  const sim = forceSimulation(layout.nodes)
    .force('link', forceLink<LaidNode, LaidEdge>(layout.edges).distance(forces.link).strength(0.6))
    .force('charge', forceManyBody<LaidNode>().strength(forces.charge).distanceMax(forces.chargeMax))
    .force('x', forceX<LaidNode>(0).strength(forces.gravity))
    .force('y', forceY<LaidNode>(0).strength(forces.gravity))
    .force(
      'collide',
      forceCollide<LaidNode>((node) => nodeRadius(node.degree) + 5).iterations(2),
    )
    .stop();

  sim.tick(forces.ticks);

  return sim;
}
