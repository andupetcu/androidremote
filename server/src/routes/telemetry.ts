import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { eventStore } from '../services/eventStore';
import { telemetryStore, TelemetryInput, parseBucketMs } from '../services/telemetryStore';
import { noteDeviceSeen } from '../services/devicePresence';
import { validateBody } from '../middleware/validate';
import { parseTimestamp } from './pagination';

export const telemetryRouter = Router();

const num = (schema: z.ZodNumber) => schema.nullable().optional();
const str = (max: number) => z.string().max(max).nullable().optional();

const sampleFields = {
  batteryLevel: num(z.number().int().min(0).max(100)),
  batteryCharging: z.union([z.boolean(), z.number()]).nullable().optional(),
  batteryHealth: str(50),
  networkType: str(50),
  networkSsid: str(100),
  ipAddress: str(100),
  signalStrength: num(z.number().int().min(-200).max(0)),
  storageUsedBytes: num(z.number().int().min(0)),
  storageTotalBytes: num(z.number().int().min(0)),
  memoryUsedBytes: num(z.number().int().min(0)),
  memoryTotalBytes: num(z.number().int().min(0)),
  screenOn: z.union([z.boolean(), z.number()]).nullable().optional(),
  brightness: num(z.number().int().min(0).max(255)),
  latitude: num(z.number().min(-90).max(90)),
  longitude: num(z.number().min(-180).max(180)),
  locationAccuracy: num(z.number().min(0)),
  uptimeMs: num(z.number().int().min(0)),
  androidSecurityPatch: str(50),
  collectedAt: z.number().int().min(0).optional(),
};
// Unknown keys (including a deviceId) are stripped: the device ID always comes from the URL (C2).
const telemetrySchema = z.object(sampleFields);
export const MAX_BATCH_SAMPLES = 500;
const batchSchema = z.object({ samples: z.array(telemetrySchema).min(1).max(MAX_BATCH_SAMPLES) });

/** Report interval the device should follow, in milliseconds (the device clamps it to 15 s..1 h). */
function nextReportIn(): number {
  const v = Number(process.env.TELEMETRY_REPORT_INTERVAL_MS);
  return v > 0 ? v : 60_000;
}

function toInput(deviceId: string, sample: z.infer<typeof telemetrySchema>): TelemetryInput {
  const { batteryCharging, screenOn, ...rest } = sample;
  const out: TelemetryInput = { ...(rest as Omit<TelemetryInput, 'deviceId'>), deviceId };
  if (batteryCharging !== undefined) out.batteryCharging = batteryCharging === null ? null : Boolean(batteryCharging);
  if (screenOn !== undefined) out.screenOn = screenOn === null ? null : Boolean(screenOn);
  return out;
}

/** Apply samples oldest first; raise battery events on state transitions only. */
function ingest(deviceId: string, samples: Array<z.infer<typeof telemetrySchema>>): void {
  const now = Date.now();
  const ordered = samples
    .map((s, i) => ({ s, i, at: s.collectedAt ?? now }))
    .sort((a, b) => a.at - b.at || a.i - b.i);
  for (const { s } of ordered) {
    const result = telemetryStore.recordSample(toInput(deviceId, s));
    if (result.alert) {
      eventStore.recordEvent({
        deviceId,
        eventType: result.alert,
        severity: result.alert === 'battery-critical' ? 'critical' : 'warning',
        data: { batteryLevel: result.batteryLevel },
      });
    }
  }
}

/** POST /api/devices/:id/telemetry - Device pushes telemetry */
telemetryRouter.post('/devices/:id/telemetry', validateBody(telemetrySchema), (req: Request, res: Response) => {
  const { id } = req.params;
  if (!noteDeviceSeen(id)) {
    res.status(404).json({ error: 'Device not found' });
    return;
  }
  ingest(id, [req.body]);
  res.json({ success: true, nextReportIn: nextReportIn() });
});

/** POST /api/devices/:id/telemetry/batch - Device flushes buffered samples (T10): { samples: [{...telemetry, collectedAt}] } */
telemetryRouter.post('/devices/:id/telemetry/batch', validateBody(batchSchema), (req: Request, res: Response) => {
  const { id } = req.params;
  if (!noteDeviceSeen(id)) {
    res.status(404).json({ error: 'Device not found' });
    return;
  }
  const samples = req.body.samples as Array<z.infer<typeof telemetrySchema>>;
  ingest(id, samples);
  res.json({ success: true, accepted: samples.length, nextReportIn: nextReportIn() });
});

/** GET /api/devices/:id/telemetry - Get latest telemetry */
telemetryRouter.get('/devices/:id/telemetry', (req: Request, res: Response) => {
  const { id } = req.params;

  const telemetry = telemetryStore.getTelemetry(id);
  if (!telemetry) {
    // Empty telemetry object instead of 404 when no data exists yet
    res.json({
      deviceId: id,
      timestamp: null,
      batteryLevel: null,
      batteryCharging: null,
      networkType: null,
      storageUsedBytes: null,
      storageTotalBytes: null,
      memoryUsedBytes: null,
      memoryTotalBytes: null,
    });
    return;
  }

  res.json(telemetry);
});

/**
 * GET /api/devices/:id/telemetry/history?from&to&bucket&limit
 * bucket: minute|hour|day or 1m|15m|1h|6h|1d style; omitted gives the raw rows. Averaged in SQL.
 */
telemetryRouter.get('/devices/:id/telemetry/history', (req: Request, res: Response) => {
  const { id } = req.params;
  const now = Date.now();
  const fromTs = parseTimestamp(req.query.from) ?? now - 24 * 60 * 60 * 1000;
  const toTs = parseTimestamp(req.query.to) ?? now;

  let bucketMs: number | null = null;
  const bucket = req.query.bucket;
  if (bucket !== undefined) {
    bucketMs = typeof bucket === 'string' ? parseBucketMs(bucket) : null;
    if (bucketMs === null) {
      res.status(400).json({ error: 'bucket must be minute, hour, day or <n>m / <n>h / <n>d (1 minute to 7 days)' });
      return;
    }
  }

  const limit = typeof req.query.limit === 'string' ? parseInt(req.query.limit, 10) : undefined;
  const dataPoints = telemetryStore.getHistory(id, fromTs, toTs, { limit, bucketMs });

  res.json({
    deviceId: id,
    from: fromTs,
    to: toTs,
    bucket: bucket ?? null,
    dataPoints,
  });
});

/** GET /api/telemetry - Get telemetry for all devices (dashboard) */
telemetryRouter.get('/telemetry', (_req: Request, res: Response) => {
  res.json({ telemetry: telemetryStore.getAllTelemetry() });
});
