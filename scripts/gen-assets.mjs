/**
 * Generates Pico's production image assets from inline SVG:
 *   public/og.png               1200x630 social card
 *   public/icon-192.png         favicon / manifest icon
 *   public/icon-512.png         manifest + maskable icon
 *   public/apple-touch-icon.png 180x180 iOS home-screen icon
 * Brand: black tile, white waveform bars, one green voice bar (#30d158).
 */
import sharp from 'sharp'

const GREEN = '#30d158'

const iconSvg = (size) => {
  const s = size / 64
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="${size}" height="${size}">
  <rect width="64" height="64" rx="16" fill="#0d0d0f"/>
  <rect x="14" y="26" width="5" height="12" rx="2.5" fill="#fff"/>
  <rect x="23" y="20" width="5" height="24" rx="2.5" fill="#fff"/>
  <rect x="32" y="14" width="5" height="36" rx="2.5" fill="${GREEN}"/>
  <rect x="41" y="22" width="5" height="20" rx="2.5" fill="#fff"/>
  <rect x="50" y="28" width="5" height="8" rx="2.5" fill="#fff"/>
</svg>`
}

const ogSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 630" width="1200" height="630">
  <rect width="1200" height="630" fill="#ffffff"/>
  <rect x="72" y="72" width="140" height="140" rx="34" fill="#0d0d0f"/>
  <g>
    <rect x="104" y="124" width="11" height="36" rx="5.5" fill="#fff"/>
    <rect x="131" y="108" width="11" height="68" rx="5.5" fill="#fff"/>
    <rect x="158" y="90" width="11" height="104" rx="5.5" fill="${GREEN}"/>
    <rect x="185" y="112" width="11" height="60" rx="5.5" fill="#fff"/>
    <rect x="212" y="128" width="11" height="28" rx="5.5" fill="#fff"/>
  </g>
  <text x="252" y="163" font-family="Arial, Helvetica, sans-serif" font-size="76" font-weight="800" letter-spacing="-2" fill="#0d0d0f">Pico</text>
  <text x="72" y="360" font-family="Arial, Helvetica, sans-serif" font-size="88" font-weight="800" letter-spacing="-3" fill="#0d0d0f">Calls that weigh nothing.</text>
  <text x="72" y="432" font-family="Arial, Helvetica, sans-serif" font-size="34" font-weight="500" fill="#7c7c82">Peer-to-peer video calling, tuned to run on a single bar of signal.</text>
  <g font-family="Arial, Helvetica, sans-serif" font-size="26" font-weight="700">
    <rect x="72" y="486" width="330" height="58" rx="29" fill="#f5f5f7"/>
    <text x="104" y="523" fill="#3c3c43">Peer-to-peer · no servers</text>
    <rect x="424" y="486" width="250" height="58" rx="29" fill="#f5f5f7"/>
    <text x="456" y="523" fill="#3c3c43">Runs on one bar</text>
    <rect x="696" y="486" width="330" height="58" rx="29" fill="#f5f5f7"/>
    <text x="728" y="523" fill="#3c3c43">Encrypted, nothing saved</text>
  </g>
</svg>`

await sharp(Buffer.from(iconSvg(192))).resize(192, 192).png().toFile('public/icon-192.png')
await sharp(Buffer.from(iconSvg(512))).resize(512, 512).png().toFile('public/icon-512.png')
await sharp(Buffer.from(iconSvg(180))).resize(180, 180).png().toFile('public/apple-touch-icon.png')
await sharp(Buffer.from(ogSvg)).png().toFile('public/og.png')
console.log('assets generated: og.png, icon-192.png, icon-512.png, apple-touch-icon.png')
