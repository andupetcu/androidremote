import { z } from 'zod';
import { isValidPackageName } from './apkValidator';

/**
 * Payload validation for the command types that carry structured data (contract C10, AM-16).
 * Returns the cleaned payload or an error message. Types without a schema pass through unchanged.
 */

const pkg = z.string().refine(isValidPackageName, 'packageName is not a valid Android package name');

const SCHEMAS: Record<string, z.ZodTypeAny> = {
  SET_KIOSK: z.object({ packageName: pkg, enabled: z.boolean(), lockTask: z.boolean() }).passthrough(),
  DISABLE_APP: z.object({ packageName: pkg }).passthrough(),
  ENABLE_APP: z.object({ packageName: pkg }).passthrough(),
  LAUNCH_APP: z.object({ packageName: pkg }).passthrough(),
  GRANT_PERMISSION: z.object({
    packageName: pkg,
    permission: z.string().min(1).max(300).regex(/^[A-Za-z0-9_.]+$/, 'permission contains invalid characters'),
    state: z.enum(['granted', 'denied', 'default']),
  }).passthrough(),
  SET_PROTECTED_PACKAGES: z.object({ packages: z.array(pkg).max(500) }).passthrough(),
};

export type PayloadResult = { payload: Record<string, unknown> } | { error: string };

export function validateCommandPayload(
  type: string,
  payload: Record<string, unknown>,
  deviceId: string
): PayloadResult {
  if (type === 'WIPE') {
    // The device refuses a WIPE whose confirm is not its own id; the server refuses it first.
    if (payload.confirm !== deviceId) {
      return { error: 'WIPE requires payload.confirm equal to the device ID' };
    }
    if (payload.wipeExternalStorage !== undefined && typeof payload.wipeExternalStorage !== 'boolean') {
      return { error: 'wipeExternalStorage must be a boolean' };
    }
    if (payload.reason !== undefined && typeof payload.reason !== 'string') {
      return { error: 'reason must be a string' };
    }
    return { payload };
  }

  const schema = SCHEMAS[type];
  if (!schema) return { payload };
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue.path.length ? `${issue.path.join('.')}: ` : '';
    return { error: `${type} payload invalid: ${where}${issue.message}` };
  }
  return { payload: parsed.data as Record<string, unknown> };
}
