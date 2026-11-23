const ESC = '\x1b';
const CHUNK = 4096;

export function pngSize(b64) {
  const buf = Buffer.from(b64.slice(0, 44), 'base64');
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

export function encodeFrame(b64png, place, id = 1) {
  let out = `${ESC}[H`;
  for (let i = 0; i < b64png.length || i === 0; i += CHUNK) {
    const chunk = b64png.slice(i, i + CHUNK);
    const m = i + CHUNK < b64png.length ? 1 : 0;
    const ctl = i === 0
      ? `a=T,f=100,i=${id},p=1,c=${place.cols},r=${place.rows},C=1,q=2,m=${m}`
      : `m=${m}`;
    out += `${ESC}_G${ctl};${chunk}${ESC}\\`;
  }
  return out;
}

export function deleteAll() {
  return `${ESC}_Ga=d,d=A,q=2${ESC}\\`;
}

// Deletes one image by id, freeing its data (uppercase I).
export function deleteImage(id) {
  return `${ESC}_Ga=d,d=I,i=${id},q=2${ESC}\\`;
}

export function enterScreen() {
  return `${ESC}[?1049h${ESC}[?25l${ESC}[2J${ESC}[H`;
}

export function leaveScreen() {
  return `${deleteAll()}${ESC}[?1000l${ESC}[?1006l${ESC}[?25h${ESC}[?1049l`;
}

export function kittyQuery() {
  return `${ESC}_Gi=31,s=1,v=1,a=q,t=d,f=24;AAAA${ESC}\\${ESC}[c`;
}

export function parseKittyReply(buf) {
  if (buf.includes(`${ESC}_Gi=31;OK`)) return true;
  if (/\x1b\[\?[0-9;]*c/.test(buf)) return false;
  return null;
}
