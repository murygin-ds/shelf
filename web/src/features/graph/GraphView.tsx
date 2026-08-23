import { useEffect, useMemo, useRef, useState } from 'react';

import { describe } from '@/api/errors';
import * as graphApi from '@/api/graph';
import { m } from '@/i18n';
import { usePrefs } from '@/store/prefs';
import { useWorkspace } from '@/store/workspace';
import { Icon } from '@/ui/Icon';
import { tip } from '@/ui/Tooltip';

import styles from './graph.module.css';
import { bounds, buildLayout, nodeRadius, simulate, type LaidNode } from './layout';
import {
  fit,
  IDENTITY,
  labelTier,
  pan,
  recentre,
  toWorld,
  transform,
  zoomAt,
  type Size,
  type View,
} from './viewport';

/** How far the hand travels before a press becomes a drag rather than a click. */
const DRAG_SLOP_PX = 4;

/** One press of the zoom buttons, and one press of `+` or `-`. */
const ZOOM_STEP = 1.35;

/** Room left around the graph when it is fitted to the panel. */
const FIT_PADDING = 44;

export function GraphView() {
  const vaultId = useWorkspace((state) => state.vaultId);
  const keyring = useWorkspace((state) => state.keyring);

  const [graph, setGraph] = useState<graphApi.Graph | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  if (error) {
    return (
      <div className={styles.pane}>
        <div className={styles.error}>{error}</div>
      </div>
    );
  }

  if (!graph) {
    return (
      <div className={styles.pane}>
        <p className={styles.empty}>{m.views.graph.drawing}</p>
      </div>
    );
  }

  if (graph.nodes.length === 0) {
    return (
      <div className={styles.pane}>
        <p className={styles.empty}>{m.views.graph.empty}</p>
      </div>
    );
  }

  return <Canvas graph={graph} />;
}

interface Controls {
  zoom: (factor: number) => void;
  fit: () => void;
  reset: () => void;
}

/**
 * The drawing, and everything that happens to it.
 *
 * React owns the shape of the picture — one `<line>` per edge, one `<g>` per note, rendered
 * once per arrangement — and nothing else. Positions, the viewport transform and the hover
 * highlight are written straight onto those elements, because all three change tens of times
 * a second and a state update per change would re-render the whole graph each time. The
 * elements are found once with `querySelectorAll` rather than collected through a ref
 * callback per node: document order is the order they were mapped in, and an array of refs
 * would be one more thing to keep in step with a list whose length changes.
 */
