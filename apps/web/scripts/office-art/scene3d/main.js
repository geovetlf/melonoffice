/**
 * The office's 3D art (Home): rooms and workstations modelled in three.js and rendered with
 * physical materials, soft shadows, image-based light and ambient occlusion, then saved as
 * pictures. It runs only when the art is baked (bake.mjs); the app ships the pictures.
 *
 * Every room is a diorama: an open box seen from the front and above, as in the Home's reference
 * design, its walls cut so the work inside shows. A department's room keeps its floor clear for
 * the Home to seat its workstations, and each bake reports where that floor is in the picture.
 */
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { Reflector } from 'three/addons/objects/Reflector.js';
import { circuitTexture, outsideTexture, posterTexture, wallDisplay } from './displays.js';
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
import { makeMaterials, random } from './materials.js';
import { LOOKS, person } from './people.js';

const renderer = new THREE.WebGLRenderer({
  antialias: true,
  alpha: true,
  preserveDrawingBuffer: true,
});
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.VSMShadowMap;
renderer.toneMapping = THREE.AgXToneMapping;
renderer.toneMappingExposure = 0.78;
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.body.appendChild(renderer.domElement);

const m = makeMaterials();
const environment = new THREE.PMREMGenerator(renderer).fromScene(
  new RoomEnvironment(),
  0.04,
).texture;

/** Warm morning light through the windows, a soft cool fill from the room. */
function sceneWith(background = null) {
  const scene = new THREE.Scene();
  scene.environment = environment;
  scene.environmentIntensity = 0.45;
  scene.background = background;
  const sun = new THREE.DirectionalLight('#ffd6a6', 3.6);
  sun.position.set(-6, 9, 7);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -7;
  sun.shadow.camera.right = 7;
  sun.shadow.camera.top = 7;
  sun.shadow.camera.bottom = -7;
  sun.shadow.radius = 10;
  sun.shadow.blurSamples = 16;
  sun.shadow.bias = -0.0004;
  scene.add(sun);
  scene.add(new THREE.HemisphereLight('#eef3fb', '#cbbfae', 0.45));
  return scene;
}

function render(scene, camera, width, height, ao = true, glow = scene.background !== null) {
  renderer.setPixelRatio(1);
  renderer.setSize(width, height, false);
  renderer.setClearColor(0x000000, 0);
  if (!ao) {
    renderer.render(scene, camera);
    return renderer.domElement.toDataURL('image/png');
  }
  const composer = new EffectComposer(renderer);
  composer.setSize(width, height);
  composer.addPass(new RenderPass(scene, camera));
  const gtao = new GTAOPass(scene, camera, width, height);
  gtao.updateGtaoMaterial({
    radius: 0.5,
    distanceExponent: 1.6,
    thickness: 1.2,
    scale: 1.1,
    samples: 16,
  });
  gtao.blendIntensity = 0.9;
  composer.addPass(gtao);
  // Screens and lines of light glow softly (rooms only: the glow would not survive transparency).
  if (glow) composer.addPass(new UnrealBloomPass(new THREE.Vector2(width, height), 0.35, 0.3, 1.6));
  composer.addPass(new OutputPass());
  composer.render();
  const data = renderer.domElement.toDataURL('image/png');
  composer.dispose();
  return data;
}

/* ------------------------------------------------------------------ rooms */

const ROOM = { d: 5.2, h: 2.7, wall: 0.16 };
/** A side room is 7 m wide; the centre rooms are narrower, as the Home's columns (10 : 7 : 10). */
const SIDE_W = 7;
const CENTRE_W = 4.9;
export const SIDE_ASPECT = 1.8;
export const CENTRE_ASPECT = 1.26;

/**
 * The camera: in front and above, looking down at 27°, close in: the room's front corners fall
 * just outside the picture and the back wall's top just above it, so the room fills its frame.
 */
const PITCH_ROOM = THREE.MathUtils.degToRad(27);
/** How far past the picture's sides the front corners go, and where the back wall's top is. */
const ZOOM = { sides: -1.22, top: 1.04 };

