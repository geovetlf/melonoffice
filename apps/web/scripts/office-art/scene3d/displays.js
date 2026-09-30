/**
 * Pictures for the office's big screens, posters and windows (Home, reference layout). A wall
 * screen reads as an app at work in that department: a dark dashboard with its kind of chart,
 * board or gallery. Shapes only: no words and no figures, so nothing is mistaken for real data.
 */
import * as THREE from 'three';
import { random } from './materials.js';

const NAVY = ['#0e1a30', '#15233f'];
const ACCENTS = ['#5aa9ff', '#4fd1e8', '#8b7cff', '#f5b942', '#ff8a5c', '#ff6fa8'];

function canvasTexture(width, height, draw) {
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  draw(c.getContext('2d'), width, height);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.roundRect(x, y, w, h, r);
}

/** Lines of placeholder text: pale bars. */
function textBars(g, x, y, widths, color = 'rgba(210,225,255,0.28)', h = 10, gap = 20) {
  g.fillStyle = color;
  widths.forEach((w, i) => {
    roundRect(g, x, y + i * gap, w, h, h / 2);
    g.fill();
  });
}

function card(g, x, y, w, h, fill = 'rgba(255,255,255,0.055)') {
  g.fillStyle = fill;
  roundRect(g, x, y, w, h, 14);
  g.fill();
  g.strokeStyle = 'rgba(160,200,255,0.12)';
  g.lineWidth = 2;
  g.stroke();
}

function sparkline(g, x, y, w, h, color, r) {
  g.strokeStyle = color;
  g.lineWidth = 4;
  g.lineJoin = 'round';
  g.beginPath();
  let v = 0.6;
  for (let i = 0; i <= 10; i += 1) {
    v = Math.max(0.1, Math.min(0.9, v - 0.05 + (r() - 0.45) * 0.25));
    const px = x + (i / 10) * w;
    const py = y + v * h;
    if (i === 0) g.moveTo(px, py);
    else g.lineTo(px, py);
  }
  g.stroke();
}

function areaChart(g, x, y, w, h, color, r, points = 14) {
  const pts = [];
  let v = 0.75;
  for (let i = 0; i < points; i += 1) {
    v = Math.max(0.12, Math.min(0.92, v - 0.045 + (r() - 0.5) * 0.18));
    pts.push([x + (i / (points - 1)) * w, y + v * h]);
  }
  const fill = g.createLinearGradient(0, y, 0, y + h);
  fill.addColorStop(0, `${color}88`);
  fill.addColorStop(1, `${color}00`);
  g.fillStyle = fill;
  g.beginPath();
  g.moveTo(x, y + h);
  pts.forEach(([px, py]) => g.lineTo(px, py));
  g.lineTo(x + w, y + h);
  g.fill();
  g.strokeStyle = color;
  g.lineWidth = 5;
  g.beginPath();
  pts.forEach(([px, py], i) => (i === 0 ? g.moveTo(px, py) : g.lineTo(px, py)));
  g.stroke();
}

function bars(g, x, y, w, h, n, r, colors = ['#5aa9ff', '#4fd1e8']) {
  const bw = w / n;
  for (let i = 0; i < n; i += 1) {
    const bh = h * (0.25 + (i / n) * 0.55 + r() * 0.2);
    const grad = g.createLinearGradient(0, y + h - bh, 0, y + h);
    grad.addColorStop(0, colors[i % colors.length]);
    grad.addColorStop(1, `${colors[(i + 1) % colors.length]}55`);
    g.fillStyle = grad;
    roundRect(g, x + i * bw + bw * 0.18, y + h - bh, bw * 0.64, bh, 6);
    g.fill();
  }
}

function donut(g, cx, cy, radius, parts, width = 26) {
  let a = -Math.PI / 2;
  for (const [share, color] of parts) {
    g.strokeStyle = color;
    g.lineWidth = width;
    g.beginPath();
    g.arc(cx, cy, radius, a + 0.04, a + share * Math.PI * 2 - 0.04);
    g.stroke();
    a += share * Math.PI * 2;
  }
}

