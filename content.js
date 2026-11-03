(() => {
  'use strict';

  // Extension runs locally in the browser. No remote requests or Ozon API calls.
  const STORE_PATH = /^\/app\/items\/store\/?$/;
  const HEADER_ATTR = 'data-ozrp-header';
  const CELL_ATTR = 'data-ozrp-cell';
  const HEADER_SELECTOR = `[${HEADER_ATTR}]`;
  const CELL_SELECTOR = `[${CELL_ATTR}]`;
  const currencyFormatter = new Intl.NumberFormat('ru-RU', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

  let refreshTimer = null;

  function normalizedHeading(text) {
    // Ignore hyphens, all whitespace and sort icons in table headings.
    return (text || '')
      .toLocaleLowerCase('ru-RU')
      .replace(/[^а-яёa-z0-9]/giu, '');
  }

  function parseMoney(text) {
    // First displayed price in a cell. Spaces / NBSP / NNBSP separate thousands.
    const found = (text || '').match(/\d[\d\s\u00a0\u202f]*(?:[,.]\d{1,2})?/u);
    if (!found) return null;
    const number = Number(found[0].replace(/[\s\u00a0\u202f]/g, '').replace(',', '.'));
    return Number.isFinite(number) && number >= 0 ? number : null;
  }

  function parseReviews(text) {
    const found = (text || '').match(/\d[\d\s\u00a0\u202f]*/u);
    if (!found) return null;
    const number = Number(found[0].replace(/[\s\u00a0\u202f]/g, ''));
    return Number.isSafeInteger(number) && number >= 0 ? number : null;
  }

  function isInCart(cell) {
    if (!cell) return false;
    const label = `${cell.textContent || ''} ${cell.querySelector('button')?.getAttribute('aria-label') || ''}`;
    return /убрать\s+из\s+корзины|удалить\s+из\s+корзины|в\s+корзине/iu.test(label);
  }

  function getColumns(table) {
    const headRow = table.tHead?.rows?.[0];
    if (!headRow) return null;

    // Ignore previously added column when identifying native Ozon column indexes.
    const nativeHeaders = [...headRow.children].filter(
      (node) => node.tagName === 'TH' && !node.hasAttribute(HEADER_ATTR)
    );
    const texts = nativeHeaders.map((node) => normalizedHeading(node.textContent));
    const find = (label) => texts.findIndex((text) => text === label || text.startsWith(label));
    const reviewsIndex = find('отзывы');
    const ratingIndex = find('контентрейтинг');
    const priceIndex = find('ценакарточки');
    const nameIndex = find('названиетовара');

    if (reviewsIndex < 0 || ratingIndex < 0 || priceIndex < 0 || nameIndex < 0) return null;
    return {
      headRow,
      ratingHeader: nativeHeaders[ratingIndex],
      reviewsIndex,
      ratingIndex,
      priceIndex,
      nameIndex,
      cartIndex: priceIndex + 1,
    };
  }

  function ensureHeader(columns) {
    let header = [...columns.headRow.children].find((node) => node.hasAttribute(HEADER_ATTR));
    if (!header) {
      header = columns.ratingHeader.cloneNode(false);
      header.setAttribute(HEADER_ATTR, '');
      header.textContent = 'Цена за отзыв';
    }
    // Ozon can replace/reorder table nodes after filter changes.
    if (columns.ratingHeader.nextElementSibling !== header) {
      columns.ratingHeader.after(header);
    }
  }

  function ensureCell(row, columns) {
    const allCells = [...row.children].filter((node) => node.tagName === 'TD');
    const nativeCells = allCells.filter((node) => !node.hasAttribute(CELL_ATTR));
    if (nativeCells.length <= columns.cartIndex) return null;

    let cell = allCells.find((node) => node.hasAttribute(CELL_ATTR));

    // Empty Ozon loading placeholders are not real offers. Do not insert cells.
    const name = nativeCells[columns.nameIndex].textContent.trim();
    const hasData = nativeCells[columns.priceIndex].textContent.trim()
      || nativeCells[columns.reviewsIndex].textContent.trim();
    if (!name && !hasData) {
      cell?.remove();
      return null;
    }

    if (!cell) {
      // Clone the neighboring Ozon cell to preserve the current table's styling.
      cell = nativeCells[columns.ratingIndex].cloneNode(false);
      cell.setAttribute(CELL_ATTR, '');
      cell.innerHTML = '<div class="ozrp-amount"></div><div class="ozrp-best" hidden>Лучший оффер</div>';
    }
    if (nativeCells[columns.ratingIndex].nextElementSibling !== cell) {
      nativeCells[columns.ratingIndex].after(cell);
    }
    return {
      cell,
      reviewCell: nativeCells[columns.reviewsIndex],
      priceCell: nativeCells[columns.priceIndex],
      nameCell: nativeCells[columns.nameIndex],
      cartCell: nativeCells[columns.cartIndex],
    };
  }

  function setCellContent(cell, cost, isBest) {
    let amount = cell.querySelector('.ozrp-amount');
    let best = cell.querySelector('.ozrp-best');
    if (!amount || !best) {
      cell.replaceChildren();
      amount = document.createElement('div');
      amount.className = 'ozrp-amount';
      best = document.createElement('div');
      best.className = 'ozrp-best';
      best.textContent = 'Лучший оффер';
      cell.append(amount, best);
    }

    const nextText = cost === null ? '—' : `${currencyFormatter.format(cost)} ₽`;
    if (amount.textContent !== nextText) amount.textContent = nextText;
    if (best.hidden === isBest) best.hidden = !isBest;
    cell.classList.toggle('ozrp-cheap', cost !== null && cost < 100);
    cell.classList.toggle('ozrp-winner', isBest);
  }

  function scanTable(table) {
    const columns = getColumns(table);
    if (!columns) return;
    ensureHeader(columns);
    const entries = [];

    for (const row of table.tBodies[0]?.rows || []) {
      const cells = ensureCell(row, columns);
      if (!cells) continue;

      const price = parseMoney(cells.priceCell.textContent);
      const reviews = parseReviews(cells.reviewCell.textContent);
      const cost = price !== null && reviews !== null && reviews > 0 ? price / reviews : null;
      entries.push({ cell: cells.cell, cost, inCart: isInCart(cells.cartCell) });
    }

    // Only visible/current-page offers, and only those NOT already in cart.
    let bestEntry = null;
    for (const entry of entries) {
      if (entry.inCart || entry.cost === null) continue;
      if (bestEntry === null || entry.cost < bestEntry.cost) bestEntry = entry;
    }
    for (const entry of entries) {
      setCellContent(entry.cell, entry.cost, entry === bestEntry);
    }
  }

  function refresh() {
    if (!STORE_PATH.test(location.pathname)) return;
    for (const table of document.querySelectorAll('table')) scanTable(table);
  }

  function scheduleRefresh() {
    if (refreshTimer !== null) return;
    refreshTimer = window.setTimeout(() => {
      refreshTimer = null;
      refresh();
    }, 70);
  }

  function isExtensionNode(node) {
    if (node.nodeType !== Node.ELEMENT_NODE) return false;
    return node.hasAttribute(HEADER_ATTR) || node.hasAttribute(CELL_ATTR);
  }

  function isOwnChange(mutation) {
    const target = mutation.target.nodeType === Node.ELEMENT_NODE
      ? mutation.target
      : mutation.target.parentElement;
    if (target?.closest(`${HEADER_SELECTOR}, ${CELL_SELECTOR}`)) return true;
    if (mutation.type !== 'childList') return false;
    const changed = [...mutation.addedNodes, ...mutation.removedNodes];
    return changed.length > 0 && changed.every(isExtensionNode);
  }

  // Observe Vue updates: new rows, sorting, filters, pagination and cart button text.
  const observer = new MutationObserver((mutations) => {
    if (mutations.some((mutation) => !isOwnChange(mutation))) scheduleRefresh();
  });
  observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', scheduleRefresh, { once: true });
  } else {
    scheduleRefresh();
  }
})();
