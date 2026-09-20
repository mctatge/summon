import type { Group, Mesh, MeshStandardMaterial, Object3D, Vector3 } from 'three';

/** Procedural rig. The host owns placement and the observed session state. */
export interface Chef {
  id: string;
  root: Group;
  body: Group;
  head: Group;
  hat: Group;
  arms: Group[];
  legs: Group[];
  ring: Mesh<import('three').BufferGeometry, MeshStandardMaterial>;
  carried: Group;
  utensil: Group;
  spoon: Group;
  attention: Group;
  color: number;
  state: string;
  target: Vector3;
  facing: number;
  phase: number;
  selected: boolean;
  carryType: string;
  route: Vector3[];
  home: unknown;
  pose?: string;
  atWorktop?: boolean;
  carrying?: boolean;
  related?: boolean;
}

export const apronColors: number[];
export function hash(value: string): number;
/** Use a stable, nonnegative index to retain the same chef appearance. */
export function createChef(parent: Object3D, id: string, index?: number): Chef;
/** time and dt are seconds. Pause freezes joints; reduced motion snaps to target. */
export function animateChef(chef: Chef, time: number, dt: number, reduced?: boolean, paused?: boolean): void;
/** Creates new meshes; hosts that clone shared resources must clone these too. */
export function setCarriedType(chef: Chef, type: string): void;
