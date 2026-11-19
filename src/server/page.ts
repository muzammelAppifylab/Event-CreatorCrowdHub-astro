import {type Abilities, NO_ABILITIES, type Site, type Viewer} from '../lib/types';
import {GUEST} from '../platform/auth';
import {backend, read} from './backend';

/**
 * What every on-demand page needs, from the Site API in-process: the site's
 * brand, the visitor and what the UI may show them. Call it first in a page's
 * frontmatter:
 *
 *   const {api, site, viewer, abilities} = await pageContext(Astro.request, Astro.response);
 *
 * `api` is the in-process Site API client for the page's own reads. The page
 * now depends on the visitor's cookies, so it is marked private: no shared
 * cache may keep one visitor's page and serve it to another.
 */
export async function pageContext(request: Request, response: {headers: Headers}) {
  const api = backend(request);
  const [brand, me] = await Promise.all([
    read<{site: Site | null}>(api.site.$get()),
    read<{viewer: Viewer; roles: string[]; abilities: Abilities}>(api.me.$get()),
  ]);
  response.headers.set('Cache-Control', 'private, no-store');
  return {
    api,
    site: brand?.site ?? null,
    viewer: me?.viewer ?? GUEST,
    abilities: me?.abilities ?? NO_ABILITIES,
  };
}

/**
 * What a PRERENDERED page needs (`export const prerender = true`): the brand
 * only, read once at BUILD time. There is no visitor at build time: the page
 * renders signed out and passes `isStatic` to `<Base>`, which fills the
 * visitor in, in the browser.
 *
 *   export const prerender = true;
 *   const {site, viewer} = await staticContext(Astro.request);
 */
export async function staticContext(request: Request) {
  const api = backend(request);
  const brand = await read<{site: Site | null}>(api.site.$get());
  return {api, site: brand?.site ?? null, viewer: GUEST};
}

/** How long a browser may keep a public on-demand page (`publicPageContext`): short, so an edit shows within a minute. */
export const PUBLIC_PAGE_MAX_AGE = 60;

/**
 * For an ON-DEMAND page that is the same for every visitor (a public event page, audit M-29): the
 * brand only, no visitor read, and a short PUBLIC cache. The page renders signed out and passes
 * `isStatic` to `<Base>`, which fills the visitor in, in the browser, exactly like a prerendered page;
 * anything about this visitor (their RSVP, host tools) must load in the browser too. Never use it on
 * a page that reads cookies, `pageContext`, `withViewer` or anything per visitor: it would be shared.
 *
 *   const {api, site, viewer} = await publicPageContext(Astro.request, Astro.response);
 */
export async function publicPageContext(request: Request, response: {headers: Headers}, maxAge = PUBLIC_PAGE_MAX_AGE) {
  const context = await staticContext(request);
  response.headers.set('Cache-Control', `public, max-age=${Math.max(0, Math.floor(maxAge))}`);
  return context;
}
