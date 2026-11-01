import {type ReactNode, useEffect, useId, useRef, useState} from 'react';

type PopoverProps = {
  /** The trigger's content; rendered inside a button. */
  trigger: ReactNode;
  children: ReactNode | ((close: () => void) => ReactNode);
  align?: 'start' | 'center' | 'end';
  triggerClassName?: string;
  triggerLabel?: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
};

/** A floating panel opened by a button. Click outside or Esc closes it and returns focus to the button. */
export function Popover({trigger, children, align = 'center', triggerClassName = 'button button-outline button-md', triggerLabel, open: controlled, onOpenChange}: PopoverProps) {
  const [inner, setInner] = useState(false);
  const open = controlled ?? inner;
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const set = (value: boolean) => {
    setInner(value);
    onOpenChange?.(value);
  };
  useEffect(() => {
    if (!open) return;
    const down = (event: MouseEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) set(false);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        set(false);
        button.current?.focus();
      }
    };
    document.addEventListener('mousedown', down);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('mousedown', down);
      document.removeEventListener('keydown', key);
    };
  });
  const close = () => {
    set(false);
    button.current?.focus();
  };
  return (
    <div className="popover" ref={root}>
      <button
        ref={button}
        type="button"
        className={triggerClassName}
        aria-expanded={open}
        aria-controls={id}
        aria-haspopup="dialog"
        aria-label={triggerLabel}
        onClick={() => set(!open)}>
        {trigger}
      </button>
      {open && (
        <div id={id} role="dialog" className={`popover-panel popover-${align}`}>
          {typeof children === 'function' ? children(close) : children}
        </div>
      )}
    </div>
  );
}
