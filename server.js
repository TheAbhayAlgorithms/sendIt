import { createApp } from './src/app.js';

const PORT = Number.parseInt(process.env.PORT, 10) || 3000;

const { server, adminSecret } = createApp();

server.listen(PORT, () => {
  console.log(`\n  SendIt Chat Server running at http://localhost:${PORT}`);
  console.log(`  Admin Console: http://localhost:${PORT}/admin`);
  console.log(`  Admin Key:     ${adminSecret}\n`);
});
