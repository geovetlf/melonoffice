/**
 * The office's 3D art (Home V4): rooms and workstations modelled in three.js and rendered with
 * physical materials, soft shadows, image-based light and ambient occlusion, then saved as
 * pictures. It runs only when the art is baked (bake.mjs); the app ships the pictures.
 *
 * Rooms keep the slots the Home places its controls on: a side room is 16:10 with its big screen
 * at `SIDE_SCREEN`, and the floor from 60% down stays clear for the workstations.
 */
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import {
  at,
  board,
  bookshelf,
  box,
  coffeeTable,
  desk,
  floorLamp,
  keyboard,
  laptop,
  meetingTable,
  mesh,
  monitor,
  mug,
  officeChair,
  papers,
  pendant,
  plant,
  print,
  sofa,
} from './furniture.js';
import { boardTexture, makeMaterials, random, screenTexture } from './materials.js';
import { LOOKS, person } from './people.js';

export const SIDE_SCREEN = { x: 0.355, y: 0.17, w: 0.29, h: 0.25 };

const renderer = new THREE.WebGLRenderer({
  antialias: true,
  alpha: true,
  preserveDrawingBuffer: true,
});
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.VSMShadowMap;
renderer.toneMapping = THREE.AgXToneMapping;
renderer.toneMappingExposure = 0.95;
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.body.appendChild(renderer.domElement);

const m = makeMaterials();
const environment = new THREE.PMREMGenerator(renderer).fromScene(
  new RoomEnvironment(),
  0.04,
).texture;

function sceneWith(background = null) {
  const scene = new THREE.Scene();
  scene.environment = environment;
  scene.environmentIntensity = 0.55;
  scene.background = background;
  // The day through the building's windows: a warm key light from the front left.
  const sun = new THREE.DirectionalLight('#fff1dd', 2.2);
  sun.position.set(-4, 7, 8);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -6;
  sun.shadow.camera.right = 6;
  sun.shadow.camera.top = 6;
  sun.shadow.camera.bottom = -6;
  sun.shadow.radius = 8;
  sun.shadow.blurSamples = 16;
  sun.shadow.bias = -0.0004;
  scene.add(sun);
  scene.add(new THREE.HemisphereLight('#fff6ec', '#b89a80', 0.55));
  return scene;
}

function render(scene, camera, width, height, ao = true) {
  renderer.setPixelRatio(1);
  renderer.setSize(width, height, false);
  if (!ao) {
    renderer.render(scene, camera);
    return renderer.domElement.toDataURL('image/png');
  }
  const composer = new EffectComposer(renderer);
  composer.setSize(width, height);
  composer.addPass(new RenderPass(scene, camera));
  const gtao = new GTAOPass(scene, camera, width, height);
  gtao.updateGtaoMaterial({
    radius: 0.45,
    distanceExponent: 1.6,
    thickness: 1.2,
    scale: 1.1,
    samples: 16,
  });
  gtao.blendIntensity = 0.85;
  composer.addPass(gtao);
  composer.addPass(new OutputPass());
  composer.render();
  const data = renderer.domElement.toDataURL('image/png');
  composer.dispose();
  return data;
}

/* ------------------------------------------------------------------ rooms */

/*
 * Every room is a box open at the front, seen from high up and straight on, with a shifted lens
 * so walls stay upright (as in architectural drawings). The front opening fills the picture
 * exactly, so rooms side by side in the Home join into one building: the back wall's foot is at
 * 60% of the height in every room, the back wall is three quarters as wide as the picture.
 */
const ROOM = { h: 3.5, d: 5 };
const VIEW = { distance: 3 * ROOM.d, height: 1.6 * ROOM.h };

