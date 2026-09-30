/**
 * The Home's office scene, drawn (Home V4). Each function returns one room of the building as an
 * SVG string: walls, floor, light, furniture and the department's own things. People, desks,
 * screens and every piece of data are NOT drawn here: the web app places them on top, from real
 * records, so the pictures never say anything about the organization.
 *
 * `bake.mjs` renders these to WebP. Change a room here, bake again, commit both.
 */

/** Side rooms (departments) and the centre column's rooms, in pixels at 2x. */
export const SIDE = { w: 960, h: 600 };
export const CENTRE = { w: 640, h: 600 };

/** The back wall of a side room: the screen overlay and the desks are placed from these. */
export const SIDE_WALL = { x0: 96, x1: 864, y0: 58, y1: 392 };
/** Where the department's wall screen hangs, as fractions of the side room. */
export const SIDE_SCREEN = { x: 0.355, y: 0.17, w: 0.29, h: 0.25 };

function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const f = (n) => Math.round(n * 10) / 10;

function defs(id) {
  return `
  <linearGradient id="${id}-plaster" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#fbf3ea"/><stop offset="0.7" stop-color="#f1e2d2"/><stop offset="1" stop-color="#e6d0bb"/>
  </linearGradient>
  <linearGradient id="${id}-ceiling" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#efe4d8"/><stop offset="1" stop-color="#fbf5ee"/>
  </linearGradient>
  <linearGradient id="${id}-oak" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#c99a6b"/><stop offset="0.5" stop-color="#b98555"/><stop offset="1" stop-color="#9d6b40"/>
  </linearGradient>
  <linearGradient id="${id}-wood" x1="0" y1="0" x2="1" y2="0">
    <stop offset="0" stop-color="#9b6a42"/><stop offset="0.5" stop-color="#b98458"/><stop offset="1" stop-color="#9b6a42"/>
  </linearGradient>
  <linearGradient id="${id}-woodside" x1="0" y1="0" x2="1" y2="0">
    <stop offset="0" stop-color="#8a5a36"/><stop offset="1" stop-color="#b07d52"/>
  </linearGradient>
  <linearGradient id="${id}-glass" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#e9f1f1" stop-opacity="0.85"/><stop offset="0.5" stop-color="#d6e3e4" stop-opacity="0.55"/><stop offset="1" stop-color="#f4ece2" stop-opacity="0.8"/>
  </linearGradient>
  <radialGradient id="${id}-pool" cx="0.5" cy="0.5" r="0.5">
    <stop offset="0" stop-color="#fff1d6" stop-opacity="0.75"/><stop offset="1" stop-color="#fff1d6" stop-opacity="0"/>
  </radialGradient>
  <radialGradient id="${id}-lamp" cx="0.5" cy="0.5" r="0.5">
    <stop offset="0" stop-color="#fff4d9" stop-opacity="0.95"/><stop offset="0.35" stop-color="#ffd9a0" stop-opacity="0.45"/><stop offset="1" stop-color="#ffd9a0" stop-opacity="0"/>
  </radialGradient>
  <radialGradient id="${id}-vignette" cx="0.5" cy="0.45" r="0.75">
    <stop offset="0.55" stop-color="#3a1f10" stop-opacity="0"/><stop offset="1" stop-color="#3a1f10" stop-opacity="0.28"/>
  </radialGradient>
  <linearGradient id="${id}-leaf" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#7fa65a"/><stop offset="1" stop-color="#3f6b35"/>
  </linearGradient>
  <linearGradient id="${id}-leaf2" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#9cbd6e"/><stop offset="1" stop-color="#557f3f"/>
  </linearGradient>
  <linearGradient id="${id}-pot" x1="0" y1="0" x2="1" y2="0">
    <stop offset="0" stop-color="#e9e1d8"/><stop offset="0.6" stop-color="#fbf7f2"/><stop offset="1" stop-color="#d9cfc4"/>
  </linearGradient>
  <linearGradient id="${id}-terracotta" x1="0" y1="0" x2="1" y2="0">
    <stop offset="0" stop-color="#b8643f"/><stop offset="0.6" stop-color="#d9845a"/><stop offset="1" stop-color="#a95a38"/>
  </linearGradient>
  <linearGradient id="${id}-screen" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#2d2a2c"/><stop offset="1" stop-color="#1c1a1c"/>
  </linearGradient>
  <filter id="${id}-soft" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="6"/></filter>
  <filter id="${id}-softer" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="14"/></filter>`;
}

