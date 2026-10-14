/* Exact quantiles away from the interactive 3D rendering thread. */
'use strict';
importScripts('../lib/roi-distribution.js');
self.onmessage = event => {
  const { id, values, maxPoints, includeUpperTailValues } = event.data;
  try {
    const distribution = self.RoiDistribution.summarize(values, { maxPoints, includeUpperTailValues });
    const tail = distribution && distribution.upperTailValues;
    self.postMessage({ id, distribution }, tail ? [tail.buffer] : []);
  } catch (error) {
    self.postMessage({ id, error: error.message || String(error) });
  }
};
