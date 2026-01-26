import request from 'supertest';
import { app } from '../src/app';

describe('Server Health', () => {
  it('responds to health check', async () => {
    const response = await request(app).get('/health');

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('ok');
  });

  it('includes timestamp in health response', async () => {
    const before = Date.now();
    const response = await request(app).get('/health');
    const after = Date.now();

    expect(response.body.timestamp).toBeGreaterThanOrEqual(before);
    expect(response.body.timestamp).toBeLessThanOrEqual(after);
  });
});