/** A one-point perspective box: ceiling, walls and a planked oak floor, lit warm. */
function shell(id, w, h, wall, { left = 'glass', right = 'wood', seed = 1 } = {}) {
  const vx = (wall.x0 + wall.x1) / 2;
  const vy = wall.y0 + (wall.y1 - wall.y0) * 0.55;
  const rnd = prng(seed);
  const parts = [];
  // Ceiling, with a recessed light line along it.
  parts.push(
    `<polygon points="0,0 ${w},0 ${wall.x1},${wall.y0} ${wall.x0},${wall.y0}" fill="url(#${id}-ceiling)"/>`,
  );
  parts.push(
    `<polygon points="${f(w * 0.3)},${f(wall.y0 * 0.35)} ${f(w * 0.7)},${f(wall.y0 * 0.35)} ${f(w * 0.66)},${f(wall.y0 * 0.55)} ${f(w * 0.34)},${f(wall.y0 * 0.55)}" fill="#fff9ee" opacity="0.9"/>`,
  );
  // Back wall.
  parts.push(
    `<rect x="${wall.x0}" y="${wall.y0}" width="${wall.x1 - wall.x0}" height="${wall.y1 - wall.y0}" fill="url(#${id}-plaster)"/>`,
  );
  // Floor, planked towards the vanishing point.
  const floor = `0,${h} ${w},${h} ${wall.x1},${wall.y1} ${wall.x0},${wall.y1}`;
  parts.push(`<clipPath id="${id}-floorclip"><polygon points="${floor}"/></clipPath>`);
  parts.push(`<polygon points="${floor}" fill="url(#${id}-oak)"/>`);
  const k = (wall.y1 - vy) / (h - vy);
  const planks = [];
  for (let x = -w; x <= w * 2; x += 46) {
    const top = vx + (x - vx) * k;
    planks.push(
      `<line x1="${f(x)}" y1="${h}" x2="${f(top)}" y2="${wall.y1}" stroke="#7d5232" stroke-opacity="0.28" stroke-width="1.4"/>`,
    );
  }
  for (let i = 1; i < 9; i += 1) {
    const y = wall.y1 + (h - wall.y1) * Math.pow(i / 9, 1.5);
    const shade = 0.05 + rnd() * 0.08;
    planks.push(
      `<line x1="0" y1="${f(y)}" x2="${w}" y2="${f(y)}" stroke="#6e4528" stroke-opacity="${f(shade * 10) / 10}" stroke-width="1"/>`,
    );
  }
  parts.push(`<g clip-path="url(#${id}-floorclip)">${planks.join('')}
    <ellipse cx="${vx}" cy="${f(wall.y1 + (h - wall.y1) * 0.45)}" rx="${f(w * 0.42)}" ry="${f((h - wall.y1) * 0.5)}" fill="url(#${id}-pool)"/></g>`);
  // Baseboard.
  parts.push(
    `<rect x="${wall.x0}" y="${wall.y1 - 8}" width="${wall.x1 - wall.x0}" height="8" fill="#d8c3ae"/>`,
  );
  // Left wall.
  const lw = `0,0 ${wall.x0},${wall.y0} ${wall.x0},${wall.y1} 0,${h}`;
  const rw = `${w},0 ${wall.x1},${wall.y0} ${wall.x1},${wall.y1} ${w},${h}`;
  parts.push(side(id, lw, left, 'left', w, h, wall));
  parts.push(side(id, rw, right, 'right', w, h, wall));
  return parts.join('\n');
}

