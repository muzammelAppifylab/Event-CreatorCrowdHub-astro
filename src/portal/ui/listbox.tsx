import {type ReactNode, useEffect, useId, useRef, useState} from 'react';

import {Icon} from './icon';

export type ListboxOption = {value: string; label: string; description?: string; meta?: ReactNode; disabled?: boolean};

type ListboxProps = {
  id: string;
  value: string;
  onChange: (value: string) => void;
  options: ListboxOption[];
  placeholder?: string;
  disabled?: boolean;
  invalid?: boolean;
  'aria-describedby'?: string;
};

/**
 * A custom dropdown (the shadcn Select): a button showing the choice, a floating listbox with a check on the
 * selected row, an optional description and a meta badge per option. Up/Down/Home/End move, Enter or Space picks,
 * Esc closes and returns focus, typing a letter jumps to a match. Use it where an option needs a line of
 * explanation; a plain long list stays `Select`.
 */
export function Listbox({id, value, onChange, options, placeholder = 'Select…', disabled, invalid, 'aria-describedby': describedBy}: ListboxProps) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const listId = useId();
  const selected = options.find(o => o.value === value);
  const optionId = (index: number) => `${listId}-${index}`;

  const openList = () => {
    setActive(Math.max(0, options.findIndex(o => o.value === value)));
    setOpen(true);
  };
  const close = () => {
    setOpen(false);
    button.current?.focus();
  };
  const pick = (option: ListboxOption) => {
    if (option.disabled) return;
    onChange(option.value);
    close();
  };
  const move = (from: number, step: number) => {
    for (let i = 1; i <= options.length; i++) {
      const next = (from + step * i + options.length * i) % options.length;
      if (!options[next]?.disabled) return next;
    }
    return from;
  };

  useEffect(() => {
    if (!open) return;
    const down = (event: MouseEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', down);
    return () => document.removeEventListener('mousedown', down);
  }, [open]);
  useEffect(() => {
    if (open) document.getElementById(optionId(active))?.scrollIntoView?.({block: 'nearest'});
  });

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (!open) {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) {
        event.preventDefault();
        openList();
      }
      return;
    }
    if (event.key === 'ArrowDown') setActive(move(active, 1));
    else if (event.key === 'ArrowUp') setActive(move(active, -1));
    else if (event.key === 'Home') setActive(move(-1, 1));
    else if (event.key === 'End') setActive(move(options.length, -1));
    else if (event.key === 'Enter' || event.key === ' ') {
      const option = options[active];
      if (option) pick(option);
    } else if (event.key === 'Escape') close();
    else if (event.key === 'Tab') setOpen(false);
    else if (event.key.length === 1) {
      const typed = options.findIndex(o => !o.disabled && o.label.toLowerCase().startsWith(event.key.toLowerCase()));
      if (typed >= 0) setActive(typed);
      return;
    } else return;
    event.preventDefault();
  };

  return (
    <div className="listbox" ref={root}>
      <button
        ref={button}
        id={id}
        type="button"
        className="listbox-trigger"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-activedescendant={open ? optionId(active) : undefined}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        disabled={disabled}
        onClick={() => (open ? close() : openList())}
        onKeyDown={onKeyDown}>
        <span className="listbox-value" data-placeholder={selected ? undefined : ''}>
          {selected?.label ?? placeholder}
        </span>
        {selected?.meta}
        <Icon name="chevrons-up-down" size={16} className="listbox-chevron" />
      </button>
      {open && (
        <div id={listId} role="listbox" className="listbox-panel">
          {options.map((option, index) => (
            <div
              key={option.value}
              id={optionId(index)}
              role="option"
              aria-selected={option.value === value}
              aria-disabled={option.disabled || undefined}
              data-active={index === active}
              className="listbox-option"
              onMouseMove={() => !option.disabled && setActive(index)}
              onMouseDown={event => event.preventDefault()}
              onClick={() => pick(option)}>
              <span className="listbox-option-text">
                <span className="listbox-option-label">{option.label}</span>
                {option.description && <span className="listbox-option-desc">{option.description}</span>}
              </span>
              {option.meta}
              <Icon name="check" size={16} className="listbox-check" />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
