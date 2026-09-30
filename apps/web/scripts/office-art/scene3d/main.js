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
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import {
  at,
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
  plant,
  sofa,
} from './furniture.js';
import { makeMaterials, panelTexture, random, screenTexture } from './materials.js';
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
renderer.toneMappingExposure = 0.92;
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
  // Daylight through the building's glass: a neutral key light from the front left.
  const sun = new THREE.DirectionalLight('#f6f9ff', 2.3);
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
  scene.add(new THREE.HemisphereLight('#f4f8ff', '#b7c0cc', 0.6));
  return scene;
}

function render(scene, camera, width, height, ao = true, glow = scene.background !== null) {
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
  // Lit lines and screens glow softly (rooms only: the glow would not survive transparency).
  if (glow) composer.addPass(new UnrealBloomPass(new THREE.Vector2(width, height), 0.5, 0.35, 2.2));
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

/** A line of integrated light, `len` long along x (or z when `alongZ`). */
function ledLine(len, material = m.led, alongZ = false, thick = 0.018) {
  return mesh(
    alongZ ? new THREE.BoxGeometry(thick, thick, len) : new THREE.BoxGeometry(len, thick, thick),
    material,
    { cast: false },
  );
}

/**
 * The shell: a polished pale floor, a white back wall with lines of light at its foot and near
 * the top, and side walls of glass (a bright corridor behind) or white fluted panels.
 */
function shell(scene, w, { wall = m.wall, left = 'glass', right = 'fluted' } = {}) {
  const { d, h } = ROOM;
  const floorGeometry = new THREE.PlaneGeometry(w, d + 0.02);
  floorGeometry.attributes.uv.array.forEach(
    (v, i, a) => (a[i] = v * (i % 2 === 0 ? w / 2.4 : d / 2.4)),
  );
  const floor = mesh(floorGeometry, m.floor, { cast: false });
  floor.rotation.x = -Math.PI / 2;
  scene.add(floor);
  // The slab edge at the front: the building's floor, cut, with a line of light in it.
  scene.add(at(box(w + 0.02, 0.18, 0.1, m.slab, 0.002), 0, -0.09, d / 2 - 0.05));
  scene.add(at(ledLine(w), 0, -0.03, d / 2 + 0.005));
  scene.add(
    at(mesh(new THREE.PlaneGeometry(w, h + 1.5), wall, { cast: false }), 0, (h + 1.5) / 2, BACK),
  );
  // A shadow gap at the wall's foot with light in it, and a cove of light up high.
  scene.add(at(box(w, 0.06, 0.03, m.white), 0, 0.07, BACK + 0.015));
  scene.add(at(ledLine(w, m.led, false, 0.012), 0, 0.02, BACK + 0.02));
  scene.add(at(ledLine(w, m.lampGlow, false, 0.02), 0, 2.72, BACK + 0.02));
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
      // A glass partition in slim aluminium frames, a bright corridor behind it.
      scene.add(plane(m.corridor, side * 0.9));
      for (let z = BACK; z <= d / 2 + 0.01; z += d / 3)
        scene.add(at(box(0.025, h + 1.5, 0.03, m.aluminium), x, (h + 1.5) / 2, z));
      scene.add(at(box(0.025, 0.03, d, m.aluminium), x, 0.015, 0));
      scene.add(at(ledLine(d, m.led, true, 0.01), x - side * 0.02, 2.5, 0));
      scene.add(plane(m.glass));
    } else {
      // White fluted panels with a vertical line of light where they meet the back wall.
      scene.add(plane(m.wallTint, side * 0.05));
      for (let z = BACK + 0.12; z <= d / 2; z += 0.14)
        scene.add(
          at(box(0.04, h + 1.5, 0.1, m.composite, 0.02), x - side * 0.02, (h + 1.5) / 2, z),
        );
      scene.add(at(box(0.012, h + 1.5, 0.012, m.led), x - side * 0.04, (h + 1.5) / 2, BACK + 0.05));
    }
  }
}

