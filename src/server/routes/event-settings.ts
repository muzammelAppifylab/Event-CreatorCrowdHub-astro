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
import {audit} from '../../platform/auth';
import {listPrices} from '../../platform/payments';
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
 *   GET   /site-api/event-settings/brand  public: colour and font only (they already style the public pages)
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
  updatedAt: true,
} as const;

type Row = Prisma.EventSettingsGetPayload<{select: typeof select}>;

function toDto(row: Row | null): EventSettingsDto {
  if (!row) return {...DEFAULT_EVENT_SETTINGS, updatedAt: null};
  return {
    brandColor: row.brandColor,
    fontPreset: row.fontPreset as FontPreset,
    defaultTimezone: row.defaultTimezone,
    senderName: row.senderName,
    replyToEmail: row.replyToEmail,
    // A hand-edited row never breaks the screen: rules that fail today's checks are left out.
    defaultReminderRules: parseReminderRules(new Collector(), row.defaultReminderRules, 'rules') ?? [],
    allowMaybeDefault: row.allowMaybeDefault,
    showGuestListDefault: row.showGuestListDefault,
    defaultCoverPoster: row.defaultCoverPoster as PosterDesign | null,
    updatedAt: row.updatedAt.toISOString(),
  };
}

const patchBody = validator('json', (value, c) => {
  const parsed = parseSettingsPatch(value);
  return parsed.ok
    ? parsed.value
    : c.json({...problem('invalid_input', 'Some fields need attention.'), fields: parsed.fields}, 422);
});

export const eventSettingsRoutes = new Hono()
  .get('/brand', withDb, async c => {
    const row = await c.var.db.eventSettings.findUnique({where: {id: 1}, select: {brandColor: true, fontPreset: true}});
    c.header('Cache-Control', 'public, max-age=60');
    return c.json({brandColor: row?.brandColor ?? null, fontPreset: row?.fontPreset ?? DEFAULT_EVENT_SETTINGS.fontPreset});
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
  });
