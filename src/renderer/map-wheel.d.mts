export type WheelInput = { deltaX: number; deltaY: number; deltaMode: number; ctrlKey: boolean };
export type MapSize = { width: number; height: number };
export function wheelPixels(event: WheelInput, size: MapSize): { x: number; y: number };
export function applyMapWheel(view: { x: number; y: number; zoom: number }, event: WheelInput, size: MapSize, point: { x: number; y: number }): { x: number; y: number; zoom: number };
