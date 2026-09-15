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
raw row universe; Otsu never enters analytical ROI calculations; section-scaled
analytes do not use local D4 denominators; reference snapshots and ranges are fixed; absolute values
require a compatible ROI calibration; unavailable values are not zero-filled;
stale Viewer saves cannot erase newer Master settings.

The v2.14 3D tests cover numeric coronal ordering and ordinal Z, saved XY pitch
and arbitrary rotation, missing-correction exclusion, source-array preservation,
and optional placement metadata through cloud state and real ZIP round trips.
The browser suite exercises Master selection, WebGL rendering, controls,
section-detail navigation and return state, and concurrent placement/ROI edits.
Only synthetic rasters are committed; private study data is not a test fixture.

The v2.20 alignment candidates use exact-name ROI union-mask pixel centroids in
physical coordinates from both immediate loaded neighbors. Numerical checks
cover unequal XY pitch, saved rotation and offsets, proper rigid composition,
equal ROI weights, edge/area defaults and degenerate cases. Browser regressions
cover read-only calculation, ROI choice, preview/original comparison, manual
tuning, cancellation to a pre-existing draft, explicit adoption and placement-only
save/reload. Changes to central or neighboring ROI/geometry/placement invalidate
the candidate's save dependencies. Raw rasters remain bitwise identical and the
normalization, ROI, image-registration and display metadata remain unchanged.
These checks validate the software workflow, not anatomical registration accuracy.

The v2.21 whole-stack candidate jointly minimizes second differences of ROI
centroids with a fixed placement prior (lambda=1), using proper rigid XY poses.
Tests cover known jitter, preservation of linear ROI trajectories and physical
scale, disconnected intervals, endpoint support, coordinate equivariance and
source immutability. Browser regressions cover whole-stack preview, selection,
adoption/cancellation, unsupported sections and atomic local saving. Every
reference revision is checked under the same IndexedDB write lock; any conflict
or failed write rolls back the entire placement batch. Cloud retries retain local
completion and target only unfinished records. Fixtures are synthetic; these
checks do not validate anatomical ground truth or actual section spacing.

Display ranges in v2.12 are versioned separately from immutable normalization
profiles. Tests cover exact finite nearest-rank P99, sparse/all-zero/signed data,
per-molecule raw/normalized manual settings, reversible legacy migration and
the huge-group-range black-image regression. Common P99 snapshots pool all
valid corrected pixels of the same method/name/unit, require the complete
portable member inventory and never mutate historical profile ranges or hashes.
Display-only updates, cloud/ZIP restoration and effective Excel/PNG provenance
must preserve correction arrays and ROI numerical summaries.

Folder normalization in v2.10 adds a second-level group boundary: the selected
folder and every descendant form one target set, while root/first-level datasets
remain outside the automatic groups. Reference datasets and common ranges must
stay inside that group. Each section retains its own `k = D_ref / D_s`, shared
between DA and NE in legacy profiles; 5-HT pixel ratios keep the same formula.

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

Excel batch browser regressions read actual downloaded ZIP/XLSX files, including
an 81-dataset batch with one conflict. They verify automatic successful-only
downloads, complete failure manifests, unchanged analytical cells and raw bits,
missing-raster rejection, absent-standard raw export, warning-only completion,
ordinary-open conflict prompts, cancellation during the first or final dataset,
and control recovery after listing, index, or archive failures. These tests use
the installed SheetJS and JSZip versions rather than external CDNs.

The v2.13 restoration batch uses the existing `marmoset_atlas_v1` inner ZIP
format and puts one ZIP per registered dataset under `datasets/` in one outer
archive. Its `_Restore_Export_Index.json` records every target and its result,
including skips and cancellation. The outer archive must be extracted before
individual dataset ZIPs are imported through the ordinary restore UI.

Restoration verification must check raw Float32/NaN round trips, ROI and spatial
alignment, original HE/Atlas/Immuno image bytes, normalization and binding,
per-layer display/Otsu/rotation state, and folder paths. Missing declared raster
or image assets must skip that dataset, never produce an incomplete success.
Unregistered optional images are allowed. Batch controls must recover on every
exit, partial success must remain downloadable, cancellation must offer built
results, and all-failed batches must not download an empty archive. These ZIPs
do not include source imzML/ibd spectra, empty folder-only trees, or cloud identity
and synchronization metadata; the Excel export remains a separate output.

These checks verify software behavior, **not scientific validation** of an assay,
spray uniformity, cross-analyte normalization, saturation thresholds, calibration,
or the completeness of any real study. Such validation requires the experimental
raw data, QC evidence and calibration records.

The v2.11.0 simple workflow adds schema-3 profiles without rewriting schema-1/2
hashes or equations. Selecting a second-level folder loads all descendants and
suggests a unique d4-5-HT standard plus eligible numeric MSI targets. Ambiguous
standards or 5-HT identities require an explicit mapping. Applying the folder
uses every non-skipped section as a fixed reference, computes section d4 medians over their
measured footprint, and applies the common reference divided by each median to
all selected non-5-HT analytes. The 5-HT channel remains a pixel ratio. Missing
values stay missing and measured zeros stay zero. A bad reference is never
silently dropped; every default reference needs a valid factor before saving.

Simple-profile ROI coverage is reported without suppressing partial summaries
unless the explicit enforcement option is enabled. Zero valid pixels remain
unavailable. The enforcement option also gates the coefficient's reference
region: an insufficient reference cannot produce a factor or a saved group.
New experiment metadata is optional for relative correction; no
automatic ID or default QC value constitutes assay validation. Absolute ROI
calibration still requires compatible real conditions and a saturation boundary.
Enabling an invalid calibration blocks profile creation; an absent calibration
does not block the default relative-correction workflow.
Ranges are keyed to each unambiguous analyte identity; unknown or duplicate
names retain individual ranges. General analytes follow the same method and
range dispatch in Viewer, ROI summaries, PNG display, and real XLSX export.

Additional scenarios cover automatic loading and applying, generated profile
revisions, explicit switching from legacy conditions, retained existing settings,
local group CAS, cloud partial failure with failed-only retry, generic-analyte
round trips, and mixed-version scope assessment. Synthetic known-value fixtures
check the 10/20/40 median example (factors 2/1/0.5), d4-independent section scaling,
raw-bit invariance and exact legacy fingerprints. Final test runs are reported
with each pull request rather than hard-coded here.

The v2.11.1 missing-standard workflow skips a dataset only when the internal
standard is genuinely undeclared and no numeric standard is explicitly selected.
The folder still receives one atomic set of correction or skip records. Skip
profiles retain every folder member in scope but contribute no section median,
reference value, coefficient, or normalized range values. A folder with no
standards can save skip records without manufacturing correction values.
Ambiguous declared standards, registered but missing/corrupt rasters, nonnumeric
standards, invalid d4 reference signals, and incompatible coordinates still block
correction. A missing standard is never treated as a numeric zero.

Regression scenarios include a mixed folder with section medians 2 and 4 plus an
absent standard (reference 3), all-skipped folders, active-profile fingerprint
compatibility, retained folder scope and cloud/ZIP provenance, and explicit
reapplication after adding d4. UI checks cover automatic skip mapping, disabled
irrelevant inputs, planned/applied counts, atomic saving, and existing CAS guards.
Viewer and output checks require raw images and ROI summaries with a conspicuous
uncorrected notice, even if an obsolete stored display mode says normalized.
Normalized Excel cells stay blank with SKIPPED / INTERNAL_STANDARD_MISSING;
raw values remain intact. PNG output also identifies uncorrected data.
