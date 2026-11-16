// Code 128 barcode encoder (code sets B and C) producing an SVG.
// Patterns are bar/space widths for symbol values 0–105; 106 is STOP.
const P = ["212222", "222122", "222221", "121223", "121322", "131222", "122213", "122312", "132212", "221213", "221312", "231212", "112232", "122132", "122231", "113222", "123122", "123221", "223211", "221132", "221231", "213212", "223112", "312131", "311222", "321122", "321221", "312212", "322112", "322211", "212123", "212321", "232121", "111323", "131123", "131321", "112313", "132113", "132311", "211313", "231113", "231311", "112133", "112331", "132131", "113123", "113321", "133121", "313121", "211331", "231131", "213113", "213311", "213131", "311123", "311321", "331121", "312113", "312311", "332111", "314111", "221411", "431111", "111224", "111422", "121124", "121421", "141122", "141221", "112214", "112412", "122114", "122411", "142112", "142211", "241211", "221114", "413111", "241112", "134111", "111242", "121142", "121241", "114212", "124112", "124211", "411212", "421112", "421211", "212141", "214121", "412121", "111143", "111341", "131141", "114113", "114311", "411113", "411311", "113141", "114131", "311141", "411131", "211412", "211214", "211232"].concat(['2331112']);

const digitsAt = (s, i) => { let n = 0; while (i + n < s.length && s.charCodeAt(i + n) >= 48 && s.charCodeAt(i + n) <= 57) n++; return n; };

/** Returns the list of symbol values, including start, checksum and stop. Throws on unsupported characters. */
export function code128Values(text) {
  if (!text) throw new Error('Nothing to encode');
  for (const ch of text) { const c = ch.charCodeAt(0); if (c < 32 || c > 126) throw new Error('Labels support plain letters, digits and symbols only'); }
  const v = [];
  let i = 0, set;
  const lead = digitsAt(text, 0);
  if (lead === text.length ? lead >= 2 && lead % 2 === 0 : lead >= 4) { set = 'C'; v.push(105); }
  else { set = 'B'; v.push(104); }
  while (i < text.length) {
    const run = digitsAt(text, i);
    if (set === 'C') {
      if (run >= 2) { v.push(Number(text.substr(i, 2))); i += 2; }
      else { v.push(100); set = 'B'; }
      continue;
    }
    // In set B: switch to C for long digit runs (shorter barcode), keeping an odd leading digit in B.
    if (run >= 6 || (run >= 4 && i + run === text.length)) {
      if (run % 2 === 1) { v.push(text.charCodeAt(i) - 32); i++; }
      v.push(99); set = 'C';
      continue;
    }
    v.push(text.charCodeAt(i) - 32); i++;
  }
  let sum = v[0];
  for (let k = 1; k < v.length; k++) sum += v[k] * k;
  v.push(sum % 103, 106);
  return v;
}

/** Module string, e.g. "11010010000…": 1 = bar, 0 = space, without quiet zones. */
export function code128Modules(text) {
  let out = '';
  for (const val of code128Values(text)) {
    const w = P[val];
    for (let k = 0; k < w.length; k++) out += (k % 2 ? '0' : '1').repeat(Number(w[k]));
  }
  return out;
}

/** SVG barcode with a 10-module quiet zone either side; scales to its container width. */
export function code128Svg(text, { height = 40 } = {}) {
  const m = code128Modules(text), q = 10, w = m.length + 2 * q;
  let rects = '', x = 0;
  while (x < m.length) {
    if (m[x] === '1') { let e = x; while (e < m.length && m[e] === '1') e++; rects += `<rect x="${x + q}" y="0" width="${e - x}" height="${height}"/>`; x = e; }
    else x++;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${height}" preserveAspectRatio="none" shape-rendering="crispEdges" role="img" aria-label="Barcode ${text.replace(/[<>&"]/g, '')}"><rect width="${w}" height="${height}" fill="#fff"/><g fill="#000">${rects}</g></svg>`;
}
