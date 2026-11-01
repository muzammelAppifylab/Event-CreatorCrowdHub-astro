import {useId, useMemo, useRef, useState} from 'react';

import {Icon} from './icon';

export type CommandItem = {value: string; label: string; hint?: string; group?: string; disabled?: boolean};

type CommandProps = {
  items: CommandItem[];
  onSelect: (item: CommandItem) => void;
  placeholder?: string;
  emptyText?: string;
  label?: string;
};

/** A searchable list (command palette / combobox). Type to filter, Up/Down to move, Enter to choose. */
export function Command({items, onSelect, placeholder = 'Type to search…', emptyText = 'No results found.', label = 'Commands'}: CommandProps) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const id = useId();
  const list = useRef<HTMLDivElement>(null);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items.filter((i) => !q || `${i.label} ${i.group ?? ''}`.toLowerCase().includes(q));
  }, [items, query]);
  const enabled = filtered.filter((i) => !i.disabled);
  const index = Math.max(0, Math.min(active, enabled.length - 1));
  const current: CommandItem | undefined = enabled[index];
  const groups = Array.from(new Set(filtered.map((i) => i.group ?? '')));
  const optionId = (item: CommandItem) => `${id}-${item.value}`;

  const activate = (next: number) => {
    setActive(next);
    const item = enabled[next];
    const options: ScrollIntoViewOptions = {block: 'nearest'};
    if (item) document.getElementById(optionId(item))?.scrollIntoView?.(options);
  };
  const move = (delta: number) => {
    if (enabled.length) activate((index + delta + enabled.length) % enabled.length);
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      move(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      move(-1);
    } else if (e.key === 'Home') {
      e.preventDefault();
      activate(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      activate(Math.max(0, enabled.length - 1));
    } else if (e.key === 'Enter' && current) {
      e.preventDefault();
      onSelect(current);
    }
  };

  return (
    <div className="command">
      <div className="command-input">
        <Icon name="search" size={16} />
        <input
          type="text"
          role="combobox"
          aria-expanded="true"
          aria-controls={`${id}-list`}
          aria-activedescendant={current ? optionId(current) : undefined}
          aria-autocomplete="list"
          aria-label={label}
          placeholder={placeholder}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
        />
      </div>
      <div className="command-list" id={`${id}-list`} role="listbox" aria-label={label} ref={list}>
        {filtered.length === 0 && <p className="command-empty" role="status">{emptyText}</p>}
        {groups.map((group) => (
          <div key={group} role="group" aria-label={group || undefined}>
            {group && <div className="command-group" aria-hidden="true">{group}</div>}
            {filtered
              .filter((i) => (i.group ?? '') === group)
              .map((item) => (
                <div
                  key={item.value}
                  id={optionId(item)}
                  role="option"
                  aria-selected={item === current}
                  aria-disabled={item.disabled || undefined}
                  data-active={item === current}
                  className="command-item"
                  onMouseMove={() => !item.disabled && setActive(enabled.indexOf(item))}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => !item.disabled && onSelect(item)}>
                  <span>{item.label}</span>
                  {item.hint && <kbd className="command-hint">{item.hint}</kbd>}
                </div>
              ))}
          </div>
        ))}
      </div>
    </div>
  );
}