function roomCamera(w, h = ROOM.h) {
  const camera = new THREE.PerspectiveCamera(30, w / h, 0.5, 80);
  camera.position.set(0, VIEW.height, ROOM.d / 2 + VIEW.distance);
  camera.lookAt(0, VIEW.height, 0);
  camera.updateMatrixWorld();
  const n = camera.near / VIEW.distance;
  camera.projectionMatrix.makePerspective(
    (-w / 2) * n,
    (w / 2) * n,
    (h - VIEW.height) * n,
    -VIEW.height * n,
    camera.near,
    camera.far,
  );
  camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
  return camera;
}

/** Where a picture's point (0..1) lands on the plane z = `z`. */
function onPlane(camera, u, v, z) {
  const p = new THREE.Vector3(u * 2 - 1, 1 - v * 2, 0.5).unproject(camera);
  const dir = p.sub(camera.position).normalize();
  const t = (z - camera.position.z) / dir.z;
  return camera.position.clone().add(dir.multiplyScalar(t));
}

const BACK = -ROOM.d / 2;

/** The shell: oak floor, a plaster back wall, the side walls (glass, slats or plaster). */
function shell(scene, w, { wall = m.plaster, left = 'glass', right = 'slats' } = {}) {
  const { d, h } = ROOM;
  const floorGeometry = new THREE.PlaneGeometry(w, d + 0.02);
  floorGeometry.attributes.uv.array.forEach(
    (v, i, a) => (a[i] = v * (i % 2 === 0 ? w / 2.4 : d / 2.4)),
  );
  const floor = mesh(floorGeometry, m.oakFloor, { cast: false });
  floor.rotation.x = -Math.PI / 2;
  scene.add(floor);
  // The slab edge at the front: the building's floor, cut.
  scene.add(at(box(w + 0.02, 0.18, 0.1, m.slab, 0.002), 0, -0.09, d / 2 - 0.05));
  scene.add(
    at(mesh(new THREE.PlaneGeometry(w, h + 1.5), wall, { cast: false }), 0, (h + 1.5) / 2, BACK),
  );
  scene.add(at(box(w, 0.1, 0.02, m.white), 0, 0.05, BACK + 0.01));
  for (const [side, kind] of [
    [-1, left],
    [1, right],
  ]) {
    const x = side * (w / 2);
    const plane = (material, dx = 0) => {
      const p = mesh(new THREE.PlaneGeometry(d, h + 1.5), material, { cast: false });
      p.rotation.y = -side * (Math.PI / 2);
      p.position.set(x + dx, (h + 1.5) / 2, 0);
      return p;
    };
    if (kind === 'glass') {
      // A glass partition with slim black mullions and a bright corridor behind it.
      scene.add(plane(m.corridor, side * 0.9));
      for (let z = BACK; z <= d / 2 + 0.01; z += d / 4)
        scene.add(at(box(0.02, h + 1.5, 0.03, m.bronze), x, (h + 1.5) / 2, z));
      scene.add(at(box(0.02, 0.02, d, m.bronze), x, 2.3, 0));
      scene.add(at(box(0.03, 0.05, d, m.bronze), x, 0.025, 0));
      const pane = plane(m.glass);
      scene.add(pane);
    } else if (kind === 'slats') {
      scene.add(plane(m.walnut, side * 0.06));
      for (let z = BACK + 0.04; z <= d / 2; z += 0.1)
        scene.add(at(box(0.04, h + 1.5, 0.05, m.oak, 0.008), x - side * 0.02, (h + 1.5) / 2, z));
    } else {
      scene.add(plane(wall));
      scene.add(at(box(0.02, 0.1, d, m.white), x - side * 0.01, 0.05, 0));
    }
  }
}

/** The big screen's frame on the back wall, exactly where the Home draws the screen. */
function wallScreenFrame(scene, camera, rect) {
  const z = BACK + 0.03;
  const a = onPlane(camera, rect.x, rect.y, z);
  const b = onPlane(camera, rect.x + rect.w, rect.y + rect.h, z);
  const w = b.x - a.x;
  const h = a.y - b.y;
  const cx = (a.x + b.x) / 2;
  const cy = (a.y + b.y) / 2;
  scene.add(at(box(w + 0.06, h + 0.06, 0.04, m.bezel, 0.01), cx, cy, z));
  const face = mesh(new THREE.PlaneGeometry(w, h), m.screenOff, { cast: false });
  face.position.set(cx, cy, z + 0.021);
  scene.add(face);
  return { cx, cy, w, h, bottom: cy - h / 2 };
}

