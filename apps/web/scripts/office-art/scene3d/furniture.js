/**
 * Furniture for the office's 3D art: desks, chairs, monitors, shelves, plants, lamps, sofas and
 * boards. Units are metres; every piece stands on y = 0 and faces +z (the camera).
 */
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { random } from './materials.js';

export function mesh(geometry, material, { cast = true, receive = true } = {}) {
  const m = new THREE.Mesh(geometry, material);
  m.castShadow = cast;
  m.receiveShadow = receive;
  return m;
}

export function box(w, h, d, material, radius = 0.004) {
  return mesh(new RoundedBoxGeometry(w, h, d, 2, Math.min(radius, w / 2, h / 2, d / 2)), material);
}

export function at(object, x, y, z, ry = 0) {
  object.position.set(x, y, z);
  object.rotation.y = ry;
  return object;
}

function cylinder(rt, rb, h, material, segments = 24) {
  return mesh(new THREE.CylinderGeometry(rt, rb, h, segments), material);
}

/** A white composite desk on slim aluminium legs, a line of light under its front edge. */
export function desk(m, w = 1.4, d = 0.7) {
  const g = new THREE.Group();
  g.add(at(box(w, 0.035, d, m.composite, 0.008), 0, 0.735, 0));
  for (const sx of [-1, 1]) {
    g.add(at(box(0.035, 0.72, 0.035, m.aluminium), sx * (w / 2 - 0.08), 0.36, d / 2 - 0.08));
    g.add(at(box(0.035, 0.72, 0.035, m.aluminium), sx * (w / 2 - 0.08), 0.36, -d / 2 + 0.08));
    g.add(at(box(0.035, 0.03, d - 0.12, m.aluminium), sx * (w / 2 - 0.08), 0.06, 0));
  }
  g.add(at(box(w - 0.3, 0.008, 0.008, m.led), 0, 0.71, d / 2 - 0.06));
  // A modesty panel on the side away from whoever sits there.
  g.add(at(box(w - 0.22, 0.46, 0.018, m.composite, 0.004), 0, 0.49, d / 2 - 0.1));
  return g;
}

/** A monitor on a stand; `screen` is its picture's material. */
export function monitor(m, screen, w = 0.62, h = 0.36) {
  const g = new THREE.Group();
  g.add(at(box(w, h, 0.025, m.bezel, 0.006), 0, 0.2 + h / 2, 0));
  const face = mesh(new THREE.PlaneGeometry(w - 0.024, h - 0.024), screen, { cast: false });
  face.position.set(0, 0.2 + h / 2, 0.0132);
  face.name = 'screen';
  g.add(face);
  g.add(at(box(0.05, 0.22, 0.03, m.aluminium), 0, 0.11, -0.03));
  g.add(at(box(0.24, 0.012, 0.17, m.aluminium, 0.005), 0, 0.006, -0.02));
  return g;
}

export function laptop(m, screen) {
  const g = new THREE.Group();
  g.add(at(box(0.34, 0.014, 0.23, m.aluminium, 0.004), 0, 0.007, 0));
  const lid = new THREE.Group();
  lid.add(at(box(0.34, 0.22, 0.01, m.aluminium, 0.004), 0, 0.11, 0));
  const face = mesh(new THREE.PlaneGeometry(0.31, 0.19), screen, { cast: false });
  face.position.set(0, 0.11, 0.0055);
  lid.add(face);
  lid.position.set(0, 0.012, -0.11);
  lid.rotation.x = -0.28;
  g.add(lid);
  return g;
}

export function keyboard(m) {
  return box(0.4, 0.014, 0.13, m.white, 0.004);
}

export function mug(m, material) {
  const g = new THREE.Group();
  g.add(at(cylinder(0.04, 0.036, 0.095, material ?? m.ceramic), 0, 0.0475, 0));
  const handle = mesh(new THREE.TorusGeometry(0.025, 0.007, 8, 16, Math.PI), material ?? m.ceramic);
  handle.position.set(0.04, 0.05, 0);
  handle.rotation.z = -Math.PI / 2;
  g.add(handle);
  return g;
}

