/**
 * Materials for the office's 3D art (Home V4): polished composite, glass, metal, fabric, light,
 * ceramic and leaves, with textures drawn on a canvas from a seeded random source, so every bake
 * is the same. Nothing here shows data or text.
 */
import * as THREE from 'three';

/** A small seeded random source (mulberry32). */
export function random(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function canvas(width, height, draw) {
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  draw(c.getContext('2d'), width, height);
  return c;
}

function texture(c, repeat = [1, 1], color = true) {
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat[0], repeat[1]);
  t.anisotropy = 8;
  if (color) t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function noise(base, seed, amount = 10, size = 512) {
  const r = random(seed);
  return canvas(size, size, (g, w, h) => {
    g.fillStyle = base;
    g.fillRect(0, 0, w, h);
    const image = g.getImageData(0, 0, w, h);
    for (let i = 0; i < image.data.length; i += 4) {
      const n = (r() - 0.5) * amount;
      image.data[i] += n;
      image.data[i + 1] += n;
      image.data[i + 2] += n;
    }
    g.putImageData(image, 0, 0);
  });
}

/** A woven fabric: fine crossing threads. */
function weave(base, seed) {
  const r = random(seed);
  return canvas(256, 256, (g, w, h) => {
    g.fillStyle = base;
    g.fillRect(0, 0, w, h);
    for (let i = 0; i < w; i += 3) {
      g.fillStyle = `rgba(255,255,255,${0.03 + r() * 0.04})`;
      g.fillRect(i, 0, 1, h);
      g.fillStyle = `rgba(0,0,0,${0.04 + r() * 0.05})`;
      g.fillRect(0, i, w, 1);
    }
  });
}

/** Large pale tiles of polished composite, with fine joints and a faint cloud. */
function tiles(seed) {
  const r = random(seed);
  return canvas(1024, 1024, (g, w, h) => {
    g.fillStyle = '#e6e3de';
    g.fillRect(0, 0, w, h);
    for (let i = 0; i < 900; i += 1) {
      g.fillStyle = `rgba(${r() < 0.5 ? '255,255,255' : '160,170,185'},${0.05 + r() * 0.06})`;
      const s = 6 + r() * 30;
      g.beginPath();
      g.arc(r() * w, r() * h, s, 0, Math.PI * 2);
      g.fill();
    }
    g.fillStyle = 'rgba(120,130,145,0.22)';
    for (let i = 0; i <= 2; i += 1) {
      g.fillRect(0, (i * h) / 2 - 1, w, 2);
      g.fillRect((i * w) / 2 - 1, 0, 2, h);
    }
  });
}

export function makeMaterials() {
  const floor = new THREE.MeshPhysicalMaterial({
    map: texture(tiles(7), [1, 1]),
    transparent: true,
    opacity: 0.62,
    roughness: 0.22,
    clearcoat: 0.6,
    clearcoatRoughness: 0.2,
  });
  // White composite: desks, cabinets, fronts.
  const composite = new THREE.MeshPhysicalMaterial({
    color: '#f5f6f8',
    roughness: 0.32,
    clearcoat: 0.3,
  });
  // Pale grey composite: sideboards, shelving, frames.
  const stone = new THREE.MeshStandardMaterial({ color: '#d8dde4', roughness: 0.4 });
  const wall = new THREE.MeshStandardMaterial({
    map: texture(noise('#f4f1ec', 3, 4), [3, 3]),
    roughness: 0.9,
  });
  const wallTint = new THREE.MeshStandardMaterial({
    map: texture(noise('#eef0f3', 4, 4), [3, 3]),
    roughness: 0.9,
  });
  const ceiling = new THREE.MeshStandardMaterial({ color: '#f6f0ea', roughness: 0.95 });
  const glass = new THREE.MeshPhysicalMaterial({
    color: '#ffffff',
    metalness: 0,
    roughness: 0.04,
    transmission: 0.92,
    thickness: 0.02,
    ior: 1.45,
    transparent: true,
    opacity: 0.35,
  });
  const frosted = new THREE.MeshPhysicalMaterial({
    color: '#f5efe9',
    roughness: 0.35,
    transmission: 0.6,
    transparent: true,
    opacity: 0.55,
  });
  const blackMetal = new THREE.MeshStandardMaterial({
    color: '#3a3f47',
    roughness: 0.38,
    metalness: 0.7,
  });
  const aluminium = new THREE.MeshStandardMaterial({
    color: '#c9c7c4',
    roughness: 0.3,
    metalness: 0.85,
  });
  const brass = new THREE.MeshStandardMaterial({
    color: '#d9dde3',
    roughness: 0.3,
    metalness: 0.9,
  });
  const white = new THREE.MeshStandardMaterial({ color: '#f7f8fa', roughness: 0.35 });
  const ceramic = new THREE.MeshStandardMaterial({ color: '#f4f5f7', roughness: 0.3 });
  const terracotta = new THREE.MeshStandardMaterial({ color: '#c9ced6', roughness: 0.4 });
  const soil = new THREE.MeshStandardMaterial({ color: '#3a2a20', roughness: 1 });
  const leaf = new THREE.MeshStandardMaterial({
    color: '#4f7a45',
    roughness: 0.55,
    side: THREE.DoubleSide,
  });
  const leafLight = new THREE.MeshStandardMaterial({
    color: '#6d9559',
    roughness: 0.55,
    side: THREE.DoubleSide,
  });
  const fabric = (base, seed = 5) =>
    new THREE.MeshStandardMaterial({ map: texture(weave(base, seed), [2, 2]), roughness: 0.9 });
  const rug = new THREE.MeshStandardMaterial({
    map: texture(weave('#dfe3e9', 9), [6, 4]),
    roughness: 1,
  });
  const screenOff = new THREE.MeshStandardMaterial({
    color: '#141315',
    roughness: 0.15,
    metalness: 0.2,
  });
  const bezel = new THREE.MeshStandardMaterial({
    color: '#1d1c1f',
    roughness: 0.35,
    metalness: 0.3,
  });
  const lampGlow = new THREE.MeshStandardMaterial({
    color: '#f4f8ff',
    emissive: '#eaf2ff',
    emissiveIntensity: 2.4,
  });
  const bronze = new THREE.MeshStandardMaterial({
    color: '#6f5d4e',
    roughness: 0.4,
    metalness: 0.6,
  });
  const slab = new THREE.MeshStandardMaterial({ color: '#cfd5de', roughness: 0.6 });
  // Integrated light: cool LED lines, and the brand's coral for GIA and MelonMotor.
  const led = new THREE.MeshStandardMaterial({
    color: '#dff0ff',
    emissive: '#8fc4ff',
    emissiveIntensity: 4,
  });
  const ledCoral = new THREE.MeshStandardMaterial({
    color: '#ffd9c7',
    emissive: '#ff8a5c',
    emissiveIntensity: 4,
  });
  // A glass display: a picture glowing on clear glass.
  const holo = (map, opacity = 1) =>
    new THREE.MeshBasicMaterial({
      map,
      transparent: true,
      opacity,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
  const corridor = new THREE.MeshStandardMaterial({
    color: '#f6eee6',
    emissive: '#fff3e6',
    emissiveIntensity: 0.35,
    roughness: 1,
  });
  return {
    slab,
    bronze,
    led,
    ledCoral,
    holo,
    corridor,
    floor,
    composite,
    stone,
    wall,
    wallTint,
    ceiling,
    glass,
    frosted,
    blackMetal,
    aluminium,
    brass,
    white,
    ceramic,
    terracotta,
    soil,
    leaf,
    leafLight,
    fabric,
    rug,
    screenOff,
    bezel,
    lampGlow,
  };
}

/** A screen's picture: shapes that say what the room does, never numbers or words. */
export function screenTexture(kind, hue = '#f2784b', seed = 1) {
  const r = random(seed);
  const c = canvas(512, 320, (g, w, h) => {
    const bg = g.createLinearGradient(0, 0, 0, h);
    bg.addColorStop(0, '#182335');
    bg.addColorStop(1, '#0f1726');
    g.fillStyle = bg;
    g.fillRect(0, 0, w, h);
    // A header strip and a side rail, like an app.
    g.fillStyle = 'rgba(255,255,255,0.06)';
    g.fillRect(0, 0, w, 28);
    g.fillRect(0, 28, 60, h - 28);
    for (let i = 0; i < 5; i += 1) {
      g.fillStyle = i === 1 ? hue : 'rgba(255,255,255,0.18)';
      g.fillRect(16, 48 + i * 30, 28, 6);
    }
    const x0 = 80;
    const bars = (n, color) => {
      for (let i = 0; i < n; i += 1) {
        const bh = 40 + r() * 150 + i * 8;
        g.fillStyle = i === n - 1 ? hue : color;
        g.fillRect(x0 + 10 + i * ((w - x0 - 30) / n), h - 30 - bh, (w - x0 - 30) / n - 10, bh);
      }
    };
    const line = (color, width = 3) => {
      g.strokeStyle = color;
      g.lineWidth = width;
      g.beginPath();
      let y = h - 80;
      for (let x = x0 + 10; x < w - 20; x += 30) {
        y = Math.max(60, Math.min(h - 40, y - 10 + (r() - 0.35) * 40));
        if (x === x0 + 10) g.moveTo(x, y);
        else g.lineTo(x, y);
      }
      g.stroke();
    };
    const cards = (cols) => {
      const cw = (w - x0 - 20) / cols - 10;
      for (let col = 0; col < cols; col += 1) {
        g.fillStyle = 'rgba(255,255,255,0.05)';
        g.fillRect(x0 + col * (cw + 10), 44, cw, h - 60);
        const n = 2 + Math.floor(r() * 3);
        for (let i = 0; i < n; i += 1) {
          g.fillStyle = i === 0 && col === 1 ? hue : 'rgba(255,255,255,0.16)';
          g.fillRect(x0 + col * (cw + 10) + 6, 54 + i * 44, cw - 12, 34);
        }
      }
    };
    const tiles = () => {
      for (let i = 0; i < 6; i += 1) {
        const col = i % 3;
        const row = Math.floor(i / 3);
        const tw = (w - x0 - 40) / 3;
        g.fillStyle = [hue, '#e8b04a', '#7aa0c4', '#d97d62', '#9fbf8a', '#c9a0d6'][i];
        g.globalAlpha = 0.75;
        g.fillRect(x0 + col * (tw + 10), 44 + row * 130, tw, 118);
        g.globalAlpha = 1;
      }
    };
    const donut = () => {
      const cx = x0 + 90;
      const cy = h / 2 + 10;
      let a = -Math.PI / 2;
      for (const [part, color] of [
        [0.45, hue],
        [0.3, '#e8b04a'],
        [0.25, 'rgba(255,255,255,0.25)'],
      ]) {
        g.strokeStyle = color;
        g.lineWidth = 26;
        g.beginPath();
        g.arc(cx, cy, 64, a, a + part * Math.PI * 2);
        g.stroke();
        a += part * Math.PI * 2;
      }
    };
    const network = () => {
      const pts = Array.from({ length: 14 }, () => [
        x0 + 20 + r() * (w - x0 - 50),
        50 + r() * (h - 80),
      ]);
      g.strokeStyle = 'rgba(255,255,255,0.18)';
      g.lineWidth = 1.5;
      for (let i = 0; i < pts.length; i += 1) {
        const [ax, ay] = pts[i];
        const [bx, by] = pts[(i * 5 + 3) % pts.length];
        g.beginPath();
        g.moveTo(ax, ay);
        g.lineTo(bx, by);
        g.stroke();
      }
      for (const [i, [x, y]] of pts.entries()) {
        g.fillStyle = i % 4 === 0 ? hue : 'rgba(255,255,255,0.55)';
        g.beginPath();
        g.arc(x, y, i % 4 === 0 ? 7 : 4, 0, Math.PI * 2);
        g.fill();
      }
    };
    switch (kind) {
      case 'growth':
        bars(7, 'rgba(255,255,255,0.22)');
        line('#ffffff', 3);
        break;
      case 'finance':
        line(hue, 4);
        line('rgba(255,255,255,0.5)', 2);
        break;
      case 'dashboard':
        cards(4);
        break;
      case 'social':
      case 'video':
        tiles();
        break;
      case 'network':
        network();
        break;
      case 'map':
        donut();
        bars(4, 'rgba(255,255,255,0.18)');
        break;
      default:
        cards(3);
    }
  });
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const GLOW = '#7cc0ff';
const GLOW_SOFT = 'rgba(185,220,255,0.55)';
const CORAL = '#ff8a5c';

/**
 * A glass display's picture: glowing shapes on clear glass that say what a department does,
 * never words or numbers. The background is transparent, so the wall shows through.
 */
export function panelTexture(kind, seed = 3) {
  const r = random(seed);
  const c = canvas(640, 400, (g, w, h) => {
    g.clearRect(0, 0, w, h);
    const tint = g.createLinearGradient(0, 0, w, h);
    tint.addColorStop(0, 'rgba(18,30,50,0.88)');
    tint.addColorStop(1, 'rgba(28,44,70,0.8)');
    g.fillStyle = tint;
    g.fillRect(0, 0, w, h);
    g.strokeStyle = 'rgba(190,225,255,0.8)';
    g.lineWidth = 3;
    g.strokeRect(1.5, 1.5, w - 3, h - 3);
    g.shadowColor = GLOW;
    g.shadowBlur = 14;
    const bar = (x, y, bw, bh, color) => {
      g.fillStyle = color;
      g.fillRect(x, y, bw, bh);
    };
    const line = (points, color, width = 4) => {
      g.strokeStyle = color;
      g.lineWidth = width;
      g.beginPath();
      points.forEach(([x, y], i) => (i === 0 ? g.moveTo(x, y) : g.lineTo(x, y)));
      g.stroke();
    };
    const series = (n, y0, amp) =>
      Array.from({ length: n }, (_, i) => [
        40 + (i * (w - 80)) / (n - 1),
        y0 - i * (amp / n) + (r() - 0.5) * amp * 0.5,
      ]);
    switch (kind) {
      case 'funnel': // Comercial
        for (let i = 0; i < 5; i += 1) {
          const bw = 440 - i * 80;
          bar((w - bw) / 2, 40 + i * 66, bw, 48, i === 4 ? CORAL : i % 2 ? GLOW_SOFT : GLOW);
        }
        break;
      case 'pipeline':
        for (let col = 0; col < 5; col += 1) {
          bar(30 + col * 120, 30, 100, 6, col === 4 ? CORAL : GLOW);
          for (let i = 0; i < 5 - col; i += 1)
            bar(
              30 + col * 120,
              56 + i * 64,
              100,
              48,
              col === 4 ? 'rgba(255,138,92,0.7)' : GLOW_SOFT,
            );
        }
        break;
      case 'kanban': // Operaciones
        for (let col = 0; col < 4; col += 1) {
          bar(30 + col * 150, 30, 130, 6, GLOW);
          const n = 2 + Math.floor(r() * 3);
          for (let i = 0; i < n; i += 1)
            bar(
              30 + col * 150,
              56 + i * 76,
              130,
              58,
              i === 0 && col === 2 ? 'rgba(255,138,92,0.75)' : GLOW_SOFT,
            );
        }
        break;
      case 'flow': {
        const nodes = [
          [80, 90],
          [240, 90],
          [400, 90],
          [560, 200],
          [400, 310],
          [240, 310],
        ];
        line(nodes, GLOW, 5);
        nodes.forEach(([x, y], i) =>
          bar(x - 55, y - 32, 110, 64, i === 3 ? 'rgba(255,138,92,0.8)' : GLOW_SOFT),
        );
        break;
      }
      case 'creatives': // Marketing
        for (let i = 0; i < 6; i += 1) {
          const x = 30 + (i % 3) * 200;
          const y = 30 + Math.floor(i / 3) * 180;
          const grad = g.createLinearGradient(x, y, x + 180, y + 160);
          grad.addColorStop(0, i % 2 ? 'rgba(255,138,92,0.8)' : 'rgba(124,192,255,0.85)');
          grad.addColorStop(1, 'rgba(210,190,255,0.7)');
          g.fillStyle = grad;
          g.fillRect(x, y, 180, 160);
        }
        break;
      case 'social':
        for (let i = 0; i < 4; i += 1) {
          g.fillStyle = i === 1 ? CORAL : GLOW;
          g.beginPath();
          g.arc(90 + i * 150, 110, 48, 0, Math.PI * 2);
          g.fill();
          bar(50 + i * 150, 190, 80, 150 - i * 25, GLOW_SOFT);
        }
        break;
      case 'charts': // Finanzas
        for (let i = 0; i < 9; i += 1)
          bar(
            40 + i * 64,
            h - 40 - (60 + i * 22 + r() * 40),
            40,
            60 + i * 22 + r() * 40,
            i === 8 ? CORAL : GLOW_SOFT,
          );
        line(series(9, h - 120, 220), '#ffffff', 4);
        break;
      case 'donut': {
        let a = -Math.PI / 2;
        for (const [part, color] of [
          [0.5, GLOW],
          [0.3, CORAL],
          [0.2, GLOW_SOFT],
        ]) {
          g.strokeStyle = color;
          g.lineWidth = 42;
          g.beginPath();
          g.arc(170, h / 2, 110, a, a + part * Math.PI * 2);
          g.stroke();
          a += part * Math.PI * 2;
        }
        for (let i = 0; i < 4; i += 1)
          bar(340, 90 + i * 64, 240 - i * 40, 30, i === 0 ? CORAL : GLOW_SOFT);
        break;
      }
      case 'network': {
        // Investigación
        const pts = Array.from({ length: 16 }, () => [40 + r() * (w - 80), 40 + r() * (h - 80)]);
        for (let i = 0; i < pts.length; i += 1) {
          const [ax, ay] = pts[i];
          const [bx, by] = pts[(i * 5 + 3) % pts.length];
          line(
            [
              [ax, ay],
              [bx, by],
            ],
            'rgba(185,220,255,0.6)',
            2,
          );
        }
        pts.forEach(([x, y], i) => {
          g.fillStyle = i % 5 === 0 ? CORAL : '#ffffff';
          g.beginPath();
          g.arc(x, y, i % 5 === 0 ? 11 : 6, 0, Math.PI * 2);
          g.fill();
        });
        break;
      }
      case 'documents':
        for (let i = 0; i < 4; i += 1) {
          bar(40 + i * 145, 40 + (i % 2) * 30, 120, 160, GLOW_SOFT);
          for (let l = 0; l < 5; l += 1)
            bar(55 + i * 145, 60 + (i % 2) * 30 + l * 24, 90 - l * 10, 8, '#ffffff');
        }
        line(series(8, h - 50, 120), CORAL, 5);
        break;
      case 'layouts': // Diseño
        bar(40, 40, 260, 320, GLOW_SOFT);
        bar(60, 60, 220, 120, 'rgba(255,138,92,0.75)');
        for (let i = 0; i < 3; i += 1) bar(60, 200 + i * 50, 220 - i * 40, 26, '#ffffff');
        for (let i = 0; i < 4; i += 1)
          bar(
            330 + (i % 2) * 140,
            40 + Math.floor(i / 2) * 170,
            120,
            150,
            i === 3 ? GLOW : GLOW_SOFT,
          );
        break;
      case 'objectives': // Consejo
        for (let i = 0; i < 4; i += 1) {
          g.strokeStyle = i === 3 ? CORAL : GLOW;
          g.lineWidth = 8;
          g.beginPath();
          g.arc(160, h / 2, 40 + i * 36, 0, Math.PI * 2);
          g.stroke();
        }
        for (let i = 0; i < 4; i += 1) {
          bar(340, 80 + i * 70, 240, 14, 'rgba(185,220,255,0.35)');
          bar(340, 80 + i * 70, 80 + r() * 150, 14, i === 1 ? CORAL : GLOW);
        }
        break;
      case 'circuit': {
        // MelonMotor: traces of light, joined at nodes.
        g.clearRect(0, 0, w, h);
        g.fillStyle = 'rgba(20,32,52,0.9)';
        g.fillRect(0, 0, w, h);
        for (let i = 0; i < 26; i += 1) {
          let x = r() * w;
          let y = r() * h;
          const pts = [[x, y]];
          for (let k = 0; k < 4; k += 1) {
            if (k % 2 === 0) x += (r() - 0.5) * 260;
            else y += (r() - 0.5) * 200;
            pts.push([x, y]);
          }
          line(pts, i % 7 === 0 ? 'rgba(255,138,92,0.85)' : 'rgba(124,192,255,0.7)', 2);
          g.fillStyle = '#e6f3ff';
          g.beginPath();
          g.arc(x, y, 4, 0, Math.PI * 2);
          g.fill();
        }
        break;
      }
      default:
        for (let i = 0; i < 6; i += 1)
          bar(40 + (i % 3) * 190, 40 + Math.floor(i / 3) * 170, 170, 150, GLOW_SOFT);
    }
  });
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