const HUES = {
  growth: '#f5b942',
  dashboard: '#ff9a62',
  social: '#ff7f6e',
  video: '#f0665a',
  network: '#7aa0c4',
  finance: '#e8a33d',
  map: '#f2784b',
  generic: '#f2a07b',
  meeting: '#f2a07b',
};

function pendants(scene, xs, z, drop, shade = 'dome') {
  for (const x of xs) scene.add(at(pendant(m, drop, shade, 0.6), x, VIEW.height + 1, z));
}

/** A low walnut sideboard under the screen, with a few things on it. */
function credenza(w, seed) {
  const g = new THREE.Group();
  g.add(at(box(w, 0.5, 0.42, m.walnut, 0.012), 0, 0.3, 0));
  g.add(at(box(w - 0.1, 0.04, 0.38, m.blackMetal), 0, 0.03, 0));
  const doors = Math.round(w / 0.45);
  for (let i = 0; i < doors; i += 1) {
    g.add(
      at(
        box(w / doors - 0.02, 0.44, 0.012, m.oak, 0.004),
        -w / 2 + (i + 0.5) * (w / doors),
        0.3,
        0.21,
      ),
    );
  }
  g.add(at(papers(m, 3, seed), -w / 2 + 0.3, 0.55, 0));
  g.add(at(plant(m, 'snake', seed + 3, 0.55), w / 2 - 0.25, 0.55, 0));
  return g;
}

function filing(seed) {
  const g = new THREE.Group();
  g.add(at(box(0.5, 1.2, 0.5, m.white, 0.01), 0, 0.6, 0));
  for (let i = 0; i < 4; i += 1) {
    g.add(at(box(0.44, 0.26, 0.01, m.white, 0.004), 0, 0.17 + i * 0.29, 0.255));
    g.add(at(box(0.12, 0.015, 0.02, m.brass), 0, 0.25 + i * 0.29, 0.265));
  }
  g.add(at(papers(m, 4, seed), 0, 1.2, 0));
  return g;
}