export function papers(m, count = 3, seed = 1) {
  const r = random(seed);
  const g = new THREE.Group();
  for (let i = 0; i < count; i += 1) {
    const sheet = box(0.21, 0.004, 0.297, m.white, 0.001);
    sheet.position.set((r() - 0.5) * 0.03, 0.002 + i * 0.004, (r() - 0.5) * 0.03);
    sheet.rotation.y = (r() - 0.5) * 0.3;
    g.add(sheet);
  }
  return g;
}

/** A mesh office chair: seat, curved back, five-star base. */
export function officeChair(m, fabric) {
  const g = new THREE.Group();
  g.add(at(box(0.5, 0.07, 0.48, fabric, 0.03), 0, 0.47, 0));
  const back = box(0.48, 0.58, 0.06, fabric, 0.03);
  back.position.set(0, 0.82, -0.24);
  back.rotation.x = -0.1;
  g.add(back);
  g.add(at(cylinder(0.025, 0.025, 0.36, m.aluminium), 0, 0.27, 0));
  for (let i = 0; i < 5; i += 1) {
    const a = (i / 5) * Math.PI * 2;
    const leg = box(0.3, 0.025, 0.04, m.aluminium);
    leg.position.set(Math.cos(a) * 0.15, 0.06, Math.sin(a) * 0.15);
    leg.rotation.y = -a;
    g.add(leg);
  }
  for (const sx of [-1, 1]) g.add(at(box(0.04, 0.2, 0.3, m.aluminium, 0.01), sx * 0.26, 0.6, 0));
  return g;
}

/** A sofa in fabric on slim legs. */
export function sofa(m, fabric, w = 1.8) {
  const g = new THREE.Group();
  g.add(at(box(w, 0.2, 0.8, fabric, 0.06), 0, 0.3, 0));
  g.add(at(box(w, 0.42, 0.18, fabric, 0.07), 0, 0.56, -0.31));
  for (const sx of [-1, 1])
    g.add(at(box(0.16, 0.3, 0.8, fabric, 0.06), sx * (w / 2 - 0.08), 0.45, 0));
  for (let i = 0; i < Math.round(w / 0.6); i += 1) {
    const c = box(w / Math.round(w / 0.6) - 0.06, 0.1, 0.62, fabric, 0.05);
    c.position.set(-w / 2 + 0.16 + (i + 0.5) * ((w - 0.32) / Math.round(w / 0.6)), 0.45, 0.05);
    g.add(c);
  }
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1])
      g.add(at(cylinder(0.02, 0.015, 0.2, m.composite), sx * (w / 2 - 0.1), 0.1, sz * 0.32));
  }
  return g;
}

export function coffeeTable(m, r = 0.4) {
  const g = new THREE.Group();
  g.add(at(cylinder(r, r, 0.03, m.composite, 48), 0, 0.42, 0));
  g.add(at(cylinder(0.03, 0.05, 0.4, m.blackMetal), 0, 0.2, 0));
  g.add(at(cylinder(0.2, 0.2, 0.02, m.blackMetal), 0, 0.01, 0));
  return g;
}

export function meetingTable(m, w = 2.6, d = 1.1) {
  const g = new THREE.Group();
  const top = mesh(new RoundedBoxGeometry(w, 0.04, d, 4, 0.02), m.stone);
  top.position.y = 0.74;
  g.add(top);
  for (const sx of [-1, 1])
    g.add(at(box(0.08, 0.72, d * 0.6, m.blackMetal, 0.02), sx * (w / 2 - 0.35), 0.36, 0));
  return g;
}

