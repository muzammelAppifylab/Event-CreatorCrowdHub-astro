import {IconButton} from '../ui';

/** Reorder a ordered item up or down; `what` names it for screen readers ("ticket Early bird"). */
export function MoveButtons({what, index, count, pending, disabled, onMove}: {what: string; index: number; count: number; pending?: boolean; disabled?: boolean; onMove: (to: number) => void}) {
  return (
    <span className="toolbar">
      <IconButton icon="chevron-up" label={`Move ${what} up`} size="sm" disabled={disabled || pending || index <= 0} onClick={() => onMove(index - 1)} />
      <IconButton icon="chevron-down" label={`Move ${what} down`} size="sm" pending={pending} disabled={disabled || index >= count - 1} onClick={() => onMove(index + 1)} />
    </span>
  );
}

/** A copy of `list` with the item at `from` moved to `to`. */
export function moved<T>(list: readonly T[], from: number, to: number): T[] {
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item as T);
  return next;
}
