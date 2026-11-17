import { describe, expect, it } from 'vitest';
import { applyCommand, headingAnchorAt, type Edit } from '../../src/shared/markdown-edit';
import { documentToHtml, DEFAULT_DOCUMENT_SETTINGS } from '../../src/shared/documents';

function run(text: string, start: number, end: number, command: Parameters<typeof applyCommand>[2]) {
  const edit: Edit = applyCommand(text, { start, end }, command);
  const out = text.slice(0, edit.from) + edit.insert + text.slice(edit.to);
  return { out, selected: out.slice(edit.select.start, edit.select.end) };
}

describe('bold and italic', () => {
  it('wrap the selection and select the words inside', () => {
    expect(run('make this bold', 5, 9, 'bold')).toEqual({ out: 'make **this** bold', selected: 'this' });
    expect(run('make this', 5, 9, 'italic')).toEqual({ out: 'make *this*', selected: 'this' });
  });

  it('insert a placeholder with nothing selected', () => {
    expect(run('ab', 1, 1, 'bold')).toEqual({ out: 'a**bold text**b', selected: 'bold text' });
  });

  it('remove the marks when pressed again', () => {
    expect(run('make **this** bold', 7, 11, 'bold')).toEqual({ out: 'make this bold', selected: 'this' });
    expect(run('make **this** bold', 5, 13, 'bold')).toEqual({ out: 'make this bold', selected: 'this' });
  });

  it('keep spaces outside the marks, which Markdown needs', () => {
    expect(run('a word b', 1, 7, 'bold').out).toBe('a **word** b');
  });
});

describe('line formats', () => {
  it('turn lines into a list, and back', () => {
    const list = run('one\ntwo\n\nthree', 0, 7, 'bullets');
    expect(list.out).toBe('- one\n- two\n\nthree');
    expect(run(list.out, 0, 11, 'bullets').out).toBe('one\ntwo\n\nthree');
  });

  it('number lines, converting bullets, and skip blank lines', () => {
    expect(run('- a\n\n- b', 0, 8, 'numbers').out).toBe('1. a\n\n2. b');
  });

  it('switch heading levels instead of stacking marks', () => {
    expect(run('Title', 2, 2, 'h2').out).toBe('## Title');
    expect(run('## Title', 4, 4, 'h3').out).toBe('### Title');
    expect(run('### Title', 4, 4, 'h3').out).toBe('Title');
  });

  it('apply to the whole line the cursor is on', () => {
    expect(run('first\nsecond line\nthird', 9, 9, 'quote').out).toBe('first\n> second line\nthird');
  });

  it('do not take in the next line when the selection ends at its start', () => {
    expect(run('a\nb\n', 0, 2, 'bullets').out).toBe('- a\nb\n');
  });
});

describe('blocks', () => {
  it('put a table on its own lines with blank lines around it', () => {
    const { out, selected } = run('Intro\nMore', 5, 5, 'table');
    expect(out).toBe('Intro\n\n| Column | Column |\n| --- | --- |\n| Text | Text |\n\nMore');
    expect(selected).toBe('Column');
  });

  it('add a divider at the start without extra lines', () => {
    expect(run('', 0, 0, 'rule').out).toBe('---');
  });
});

describe('preview follows the cursor', () => {
  const md = '# Title\n\nIntro text\n\n## First\n\n- a\n- b\n\n## Second\n\nBody';
  it('finds the heading of the section being edited, using the page anchors', () => {
    expect(headingAnchorAt(md, 0)).toBeNull();
    expect(headingAnchorAt(md, md.indexOf('Intro'))).toBe('h0');
    expect(headingAnchorAt(md, md.indexOf('- b'))).toBe('h2');
    expect(headingAnchorAt(md, md.length)).toBe('h4');
    // The anchors exist in the rendered page.
    const html = documentToHtml({ title: 'T', markdown: md, settings: DEFAULT_DOCUMENT_SETTINGS, source: null, transcript: null }, '');
    for (const a of ['h0', 'h2', 'h4']) expect(html).toContain(`id="${a}"`);
    expect(html).toContain('id="h4" dir="auto">Second<');
  });
});
