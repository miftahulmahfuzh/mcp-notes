// Spike: a local player page plus a pass-through that adds the Referer a stream host insists on,
// and rewrites playlists so every further request comes back through here.
// node proxy.mjs [port]
import http from 'node:http';
import { Readable } from 'node:stream';

const PORT = Number(process.argv[2] ?? 7399);
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const stats = { requests: 0, bytes: 0, errors: [] };

const through = (url, ref) => `/p?r=${encodeURIComponent(ref)}&u=${encodeURIComponent(url)}`;

function rewritePlaylist(text, base, ref) {
  return text
    .split('\n')
    .map((line) => {
      const t = line.trim();
      if (t === '') return line;
      if (t.startsWith('#')) return line.replace(/URI="([^"]+)"/g, (_, u) => `URI="${through(new URL(u, base).href, ref)}"`);
      return through(new URL(t, base).href, ref);
    })
    .join('\n');
}

const PAGE = (src, kind) => `<!doctype html><meta charset="utf-8"><title>notesd direct stream (spike)</title>
<style>html,body{margin:0;height:100%;background:#000;overflow:hidden}video{width:100vw;height:100vh;background:#000}</style>
<video id="v" controls autoplay playsinline></video>
<script src="https://cdnjs.cloudflare.com/ajax/libs/hls.js/1.5.17/hls.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/dashjs/4.7.4/dash.all.min.js"></script>
<script>
const v = document.getElementById('v'); window.spike = { errors: [], levels: [] };
if (${JSON.stringify(kind)} === 'dash') {
  const p = dashjs.MediaPlayer().create(); p.initialize(v, ${JSON.stringify(src)}, true);
  p.on('error', (e) => spike.errors.push(JSON.stringify(e.error || e).slice(0, 300)));
} else {
  const hls = new Hls({ startLevel: -1 }); window.hls = hls;
  hls.on(Hls.Events.MANIFEST_PARSED, (_, d) => { spike.levels = d.levels.map((l) => l.height); v.play().catch((e) => spike.errors.push(String(e))); });
  hls.on(Hls.Events.ERROR, (_, d) => spike.errors.push(d.type + ' ' + d.details + (d.fatal ? ' FATAL' : '')));
  hls.loadSource(${JSON.stringify(src)}); hls.attachMedia(v);
}
</script>`;

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    try {
      if (url.pathname === '/') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<title>notesd direct stream (spike)</title>ready'); }
      if (url.pathname === '/stats') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(stats)); }
      if (url.pathname === '/play') {
        const src = through(url.searchParams.get('src'), url.searchParams.get('ref') ?? '');
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(PAGE(src, url.searchParams.get('kind') ?? 'hls'));
      }
      if (url.pathname !== '/p') { res.writeHead(404); return res.end(); }
      const target = url.searchParams.get('u');
      const ref = url.searchParams.get('r') ?? '';
      const headers = { 'user-agent': UA, accept: '*/*' };
      if (ref) { headers.referer = ref; headers.origin = new URL(ref).origin; }
      if (req.headers.range) headers.range = req.headers.range;
      const upstream = await fetch(target, { headers });
      stats.requests++;
      const type = upstream.headers.get('content-type') ?? '';
      const out = { 'access-control-allow-origin': '*', 'content-type': type || 'application/octet-stream' };
      for (const h of ['content-range', 'accept-ranges']) if (upstream.headers.get(h)) out[h] = upstream.headers.get(h);
      if (!upstream.ok) stats.errors.push(`${upstream.status} ${target.slice(0, 120)}`);
      const looksLikePlaylist = /mpegurl/i.test(type) || /\.(m3u8|txt)(\?|$)/.test(target);
      if (looksLikePlaylist) {
        const text = await upstream.text();
        if (text.startsWith('#EXTM3U')) {
          out['content-type'] = 'application/vnd.apple.mpegurl';
          res.writeHead(upstream.status, out);
          return res.end(rewritePlaylist(text, upstream.url, ref));
        }
        res.writeHead(upstream.status, out);
        return res.end(text);
      }
      res.writeHead(upstream.status, out);
      if (!upstream.body) return res.end();
      const body = Readable.fromWeb(upstream.body);
      body.on('data', (c) => (stats.bytes += c.length));
      body.on('error', () => res.destroy());
      body.pipe(res);
    } catch (err) {
      stats.errors.push(String(err?.message ?? err).slice(0, 200));
      if (!res.headersSent) res.writeHead(502);
      res.end();
    }
  })
  .listen(PORT, '0.0.0.0', () => console.log(`spike proxy on ${PORT}`));
