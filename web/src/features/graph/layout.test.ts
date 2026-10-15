import { describe, expect, it } from 'vitest';

import type { Graph } from '@/api/graph';
import type { FolderNode, NoteNode, Tree } from '@/api/workspace';

import {
  bounds,
  buildLayout,
  forceGroup,
  forceParams,
  linkDistance,
  linkStrength,
  neighbourhood,
  nodeCharge,
  nodeRadius,
  placeNodes,
  simulate,
} from './layout';

function make(degrees: Record<string, number>, edges: Array<[string, string]>): Graph {
  return {
    nodes: Object.entries(degrees).map(([ref, degree], index) => ({
      ref,
      id: index + 1,
      name: `note ${ref}`,
      locked: false,
      degree,
    })),
    edges: edges.map(([from, to]) => ({ from, to })),
    locked: 0,
    revealsLocked: true,
  };
}

describe('buildLayout', () => {
  it('leaves out notes nothing links to, and says how many', () => {
    const laid = buildLayout(make({ a: 1, b: 1, c: 0, d: 0 }, [['a', 'b']]), { orphans: false });

    expect(laid.nodes.map((node) => node.ref)).toEqual(['a', 'b']);
    expect(laid.hidden).toBe(2);
  });

  it('draws them when asked, and then hides nothing', () => {
    const laid = buildLayout(make({ a: 1, b: 1, c: 0 }, [['a', 'b']]), { orphans: true });

    expect(laid.nodes).toHaveLength(3);
    expect(laid.hidden).toBe(0);
  });

  it('drops an edge whose other end is not in the picture', () => {
    // Degree and edges disagreeing is not something the server sends; the filter still may
    // not leave a line pointing at a node that was never laid out.
    const laid = buildLayout(make({ a: 1, b: 0 }, [['a', 'b']]), { orphans: false });

    expect(laid.nodes.map((node) => node.ref)).toEqual(['a']);
    expect(laid.edges).toEqual([]);
  });

  it('reads neighbours in both directions, whichever way the link was written', () => {
    const laid = buildLayout(make({ a: 1, b: 2, c: 1 }, [['a', 'b'], ['c', 'b']]), {
      orphans: false,
    });

    expect([...(laid.neighbours.get('b') ?? [])].sort()).toEqual(['a', 'c']);
    expect([...(laid.neighbours.get('a') ?? [])]).toEqual(['b']);
    expect(laid.incident.get('b')).toEqual([0, 1]);
    expect(laid.incident.get('a')).toEqual([0]);
  });

  it('copies the nodes rather than laying out the response in place', () => {
    const graph = make({ a: 1, b: 1 }, [['a', 'b']]);
    const laid = buildLayout(graph, { orphans: false });

    simulate(laid);

    expect(graph.nodes[0]).not.toHaveProperty('x');
  });
});

describe('nodeRadius', () => {
  it('grows with degree and then stops', () => {
    expect(nodeRadius(0)).toBeLessThan(nodeRadius(1));
    expect(nodeRadius(1)).toBeLessThan(nodeRadius(9));
    expect(nodeRadius(24)).toBe(nodeRadius(400));
  });

  it('is a real radius for a note with no links at all', () => {
    expect(nodeRadius(0)).toBeGreaterThan(0);
  });
});

describe('forceParams', () => {
  it('loosens its grip as the graph grows', () => {
    const small = forceParams(20);
    const large = forceParams(2000);

    expect(Math.abs(large.charge)).toBeLessThan(Math.abs(small.charge));
    expect(large.link).toBeLessThan(small.link);
    expect(large.ticks).toBeLessThan(small.ticks);
  });

  it('survives an empty graph', () => {
    expect(Number.isFinite(forceParams(0).charge)).toBe(true);
  });
});

describe('link forces', () => {
  it('give a hub a longer reach, so its neighbours have room around it', () => {
    expect(linkDistance(40, 100)).toBeGreaterThan(linkDistance(40, 4));
    expect(linkDistance(40, 0)).toBe(40);
  });

  it('pull a line into a hub more weakly than a line between two quiet notes', () => {
    expect(linkStrength(2, 100)).toBeLessThan(linkStrength(2, 2));
    expect(linkStrength(1, 1)).toBe(1);
    expect(linkStrength(0, 0)).toBe(1);
  });

  it('push harder from a hub, and never flip the sign', () => {
    expect(nodeCharge(-100, 25)).toBeLessThan(nodeCharge(-100, 1));
    expect(nodeCharge(-100, 0)).toBe(-100);
  });
});