/** A photo-like thumbnail: soft gradient shapes. */
function thumb(g, x, y, w, h, seed) {
  const r = random(seed);
  const a = ACCENTS[Math.floor(r() * ACCENTS.length)];
  const b = ACCENTS[Math.floor(r() * ACCENTS.length)];
  const grad = g.createLinearGradient(x, y, x + w, y + h);
  grad.addColorStop(0, a);
  grad.addColorStop(1, b);
  g.save();
  roundRect(g, x, y, w, h, 10);
  g.clip();
  g.fillStyle = grad;
  g.fillRect(x, y, w, h);
  g.fillStyle = 'rgba(255,255,255,0.35)';
  g.beginPath();
  g.arc(
    x + w * (0.3 + r() * 0.4),
    y + h * (0.35 + r() * 0.3),
    Math.min(w, h) * 0.25,
    0,
    Math.PI * 2,
  );
  g.fill();
  g.fillStyle = 'rgba(10,20,40,0.25)';
  g.fillRect(x, y + h * 0.72, w, h * 0.28);
  g.restore();
}

function worldMap(g, x, y, w, h, r) {
  // Continents as clouds of lit dots.
  const blobs = [
    [0.18, 0.32, 0.13, 0.16],
    [0.27, 0.68, 0.07, 0.17],
    [0.49, 0.3, 0.07, 0.1],
    [0.52, 0.6, 0.08, 0.17],
    [0.7, 0.33, 0.17, 0.15],
    [0.83, 0.72, 0.06, 0.07],
  ];
  for (let i = 0; i < 1400; i += 1) {
    const [bx, by, rx, ry] = blobs[i % blobs.length];
    const a = r() * Math.PI * 2;
    const d = Math.sqrt(r());
    const px = x + (bx + Math.cos(a) * rx * d) * w;
    const py = y + (by + Math.sin(a) * ry * d) * h;
    g.fillStyle = r() < 0.08 ? '#9fdcff' : 'rgba(90,169,255,0.75)';
    g.fillRect(px, py, 4, 4);
  }
  g.strokeStyle = 'rgba(255,138,92,0.9)';
  g.lineWidth = 3;
  for (const [ax, ay, bx, by] of [
    [0.18, 0.32, 0.49, 0.3],
    [0.49, 0.3, 0.7, 0.33],
    [0.27, 0.68, 0.52, 0.6],
  ]) {
    g.beginPath();
    g.moveTo(x + ax * w, y + ay * h);
    g.quadraticCurveTo(
      x + ((ax + bx) / 2) * w,
      y + (Math.min(ay, by) - 0.18) * h,
      x + bx * w,
      y + by * h,
    );
    g.stroke();
  }
  g.strokeStyle = 'rgba(90,169,255,0.25)';
  g.lineWidth = 2;
  g.beginPath();
  g.ellipse(x + w / 2, y + h / 2, w * 0.49, h * 0.47, 0, 0, Math.PI * 2);
  g.stroke();
}

/**
 * A department's big screen: `growth` (Comercial: funnel and pipeline), `dashboard`
 * (Operaciones: kanban and flow), `social` (Marketing: campaigns and creatives), `video`
 * (Diseño: a design canvas and layers), `network` (Investigación: data and trends), `finance`
 * (Finanzas: charts), `map` (Consejo: the world and objectives).
 */