function Canvas({ graph }: { graph: graphApi.Graph }) {
  const orphans = usePrefs((state) => state.graphOrphans);
  const setOrphans = usePrefs((state) => state.setGraphOrphans);

  const layout = useMemo(() => buildLayout(graph, { orphans }), [graph, orphans]);

  const canvas = useRef<SVGSVGElement>(null);
  const world = useRef<SVGGElement>(null);
  const view = useRef<View>(IDENTITY);
  const size = useRef<Size>({ width: 0, height: 0 });
  const box = useRef<DOMRect | null>(null);
  const controls = useRef<Controls | null>(null);

  useEffect(() => {
    const svg = canvas.current;
    const layer = world.current;
    if (!svg || !layer) return;

    const { nodes, edges } = layout;

    const dots = Array.from(layer.querySelectorAll<SVGGElement>('[data-ref]'));
    const lines = Array.from(layer.querySelectorAll<SVGLineElement>('[data-edge]'));

    const byRef = new Map<string, SVGGElement>();
    dots.forEach((dot, index) => {
      const ref = nodes[index]?.ref;
      if (ref !== undefined) byRef.set(ref, dot);
    });

    const sim = simulate(layout);

    const round = (value: number) => Math.round(value * 10) / 10;

    const paint = () => {
      for (let index = 0; index < nodes.length; index += 1) {
        const node = nodes[index];
        const dot = dots[index];
        if (!node || !dot) continue;

        dot.setAttribute('transform', `translate(${round(node.x ?? 0)},${round(node.y ?? 0)})`);
      }

      for (let index = 0; index < edges.length; index += 1) {
        const edge = edges[index];
        const line = lines[index];
        if (!edge || !line) continue;

        const from = edge.source as LaidNode;
        const to = edge.target as LaidNode;

        line.setAttribute('x1', String(round(from.x ?? 0)));
        line.setAttribute('y1', String(round(from.y ?? 0)));
        line.setAttribute('x2', String(round(to.x ?? 0)));
        line.setAttribute('y2', String(round(to.y ?? 0)));
      }
    };

    const show = () => {
      layer.setAttribute('transform', transform(view.current));
      svg.dataset.labels = labelTier(view.current.k);
    };

    const toFit = () => {
      view.current = fit(bounds(nodes), size.current, FIT_PADDING);
      show();
    };

    let animating = 0;

    // The camera tracks the graph while it settles — a layout fitted on the first frame is
    // fitted to a knot that then unfolds past the edges — and lets go the moment the reader
    // touches it, because a view that keeps recentring under the hand cannot be aimed.
    let following = true;

    // The simulation is ticked by hand rather than by d3's own timer: the same loop that
    // advances it is the one that writes the frame, and it has to stop on its own once the
    // graph is at rest — a layout that never settles makes every label a moving target.
    const step = () => {
      animating = 0;
      sim.tick();
      paint();

      if (following) toFit();

      if (sim.alpha() > sim.alphaMin()) animating = requestAnimationFrame(step);
    };

    const wake = () => {
      if (animating === 0) animating = requestAnimationFrame(step);
    };

    const measure = () => {
      const rect = svg.getBoundingClientRect();
      box.current = rect;

      return { width: rect.width, height: rect.height };
    };

    size.current = measure();
    toFit();
    paint();
    wake();

    const observer = new ResizeObserver(() => {
      const next = measure();

      if (size.current.width > 0 && next.width > 0) {
        view.current = recentre(view.current, size.current, next);
      }

      size.current = next;
      show();
    });

    observer.observe(svg);

    const local = (event: { clientX: number; clientY: number }) => {
      const rect = box.current ?? svg.getBoundingClientRect();

      return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    };

    const hit = (target: EventTarget | null): number => {
      const group = (target as Element | null)?.closest?.<SVGGElement>('[data-ref]');
      const index = group ? Number(group.dataset.index) : Number.NaN;

      return Number.isInteger(index) ? index : -1;
    };

    const pin = (index: number, on: boolean) => {
      const dot = dots[index];
      if (!dot) return;

      if (on) dot.dataset.pinned = '1';
      else delete dot.dataset.pinned;
    };

    const glow: Element[] = [];
    let lit: string | null = null;

    /** The hovered note, what it touches, and the lines between — everything else dims. */
    const highlight = (ref: string | null) => {
      if (ref === lit) return;
      lit = ref;

      for (const element of glow) element.removeAttribute('data-lit');
      glow.length = 0;

      if (ref === null) {
        delete svg.dataset.dim;
        return;
      }

      const own = byRef.get(ref);
      if (own) glow.push(own);

      for (const near of layout.neighbours.get(ref) ?? []) {
        const dot = byRef.get(near);
        if (dot) glow.push(dot);
      }

      for (const at of layout.incident.get(ref) ?? []) {
        const line = lines[at];
        if (line) glow.push(line);
      }

      for (const element of glow) element.setAttribute('data-lit', '1');
      svg.dataset.dim = '1';
    };

    // A gesture that is still running when the arrangement changes under it has to end, so
    // its window listeners are reachable from the cleanup below.
    let gesture: (() => void) | null = null;

    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return;

      following = false;

      const index = hit(event.target);
      const node = index >= 0 ? nodes[index] : undefined;
      const start = { x: event.clientX, y: event.clientY };
      const from = view.current;
      let armed = false;

      const carry = (moved: PointerEvent) => {
        if (
          !armed &&
          Math.abs(moved.clientX - start.x) < DRAG_SLOP_PX &&
          Math.abs(moved.clientY - start.y) < DRAG_SLOP_PX
        ) {
          return;
        }

        if (!armed) {
          armed = true;
          svg.dataset.grabbing = '1';

          if (node) {
            sim.alphaTarget(0.3);
            wake();
          }
        }

        if (node) {
          const at = toWorld(view.current, local(moved));

          node.fx = at.x;
          node.fy = at.y;
        } else {
          view.current = pan(from, moved.clientX - start.x, moved.clientY - start.y);
          show();
        }
      };

      const release = () => {
        stop();

        // A press that never became a drag is a click, and the note under it opens.
        if (!armed) {
          if (node && node.id !== null && !node.locked) open(node.id);
          return;
        }

        if (!node) return;

        // Where the hand left it is where it stays. An arrangement somebody made by hand is
        // the one thing a force layout cannot produce, and dropping it back into the
        // simulation would undo the move as the reader watches. Releasing one note again is
        // the button rather than a second gesture: a press on a note already opens it, so
        // anything built on a second press would have to delay every open to tell them
        // apart.
        pin(index, true);
        sim.alphaTarget(0);
        wake();
      };

      // A cancelled pointer is the system taking the hand away mid-drag; the note goes back
      // to the simulation rather than staying wherever it happened to be.
      const abandon = () => {
        stop();

        if (!node || !armed) return;

        node.fx = null;
        node.fy = null;
        sim.alphaTarget(0);
        wake();
      };

      // Last, and an arrow rather than a declaration: a hoisted function is one TypeScript
      // assumes could run before the null check at the top of the effect, and inside it the
      // canvas is `SVGSVGElement | null` again.
      const stop = () => {
        window.removeEventListener('pointermove', carry);
        window.removeEventListener('pointerup', release);
        window.removeEventListener('pointercancel', abandon);

        delete svg.dataset.grabbing;
        gesture = null;
      };

      gesture = stop;

      window.addEventListener('pointermove', carry);
      window.addEventListener('pointerup', release);
      window.addEventListener('pointercancel', abandon);
    };

    const onWheel = (event: WheelEvent) => {
      // React registers `onWheel` passively at the root, where `preventDefault` is ignored
      // and the shell scrolls instead of the graph zooming — hence the native listener.
      event.preventDefault();
      following = false;

      // A trackpad pinch arrives as a wheel with ctrl held; line-mode deltas are a handful
      // of units where pixel-mode deltas are a hundred.
      const delta = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
      const factor = Math.exp(-delta * (event.ctrlKey ? 0.01 : 0.002));

      view.current = zoomAt(view.current, local(event), factor);
      show();
    };

    const onOver = (event: PointerEvent) => {
      const index = hit(event.target);

      highlight(index >= 0 ? (nodes[index]?.ref ?? null) : null);
    };

    const onLeave = () => highlight(null);

    svg.addEventListener('pointerdown', onPointerDown);
    svg.addEventListener('wheel', onWheel, { passive: false });
    svg.addEventListener('pointerover', onOver);
    svg.addEventListener('pointerleave', onLeave);

    controls.current = {
      zoom: (factor) => {
        following = false;

        const centre = { x: size.current.width / 2, y: size.current.height / 2 };

        view.current = zoomAt(view.current, centre, factor);
        show();
      },
      fit: () => {
        following = false;
        toFit();
      },
      reset: () => {
        for (let index = 0; index < nodes.length; index += 1) {
          const node = nodes[index];
          if (!node) continue;

          node.fx = null;
          node.fy = null;
          pin(index, false);
        }

        following = true;
        sim.alphaTarget(0).alpha(1);
        wake();
      },
    };

    return () => {
      gesture?.();
      observer.disconnect();

      // The canvas element outlives the arrangement drawn on it — React keeps it across a
      // change of filter — and every attribute written here is written outside React, so a
      // highlight left over from the previous graph would dim the next one for good.
      highlight(null);
      delete svg.dataset.grabbing;

      svg.removeEventListener('pointerdown', onPointerDown);
      svg.removeEventListener('wheel', onWheel);
      svg.removeEventListener('pointerover', onOver);
      svg.removeEventListener('pointerleave', onLeave);

      if (animating !== 0) cancelAnimationFrame(animating);

      sim.stop();
      controls.current = null;
    };
  }, [layout]);

  const drawn = layout.nodes.length > 0;

  return (
    <div
      className={styles.pane}
      tabIndex={drawn ? 0 : -1}
      onKeyDown={(event) => {
        if (event.key === '+' || event.key === '=') controls.current?.zoom(ZOOM_STEP);
        else if (event.key === '-' || event.key === '_') controls.current?.zoom(1 / ZOOM_STEP);
        else if (event.key === '0') controls.current?.fit();
        else return;

        event.preventDefault();
      }}
    >
      <div className={styles.head}>
        <span className={styles.title}>{m.views.graph.title}</span>
        <span className={styles.legend}>
          {graph.locked > 0
            ? m.views.graph.legendLocked(layout.nodes.length, layout.edges.length, graph.locked)
            : m.views.graph.legend(layout.nodes.length, layout.edges.length)}
          {layout.hidden > 0 ? ` ${m.views.graph.legendHidden(layout.hidden)}` : ''}
        </span>

        <span className={styles.spacer} />

        <div className={styles.tools}>
          <button
            type="button"
            className={styles.toggle}
            aria-pressed={orphans}
            onClick={() => setOrphans(!orphans)}
            {...tip(m.views.graph.orphansTip)}
          >
            {m.views.graph.orphans}
          </button>
          <button
            type="button"
            className={styles.tool}
            disabled={!drawn}
            onClick={() => controls.current?.zoom(1 / ZOOM_STEP)}
            {...tip(m.views.graph.zoomOut)}
          >
            <Icon name="minus" />
          </button>
          <button
            type="button"
            className={styles.tool}
            disabled={!drawn}
            onClick={() => controls.current?.zoom(ZOOM_STEP)}
            {...tip(m.views.graph.zoomIn)}
          >
            <Icon name="plus" />
          </button>
          <button
            type="button"
            className={styles.tool}
            disabled={!drawn}
            onClick={() => controls.current?.fit()}
            {...tip(m.views.graph.fit)}
          >
            <Icon name="target" />
          </button>
          <button
            type="button"
            className={styles.tool}
            disabled={!drawn}
            onClick={() => controls.current?.reset()}
            {...tip(m.views.graph.reset)}
          >
            <Icon name="graph" />
          </button>
        </div>
      </div>

      {drawn ? (
        <svg ref={canvas} className={styles.canvas} role="img" aria-label={m.views.graph.canvas}>
          <g ref={world}>
            <g>
              {layout.edges.map((edge, index) => {
                const from = edge.source as LaidNode;
                const to = edge.target as LaidNode;

                return (
                  <line
                    key={index}
                    data-edge=""
                    vectorEffect="non-scaling-stroke"
                    className={from.locked || to.locked ? styles.edgeMasked : styles.edge}
                  />
                );
              })}
            </g>

            <g>
              {layout.nodes.map((node, index) => {
                const radius = nodeRadius(node.degree);

                return (
                  <g
                    key={node.ref}
                    data-ref={node.ref}
                    data-index={index}
                    data-hub={node.degree >= layout.hub ? '1' : undefined}
                    className={node.locked ? styles.nodeMasked : styles.node}
                  >
                    <circle r={radius} className={node.locked ? styles.dotMasked : styles.dot} />
                    <text y={radius + 13} className={styles.label}>
                      {node.locked ? '••••••' : truncate(node.name)}
                    </text>
                    {node.locked ? null : (
                      <title>{m.views.graph.node(node.name, node.degree)}</title>
                    )}
                  </g>
                );
              })}
            </g>
          </g>
        </svg>
      ) : (
        <p className={styles.empty}>{m.views.graph.noLinks}</p>
      )}

      <div className={styles.foot}>
        <p className={styles.note}>
          {graph.revealsLocked ? m.views.graph.revealsLocked : m.views.graph.hidesLocked}
        </p>
        {drawn ? <p className={styles.hint}>{m.views.graph.hint}</p> : null}
      </div>
    </div>
  );
}

function open(id: number): void {
  const { tree, openNote, setView } = useWorkspace.getState();
  const note = tree.notes.find((candidate) => candidate.id === id);

  if (!note) return;

  void openNote(note);
  setView('editor');
}

function truncate(name: string): string {
  return name.length > 22 ? `${name.slice(0, 21)}…` : name;
}