/** What sits on each department's walls: the room says what the department does. */
function decorate(scene, camera, motif, seed, w) {
  const hue = HUES[motif] ?? '#f2784b';
  const screen = wallScreenFrame(scene, camera, SIDE_SCREEN);
  const half = w / 2;
  const leftX = (-half + screen.cx - screen.w / 2) / 2 + 0.1;
  const rightX = (half + screen.cx + screen.w / 2) / 2 - 0.1;
  const boardOf = (kind, bw, bh) =>
    board(
      m,
      new THREE.MeshStandardMaterial({ map: boardTexture(kind, hue, seed), roughness: 0.85 }),
      bw,
      bh,
      kind === 'pins' ? m.oak : m.blackMetal,
    );
  scene.add(at(credenza(screen.w * 0.9, seed), 0, 0, BACK + 0.24));
  switch (motif) {
    case 'growth': // Comercial: the pipeline and the customers.
      scene.add(at(boardOf('pipeline', 1.0, 0.7), leftX, 1.45, BACK + 0.03));
      scene.add(at(bookshelf(m, 0.9, 1.9, seed + 3), rightX, 0, BACK + 0.2));
      break;
    case 'dashboard': // Operaciones: a kanban and the processes.
      scene.add(at(boardOf('kanban', 1.0, 0.7), leftX, 1.45, BACK + 0.03));
      scene.add(at(boardOf('flow', 0.8, 0.55), rightX, 1.6, BACK + 0.03));
      scene.add(at(filing(seed), rightX, 0, BACK + 0.3));
      break;
    case 'social': // Marketing: a moodboard and the campaign's poster.
    case 'video': // Diseño: moodboards.
      scene.add(at(boardOf('mood', 1.0, 0.7), leftX, 1.45, BACK + 0.03));
      scene.add(
        at(boardOf(motif === 'social' ? 'campaign' : 'mood', 0.7, 0.9), rightX, 1.55, BACK + 0.03),
      );
      break;
    case 'network': // Investigación: data on the wall, a library.
      scene.add(at(boardOf('pins', 1.0, 0.7), leftX, 1.45, BACK + 0.03));
      scene.add(at(bookshelf(m, 0.95, 2.0, seed + 5), rightX, 0, BACK + 0.2));
      break;
    case 'finance': // Finanzas: charts, invoices and files.
      scene.add(at(boardOf('chart', 1.0, 0.7), leftX, 1.45, BACK + 0.03));
      scene.add(at(filing(seed), rightX - 0.28, 0, BACK + 0.3));
      scene.add(at(filing(seed + 1), rightX + 0.28, 0, BACK + 0.3));
      break;
    default:
      scene.add(at(print(m, [hue, '#2f3b4c']), leftX - 0.3, 1.6, BACK + 0.03));
      scene.add(at(print(m, ['#e8b04a', '#8a4f3a']), leftX + 0.3, 1.6, BACK + 0.03));
      scene.add(at(bookshelf(m, 0.9, 1.9, seed + 3), rightX, 0, BACK + 0.2));
  }
  // Plants in the back corners and a pair of pendants over the desks.
  scene.add(at(plant(m, 'tall', seed + 11, 1.05), -half + 0.32, 0, BACK + 0.4));
  scene.add(at(plant(m, 'bush', seed + 13, 1.2), half - 0.3, 0, BACK + 0.45));
  const rug = mesh(new THREE.PlaneGeometry(w - 1.0, 2.6), m.rug, { cast: false });
  rug.rotation.x = -Math.PI / 2;
  rug.position.set(0, 0.004, 0.9);
  scene.add(rug);
}

const SIDE_W = ROOM.h * 1.6;
const CENTRE_W = (ROOM.h * 640) / 600;

export function sideRoom(motif, seed, width = 1920, height = 1200) {
  const scene = sceneWith();
  const camera = roomCamera(SIDE_W);
  shell(scene, SIDE_W, {
    left: seed % 2 === 0 ? 'glass' : 'slats',
    right: seed % 2 === 0 ? 'slats' : 'glass',
  });
  if (motif === 'meeting') {
    const screen = wallScreenFrame(scene, camera, { ...SIDE_SCREEN, y: 0.2, h: 0.2 });
    void screen;
    const table = meetingTable(m, 2.6, 1.1);
    table.position.set(0, 0, 0.3);
    scene.add(table);
    const fabric = m.fabric('#3b3a40', 3);
    for (let i = 0; i < 3; i += 1) {
      for (const side of [-1, 1]) {
        const c = officeChair(m, fabric);
        c.position.set(-0.85 + i * 0.85, 0, 0.3 + side * 0.85);
        c.rotation.y = side === 1 ? Math.PI : 0;
        scene.add(c);
      }
    }
    scene.add(at(plant(m, 'tall', seed, 1.05), -SIDE_W / 2 + 0.35, 0, BACK + 0.4));
    scene.add(at(plant(m, 'tall', seed + 2, 1.05), SIDE_W / 2 - 0.35, 0, BACK + 0.4));
    scene.add(at(print(m, ['#f2784b', '#2f3b4c'], 0.6, 0.8), -1.75, 1.55, BACK + 0.03));
    scene.add(at(print(m, ['#e8b04a', '#556b5c'], 0.6, 0.8), 1.75, 1.55, BACK + 0.03));
    pendants(scene, [-0.6, 0.6], 0.3, VIEW.height + 1 - 2.2, 'brass');
  } else {
    decorate(scene, camera, motif, seed, SIDE_W);
  }
  return render(scene, camera, width, height);
}