function roomCamera(w, aspect) {
  const camera = new THREE.PerspectiveCamera(30, aspect, 0.3, 80);
  const place = (distance, targetY) => {
    camera.position.set(
      0,
      targetY + Math.sin(PITCH_ROOM) * distance,
      Math.cos(PITCH_ROOM) * distance,
    );
    camera.lookAt(0, targetY, 0);
    camera.updateMatrixWorld();
    camera.updateProjectionMatrix();
  };
  const u = (x, y, z) => new THREE.Vector3(x, y, z).project(camera);
  let targetY = 0.6;
  let distance = 10;
  for (let round = 0; round < 6; round += 1) {
    // The distance that puts the front corners at the picture's sides.
    let near = 2;
    let far = 40;
    for (let i = 0; i < 40; i += 1) {
      distance = (near + far) / 2;
      place(distance, targetY);
      if (u(-w / 2 - ROOM.wall, 0, ROOM.d / 2).x < ZOOM.sides) near = distance;
      else far = distance;
    }
    // The height that puts the back wall's top just inside the top edge.
    let low = -3;
    let high = 4;
    for (let i = 0; i < 40; i += 1) {
      targetY = (low + high) / 2;
      place(distance, targetY);
      if (u(0, ROOM.h, BACK - ROOM.wall).y > ZOOM.top) low = targetY;
      else high = targetY;
    }
  }
  place(distance, targetY);
  return camera;
}

