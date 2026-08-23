/**
 * The icon set from the Basalt spec, kept as one sprite so a note icon is a string the
 * tree can store and the picker can enumerate.
 */
export const ICON_NAMES = [
  'doc',
  'folder',
  'lock',
  'key',
  'shield',
  'eye',
  'star',
  'flag',
  'bolt',
  'bulb',
  'book',
  'target',
  'code',
  'terminal',
  'db',
  'calendar',
  'clock',
  'user',
  'globe',
  'hash',
  'tag',
  'layers',
  'inbox',
  'warn',
  'graph',
  'pin',
  'link',
  'circle',
  'claude',
] as const;

export type IconName =
  | (typeof ICON_NAMES)[number]
  // The default vault mark. Kept out of ICON_NAMES so picking "reset" in the picker falls
  // back to it rather than offering it as one choice among the note icons.
  | 'vault'
  | 'chev'
  | 'down'
  | 'plus'
  | 'minus'
  | 'search'
  | 'dots'
  | 'check'
  | 'panel'
  | 'x'
  | 'arrow'
  | 'trash'
  | 'box'
  // The editor's own verbs. Kept out of ICON_NAMES: nobody wants "cut" as a note icon.
  | 'bold'
  | 'italic'
  | 'strike'
  | 'case'
  | 'text'
  | 'list'
  | 'quote'
  | 'table'
  | 'rule'
  | 'cut'
  | 'copy'
  | 'paste';

const stroke = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.6,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const;

export function Icon({
  name,
  size = 14,
  className,
  style,
}: {
  name: IconName;
  size?: number | undefined;
  // CSS module lookups are string | undefined under noUncheckedIndexedAccess, so the
  // props that receive them have to say so.
  className?: string | undefined;
  style?: React.CSSProperties | undefined;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
      className={className}
      style={style}
    >
      <use href={`#i-${name}`} />
    </svg>
  );
}

/**
 * Rendered once at the app root; every Icon references it by id.
 *
 * Every glyph is drawn so its ink is centred on (12, 12). A shape that fills the box
 * unevenly — a folder tab is only on top, a pin only has a stem below — reads as misaligned
 * next to its neighbours even though the boxes line up, so the geometry compensates.
 */