/** Folders as `[id, name, parent]`, notes as `id → folder`; ids match `make`'s order. */
function tree(folders: Array<[number, string, number | null]>, notes: Record<number, number | null>): Tree {
  return {
    folders: folders.map(([id, name, parentId]) => ({ id, name, parentId }) as FolderNode),
    notes: Object.entries(notes).map(([id, folderId]) => ({ id: Number(id), folderId }) as NoteNode),
  };
}

describe('placeNodes', () => {
  const graph = make({ a: 1, b: 1, c: 1, d: 1, e: 1 }, []);

  it('groups by top-level folder, largest first', () => {
    const { kept, groups } = placeNodes(
      graph.nodes,
      tree([[1, 'work', null], [2, 'home', null]], { 1: 1, 2: 1, 3: 2, 4: null, 5: 1 }),
    );

    expect(groups).toEqual([{ name: 'work', count: 3 }, { name: 'home', count: 1 }]);
    expect(kept.map((node) => node.group)).toEqual([0, 0, 1, -1, 0]);
  });

  it('splits a folder that holds most of the picture into its subfolders', () => {
    const { groups } = placeNodes(
      graph.nodes,
      tree(
        [[1, 'projects', null], [2, 'shelf', 1], [3, 'wb', 1], [4, 'memory', null]],
        { 1: 2, 2: 2, 3: 3, 4: 3, 5: 4 },
      ),
    );

    expect(groups.map((group) => group.name)).toEqual(['shelf', 'wb', 'memory']);
  });

  it('keeps one big folder whole when it has nothing to split into', () => {
    const { groups } = placeNodes(
      graph.nodes,
      tree([[1, 'notes', null], [2, 'old', 1]], { 1: 1, 2: 1, 3: 1, 4: 2, 5: null }),
    );

    expect(groups.map((group) => group.name)).toEqual(['notes']);
  });

  it('names a repeated note by its folder, and leaves a unique one alone', () => {
    const named = make({ a: 1, b: 1, c: 1 }, []);
    named.nodes[0]!.name = 'CLAUDE.md';
    named.nodes[1]!.name = 'CLAUDE.md';

    const { kept } = placeNodes(
      named.nodes,
      tree([[1, 'shelf', null], [2, 'wb', null]], { 1: 1, 2: 2, 3: 1 }),
    );

    expect(kept.map((node) => node.caption)).toEqual(['shelf/CLAUDE.md', 'wb/CLAUDE.md', 'note c']);
    expect(kept[0]?.path).toBe('shelf/CLAUDE.md');
  });

  it('puts every note at the root when there is no tree to ask', () => {
    const { kept, groups } = placeNodes(graph.nodes, null);

    expect(groups).toEqual([]);
    expect(kept.every((node) => node.group === -1)).toBe(true);
  });

  it('survives a parent cycle', () => {
    const { kept } = placeNodes(graph.nodes.slice(0, 1), tree([[1, 'a', 2], [2, 'b', 1]], { 1: 1 }));

    expect(kept).toHaveLength(1);
  });
});

describe('forceGroup', () => {
  it('pulls a note towards the middle of its own folder only', () => {
    const laid = buildLayout(make({ a: 1, b: 1, c: 1 }, []), { orphans: true });
    const [a, b, c] = laid.nodes;
    if (!a || !b || !c) throw new Error('three nodes expected');

    Object.assign(a, { x: 0, y: 0, vx: 0, vy: 0, group: 0 });
    Object.assign(b, { x: 100, y: 0, vx: 0, vy: 0, group: 0 });
    Object.assign(c, { x: 500, y: 0, vx: 0, vy: 0, group: -1 });

    const force = forceGroup(0.1);
    force.initialize(laid.nodes);
    force(1);

    expect(a.vx).toBeGreaterThan(0);
    expect(b.vx).toBeLessThan(0);
    expect(c.vx).toBe(0);
  });
});

