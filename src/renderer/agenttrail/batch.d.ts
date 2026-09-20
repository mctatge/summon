import type { Object3D } from 'three';

/** Merge static mesh parts, preserving the independently animated rig groups. */
export function batchMeshes(root: Object3D, recursive?: boolean): void;
/** Disposes generated batch geometry only, not shared materials or textures. */
export function disposeBatches(root: Object3D): void;