export function IconSprite() {
  return (
    <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden="true">
      <defs>
        <symbol id="i-chev" {...stroke}>
          <polyline points="8.5 5 15.5 12 8.5 19" />
        </symbol>
        <symbol id="i-down" {...stroke}>
          <polyline points="5 8.5 12 15.5 19 8.5" />
        </symbol>
        <symbol id="i-plus" {...stroke}>
          <path d="M12 5.5v13M5.5 12h13" />
        </symbol>
        <symbol id="i-minus" {...stroke}>
          <path d="M5.5 12h13" />
        </symbol>
        <symbol id="i-search" {...stroke}>
          <circle cx="10.45" cy="10.45" r="6.5" />
          <path d="M15.45 15.45l4.55 4.55" />
        </symbol>
        <symbol id="i-lock" {...stroke}>
          <rect x="5" y="10.5" width="14" height="9.5" rx="2.5" />
          <path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" />
        </symbol>
        <symbol id="i-doc" {...stroke}>
          <path d="M6.5 3.5h7l4.5 4.5v12.5h-11.5z" />
          <path d="M10 13.5h5M10 16.5h3.5" />
        </symbol>
        <symbol id="i-folder" {...stroke}>
          <path d="M3.5 5h5.5l2 2.5h9.5v11h-17z" />
        </symbol>
        <symbol id="i-user" {...stroke}>
          <circle cx="12" cy="8.5" r="3.4" />
          <path d="M5.5 19.5c1.5-3.6 11.5-3.6 13 0" />
        </symbol>
        <symbol id="i-globe" {...stroke}>
          <circle cx="12" cy="12" r="8" />
          <path d="M4 12h16" />
          <path d="M12 4c4 4.5 4 11.5 0 16-4-4.5-4-11.5 0-16z" />
        </symbol>
        <symbol id="i-clock" {...stroke}>
          <circle cx="12" cy="12" r="8" />
          <path d="M12 7.5V12l3 2" />
        </symbol>
        <symbol id="i-dots" viewBox="0 0 24 24" fill="currentColor" stroke="none">
          <circle cx="6" cy="12" r="1.4" />
          <circle cx="12" cy="12" r="1.4" />
          <circle cx="18" cy="12" r="1.4" />
        </symbol>
        <symbol id="i-check" {...stroke} strokeWidth={2.2}>
          <polyline points="5 12.5 9.8 17 19 7" />
        </symbol>
        <symbol id="i-graph" {...stroke}>
          <circle cx="6" cy="17" r="2.4" />
          <circle cx="17.5" cy="17" r="2.4" />
          <circle cx="12" cy="6.5" r="2.4" />
          <path d="M8.2 15.6l2.6-6.6M15.5 15.3l-2-6" />
        </symbol>
        <symbol id="i-panel" {...stroke}>
          <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
          <path d="M14.5 4.5v15" />
        </symbol>
        <symbol id="i-x" {...stroke}>
          <path d="M6.8 6.8l10.4 10.4M17.2 6.8L6.8 17.2" />
        </symbol>
        <symbol id="i-arrow" {...stroke}>
          <path d="M5 12h13" />
          <polyline points="13 6.6 18.4 12 13 17.4" />
        </symbol>
        <symbol id="i-hash" {...stroke}>
          <path d="M10.2 4.5L8 19.5M16.8 4.5l-2.2 15M5.4 9.2h14M4.6 14.8h14" />
        </symbol>
        <symbol id="i-trash" {...stroke}>
          <path d="M5.5 6.5h13M9.5 6.5V4.5h5v2M7 6.5l1 13h8l1-13" />
        </symbol>
        <symbol id="i-key" {...stroke}>
          <circle cx="7.3" cy="12" r="3.6" />
          <path d="M10.9 12H20.3M17.3 12v3M14.3 12v2.4" />
        </symbol>
        <symbol id="i-star" {...stroke}>
          <path d="M12 3.5l2.2 6.3 6.3 2.2-6.3 2.2L12 20.5l-2.2-6.3L3.5 12l6.3-2.2z" />
        </symbol>
        <symbol id="i-flag" {...stroke}>
          <path d="M6.5 20.25V3.75h11l-2.3 3.9L17.5 11.55H6.5" />
        </symbol>
        <symbol id="i-bolt" {...stroke}>
          <path d="M13.5 3.5L6.5 13.5h5l-1 7 7-10h-5z" />
        </symbol>
        <symbol id="i-bulb" {...stroke}>
          <circle cx="12" cy="9.1" r="4.6" />
          <path d="M9.8 16.7h4.4M10.6 19.5h2.8" />
        </symbol>
        <symbol id="i-book" {...stroke}>
          <path d="M4.5 5h6.8v14H4.5zM12.7 5h6.8v14h-6.8z" />
        </symbol>
        <symbol id="i-target" {...stroke}>
          <circle cx="12" cy="12" r="7.5" />
          <circle cx="12" cy="12" r="2.6" />
        </symbol>
        <symbol id="i-shield" {...stroke}>
          <path d="M12 3.8l7 2.4v5.5c0 4.1-3 7-7 8.5-4-1.5-7-4.4-7-8.5V6.2z" />
        </symbol>
        <symbol id="i-code" {...stroke}>
          <polyline points="8.5 8 4.5 12 8.5 16" />
          <polyline points="15.5 8 19.5 12 15.5 16" />
        </symbol>
        <symbol id="i-calendar" {...stroke}>
          <rect x="4" y="5.5" width="16" height="14.5" rx="2.5" />
          <path d="M4 10.2h16M8.5 3.5v4M15.5 3.5v4" />
        </symbol>
        <symbol id="i-pin" {...stroke}>
          <circle cx="12" cy="7.95" r="3.2" />
          <path d="M12 19.25v-8" />
        </symbol>
        <symbol id="i-warn" {...stroke}>
          <path d="M12 4.5l8.5 15h-17z" />
          <path d="M12 10v4.2M12 16.9v.4" />
        </symbol>
        <symbol id="i-db" {...stroke}>
          <ellipse cx="12" cy="6.5" rx="7" ry="2.8" />
          <path d="M5 6.5v11c0 1.6 3.1 2.8 7 2.8s7-1.2 7-2.8v-11" />
          <path d="M5 12c0 1.6 3.1 2.8 7 2.8s7-1.2 7-2.8" />
        </symbol>
        <symbol id="i-terminal" {...stroke}>
          <rect x="3.5" y="5" width="17" height="14" rx="2.5" />
          <polyline points="7.5 10 10 12.4 7.5 14.8" />
          <path d="M12.6 15h4" />
        </symbol>
        <symbol id="i-layers" {...stroke}>
          <path d="M12 5.5l8 4-8 4-8-4z" />
          <path d="M4 14.5l8 4 8-4" />
        </symbol>
        <symbol id="i-box" {...stroke}>
          <rect x="4" y="4.5" width="16" height="15" rx="2.5" />
          <path d="M4 9.6h16" />
        </symbol>
        <symbol id="i-bold" {...stroke}>
          <path d="M8 5.5h5.2a3.25 3.25 0 0 1 0 6.5H8z" />
          <path d="M8 12h6a3.5 3.5 0 0 1 0 7H8z" />
        </symbol>
        <symbol id="i-italic" {...stroke}>
          <path d="M15 5.5h-4.5M13.5 18.5H9M14 5.5l-3.5 13" />
        </symbol>
        <symbol id="i-strike" {...stroke}>
          <path d="M4.5 12h15" />
          <path d="M16 7.6A4.6 4.6 0 0 0 8.4 9.4c0 1.2.9 2 2.4 2.6M7.8 16.6a4.7 4.7 0 0 0 7.3-.9" />
        </symbol>
        <symbol id="i-case" {...stroke}>
          <path d="M3.5 17.5l4-10.5 4 10.5M5 14h5" />
          <circle cx="17" cy="14.4" r="3.1" />
          <path d="M20.1 11.3v6.2" />
        </symbol>
        <symbol id="i-text" {...stroke}>
          <path d="M5.5 6.5h13M12 6.5v11M9 17.5h6" />
        </symbol>
        <symbol id="i-list" {...stroke}>
          <path d="M9.5 7h10M9.5 12h10M9.5 17h10" />
          <circle cx="5.2" cy="7" r="1" fill="currentColor" stroke="none" />
          <circle cx="5.2" cy="12" r="1" fill="currentColor" stroke="none" />
          <circle cx="5.2" cy="17" r="1" fill="currentColor" stroke="none" />
        </symbol>
        <symbol id="i-quote" {...stroke}>
          <path d="M5.5 6v12" />
          <path d="M10 8.5h9M10 12h9M10 15.5h5.5" />
        </symbol>
        <symbol id="i-table" {...stroke}>
          <rect x="4" y="5" width="16" height="14" rx="2" />
          <path d="M4 9.8h16M11.4 9.8V19" />
        </symbol>
        <symbol id="i-rule" {...stroke}>
          <path d="M4.5 12h15" />
        </symbol>
        <symbol id="i-cut" {...stroke}>
          <circle cx="7" cy="17.2" r="2.6" />
          <circle cx="17" cy="17.2" r="2.6" />
          <path d="M8.8 15.3L18.2 4.5M15.2 15.3L5.8 4.5" />
        </symbol>
        <symbol id="i-copy" {...stroke}>
          <rect x="9" y="9" width="10.5" height="10.5" rx="2" />
          <path d="M5.5 15V6.5a2 2 0 0 1 2-2H15" />
        </symbol>
        <symbol id="i-paste" {...stroke}>
          <path d="M9.5 5H7a1.8 1.8 0 0 0-1.8 1.8v11.4A1.8 1.8 0 0 0 7 20h10a1.8 1.8 0 0 0 1.8-1.8V6.8A1.8 1.8 0 0 0 17 5h-2.5" />
          <rect x="9.3" y="3.2" width="5.4" height="3.6" rx="1" />
        </symbol>
        <symbol id="i-eye" {...stroke}>
          <path d="M2.8 12S6.5 6.6 12 6.6 21.2 12 21.2 12 17.5 17.4 12 17.4 2.8 12 2.8 12z" />
          <circle cx="12" cy="12" r="2.6" />
        </symbol>
        <symbol id="i-tag" {...stroke}>
          <path d="M4.5 11.6V4.5h7.1l7.9 7.9-7.1 7.1z" />
          <circle cx="8.4" cy="8.4" r="1.3" />
        </symbol>
        <symbol id="i-inbox" {...stroke}>
          <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
          <path d="M3.5 13.6H8l1.6 2.5h4.8l1.6-2.5h4.5" />
        </symbol>
        <symbol id="i-link" {...stroke}>
          <rect x="2.8" y="9" width="10.4" height="6" rx="3" />
          <rect x="10.8" y="9" width="10.4" height="6" rx="3" />
        </symbol>
        <symbol id="i-circle" {...stroke}>
          <circle cx="12" cy="12" r="7.5" />
        </symbol>
        {/* Claude's own mark, measured off its monochrome template icon: the twelve rays at the
            angles and relative lengths it really uses, redrawn at this set's stroke and brought
            in to `star`'s reach so it does not outsize its neighbours. It marks what is connected
            to Claude and nothing else, which is why it carries no brand colour. */}
        <symbol id="i-claude" {...stroke}>
          <path d="M12 12l6.41 1.84M12 12l5.04 4.91M12 12l3.37 6.01M12 12l-1.02 6.84M12 12l-3.82 6.03M12 12l-5.49 4.06M12 12l-6.89 0.05M12 12l-6.07 -3.70M12 12l-3.58 -6.53M12 12l1.14 -6.45M12 12l4.47 -5.08M12 12l6.38 -1.14" />
        </symbol>
        <symbol id="i-vault" {...stroke}>
          <rect x="3.5" y="4" width="17" height="16" rx="2.5" />
          <path d="M3.5 12h17M8 7.5v4.5M16 15.5v4.5" />
        </symbol>
      </defs>
    </svg>
  );
}