/** The city through headquarters' window: soft towers under a warm sky. */
function cityView() {
  const c = document.createElement('canvas');
  c.width = 1024;
  c.height = 640;
  const g = c.getContext('2d');
  const sky = g.createLinearGradient(0, 0, 0, 640);
  sky.addColorStop(0, '#cfdde8');
  sky.addColorStop(0.75, '#f5e2cf');
  g.fillStyle = sky;
  g.fillRect(0, 0, 1024, 640);
  const r = random(5);
  for (const [tone, top] of [
    ['rgba(170,182,196,0.6)', 300],
    ['rgba(128,140,158,0.75)', 200],
  ]) {
    let x = -20;
    while (x < 1024) {
      const bw = 50 + r() * 80;
      const bh = 180 + r() * top;
      g.fillStyle = tone;
      g.fillRect(x, 640 - bh, bw - 8, bh);
      g.fillStyle = 'rgba(255,245,230,0.25)';
      for (let y = 640 - bh + 12; y < 630; y += 18) g.fillRect(x + 6, y, bw - 20, 4);
      x += bw;
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Headquarters: Consejo's strategy room and GIA's desk, a window over the city. */
export function headquarters(width = 1280, height = 1200) {
  const scene = sceneWith();
  const w = CENTRE_W;
  const camera = roomCamera(w);
  shell(scene, w, { wall: m.plasterWarm, left: 'slats', right: 'slats' });
  // A wide window over the city.
  const view = mesh(
    new THREE.PlaneGeometry(w - 0.5, 1.9),
    new THREE.MeshBasicMaterial({ map: cityView() }),
    { cast: false },
  );
  view.position.set(0, 1.85, BACK + 0.01);
  scene.add(view);
  for (let i = 0; i <= 3; i += 1)
    scene.add(
      at(
        box(0.05, 1.95, 0.08, m.blackMetal),
        -(w - 0.5) / 2 + (i * (w - 0.5)) / 3,
        1.85,
        BACK + 0.04,
      ),
    );
  scene.add(at(box(w - 0.45, 0.06, 0.12, m.blackMetal), 0, 0.88, BACK + 0.05));
  scene.add(at(box(w - 0.45, 0.06, 0.12, m.blackMetal), 0, 2.82, BACK + 0.05));
  const daylight = new THREE.SpotLight('#fff3e2', 14, 12, 0.9, 0.8, 1.2);
  daylight.position.set(0, 2.2, BACK - 0.6);
  daylight.target.position.set(0, 0, 1.5);
  scene.add(daylight, daylight.target);
  // Consejo's round strategy table in the back.
  const table = new THREE.Group();
  table.add(at(mesh(new THREE.CylinderGeometry(0.55, 0.55, 0.04, 64), m.walnut), 0, 0.74, 0));
  table.add(at(mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.72, 16), m.blackMetal), 0, 0.37, 0));
  table.add(at(mesh(new THREE.CylinderGeometry(0.28, 0.28, 0.02, 32), m.blackMetal), 0, 0.01, 0));
  table.add(at(papers(m, 3, 8), 0.1, 0.76, 0.05));
  for (let i = 0; i < 4; i += 1) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    const c = officeChair(m, m.fabric('#d9c3a5', 12 + i));
    c.position.set(Math.sin(a) * 0.85, 0, Math.cos(a) * 0.85);
    c.rotation.y = a + Math.PI;
    table.add(c);
  }
  table.position.set(-0.95, 0, BACK + 1.25);
  scene.add(table);
  // GIA at her walnut desk, facing the room.
  const executive = new THREE.Group();
  executive.add(at(box(1.7, 0.05, 0.8, m.walnut, 0.012), 0, 0.74, 0));
  executive.add(at(box(0.06, 0.72, 0.76, m.walnut, 0.01), -0.8, 0.36, 0));
  executive.add(at(box(0.06, 0.72, 0.76, m.walnut, 0.01), 0.8, 0.36, 0));
  executive.add(at(box(1.56, 0.46, 0.03, m.walnut), 0, 0.46, 0.3));
  const gia = person(
    { skin: '#eec5a6', hair: '#3a2419', top: '#f4efe9', jacket: '#c9643f', style: 'bun' },
    { turn: -0.1 },
  );
  gia.position.set(0, 0, -0.45);
  const chair = officeChair(m, m.fabric('#2b2a2c', 4));
  chair.position.set(0, 0, -0.62);
  executive.add(chair, gia);
  executive.add(
    at(
      laptop(m, new THREE.MeshBasicMaterial({ map: screenTexture('map', '#f2784b', 3) })),
      0.05,
      0.765,
      0.05,
    ),
  );
  const side = monitor(
    m,
    new THREE.MeshBasicMaterial({ map: screenTexture('growth', '#f2784b', 4) }),
    0.56,
    0.33,
  );
  side.position.set(-0.55, 0.765, -0.1);
  side.rotation.y = 0.4;
  executive.add(side);
  executive.add(at(papers(m, 3, 2), 0.55, 0.765, 0.1));
  executive.add(at(mug(m), 0.4, 0.765, -0.18));
  executive.position.set(0, 0, 0.75);
  scene.add(executive);
  scene.add(at(plant(m, 'tall', 21, 1.05), w / 2 - 0.35, 0, BACK + 0.45));
  pendants(scene, [0], 0.75, VIEW.height + 1 - 2.3, 'brass');
  const rug = mesh(new THREE.CircleGeometry(1.5, 64), m.rug, { cast: false });
  rug.rotation.x = -Math.PI / 2;
  rug.position.set(0, 0.004, 0.9);
  scene.add(rug);
  return render(scene, camera, width, height);
}