function side(id, points, kind, which, w, h, wall) {
  const x0 = which === 'left' ? 0 : w;
  const x1 = which === 'left' ? wall.x0 : wall.x1;
  const lines = [];
  if (kind === 'glass') {
    lines.push(`<polygon points="${points}" fill="#efe6dc"/>`);
    lines.push(`<polygon points="${points}" fill="url(#${id}-glass)"/>`);
    // Mullions, and a reflection across the glass.
    for (let t = 0.25; t < 1; t += 0.25) {
      const x = x0 + (x1 - x0) * t;
      const yTop = wall.y0 * t;
      const yBottom = h + (wall.y1 - h) * t;
      lines.push(
        `<line x1="${f(x)}" y1="${f(yTop)}" x2="${f(x)}" y2="${f(yBottom)}" stroke="#7b6a5c" stroke-opacity="0.35" stroke-width="3"/>`,
      );
    }
    lines.push(
      `<line x1="${x0}" y1="${f(h * 0.55)}" x2="${x1}" y2="${f(wall.y0 + (wall.y1 - wall.y0) * 0.55)}" stroke="#7b6a5c" stroke-opacity="0.25" stroke-width="2"/>`,
    );
    lines.push(
      `<polygon points="${f(x0 + (x1 - x0) * 0.1)},${f(h * 0.2)} ${f(x0 + (x1 - x0) * 0.3)},${f(h * 0.12)} ${f(x0 + (x1 - x0) * 0.2)},${f(h * 0.8)} ${f(x0 + (x1 - x0) * 0.02)},${f(h * 0.9)}" fill="#ffffff" opacity="0.25"/>`,
    );
  } else {
    lines.push(`<polygon points="${points}" fill="url(#${id}-woodside)"/>`);
    for (let t = 0.1; t < 1; t += 0.1) {
      const x = x0 + (x1 - x0) * t;
      lines.push(
        `<line x1="${f(x)}" y1="${f(wall.y0 * t)}" x2="${f(x)}" y2="${f(h + (wall.y1 - h) * t)}" stroke="#5e3a20" stroke-opacity="0.3" stroke-width="2"/>`,
      );
    }
  }
  return lines.join('');
}

function pendant(id, x, y, drop, scale = 1) {
  const s = scale;
  return `<g>
    <line x1="${x}" y1="0" x2="${x}" y2="${y + drop}" stroke="#4a3426" stroke-width="${f(2 * s)}"/>
    <circle cx="${x}" cy="${f(y + drop + 14 * s)}" r="${f(70 * s)}" fill="url(#${id}-lamp)"/>
    <path d="M ${f(x - 22 * s)} ${f(y + drop + 16 * s)} Q ${x} ${f(y + drop - 12 * s)} ${f(x + 22 * s)} ${f(y + drop + 16 * s)} Z" fill="#2f2622"/>
    <ellipse cx="${x}" cy="${f(y + drop + 16 * s)}" rx="${f(20 * s)}" ry="${f(4 * s)}" fill="#fff0cf"/>
  </g>`;
}

function plant(id, x, y, size, seed, pot = 'white') {
  const rnd = prng(seed);
  const leaves = [];
  const n = 26;
  for (let i = 0; i < n; i += 1) {
    const angle = -160 + rnd() * 140;
    const len = size * (0.55 + rnd() * 0.55);
    const rad = (angle * Math.PI) / 180;
    const cx = x + Math.cos(rad) * len * 0.5;
    const cy = y - size * 0.15 + Math.sin(rad) * len * 0.5;
    const fill = rnd() > 0.5 ? `url(#${id}-leaf)` : `url(#${id}-leaf2)`;
    leaves.push(
      `<ellipse cx="${f(cx)}" cy="${f(cy)}" rx="${f(len * 0.5)}" ry="${f(size * 0.09)}" transform="rotate(${f(angle)} ${f(cx)} ${f(cy)})" fill="${fill}"/>`,
    );
  }
  const pw = size * 0.42;
  const ph = size * 0.46;
  const potFill = pot === 'white' ? `url(#${id}-pot)` : `url(#${id}-terracotta)`;
  return `<g>
    <ellipse cx="${x}" cy="${f(y + ph)}" rx="${f(pw * 0.9)}" ry="${f(pw * 0.18)}" fill="#3a2414" opacity="0.25" filter="url(#${id}-soft)"/>
    ${leaves.join('')}
    <path d="M ${f(x - pw / 2)} ${y} L ${f(x + pw / 2)} ${y} L ${f(x + pw * 0.4)} ${f(y + ph)} L ${f(x - pw * 0.4)} ${f(y + ph)} Z" fill="${potFill}"/>
    <ellipse cx="${x}" cy="${y}" rx="${f(pw / 2)}" ry="${f(pw * 0.1)}" fill="#6b4a33"/>
  </g>`;
}

