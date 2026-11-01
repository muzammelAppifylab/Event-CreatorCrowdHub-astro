import {Hono} from 'hono';
import {validator} from 'hono/validator';

import {Prisma} from '../../generated/prisma/client';
import type {PrismaClient} from '../../generated/prisma/client';
import {
  Collector,
  DEFAULT_EVENT_SETTINGS,
  type EventSettingsDto,
  type FontPreset,
  type PosterDesign,
  parseReminderRules,
  parseSettingsPatch,
} from '../../lib/event-schemas';
import {STARTER_REMINDER_RULES} from '../../domain/reminders';
import {audit} from '../../platform/auth';
import {listPrices} from '../../platform/payments';
import {completeUpload, createUpload, deleteFile} from '../../platform/files';
import {LOGO_FILE_ID, LOGO_MAX_BYTES, LOGO_RULE, LOGO_TYPES, logoPath, parseLogoUpload} from '../../lib/event-brand';
import {problem, requireAuth, requirePermission, withDb, withViewer} from '../../platform/guards';
import {siteBase} from '../jobs/shared';
import {shapePaymentsStatus} from '../payments-status';
import {PERMISSIONS} from '../permissions';

/**
 * Event settings: ONE row (`event_settings`, id 1), created on first save.
 * Branding, the defaults new events inherit, and the default email rules.
 *
 *   GET   /site-api/event-settings        `site:event:manage`: the whole row (or defaults when never saved)
 *   PATCH /site-api/event-settings        `site:event:manage`: only the keys sent change
 *   GET   /site-api/event-settings/payments `site:event:manage`: read-only checkout status (mode, paid tickets, catalogue prices)
 *   GET   /site-api/event-settings/brand  public: colour, font and logo link (they already style the public pages)
 *   POST  /site-api/event-settings/logo           `site:event:manage`: step 1, a public upload URL for an image (type + size checked)
 *   POST  /site-api/event-settings/logo/complete  `site:event:manage`: step 3, keeps the file as the logo, removes the old one
 *   DELETE /site-api/event-settings/logo          `site:event:manage`: back to the site logo
 */

const select = {
  brandColor: true,
  fontPreset: true,
  defaultTimezone: true,
  senderName: true,
  replyToEmail: true,
  defaultReminderRules: true,
  allowMaybeDefault: true,
  showGuestListDefault: true,
  defaultCoverPoster: true,
  logoFileId: true,
  logoName: true,
  updatedAt: true,
} as const;

type Row = Prisma.EventSettingsGetPayload<{select: typeof select}>;

function toDto(row: Row | null): EventSettingsDto {
  if (!row) return {...DEFAULT_EVENT_SETTINGS, defaultReminderRules: STARTER_REMINDER_RULES.map(r => ({...r})), logoUrl: null, updatedAt: null};
  return {
    brandColor: row.brandColor,
    fontPreset: row.fontPreset as FontPreset,
    defaultTimezone: row.defaultTimezone,
    senderName: row.senderName,
    replyToEmail: row.replyToEmail,
    // A hand-edited row never breaks the screen: rules that fail today's checks are left out.
    defaultReminderRules: ((rules) => (rules.length ? rules : STARTER_REMINDER_RULES.map(r => ({...r}))))(parseReminderRules(new Collector(), row.defaultReminderRules, 'rules') ?? []),
    allowMaybeDefault: row.allowMaybeDefault,
    showGuestListDefault: row.showGuestListDefault,
    defaultCoverPoster: row.defaultCoverPoster as PosterDesign | null,
    logoUrl: logoPath(row.logoFileId && row.logoName ? {id: row.logoFileId, name: row.logoName} : null),
    updatedAt: row.updatedAt.toISOString(),
  };
}

const LOGO_RULE_MESSAGE = LOGO_RULE;

const logoUploadBody = validator('json', (value, c) => {
  const parsed = parseLogoUpload(value);
  return parsed.ok ? parsed.value : c.json({...problem('invalid_input', parsed.message), fields: {logo: parsed.message}}, 422);
});

const logoCompleteBody = validator('json', (value, c) => {
  const id = (value as {fileId?: unknown} | null)?.fileId;
  return typeof id === 'string' && LOGO_FILE_ID.test(id) ? {fileId: id} : c.json(problem('invalid_input', 'That is not an uploaded file.'), 422);
});

const patchBody = validator('json', (value, c) => {
  const parsed = parseSettingsPatch(value);
  return parsed.ok
    ? parsed.value
    : c.json({...problem('invalid_input', 'Some fields need attention.'), fields: parsed.fields}, 422);
});