export function wallDisplay(kind, seed = 1) {
  const r = random(seed);
  return canvasTexture(1600, 860, (g, w, h) => {
    const bg = g.createLinearGradient(0, 0, w, h);
    bg.addColorStop(0, NAVY[1]);
    bg.addColorStop(1, NAVY[0]);
    g.fillStyle = bg;
    g.fillRect(0, 0, w, h);
    const glow = g.createRadialGradient(w * 0.3, h * 0.2, 10, w * 0.3, h * 0.2, w * 0.7);
    glow.addColorStop(0, 'rgba(90,169,255,0.18)');
    glow.addColorStop(1, 'rgba(90,169,255,0)');
    g.fillStyle = glow;
    g.fillRect(0, 0, w, h);
    // The app's frame: a top bar and a rail of icons.
    g.fillStyle = 'rgba(255,255,255,0.05)';
    g.fillRect(0, 0, w, 64);
    g.fillStyle = '#ff8a5c';
    g.beginPath();
    g.arc(40, 32, 13, 0, Math.PI * 2);
    g.fill();
    textBars(g, 68, 26, [160], 'rgba(230,240,255,0.55)', 12);
    for (let i = 0; i < 3; i += 1) {
      g.fillStyle = 'rgba(255,255,255,0.14)';
      g.beginPath();
      g.arc(w - 40 - i * 44, 32, 12, 0, Math.PI * 2);
      g.fill();
    }
    for (let i = 0; i < 7; i += 1) {
      g.fillStyle = i === 1 ? '#5aa9ff' : 'rgba(255,255,255,0.16)';
      roundRect(g, 22, 100 + i * 64, 36, 36, 9);
      g.fill();
    }
    const X = 90;
    const Y = 90;
    const W = w - X - 30;
    const H = h - Y - 30;
    switch (kind) {
      case 'growth': {
        card(g, X, Y, W * 0.52, H);
        textBars(g, X + 28, Y + 26, [220, 140]);
        const colors = ['#8b7cff', '#6f8dff', '#5aa9ff', '#4fd1e8', '#f5b942', '#ff8a5c'];
        const top = Y + 110;
        const fw = W * 0.4;
        const cx = X + W * 0.26;
        for (let i = 0; i < 6; i += 1) {
          const y0 = top + i * 92;
          const w0 = fw * (1 - i * 0.15);
          const w1 = fw * (1 - (i + 1) * 0.15);
          const grad = g.createLinearGradient(cx - w0 / 2, 0, cx + w0 / 2, 0);
          grad.addColorStop(0, `${colors[i]}cc`);
          grad.addColorStop(0.5, colors[i]);
          grad.addColorStop(1, `${colors[i]}cc`);
          g.fillStyle = grad;
          g.beginPath();
          g.moveTo(cx - w0 / 2, y0);
          g.lineTo(cx + w0 / 2, y0);
          g.lineTo(cx + w1 / 2, y0 + 84);
          g.lineTo(cx - w1 / 2, y0 + 84);
          g.closePath();
          g.fill();
        }
        const px = X + W * 0.55;
        for (let col = 0; col < 3; col += 1) {
          const cw = (W * 0.45 - 40) / 3;
          card(g, px + col * (cw + 20), Y, cw, H * 0.62);
          textBars(g, px + col * (cw + 20) + 18, Y + 22, [cw * 0.5]);
          for (let i = 0; i < 3 - (col === 2 ? 1 : 0); i += 1) {
            card(
              g,
              px + col * (cw + 20) + 14,
              Y + 60 + i * 110,
              cw - 28,
              94,
              'rgba(255,255,255,0.08)',
            );
            g.fillStyle = colors[(col * 2 + i) % colors.length];
            roundRect(g, px + col * (cw + 20) + 28, Y + 76 + i * 110, 30, 30, 8);
            g.fill();
            textBars(g, px + col * (cw + 20) + 70, Y + 80 + i * 110, [cw * 0.4, cw * 0.28]);
          }
        }
        card(g, px, Y + H * 0.66, W * 0.45 - 10, H * 0.34);
        areaChart(g, px + 20, Y + H * 0.72, W * 0.45 - 50, H * 0.24, '#4fd1e8', r);
        break;
      }
      case 'dashboard': {
        const colors = ['#5aa9ff', '#f5b942', '#8b7cff', '#4fd1e8'];
        const cw = (W - 60) / 4;
        for (let col = 0; col < 4; col += 1) {
          card(g, X + col * (cw + 20), Y, cw, H * 0.64);
          g.fillStyle = colors[col];
          roundRect(g, X + col * (cw + 20) + 18, Y + 22, 60, 10, 5);
          g.fill();
          const n = [4, 3, 3, 2][col];
          for (let i = 0; i < n; i += 1) {
            card(
              g,
              X + col * (cw + 20) + 14,
              Y + 50 + i * 88,
              cw - 28,
              76,
              'rgba(255,255,255,0.08)',
            );
            g.fillStyle = colors[col];
            g.fillRect(X + col * (cw + 20) + 14, Y + 50 + i * 88, 6, 76);
            textBars(g, X + col * (cw + 20) + 34, Y + 66 + i * 88, [cw * 0.55, cw * 0.35]);
          }
        }
        // A process: steps joined by arrows.
        card(g, X, Y + H * 0.68, W, H * 0.32);
        const steps = 5;
        for (let i = 0; i < steps; i += 1) {
          const sx = X + 60 + i * ((W - 120) / (steps - 1));
          const sy = Y + H * 0.84;
          if (i < steps - 1) {
            g.strokeStyle = 'rgba(90,169,255,0.7)';
            g.lineWidth = 4;
            g.beginPath();
            g.moveTo(sx + 40, sy);
            g.lineTo(sx + (W - 120) / (steps - 1) - 40, sy);
            g.stroke();
          }
          g.fillStyle = i < 3 ? colors[i % colors.length] : 'rgba(255,255,255,0.2)';
          g.beginPath();
          g.arc(sx, sy, 32, 0, Math.PI * 2);
          g.fill();
        }
        break;
      }
      case 'social': {
        card(g, X, Y, W * 0.62, H);
        for (let i = 0; i < 6; i += 1) {
          const tw = (W * 0.62 - 80) / 3;
          const th = (H - 100) / 2;
          thumb(
            g,
            X + 20 + (i % 3) * (tw + 20),
            Y + 70 + Math.floor(i / 3) * (th + 10),
            tw,
            th - 10,
            seed * 10 + i,
          );
        }
        textBars(g, X + 24, Y + 24, [200]);
        const px = X + W * 0.64;
        card(g, px, Y, W * 0.36, H * 0.48);
        areaChart(g, px + 20, Y + 60, W * 0.36 - 40, H * 0.36, '#ff6fa8', r);
        card(g, px, Y + H * 0.52, W * 0.36, H * 0.48);
        donut(g, px + 110, Y + H * 0.76, 70, [
          [0.42, '#8b7cff'],
          [0.33, '#ff6fa8'],
          [0.25, '#4fd1e8'],
        ]);
        textBars(g, px + 220, Y + H * 0.66, [140, 110, 160, 90]);
        break;
      }
      case 'video': {
        card(g, X, Y, W * 0.7, H);
        const cx = X + W * 0.35;
        const cy = Y + H * 0.55;
        const plate = g.createRadialGradient(cx, cy + 60, 10, cx, cy + 60, 300);
        plate.addColorStop(0, 'rgba(79,209,232,0.8)');
        plate.addColorStop(1, 'rgba(79,209,232,0)');
        g.fillStyle = plate;
        g.beginPath();
        g.ellipse(cx, cy + 90, 300, 80, 0, 0, Math.PI * 2);
        g.fill();
        const blob = g.createLinearGradient(cx - 180, cy - 160, cx + 180, cy + 100);
        blob.addColorStop(0, '#ff8a5c');
        blob.addColorStop(0.5, '#8b7cff');
        blob.addColorStop(1, '#4fd1e8');
        g.fillStyle = blob;
        g.beginPath();
        g.moveTo(cx - 200, cy + 60);
        g.bezierCurveTo(cx - 190, cy - 170, cx + 40, cy - 230, cx + 190, cy - 40);
        g.bezierCurveTo(cx + 240, cy + 40, cx + 60, cy + 110, cx - 200, cy + 60);
        g.fill();
        for (let i = 0; i < 4; i += 1) thumb(g, X + 24 + i * 150, Y + 24, 130, 70, seed * 7 + i);
        const px = X + W * 0.72;
        card(g, px, Y, W * 0.28, H);
        for (let i = 0; i < 7; i += 1) {
          g.fillStyle = ACCENTS[i % ACCENTS.length];
          roundRect(g, px + 20, Y + 30 + i * 80, 48, 48, 10);
          g.fill();
          textBars(g, px + 86, Y + 40 + i * 80, [W * 0.12, W * 0.08]);
        }
        break;
      }
      case 'network': {
        card(g, X, Y, W * 0.58, H);
        const pts = Array.from({ length: 34 }, (_, i) => {
          const a = r() * Math.PI * 2;
          const d = Math.sqrt(r()) * (i < 6 ? 0.3 : 1);
          return [
            X + W * 0.29 + Math.cos(a) * d * W * 0.25,
            Y + H * 0.5 + Math.sin(a) * d * H * 0.4,
          ];
        });
        g.lineWidth = 2;
        for (let i = 0; i < pts.length; i += 1) {
          for (const j of [(i * 7 + 3) % pts.length, (i * 11 + 5) % pts.length]) {
            g.strokeStyle = 'rgba(120,190,255,0.35)';
            g.beginPath();
            g.moveTo(...pts[i]);
            g.lineTo(...pts[j]);
            g.stroke();
          }
        }
        pts.forEach(([px, py], i) => {
          g.fillStyle = i % 5 === 0 ? '#8b7cff' : i % 3 === 0 ? '#4fd1e8' : '#9fd0ff';
          g.shadowColor = '#5aa9ff';
          g.shadowBlur = 18;
          g.beginPath();
          g.arc(px, py, i % 5 === 0 ? 12 : 6, 0, Math.PI * 2);
          g.fill();
        });
        g.shadowBlur = 0;
        const px = X + W * 0.6;
        card(g, px, Y, W * 0.4, H * 0.5);
        areaChart(g, px + 20, Y + 60, W * 0.4 - 40, H * 0.38, '#8b7cff', r);
        card(g, px, Y + H * 0.54, W * 0.4, H * 0.46);
        for (let i = 0; i < 4; i += 1) {
          g.fillStyle = 'rgba(255,255,255,0.12)';
          roundRect(g, px + 20, Y + H * 0.58 + i * 76, 44, 56, 6);
          g.fill();
          textBars(g, px + 80, Y + H * 0.6 + i * 76, [W * 0.2, W * 0.13]);
        }
        break;
      }
      case 'finance': {
        card(g, X, Y, W * 0.3, H * 0.56);
        donut(
          g,
          X + W * 0.15,
          Y + H * 0.3,
          120,
          [
            [0.4, '#4fd1e8'],
            [0.25, '#f5b942'],
            [0.2, '#8b7cff'],
            [0.15, '#ff8a5c'],
          ],
          36,
        );
        card(g, X, Y + H * 0.6, W * 0.3, H * 0.4);
        sparkline(g, X + 24, Y + H * 0.68, W * 0.3 - 48, H * 0.26, '#f5b942', r);
        card(g, X + W * 0.32, Y, W * 0.68, H);
        textBars(g, X + W * 0.32 + 28, Y + 26, [220, 120]);
        bars(g, X + W * 0.32 + 30, Y + 110, W * 0.68 - 60, H - 150, 12, r, [
          '#4fd1e8',
          '#5aa9ff',
          '#8b7cff',
        ]);
        areaChart(g, X + W * 0.32 + 30, Y + 110, W * 0.68 - 60, H * 0.45, '#f5b942', r, 12);
        break;
      }
      case 'map': {
        card(g, X, Y, W * 0.72, H);
        worldMap(g, X + 20, Y + 40, W * 0.72 - 40, H - 60, r);
        const px = X + W * 0.74;
        for (let i = 0; i < 3; i += 1) {
          card(g, px, Y + i * (H / 3), W * 0.26, H / 3 - 16);
          textBars(g, px + 20, Y + i * (H / 3) + 22, [W * 0.1]);
          sparkline(g, px + 20, Y + i * (H / 3) + 60, W * 0.26 - 40, H / 3 - 110, ACCENTS[i], r);
        }
        break;
      }
      default: {
        for (let i = 0; i < 4; i += 1) {
          card(
            g,
            X + (i % 2) * (W / 2 + 10),
            Y + Math.floor(i / 2) * (H / 2 + 10),
            W / 2 - 10,
            H / 2 - 10,
          );
          areaChart(
            g,
            X + (i % 2) * (W / 2 + 10) + 20,
            Y + Math.floor(i / 2) * (H / 2 + 10) + 60,
            W / 2 - 50,
            H / 2 - 100,
            ACCENTS[i],
            r,
          );
        }
      }
    }
  });
}

