const { once } = require('node:events');
const { createApp } = require('../../src/app');

// Всеки тест получава отделен локален сървър, който се затваря след него.
async function withApp(options, run) {
  const server = createApp(options).listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

module.exports = { withApp };
