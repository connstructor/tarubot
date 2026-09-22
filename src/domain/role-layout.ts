/** Managed role presentation policy, independent of Discord I/O and membership eligibility. */
import { Failure } from "./values.js";

/** Highest first; partial configurations retain the relative order of the roles that exist. */
export function managedRoleOrder(bindings: {
  leader_role_id: string | null;
  officer_role_id: string | null;
  member_role_id: string | null;
  guest_role_id: string | null;
}): string[] {
  return [
    bindings.leader_role_id,
    bindings.officer_role_id,
    bindings.member_role_id,
    bindings.guest_role_id,
  ].filter((value): value is string => value !== null);
}

/** Pack one consecutive block at the lowest managed slot, preserving unrelated role order. */
export function rolePositionChanges(
  ascendingIds: readonly string[],
  priority: readonly string[],
): { role: string; position: number }[] {
  const managed = new Set(priority);
  if (managed.size !== priority.length)
    throw new Failure(
      "blocked",
      "Managed roles must be distinct before arranging their hierarchy.",
    );
  const slots = ascendingIds.flatMap((id, position) => (managed.has(id) ? [{ id, position }] : []));
  if (slots.length !== priority.length)
    throw new Failure(
      "blocked",
      "A managed role is missing; run /setup or repair its configuration.",
    );
  const first = slots[0]?.position;
  if (first === undefined) return [];
  if (first === 0) throw new Failure("blocked", "The everyone role cannot be managed.");
  const unrelated = ascendingIds.filter((id) => !managed.has(id));
  const wanted = [
    ...unrelated.slice(0, first),
    ...[...priority].reverse(),
    ...unrelated.slice(first),
  ];
  if (wanted.every((id, index) => ascendingIds[index] === id)) return [];
  // Discord's bulk endpoint needs the full final order; sparse moves can interleave other roles.
  return wanted.map((role, position) => ({ role, position }));
}
