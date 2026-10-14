import { Router, Request, Response } from 'express';
import { deviceStore } from '../services/deviceStore';
import { eventStore, DeviceEventType, EventSeverity } from '../services/eventStore';
import { auditStore } from '../services/auditStore';
import { adminSubject } from '../middleware/auth';
import { parsePagination, parseTimestamp } from './pagination';

export const eventsRouter = Router();

function ackFilter(raw: unknown): boolean | undefined {
  return raw !== undefined ? raw === 'true' : undefined;
}

/** GET /api/events - List all events (optionally for one device) */
eventsRouter.get('/events', (req: Request, res: Response) => {
  const deviceId = typeof req.query.deviceId === 'string' && req.query.deviceId ? req.query.deviceId : undefined;
  const filter = {
    severity: req.query.severity as EventSeverity | undefined,
    acknowledged: ackFilter(req.query.acknowledged),
    from: parseTimestamp(req.query.from),
    to: parseTimestamp(req.query.to),
  };
  const page = parsePagination(req.query);
  const events = deviceId
    ? eventStore.getDeviceEvents(deviceId, { ...filter, ...page })
    : eventStore.getAllEvents({ ...filter, ...page });
  res.json({ events, count: events.length, total: eventStore.countEvents({ ...filter, deviceId }) });
});

/** GET /api/events/unread - Get unread critical/warning events */
eventsRouter.get('/events/unread', (req: Request, res: Response) => {
  const minSeverity = (req.query.minSeverity as EventSeverity) || 'warning';
  const events = eventStore.getUnacknowledgedEvents(minSeverity);
  const count = eventStore.getUnacknowledgedCount(minSeverity);
  res.json({ events, count });
});

/** GET /api/events/stats - Get event statistics */
eventsRouter.get('/events/stats', (_req: Request, res: Response) => {
  res.json({
    unread: eventStore.getUnacknowledgedCount('info'),
    critical: eventStore.getUnacknowledgedCount('critical'),
    warning: eventStore.getUnacknowledgedCount('warning'),
  });
});

/** GET /api/devices/:id/events - Get events for device */
eventsRouter.get('/devices/:id/events', (req: Request, res: Response) => {
  const events = eventStore.getDeviceEvents(req.params.id, {
    severity: req.query.severity as EventSeverity | undefined,
    acknowledged: ackFilter(req.query.acknowledged),
    ...parsePagination(req.query),
  });
  res.json({ events, count: events.length });
});

/** POST /api/devices/:id/events - Device reports an event */
eventsRouter.post('/devices/:id/events', (req: Request, res: Response) => {
  const { id } = req.params;
  const { eventType, severity, data } = req.body;

  if (!deviceStore.getDevice(id)) {
    res.status(404).json({ error: 'Device not found' });
    return;
  }

  const event = eventStore.recordEvent({
    deviceId: id,
    eventType: eventType as DeviceEventType,
    severity: severity as EventSeverity,
    data,
  });

  res.status(201).json(event);
});

/** POST /api/events/:id/acknowledge - the actor is the authenticated admin, never a client-supplied name (SS-11). */
eventsRouter.post('/events/:id/acknowledge', (req: Request, res: Response) => {
  const { id } = req.params;
  const actor = adminSubject(req);

  if (!eventStore.acknowledgeEvent(parseInt(id, 10), actor)) {
    res.status(404).json({ error: 'Event not found or already acknowledged' });
    return;
  }

  auditStore.log({
    actorType: 'admin',
    actorId: actor,
    action: 'event.acknowledged',
    resourceType: 'event',
    resourceId: id,
    ipAddress: req.ip,
  });

  res.json({ success: true });
});

/** POST /api/events/acknowledge - Acknowledge multiple events */
eventsRouter.post('/events/acknowledge', (req: Request, res: Response) => {
  const { eventIds } = req.body;

  if (!Array.isArray(eventIds)) {
    res.status(400).json({ error: 'eventIds must be an array' });
    return;
  }

  const actor = adminSubject(req);
  const ids = eventIds.filter((v: unknown): v is number => Number.isInteger(v));
  const count = ids.length > 0 ? eventStore.acknowledgeEvents(ids, actor) : 0;

  auditStore.log({
    actorType: 'admin',
    actorId: actor,
    action: 'event.acknowledged',
    resourceType: 'event',
    details: { count, eventIds: ids.slice(0, 100) },
    ipAddress: req.ip,
  });

  res.json({ success: true, acknowledged: count });
});