function shelf(id, x, y, w, h, seed, rows = 4) {
  const rnd = prng(seed);
  const colors = [
    '#c9a27e',
    '#8f5d3b',
    '#e8d8c4',
    '#d78b5f',
    '#6f7b72',
    '#b86f4d',
    '#f0c79a',
    '#7a6152',
    '#dfb58b',
  ];
  const parts = [
    `<rect x="${x - 6}" y="${y - 6}" width="${w + 12}" height="${h + 12}" rx="3" fill="#8e5f3a"/>`,
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#5b3a24"/>`,
  ];
  const rowH = h / rows;
  for (let r = 0; r < rows; r += 1) {
    const top = y + r * rowH;
    parts.push(
      `<rect x="${x}" y="${f(top)}" width="${w}" height="${f(rowH)}" fill="#e9d7c2" opacity="0.18"/>`,
    );
    let cx = x + 4;
    while (cx < x + w - 10) {
      const kind = rnd();
      if (kind < 0.12) {
        // A little plant or an object.
        parts.push(
          `<circle cx="${f(cx + 9)}" cy="${f(top + rowH - 16)}" r="9" fill="url(#${id}-leaf)"/><rect x="${f(cx + 3)}" y="${f(top + rowH - 12)}" width="12" height="10" fill="#f3ece4"/>`,
        );
        cx += 24;
      } else if (kind < 0.2) {
        cx += 14 + rnd() * 16;
      } else {
        const bw = 6 + rnd() * 8;
        const bh = rowH * (0.55 + rnd() * 0.35);
        const color = colors[Math.floor(rnd() * colors.length)];
        parts.push(
          `<rect x="${f(cx)}" y="${f(top + rowH - 4 - bh)}" width="${f(bw)}" height="${f(bh)}" fill="${color}"/>`,
        );
        cx += bw + 1.5;
      }
    }
    parts.push(`<rect x="${x}" y="${f(top + rowH - 4)}" width="${w}" height="5" fill="#9c6a43"/>`);
  }
  return parts.join('');
}

/** The dark frame the web app's screen overlay sits in (the overlay covers it exactly). */
function wallScreen(id, w, h, screen) {
  const x = screen.x * w;
  const y = screen.y * h;
  const sw = screen.w * w;
  const sh = screen.h * h;
  return `<g>
    <rect x="${f(x - 4)}" y="${f(y + 10)}" width="${f(sw + 8)}" height="${f(sh + 8)}" rx="10" fill="#3a2414" opacity="0.25" filter="url(#${id}-soft)"/>
    <rect x="${f(x - 6)}" y="${f(y - 6)}" width="${f(sw + 12)}" height="${f(sh + 12)}" rx="10" fill="#2a2426"/>
    <rect x="${f(x)}" y="${f(y)}" width="${f(sw)}" height="${f(sh)}" rx="5" fill="url(#${id}-screen)"/>
  </g>`;
}

function slats(id, x, y, w, h) {
  const parts = [`<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="url(#${id}-wood)"/>`];
  for (let sx = x + 8; sx < x + w; sx += 14)
    parts.push(
      `<rect x="${f(sx)}" y="${y}" width="4" height="${h}" fill="#6e4528" opacity="0.35"/>`,
    );
  return parts.join('');
}

function frame(x, y, w, h, fill, inner = '') {
  return `<g><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="3" fill="#6b4a33"/><rect x="${x + 6}" y="${y + 6}" width="${w - 12}" height="${h - 12}" fill="${fill}"/>${inner}</g>`;
}

function clock(x, y, r) {
  return `<g><circle cx="${x}" cy="${y}" r="${r}" fill="#fbf7f2" stroke="#3a2c24" stroke-width="4"/><line x1="${x}" y1="${y}" x2="${x}" y2="${f(y - r * 0.6)}" stroke="#3a2c24" stroke-width="3"/><line x1="${x}" y1="${y}" x2="${f(x + r * 0.45)}" y2="${y}" stroke="#3a2c24" stroke-width="3"/></g>`;
}

