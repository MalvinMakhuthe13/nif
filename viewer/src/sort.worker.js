/**
 * NIF Sort Worker
 * © Fumoca Technologies · fumoca.co.za
 *
 * Runs in a Web Worker — completely off the main thread.
 * Receives SharedArrayBuffer views for depth and index arrays.
 * Sorts indices by depth (back-to-front) and signals completion.
 *
 * Protocol:
 *   Main → Worker:  { type:'sort', depths: Float32Array, indices: Uint32Array, count: number }
 *   Worker → Main:  { type:'done', indices: Uint32Array }
 *
 * The indices array is transferred (zero-copy) both ways via Transferable.
 * depths is sent as a regular copy (it's written by the main thread every frame
 * and doesn't need to persist).
 *
 * If SharedArrayBuffer is available (COOP/COEP headers set), it can be used
 * instead — the worker reads depths in place without a copy.
 */

self.onmessage = ({ data }) => {
  if (data.type !== 'sort') return;

  const { depths, count } = data;
  const indices = data.indices;

  // Sort indices back-to-front (largest depth = furthest = first to draw)
  // TypedArray.sort with a comparator — native code path, fastest available
  indices.sort((a, b) => depths[a] - depths[b]);

  // Transfer indices back — zero-copy, no heap allocation
  self.postMessage({ type: 'done', indices }, [indices.buffer]);
};
