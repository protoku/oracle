import { isObject } from './json.js';
import type { Json } from './types.js';

// Dotted path over plain JSON. A missing segment, or a step through a scalar
// or null, yields null. Numeric segments index arrays.
export function getPath(root: Json | undefined, path: string): Json {
  if (root === undefined) return null;
  if (path === '') return root;
  let current: Json = root;
  for (const segment of path.split('.')) {
    if (Array.isArray(current)) {
      if (!/^\d+$/.test(segment)) return null;
      const next: Json | undefined = current[Number(segment)];
      if (next === undefined) return null;
      current = next;
    } else if (isObject(current)) {
      const next: Json | undefined = current[segment];
      if (next === undefined) return null;
      current = next;
    } else {
      return null;
    }
  }
  return current;
}