/** What makes each department's room its own: decoration only, never data. */
function decor(id, motif, seed) {
  const rnd = prng(seed * 7 + 3);
  const wall = SIDE_WALL;
  const parts = [];
  const pin = (x, y, w, h, color) =>
    `<rect x="${f(x)}" y="${f(y)}" width="${f(w)}" height="${f(h)}" fill="${color}" transform="rotate(${f((rnd() - 0.5) * 8)} ${f(x + w / 2)} ${f(y + h / 2)})"/>`;
  switch (motif) {
    case 'social': {
      // A pinboard of campaign photos and a ring light.
      parts.push(
        `<rect x="140" y="110" width="170" height="130" rx="4" fill="#caa27a"/><rect x="146" y="116" width="158" height="118" fill="#d9b58e"/>`,
      );
      const tones = ['#f2784b', '#f5b942', '#ff9a8a', '#7fb2c9', '#f4e3cf', '#c46a4a'];
      for (let i = 0; i < 9; i += 1) {
        const x = 154 + (i % 3) * 50;
        const y = 124 + Math.floor(i / 3) * 36;
        parts.push(pin(x, y, 42, 30, '#fffaf4'));
        parts.push(pin(x + 3, y + 3, 36, 20, tones[i % tones.length]));
      }
      parts.push(
        `<circle cx="760" cy="200" r="34" fill="none" stroke="#fff6e6" stroke-width="9"/><circle cx="760" cy="200" r="52" fill="url(#${id}-lamp)"/><line x1="760" y1="234" x2="760" y2="330" stroke="#3a2c24" stroke-width="4"/><path d="M 740 380 L 760 330 L 780 380" stroke="#3a2c24" stroke-width="4" fill="none"/>`,
      );
      parts.push(shelf(id, 670, 250, 150, 110, seed + 5, 2));
      break;
    }
    case 'video': {
      // A moodboard of swatches and sketches, and an easel.
      parts.push(
        `<rect x="140" y="104" width="180" height="150" rx="4" fill="#f7f1ea" stroke="#d9c7b5" stroke-width="3"/>`,
      );
      const tones = [
        '#f2784b',
        '#f5b942',
        '#e7c4a8',
        '#9fb8c4',
        '#c96c56',
        '#f0dcc4',
        '#ad7a5a',
        '#ffd4b8',
      ];
      for (let i = 0; i < 8; i += 1)
        parts.push(pin(150 + (i % 4) * 42, 116 + Math.floor(i / 4) * 66, 34, 54, tones[i]));
      parts.push(
        `<g><line x1="730" y1="170" x2="700" y2="380" stroke="#8e5f3a" stroke-width="6"/><line x1="770" y1="170" x2="800" y2="380" stroke="#8e5f3a" stroke-width="6"/><rect x="705" y="180" width="90" height="110" fill="#fffaf4" stroke="#8e5f3a" stroke-width="4"/><path d="M 720 260 Q 745 200 780 240" stroke="#f2784b" stroke-width="5" fill="none"/><circle cx="760" cy="215" r="12" fill="#f5b942"/></g>`,
      );
      break;
    }
    case 'growth': {
      // A whiteboard with a funnel sketched on it, and an awards shelf.
      parts.push(
        `<rect x="130" y="100" width="190" height="130" rx="6" fill="#fdfcfa" stroke="#bfb2a5" stroke-width="4"/>`,
      );
      parts.push(
        `<path d="M 170 125 L 280 125 L 245 170 L 245 205 L 205 215 L 205 170 Z" fill="none" stroke="#f2784b" stroke-width="4" stroke-linejoin="round"/><line x1="160" y1="140" x2="175" y2="140" stroke="#6f7b72" stroke-width="3"/><line x1="290" y1="160" x2="305" y2="160" stroke="#6f7b72" stroke-width="3"/>`,
      );
      parts.push(`<rect x="130" y="232" width="190" height="8" fill="#bfb2a5"/>`);
      parts.push(shelf(id, 660, 110, 170, 170, seed + 9, 3));
      parts.push(
        `<g><rect x="720" y="92" width="18" height="14" fill="#e8a33d"/><path d="M 712 72 L 746 72 L 740 92 L 718 92 Z" fill="#f5b942"/></g>`,
      );
      break;
    }
    case 'dashboard': {
      // A kanban board of sticky notes, and a wall clock.
      parts.push(
        `<rect x="660" y="100" width="190" height="160" rx="6" fill="#fdfcfa" stroke="#bfb2a5" stroke-width="4"/>`,
      );
      for (let c = 0; c < 3; c += 1) {
        parts.push(`<rect x="${672 + c * 60}" y="112" width="50" height="8" fill="#d9c7b5"/>`);
        const notes = 2 + Math.floor(rnd() * 3);
        for (let n = 0; n < notes; n += 1)
          parts.push(
            pin(
              674 + c * 60,
              128 + n * 30,
              44,
              24,
              ['#f5b942', '#ffb4a2', '#ffe08a', '#f2c9a8'][(c + n) % 4],
            ),
          );
      }
      parts.push(clock(210, 140, 34));
      parts.push(shelf(id, 130, 200, 170, 120, seed + 2, 2));
      break;
    }
    case 'finance': {
      // Framed prints, filing cabinets and a clock.
      parts.push(
        frame(
          140,
          104,
          100,
          80,
          '#e7c4a8',
          `<path d="M 150 170 Q 175 130 200 150 T 232 120" stroke="#b8643f" stroke-width="3" fill="none"/>`,
        ),
      );
      parts.push(
        frame(250, 104, 70, 80, '#f0dcc4', `<circle cx="285" cy="144" r="16" fill="#e8a33d"/>`),
      );
      parts.push(
        `<g>${[0, 1].map((i) => `<rect x="${140 + i * 92}" y="232" width="86" height="150" rx="4" fill="#d6c9bc" stroke="#b3a393" stroke-width="3"/>${[0, 1, 2].map((d) => `<rect x="${150 + i * 92}" y="${244 + d * 46}" width="66" height="38" rx="3" fill="#e6dbd0"/><rect x="${174 + i * 92}" y="${258 + d * 46}" width="18" height="5" rx="2" fill="#8c7a6a"/>`).join('')}`).join('')}</g>`,
      );
      parts.push(clock(760, 140, 32));
      parts.push(shelf(id, 670, 200, 160, 120, seed + 4, 2));
      break;
    }
    case 'network': {
      // A corkboard of pinned papers joined by thread, and a globe.
      parts.push(
        `<rect x="130" y="100" width="190" height="150" rx="4" fill="#c79b6d"/><rect x="136" y="106" width="178" height="138" fill="#d9ae80"/>`,
      );
      const pts = [];
      for (let i = 0; i < 6; i += 1) {
        const x = 150 + (i % 3) * 56 + rnd() * 14;
        const y = 118 + Math.floor(i / 3) * 62 + rnd() * 10;
        pts.push([x + 17, y + 6]);
        parts.push(pin(x, y, 36, 46, '#fffaf4'));
        parts.push(
          `<rect x="${f(x + 6)}" y="${f(y + 12)}" width="22" height="3" fill="#c9b8a6"/><rect x="${f(x + 6)}" y="${f(y + 20)}" width="18" height="3" fill="#c9b8a6"/>`,
        );
      }
      parts.push(
        `<polyline points="${[0, 4, 2, 3, 1, 5].map((i) => pts[i].map(f).join(',')).join(' ')}" fill="none" stroke="#c0392b" stroke-width="2"/>`,
      );
      for (const [x, y] of pts)
        parts.push(`<circle cx="${f(x)}" cy="${f(y)}" r="4" fill="#c0392b"/>`);
      parts.push(shelf(id, 660, 110, 170, 170, seed + 6, 3));
      parts.push(
        `<g><circle cx="745" cy="92" r="14" fill="#7fb2c9"/><path d="M 735 86 Q 745 80 752 92 T 758 98" stroke="#5c9b5a" stroke-width="5" fill="none"/><rect x="741" y="106" width="8" height="10" fill="#6b4a33"/></g>`,
      );
      break;
    }
    case 'meeting': {
      parts.push(
        frame(
          150,
          110,
          130,
          90,
          '#e7c4a8',
          `<path d="M 160 190 L 200 150 L 225 170 L 270 130 L 270 190 Z" fill="#b8643f" opacity="0.6"/>`,
        ),
      );
      parts.push(
        frame(
          690,
          110,
          120,
          90,
          '#f0dcc4',
          `<circle cx="750" cy="155" r="22" fill="#f2784b" opacity="0.7"/>`,
        ),
      );
      break;
    }
    default: {
      parts.push(
        frame(
          150,
          110,
          130,
          90,
          '#f0dcc4',
          `<circle cx="215" cy="155" r="24" fill="#f5b942" opacity="0.7"/>`,
        ),
      );
      parts.push(shelf(id, 670, 120, 160, 150, seed + 3, 3));
    }
  }
  void wall;
  return parts.join('\n');
}

