/**
 * Materials for the office's 3D art (Home V4): oak, walnut, plaster, fabric, glass, metal,
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

/** Wide oak planks with grain and a slight tone change from plank to plank. */
function planks(tones, seed, grain = 0.12) {
  const r = random(seed);
  return canvas(1024, 1024, (g, w, h) => {
    const rows = 8;
    const rowH = h / rows;
    for (let row = 0; row < rows; row += 1) {
      let x = -r() * 400;
      while (x < w) {
        const len = 380 + r() * 420;
        const tone = tones[Math.floor(r() * tones.length)];
        g.fillStyle = tone;
        g.fillRect(x, row * rowH, len, rowH);
        // Grain: long, faint, slightly wavy strokes.
        for (let i = 0; i < 26; i += 1) {
          const y = row * rowH + r() * rowH;
          g.strokeStyle = `rgba(${r() < 0.5 ? '70,40,20' : '255,235,210'},${grain * r()})`;
          g.lineWidth = 0.6 + r() * 1.6;
          g.beginPath();
          g.moveTo(x, y);
          for (let s = 0; s <= len; s += 40) g.lineTo(x + s, y + Math.sin(s / 60 + i) * 1.4);
          g.stroke();
        }
        // The seam.
        g.fillStyle = 'rgba(60,35,18,0.35)';
        g.fillRect(x, row * rowH, 2, rowH);
        x += len;
      }
      g.fillStyle = 'rgba(60,35,18,0.3)';
      g.fillRect(0, row * rowH, w, 2);
    }
  });
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

export function makeMaterials() {
  const oakFloor = new THREE.MeshStandardMaterial({
    map: texture(planks(['#c99a6b', '#c2915f', '#d1a577', '#bf8f62', '#cc9d6e'], 7), [1.4, 1.4]),
    roughness: 0.55,
    metalness: 0,
  });
  const oak = new THREE.MeshStandardMaterial({
    map: texture(planks(['#d8b48a', '#d2ab80', '#dcb990'], 11, 0.08), [0.6, 0.6]),
    roughness: 0.5,
  });
  const walnut = new THREE.MeshStandardMaterial({
    map: texture(planks(['#6e4a33', '#664530', '#76503a'], 13, 0.1), [0.8, 0.8]),
    roughness: 0.45,
  });
  const plaster = new THREE.MeshStandardMaterial({
    map: texture(noise('#f1e9e0', 3, 6), [3, 3]),
    roughness: 0.92,
  });
  const plasterWarm = new THREE.MeshStandardMaterial({
    map: texture(noise('#ecdccb', 4, 6), [3, 3]),
    roughness: 0.92,
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
    color: '#2b2a2c',
    roughness: 0.38,
    metalness: 0.7,
  });
  const aluminium = new THREE.MeshStandardMaterial({
    color: '#c9c7c4',
    roughness: 0.3,
    metalness: 0.85,
  });
  const brass = new THREE.MeshStandardMaterial({
    color: '#c9a064',
    roughness: 0.3,
    metalness: 0.9,
  });
  const white = new THREE.MeshStandardMaterial({ color: '#f7f4f0', roughness: 0.4 });
  const ceramic = new THREE.MeshStandardMaterial({ color: '#efe9e2', roughness: 0.35 });
  const terracotta = new THREE.MeshStandardMaterial({ color: '#c97b5a', roughness: 0.7 });
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
    map: texture(weave('#d8c7b2', 9), [6, 4]),
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
    color: '#fff3df',
    emissive: '#ffe2b0',
    emissiveIntensity: 2.4,
  });
  const cork = new THREE.MeshStandardMaterial({
    map: texture(noise('#c49a6c', 21, 28, 256), [2, 2]),
    roughness: 0.95,
  });
  const bronze = new THREE.MeshStandardMaterial({
    color: '#6f5d4e',
    roughness: 0.4,
    metalness: 0.6,
  });
  const slab = new THREE.MeshStandardMaterial({ color: '#d9cdc0', roughness: 0.9 });
  const corridor = new THREE.MeshStandardMaterial({
    color: '#f6eee6',
    emissive: '#fff3e6',
    emissiveIntensity: 0.35,
    roughness: 1,
  });
  return {
    slab,
    bronze,
    corridor,
    oakFloor,
    oak,
    walnut,
    plaster,
    plasterWarm,
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
    cork,
  };
}

