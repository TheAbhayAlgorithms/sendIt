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
  }
  console.log('[vercel-api]', req.method, req.url);
  return app(req, res);
}