/** A pale shelf of books and a few objects. */
export function bookshelf(m, w = 1.2, h = 2.0, seed = 1) {
  const r = random(seed);
  const g = new THREE.Group();
  const d = 0.34;
  g.add(at(box(w, 0.03, d, m.stone), 0, h, 0));
  g.add(at(box(w, 0.03, d, m.stone), 0, 0.015, 0));
  for (const sx of [-1, 1]) g.add(at(box(0.03, h, d, m.stone), sx * (w / 2 - 0.015), h / 2, 0));
  g.add(at(box(w, h, 0.02, m.stone), 0, h / 2, -d / 2 + 0.01));
  const shelves = 4;
  const bookColors = [
    '#e9dfd2',
    '#c9643f',
    '#2f3b4c',
    '#d8b25e',
    '#8a4f3a',
    '#6f7f8f',
    '#f4efe9',
    '#9c6b4e',
    '#556b5c',
  ];
  for (let s = 0; s < shelves; s += 1) {
    const y = 0.03 + (s * (h - 0.05)) / shelves;
    if (s > 0) g.add(at(box(w - 0.04, 0.025, d - 0.02, m.stone), 0, y, 0));
    let x = -w / 2 + 0.05;
    const kind = Math.floor(r() * 3);
    while (x < w / 2 - 0.1) {
      if (kind === 2 && x > 0 && x < 0.2) {
        // An object: a vase or a small sculpture.
        const v = cylinder(0.05, 0.07, 0.16 + r() * 0.1, r() < 0.5 ? m.ceramic : m.terracotta);
        v.position.set(x + 0.08, y + 0.1, 0);
        g.add(v);
        x += 0.22;
        continue;
      }
      const bw = 0.025 + r() * 0.03;
      const bh = 0.18 + r() * 0.1;
      const book = box(
        bw,
        bh,
        0.2 + r() * 0.05,
        new THREE.MeshStandardMaterial({
          color: bookColors[Math.floor(r() * bookColors.length)],
          roughness: 0.8,
        }),
        0.003,
      );
      const lean = r() < 0.12;
      book.position.set(x + bw / 2, y + 0.012 + bh / 2, 0.01);
      if (lean) book.rotation.z = 0.2;
      g.add(book);
      x += bw + 0.004 + (lean ? 0.04 : 0);
      if (r() < 0.08) x += 0.1;
    }
  }
  return g;
}

/** A potted plant: `tall` (fiddle-leaf), `bush` or `snake`. */
export function plant(m, kind = 'tall', seed = 1, scale = 1) {
  const r = random(seed);
  const g = new THREE.Group();
  const potH = kind === 'tall' ? 0.42 : 0.3;
  const potR = kind === 'tall' ? 0.2 : 0.16;
  g.add(
    at(cylinder(potR, potR * 0.82, potH, r() < 0.5 ? m.ceramic : m.terracotta, 32), 0, potH / 2, 0),
  );
  g.add(at(cylinder(potR * 0.95, potR * 0.95, 0.02, m.soil), 0, potH - 0.02, 0));
  const leafShape = new THREE.Shape();
  leafShape.moveTo(0, 0);
  leafShape.bezierCurveTo(0.09, 0.05, 0.09, 0.22, 0, 0.3);
  leafShape.bezierCurveTo(-0.09, 0.22, -0.09, 0.05, 0, 0);
  const leafGeometry = new THREE.ShapeGeometry(leafShape, 8);
  const blade = new THREE.Shape();
  blade.moveTo(-0.025, 0);
  blade.lineTo(0.025, 0);
  blade.lineTo(0.008, 0.7);
  blade.lineTo(-0.008, 0.7);
  const bladeGeometry = new THREE.ShapeGeometry(blade);
  if (kind === 'snake') {
    for (let i = 0; i < 11; i += 1) {
      const l = mesh(bladeGeometry, r() < 0.5 ? m.leaf : m.leafLight);
      l.position.set((r() - 0.5) * 0.18, potH, (r() - 0.5) * 0.18);
      l.rotation.set((r() - 0.5) * 0.35, r() * Math.PI, (r() - 0.5) * 0.35);
      l.scale.setScalar(0.7 + r() * 0.6);
      g.add(l);
    }
  } else {
    const stems = kind === 'tall' ? 1 : 5;
    const top = kind === 'tall' ? 1.3 : 0.45;
    for (let s = 0; s < stems; s += 1) {
      const sx = (r() - 0.5) * (kind === 'tall' ? 0.02 : 0.14);
      const sz = (r() - 0.5) * (kind === 'tall' ? 0.02 : 0.14);
      const stem = cylinder(0.012, 0.016, top, m.stone, 8);
      stem.position.set(sx, potH + top / 2, sz);
      g.add(stem);
      const leaves = kind === 'tall' ? 26 : 9;
      for (let i = 0; i < leaves; i += 1) {
        const l = mesh(leafGeometry, r() < 0.55 ? m.leaf : m.leafLight);
        const y = potH + top * (kind === 'tall' ? 0.35 + r() * 0.68 : 0.4 + r() * 0.7);
        const a = r() * Math.PI * 2;
        l.position.set(sx + Math.cos(a) * 0.03, y, sz + Math.sin(a) * 0.03);
        l.rotation.set(-0.6 - r() * 0.7, a, 0, 'YXZ');
        l.scale.setScalar((kind === 'tall' ? 0.9 : 0.8) + r() * 0.5);
        g.add(l);
      }
    }
  }
  g.scale.setScalar(scale);
  return g;
}

