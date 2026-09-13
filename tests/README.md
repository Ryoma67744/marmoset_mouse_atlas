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

Folder normalization in v2.10 adds a second-level group boundary: the selected
folder and every descendant form one target set, while root/first-level datasets
remain outside the automatic groups. Reference datasets and common ranges must
stay inside that group. Each section retains its own `k = D_ref / D_s`, shared
only between DA and NE within that section; 5-HT pixel ratios keep the same formula.

Additional verification covers same-named folders under different parents,
descendant membership, malformed hierarchies, independent group references and
ranges, and schema-1 profile compatibility. Saving checks the target set and
folder structure as well as project revisions, so a concurrent rename, move,
addition or deletion cannot save an outdated preview. Current location bindings
are distinct from the immutable calculation snapshot: cross-group moves block
old derived channels, and subset ZIP restoration preserves the saved reference
and range without recomputing from the restored subset. Viewer and Excel expose
the calculation group, path and profile revision for traceability.

The v2.10.1 regression coverage adds missing-profile raw display, settings saved
while a Viewer remains open, stale Master rename/open paths, and imports
that race another tab's save. Ordinary metadata changes preserve newer profile
fields, cloud state saves verify their actual baseline, and ZIP restoration
checks project/folder revisions at the final commit. Tests also compare Viewer
and Excel decisions against current folder membership, distinguish explicit null
bindings from unknown standalone context, and exercise repaired group IDs on
another local folder tree. Generic CSV/Excel imports keep missing cells distinct
from real zero; previously imported zero values are not reclassified.

Previews report finite derived output by target role, including valid 5-HT ratios
when a DA/NE factor is unavailable. A wholly unavailable profile cannot be saved,
including as a replacement for existing usable settings. These scenarios use synthetic data and mock cloud
responses; they do not recover or alter any lost real-study profile.

Viewer refresh tests cover same-browser storage notifications and cloud checks on
load/focus, preserving drafts that begin during network requests. A profile
refresh disables the active Otsu display mask without writing that transient
change back on refresh alone. Storage/import tests cover atomic project/folder
commit, staged-blob cleanup, failed acknowledgements, and guarded source merges.
Merge regressions retain a remotely updated source, and stale-list regressions
prevent an older folder listing from moving a project back. Offline name changes
remain distinct from acknowledged cloud metadata and can be retried safely.
Tests use synthetic data and simulated cloud responses; live cross-PC network
propagation and the production deployment are outside this local test harness.

These checks verify software behavior, **not scientific validation** of an assay,
spray uniformity, cross-analyte normalization, saturation thresholds, calibration,
or the completeness of any real study. Such validation requires the experimental
raw data, QC evidence and calibration records.
