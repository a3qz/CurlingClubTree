module.exports = async function handler(req, res) {
  const { url } = req.query;
  if (!url) return res.status(400).send('Missing url parameter');

  let target;
  try { target = new URL(url); } catch { return res.status(400).send('Invalid url'); }
  if (target.hostname !== 'curlingseattle.org') return res.status(403).send('Forbidden');

  try {
    const upstream = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Referer': 'https://curlingseattle.org/',
      },
    });
    const html = await upstream.text();
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=300');
    res.status(upstream.status).send(html);
  } catch (err) {
    res.status(502).send('Proxy error: ' + err.message);
  }
};