/** A department's room. `motif` picks its decoration (see `RoomMotif` in the web app). */
export function sideRoom(motif, seed = 1) {
  const { w, h } = SIDE;
  const id = `r${seed}`;
  const hasScreen = motif !== 'meeting';
  const body = [
    shell(id, w, h, SIDE_WALL, {
      left: seed % 2 === 0 ? 'wood' : 'glass',
      right: seed % 2 === 0 ? 'glass' : 'wood',
      seed,
    }),
    slats(id, 340, 150, 280, 242),
    decor(id, motif, seed),
    hasScreen
      ? wallScreen(id, w, h, SIDE_SCREEN)
      : wallScreen(id, w, h, { ...SIDE_SCREEN, y: 0.2, h: 0.2 }),
    pendant(id, 300, 40, 40, 1),
    pendant(id, 660, 40, 40, 1),
    motif === 'meeting' ? meetingTable(id) : '',
    plant(id, 70, 470, 150, seed + 11, seed % 2 ? 'white' : 'terracotta'),
    plant(id, 900, 480, 140, seed + 21, seed % 2 ? 'terracotta' : 'white'),
    plant(id, 130, 330, 70, seed + 31),
  ];
  return svg(w, h, id, body.join('\n'));
}

function meetingTable(id) {
  const chairs = [];
  for (let i = 0; i < 4; i += 1) {
    const x = 330 + i * 100;
    chairs.push(`<rect x="${x}" y="398" width="46" height="40" rx="8" fill="#3b302c"/>`);
    chairs.push(`<rect x="${x}" y="520" width="46" height="44" rx="8" fill="#3b302c"/>`);
  }
  return `<g>${chairs.slice(0, 4).join('')}
    <ellipse cx="480" cy="505" rx="260" ry="30" fill="#3a2414" opacity="0.25" filter="url(#${id}-soft)"/>
    <path d="M 280 440 L 680 440 L 720 500 L 240 500 Z" fill="#c99a6b"/><path d="M 240 500 L 720 500 L 720 512 L 240 512 Z" fill="#8e5f3a"/>
    ${chairs.slice(4).join('')}</g>`;
}

