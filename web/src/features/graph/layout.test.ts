import { describe, expect, it } from 'vitest';

import type { Graph } from '@/api/graph';

import { bounds, buildLayout, forceParams, hubDegree, nodeRadius, simulate } from './layout';

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

describe('hubDegree', () => {
  it('is a quantile rather than a constant, and never below two', () => {
    const flat = buildLayout(make({ a: 1, b: 1 }, [['a', 'b']]), { orphans: false });

    expect(hubDegree(flat.nodes)).toBe(2);
    expect(hubDegree([])).toBe(2);
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
