import { createHash } from 'node:crypto';

export const INDEX_VERSION = `intl-zh-word-v1/icu-${process.versions.icu}`;
const words = new Intl.Segmenter('zh', { granularity: 'word' });
export const hashText = text => createHash('sha256').update(text, 'utf8').digest('hex');
export const codePoints = text => Array.from(text);

/** Index text is derived. Never normalize, trim or replace the saved source. */
export function tokenize(text) {
  return [...words.segment(text.normalize('NFKC').toLowerCase())]
    .filter(item => item.isWordLike).map(item => item.segment);
}

export function queryTerms(question) {
  const stopwords = new Set(['什么', '哪些', '这个', '那个', '如何', '为什么', '是否', '请问', '介绍', '说明', '比较', '对比', '的', '是', '了', '吗', '呢', '和', '与', '在', '有', '请', 'what', 'how', 'the', 'is', 'a', 'an', 'of', 'and', 'or', 'to']);
  return [...new Set(tokenize(question))].filter(term => !stopwords.has(term)).slice(0, 32);
}

/** All MATCH operands are literals, even if the question contains FTS operators. */
export function literalMatch(terms) {
  return terms.map(term => `"${term.replaceAll('"', '""')}"`).join(' OR ');
}

export function substringTerms(question) {
  const terms = queryTerms(question).filter(term => [...term].length >= 2 && [...term].length <= 16);
  // Two-character Chinese terms and short acronyms must not depend on the segmenter dictionary.
  for (const run of question.normalize('NFKC').toLowerCase().match(/[\p{Script=Han}]+/gu) || []) {
    const points = codePoints(run);
    for (let i = 0; i + 1 < points.length; i++) terms.push(points.slice(i, i + 2).join(''));
  }
  const stopwords = new Set(['什么', '哪些', '如何', '为何', '是否', '请问', '这个', '那个', '介绍', '说明', '比较', '对比']);
  return [...new Set(terms)].filter(term => !stopwords.has(term)).slice(0, 40);
}

/** Offsets are Unicode code points, [start,end); slices always reproduce raw input. */
export function chunkText(text, { target = 800, minimum = 600, maximum = 1000, overlap = 100 } = {}) {
  if (!(minimum >= 600 && maximum <= 1000 && minimum <= target && target <= maximum && overlap >= 80 && overlap <= 120)) {
    throw new TypeError('Invalid chunk configuration');
  }
  const points = codePoints(text), result = [];
  const protectedRanges = [];
  let utf16Offset = 0;
  for (const paragraph of text.split(/(?<=\n)[ \t\r]*\n/u)) {
    const length = codePoints(paragraph).length;
    const utf16Start = text.indexOf(paragraph, utf16Offset);
    const start = codePoints(text.slice(0, utf16Start)).length;
    if (length <= maximum && (paragraph.split('\n').filter(line => /^\s*\|/.test(line)).length >= 2 || /\$\$|\\\[|\\\]/.test(paragraph))) {
      protectedRanges.push({ start, end: start + length });
    }
    utf16Offset = utf16Start + paragraph.length;
  }
  let start = 0;
  while (start < points.length) {
    let end = Math.min(start + target, points.length);
    if (points.length - start > maximum) {
      const boundaries = [];
      for (let position = start + minimum; position <= Math.min(start + maximum, points.length); position++) {
        const previous = points[position - 1];
        if (previous === '\n' || /[。！？.!?；;]/u.test(previous)) {
          const paragraph = previous === '\n' && (points[position - 2] === '\n' || points[position] === '\n');
          boundaries.push({ position, distance: Math.abs(position - (start + target)), paragraph });
        }
      }
      boundaries.sort((a, b) => Number(b.paragraph) - Number(a.paragraph) || a.distance - b.distance || a.position - b.position);
      end = boundaries[0]?.position ?? end;
      const protectedRange = protectedRanges.find(range => end > range.start && end < range.end);
      if (protectedRange) {
        if (protectedRange.end - start <= maximum) end = protectedRange.end;
        else if (protectedRange.start - start >= minimum) end = protectedRange.start;
      }
    } else end = points.length;
    const body = points.slice(start, end).join('');
    const before = points.slice(0, start).join('');
    const heading = [...before.matchAll(/^(?:#{1,6}\s+[^\r\n]+|第[^\r\n]{1,35}[章节][^\r\n]*)/gm)].at(-1)?.[0] || '';
    result.push({ ordinal: result.length, start, end, text: body, sha256: hashText(body), heading });
    if (end === points.length) break;
    start = end - overlap;
  }
  return result;
}
