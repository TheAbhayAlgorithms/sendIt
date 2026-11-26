import { createApp } from '../src/createApp.js';

const { app } = createApp();

export default function handler(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const pathParam = url.searchParams.get('__path');
  if (pathParam) {
    url.searchParams.delete('__path');
    const qs = url.searchParams.toString();
    const prefix = pathParam === 'healthz' ? '/' : '/api/';
    req.url = `${prefix}${pathParam}${qs ? `?${qs}` : ''}`;
  } else if (req.url === '/api/index.js') {
    const orig = req.headers['x-vercel-original-url'] || req.headers['x-forwarded-uri'] || req.headers['x-invoke-path'];
    if (orig) req.url = orig;
  }
  console.log('[vercel-api]', req.method, req.url);
  return app(req, res);
}
