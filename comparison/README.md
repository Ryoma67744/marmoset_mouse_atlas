# Cortical layer data for six marmoset sections

Open **層別データ** from the Atlas home page, 3D section controls, or individual Image Viewer. The page is also available at `comparison/index.html`. Each entry opens a new tab. This directory is a static page and is included by the Pages and offline builds. Use the offline server rather than a `file://` URL to load the additional local gene files.

## Registered pairs

`../lib/msi-st-pairs.js` is the navigation registry: six user-adopted marmoset coronal pairs, matched by exact project ID. A different project with the same display name is not automatically matched. Missing/unknown/contradictory explicit identifiers show a message rather than an unrelated section.

The query accepts `project`, `section`, `st`, and an optional `from=stack3d|viewer`. A supplied section overrides the last-viewed section saved in this browser. Changing the section updates the URL. Gene selection, range settings, and molecule display settings remain in this browser's local storage. URLs encode the paired section, not an entire analysis session.

## MSI access and current project state

- MSI values, thumbnails, and saved ROI geometry are **not embedded in the public comparison assets**. `msi-project.js` reads the registered project's metadata and raster blobs from the current browser's `ProjectStorage` (IndexedDB), using the existing origin and offline workspace namespace. It does not sign in, contact the cloud, save project changes, or upload data.
- Open the registered section in the individual viewer or 3D page first so its data is available in that browser. If a direct comparison link has no local project data, the page offers the individual viewer link; after that page finishes loading, use **MSI・ROIを再読込** or reload the comparison page. The comparison never substitutes an exported snapshot for unavailable project data.
- The displayed MSI and ROI come from the locally saved project state when loaded. Save changes in the individual viewer, then use **MSI・ROIを再読込** or reload comparison to reflect them. Unsaved edits and later changes in another tab are not automatically mirrored. This is the current browser's stored state, not a claim that the cloud has been refreshed.
- Supported MSI channels are raw 5-HT, DA, NE, and D4-5-HT values (a.u.). Saved normalization settings are not applied here. Display ranges, colors, and overlays change presentation only; the project values and ROI remain unchanged.

## ST data and interpretation

