import 'dotenv/config';
import express, { type Request, type Response } from 'express';
import httpProxy from 'http-proxy';

const app = express();
const PORT = Number(process.env.PORT ?? 8000);

const BASE_PATH =
  process.env.OUTPUTS_BASE_PATH ??
  'https://vercel-clone-outputs.s3.ap-south-1.amazonaws.com/__outputs';

const proxy = httpProxy.createProxy();

app.use((req: Request, res: Response) => {
  const hostname = req.hostname;
  const subdomain = hostname.split('.')[0];

  // Custom domain support can be added by resolving subdomain via DB lookup.
  const resolvesTo = `${BASE_PATH}/${subdomain}`;
  proxy.web(req, res, { target: resolvesTo, changeOrigin: true });
});

proxy.on('proxyReq', (proxyReq, req) => {
  const url = req.url;
  if (url === '/') {
    proxyReq.path += 'index.html';
  }
});

app.listen(PORT, () => console.log(`Reverse Proxy Running..${PORT}`));