/** The big screen on the back wall, exactly where the Home draws the screen: frameless. */
function wallScreenFrame(scene, camera, rect) {
  const z = BACK + 0.03;
  const a = onPlane(camera, rect.x, rect.y, z);
  const b = onPlane(camera, rect.x + rect.w, rect.y + rect.h, z);
  const w = b.x - a.x;
  const h = a.y - b.y;
  const cx = (a.x + b.x) / 2;
  const cy = (a.y + b.y) / 2;
  scene.add(at(box(w + 0.03, h + 0.03, 0.03, m.bezel, 0.006), cx, cy, z));
  const face = mesh(new THREE.PlaneGeometry(w, h), m.screenOff, { cast: false });
  face.position.set(cx, cy, z + 0.016);
  scene.add(face);
  // A soft line of light under it.
  scene.add(at(ledLine(w * 0.7, m.led, false, 0.008), cx, cy - h / 2 - 0.05, z + 0.01));
  return { cx, cy, w, h, bottom: cy - h / 2 };
}

/** A glass display standing off the wall, glowing with the department's work. */
function glassPanel(kind, w, h, seed) {
  const g = new THREE.Group();
  const face = mesh(new THREE.PlaneGeometry(w, h), m.holo(panelTexture(kind, seed)), {
    cast: false,
  });
  face.position.z = 0.06;
  g.add(face);
  // Standoffs and a faint glow on the wall behind.
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      g.add(
        at(
          cylinder(0.012, 0.012, 0.06, m.aluminium),
          sx * (w / 2 - 0.05),
          sy * (h / 2 - 0.05),
          0.03,
        ),
      );
    }
  }
  const halo = mesh(
    new THREE.PlaneGeometry(w + 0.2, h + 0.2),
    new THREE.MeshBasicMaterial({
      color: '#a9d2ff',
      transparent: true,
      opacity: 0.18,
      depthWrite: false,
    }),
    { cast: false, receive: false },
  );
  halo.position.z = 0.005;
  g.add(halo);
  return g;
}

function cylinder(rt, rb, h, material, segments = 24) {
  const c = mesh(new THREE.CylinderGeometry(rt, rb, h, segments), material);
  c.rotation.x = Math.PI / 2;
  return c;
}

/** A low white sideboard floating off the floor, lit from beneath. */
function credenza(w, seed) {
  const g = new THREE.Group();
  g.add(at(box(w, 0.42, 0.42, m.composite, 0.012), 0, 0.36, 0));
  g.add(at(ledLine(w - 0.1, m.led, false, 0.01), 0, 0.14, 0.18));
  const doors = Math.round(w / 0.45);
  for (let i = 1; i < doors; i += 1) {
    g.add(at(box(0.006, 0.38, 0.006, m.stone), -w / 2 + i * (w / doors), 0.36, 0.212));
  }
  g.add(at(papers(m, 3, seed), -w / 2 + 0.3, 0.57, 0));
  g.add(at(plant(m, 'snake', seed + 3, 0.55), w / 2 - 0.25, 0.57, 0));
  return g;
}

/** A white, lit cabinet: files and devices behind frosted glass. */
function cabinet(seed, h = 1.2) {
  const g = new THREE.Group();
  g.add(at(box(0.6, h, 0.45, m.composite, 0.01), 0, h / 2, 0));
  g.add(at(box(0.52, h - 0.12, 0.01, m.frosted, 0.004), 0, h / 2, 0.23));
  for (let i = 0; i < 3; i += 1)
    g.add(at(ledLine(0.5, m.led, false, 0.006), 0, 0.2 + i * ((h - 0.2) / 3), 0.2));
  g.add(at(papers(m, 3, seed), 0, h, 0));
  return g;
}

const PANELS = {
  growth: ['funnel', 'pipeline'], // Comercial: leads, the funnel, the pipeline.
  dashboard: ['kanban', 'flow'], // Operaciones: tasks and processes.
  social: ['creatives', 'social'], // Marketing: creatives and social content.
  video: ['layouts', 'creatives'], // Diseño: interfaces, prototypes, images.
  network: ['network', 'documents'], // Investigación: data, documents, trends.
  finance: ['charts', 'donut'], // Finanzas: dashboards and indicators.
  map: ['objectives', 'charts'], // Consejo: objectives and the company's figures.
};