- ST: [MCCSTA](https://db.genomics.cn/stomics/mccsta/), datasets T420, T430, T462, T479, T503, T512 from [the paper](https://doi.org/10.1126/science.aea2673). The page includes spatial coordinates, annotations, all six catalogs, and the initial 20 genes.
- **T462 / Cor_9_3** combines cortex, thalamus, and striatum into one ST map with one display range per selected gene. All 32,891 genes in the union of the three source catalogs are packaged as local compressed files and loaded on demand; T462 does not require the official expression API. The offline package includes those files.
- The other five sections show cortical bins. T503 ships its 30,009 spatial gene vectors in 118 local raw-count shards. For T420, T430, T479 and T512, additional spatial gene values beyond the initial 20 are fetched from the official public schema/data API; returned coordinates must exactly match the bundled section before accepting expression data. Those requests require internet access and upstream CORS availability.
- T462 displays the audited raw RNA counts from H5AD `X` and each RDS object's `RNA/counts`. Integrated, imputed, and normalized `RNA/data` matrices are not mixed into this display. The display's `log1p` option changes color scaling only. T503 also displays raw H5AD counts. Additional spatial vectors fetched on demand for the four API-backed sections retain the original viewer units. A zero is not proof of biological absence.
- Source catalogs differ. A gene absent from one source is unavailable in those bins, not a measured zero; unavailable bins are excluded from detection-rate denominators. Loading errors are shown separately and can be retried. MSI and ST are different specimens, are independently fitted, and are **not spatially registered**.
- Gene descriptions include NCBI marmoset annotations and explicitly labeled general functions with human references; they do not establish cell identity or experimental function in marmoset.

### Unified T462 audit (2026-11-17)

The complete `T462.h5ad`, `obj_Thalamus.rds`, and `obj_Striatum.rds` files were obtained from the [official distribution directory](https://ftp.cngb.org/pub/SciRAID/stomics/STDS0000395/). Both RDS gzip streams passed a complete CRC32/ISIZE read. T462 was selected using the stored sample identifiers and observation IDs.

| Source | T462 bins | Source feature catalog | Region labels | Total raw counts |
| --- | ---: | ---: | --- | ---: |
| Cortex (`T462.h5ad`) | 8,407 | 29,724 | Existing cortical labels | 169,656,337 |
| Thalamus (`obj_Thalamus.rds`) | 2,647 | 31,738 | Tha 2,023; Lgn 624 | 26,221,044 |
| Striatum (`obj_Striatum.rds`) | 283 | 32,226 | Cd only; no Pu in T462 | 3,190,407 |
| Combined | **11,337** | **32,891 in the union** | Available cortex, Tha, Lgn, and Cd | **199,067,788** |

Counts are finite nonnegative integers. Per-bin total counts and detected-feature counts agree exactly with each source's QC metadata. Coordinates are retained without translation, reflection, rotation, scaling, or interpolation. All bins are unique within and across the three sources. Thalamus and striatum positions are consistent with the authors' T462 figures. These checks support one ST map; they do not establish MSI registration or whole-section coverage.

The complete cortex coordinates and the 20 previously bundled gene vectors match the official viewer exactly, including row order. Existing viewer cortical annotations are preserved: 358 bins are labeled `L2-Allo` in the viewer but `L2/3/4` in the H5AD. This source-label difference is retained in provenance rather than silently relabeling the existing view. Subcortical bins use the original `Tha`, `Lgn`, or `Cd` region labels and the layer category `対象外（皮質下）`; numeric clusters are not presented as named nuclei.

Among the six adopted pairs, only T462 is present in these two subcortical RDS objects. This does not establish biological absence or the absence of other public sources for the remaining sections. The application shows the **available cortex + thalamus + striatum subsets**, not a reconstructed whole section. Missing tissue is left blank.

### Earlier cortical coverage audit (2026-11-16)

The v2.45.0 page displayed cortical bins. Direct inspection of all six [official Coronal Bin200 H5AD files](https://db.genomics.cn/stomics/mccsta/download/) confirmed that their spatial coordinates exactly match the bundled viewer coordinates, including row order. Every observation has a cortical layer annotation; none supplies additional subcortical coordinates. At that audit, T479 was downloaded completely; the other five were inspected through validated HTTPS range reads of their HDF5 metadata, spatial arrays, and annotation arrays without downloading their expression matrices. T462 was subsequently downloaded and audited in full as described above.

| Section | Spatial bins | Features |
| --- | ---: | ---: |
| T420 | 4,410 | 27,624 |
| T430 | 6,101 | 28,887 |
| T462 | 8,407 | 29,724 |
| T479 | 7,964 | 29,777 |
| T503 | 7,205 | 30,009 |
| T512 | 6,225 | 29,628 |

Layer names are L1–L6, with an additional combined `L2/3/4` label in T462. A whole-brain acquisition reported by the study does not make these processed cortical matrices whole-section datasets. Whole-section display must use independently verified, uncropped source coordinates and expression; do not relabel the current cortical data as full coverage or invent values in missing regions.

The complete official `T479.gem.gz` (2,580,567,648 bytes; SHA-256 `0092f7e8b9240e2eb4e164dc24585fa24b44de4b93b9d7a063c2cf94486b050b`) was also audited. All 95,072,145 records, including 47,692,666 records with `cell_label=0`, fall in the same 7,964 cortical bins after nearest-bin aggregation of `rx/200, ry/200`. There are zero additional bins or counts outside that set. The total MIDCount is 131,860,014, and every bin total exactly matches the H5AD. All six recommended genes plus TH, TPH2, SLC6A3, and SLC6A4 also match exactly in every bin. Gzip CRC32/ISIZE verification passed. This complete-file conclusion applies to T479 Bin1; the other five Bin1 files remain unaudited in full. The separate subcortical RDS audit is described above.

## Files and distribution

`index.html` contains the page and paired-section metadata. `bootstrap.js` contains the gzip/base64 public ST and gene-annotation package plus the numeric MSI renderer; it contains no user MSI raster values. `data/t462/manifest.js` contains the unified coordinates, annotations, source catalogs, initial genes, file checksums, and provenance; compressed gene files in the same directory contain all T462 RNA counts. `st-data.js` validates and loads those files, retaining source-specific availability. `scripts/pack-t462-st.py` regenerates them from the audited count matrices. The original multi-gigabyte H5AD/RDS files are not included in the repository or browser package.

`msi-project.js` adapts the current local project for display. `app.js` and `styles.css` implement the comparison UI, and `route.js` handles navigation. `tests/msi-st-public-assets.test.js` guards against accidentally bundling saved MSI images, values, or ROI geometry in these public assets. T462 data/provider tests validate the packaged counts, coordinates, missing-versus-zero semantics, and loading failures.

The same comparison code is included in Pages and offline builds. Public release files do not include users' MSI data. The existing complete offline workspace export intentionally packages the selected workspace's data separately, under its existing export behavior. Keep project data in that workspace or browser storage, not in comparison source assets.

Run `npm test` for repository checks and `npm run build:pages` for the deployment package. Publishing is performed by the existing main-branch Pages workflow; local source changes alone do not update the public app.

## Cortical layer tables and downloads

Select a section and one of L1–L6. Each gene has a zero-inclusive mean CP10k, detected bin count, total bin count and detection percentage. The table includes all genes in the cortical catalog. A layer pools the sampled cortex. T462 uses only bins with an individual cortical layer annotation. V1 and V2 are anatomical regions and do not enter the layer list.

Download one layer or all six from the selected section. CSV uses one row per section, layer and gene. An Excel workbook opens with a Japanese guide (「説明」) listing the selected section, included layers and the contents of each exported sheet. It defines the per-gene measurements and units, the Metadata keys, and the MSI_ROI fields when that sheet is present. Each requested layer has its own expression sheet. Metadata records the normalization and data source. Searches and table pagination affect the on-screen view only. ST extraction works independently of local MSI data.

For a registered MSI region, the page can also report the selected molecule’s raw median and finite-pixel count from browser storage. Missing ROI boundaries or signal retain a missing status. T503 can use Cor_2_2 as an optional MSI source, alongside its registered Cor_2_3 source.

### Rebuild the released public data

Use Python 3.11+ with NumPy, h5py and SciPy (including `scipy.stats.false_discovery_control`). Obtain the six named H5AD files from the [official MCCSTA distribution](https://ftp.cngb.org/pub/SciRAID/stomics/STDS0000395/). Run from the repository root, supplying the original filenames. The summary generator checks each file against its recorded SHA-256 and matches its coordinates, annotation, library sizes and initial map values.

```sh
for section in T420 T430 T462 T479 T503 T512; do
    python scripts/build-st-layer-data.py "/path/to/data/${section}.h5ad"
done
python scripts/pack-t503-spatial.py /path/to/data/T503.h5ad
OPENBLAS_NUM_THREADS=1 python scripts/validate-t503-spatial.py /path/to/data/T503.h5ad comparison/data/layer-analysis/t503-spatial-validation.json --publish comparison/data/layer-analysis
```
