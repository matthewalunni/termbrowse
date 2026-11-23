export function saneSize(term) {
  return term.pxW > 0 && term.pxH > 0 && term.cols > 0 && term.rows > 0
    && term.cols <= 500 && term.rows <= 300;
}

// Fit an image into cols x (rows-1) cells (last row is the status line), keeping aspect.
export function fit(img, term) {
  const cellW = term.pxW / term.cols;
  const cellH = term.pxH / term.rows;
  const maxCols = term.cols;
  const maxRows = Math.max(1, term.rows - 1);
  const scale = Math.min((maxCols * cellW) / img.width, (maxRows * cellH) / img.height);
  const eps = 1e-9;
  const cols = Math.min(maxCols, Math.max(1, Math.floor((img.width * scale) / cellW + eps)));
  const rows = Math.min(maxRows, Math.max(1, Math.floor((img.height * scale) / cellH + eps)));
  return { cols, rows };
}

export function screencastSize(term) {
  const cellH = term.pxH / term.rows;
  return {
    maxWidth: Math.min(2000, Math.round(term.pxW)),
    maxHeight: Math.min(1600, Math.round(cellH * Math.max(1, term.rows - 1))),
  };
}

// 1-based terminal cell -> CSS page coordinates (cell centre), or null outside the image.
export function cellToPage(col, row, place, term, viewport) {
  if (col < 1 || row < 1 || col > place.cols || row > place.rows) return null;
  return {
    x: ((col - 0.5) / place.cols) * viewport.width,
    y: ((row - 0.5) / place.rows) * viewport.height,
  };
}
