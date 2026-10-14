/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/test', '<rootDir>/src'],
  // env.ts: per-file scratch dirs, cheap bcrypt, no keep-alive agent. afterEnv.ts: closes the shared supertest servers.
  setupFiles: ['<rootDir>/test/env.ts'],
  setupFilesAfterEnv: ['<rootDir>/test/support/afterEnv.ts'],
  // One long-lived server per app instead of one per request (see test/support/supertest.ts).
  moduleNameMapper: { '^supertest$': '<rootDir>/test/support/supertest.ts' },
  testMatch: ['**/*.test.ts'],
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov', 'html'],
  verbose: true,
};
