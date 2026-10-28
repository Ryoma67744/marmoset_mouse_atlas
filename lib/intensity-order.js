/* Presentation order only; preserve input objects and stable identities. */
(function (global) {
  'use strict';
  function sortByValue(items, getValue) {
    return items.map((item, index) => ({ item, index, value: getValue(item) })).sort((a, b) => {
      const av = Number.isFinite(a.value), bv = Number.isFinite(b.value);
      if (av !== bv) return av ? -1 : 1;
      if (av && a.value !== b.value) return a.value > b.value ? -1 : 1;
      return a.index - b.index;
    }).map(entry => entry.item);
  }
  global.IntensityOrder = { sortByValue };
})(window);
