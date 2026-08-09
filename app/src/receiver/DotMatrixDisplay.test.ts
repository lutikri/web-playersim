import { describe, expect, it } from 'vitest';
import { getDotMatrixGlyph, measureDotMatrixText } from './DotMatrixDisplay';

describe('dot-matrix display', () => {
  it('uses explicit square-cell glyphs instead of font rendering', () => {
    expect(getDotMatrixGlyph('8')).toEqual([
      '01110', '10001', '10001', '01110', '10001', '10001', '01110',
    ]);
    expect(getDotMatrixGlyph(':')[0]).toHaveLength(1);
  });

  it('supports every weekday abbreviation used by the idle clock', () => {
    for (const day of ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN']) {
      for (const character of day) {
        expect(getDotMatrixGlyph(character).some((row) => row.includes('1'))).toBe(true);
      }
    }
  });

  it('accounts for narrow punctuation when centering a clock', () => {
    const style = { cellSize: 8, cellGap: 2, letterGap: 8 };
    expect(measureDotMatrixText('12:09', style)).toBeLessThan(measureDotMatrixText('12009', style));
  });
});
