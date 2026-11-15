// Echo what the Next rewrite actually sends upstream (one-shot diagnostic).
import { createServer } from 'node:http'
createServer((req, res) => {
  console.log(JSON.stringify({
    host: req.headers.host,
    origin: req.headers.origin ?? null,
    xfHost: req.headers['x-forwarded-host'] ?? null,
    xfProto: req.headers['x-forwarded-proto'] ?? null,
  }))
  res.end('ok')
}).listen(3003, "127.0.0.1", () => console.log('echo up'))
