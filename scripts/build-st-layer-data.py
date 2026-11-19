"""Build a cortical expression summary from an original MCCSTA section H5AD.

python scripts/build-st-layer-data.py T503.h5ad
Dependencies: h5py, NumPy, SciPy. The input is the public SECTION.h5ad at SOURCE_ROOT.
The binary is feature-major: a little-endian float64 [genes, groups] matrix of
zero-inclusive mean CP10k, then an identically shaped uint16 detection matrix.
The manifest maps both axes and records the denominators and source fingerprint.
"""
import argparse
import base64
import gzip
import hashlib
import json
from pathlib import Path
import re

import h5py
import numpy as np
from scipy import sparse

SOURCE_ROOT = 'https://ftp.cngb.org/pub/SciRAID/stomics/STDS0000395/'
SOURCE_SHA256 = {
    'T420': '4532fe601e7fc230d3c8c4368be3bec4729e26b2a1109c44d1d4349ff7213b7a',
    'T430': 'a32124031e7bae75876d04927c69db9ec8fe9f5516ff82a4189f2898ab4f7524',
    'T462': 'e251aa707c618c9595db702a7823f9f29e6fc625c4cbd7e72ebb924ebe5c7b33',
    'T479': 'e666a08080ce1e40f93b8441e723c2b83c47444ff8bb3c9456ace0e9f6949581',
    'T503': 'd314a439da9352895aef9c6f7fbf280e65903eed47fb218db74605270936a8ef',
    'T512': 'a4a9b7acb227de38dae671e3a50206e41238afd0d8a8fceee65e22ac49410670',
}
GROUPS = ['L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'V1', 'V2']
ROOT = Path(__file__).resolve().parents[1]


def obs_strings(column):
    if isinstance(column, h5py.Dataset):
        return column.asstr()[:]
    categories, codes = column['categories'].asstr()[:], column['codes'][:]
    # The official cortical viewer uses "None" for an unassigned anatomical label.
    return np.where(codes < 0, 'None', categories[codes])


def read_viewer(bootstrap, section_id):
    packed = re.search(r'window\.MARMOSET_BOOTSTRAP\s*=\s*"([^"]+)"', bootstrap.read_text())
    data = json.loads(gzip.decompress(base64.b64decode(packed[1])))
    section = next(s for s in data['sections'] if s['id'] == section_id)
    return section, data['catalogs'][section_id]


def summarize(source, section, catalog):
    section_id = section['id']
    with source.open('rb') as stream:
        digest = hashlib.file_digest(stream, 'sha256').hexdigest()
    if digest != SOURCE_SHA256.get(section_id):
        raise ValueError(f'Input does not match the verified MCCSTA {section_id} H5AD')
    with h5py.File(source, 'r') as handle:
        bins = section['nTotal']
        matrix = handle['X']
        genes = handle['var/_index'].asstr()[:].tolist()
        if tuple(matrix.attrs['shape']) != (bins, len(genes)) or set(genes) != set(catalog):
            raise ValueError('Unexpected count matrix dimensions or viewer gene catalog')
        if len(set(genes)) != len(genes) or not all(genes):
            raise ValueError('Gene identifiers must be unique and nonempty')
        coords = np.column_stack([section['x'], section['y']])
        np.testing.assert_array_equal(handle['obsm/spatial'][:], coords)
        ids = obs_strings(handle['obs/_index'])
        np.testing.assert_array_equal(ids, [f'{section_id}_{x}_{y}' for x, y in coords])
        annotations = {}
        mismatches = {}
        for name, field in [('layer', 'annotation'), ('region', 'region')]:
            field_data = section[name]
            viewer = np.asarray(field_data['categories'])[field_data['values']]
            original = obs_strings(handle['obs'][field])
            changed = original != viewer
            different = int(np.count_nonzero(changed))
            # T462's unified viewer documents 358 cortical layer differences
            # with raw H5AD annotations. Preserve the labels actually rendered.
            if section_id == 'T462' and name == 'layer':
                if (different != 358 or np.any(original[changed] != 'L2/3/4')
                        or np.any(viewer[changed] != 'L2-Allo')):
                    raise ValueError('Unexpected T462 combined-layer annotations')
            elif different:
                raise ValueError(f'{section_id} unexpected {name} disagreement in {different} bins')
            annotations[name], mismatches[name] = viewer, different
        layers, regions = annotations['layer'], annotations['region']
        groups = [g for g in GROUPS if g in (layers if g.startswith('L') else regions)]
        populations = [np.flatnonzero((layers if g.startswith('L') else regions) == g) for g in groups]
        counts = [len(indices) for indices in populations]
        if not counts or max(counts) > 65535:
            raise ValueError('Unexpected group denominators')
        group_index = {g: i for i, g in enumerate(groups)}
        panel_indices = [genes.index(g) for g in section['genes']]
        panel = np.column_stack([section['genes'][g] for g in section['genes']])
        indptr = matrix['indptr'][:]
        library = handle['obs/nCounts_RNA'][:]
        features = handle['obs/nFeature_RNA'][:]
        sums = np.zeros((len(genes), len(groups)), dtype='<f8')
        detections = np.zeros(sums.shape, dtype='<u2')
        # Validate totals against the annotation's library sizes and restrict
        # all working matrices to one block. A zero remains in its denominator.
        for first in range(0, bins, 128):
            last = min(bins, first + 128)
            start, end = indptr[first], indptr[last]
            data, indices = matrix['data'][start:end], matrix['indices'][start:end]
            block = sparse.csr_matrix((data, indices, indptr[first:last+1] - start),
                                      shape=(last - first, len(genes)))
            if data.dtype.kind not in 'ui' or np.any(data <= 0) or np.any(library[first:last] <= 0):
                raise ValueError('Expected positive raw counts and nonempty libraries')
            block.sum_duplicates()
            np.testing.assert_array_equal(np.asarray(block.sum(axis=1)).ravel(), library[first:last])
            np.testing.assert_array_equal(block.getnnz(axis=1), features[first:last])
            np.testing.assert_array_equal(block[:, panel_indices].toarray(), panel[first:last])
            scale = 10000.0 / library[first:last]
            for i in range(last - first):
                left, right = block.indptr[i:i+2]
                cols = block.indices[left:right]
                scaled = block.data[left:right] * scale[i]
                labels = (layers[first + i], regions[first + i])
                for group in labels:
                    if group in group_index:
                        k = group_index[group]
                        sums[cols, k] += scaled
                        detections[cols, k] += 1
        means = sums / counts
        np.testing.assert_allclose(means.sum(axis=0), 10000)
        audit = dict(section=section_id, sourceSha256=digest, nBins=bins, groups=groups, counts=counts,
                     regionCategories=section['region']['categories'], layerCategories=section['layer']['categories'],
                     sourceAnnotationMismatches=mismatches, mapGenesCrossChecked=list(section['genes']),
                     nLayerBins=int(sum(counts[k] for k, g in enumerate(groups) if g.startswith('L'))))
        return audit, genes, means, detections


def write_assets(output, audit, genes, means, detected):
    values = means.astype('<f8').tobytes() + detected.astype('<u2').tobytes()
    digest = hashlib.sha256(values).hexdigest()
    section_id = audit['section']
    filename = section_id.lower() + '-' + digest[:16] + '.bin'
    region_labels = ['領域未割当' if r == 'None' else r for r in audit['regionCategories']]
    comparisons = []
    if all(layer in audit['groups'] for layer in GROUPS[:6]):
        comparisons.append('each layer vs unweighted mean of other five layers')
    if 'V1' in audit['groups'] and 'V2' in audit['groups']:
        comparisons.append('V1 whole vs V2 whole')
    manifest = dict(audit, format='marmoset-layer-summary-v1', version='1', genes=genes,
                    scope=section_id + ' 収録皮質全域（' + '、'.join(region_labels) + '）',
                    sourceUrl=SOURCE_ROOT + section_id + '.h5ad', dataFile=filename, dataSha256=digest,
                    normalization='mean of per-bin raw RNA counts / total raw RNA counts × 10,000; includes zeros',
                    comparison='; '.join(comparisons),
                    testStatus='not_tested')
    output.mkdir(parents=True, exist_ok=True)
    (output / filename).write_bytes(values)
    (output / (section_id.lower() + '.json')).write_text(json.dumps(manifest, ensure_ascii=False, separators=(',', ':')) + '\n')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('h5ad', type=Path)
    parser.add_argument('--bootstrap', type=Path, default=ROOT / 'comparison/bootstrap.js')
    parser.add_argument('--output', type=Path, default=ROOT / 'comparison/data/layer-analysis')
    args = parser.parse_args()
    write_assets(args.output, *summarize(args.h5ad, *read_viewer(args.bootstrap, args.h5ad.stem)))


if __name__ == '__main__':
    main()
