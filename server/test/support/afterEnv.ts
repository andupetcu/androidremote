import { closeSupertestServers } from './supertest';

afterAll(async () => {
  await closeSupertestServers();
});