export const eventSettingsRoutes = new Hono()
  .get('/brand', withDb, async c => {
    const row = await c.var.db.eventSettings.findUnique({where: {id: 1}, select: {brandColor: true, fontPreset: true, logoFileId: true, logoName: true}});
    c.header('Cache-Control', 'public, max-age=60');
    const logoUrl = logoPath(row?.logoFileId && row?.logoName ? {id: row.logoFileId, name: row.logoName} : null);
    return c.json({brandColor: row?.brandColor ?? null, fontPreset: row?.fontPreset ?? DEFAULT_EVENT_SETTINGS.fontPreset, logoUrl});
  })

  .get('/', withViewer, requireAuth, requirePermission(PERMISSIONS.EVENT_MANAGE), withDb, async c => {
    const row = await c.var.db.eventSettings.findUnique({where: {id: 1}, select});
    return c.json({settings: toDto(row)});
  })

  .get('/payments', withViewer, requireAuth, requirePermission(PERMISSIONS.EVENT_MANAGE), withDb, async c => {
    const rows = await c.var.db.ticketType.findMany({
      where: {priceCents: {gt: 0}, event: {deletedAt: null}},
      select: {id: true, name: true, priceCents: true, currency: true, eventId: true, event: {select: {title: true}}},
      orderBy: [{event: {startAt: 'desc'}}, {sortOrder: 'asc'}],
      take: 200,
    });
    const catalogue = await listPrices(siteBase()).catch(() => null);
    c.header('Cache-Control', 'no-store');
    return c.json(shapePaymentsStatus(rows.map(({event, ...r}) => ({...r, eventTitle: event.title})), catalogue?.ok ? catalogue.data : null));
  })

  .patch('/', patchBody, withViewer, requireAuth, requirePermission(PERMISSIONS.EVENT_MANAGE), withDb, async c => {
    const db: PrismaClient = c.var.db;
    const patch = c.req.valid('json');
    // Column by column: nothing the client sent reaches the database except what was validated.
    const data = {
      ...(patch.brandColor !== undefined ? {brandColor: patch.brandColor} : {}),
      ...(patch.fontPreset !== undefined ? {fontPreset: patch.fontPreset} : {}),
      ...(patch.defaultTimezone !== undefined ? {defaultTimezone: patch.defaultTimezone} : {}),
      ...(patch.senderName !== undefined ? {senderName: patch.senderName} : {}),
      ...(patch.replyToEmail !== undefined ? {replyToEmail: patch.replyToEmail} : {}),
      ...(patch.defaultReminderRules !== undefined
        ? {defaultReminderRules: patch.defaultReminderRules.map(r => ({...r})) as Prisma.InputJsonArray}
        : {}),
      ...(patch.allowMaybeDefault !== undefined ? {allowMaybeDefault: patch.allowMaybeDefault} : {}),
      ...(patch.showGuestListDefault !== undefined ? {showGuestListDefault: patch.showGuestListDefault} : {}),
      ...(patch.defaultCoverPoster !== undefined ? {defaultCoverPoster: patch.defaultCoverPoster} : {}),
    };
    const row = await db.eventSettings.upsert({where: {id: 1}, create: {id: 1, ...data}, update: data, select});
    await audit(db, {actorUserId: c.var.viewer.id, action: 'event_settings_changed', target: ['event_settings', 1], meta: {keys: Object.keys(data)}});
    return c.json({settings: toDto(row)});
  })

  // Logo, step 1: validate the image's type and size, then a PUBLIC upload URL (it shows on public pages and in emails).
  .post('/logo', logoUploadBody, withViewer, requireAuth, requirePermission(PERMISSIONS.EVENT_MANAGE), async c => {
    const grant = await createUpload(c.req.url, {...c.req.valid('json'), visibility: 'public'});
    if (!grant.ok) return c.json(problem(grant.code, grant.message), grant.status === 402 ? 402 : 400);
    return c.json({fileId: grant.data.file.id, upload: grant.data.upload}, 201);
  })

  // Logo, step 3: after the browser's PUT. The stored file is checked again (never trust the id or the claimed type).
  .post('/logo/complete', logoCompleteBody, withViewer, requireAuth, requirePermission(PERMISSIONS.EVENT_MANAGE), withDb, async c => {
    const db: PrismaClient = c.var.db;
    const {fileId} = c.req.valid('json');
    const done = await completeUpload(c.req.url, fileId);
    if (!done.ok) return c.json(problem(done.code, done.message), 400);
    const file = done.data;
    if (file.visibility !== 'public' || !(LOGO_TYPES as readonly string[]).includes(file.contentType) || file.size > LOGO_MAX_BYTES) {
      await deleteFile(c.req.url, fileId).catch(() => null);
      return c.json(problem('invalid_input', LOGO_RULE_MESSAGE), 422);
    }
    const before = await db.eventSettings.findUnique({where: {id: 1}, select: {logoFileId: true}});
    const data = {logoFileId: file.id, logoName: file.name.slice(0, 200)};
    const row = await db.eventSettings.upsert({where: {id: 1}, create: {id: 1, ...data}, update: data, select});
    if (before?.logoFileId && before.logoFileId !== file.id) await deleteFile(c.req.url, before.logoFileId).catch(() => null);
    await audit(db, {actorUserId: c.var.viewer.id, action: 'event_settings_changed', target: ['event_settings', 1], meta: {keys: ['logo']}});
    return c.json({settings: toDto(row)});
  })

  .delete('/logo', withViewer, requireAuth, requirePermission(PERMISSIONS.EVENT_MANAGE), withDb, async c => {
    const db: PrismaClient = c.var.db;
    const before = await db.eventSettings.findUnique({where: {id: 1}, select: {logoFileId: true}});
    if (!before?.logoFileId) return c.json({settings: toDto(await db.eventSettings.findUnique({where: {id: 1}, select}))});
    const row = await db.eventSettings.update({where: {id: 1}, data: {logoFileId: null, logoName: null}, select});
    await deleteFile(c.req.url, before.logoFileId).catch(() => null);
    await audit(db, {actorUserId: c.var.viewer.id, action: 'event_settings_changed', target: ['event_settings', 1], meta: {keys: ['logo']}});
    return c.json({settings: toDto(row)});
  });
