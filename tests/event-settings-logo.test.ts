import {Hono} from 'hono';
import {beforeEach, describe, expect, it, vi} from 'vitest';

import {LOGO_MAX_BYTES, logoPath, parseLogoUpload} from '../src/lib/event-brand';

const state = vi.hoisted(() => ({db: {} as Record<string, unknown>}));
const files = vi.hoisted(() => ({
  createUpload: vi.fn(),
  completeUpload: vi.fn(),
  deleteFile: vi.fn(async () => ({ok: true})),
}));

vi.mock('../src/platform/guards', async () => {
  const actual = await vi.importActual<typeof import('../src/platform/guards')>('../src/platform/guards');
  const pass = async (_c: unknown, next: () => Promise<void>) => next();
  return {
    ...actual,
    withViewer: async (c: {set: (k: string, v: unknown) => void}, next: () => Promise<void>) => {
      c.set('viewer', {state: 'user', id: 7});
      await next();
    },
    requireAuth: pass,
    requirePermission: () => pass,
    withDb: async (c: {set: (k: string, v: unknown) => void}, next: () => Promise<void>) => {
      c.set('db', state.db);
      await next();
    },
  };
});
vi.mock('../src/platform/auth', () => ({audit: vi.fn(async () => undefined)}));
vi.mock('../src/platform/files', () => files);

import {eventSettingsRoutes} from '../src/server/routes/event-settings';

const app = new Hono().route('/event-settings', eventSettingsRoutes);
const post = (path: string, body: unknown) =>
  app.request(`/event-settings${path}`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body)});
const ID = `file_${'a'.repeat(26)}`;
const OLD = `file_${'b'.repeat(26)}`;

beforeEach(() => vi.clearAllMocks());

describe('parseLogoUpload', () => {
  it('accepts a small raster image', () => {
    expect(parseLogoUpload({name: ' logo.png ', contentType: 'image/png', size: 1000})).toEqual({ok: true, value: {name: 'logo.png', contentType: 'image/png', size: 1000}});
  });
  it('refuses other types, empty and oversized files', () => {
    for (const bad of [
      {name: 'a.svg', contentType: 'image/svg+xml', size: 10},
      {name: 'a.pdf', contentType: 'application/pdf', size: 10},
      {name: 'a.png', contentType: 'image/png', size: 0},
      {name: 'a.png', contentType: 'image/png', size: LOGO_MAX_BYTES + 1},
      {name: '', contentType: 'image/png', size: 10},
      null,
    ]) expect(parseLogoUpload(bad).ok).toBe(false);
  });
  it('builds the public path', () => {
    expect(logoPath({id: ID, name: 'my logo.png'})).toBe(`/__platform/files/${ID}/my%20logo.png`);
    expect(logoPath(null)).toBeNull();
  });
});

describe('POST /event-settings/logo', () => {
  it('422s a bad type before asking storage', async () => {
    const res = await post('/logo', {name: 'a.exe', contentType: 'application/zip', size: 10});
    expect(res.status).toBe(422);
    expect(files.createUpload).not.toHaveBeenCalled();
  });
  it('asks for a PUBLIC upload for a valid image and keeps the issued id as the pending logo', async () => {
    files.createUpload.mockResolvedValue({ok: true, data: {file: {id: ID}, upload: {url: '/u'}}});
    const upsert = vi.fn(async () => ({id: 1}));
    state.db = {eventSettings: {upsert}};
    const res = await post('/logo', {name: 'a.png', contentType: 'image/png', size: 500});
    expect(res.status).toBe(201);
    expect(files.createUpload.mock.calls[0]![1]).toMatchObject({visibility: 'public', contentType: 'image/png'});
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({update: {pendingLogoFileId: ID}}));
  });
});

describe('POST /event-settings/logo/complete', () => {
  it('422s a malformed file id', async () => {
    expect((await post('/logo/complete', {fileId: '../x'})).status).toBe(422);
    expect(files.completeUpload).not.toHaveBeenCalled();
  });
  it('never confirms, adopts or deletes a file id this route did not issue', async () => {
    const updateMany = vi.fn();
    state.db = {eventSettings: {findFirst: vi.fn(async () => null), updateMany}};
    const res = await post('/logo/complete', {fileId: ID});
    expect(res.status).toBe(422);
    expect(files.completeUpload).not.toHaveBeenCalled();
    expect(files.deleteFile).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
  });
  it('removes the ISSUED file when it is not a public image and keeps the old logo', async () => {
    files.completeUpload.mockResolvedValue({ok: true, data: {id: ID, name: 'a.pdf', contentType: 'application/pdf', size: 5, visibility: 'public'}});
    const updateMany = vi.fn(async () => ({count: 1}));
    state.db = {eventSettings: {findFirst: vi.fn(async () => ({logoFileId: OLD})), updateMany}};
    const res = await post('/logo/complete', {fileId: ID});
    expect(res.status).toBe(422);
    expect(updateMany).toHaveBeenCalledWith({where: {id: 1, pendingLogoFileId: ID}, data: {pendingLogoFileId: null}});
    expect(files.deleteFile).toHaveBeenCalledTimes(1);
    expect(files.deleteFile.mock.calls[0]).toEqual([expect.anything(), ID]);
  });
  it('adopts the issued file and deletes only the previous logo stored in the row', async () => {
    files.completeUpload.mockResolvedValue({ok: true, data: {id: ID, name: 'logo.png', contentType: 'image/png', size: 500, visibility: 'public'}});
    const updateMany = vi.fn(async () => ({count: 1}));
    const findUnique = vi.fn(async () => null);
    state.db = {eventSettings: {findFirst: vi.fn(async () => ({logoFileId: OLD})), updateMany, findUnique}};
    const res = await post('/logo/complete', {fileId: ID});
    expect(res.status).toBe(200);
    expect(updateMany).toHaveBeenCalledWith({where: {id: 1, pendingLogoFileId: ID}, data: {logoFileId: ID, logoName: 'logo.png', pendingLogoFileId: null}});
    expect(files.deleteFile).toHaveBeenCalledTimes(1);
    expect(files.deleteFile.mock.calls[0]).toEqual([expect.anything(), OLD]);
  });
});