/** What sits on each department's walls: the room says what the department does. */
function decorate(scene, camera, motif, seed, w) {
  const screen = wallScreenFrame(scene, camera, SIDE_SCREEN);
  const half = w / 2;
  const leftX = (-half + screen.cx - screen.w / 2) / 2 + 0.08;
  const rightX = (half + screen.cx + screen.w / 2) / 2 - 0.08;
  const [left, right] = PANELS[motif] ?? ['default', 'default'];
  scene.add(at(credenza(screen.w * 0.9, seed), 0, 0, BACK + 0.24));
  scene.add(at(glassPanel(left, 1.05, 0.7, seed), leftX, 1.5, BACK + 0.02));
  scene.add(at(glassPanel(right, 0.85, 0.55, seed + 1), rightX, 1.62, BACK + 0.02));
  scene.add(at(cabinet(seed, 1.0), rightX, 0, BACK + 0.3));
  // Plants in the back corners.
  scene.add(at(plant(m, 'tall', seed + 11, 1.05), -half + 0.32, 0, BACK + 0.4));
  scene.add(at(plant(m, 'bush', seed + 13, 1.1), half - 0.28, 0, BACK + 0.45));
  // Lines of light in the floor along the rows of desks.
  for (const z of [0.2, 1.6]) scene.add(at(ledLine(w - 1.2, m.led, false, 0.008), 0, 0.003, z));
}

/** The accent of each department's monitors: the office's blue, or the brand's coral. */
const SCREEN_HUES = { growth: '#ff8a5c', social: '#ff8a5c', map: '#ff8a5c' };

const SIDE_W = ROOM.h * 1.6;
const CENTRE_W = (ROOM.h * 640) / 600;
const CHAIR = '#cfd5dd';

export function sideRoom(motif, seed, width = 1920, height = 1200) {
  const scene = sceneWith(new THREE.Color('#e9edf2'));
  const camera = roomCamera(SIDE_W);
  shell(scene, SIDE_W, {
    left: seed % 2 === 0 ? 'glass' : 'fluted',
    right: seed % 2 === 0 ? 'fluted' : 'glass',
  });
  if (motif === 'meeting') {
    wallScreenFrame(scene, camera, { ...SIDE_SCREEN, y: 0.2, h: 0.2 });
    const table = meetingTable(m, 2.6, 1.1);
    table.position.set(0, 0, 0.3);
    scene.add(table);
    scene.add(at(ledLine(2.4, m.led, false, 0.01), 0, 0.72, 0.86));
    const fabric = m.fabric(CHAIR, 3);
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
    scene.add(at(glassPanel('objectives', 0.8, 0.55, seed), -1.75, 1.55, BACK + 0.02));
    scene.add(at(glassPanel('default', 0.8, 0.55, seed + 1), 1.75, 1.55, BACK + 0.02));
  } else {
    decorate(scene, camera, motif, seed, SIDE_W);
  }
  return render(scene, camera, width, height);
}

