import { createApp } from './src/app.js';

const PORT = Number.parseInt(process.env.PORT, 10) || 3000;
const HOST = process.env.HOST || '0.0.0.0';

const { app, server, adminSecret } = createApp();

if (!process.env.VERCEL) {
  server.listen(PORT, HOST, () => {
    console.log(`\n  SendIt Chat Server running at http://${HOST}:${PORT}`);
    console.log(`  Admin Console: http://localhost:${PORT}/admin`);
    console.log(`  Admin Key:     ${adminSecret}\n`);
  });
}

export default app;