/** The atrium: MelonMotor's core. A lit ring in the floor, fine lines of light to the rooms. */
export function atrium(width = 1280, height = 1200) {
  const scene = sceneWith();
  const w = CENTRE_W;
  const camera = roomCamera(w);
  shell(scene, w, { wall: m.plaster, left: 'glass', right: 'glass' });
  // A floating oak stair climbing the back wall.
  for (let i = 0; i < 13; i += 1) {
    scene.add(at(box(1.0, 0.05, 0.32, m.oak, 0.01), 0.75 - i * 0.12, 0.2 + i * 0.22, BACK + 0.2));
  }
  scene.add(at(box(0.012, 3.2, 0.012, m.blackMetal), -0.1, 1.6, BACK + 0.4));
  // The core: a low white disc with a ring of light and nodes, its glow on the floor.
  const core = new THREE.Group();
  core.add(at(mesh(new THREE.CylinderGeometry(0.85, 0.9, 0.08, 96), m.white), 0, 0.04, 0));
  const ringMaterial = new THREE.MeshStandardMaterial({
    color: '#ffd2b8',
    emissive: '#f2784b',
    emissiveIntensity: 2.2,
  });
  const ring = mesh(new THREE.TorusGeometry(0.7, 0.018, 12, 128), ringMaterial, { cast: false });
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.085;
  core.add(ring);
  const inner = mesh(new THREE.TorusGeometry(0.4, 0.01, 12, 96), ringMaterial, { cast: false });
  inner.rotation.x = -Math.PI / 2;
  inner.position.y = 0.085;
  core.add(inner);
  const glow = new THREE.PointLight('#ff9a6a', 2.2, 4, 1.6);
  glow.position.y = 0.4;
  core.add(glow);
  for (let i = 0; i < 6; i += 1) {
    const a = (i / 6) * Math.PI * 2 + 0.3;
    const node = mesh(
      new THREE.SphereGeometry(0.035, 16, 12),
      new THREE.MeshStandardMaterial({ color: '#fff', emissive: '#ffb27a', emissiveIntensity: 2 }),
      { cast: false },
    );
    node.position.set(Math.cos(a) * 0.7, 0.1, Math.sin(a) * 0.7);
    core.add(node);
  }
  core.position.set(0, 0, 0.9);
  scene.add(core);
  // Fine lines of light across the back wall, running to the rooms either side.
  for (const y of [2.55, 2.62]) {
    const line = mesh(new THREE.BoxGeometry(w, 0.012, 0.012), m.lampGlow, { cast: false });
    line.position.set(0, y, BACK + 0.02);
    scene.add(line);
  }
  scene.add(at(plant(m, 'tall', 31, 1.05), -w / 2 + 0.35, 0, BACK + 0.45));
  scene.add(at(plant(m, 'bush', 32, 1.2), w / 2 - 0.35, 0, 1.9));
  return render(scene, camera, width, height);
}

