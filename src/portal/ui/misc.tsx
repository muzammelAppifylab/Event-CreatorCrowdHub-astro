import type {ReactNode} from 'react';

import {Icon} from './icon';

/** A 1px rule. Decorative by default; pass `decorative={false}` to expose it to assistive tech. */
export function Separator({orientation = 'horizontal', decorative = true}: {orientation?: 'horizontal' | 'vertical'; decorative?: boolean}) {
  return (
    <div
      className={`separator separator-${orientation}`}
      role={decorative ? 'none' : 'separator'}
      aria-orientation={decorative ? undefined : orientation}
    />
  );
}

const RATIOS = {'1/1': '1-1', '4/3': '4-3', '16/9': '16-9', '3/2': '3-2', '21/9': '21-9'} as const;

/** Keeps its child at a fixed width : height ratio. */
export function AspectRatio({ratio = '16/9', children}: {ratio?: keyof typeof RATIOS; children: ReactNode}) {
  return <div className={`aspect aspect-${RATIOS[ratio]}`}>{children}</div>;
}

/** Page links for a long list. Pages are 1-based; ellipses collapse the middle. */
export function Pagination({page, pageCount, onPageChange, label = 'Pagination'}: {page: number; pageCount: number; onPageChange: (page: number) => void; label?: string}) {
  const pages: (number | 'gap-start' | 'gap-end')[] = [];
  for (let p = 1; p <= pageCount; p++) {
    if (p === 1 || p === pageCount || Math.abs(p - page) <= 1) pages.push(p);
    else if (p < page && pages[pages.length - 1] !== 'gap-start') pages.push('gap-start');
    else if (p > page && pages[pages.length - 1] !== 'gap-end') pages.push('gap-end');
  }
  return (
    <nav className="pagination" aria-label={label}>
      <ul>
        <li>
          <button type="button" className="pagination-link" disabled={page <= 1} onClick={() => onPageChange(page - 1)}>
            <Icon name="arrow-left" size={16} /> Previous
          </button>
        </li>
        {pages.map((p) =>
          typeof p === 'string' ? (
            <li key={p} aria-hidden="true" className="pagination-gap">…</li>
          ) : (
            <li key={p}>
              <button type="button" className={`pagination-link${p === page ? ' is-active' : ''}`} aria-current={p === page ? 'page' : undefined} aria-label={`Page ${p}`} onClick={() => onPageChange(p)}>
                {p}
              </button>
            </li>
          ),
        )}
        <li>
          <button type="button" className="pagination-link" disabled={page >= pageCount} onClick={() => onPageChange(page + 1)}>
            Next <Icon name="arrow-right" size={16} />
          </button>
        </li>
      </ul>
    </nav>
  );
}
