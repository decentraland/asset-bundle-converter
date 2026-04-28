// Jest config for E2E tests that require Unity (run inside Docker image).
// These tests are NOT part of the regular `yarn test` — they run as a
// separate CI step after the Docker image is built.
module.exports = {
  moduleFileExtensions: ['ts', 'js'],
  transform: {
    '^.+\\.(ts|tsx)$': ['ts-jest', { tsconfig: 'test/tsconfig.json' }]
  },
  testMatch: ['**/test/e2e/**/*.spec.(ts)'],
  testEnvironment: 'node',
  testTimeout: 1800000 // 30 minutes — real Unity conversions are slow
}