/** The lounge: a sofa, a coffee table, shelves and plants. */
export function lounge(width = 1280, height = 1200) {
  const scene = sceneWith();
  const w = CENTRE_W;
  const camera = roomCamera(w);
  shell(scene, w, { wall: m.plasterWarm, left: 'slats', right: 'glass' });
  scene.add(at(bookshelf(m, 1.1, 2.1, 41), -0.9, 0, BACK + 0.2));
  scene.add(at(bookshelf(m, 1.1, 2.1, 42), 0.9, 0, BACK + 0.2));
  const s = sofa(m, m.fabric('#d9c3a5', 6), 1.9);
  s.position.set(0, 0, -0.5);
  scene.add(s);
  scene.add(at(coffeeTable(m, 0.45), 0, 0, 0.55));
  scene.add(at(mug(m), 0.1, 0.44, 0.55));
  scene.add(at(papers(m, 2, 4), -0.15, 0.44, 0.45));
  scene.add(at(floorLamp(m), 1.35, 0, -0.7));
  scene.add(at(plant(m, 'bush', 44, 1.2), -1.4, 0, 1.6));
  const rug = mesh(new THREE.CircleGeometry(1.4, 64), m.rug, { cast: false });
  rug.rotation.x = -Math.PI / 2;
  rug.position.set(0, 0.004, 0.3);
  scene.add(rug);
  pendants(scene, [0], 0.4, VIEW.height + 1 - 2.2, 'brass');
  return render(scene, camera, width, height);
}

/* ------------------------------------------------------------- workstations */

/*
 * A workstation is drawn in layers so the Home can seat a person or not, and keep its state:
 * the chair (with the shadows on the floor), the person, then the desk in front. Each layer is
 * drawn in the Home's workstation box: 88 units wide from (-44, -66), where the desk's front edge
 * sits at y = -2, and 110 tall so the desk's legs and shadow fit under it.
 */
export const DESK_BOX = { x: -44, y: -66, w: 88, h: 110 };
const UNIT = 1.4 / 84; // The desk (1.4 m) spans 84 units.

