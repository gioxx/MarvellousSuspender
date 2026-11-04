import { describe, it, expect } from 'vitest';
import { gsUtils } from '../src/js/gsUtils.js';

// Locale messages come from translators. A few use <i>, <em>, <strong>, <b> or <br> on
// purpose; anything else in them is shown as the text it is.
describe('gsUtils.parseLocalisedMarkup', () => {
  const parse = (text) => gsUtils.parseLocalisedMarkup(text);

  it('returns plain text as one text node', () => {
    expect(parse('Suspend this tab')).toEqual(['Suspend this tab']);
  });

  it('turns the allowed tags into elements', () => {
    expect(parse('marvellous-<i>er</i>')).toEqual(['marvellous-', { tag: 'i', children: ['er'] }]);
    expect(parse('a <strong>b</strong> <em>c</em> <b>d</b>')).toEqual([
      'a ', { tag: 'strong', children: ['b'] }, ' ', { tag: 'em', children: ['c'] }, ' ', { tag: 'b', children: ['d'] },
    ]);
  });

  it('nests allowed tags', () => {
    expect(parse('<strong>a <i>b</i></strong>')).toEqual([
      { tag: 'strong', children: ['a ', { tag: 'i', children: ['b'] }] },
    ]);
  });

  it('reads tag names in any case', () => {
    expect(parse('<STRONG>a</Strong>')).toEqual([{ tag: 'strong', children: ['a'] }]);
  });

  it('turns <br>, <br/> and <br /> into a line break', () => {
    const br = { tag: 'br', children: [] };
    expect(parse('a<br>b<br/>c<br />d')).toEqual(['a', br, 'b', br, 'c', br, 'd']);
  });

  // localiseHtml turned a newline into <br /> after the message; getMessage() call sites
  // wrote it as it is, and a newline in HTML text shows as a space.
  it('keeps a newline as text unless asked to make it a line break', () => {
    const br = { tag: 'br', children: [] };
    expect(parse('first\nsecond')).toEqual(['first\nsecond']);
    expect(gsUtils.parseLocalisedMarkup('first\nsecond', { newlines: true })).toEqual(['first', br, 'second']);
    // <br /> then a newline was two line breaks before as well
    expect(gsUtils.parseLocalisedMarkup('a<br>\nb', { newlines: true })).toEqual(['a', br, br, 'b']);
  });

  it('keeps any other tag as text', () => {
    expect(parse('see <a href="https://example.org">here</a>')).toEqual(['see <a href="https://example.org">here</a>']);
    expect(parse('<img src=x><script>x</script><form><input>')).toEqual(['<img src=x><script>x</script><form><input>']);
    expect(parse('<bx>a</bx> <b-x>b')).toEqual(['<bx>a</bx> <b-x>b']);
  });

  it('drops the attributes of an allowed tag', () => {
    expect(parse('<b id="probe" class=x>a</b>')).toEqual([{ tag: 'b', children: ['a'] }]);
    expect(parse('<i onclick="x()">a</i>')).toEqual([{ tag: 'i', children: ['a'] }]);
  });

  // Translator typos are read the way the HTML parser reads them, without a tag showing.
  it('closes up to the open tag a closing tag matches', () => {
    expect(parse('<b><i>x</b>y</i>z')).toEqual([{ tag: 'b', children: [{ tag: 'i', children: ['x'] }] }, 'yz']);
    expect(parse('<strong>a <em>b</strong> c')).toEqual([{ tag: 'strong', children: ['a ', { tag: 'em', children: ['b'] }] }, ' c']);
  });

  it('drops a closing tag that closes nothing', () => {
    expect(parse('a</b>c')).toEqual(['ac']);
    expect(parse('<i>a</b>c</i>')).toEqual([{ tag: 'i', children: ['ac'] }]);
  });

  it('turns </br> into a line break', () => {
    expect(parse('a</br>b')).toEqual(['a', { tag: 'br', children: [] }, 'b']);
  });

  it('keeps an unclosed tag open to the end', () => {
    expect(parse('a <b>b <i>c')).toEqual(['a ', { tag: 'b', children: ['b ', { tag: 'i', children: ['c'] }] }]);
  });

  it('leaves entities as text', () => {
    expect(parse('a &amp; b &lt;i&gt;')).toEqual(['a &amp; b &lt;i&gt;']);
  });

  it('treats a missing message as empty', () => {
    expect(parse(undefined)).toEqual([]);
    expect(parse(null)).toEqual([]);
    expect(parse('')).toEqual([]);
  });
});

