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
import type { Tree } from '@/api/workspace';

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

export interface LaidNode extends SimulationNodeDatum, GraphNode {
  /** Index into `Layout.groups`, or -1 for a note at the vault root or one nobody can see. */
  group: number;
  /** The name under the dot: the note's own, or with its folder when the name repeats. */
  caption: string;
  /** Folders and name, for the tooltip. */
  path: string;
}

/** A folder the picture is coloured by. */
export interface Group {
  name: string;
  count: number;
}

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
  /**
   * Largest first over the whole graph, which is also the order colours are handed out in.
   * Counts are over what is drawn, so a local graph lists only the folders it reaches.
   */
  groups: Group[];
  /** The note a local graph is drawn around; null for the whole graph. */
  centre: string | null;
}

/** A local graph: one note and whatever is within `depth` links of it. */
export interface Around {
  ref: string;
  depth: number;
}

export const MAX_DEPTH = 3;

export interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface Forces {
  cohesion: number;
  link: number;
  charge: number;
  chargeMax: number;
  gravity: number;
  ticks: number;
}

/** Radius of one dot. Degree past this many links stops making it bigger. */
const MAX_DEGREE = 24;

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
    cohesion: 0.12,
    link: 30 + 40 / Math.pow(n, 0.25),
    charge: -(60 + 2600 / root),
    // Without a cutoff every node feels every other one, which is both slower and a worse
    // picture: distant clusters push each other into a ring instead of settling.
    chargeMax: 600,
    // Enough to bring a stray two-note island back next to the rest: otherwise fitting the
    // view to it shrinks the main graph to a dot in the middle of an empty panel.
    gravity: 0.06,
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
export function buildLayout(
  graph: Graph,
  opts: { orphans: boolean; tree?: Tree | null; around?: Around | null },
): Layout {
  const visible: GraphNode[] = [];
  let hidden = 0;

  for (const node of graph.nodes) {
    if (!opts.orphans && node.degree === 0) {
      hidden += 1;
      continue;
    }

    visible.push(node);
  }

  // Placed over the whole picture before any cut, so a folder keeps its colour and a name
  // keeps its prefix when the reader steps into a local graph and back out.
  const placed = placeNodes(visible, opts.tree ?? null);
  const around = opts.around ?? null;
  const centre =
    around && placed.kept.some((node) => node.ref === around.ref) ? around.ref : null;

  let kept = placed.kept;
  let groups = placed.groups;

  if (around && centre !== null) {
    const near = neighbourhood(graph.edges, centre, around.depth);

    kept = kept.filter((node) => near.has(node.ref));
    groups = groups.map((group, index) => ({
      ...group,
      count: kept.filter((node) => node.group === index).length,
    }));
    // The unlinked notes are not "left out" of a picture that was never meant to hold them.
    hidden = 0;
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

  return { nodes: kept, edges, neighbours, incident, hidden, groups, centre };
}

/**
 * Every note within `depth` links of `centre`, in either direction, the centre included.
 *
 * Direction is ignored for the same reason the hover highlight ignores it: "what is this
 * note about" is answered as much by what points at it as by what it points at.
 */
export function neighbourhood(
  edges: ReadonlyArray<{ from: string; to: string }>,
  centre: string,
  depth: number,
): Set<string> {
  const adjacent = new Map<string, string[]>();
  const join = (a: string, b: string) => {
    const list = adjacent.get(a);
    if (list) list.push(b);
    else adjacent.set(a, [b]);
  };

  for (const edge of edges) {
    join(edge.from, edge.to);
    join(edge.to, edge.from);
  }

  const reached = new Set([centre]);
  let frontier = [centre];

  for (let step = 0; step < depth && frontier.length > 0; step += 1) {
    const next: string[] = [];

    for (const ref of frontier) {
      for (const other of adjacent.get(ref) ?? []) {
        if (reached.has(other)) continue;

        reached.add(other);
        next.push(other);
      }
    }

    frontier = next;
  }

  return reached;
}

/** Past this many, folders stop getting a colour of their own: twenty hues are not a key. */
export const MAX_GROUPS = 10;

/**
 * Which folder each note belongs to, and what to call it.
 *
 * The graph response carries no folders, so they come from the tree the tab already holds.
 * The group is the top-level folder, except for one that holds most of the picture across
 * several subfolders — a `projects/` with a folder per project — which is split into those
 * subfolders: colouring everything one colour says nothing.
 *
 * Names repeat a lot in a vault laid out by convention (every project has a `CLAUDE.md`), and
 * ten dots called the same thing are no map at all, so a repeated name carries its folder.
 */
export function placeNodes(
  nodes: GraphNode[],
  tree: Tree | null,
): { kept: LaidNode[]; groups: Group[] } {
  const folders = new Map((tree?.folders ?? []).map((folder) => [folder.id, folder]));
  const folderOf = new Map((tree?.notes ?? []).map((note) => [note.id, note.folderId]));

  const chainOf = (node: GraphNode): number[] => {
    const chain: number[] = [];
    const seen = new Set<number>();
    let at = node.id === null ? null : (folderOf.get(node.id) ?? null);

    // A parent cycle is not something the server allows; the walk still may not hang on one.
    while (at !== null && !seen.has(at)) {
      seen.add(at);
      chain.unshift(at);
      at = folders.get(at)?.parentId ?? null;
    }

    return chain;
  };

  const chains = nodes.map((node) => (node.locked ? [] : chainOf(node)));

  const perTop = new Map<number, { count: number; children: Set<number> }>();
  for (const chain of chains) {
    const [top, child] = chain;
    if (top === undefined) continue;

    const entry = perTop.get(top) ?? { count: 0, children: new Set<number>() };
    entry.count += 1;
    if (child !== undefined) entry.children.add(child);
    perTop.set(top, entry);
  }

  const split = new Set<number>();
  for (const [top, entry] of perTop) {
    if (entry.count * 2 > nodes.length && entry.children.size >= 2) split.add(top);
  }

  const groupFolder = chains.map((chain) => {
    const [top, child] = chain;
    if (top === undefined) return null;

    return split.has(top) && child !== undefined ? child : top;
  });

  const counts = new Map<number, number>();
  for (const folder of groupFolder) {
    if (folder !== null) counts.set(folder, (counts.get(folder) ?? 0) + 1);
  }

  const name = (id: number) => folders.get(id)?.name ?? '';
  const ordered = [...counts.entries()].sort(
    (a, b) => b[1] - a[1] || name(a[0]).localeCompare(name(b[0])),
  );
  const index = new Map(ordered.map(([folder], at) => [folder, at]));
  const groups = ordered.map(([folder, count]) => ({ name: name(folder), count }));

  const seen = new Map<string, number>();
  for (const node of nodes) {
    if (!node.locked) seen.set(node.name, (seen.get(node.name) ?? 0) + 1);
  }

  const kept = nodes.map((node, at): LaidNode => {
    const chain = chains[at] ?? [];
    const folder = groupFolder[at] ?? null;
    const parent = chain[chain.length - 1];
    const repeated = (seen.get(node.name) ?? 0) > 1;

    return {
      ...node,
      group: folder === null ? -1 : (index.get(folder) ?? -1),
      caption: captionOf(node, repeated && parent !== undefined ? name(parent) : null),
      path: [...chain.map(name), node.name].join('/'),
    };
  });

  return { kept, groups };
}

function captionOf(node: GraphNode, folder: string | null): string {
  if (node.locked) return '••••••';

  const own = clip(node.name, 22);

  return folder ? `${clip(folder, 12)}/${own}` : own;
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
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
 * How long a line is, given the busier of its two ends.
 *
 * A hub's neighbours have to sit on a ring around it, and the ring has to be long enough to
 * hold them: its circumference grows with the count, so its radius cannot stay fixed.
 */
export function linkDistance(base: number, busiest: number): number {
  return base + Math.sqrt(Math.max(busiest, 0)) * 7;
}

/**
 * How hard a line pulls, given how many lines each of its ends has.
 *
 * A constant pull is what turned a vault with one index note into a ball: a note linked to
 * from a hundred others is pulled a hundred times as hard as each of them, and drags them all
 * into one knot on top of itself. Weakening a line by both ends rather than by the quieter one
 * (d3's default) also lets a note settle by its local links instead of by the index that
 * lists it along with everything else, which is what makes clusters visible at all.
 */
export function linkStrength(from: number, to: number): number {
  return 1 / Math.sqrt(Math.max(from, 1) * Math.max(to, 1));
}

/** Hubs push harder, so the clusters around them do not grow into each other. */
export function nodeCharge(base: number, links: number): number {
  return base * (1 + Math.sqrt(Math.max(links, 0)) / 3);
}

/**
 * Starting positions: each folder on its own spoke of a wheel, so groups begin apart instead
 * of having to untangle out of one phyllotaxis spiral — which the warm-up ticks are too few
 * to do, and which is how one project's notes ended up threaded through another's.
 */
function seed(nodes: LaidNode[], groups: number, radius: number): void {
  const slots = groups + 1;

  nodes.forEach((node, index) => {
    if (node.x !== undefined && node.y !== undefined) return;

    const slot = node.group < 0 ? 0 : node.group + 1;
    const angle = (slot / slots) * Math.PI * 2;
    const reach = slot === 0 ? 0 : radius;
    // Golden-angle spiral inside the slot, so two notes never start on the same point.
    const spin = index * 2.39996;
    const spread = 10 * Math.sqrt(index + 1);

    node.x = Math.cos(angle) * reach + Math.cos(spin) * spread;
    node.y = Math.sin(angle) * reach + Math.sin(spin) * spread;
  });
}

/**
 * A pull towards the middle of the note's own folder, wherever that middle currently is.
 *
 * Links alone group a vault only as well as it is linked; a project whose notes all point at
 * a shared index would otherwise be scattered round that index with everybody else's.
 */
export function forceGroup(strength: number) {
  let nodes: LaidNode[] = [];

  const force = (alpha: number) => {
    const sums = new Map<number, { x: number; y: number; n: number }>();

    for (const node of nodes) {
      if (node.group < 0) continue;

      const sum = sums.get(node.group) ?? { x: 0, y: 0, n: 0 };
      sum.x += node.x ?? 0;
      sum.y += node.y ?? 0;
      sum.n += 1;
      sums.set(node.group, sum);
    }

    const pull = strength * alpha;

    for (const node of nodes) {
      const sum = node.group < 0 ? undefined : sums.get(node.group);
      if (!sum || sum.n < 2) continue;

      node.vx = (node.vx ?? 0) + (sum.x / sum.n - (node.x ?? 0)) * pull;
      node.vy = (node.vy ?? 0) + (sum.y / sum.n - (node.y ?? 0)) * pull;
    }
  };

  force.initialize = (next: LaidNode[]) => {
    nodes = next;
  };

  return force;
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

  seed(layout.nodes, layout.groups.length, forces.link * Math.sqrt(layout.nodes.length) * 0.6);

  const links = (node: LaidNode) => layout.incident.get(node.ref)?.length ?? 0;
  const ends = (edge: LaidEdge): [number, number] => [
    links(edge.source as LaidNode),
    links(edge.target as LaidNode),
  ];

  const sim = forceSimulation(layout.nodes)
    .force(
      'link',
      forceLink<LaidNode, LaidEdge>(layout.edges)
        .distance((edge) => linkDistance(forces.link, Math.max(...ends(edge))))
        .strength((edge) => linkStrength(...ends(edge))),
    )
    .force(
      'charge',
      forceManyBody<LaidNode>()
        .strength((node) => nodeCharge(forces.charge, links(node)))
        .distanceMax(forces.chargeMax),
    )
    .force('x', forceX<LaidNode>(0).strength(forces.gravity))
    .force('y', forceY<LaidNode>(0).strength(forces.gravity))
    .force('group', forceGroup(forces.cohesion))
    .force(
      'collide',
      forceCollide<LaidNode>((node) => nodeRadius(node.degree) + 7).iterations(2),
    )
    .stop();

  sim.tick(forces.ticks);

  return sim;
}
