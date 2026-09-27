import { Firestore } from '@google-cloud/firestore';
import { randomUUID } from 'node:crypto';

/**
 * Firestore tests run against the local emulator (FIRESTORE_EMULATOR_HOST). CI always starts it
 * and sets REQUIRE_FIRESTORE_EMULATOR, so there they can never be silently skipped.
 */
export const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST;
export const emulatorRequired = process.env.REQUIRE_FIRESTORE_EMULATOR === '1';

/** A client for a fresh, empty emulator project, so tests never see each other's data. */
export function emulatorFirestore(): Firestore {
  if (emulatorHost === undefined) throw new Error('FIRESTORE_EMULATOR_HOST is not set');
  return new Firestore({ projectId: `demo-${randomUUID().slice(0, 8)}` });
}
