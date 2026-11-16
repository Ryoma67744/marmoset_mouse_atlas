# MSI–ST comparison — six paired samples

Open `comparison/index.html` directly or use the MSI–ST entry in the 3D section controls / individual Image Viewer. Both open a new tab, preserving the originating view and unsaved edits. This directory is a static page and is included by the Pages and offline builds.

## Registered pairs

`../lib/msi-st-pairs.js` is the navigation registry: six user-adopted marmoset coronal pairs, matched by exact project ID. A different project with the same display name is not automatically matched. Missing/unknown/contradictory explicit identifiers show a message rather than an unrelated section.

The query accepts `project`, `section`, `st`, and an optional `from=stack3d|viewer`. A supplied section overrides the last-viewed section saved in this browser. Changing the section updates the URL. Gene selection, range settings, and molecule display settings remain in this browser's local storage. URLs encode the paired section, not an entire analysis session.

## MSI access and current project state

- MSI values, thumbnails, and saved ROI geometry are **not embedded in the public comparison assets**. `msi-project.js` reads the registered project's metadata and raster blobs from the current browser's `ProjectStorage` (IndexedDB), using the existing origin and offline workspace namespace. It does not sign in, contact the cloud, save project changes, or upload data.
- Open the registered section in the individual viewer or 3D page first so its data is available in that browser. If a direct comparison link has no local project data, the page offers the individual viewer link; after that page finishes loading, use **MSI・ROIを再読込** or reload the comparison page. The comparison never substitutes an exported snapshot for unavailable project data.
- The displayed MSI and ROI come from the locally saved project state when loaded. Save changes in the individual viewer, then use **MSI・ROIを再読込** or reload comparison to reflect them. Unsaved edits and later changes in another tab are not automatically mirrored. This is the current browser's stored state, not a claim that the cloud has been refreshed.
- Supported MSI channels are raw 5-HT, DA, NE, and D4-5-HT values (a.u.). Saved normalization settings are not applied here. Display ranges, colors, and overlays change presentation only; the project values and ROI remain unchanged.

## ST data and interpretation

- ST: [MCCSTA](https://db.genomics.cn/stomics/mccsta/), datasets T420, T430, T462, T479, T503, T512 from [the paper](https://doi.org/10.1126/science.aea2673). The page includes spatial coordinates, cortical annotations, all six catalogs, and the initial 20 genes. Additional selected gene values are fetched on demand from the official public schema/data API; the returned coordinates must exactly match the bundled section before accepting expression data. This requires internet access and upstream CORS availability. Failed requests are shown separately from zero/unavailable expression, with a retry action. Without internet, the bundled genes remain available.
- Numeric expression units/normalization remain unconfirmed; values are not labeled raw UMI. A zero is not proof of biological absence. MSI and ST are different specimens, are independently fitted, and are **not spatially registered**.
- Gene descriptions include NCBI marmoset annotations and explicitly labeled general functions with human references; they do not establish cell identity or experimental function in marmoset.

### Coverage audit (2026-11-16)

The current page displays cortical bins. Direct inspection of all six [official Coronal Bin200 H5AD files](https://db.genomics.cn/stomics/mccsta/download/) confirmed that their spatial coordinates exactly match the bundled viewer coordinates, including row order. Every observation has a cortical layer annotation; none supplies additional subcortical coordinates. T479 was downloaded completely; the other five were inspected through validated HTTPS range reads of their HDF5 metadata, spatial arrays, and annotation arrays without downloading their expression matrices.

| Section | Spatial bins | Features |
| --- | ---: | ---: |
| T420 | 4,410 | 27,624 |
| T430 | 6,101 | 28,887 |
| T462 | 8,407 | 29,724 |
| T479 | 7,964 | 29,777 |
| T503 | 7,205 | 30,009 |
| T512 | 6,225 | 29,628 |

Layer names are L1–L6, with an additional combined `L2/3/4` label in T462. A whole-brain acquisition reported by the study does not make these processed cortical matrices whole-section datasets. Whole-section display must use independently verified, uncropped source coordinates and expression; do not relabel the current cortical data as full coverage or invent values in missing regions.

The complete official `T479.gem.gz` (2,580,567,648 bytes; SHA-256 `0092f7e8b9240e2eb4e164dc24585fa24b44de4b93b9d7a063c2cf94486b050b`) was also audited. All 95,072,145 records, including 47,692,666 records with `cell_label=0`, fall in the same 7,964 cortical bins after nearest-bin aggregation of `rx/200, ry/200`. There are zero additional bins or counts outside that set. The total MIDCount is 131,860,014, and every bin total exactly matches the H5AD. All six recommended genes plus TH, TPH2, SLC6A3, and SLC6A4 also match exactly in every bin. Gzip CRC32/ISIZE verification passed. This complete-file conclusion applies to T479 Bin1; the other five Bin1 files and the separate subcortical RDS objects were not audited.

## Files and distribution

`index.html` contains the page and paired-section metadata. `bootstrap.js` contains the gzip/base64 public ST and gene-annotation package plus the numeric MSI renderer; it contains no user MSI raster values. `msi-project.js` adapts the current local project for display. `app.js` and `styles.css` implement the comparison UI, and `route.js` handles navigation. `tests/msi-st-public-assets.test.js` guards against accidentally bundling saved MSI images, values, or ROI geometry in these public assets.

The same comparison code is included in Pages and offline builds. Public release files do not include users' MSI data. The existing complete offline workspace export intentionally packages the selected workspace's data separately, under its existing export behavior. Keep project data in that workspace or browser storage, not in comparison source assets.

Run `npm test` for repository checks and `npm run build:pages` for the deployment package. Publishing is performed by the existing main-branch Pages workflow; local source changes alone do not update the public app.