/** The city through headquarters' glass: pale towers under a clear sky. */
function cityView() {
  const c = document.createElement('canvas');
  c.width = 1024;
  c.height = 640;
  const g = c.getContext('2d');
  const sky = g.createLinearGradient(0, 0, 0, 640);
  sky.addColorStop(0, '#bcd6f2');
  sky.addColorStop(0.8, '#eef3fa');
  g.fillStyle = sky;
  g.fillRect(0, 0, 1024, 640);
  const r = random(5);
  for (const [tone, top] of [
    ['rgba(170,190,215,0.55)', 320],
    ['rgba(130,152,182,0.7)', 220],
  ]) {
    let x = -20;
    while (x < 1024) {
      const bw = 50 + r() * 80;
      const bh = 180 + r() * top;
      g.fillStyle = tone;
      g.fillRect(x, 640 - bh, bw - 8, bh);
      g.fillStyle = 'rgba(235,245,255,0.35)';
      for (let y = 640 - bh + 12; y < 630; y += 18) g.fillRect(x + 6, y, bw - 20, 3);
      x += bw;
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** A ring of light lying on the floor (or a platform). */
function lightRing(radius, material = m.led, tube = 0.014) {
  const ring = mesh(new THREE.TorusGeometry(radius, tube, 12, 160), material, { cast: false });
  ring.rotation.x = -Math.PI / 2;
  return ring;
}

/**
 * Headquarters: the executive centre. Consejo's strategy table by the glass, and GIA on a round,
 * lit platform at the heart of the room, a quiet ring of light above her.
 */
export function headquarters(width = 1280, height = 1200) {
  const scene = sceneWith(new THREE.Color('#e9edf2'));
  const w = CENTRE_W;
  const camera = roomCamera(w);
  shell(scene, w, { wall: m.wallTint, left: 'glass', right: 'glass' });
  // Floor-to-ceiling glass over the city.
  const view = mesh(
    new THREE.PlaneGeometry(w - 0.4, 2.3),
    new THREE.MeshBasicMaterial({ map: cityView() }),
    { cast: false },
  );
  view.position.set(0, 1.4, BACK + 0.01);
  scene.add(view);
  for (let i = 0; i <= 3; i += 1)
    scene.add(
      at(box(0.03, 2.4, 0.05, m.aluminium), -(w - 0.4) / 2 + (i * (w - 0.4)) / 3, 1.4, BACK + 0.04),
    );
  scene.add(at(box(w - 0.35, 0.04, 0.08, m.aluminium), 0, 0.25, BACK + 0.05));
  const daylight = new THREE.SpotLight('#eef5ff', 14, 12, 0.9, 0.8, 1.2);
  daylight.position.set(0, 2.2, BACK - 0.6);
  daylight.target.position.set(0, 0, 1.5);
  scene.add(daylight, daylight.target);
  // Consejo's strategy table: white, round, a glass display of objectives above it.
  const table = new THREE.Group();
  table.add(at(mesh(new THREE.CylinderGeometry(0.5, 0.5, 0.04, 64), m.composite), 0, 0.74, 0));
  table.add(at(mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.72, 16), m.aluminium), 0, 0.37, 0));
  table.add(at(lightRing(0.46, m.led, 0.006), 0, 0.765, 0));
  for (let i = 0; i < 4; i += 1) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    const c = officeChair(m, m.fabric(CHAIR, 12 + i));
    c.position.set(Math.sin(a) * 0.8, 0, Math.cos(a) * 0.8);
    c.rotation.y = a + Math.PI;
    table.add(c);
  }
  table.position.set(-1.05, 0, BACK + 1.2);
  scene.add(table);
  const board = glassPanel('objectives', 0.9, 0.6, 7);
  board.position.set(-1.05, 1.55, BACK + 0.5);
  scene.add(board);
  // GIA's platform: a low white disc ringed in coral light, her white desk on it, a ring of
  // light standing behind her: the intelligence at the centre of the office.
  const centre = new THREE.Group();
  centre.add(at(mesh(new THREE.CylinderGeometry(1.0, 1.05, 0.12, 96), m.composite), 0, 0.06, 0));
  centre.add(at(lightRing(1.03, m.ledCoral, 0.014), 0, 0.1, 0));
  centre.add(at(lightRing(0.82, m.led, 0.007), 0, 0.125, 0));
  const deskTop = box(1.3, 0.04, 0.6, m.composite, 0.015);
  deskTop.position.set(0, 0.86, 0.12);
  centre.add(deskTop);
  const pedestal = box(1.16, 0.72, 0.08, m.composite, 0.015);
  pedestal.position.set(0, 0.48, 0.36);
  centre.add(pedestal);
  centre.add(at(ledLine(1.12, m.ledCoral, false, 0.012), 0, 0.3, 0.405));
  const gia = person(
    { skin: '#eec5a6', hair: '#3a2419', top: '#f4efe9', jacket: '#e8704a', style: 'bun' },
    { turn: 0 },
  );
  gia.position.set(0, 0.12, -0.32);
  const chair = officeChair(m, m.fabric('#f1f3f6', 4));
  chair.position.set(0, 0.12, -0.5);
  centre.add(chair, gia);
  centre.add(
    at(
      laptop(m, new THREE.MeshBasicMaterial({ map: screenTexture('map', '#ff8a5c', 3) })),
      0,
      0.885,
      0.1,
    ),
  );
  const giaScreen = mesh(
    new THREE.PlaneGeometry(0.56, 0.34),
    m.holo(panelTexture('objectives', 5), 0.95),
    { cast: false },
  );
  giaScreen.position.set(-0.52, 1.18, 0.2);
  giaScreen.rotation.y = 0.35;
  centre.add(giaScreen);
  const halo = mesh(new THREE.TorusGeometry(0.42, 0.012, 12, 128), m.ledCoral, { cast: false });
  halo.position.set(0, 1.42, -0.62);
  centre.add(halo);
  const haloInner = mesh(new THREE.TorusGeometry(0.34, 0.005, 12, 128), m.led, { cast: false });
  haloInner.position.set(0, 1.42, -0.63);
  centre.add(haloInner);
  const glow = new THREE.PointLight('#ff9a6a', 1.8, 3, 1.6);
  glow.position.set(0, 1.4, 0.3);
  centre.add(glow);
  centre.position.set(0.35, 0, 0.7);
  scene.add(centre);
  scene.add(at(plant(m, 'tall', 21, 1.05), w / 2 - 0.35, 0, BACK + 0.45));
  return render(scene, camera, width, height);
}

