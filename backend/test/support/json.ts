/** Navigation of JSON answers in assertions; a missing step gives undefined. */
function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null;
}

export function at(value: unknown, ...path: (string | number)[]): unknown {
  let current = value;
  for (const key of path) {
    if (!isRecord(current)) return undefined;
    current = current[String(key)];
  }
  return current;
}

export function text(value: unknown, ...path: (string | number)[]): string {
  const found = at(value, ...path);
  if (typeof found !== 'string') throw new Error(`Expected text at ${path.join('.')}, found ${JSON.stringify(found)}`);
  return found;
}

export function items(value: unknown, ...path: (string | number)[]): unknown[] {
  const found = at(value, ...path);
  if (!Array.isArray(found)) throw new Error(`Expected an array at ${path.join('.')}, found ${JSON.stringify(found)}`);
  return found;
}

/** Every value of `field` in the tree, at any depth. */
export function findValues(value: unknown, field: string): unknown[] {
  if (Array.isArray(value)) return value.flatMap((item: unknown) => findValues(item, field));
  if (!isRecord(value)) return [];
  return Object.entries(value).flatMap(([key, item]) => (key === field ? [item] : findValues(item, field)));
}

/** A copy of an object without one field. */
export function without(value: unknown, field: string): unknown {
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== field));
}
