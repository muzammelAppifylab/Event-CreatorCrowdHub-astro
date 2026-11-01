import {type KeyboardEvent, type ReactNode, useId, useRef, useState} from 'react';

import {Icon} from './icon';

type CollapsibleProps = {
  trigger: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
};

/** One button that shows or hides a region. */
export function Collapsible({trigger, children, defaultOpen = false, open: controlled, onOpenChange}: CollapsibleProps) {
  const [inner, setInner] = useState(defaultOpen);
  const open = controlled ?? inner;
  const id = useId();
  return (
    <div className="collapsible" data-state={open ? 'open' : 'closed'}>
      <button
        type="button"
        className="collapsible-trigger"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => {
          setInner(!open);
          onOpenChange?.(!open);
        }}>
        {trigger}
        <Icon name="chevron-down" size={16} className="disclosure-chevron" />
      </button>
      <div id={id} role="region" className="collapsible-content" hidden={!open}>
        {children}
      </div>
    </div>
  );
}

export type AccordionItem = {value: string; title: ReactNode; content: ReactNode};

/** A stack of headings that each open a region. `single` keeps one open at a time. Up/Down/Home/End move between triggers. */
export function Accordion({items, type = 'single', defaultValue = []}: {items: AccordionItem[]; type?: 'single' | 'multiple'; defaultValue?: string[]}) {
  const [openValues, setOpen] = useState<string[]>(defaultValue);
  const id = useId();
  const list = useRef<HTMLDivElement>(null);
  const toggle = (value: string) =>
    setOpen((cur) => (cur.includes(value) ? cur.filter((v) => v !== value) : type === 'single' ? [value] : [...cur, value]));
  const onKeyDown = (event: KeyboardEvent) => {
    const triggers = Array.from(list.current?.querySelectorAll<HTMLButtonElement>('.accordion-trigger') ?? []);
    const i = triggers.indexOf(document.activeElement as HTMLButtonElement);
    if (i < 0) return;
    const targets: Record<string, number> = {ArrowDown: (i + 1) % triggers.length, ArrowUp: (i - 1 + triggers.length) % triggers.length, Home: 0, End: triggers.length - 1};
    const next = targets[event.key];
    if (next === undefined) return;
    event.preventDefault();
    triggers[next].focus();
  };
  return (
    <div className="accordion" ref={list} onKeyDown={onKeyDown}>
      {items.map((item) => {
        const open = openValues.includes(item.value);
        return (
          <div className="accordion-item" key={item.value} data-state={open ? 'open' : 'closed'}>
            <h3>
              <button
                type="button"
                className="accordion-trigger"
                id={`${id}-${item.value}-t`}
                aria-expanded={open}
                aria-controls={`${id}-${item.value}-c`}
                onClick={() => toggle(item.value)}>
                {item.title}
                <Icon name="chevron-down" size={16} className="disclosure-chevron" />
              </button>
            </h3>
            <div id={`${id}-${item.value}-c`} role="region" aria-labelledby={`${id}-${item.value}-t`} className="accordion-content" hidden={!open}>
              {item.content}
            </div>
          </div>
        );
      })}
    </div>
  );
}