// A minimal document: enough of the DOM for setLocalisedContent, and a serialiser that
// writes text escaped, so a tag kept as text cannot pass for an element.
function fakeDocument() {
  const escape = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const doc = {
    createTextNode: (data) => ({ nodeType: 3, data }),
    createElement: (localName) => fakeElement(localName),
  };
  function fakeElement(localName) {
    const el = {
      nodeType: 1,
      localName,
      ownerDocument: doc,
      childNodes: [],
      attributes: {},
      appendChild(node) { el.childNodes.push(node); return node; },
      replaceChildren(...nodes) { el.childNodes = [...nodes]; },
      get textContent() {
        return el.childNodes.map((node) => (node.nodeType === 3 ? node.data : node.textContent)).join('');
      },
      set textContent(value) { el.childNodes = value ? [doc.createTextNode(value)] : []; },
      get html() {
        return el.childNodes.map((node) => {
          if (node.nodeType === 3) return escape(node.data);
          const attrs = Object.keys(node.attributes).length ? ' +attrs' : '';
          return node.localName === 'br' ? `<br${attrs}>` : `<${node.localName}${attrs}>${node.html}</${node.localName}>`;
        }).join('');
      },
    };
    return el;
  }
  return doc;
}

describe('gsUtils.setLocalisedContent', () => {
  const render = (text, tag = 'p', options) => {
    const el = fakeDocument().createElement(tag);
    el.textContent = 'replaced';
    gsUtils.setLocalisedContent(el, text, options);
    return el;
  };

  it('replaces what the element held', () => {
    expect(render('plain').html).toBe('plain');
    expect(render(undefined).html).toBe('');
  });

  it('builds the allowed tags as elements, without attributes, in any case', () => {
    expect(render('a <I>b</I> <STRONG class=x>c</strong> <em onclick="x()">d</em> <b id=probe>e</b>').html)
      .toBe('a <i>b</i> <strong>c</strong> <em>d</em> <b>e</b>');
  });

  it('nests them and closes an unclosed one at the end', () => {
    expect(render('<strong>a <i>b</i> c<br>d <em>e').html).toBe('<strong>a <i>b</i> c<br>d <em>e</em></strong>');
  });

  it('writes any other tag as text', () => {
    expect(render('see <a href="https://example.org">here</a><img src=x onerror=x()>').html)
      .toBe('see &lt;a href="https://example.org"&gt;here&lt;/a&gt;&lt;img src=x onerror=x()&gt;');
  });

  it('writes entities as the text they are', () => {
    const el = render('Fish &amp; Chips &lt;i&gt;');
    expect(el.textContent).toBe('Fish &amp; Chips &lt;i&gt;');
    expect(el.html).toBe('Fish &amp;amp; Chips &amp;lt;i&amp;gt;');
  });

  it('keeps a newline as text unless asked for line breaks', () => {
    expect(render('a\nb').html).toBe('a\nb');
    expect(render('a\nb', 'p', { newlines: true }).html).toBe('a<br>b');
  });

  // document.title and the tab strip read only the text a <title> holds directly.
  it('gives a <title> the text of the message, without its tags', () => {
    const title = render('The Marvellous Suspender - is ready to get marvellous-<i>er</i>', 'title');
    expect(title.childNodes).toEqual([{ nodeType: 3, data: 'The Marvellous Suspender - is ready to get marvellous-er' }]);
    expect(render('a<br>b <strong>c</strong> <a href=x>d</a>', 'title', { newlines: true }).html)
      .toBe('a b c &lt;a href=x&gt;d&lt;/a&gt;');
  });
});
