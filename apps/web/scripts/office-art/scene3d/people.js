/**
 * The office's people, seated at work (Home V4): natural proportions, simple smooth forms,
 * facing the room with their hands at the keyboard. Stylized on purpose, since the agents are
 * digital people, but never childlike: no big heads, no cartoon faces.
 */
import * as THREE from 'three';
import { at, mesh } from './furniture.js';

export const LOOKS = [
  { skin: '#e7bb98', hair: '#2b1a14', top: '#f1ece6', jacket: '#2f3b4c', style: 'short' },
  { skin: '#f1c9a8', hair: '#6b3f25', top: '#c9643f', jacket: null, style: 'long' },
  { skin: '#9c6647', hair: '#16100d', top: '#e9dcc9', jacket: '#7a5a44', style: 'bun' },
  { skin: '#f0cdb1', hair: '#a4683c', top: '#6f7f8f', jacket: null, style: 'short' },
  { skin: '#c28a64', hair: '#241712', top: '#e8b04a', jacket: null, style: 'curly' },
  { skin: '#7b4d33', hair: '#120d0b', top: '#f4efe9', jacket: '#3d4a3f', style: 'short' },
];

function material(color, roughness = 0.75) {
  return new THREE.MeshStandardMaterial({ color, roughness });
}

/** A limb from a to b: a capsule of the given radius. */
function limb(a, b, radius, mat) {
  const dir = new THREE.Vector3().subVectors(b, a);
  const length = dir.length();
  const m = mesh(new THREE.CapsuleGeometry(radius, Math.max(0.001, length), 6, 14), mat);
  m.position.copy(a).add(b).multiplyScalar(0.5);
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
  return m;
}

/** A seated person; `turn` turns the head towards a monitor on their right (+) or left (-). */
export function person(look, { turn = 0 } = {}) {
  const g = new THREE.Group();
  const skin = material(look.skin, 0.6);
  const hair = material(look.hair, 0.55);
  const top = material(look.top, 0.85);
  const jacket = look.jacket ? material(look.jacket, 0.8) : top;

  // Torso: a lathe from the waist to the shoulders, slightly flattened front to back.
  const profile = [
    [0.0, 0.5],
    [0.15, 0.5],
    [0.165, 0.62],
    [0.155, 0.78],
    [0.175, 0.94],
    [0.19, 1.0],
    [0.17, 1.045],
    [0.09, 1.07],
    [0.05, 1.075],
    [0.0, 1.075],
  ].map(([x, y]) => new THREE.Vector2(x, y));
  const torso = mesh(new THREE.LatheGeometry(profile, 32), jacket);
  torso.scale.set(1, 1, 0.62);
  g.add(torso);
  if (look.jacket) {
    // The shirt showing at the open collar.
    const shirt = mesh(new THREE.SphereGeometry(0.07, 20, 12), top);
    shirt.scale.set(1, 1.1, 0.35);
    shirt.position.set(0, 0.98, 0.075);
    g.add(shirt);
  }
  // Seat of the trousers under the torso.
  const hips = mesh(new THREE.SphereGeometry(0.17, 24, 12), material('#3b3a40', 0.85));
  hips.scale.set(1, 0.45, 0.8);
  hips.position.set(0, 0.52, 0);
  g.add(hips);

  // Neck and head (head height about 0.23 m: natural proportions).
  g.add(at(mesh(new THREE.CylinderGeometry(0.045, 0.05, 0.1, 16), skin), 0, 1.1, 0));
  const head = new THREE.Group();
  const skull = mesh(new THREE.SphereGeometry(0.1, 32, 24), skin);
  skull.scale.set(0.9, 1.12, 0.98);
  head.add(skull);
  // Jaw, a little narrower than the skull.
  const jaw = mesh(new THREE.SphereGeometry(0.08, 24, 16), skin);
  jaw.scale.set(0.95, 0.85, 1);
  jaw.position.set(0, -0.045, 0.018);
  head.add(jaw);
  const nose = mesh(new THREE.SphereGeometry(0.014, 12, 8), skin);
  nose.scale.set(0.9, 1.3, 1);
  nose.position.set(0, -0.005, 0.097);
  head.add(nose);
  for (const sx of [-1, 1]) {
    const ear = mesh(new THREE.SphereGeometry(0.018, 12, 8), skin);
    ear.scale.set(0.5, 1, 0.8);
    ear.position.set(sx * 0.09, 0, 0);
    head.add(ear);
    const brow = mesh(new THREE.CapsuleGeometry(0.0028, 0.02, 4, 8), hair);
    brow.rotation.z = Math.PI / 2 + sx * 0.12;
    brow.position.set(sx * 0.033, 0.03, 0.09);
    head.add(brow);
    const eye = mesh(new THREE.SphereGeometry(0.0065, 10, 8), material('#2a1d17', 0.3));
    eye.position.set(sx * 0.032, 0.012, 0.089);
    head.add(eye);
  }
  // Hair.
  const cap = mesh(
    new THREE.SphereGeometry(0.106, 32, 16, 0, Math.PI * 2, 0, Math.PI * 0.55),
    hair,
  );
  cap.scale.set(0.93, 1.1, 1.02);
  cap.position.set(0, 0.012, -0.008);
  cap.rotation.x = -0.35;
  head.add(cap);
  if (look.style === 'long') {
    const back = mesh(new THREE.CapsuleGeometry(0.085, 0.16, 8, 16), hair);
    back.scale.set(1.1, 1, 0.55);
    back.position.set(0, -0.08, -0.05);
    head.add(back);
  } else if (look.style === 'bun') {
    head.add(at(mesh(new THREE.SphereGeometry(0.045, 16, 12), hair), 0, 0.1, -0.06));
  } else if (look.style === 'curly') {
    for (let i = 0; i < 18; i += 1) {
      const a = (i / 18) * Math.PI * 2;
      const c = mesh(new THREE.SphereGeometry(0.032, 10, 8), hair);
      c.position.set(
        Math.cos(a) * 0.085,
        0.045 + Math.sin(i * 1.7) * 0.02,
        Math.sin(a) * 0.075 - 0.01,
      );
      if (c.position.z > 0.06) c.position.y += 0.03;
      head.add(c);
    }
  }
  head.position.set(0, 1.265, 0.01);
  head.rotation.y = turn;
  head.rotation.x = 0.12;
  g.add(head);

  // Arms: shoulder to elbow to the hand on the keyboard.
  for (const sx of [-1, 1]) {
    const shoulder = new THREE.Vector3(sx * 0.185, 1.0, 0);
    const elbow = new THREE.Vector3(sx * 0.215, 0.8, 0.14);
    const wrist = new THREE.Vector3(sx * 0.13, 0.77, 0.36);
    g.add(limb(shoulder, elbow, 0.048, jacket));
    g.add(limb(elbow, wrist, 0.04, jacket));
    const hand = mesh(new THREE.SphereGeometry(0.035, 16, 10), skin);
    hand.scale.set(0.8, 0.5, 1.2);
    hand.position.set(sx * 0.12, 0.765, 0.4);
    g.add(hand);
  }
  return g;
}