/**
 * The atrium: MelonMotor, the office's nervous system. A glass column of lit layers rises from
 * a ring in the floor; lines of light leave it for the rooms either side.
 */
export function atrium(width = 1280, height = 1200) {
  const scene = sceneWith(new THREE.Color('#e9edf2'));
  const w = CENTRE_W;
  const camera = roomCamera(w);
  shell(scene, w, { wall: m.wall, left: 'glass', right: 'glass' });
  // The wall behind: dark glass traced with lines of light, the office's circuits.
  const circuitWall = mesh(
    new THREE.PlaneGeometry(w - 0.6, 2.4),
    m.holo(panelTexture('circuit', 9), 1),
    {
      cast: false,
    },
  );
  circuitWall.position.set(0, 1.45, BACK + 0.03);
  scene.add(circuitWall);
  const core = new THREE.Group();
  core.add(at(mesh(new THREE.CylinderGeometry(0.85, 0.9, 0.08, 96), m.composite), 0, 0.04, 0));
  core.add(at(lightRing(0.84, m.led, 0.016), 0, 0.085, 0));
  core.add(at(lightRing(0.6, m.ledCoral, 0.012), 0, 0.086, 0));
  // The column: a tall glass prism with lit layers inside, rising through the atrium.
  const glassBlock = new THREE.MeshPhysicalMaterial({
    color: '#dcecff',
    roughness: 0.06,
    transmission: 0.6,
    transparent: true,
    opacity: 0.5,
    emissive: '#5aa7ff',
    emissiveIntensity: 0.25,
  });
  core.add(at(box(0.5, 2.5, 0.5, glassBlock, 0.03), 0, 1.33, 0));
  for (let i = 0; i < 9; i += 1) {
    const s = 0.3 - (i % 3) * 0.05;
    core.add(at(box(s, 0.035, s, i % 4 === 2 ? m.ledCoral : m.led, 0.008), 0, 0.3 + i * 0.26, 0));
  }
  for (const [sx, sz] of [
    [-1, -1],
    [1, -1],
    [-1, 1],
    [1, 1],
  ]) {
    core.add(at(box(0.012, 2.5, 0.012, m.led), sx * 0.25, 1.33, sz * 0.25));
  }
  const glow = new THREE.PointLight('#8fc4ff', 3, 4.5, 1.6);
  glow.position.y = 1.2;
  core.add(glow);
  // Grooves of light in the floor, out to the rooms either side.
  for (const x of [-1, 1])
    core.add(at(ledLine(w / 2 - 0.9, m.led, false, 0.01), x * (w / 4 + 0.45), 0.004, 0));
  core.position.set(0, 0, 0.75);
  scene.add(core);
  scene.add(at(plant(m, 'tall', 31, 1.05), -w / 2 + 0.35, 0, BACK + 0.45));
  return render(scene, camera, width, height);
}

/** The lounge: a white sofa, a low table, shelves and plants. */
export function lounge(width = 1280, height = 1200) {
  const scene = sceneWith(new THREE.Color('#e9edf2'));
  const w = CENTRE_W;
  const camera = roomCamera(w);
  shell(scene, w, { wall: m.wallTint, left: 'fluted', right: 'glass' });
  scene.add(at(bookshelf(m, 1.1, 2.1, 41), -0.9, 0, BACK + 0.2));
  scene.add(at(bookshelf(m, 1.1, 2.1, 42), 0.9, 0, BACK + 0.2));
  const s = sofa(m, m.fabric('#e4e7ec', 6), 1.9);
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
  const chair = officeChair(m, m.fabric(CHAIR, 8));
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
    map: screenTexture(motif, SCREEN_HUES[motif] ?? '#7cc0ff', 12),
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
