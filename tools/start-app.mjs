const appName = process.env.APP_NAME;

if (!appName || !/^[a-z][a-z0-9-]*$/.test(appName)) {
  throw new Error('APP_NAME must identify one NestJS application');
}

await import(`../dist/apps/${appName}/main.js`);