/** A monitor's picture at a desk: a smaller dashboard of the department's kind. */
export function deskDisplay(kind, seed = 3) {
  return wallDisplay(kind, seed + 50);
}

/** A framed print or a moodboard sheet: soft colour shapes. */
export function posterTexture(seed = 1, cols = 1, rows = 1) {
  const r = random(seed);
  return canvasTexture(400 * cols, 520 * rows, (g, w, h) => {
    g.fillStyle = '#f7f4f0';
    g.fillRect(0, 0, w, h);
    const cw = w / cols;
    const ch = h / rows;
    for (let i = 0; i < cols * rows; i += 1) {
      const x = (i % cols) * cw;
      const y = Math.floor(i / cols) * ch;
      thumb(g, x + 18, y + 18, cw - 36, ch - 36, seed * 13 + i);
      if (r() < 0.5) {
        g.fillStyle = 'rgba(255,255,255,0.7)';
        g.fillRect(x + 40, y + ch - 90, cw * 0.5, 14);
      }
    }
  });
}

/** What the windows look onto: a bright morning, trees and far towers, softly out of focus. */
export function outsideTexture(seed = 4) {
  const r = random(seed);
  return canvasTexture(1024, 768, (g, w, h) => {
    const sky = g.createLinearGradient(0, 0, 0, h);
    sky.addColorStop(0, '#cfe3f5');
    sky.addColorStop(0.55, '#f6efe2');
    sky.addColorStop(1, '#e9e2d2');
    g.fillStyle = sky;
    g.fillRect(0, 0, w, h);
    g.filter = 'blur(6px)';
    for (let i = 0; i < 14; i += 1) {
      g.fillStyle = `rgba(${170 + r() * 40},${190 + r() * 30},${215 + r() * 20},0.7)`;
      const bw = 40 + r() * 90;
      const bh = 160 + r() * 320;
      g.fillRect(r() * w, h * 0.62 - bh, bw, bh);
    }
    g.filter = 'blur(10px)';
    for (let i = 0; i < 70; i += 1) {
      const green = ['#6f9a58', '#8fb56c', '#557f48', '#a9c47f'][Math.floor(r() * 4)];
      g.fillStyle = green;
      g.beginPath();
      g.arc(r() * w, h * (0.55 + r() * 0.45), 30 + r() * 80, 0, Math.PI * 2);
      g.fill();
    }
    g.filter = 'none';
    const sun = g.createRadialGradient(w * 0.2, h * 0.25, 10, w * 0.2, h * 0.25, w * 0.6);
    sun.addColorStop(0, 'rgba(255,240,210,0.85)');
    sun.addColorStop(1, 'rgba(255,240,210,0)');
    g.fillStyle = sun;
    g.fillRect(0, 0, w, h);
  });
}

/** MelonMotor's wall: dark glass traced with fine circuits of light. */
export function circuitTexture(seed = 9) {
  const r = random(seed);
  return canvasTexture(1024, 1024, (g, w, h) => {
    const bg = g.createLinearGradient(0, 0, 0, h);
    bg.addColorStop(0, '#0f2a52');
    bg.addColorStop(1, '#0b1c38');
    g.fillStyle = bg;
    g.fillRect(0, 0, w, h);
    g.shadowColor = '#5aa9ff';
    g.shadowBlur = 12;
    for (let i = 0; i < 40; i += 1) {
      let x = r() * w;
      let y = r() * h;
      g.strokeStyle = r() < 0.15 ? 'rgba(255,170,120,0.8)' : 'rgba(120,190,255,0.75)';
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(x, y);
      for (let s = 0; s < 4; s += 1) {
        if (r() < 0.5) x += (r() - 0.5) * 300;
        else y += (r() - 0.5) * 300;
        g.lineTo(x, y);
      }
      g.stroke();
      g.fillStyle = '#bfe0ff';
      g.beginPath();
      g.arc(x, y, 4, 0, Math.PI * 2);
      g.fill();
    }
  });
}