describe('neighbourhood', () => {
  const chain = [
    { from: 'a', to: 'b' },
    { from: 'c', to: 'b' },
    { from: 'c', to: 'd' },
  ];

  it('walks links in both directions, one step per unit of depth', () => {
    expect([...neighbourhood(chain, 'b', 1)].sort()).toEqual(['a', 'b', 'c']);
    expect([...neighbourhood(chain, 'b', 2)].sort()).toEqual(['a', 'b', 'c', 'd']);
  });

  it('is the centre alone at depth zero or with nothing linked', () => {
    expect([...neighbourhood(chain, 'b', 0)]).toEqual(['b']);
    expect([...neighbourhood(chain, 'z', 3)]).toEqual(['z']);
  });

  it('stops at a cycle instead of going round it', () => {
    const ring = [
      { from: 'a', to: 'b' },
      { from: 'b', to: 'a' },
    ];

    expect([...neighbourhood(ring, 'a', 5)].sort()).toEqual(['a', 'b']);
  });
});

describe('buildLayout around a note', () => {
  const graph = make({ a: 1, b: 2, c: 2, d: 1 }, [['a', 'b'], ['b', 'c'], ['c', 'd']]);
  const folders = tree([[1, 'x', null], [2, 'y', null]], { 1: 1, 2: 1, 3: 2, 4: 2 });

  it('keeps only what is within reach, and says whose graph it is', () => {
    const laid = buildLayout(graph, { orphans: false, around: { ref: 'a', depth: 1 } });

    expect(laid.nodes.map((node) => node.ref)).toEqual(['a', 'b']);
    expect(laid.edges).toHaveLength(1);
    expect(laid.centre).toBe('a');
  });

  it('keeps every folder its colour, and counts only what is drawn', () => {
    const whole = buildLayout(graph, { orphans: false, tree: folders });
    const local = buildLayout(graph, {
      orphans: false,
      tree: folders,
      around: { ref: 'd', depth: 1 },
    });

    expect(local.groups.map((group) => group.name)).toEqual(whole.groups.map((group) => group.name));
    expect(local.nodes.every((node) => node.group === whole.nodes.find((n) => n.ref === node.ref)?.group)).toBe(true);
    expect(local.groups.map((group) => group.count)).toEqual([0, 2]);
  });

  it('falls back to the whole graph when the centre is not in the picture', () => {
    const laid = buildLayout(make({ a: 1, b: 1, z: 0 }, [['a', 'b']]), {
      orphans: false,
      around: { ref: 'z', depth: 1 },
    });

    expect(laid.centre).toBeNull();
    expect(laid.nodes).toHaveLength(2);
    expect(laid.hidden).toBe(1);
  });
});

describe('bounds', () => {
  it('is nothing when there is nothing to bound', () => {
    expect(bounds([])).toBeNull();
  });

  it('leaves room for the dot itself, not just its centre', () => {
    const laid = buildLayout(make({ a: 1, b: 1 }, [['a', 'b']]), { orphans: false });
    const [first, second] = laid.nodes;

    if (!first || !second) throw new Error('two nodes expected');

    first.x = 0;
    first.y = 0;
    second.x = 100;
    second.y = 0;

    const box = bounds(laid.nodes);

    expect(box?.minX).toBeLessThan(0);
    expect(box?.maxX).toBeGreaterThan(100);
  });
});

describe('simulate', () => {
  it('arranges every node at a real position', () => {
    const laid = buildLayout(make({ a: 2, b: 2, c: 2, d: 2 }, [['a', 'b'], ['b', 'c'], ['c', 'd'], ['d', 'a']]), {
      orphans: false,
    });

    simulate(laid).stop();

    for (const node of laid.nodes) {
      expect(Number.isFinite(node.x ?? Number.NaN)).toBe(true);
      expect(Number.isFinite(node.y ?? Number.NaN)).toBe(true);
    }
  });

  it('keeps two linked notes apart rather than on top of each other', () => {
    const laid = buildLayout(make({ a: 1, b: 1 }, [['a', 'b']]), { orphans: false });

    simulate(laid).stop();

    const [first, second] = laid.nodes;
    if (!first || !second) throw new Error('two nodes expected');

    const apart = Math.hypot((first.x ?? 0) - (second.x ?? 0), (first.y ?? 0) - (second.y ?? 0));

    expect(apart).toBeGreaterThan(nodeRadius(1) * 2);
  });
});
