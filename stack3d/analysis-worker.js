/* Exact quantiles away from the interactive 3D rendering thread. */
'use strict';
importScripts('../lib/roi-distribution.js');
self.onmessage = event => {
  const { id, values, maxPoints } = event.data;
  try {
    self.postMessage({ id, distribution: self.RoiDistribution.summarize(values, { maxPoints }) });
  } catch (error) {
    self.postMessage({ id, error: error.message || String(error) });
  }
};