function svg(w, h, id, body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">
<defs>${defs(id)}</defs>
${body}
<rect width="${w}" height="${h}" fill="url(#${id}-vignette)"/>
</svg>`;
}

/** Headquarters: Consejo y Dirección, with the city behind the glass and GIA's desk. */
export function headquarters() {
  const { w, h } = CENTRE;
  const id = 'hq';
  const wall = { x0: 70, x1: 570, y0: 50, y1: 400 };
  const rnd = prng(99);
  const towers = [];
  for (let x = 90; x < 560; x += 26 + rnd() * 18) {
    const th = 60 + rnd() * 190;
    const tw = 22 + rnd() * 26;
    const tone = ['#c7cdd3', '#b5bcc4', '#d6d9dc', '#a9b1ba'][Math.floor(rnd() * 4)];
    towers.push(
      `<rect x="${f(x)}" y="${f(300 - th)}" width="${f(tw)}" height="${f(th + 20)}" fill="${tone}"/>`,
    );
    for (let wy = 300 - th + 10; wy < 300; wy += 14)
      towers.push(
        `<rect x="${f(x + 4)}" y="${f(wy)}" width="${f(tw - 8)}" height="3" fill="#eef2f4" opacity="0.7"/>`,
      );
  }
  const body = [
    shell(id, w, h, wall, { left: 'wood', right: 'wood', seed: 7 }),
    `<clipPath id="hq-win"><rect x="110" y="72" width="420" height="250"/></clipPath>
     <g clip-path="url(#hq-win)">
       <rect x="110" y="72" width="420" height="250" fill="#f4dcc0"/>
       <rect x="110" y="72" width="420" height="160" fill="#dcebf1" opacity="0.8"/>
       <circle cx="440" cy="250" r="90" fill="#ffe2b8" opacity="0.8"/>
       ${towers.join('')}
     </g>
     <rect x="110" y="72" width="420" height="250" fill="none" stroke="#3a2c24" stroke-width="8"/>
     <line x1="250" y1="72" x2="250" y2="322" stroke="#3a2c24" stroke-width="6"/>
     <line x1="390" y1="72" x2="390" y2="322" stroke="#3a2c24" stroke-width="6"/>
     <polygon points="130,80 180,80 140,300 110,300" fill="#fff" opacity="0.18"/>`,
    shelf(id, 76, 150, 30, 200, 12, 4),
    shelf(id, 534, 150, 30, 200, 13, 4),
    `<rect x="170" y="330" width="300" height="70" fill="#e9d7c2"/>`,
    pendant(id, 200, 20, 20, 0.9),
    pendant(id, 440, 20, 20, 0.9),
    plant(id, 60, 480, 150, 41, 'white'),
    plant(id, 585, 485, 140, 42, 'terracotta'),
    // A rug under the executive desk.
    `<ellipse cx="320" cy="520" rx="220" ry="50" fill="#e6c7a6" opacity="0.8"/><ellipse cx="320" cy="520" rx="200" ry="42" fill="none" stroke="#c9936a" stroke-width="3" opacity="0.6"/>`,
  ];
  return svg(w, h, id, body.join('\n'));
}

/** The atrium where MelonMotor sits: a stair going up to headquarters, planted. */
export function atrium() {
  const { w, h } = CENTRE;
  const id = 'at';
  const wall = { x0: 90, x1: 550, y0: 40, y1: 400 };
  const steps = [];
  const n = 11;
  for (let i = 0; i < n; i += 1) {
    const t = i / n;
    const y = 400 - t * 330;
    const half = 110 - t * 40;
    steps.push(
      `<rect x="${f(320 - half)}" y="${f(y - 30)}" width="${f(half * 2)}" height="${f(30 * (1 - t * 0.5))}" fill="${i % 2 ? '#c99a6b' : '#b98555'}"/><rect x="${f(320 - half)}" y="${f(y - 30)}" width="${f(half * 2)}" height="5" fill="#e0b98c"/>`,
    );
  }
  const body = [
    shell(id, w, h, wall, { left: 'glass', right: 'glass', seed: 5 }),
    `<rect x="190" y="40" width="260" height="360" fill="#eadbc9"/>`,
    steps.join(''),
    `<line x1="200" y1="400" x2="270" y2="60" stroke="#3a2c24" stroke-width="4" opacity="0.6"/><line x1="440" y1="400" x2="370" y2="60" stroke="#3a2c24" stroke-width="4" opacity="0.6"/>`,
    `<ellipse cx="320" cy="470" rx="170" ry="46" fill="#fff4dc" opacity="0.9"/><ellipse cx="320" cy="470" rx="150" ry="38" fill="none" stroke="#f2a07b" stroke-width="3" opacity="0.8"/><ellipse cx="320" cy="470" rx="110" ry="26" fill="none" stroke="#f2784b" stroke-width="2" opacity="0.6"/>`,
    plant(id, 120, 380, 120, 51, 'white'),
    plant(id, 520, 380, 120, 52, 'white'),
    plant(id, 60, 500, 150, 53, 'terracotta'),
    plant(id, 585, 505, 150, 54, 'terracotta'),
  ];
  return svg(w, h, id, body.join('\n'));
}

/** The lounge at the bottom of the building: a round table to meet at. */
export function lounge() {
  const { w, h } = CENTRE;
  const id = 'lo';
  const wall = { x0: 70, x1: 570, y0: 50, y1: 390 };
  const body = [
    shell(id, w, h, wall, { left: 'glass', right: 'glass', seed: 3 }),
    shelf(id, 110, 110, 150, 200, 61, 4),
    shelf(id, 380, 110, 150, 200, 62, 4),
    pendant(id, 320, 20, 60, 1.2),
    `<ellipse cx="320" cy="500" rx="210" ry="56" fill="#e6c7a6"/>`,
    ...[
      [200, 450],
      [440, 450],
      [230, 520],
      [410, 520],
    ].map(
      ([x, y]) =>
        `<g><rect x="${x - 30}" y="${y - 40}" width="60" height="44" rx="12" fill="#e9e0d6" stroke="#c2b3a4" stroke-width="3"/><rect x="${x - 34}" y="${y}" width="68" height="18" rx="8" fill="#d9cdc0"/></g>`,
    ),
    `<ellipse cx="320" cy="505" rx="95" ry="12" fill="#3a2414" opacity="0.25" filter="url(#lo-soft)"/><rect x="314" y="440" width="12" height="62" fill="#3a2c24"/><ellipse cx="320" cy="440" rx="100" ry="24" fill="#f7f1ea" stroke="#d6c7b8" stroke-width="3"/>`,
    plant(id, 60, 480, 160, 63, 'white'),
    plant(id, 585, 480, 160, 64, 'white'),
  ];
  return svg(w, h, id, body.join('\n'));
}

export const MOTIFS = [
  'social',
  'video',
  'growth',
  'dashboard',
  'finance',
  'network',
  'generic',
  'meeting',
];
