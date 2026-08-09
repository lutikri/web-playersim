export type DotMatrixGlyph = readonly string[];

const GLYPHS: Record<string, DotMatrixGlyph> = {
  ' ': ['000', '000', '000', '000', '000', '000', '000'],
  ':': ['0', '0', '1', '0', '1', '0', '0'],
  '.': ['0', '0', '0', '0', '0', '0', '1'],
  '-': ['000', '000', '000', '111', '000', '000', '000'],
  '+': ['000', '010', '010', '111', '010', '010', '000'],
  '/': ['00001', '00010', '00010', '00100', '01000', '01000', '10000'],
  '>': ['10000', '01000', '00100', '00010', '00100', '01000', '10000'],
  '<': ['00001', '00010', '00100', '01000', '00100', '00010', '00001'],
  '0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  '2': ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  '3': ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
  '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  '5': ['11111', '10000', '10000', '11110', '00001', '00001', '11110'],
  '6': ['01110', '10000', '10000', '11110', '10001', '10001', '01110'],
  '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  '9': ['01110', '10001', '10001', '01111', '00001', '00001', '01110'],
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  B: ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
  C: ['01111', '10000', '10000', '10000', '10000', '10000', '01111'],
  D: ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  F: ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
  G: ['01111', '10000', '10000', '10111', '10001', '10001', '01110'],
  H: ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
  I: ['11111', '00100', '00100', '00100', '00100', '00100', '11111'],
  J: ['00111', '00010', '00010', '00010', '10010', '10010', '01100'],
  K: ['10001', '10010', '10100', '11000', '10100', '10010', '10001'],
  L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  M: ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
  N: ['10001', '11001', '10101', '10011', '10001', '10001', '10001'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  U: ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
  V: ['10001', '10001', '10001', '10001', '10001', '01010', '00100'],
  W: ['10001', '10001', '10001', '10101', '10101', '11011', '10001'],
  X: ['10001', '10001', '01010', '00100', '01010', '10001', '10001'],
  Y: ['10001', '10001', '01010', '00100', '00100', '00100', '00100'],
  Z: ['11111', '00001', '00010', '00100', '01000', '10000', '11111'],
};

export interface DotMatrixTextStyle {
  cellSize: number;
  cellGap: number;
  letterGap: number;
  color?: string;
  glowColor?: string;
  glowStrength?: number;
}

export function getDotMatrixGlyph(character: string): DotMatrixGlyph {
  return GLYPHS[character.toUpperCase()] ?? GLYPHS[' '];
}

export function measureDotMatrixText(text: string, style: DotMatrixTextStyle): number {
  return [...text].reduce((width, character, index) => {
    const glyph = getDotMatrixGlyph(character);
    const glyphWidth = glyph[0].length * style.cellSize + (glyph[0].length - 1) * style.cellGap;
    return width + glyphWidth + (index > 0 ? style.letterGap : 0);
  }, 0);
}

export function drawDotMatrixText(
  context: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  style: DotMatrixTextStyle,
): void {
  const pixels: Array<{ x: number; y: number }> = [];
  let cursorX = x;
  [...text].forEach((character, characterIndex) => {
    if (characterIndex > 0) cursorX += style.letterGap;
    const glyph = getDotMatrixGlyph(character);
    glyph.forEach((row, rowIndex) => {
      [...row].forEach((pixel, columnIndex) => {
        if (pixel !== '1') return;
        pixels.push({
          x: cursorX + columnIndex * (style.cellSize + style.cellGap),
          y: y + rowIndex * (style.cellSize + style.cellGap),
        });
      });
    });
    cursorX += glyph[0].length * style.cellSize + (glyph[0].length - 1) * style.cellGap;
  });

  context.save();
  context.fillStyle = style.glowColor ?? '#dfe7df';
  context.globalAlpha = style.glowStrength ?? 0.22;
  context.shadowColor = style.glowColor ?? '#dfe7df';
  context.shadowBlur = style.cellSize * 1.2;
  pixels.forEach((pixel) => context.fillRect(pixel.x, pixel.y, style.cellSize, style.cellSize));
  context.restore();

  context.fillStyle = style.color ?? '#cbd1ca';
  pixels.forEach((pixel) => context.fillRect(pixel.x, pixel.y, style.cellSize, style.cellSize));
}
