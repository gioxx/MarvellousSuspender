const links = [
  {
    href: 'https://github.com/sponsors/gioxx',
    img: 'img/favicon-github.png',
    label: 'GitHub Sponsors',
    heartBadge: true,
  },
  {
    href: 'https://ko-fi.com/gioxx',
    img: 'img/favicon-kofi.ico',
    label: 'Ko-fi',
  },
  {
    href: 'https://www.buymeacoffee.com/gioxx',
    img: 'img/favicon-buymeacoffee.ico',
    label: 'Buy Me a Coffee',
  },
];

const SVG_NS = 'http://www.w3.org/2000/svg';

function makeHeartSvg() {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.classList.add('donateBar-heart');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', 'M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z');
  svg.appendChild(path);
  return svg;
}

const nav = document.querySelector('.contentNav');
if (nav) {
  const bar = document.createElement('div');
  bar.className = 'donateBar';

  for (const { href, img, label, heartBadge } of links) {
    const a = document.createElement('a');
    a.href = href;
    a.target = '_blank';
    a.title = label;
    a.setAttribute('aria-label', label);
    a.rel = 'noopener noreferrer';

    if (heartBadge) {
      const wrap = document.createElement('span');
      wrap.className = 'donateBar-badge';
      const icon = document.createElement('img');
      icon.src = img;
      icon.alt = '';
      icon.setAttribute('aria-hidden', 'true');
      icon.width = 16;
      icon.height = 16;
      wrap.appendChild(icon);
      wrap.appendChild(makeHeartSvg());
      a.appendChild(wrap);
    } else {
      const icon = document.createElement('img');
      icon.src = img;
      icon.alt = '';
      icon.setAttribute('aria-hidden', 'true');
      icon.width = 16;
      icon.height = 16;
      a.appendChild(icon);
    }

    bar.appendChild(a);
  }

  nav.appendChild(bar);
}
