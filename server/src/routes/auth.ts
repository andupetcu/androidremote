import { Router, Request, Response } from 'express';
import rateLimit, { MemoryStore } from 'express-rate-limit';
import { z } from 'zod';
import { authMiddleware, loginHandler, changePasswordHandler, logoutHandler, auditLoginFailure } from '../middleware/auth';
import { validateBody } from '../middleware/validate';

const loginSchema = z.object({
  username: z.string().min(1).max(100),
  password: z.string().min(1).max(200),
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: z.string().min(8, 'Password must be at least 8 characters').max(200),
});

// Login rate limiter: 5 attempts per 15 minutes per IP. A refused attempt is audited as well.
export const loginRateLimitStore = new MemoryStore();
const loginRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  store: loginRateLimitStore,
  handler: (req: Request, res: Response) => {
    auditLoginFailure(req, 'rate_limited');
    res.status(429).json({ error: 'Too many login attempts. Please try again in 15 minutes.' });
  },
});

/** Mounted at /api/auth, before the API gate: login is public, the rest checks the admin token itself. */
export const authRouter = Router();
authRouter.post('/login', loginRateLimit, validateBody(loginSchema), loginHandler);
authRouter.get('/verify', authMiddleware, (_req: Request, res: Response) => {
  res.json({ valid: true });
});
authRouter.put('/password', authMiddleware, validateBody(changePasswordSchema), changePasswordHandler);
authRouter.post('/logout', authMiddleware, logoutHandler);
