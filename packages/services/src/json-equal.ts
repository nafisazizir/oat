/**
 * Structural equality for JSON values, ignoring object key order (Postgres `jsonb` doesn't keep it, so
 * a document read back from the server can list attributes in another order than the editor emitted).
 */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const other = b as unknown[];
    return a.length === other.length && a.every((value, i) => jsonEqual(value, other[i]));
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left).filter((key) => left[key] !== undefined);
  const otherKeys = Object.keys(right).filter((key) => right[key] !== undefined);
  return (
    keys.length === otherKeys.length &&
    keys.every((key) => Object.hasOwn(right, key) && jsonEqual(left[key], right[key]))
  );
}

type Fields = { title?: string; contentJson?: unknown };

/**
 * Whether a patch made on top of `base` can be re-sent on top of the newer `server` copy without losing
 * anyone's work: every field the patch writes is still what it was at `base` on the server (someone
 * else changed only other fields, e.g. a rename from the sidebar while the body was being edited).
 */
export function canRebase(
  patch: Fields,
  base: Required<Fields>,
  server: Required<Fields>,
): boolean {
  if (patch.title !== undefined && server.title !== base.title) return false;
  if (patch.contentJson !== undefined && !jsonEqual(server.contentJson, base.contentJson)) {
    return false;
  }
  return true;
}
