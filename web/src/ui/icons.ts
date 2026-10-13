// Inline SVG icons (24×24, stroke = currentColor).

import type { ToolKind } from '../types';

const svg = (body: string) =>
  `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

export const TOOL_ICONS: Record<ToolKind, string> = {
  wall: svg('<path d="M5 19 19 5" stroke-width="4"/>'),
  reflector: svg('<path d="M5 19c2-9 5-12 14-14" stroke-width="3.2"/>'),
  absorber: svg('<rect x="4" y="7" width="16" height="10" rx="1"/><path d="M7 17l6-10M12 17l6-10M4 13l4-6"/>'),
  lens: svg('<ellipse cx="12" cy="12" rx="5" ry="8"/><path d="M3 9h4M3 15h4M17 12h4" opacity=".6"/>'),
  prism: svg('<path d="M12 4 20 19H4z"/><path d="M2 11l7 2M15 13l7-3M15 14l7 1M15 15l6 4" opacity=".7"/>'),
  slab: svg('<rect x="6" y="5" width="12" height="14" rx="1"/><path d="M2 9l4 1M18 12l4 1" opacity=".7"/>'),
  resonator: svg('<path d="M9 4v9a3 3 0 0 0 6 0V4"/><path d="M12 16v4"/>'),
  emitter: svg('<circle cx="12" cy="12" r="2.4" fill="currentColor"/><path d="M7.5 7.5a6.4 6.4 0 0 0 0 9M16.5 7.5a6.4 6.4 0 0 1 0 9"/>'),
};

export const TOOL_NAMES: Record<ToolKind, string> = {
  wall: 'Wall',
  reflector: 'Reflector',
  absorber: 'Absorber',
  lens: 'Lens',
  prism: 'Prism',
  slab: 'Glass block',
  resonator: 'Resonator',
  emitter: 'Emitter',
};

export const ICONS = {
  back: svg('<path d="M15 5l-7 7 7 7"/>'),
  undo: svg('<path d="M9 5 4 10l5 5"/><path d="M4 10h11a5 5 0 0 1 0 10h-3"/>'),
  trash: svg('<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>'),
  restart: svg('<path d="M4 12a8 8 0 1 0 2.4-5.7"/><path d="M4 4v5h5"/>'),
  pause: svg('<path d="M8 5v14M16 5v14" stroke-width="2.6"/>'),
  play: svg('<path d="M7 5l12 7-12 7z" fill="currentColor"/>'),
  fast: svg('<path d="M4 6l8 6-8 6zM12 6l8 6-8 6z" fill="currentColor"/>'),
  sound: svg('<path d="M4 10v4h4l5 4V6L8 10z"/><path d="M16 9a4 4 0 0 1 0 6M18.5 6.5a7.5 7.5 0 0 1 0 11"/>'),
  muted: svg('<path d="M4 10v4h4l5 4V6L8 10z"/><path d="M17 10l4 4M21 10l-4 4"/>'),
  hint: svg('<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6V14M12 17.5v.01"/>'),
  star: svg('<path d="M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.8L12 16.8 6.8 19.6l1-5.8-4.3-4.1 5.9-.8z"/>'),
  lock: svg('<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>'),
  focus: svg('<circle cx="12" cy="12" r="5"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/>'),
  silence: svg('<circle cx="12" cy="12" r="8" stroke-dasharray="3 3"/><path d="M8.5 12h7"/>'),
  resonate: svg('<path d="M12 3l6 9-6 9-6-9z"/><path d="M12 8l-1.5 4 2.5 1-1 3"/>'),
  sensor: svg('<rect x="7" y="7" width="10" height="10" rx="2"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>'),
  flip: svg('<path d="M12 3v18" stroke-dasharray="2 3"/><path d="M8 7c-3 2-3 8 0 10M16 7c3 2 3 8 0 10"/>'),
  rotl: svg('<path d="M4 12a8 8 0 1 1 2.4 5.7"/><path d="M4 18v-6h6"/>'),
  rotr: svg('<path d="M20 12a8 8 0 1 0-2.4 5.7"/><path d="M20 18v-6h-6"/>'),
  sustain: svg('<path d="M3 12c2.5-6 6.5-6 9 0s6.5 6 9 0"/><path d="M3 12c2.5 6 6.5 6 9 0s6.5-6 9 0" opacity=".5"/>'),
};
