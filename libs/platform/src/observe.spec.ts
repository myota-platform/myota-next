import { observeOptions } from './observe.js';

describe('Observe bootstrap options', () => {
  it('keeps reporting disabled without both credentials', () => {
    const options = observeOptions('activity-worker', {
      OBSERVE_APP_KEY: 'key',
      OBSERVE_ENDPOINT: 'https://observe.example.test',
    });

    expect(options).toMatchObject({
      enabled: false,
      serviceId: 'activity-worker',
      forwardLogs: true,
      redaction: { enabled: true },
      endpoint: 'https://observe.example.test',
    });
  });

  it('enables reporting and log forwarding only with both credentials', () => {
    const options = observeOptions('geodata-api', {
      OBSERVE_APP_KEY: ' app-key ',
      OBSERVE_APP_SECRET: ' app-secret ',
      OBSERVE_ENDPOINT: ' https://observe.example.test/v1 ',
      MYOTA_BUILD_VERSION: 'testing-abc123',
    });

    expect(options).toMatchObject({
      enabled: true,
      serviceId: 'geodata-api',
      serviceVersion: 'testing-abc123',
      forwardLogs: true,
      redaction: { enabled: true },
      endpoint: 'https://observe.example.test/v1',
    });
    expect(options.appKey).toBe(' app-key ');
    expect(options.appSecret).toBe(' app-secret ');
  });
});
