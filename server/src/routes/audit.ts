import { Router, Request, Response } from 'express';
import { auditStore } from '../services/auditStore';
import { parsePagination, parseTimestamp } from './pagination';

export const auditRouter = Router();

/** GET /api/audit - List audit logs */
auditRouter.get('/audit', (req: Request, res: Response) => {
  const { actorType, actorId, action, resourceType, resourceId } = req.query;
  const filter = {
    actorType: actorType as 'admin' | 'device' | 'system' | undefined,
    actorId: actorId as string | undefined,
    action: action as any,
    resourceType: resourceType as any,
    resourceId: resourceId as string | undefined,
    from: parseTimestamp(req.query.from),
    to: parseTimestamp(req.query.to),
  };
  const page = parsePagination(req.query);
  const logs = auditStore.getLogs({ ...filter, ...page });
  res.json({ logs, count: logs.length, total: auditStore.countLogs(filter) });
});

/** GET /api/audit/export - Export audit logs as CSV */
auditRouter.get('/audit/export', (req: Request, res: Response) => {
  const csv = auditStore.exportLogs({
    from: parseTimestamp(req.query.from),
    to: parseTimestamp(req.query.to),
  });

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="audit-logs-${Date.now()}.csv"`);
  res.send(csv);
});

/** GET /api/devices/:id/audit - Get audit logs for device */
auditRouter.get('/devices/:id/audit', (req: Request, res: Response) => {
  const { limit } = parsePagination(req.query);
  const logs = auditStore.getResourceLogs('device', req.params.id, limit);
  res.json({ logs, count: logs.length });
});