/** A pendant: a dome shade on a cord, its bulb glowing, and the light it casts. */
export function pendant(m, drop = 0.9, shade = 'dome', light = 1) {
  const g = new THREE.Group();
  g.add(at(cylinder(0.004, 0.004, drop, m.blackMetal, 6), 0, -drop / 2, 0));
  const shadeMaterial = shade === 'brass' ? m.brass : m.blackMetal;
  const dome = mesh(
    new THREE.SphereGeometry(0.2, 32, 12, 0, Math.PI * 2, 0, Math.PI / 2),
    new THREE.MeshStandardMaterial({
      color: shadeMaterial.color,
      roughness: 0.35,
      metalness: shadeMaterial.metalness,
      side: THREE.DoubleSide,
    }),
  );
  dome.position.y = -drop - 0.02;
  dome.scale.set(1, 0.6, 1);
  g.add(dome);
  const bulb = mesh(new THREE.SphereGeometry(0.05, 16, 8), m.lampGlow, { cast: false });
  bulb.position.y = -drop - 0.05;
  g.add(bulb);
  if (light > 0) {
    const p = new THREE.PointLight('#ffd9a8', 1.6 * light, 5, 1.6);
    p.position.y = -drop - 0.12;
    g.add(p);
  }
  return g;
}

export function floorLamp(m) {
  const g = new THREE.Group();
  g.add(at(cylinder(0.14, 0.14, 0.02, m.blackMetal), 0, 0.01, 0));
  g.add(at(cylinder(0.012, 0.012, 1.5, m.blackMetal, 8), 0, 0.75, 0));
  g.add(at(cylinder(0.14, 0.2, 0.26, m.white, 32), 0, 1.55, 0));
  const p = new THREE.PointLight('#ffd9a8', 0.8, 3, 1.8);
  p.position.y = 1.45;
  g.add(p);
  return g;
}

/** A framed board on the wall. */
export function board(m, material, w = 1.2, h = 0.75, frame = m.stone) {
  const g = new THREE.Group();
  g.add(at(box(w + 0.05, h + 0.05, 0.03, frame, 0.004), 0, 0, 0));
  const face = mesh(new THREE.PlaneGeometry(w, h), material, { cast: false });
  face.position.z = 0.0155;
  g.add(face);
  return g;
}

/** A framed print: a warm abstract. */
export function print(m, colors, w = 0.5, h = 0.65) {
  const c = document.createElement('canvas');
  c.width = 200;
  c.height = 260;
  const g2 = c.getContext('2d');
  g2.fillStyle = '#f4ede4';
  g2.fillRect(0, 0, 200, 260);
  g2.fillStyle = colors[0];
  g2.beginPath();
  g2.arc(100, 110, 60, 0, Math.PI * 2);
  g2.fill();
  g2.fillStyle = colors[1];
  g2.fillRect(30, 170, 140, 50);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return board(m, new THREE.MeshStandardMaterial({ map: t, roughness: 0.8 }), w, h, m.blackMetal);
}
