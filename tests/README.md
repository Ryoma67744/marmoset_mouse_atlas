# Verification

The production app remains a static browser app; npm dependencies are development-only.

```sh
npm ci
npm test
npx playwright install --with-deps chromium
npm run test:browser
```

`npm test` checks the numerical engine, Otsu recipes, real SheetJS XLSX / JSZip
round-trips, source syntax, and backward-compatible raw tables. Sheet-limit tests
lower the row ceiling in an isolated VM to exercise the production split path
without allocating a million-row workbook.

Browser tests use actual Chromium, IndexedDB, the app's UI and synthetic rasters.
They block external requests, substitute minimal layout CSS for the Tailwind CDN,
and simulate cloud compare-and-swap responses. They test behavior, not exact
production-CDN styling or a real authenticated Supabase deployment. They do not
access any registered research data or credentials.

For an already-installed compatible Chromium, set
`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`; optional `PLAYWRIGHT_CHROMIUM_ARGS` is a JSON
array of launch arguments. CI installs Chromium through Playwright normally.

Key invariants: source Float32 arrays are immutable; derived tables preserve the
raw row universe; Otsu never enters analytical ROI calculations; DA/NE do not use
local D4 denominators; reference snapshots and ranges are fixed; absolute values
require a compatible ROI calibration; unavailable values are not zero-filled;
stale Viewer saves cannot erase newer Master settings.

These checks verify software behavior, **not scientific validation** of an assay,
spray uniformity, cross-analyte normalization, saturation thresholds, calibration,
or the completeness of any real study. Such validation requires the experimental
raw data, QC evidence and calibration records.