function workstationScene(motif) {
  const scene = sceneWith(null);
  scene.environmentIntensity = 0.7;
  const catcher = mesh(new THREE.PlaneGeometry(6, 6), new THREE.ShadowMaterial({ opacity: 0.28 }), {
    cast: false,
  });
  catcher.rotation.x = -Math.PI / 2;
  scene.add(catcher);
  const parts = { catcher, chair: new THREE.Group(), people: [], front: new THREE.Group() };
  const chair = officeChair(m, m.fabric('#2b2a2c', 8));
  chair.position.set(0, 0, -0.58);
  parts.chair.add(chair);
  scene.add(parts.chair);
  for (const look of LOOKS) {
    const p = person(look, { turn: 0.32 });
    p.position.set(0, 0, -0.42);
    p.visible = false;
    parts.people.push(p);
    scene.add(p);
  }
  const top = desk(m);
  parts.front.add(top);
  const screen = new THREE.MeshBasicMaterial({
    map: screenTexture(motif, HUES[motif] ?? '#f2784b', 12),
  });
  const display = monitor(m, screen, 0.56, 0.33);
  display.position.set(-0.42, 0.7525, -0.08);
  display.rotation.y = 0.55;
  parts.front.add(display);
  parts.front.add(at(keyboard(m), 0.02, 0.76, 0.08));
  parts.front.add(at(mug(m, m.terracotta), 0.52, 0.7525, -0.05));
  parts.front.add(at(papers(m, 3, 3), 0.36, 0.7525, 0.12));
  parts.front.add(at(plant(m, 'snake', 9, 0.35), 0.58, 0.7525, -0.22));
  scene.add(parts.front);
  // The camera: as in the rooms, a little above and in front, looking slightly down.
  const camera = new THREE.OrthographicCamera(
    DESK_BOX.x * UNIT,
    (DESK_BOX.x + DESK_BOX.w) * UNIT,
    (DESK_BOX.h / 2) * UNIT,
    (-DESK_BOX.h / 2) * UNIT,
    0.1,
    30,
  );
  const pitch = THREE.MathUtils.degToRad(16);
  camera.position.set(0, 0.745 + Math.sin(pitch) * 8, 0.35 + Math.cos(pitch) * 8);
  camera.lookAt(0, 0.745, 0.35);
  // Shift up so the desk's front edge lands at y = -2 in the box.
  const ndcY = 1 - (2 * (-2 - DESK_BOX.y)) / DESK_BOX.h;
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
  camera.position.addScaledVector(up, -ndcY * ((DESK_BOX.h / 2) * UNIT));
  camera.updateMatrixWorld();
  camera.updateProjectionMatrix();
  // The monitor's screen, in the box's units, for the Home's state overlay.
  display.updateMatrixWorld(true);
  const face = display.getObjectByName('screen');
  const corners = [
    [-1, 1],
    [1, 1],
    [1, -1],
    [-1, -1],
  ].map(([sx, sy]) => {
    const p = new THREE.Vector3((sx * (0.56 - 0.024)) / 2, (sy * (0.33 - 0.024)) / 2, 0)
      .applyMatrix4(face.matrixWorld)
      .project(camera);
    return [
      +(DESK_BOX.x + ((p.x + 1) / 2) * DESK_BOX.w).toFixed(2),
      +(DESK_BOX.y + ((1 - p.y) / 2) * DESK_BOX.h).toFixed(2),
    ];
  });
  return { scene, camera, parts, corners };
}

function hideColour(object, hide) {
  object.traverse((o) => {
    if (o.isMesh) {
      o.material = Array.isArray(o.material) ? o.material : o.material;
      o.userData.material ??= o.material;
      if (hide) {
        // Still casts shadows and hides what is behind it, but draws nothing.
        const ghost = new THREE.MeshBasicMaterial({ colorWrite: false });
        o.material = ghost;
      } else {
        o.material = o.userData.material;
      }
    }
  });
}

/** The layers: `back` (chair and shadows), `person-N`, `front` (desk, monitor, things). */
export function workstation(layer, motif = 'generic', width = 352, height = 440) {
  const { scene, camera, parts, corners } = workstationScene(motif);
  const which = layer.startsWith('person-') ? Number(layer.slice(7)) : -1;
  parts.people.forEach((p, i) => (p.visible = i === which || layer === 'back-person'));
  if (layer === 'back') {
    parts.people.forEach((p) => (p.visible = false));
    hideColour(parts.front, true);
  } else if (layer === 'front') {
    parts.catcher.visible = false;
    parts.chair.visible = false;
  } else {
    parts.catcher.visible = false;
    parts.chair.visible = false;
    hideColour(parts.front, true);
  }
  return { data: render(scene, camera, width, height, layer !== 'back'), corners };
}