/** A screen's picture: shapes that say what the room does, never numbers or words. */
export function screenTexture(kind, hue = '#f2784b', seed = 1) {
  const r = random(seed);
  const c = canvas(512, 320, (g, w, h) => {
    const bg = g.createLinearGradient(0, 0, 0, h);
    bg.addColorStop(0, '#26252b');
    bg.addColorStop(1, '#1a191e');
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

/** A board's surface: a kanban, a moodboard, a chart pinned up. No words. */
export function boardTexture(kind, hue = '#f2784b', seed = 2) {
  const r = random(seed);
  const c = canvas(512, 320, (g, w, h) => {
    g.fillStyle = '#fbfaf8';
    g.fillRect(0, 0, w, h);
    const notes = ['#f6d36b', '#f4a98a', '#a9cbe8', '#b8dca0', '#f3c1d9'];
    if (kind === 'kanban') {
      for (let col = 0; col < 4; col += 1) {
        g.fillStyle = 'rgba(40,30,20,0.12)';
        g.fillRect(20 + col * 122, 20, 2, h - 40);
        const n = 2 + Math.floor(r() * 3);
        for (let i = 0; i < n; i += 1) {
          g.fillStyle = notes[Math.floor(r() * notes.length)];
          g.fillRect(34 + col * 122, 30 + i * 66, 88, 54);
        }
      }
    } else if (kind === 'pipeline') {
      // Comercial: deals moving through stages, the last stage narrow and bright.
      const stages = 5;
      for (let col = 0; col < stages; col += 1) {
        const x = 18 + col * 97;
        g.fillStyle = 'rgba(40,30,20,0.07)';
        g.fillRect(x, 18, 88, h - 36);
        g.fillStyle = col === stages - 1 ? hue : 'rgba(40,30,20,0.35)';
        g.fillRect(x + 8, 26, 50, 6);
        const n = 5 - col + Math.floor(r() * 2);
        for (let i = 0; i < n; i += 1) {
          g.fillStyle = col === stages - 1 ? hue : notes[(col + i) % notes.length];
          g.globalAlpha = col === stages - 1 ? 0.9 : 0.8;
          g.fillRect(x + 8, 44 + i * 44, 72, 34);
          g.globalAlpha = 1;
        }
      }
    } else if (kind === 'flow') {
      // Operaciones: a process, boxes joined by arrows.
      g.strokeStyle = 'rgba(40,30,20,0.45)';
      g.lineWidth = 3;
      const nodes = [
        [60, 80],
        [200, 80],
        [340, 80],
        [450, 170],
        [340, 250],
        [200, 250],
      ];
      g.beginPath();
      nodes.forEach(([x, y], i) => (i === 0 ? g.moveTo(x, y) : g.lineTo(x, y)));
      g.stroke();
      nodes.forEach(([x, y], i) => {
        g.fillStyle = i === 3 ? hue : notes[i % notes.length];
        if (i === 3) {
          g.beginPath();
          g.moveTo(x, y - 34);
          g.lineTo(x + 40, y);
          g.lineTo(x, y + 34);
          g.lineTo(x - 40, y);
          g.fill();
        } else g.fillRect(x - 46, y - 26, 92, 52);
      });
    } else if (kind === 'campaign') {
      // Marketing: a campaign poster, a big shape and a band of colour.
      const bg = g.createLinearGradient(0, 0, w, h);
      bg.addColorStop(0, hue);
      bg.addColorStop(1, '#e8b04a');
      g.fillStyle = bg;
      g.fillRect(0, 0, w, h);
      g.fillStyle = 'rgba(255,255,255,0.85)';
      g.beginPath();
      g.arc(w * 0.62, h * 0.42, 90, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = '#2f3b4c';
      g.fillRect(40, h - 90, 220, 20);
      g.fillStyle = 'rgba(47,59,76,0.5)';
      g.fillRect(40, h - 60, 150, 12);
    } else if (kind === 'mood') {
      for (let i = 0; i < 9; i += 1) {
        g.fillStyle = [
          hue,
          '#e8b04a',
          '#7aa0c4',
          '#d97d62',
          '#9fbf8a',
          '#c9a0d6',
          '#3b3a40',
          '#f4efe6',
          '#b27c5a',
        ][i];
        const x = 20 + (i % 3) * 160 + r() * 10;
        const y = 16 + Math.floor(i / 3) * 100 + r() * 8;
        g.fillRect(x, y, 140, 86);
      }
    } else if (kind === 'chart') {
      g.strokeStyle = hue;
      g.lineWidth = 6;
      g.beginPath();
      let y = h - 60;
      for (let x = 30; x < w - 30; x += 40) {
        y = Math.max(40, y - 12 + (r() - 0.4) * 30);
        if (x === 30) g.moveTo(x, y);
        else g.lineTo(x, y);
      }
      g.stroke();
      g.fillStyle = 'rgba(40,30,20,0.25)';
      g.fillRect(30, h - 40, w - 60, 3);
    } else {
      // Research: pinned pages joined by string.
      const pts = [];
      for (let i = 0; i < 7; i += 1) {
        const x = 30 + r() * (w - 130);
        const yy = 20 + r() * (h - 110);
        pts.push([x + 45, yy + 40]);
        g.fillStyle = '#ffffff';
        g.shadowColor = 'rgba(0,0,0,0.2)';
        g.shadowBlur = 6;
        g.fillRect(x, yy, 90, 80);
        g.shadowBlur = 0;
        g.fillStyle = 'rgba(40,30,20,0.18)';
        for (let l = 0; l < 4; l += 1) g.fillRect(x + 10, yy + 14 + l * 14, 60 - l * 8, 4);
      }
      g.strokeStyle = '#c0392b';
      g.lineWidth = 2;
      g.beginPath();
      pts.forEach(([x, yy], i) => (i === 0 ? g.moveTo(x, yy) : g.lineTo(x, yy)));
      g.stroke();
    }
  });
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
