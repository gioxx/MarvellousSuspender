import { describe, it, expect } from 'vitest';
import { gsUtils } from '../src/js/gsUtils.js';

// Just enough of an element for localiseHtml(): attributes only, no children.
function fakeElement(attributes) {
  const attrs = new Map(Object.entries(attributes));
  return {
    hasAttribute: (name) => attrs.has(name),
    getAttribute: (name) => attrs.get(name) ?? null,
    setAttribute: (name, value) => attrs.set(name, String(value)),
    attrs,
  };
}

// The help tooltip is a ::after shown on hover; localiseHtml() also makes its icon reachable
// from the keyboard and readable by screen readers.
describe('gsUtils.localiseHtml on a help tooltip', () => {
  const localise = (tooltip) => {
    const el = fakeElement({ 'data-i18n-tooltip': tooltip });
    gsUtils.localiseHtml({ getElementsByTagName: () => [el] });
    return el.attrs;
  };

  it('fills in the messages, keeping the line breaks of the template', () => {
    // the chrome stub's getMessage() returns the key
    expect(localise('__MSG_first_line1__\n\n__MSG_first_line2__').get('data-i18n-tooltip')).toBe('first_line1\n\nfirst_line2');
  });

  it('makes the icon focusable and labels it with the tooltip text', () => {
    const attrs = localise('__MSG_some_tooltip_line1__');
    expect(attrs.get('tabindex')).toBe('0');
    expect(attrs.get('role')).toBe('img');
    expect(attrs.get('aria-label')).toBe('some_tooltip_line1');
  });
});