/** Where a point of the floor (or any point) lands in the picture, as fractions. */
function project(camera, x, y, z) {
  const p = new THREE.Vector3(x, y, z).project(camera);
  return [+((p.x + 1) / 2).toFixed(4), +((1 - p.y) / 2).toFixed(4)];
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

/** A picture that glows as a screen does: untouched by the room's light. */
function glowing(map) {
  return new THREE.MeshBasicMaterial({ map, toneMapped: false });
}

/**
 * The shell: a glossy pale floor on a white slab, a white back wall and two side walls cut at
 * their tops, one of them a tall window onto a bright morning.
 */
function shell(scene, w, { window: windowSide = 'left', wall = m.wall } = {}) {
  const { d, h, wall: t } = ROOM;
  const floorGeometry = new THREE.PlaneGeometry(w, d);
  floorGeometry.attributes.uv.array.forEach(
    (v, i, a) => (a[i] = v * (i % 2 === 0 ? w / 2.4 : d / 2.4)),
  );
  const floor = mesh(floorGeometry, m.floor, { cast: false });
  floor.rotation.x = -Math.PI / 2;
  scene.add(floor);
  // Polished: the room shows softly in the floor.
  const mirror = new Reflector(new THREE.PlaneGeometry(w, d), {
    textureWidth: 1024,
    textureHeight: 1024,
    color: '#c2c6cc',
  });
  mirror.rotation.x = -Math.PI / 2;
  mirror.position.y = -0.002;
  scene.add(mirror);
  // The slab under the floor, its front edge lit.
  scene.add(at(box(w + 2 * t, 0.22, d + t, m.white, 0.02), 0, -0.11, -t / 2));
  scene.add(at(ledLine(w - 0.4, m.led, false, 0.014), 0, -0.05, d / 2 + 0.005));
  // The back wall, cut at the top.
  scene.add(at(box(w + 2 * t, h, t, wall, 0.01), 0, h / 2, BACK - t / 2));
  scene.add(at(box(w, 0.05, 0.02, m.white), 0, 0.025, BACK + 0.01));
  scene.add(at(ledLine(w - 0.2, m.lampGlow, false, 0.016), 0, h - 0.08, BACK + 0.03));
  for (const side of [-1, 1]) {
    const x = side * (w / 2 + t / 2);
    if ((side === -1 ? 'left' : 'right') === windowSide) {
      // A tall window: a sill, a head, slim dark mullions and the bright day behind.
      scene.add(at(box(t, 0.42, d, m.white, 0.01), x, 0.21, 0));
      scene.add(at(box(t, 0.3, d, m.white, 0.01), x, h - 0.15, 0));
      scene.add(at(box(t + 0.04, 0.03, d, m.stone), x, 0.43, 0));
      const panes = 3;
      for (let i = 0; i <= panes; i += 1) {
        const z = BACK + (i * d) / panes;
        scene.add(at(box(0.05, h - 0.72, 0.05, m.blackMetal), x, 0.42 + (h - 0.72) / 2, z));
      }
      const glass = mesh(new THREE.PlaneGeometry(d, h - 0.72), m.glass, { cast: false });
      glass.rotation.y = side * (Math.PI / 2);
      glass.position.set(x, 0.42 + (h - 0.72) / 2, 0);
      scene.add(glass);
      const day = mesh(new THREE.PlaneGeometry(d * 1.6, h * 1.6), glowing(outsideTexture(7)), {
        cast: false,
        receive: false,
      });
      day.rotation.y = -side * (Math.PI / 2);
      day.position.set(x + side * 1.4, h * 0.55, 0);
      scene.add(day);
      // The morning coming in.
      const spill = new THREE.PointLight('#ffe9cc', 6, 7, 1.4);
      spill.position.set(x - side * 0.8, h * 0.7, 0);
      scene.add(spill);
    } else {
      scene.add(at(box(t, h, d, wall, 0.01), x, h / 2, 0));
    }
  }
  // Warm downlights where the ceiling would be.
  for (const lx of [-w / 4, w / 4]) {
    const lamp = new THREE.PointLight('#ffd9ad', 3.2, 6, 1.5);
    lamp.position.set(lx, h + 0.4, 0.2);
    scene.add(lamp);
  }
}

/** The big screen on the back wall, glowing with the department's work. */
function bigScreen(scene, kind, seed, cx, bottom, w) {
  const h = w * (860 / 1600);
  const z = BACK + 0.03;
  scene.add(at(box(w + 0.05, h + 0.05, 0.04, m.bezel, 0.01), cx, bottom + h / 2, z));
  const face = mesh(new THREE.PlaneGeometry(w, h), glowing(wallDisplay(kind, seed)), {
    cast: false,
  });
  face.position.set(cx, bottom + h / 2, z + 0.022);
  scene.add(face);
  const wash = new THREE.PointLight('#8fc4ff', 1.6, 3.2, 1.6);
  wash.position.set(cx, bottom + h / 2, z + 0.7);
  scene.add(wash);
  return { cx, cy: bottom + h / 2, w, h };
}

/** A framed picture on the back wall. */
function framed(map, w, h) {
  const g = new THREE.Group();
  g.add(at(box(w + 0.04, h + 0.04, 0.03, m.white, 0.004), 0, 0, 0));
  const face = mesh(
    new THREE.PlaneGeometry(w, h),
    new THREE.MeshStandardMaterial({ map, roughness: 0.7 }),
    {
      cast: false,
    },
  );
  face.position.z = 0.016;
  g.add(face);
  return g;
}

/** Floating white shelves with books, pots and a few objects. */
function shelves(seed, w = 1.2, levels = 3) {
  const r = random(seed);
  const g = new THREE.Group();
  for (let i = 0; i < levels; i += 1) {
    const y = 1.0 + i * 0.42;
    g.add(at(box(w, 0.035, 0.26, m.composite, 0.008), 0, y, 0));
    let x = -w / 2 + 0.08;
    while (x < w / 2 - 0.15) {
      if (r() < 0.25) {
        g.add(
          at(
            plant(m, r() < 0.5 ? 'snake' : 'bush', seed + i * 7 + Math.floor(x * 10), 0.32),
            x + 0.08,
            y + 0.02,
            0,
          ),
        );
        x += 0.24;
      } else {
        const n = 3 + Math.floor(r() * 5);
        for (let b = 0; b < n; b += 1) {
          const bh = 0.16 + r() * 0.08;
          const book = box(
            0.035,
            bh,
            0.18,
            new THREE.MeshStandardMaterial({
              color: ['#e9e4dc', '#c8d3e0', '#2f3b4c', '#d9b98c', '#8fa3b8', '#f4efe9'][
                Math.floor(r() * 6)
              ],
              roughness: 0.8,
            }),
            0.003,
          );
          book.position.set(x + b * 0.04, y + 0.02 + bh / 2, 0);
          g.add(book);
        }
        x += n * 0.04 + 0.12;
      }
    }
  }
  return g;
}

/** A low white cabinet with drawers. */
function lowCabinet(w, seed) {
  const g = new THREE.Group();
  g.add(at(box(w, 0.62, 0.45, m.composite, 0.012), 0, 0.31, 0));
  const n = Math.max(2, Math.round(w / 0.5));
  for (let i = 1; i < n; i += 1)
    g.add(at(box(0.006, 0.56, 0.006, m.stone), -w / 2 + i * (w / n), 0.31, 0.226));
  g.add(at(papers(m, 2, seed), -w / 2 + 0.3, 0.62, 0));
  g.add(at(plant(m, 'snake', seed + 3, 0.5), w / 2 - 0.22, 0.62, 0));
  return g;
}

/** Which graphics each department's walls carry, and the season of its room. */
const ROOMS = {
  growth: { side: 'dashboard', board: 'prints' }, // Comercial: funnel, pipeline, leads.
  dashboard: { side: 'growth', board: 'prints' }, // Operaciones: kanban and processes.
  social: { side: 'network', board: 'moodboard' }, // Marketing: campaigns and creatives.
  video: { side: 'social', board: 'moodboard' }, // Diseño: moodboards and prototypes.
  network: { side: 'finance', board: 'prints' }, // Investigación: data and trends.
  finance: { side: 'map', board: 'prints' }, // Finanzas: incomes, costs, charts.
  generic: { side: 'finance', board: 'prints' },
};

/** The part of the floor the Home seats workstations on, in metres. */
const DESK_FLOOR = { x: 2.7, back: -1.0, front: 1.9 };

function floorCorners(camera, halfWidth, back, front) {
  return [
    project(camera, -halfWidth, 0, back),
    project(camera, halfWidth, 0, back),
    project(camera, halfWidth, 0, front),
    project(camera, -halfWidth, 0, front),
  ];
}

/**
 * A department's room: its big screen on the back wall, its boards and prints, a window on one
 * side and shelves on the other, plants in the corners and a clear floor for the desks.
 */
export function sideRoom(motif, seed, width = 1152, height = 640) {
  const scene = sceneWith(new THREE.Color('#eef1f5'));
  const w = SIDE_W;
  const camera = roomCamera(w, SIDE_ASPECT);
  const windowSide = seed % 2 === 0 ? 'right' : 'left';
  shell(scene, w, { window: windowSide });
  let screen;
  const half = w / 2;
  const screenX = windowSide === 'left' ? 0.35 : -0.35;
  if (motif === 'meeting') {
    bigScreen(scene, 'generic', seed, 0, 1.05, 2.4);
    const table = meetingTable(m, 3.2, 1.3);
    table.position.set(0, 0, 0.4);
    scene.add(table);
    const fabric = m.fabric('#2d3139', 3);
    for (let i = 0; i < 3; i += 1) {
      for (const side of [-1, 1]) {
        const c = officeChair(m, fabric);
        c.position.set(-1.05 + i * 1.05, 0, 0.4 + side * 1.0);
        c.rotation.y = side === 1 ? Math.PI : 0;
        scene.add(c);
      }
    }
    scene.add(at(plant(m, 'tall', seed, 1.25), -half + 0.45, 0, BACK + 0.5));
    scene.add(at(plant(m, 'tall', seed + 2, 1.2), half - 0.45, 0, BACK + 0.5));
    scene.add(at(plant(m, 'bush', seed + 4, 1.2), half - 0.5, 0, 2.0));
  } else {
    const look = ROOMS[motif] ?? ROOMS.generic;
    const big = bigScreen(scene, motif, seed, screenX, 1.0, 3.0);
    screen = [
      ...project(camera, big.cx - big.w / 2, big.cy + big.h / 2, BACK + 0.05),
      ...project(camera, big.cx + big.w / 2, big.cy - big.h / 2, BACK + 0.05),
    ];
    // Beside the screen: a moodboard or prints, and a second, smaller screen.
    const boardX = screenX + (windowSide === 'left' ? -2.35 : 2.35);
    if (look.board === 'moodboard') {
      scene.add(at(framed(posterTexture(seed, 3, 2), 1.3, 1.1), boardX, 1.65, BACK + 0.02));
    } else {
      scene.add(at(framed(posterTexture(seed, 1, 1), 0.46, 0.6), boardX - 0.3, 1.75, BACK + 0.02));
      scene.add(
        at(framed(posterTexture(seed + 5, 1, 1), 0.46, 0.6), boardX + 0.3, 1.75, BACK + 0.02),
      );
    }
    const small = mesh(
      new THREE.PlaneGeometry(0.62, 0.36),
      glowing(wallDisplay(look.side, seed + 9)),
      {
        cast: false,
      },
    );
    const smallX = screenX + (windowSide === 'left' ? 2.05 : -2.05);
    small.position.set(smallX, 1.95, BACK + 0.04);
    scene.add(at(box(0.66, 0.4, 0.03, m.bezel, 0.006), smallX, 1.95, BACK + 0.02), small);
    scene.add(at(lowCabinet(1.5, seed), screenX, 0, BACK + 0.26));
    // The solid side wall: shelves and a tall plant.
    const wallX = windowSide === 'left' ? half - 0.14 : -half + 0.14;
    const sh = shelves(seed + 20, 1.6, 3);
    sh.rotation.y = windowSide === 'left' ? -Math.PI / 2 : Math.PI / 2;
    sh.position.set(wallX, 0, BACK + 1.2);
    scene.add(sh);
    // Plants: tall ones in the back corners, a bush at the front by the window.
    scene.add(at(plant(m, 'tall', seed + 11, 1.3), -half + 0.4, 0, BACK + 0.45));
    scene.add(at(plant(m, 'tall', seed + 13, 1.25), half - 0.4, 0, BACK + 0.45));
    const windowX = windowSide === 'left' ? -half + 0.45 : half - 0.45;
    scene.add(at(plant(m, 'bush', seed + 17, 1.35), windowX, 0, 2.05));
    scene.add(at(plant(m, 'tall', seed + 19, 1.1), windowX, 0, 0.6));
  }
  const data = render(scene, camera, width, height);
  return {
    data,
    floor: floorCorners(camera, DESK_FLOOR.x, DESK_FLOOR.back, DESK_FLOOR.front),
    screen,
  };
}

/** A ring of light lying on the floor (or a platform). */
function lightRing(radius, material = m.led, tube = 0.014) {
  const ring = mesh(new THREE.TorusGeometry(radius, tube, 12, 160), material, { cast: false });
  ring.rotation.x = -Math.PI / 2;
  return ring;
}

/**
 * Consejo: the board room. An oval white table, dark chairs, the world and the company's
 * objectives on the screen, plants either side.
 */
export function headquarters(width = 806, height = 640) {
  const scene = sceneWith(new THREE.Color('#eef1f5'));
  const w = CENTRE_W;
  const camera = roomCamera(w, CENTRE_ASPECT);
  shell(scene, w, { window: 'left' });
  bigScreen(scene, 'map', 5, 0.25, 1.05, 2.4);
  const table = new THREE.Group();
  const top = mesh(new THREE.CylinderGeometry(1, 1, 0.05, 96), m.composite);
  top.scale.set(1.25, 1, 0.62);
  top.position.y = 0.74;
  table.add(top);
  table.add(at(mesh(new THREE.CylinderGeometry(0.16, 0.22, 0.72, 32), m.composite), 0, 0.36, 0));
  table.add(at(lightRing(0.3, m.led, 0.006), 0, 0.77, 0));
  const fabric = m.fabric('#2d3139', 12);
  for (let i = 0; i < 8; i += 1) {
    const a = (i / 8) * Math.PI * 2;
    const c = officeChair(m, fabric);
    c.position.set(Math.sin(a) * 1.55, 0, Math.cos(a) * 0.95);
    c.rotation.y = a + Math.PI;
    table.add(c);
  }
  table.position.set(0.1, 0, 0.1);
  scene.add(table);
  const rug = mesh(new THREE.PlaneGeometry(3.8, 2.6), m.fabric('#6d737c', 4), { cast: false });
  rug.rotation.x = -Math.PI / 2;
  rug.position.set(0.1, 0.004, 0.1);
  scene.add(rug);
  scene.add(at(plant(m, 'tall', 21, 1.3), -w / 2 + 0.45, 0, BACK + 0.45));
  scene.add(at(plant(m, 'tall', 23, 1.3), w / 2 - 0.42, 0, BACK + 0.45));
  scene.add(at(plant(m, 'bush', 25, 1.2), w / 2 - 0.45, 0, 1.9));
  const data = render(scene, camera, width, height);
  return { data, floor: floorCorners(camera, 1.9, 1.2, 2.2) };
}

/**
 * GIA's place at the centre of the office: a bright, curved gallery with a lit platform in its
 * middle, rings of light on the floor. GIA herself is drawn by the Home over the platform.
 */
export function giaRoom(width = 806, height = 640) {
  const scene = sceneWith(new THREE.Color('#eef2f8'));
  const w = CENTRE_W;
  const camera = roomCamera(w, CENTRE_ASPECT);
  shell(scene, w, { window: 'none', wall: m.wallTint });
  // Glass displays along both walls: the work GIA oversees.
  for (const side of [-1, 1]) {
    for (let i = 0; i < 3; i += 1) {
      const panel = mesh(
        new THREE.PlaneGeometry(0.8, 0.9),
        glowing(
          wallDisplay(
            ['growth', 'finance', 'social', 'dashboard', 'network', 'map'][i + (side + 1) * 1.5],
            30 + i,
          ),
        ),
        {
          cast: false,
        },
      );
      panel.rotation.y = -side * (Math.PI / 2);
      panel.position.set(side * (w / 2 - 0.02), 1.4, BACK + 0.9 + i * 1.3);
      scene.add(panel);
    }
  }
  // The back wall opens onto a hall of light: a corridor with lines of light running away.
  const hall = new THREE.Group();
  const hallW = 2.2;
  const hallH = 2.3;
  const hallD = 5;
  const hallWall = new THREE.MeshStandardMaterial({ color: '#eef4fb', roughness: 0.5 });
  hall.add(at(box(hallW, 0.05, hallD, m.floor), 0, -0.02, -hallD / 2));
  hall.add(at(box(hallW, 0.05, hallD, hallWall), 0, hallH, -hallD / 2));
  for (const sx of [-1, 1]) {
    hall.add(at(box(0.05, hallH, hallD, hallWall), sx * (hallW / 2), hallH / 2, -hallD / 2));
    for (let i = 0; i < 5; i += 1) {
      hall.add(
        at(box(0.02, hallH - 0.2, 0.03, m.led), sx * (hallW / 2 - 0.04), hallH / 2, -0.4 - i * 1.0),
      );
    }
  }
  for (let i = 0; i < 5; i += 1)
    hall.add(at(box(hallW - 0.1, 0.02, 0.03, m.led), 0, hallH - 0.04, -0.4 - i * 1.0));
  hall.add(
    at(
      mesh(
        new THREE.PlaneGeometry(hallW, hallH),
        new THREE.MeshBasicMaterial({ color: '#dff0ff' }),
        { cast: false },
      ),
      0,
      hallH / 2,
      -hallD + 0.05,
    ),
  );
  const hallLight = new THREE.PointLight('#bfe0ff', 6, 6, 1.2);
  hallLight.position.set(0, 1.6, -2);
  hall.add(hallLight);
  hall.position.set(0, 0, BACK - ROOM.wall);
  scene.add(hall);
  // The wall around the opening, instead of the shell's plain wall.
  scene.traverse((o) => {
    if (o.isMesh && Math.abs(o.position.z - (BACK - ROOM.wall / 2)) < 0.001 && o.position.y > 0.5) {
      o.visible = false;
    }
  });
  const sideW = (w + 2 * ROOM.wall - hallW) / 2;
  for (const sx of [-1, 1])
    scene.add(
      at(
        box(sideW, ROOM.h, ROOM.wall, m.wallTint, 0.01),
        sx * (hallW / 2 + sideW / 2),
        ROOM.h / 2,
        BACK - ROOM.wall / 2,
      ),
    );
  scene.add(
    at(
      box(hallW, ROOM.h - hallH, ROOM.wall, m.wallTint, 0.01),
      0,
      hallH + (ROOM.h - hallH) / 2,
      BACK - ROOM.wall / 2,
    ),
  );
  for (const x of [-hallW / 2, hallW / 2])
    scene.add(at(box(0.04, hallH, 0.04, m.led), x, hallH / 2, BACK + 0.02));
  scene.add(at(box(hallW, 0.04, 0.04, m.led), 0, hallH, BACK + 0.02));
  const blue = new THREE.PointLight('#8fc4ff', 5, 6, 1.4);
  blue.position.set(0, 2.2, 0);
  scene.add(blue);
  // The platform: white, round, ringed in blue and GIA's coral.
  const centre = new THREE.Group();
  centre.add(at(mesh(new THREE.CylinderGeometry(1.3, 1.36, 0.14, 128), m.composite), 0, 0.07, 0));
  centre.add(at(mesh(new THREE.CylinderGeometry(0.95, 1.0, 0.1, 128), m.white), 0, 0.19, 0));
  centre.add(at(lightRing(1.34, m.ledCoral, 0.02), 0, 0.12, 0));
  centre.add(at(lightRing(0.98, m.led, 0.016), 0, 0.235, 0));
  centre.add(at(lightRing(0.7, m.led, 0.01), 0, 0.245, 0));
  centre.add(at(lightRing(1.7, m.led, 0.01), 0, 0.006, 0));
  centre.add(at(lightRing(2.05, m.ledCoral, 0.008), 0, 0.006, 0));
  const glow = new THREE.PointLight('#9fd0ff', 5, 4, 1.4);
  glow.position.set(0, 1.2, 0.2);
  centre.add(glow);
  const warm = new THREE.PointLight('#ffb48a', 2.5, 3, 1.6);
  warm.position.set(0, 0.5, 1.2);
  centre.add(warm);
  centre.position.set(0, 0, 0.55);
  scene.add(centre);
  const data = render(scene, camera, width, height);
  return { data, gia: project(camera, 0, 1.25, 0.55) };
}

/**
 * MelonMotor: the office's engine room. A stack of glass cubes lit from inside rises from a
 * ringed base, circuits on the wall behind, plants either side.
 */
export function atrium(width = 806, height = 640) {
  const scene = sceneWith(new THREE.Color('#dfe8f5'));
  const w = CENTRE_W;
  const camera = roomCamera(w, CENTRE_ASPECT);
  shell(scene, w, { window: 'none', wall: m.wallTint });
  const wallPanel = mesh(
    new THREE.PlaneGeometry(w - 0.3, ROOM.h - 0.25),
    glowing(circuitTexture(9)),
    {
      cast: false,
    },
  );
  wallPanel.position.set(0, (ROOM.h - 0.25) / 2 + 0.05, BACK + 0.02);
  scene.add(wallPanel);
  for (const side of [-1, 1]) {
    const panel = mesh(
      new THREE.PlaneGeometry(ROOM.d - 0.4, ROOM.h - 0.4),
      glowing(circuitTexture(12 + side)),
      {
        cast: false,
      },
    );
    panel.rotation.y = -side * (Math.PI / 2);
    panel.position.set(side * (w / 2 - 0.02), ROOM.h / 2, 0);
    scene.add(panel);
  }
  const core = new THREE.Group();
  core.add(at(mesh(new THREE.CylinderGeometry(1.2, 1.26, 0.12, 128), m.composite), 0, 0.06, 0));
  core.add(at(lightRing(1.24, m.led, 0.02), 0, 0.12, 0));
  core.add(at(lightRing(0.95, m.ledCoral, 0.012), 0, 0.125, 0));
  const glassBlock = new THREE.MeshStandardMaterial({
    color: '#2a6fe0',
    roughness: 0.15,
    metalness: 0.1,
    transparent: true,
    opacity: 0.82,
    emissive: '#2f7dff',
    emissiveIntensity: 0.9,
  });
  const innerGlow = new THREE.MeshBasicMaterial({ color: '#9fd4ff', toneMapped: false });
  const edge = m.led;
  const cube = (s) => {
    const g = new THREE.Group();
    g.add(box(s, s, s, glassBlock, 0.02));
    g.add(box(s * 0.35, s * 0.35, s * 0.35, innerGlow, 0.01));
    const e = new THREE.EdgesGeometry(new THREE.BoxGeometry(s, s, s));
    g.add(
      new THREE.LineSegments(
        e,
        new THREE.LineBasicMaterial({ color: '#e6f4ff', toneMapped: false }),
      ),
    );
    return g;
  };
  const s = 0.42;
  const layers = [
    [3, 0],
    [2, 1],
    [1, 2],
  ];
  for (const [n, level] of layers) {
    for (let i = 0; i < n; i += 1) {
      for (let j = 0; j < n; j += 1) {
        const c = cube(s);
        c.position.set(
          (i - (n - 1) / 2) * (s + 0.02),
          0.12 + s / 2 + level * (s + 0.02),
          (j - (n - 1) / 2) * (s + 0.02),
        );
        core.add(c);
      }
    }
  }
  core.add(at(ledLine(0.02, edge), 0, 0, 0));
  const glow = new THREE.PointLight('#6fb4ff', 6, 5, 1.4);
  glow.position.y = 2.0;
  core.add(glow);
  core.position.set(0, 0, 0.5);
  scene.add(core);
  scene.add(at(plant(m, 'tall', 31, 1.25), -w / 2 + 0.45, 0, BACK + 0.5));
  scene.add(at(plant(m, 'tall', 33, 1.2), w / 2 - 0.45, 0, BACK + 0.5));
  scene.add(at(plant(m, 'bush', 35, 1.1), -w / 2 + 0.45, 0, 1.8));
  scene.add(at(plant(m, 'bush', 37, 1.1), w / 2 - 0.45, 0, 1.8));
  const data = render(scene, camera, width, height);
  return { data };
}

/** The lounge, for floors added below the first three: a sofa, shelves and plants. */
export function lounge(width = 806, height = 640) {
  const scene = sceneWith(new THREE.Color('#eef1f5'));
  const w = CENTRE_W;
  const camera = roomCamera(w, CENTRE_ASPECT);
  shell(scene, w, { window: 'right' });
  scene.add(at(bookshelf(m, 1.2, 2.1, 41), -1.2, 0, BACK + 0.2));
  scene.add(at(bookshelf(m, 1.2, 2.1, 42), 0.2, 0, BACK + 0.2));
  const s = sofa(m, m.fabric('#e4e7ec', 6), 2.2);
  s.position.set(0, 0, 0.2);
  scene.add(s);
  scene.add(at(coffeeTable(m, 0.45), 0, 0, 1.3));
  scene.add(at(mug(m), 0.1, 0.44, 1.3));
  scene.add(at(floorLamp(m), 1.6, 0, -0.4));
  scene.add(at(plant(m, 'bush', 44, 1.3), -1.8, 0, 1.8));
  const data = render(scene, camera, width, height);
  return { data };
}

/* ------------------------------------------------------------- workstations */

/*
 * A workstation is drawn in two layers so the Home can seat a person or not: the desk (its
 * monitor facing the room, the chair in front of it and the shadows), then the person, seen from
 * behind at the room's angle. The person's layer is cut where the chair's back hides them.
 *
 * Each layer is drawn in the Home's workstation box: 100 units wide from (-50, -80), 100 tall,
 * where the point of the floor under the middle of the workstation sits at (0, 0).
 */
export const DESK_BOX = { x: -50, y: -80, w: 100, h: 100 };
const UNIT = 1.9 / 100; // The box is 1.9 m wide.
/** The room camera's angle down at the desks. */
const PITCH = 27;

const MONITOR_HUES = ['#5aa9ff'];

function workstationScene(motif) {
  const scene = sceneWith(null);
  scene.environmentIntensity = 0.75;
  const catcher = mesh(new THREE.PlaneGeometry(6, 6), new THREE.ShadowMaterial({ opacity: 0.26 }), {
    cast: false,
  });
  catcher.rotation.x = -Math.PI / 2;
  scene.add(catcher);
  const station = new THREE.Group();
  // The desk, far side, with a drawer unit; the monitor faces whoever sits (and the camera).
  const top = desk(m, 1.4, 0.7);
  top.rotation.y = Math.PI;
  top.position.set(0, 0, -0.55);
  station.add(top);
  station.add(at(box(0.4, 0.6, 0.55, m.composite, 0.01), 0.45, 0.3, -0.55));
  const screen = new THREE.MeshBasicMaterial({
    map: wallDisplay(motif === 'map' ? 'map' : motif, 12),
    toneMapped: false,
  });
  const display = monitor(m, screen, 0.66, 0.38);
  display.position.set(-0.2, 0.7525, -0.72);
  station.add(display);
  station.add(
    at(
      laptop(m, new THREE.MeshBasicMaterial({ map: wallDisplay('finance', 3), toneMapped: false })),
      0.42,
      0.7525,
      -0.6,
      -0.35,
    ),
  );
  station.add(at(keyboard(m), -0.12, 0.76, -0.42));
  station.add(at(mug(m), -0.58, 0.7525, -0.45));
  station.add(at(plant(m, 'snake', 9, 0.3), 0.6, 0.7525, -0.78));
  const chair = officeChair(m, m.fabric('#2d3139', 8));
  chair.rotation.y = Math.PI;
  chair.position.set(0, 0, 0.12);
  station.add(chair);
  scene.add(station);
  const people = LOOKS.map((look) => {
    const p = person(look, { turn: 0.2 });
    p.rotation.y = Math.PI;
    p.position.set(0, 0, -0.02);
    p.visible = false;
    scene.add(p);
    return p;
  });
  const pitch = THREE.MathUtils.degToRad(PITCH);
  const camera = new THREE.OrthographicCamera(
    DESK_BOX.x * UNIT,
    (DESK_BOX.x + DESK_BOX.w) * UNIT,
    -DESK_BOX.y * UNIT,
    -(DESK_BOX.y + DESK_BOX.h) * UNIT,
    0.1,
    40,
  );
  // Looking at the middle of the workstation's floor, which lands at (0, 0) in the box.
  const anchor = new THREE.Vector3(0, 0, -0.25);
  camera.position.set(0, Math.sin(pitch) * 10, anchor.z + Math.cos(pitch) * 10);
  camera.lookAt(anchor);
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
    const p = new THREE.Vector3((sx * (0.66 - 0.024)) / 2, (sy * (0.38 - 0.024)) / 2, 0)
      .applyMatrix4(face.matrixWorld)
      .project(camera);
    return [
      +(DESK_BOX.x + ((p.x + 1) / 2) * DESK_BOX.w).toFixed(2),
      +(DESK_BOX.y + ((1 - p.y) / 2) * DESK_BOX.h).toFixed(2),
    ];
  });
  return { scene, camera, station, catcher, people, corners };
}

function ghost(object, hide) {
  object.traverse((o) => {
    if (o.isMesh) {
      o.userData.material ??= o.material;
      o.material = hide ? new THREE.MeshBasicMaterial({ colorWrite: false }) : o.userData.material;
    }
  });
}

/** The layers: `desk` (desk, monitor, chair, shadows) and `person-N` (cut by the chair). */
export function workstation(layer, motif = 'generic', width = 400, height = 400) {
  const { scene, camera, station, catcher, people, corners } = workstationScene(motif);
  const which = layer.startsWith('person-') ? Number(layer.slice(7)) : -1;
  people.forEach((p, i) => (p.visible = i === which));
  if (which >= 0) {
    catcher.visible = false;
    ghost(station, true);
  }
  return { data: render(scene, camera, width, height, which < 0), corners };
}

export { MONITOR_HUES };
