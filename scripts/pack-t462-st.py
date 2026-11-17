"""Package verified T462 public RNA counts for the static comparison page.

Inputs are the audit.json, *-T462-counts.npz (bins x genes),
*-T462-genes.json and T462-selected-counts.json.gz exported by the source
audit. The latter supplies coordinates and original region labels, not counts.
Requires NumPy/SciPy. No source RDS, MSI, user ROI or local paths are bundled.

Example:
  python scripts/pack-t462-st.py --audit-directory /path/to/T462-subcortex

The generated manifest deliberately preserves existing cortical viewer layer
labels; its provenance records the 358-label difference from the H5AD file.
Sparse shards omit only measured zeros. Catalog absence remains unavailable.
deltaIndices stores the first absolute bin index, then strictly positive steps.
"""

import argparse
import base64
import gzip
import hashlib
import json
from pathlib import Path
import re
import sys


def json_bytes(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode('utf-8')


def categorized(values):
    categories = list(dict.fromkeys(values))
    indices = {value: index for index, value in enumerate(categories)}
    return {'categories': categories, 'values': [indices[value] for value in values]}


def main():
    repo = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--audit-directory', type=Path, required=True)
    parser.add_argument('--bootstrap', type=Path, default=repo / 'comparison/bootstrap.js')
    parser.add_argument('--output', type=Path, default=repo / 'comparison/data/t462')
    parser.add_argument('--python-libs', type=Path, help='Optional local NumPy/SciPy package directory')
    parser.add_argument('--genes-per-chunk', type=int, choices=[128, 256], default=128)
    args = parser.parse_args()
    if args.python_libs:
        sys.path.insert(0, str(args.python_libs.resolve()))
    import numpy as np
    from scipy import sparse

    audit_dir = args.audit_directory.resolve()
    audit = json.loads((audit_dir / 'audit.json').read_text(encoding='utf-8'))
    with gzip.open(audit_dir / 'T462-selected-counts.json.gz', 'rt', encoding='utf-8') as stream:
        metadata = json.load(stream)
    bootstrap_source = args.bootstrap.read_text(encoding='utf-8')
    packed = re.search(r'window\.MARMOSET_BOOTSTRAP\s*=\s*("[^"\r\n]+")', bootstrap_source)
    if not packed:
        raise ValueError('Cannot identify the existing cortical bootstrap')
    bootstrap = json.loads(gzip.decompress(base64.b64decode(json.loads(packed.group(1)))))
    cortex_viewer = next(section for section in bootstrap['sections'] if section['id'] == 'T462')
    reports = {source['name']: source for source in audit['sources']}
    coordinate_sources = {source['name']: source for source in metadata['sources']}
    source_names = ['Cortex', 'Thalamus', 'Striatum']
    labels = {'Cortex': '皮質', 'Thalamus': '視床', 'Striatum': '線条体'}
    expected = {'Cortex': (8407, 29724, 169656337),
                'Thalamus': (2647, 31738, 26221044),
                'Striatum': (283, 32226, 3190407)}
    manifest = {'format': 'marmoset-st-unified-v1', 'id': 'T462',
                'valueType': 'RNA counts', 'n': 11337, 'x': [], 'y': [],
                'sources': [], 'genes': [], 'geneChunks': {}, 'initialGenes': {}, 'chunks': {},
                'provenance': {
                    'pairedMsiSection': 'Cor_9_3', 'scope': 'cortex_plus_available_thalamus_striatum',
                    'coordinateTransformApplied': 'none', 'msiRegistration': 'not_registered',
                    'downloadPage': 'https://db.genomics.cn/stomics/mccsta/download/',
                    'paper': 'https://doi.org/10.1126/science.aea2673',
                    'matrixTypes': {'Cortex': 'H5AD X', 'Thalamus': 'RNA/counts', 'Striatum': 'RNA/counts'},
                    'corticalLayerSource': 'Existing MCCSTA viewer bootstrap; preserved without relabeling',
                    'corticalLayerDifferences': audit['cortexAnnotationLabelDifferences'],
                    'countValidation': 'All bin totals and detected feature counts match source metadata',
                    'rdsIntegrity': 'Both downloaded RDS gzip streams passed full CRC32 and ISIZE validation',
                    'limits': ['Available cortex, Tha, Lgn and Cd subsets; not whole-section coverage.',
                               'Gene catalog absence is unavailable, not a measured zero.',
                               'Raw RNA counts; no integrated, imputed or normalized assay values.']}}
    regions, layers, matrices, gene_indices = [], [], {}, {}
    offset = 0
    for name in source_names:
        report = reports[name]
        coordinates = coordinate_sources[name]
        matrix = sparse.load_npz(audit_dir / (name + '-T462-counts.npz')).tocsc()
        matrix.sum_duplicates()
        matrix.eliminate_zeros()
        matrix.sort_indices()
        genes = json.loads((audit_dir / (name + '-T462-genes.json')).read_text(encoding='utf-8'))
        expected_bins, expected_genes, expected_counts = expected[name]
        if matrix.shape != (expected_bins, expected_genes) or len(genes) != expected_genes:
            raise ValueError(name + ': source matrix shape does not match the audited input')
        if len(set(genes)) != len(genes) or any(not isinstance(g, str) or not g for g in genes):
            raise ValueError(name + ': invalid feature identifiers')
        if not np.isfinite(matrix.data).all() or np.any(matrix.data <= 0) or np.any(matrix.data != np.floor(matrix.data)):
            raise ValueError(name + ': invalid raw RNA counts')
        if matrix.sum() != expected_counts or report['totalCounts'] != expected_counts or matrix.nnz != report['nonzeroEntries']:
            raise ValueError(name + ': source counts differ from the completed audit')
        for field in report['qc'].values():
            if field['matchingBins'] != expected_bins or field['maxAbsoluteDifference'] != 0:
                raise ValueError(name + ': incomplete source QC')
        x, y = coordinates['x'], coordinates['y']
        if len(x) != expected_bins or len(y) != expected_bins or len(coordinates['region']) != expected_bins:
            raise ValueError(name + ': inconsistent coordinate or region metadata')
        if any(not np.isfinite(v) or v != int(v) for v in x + y):
            raise ValueError(name + ': expected finite integer Bin200 coordinates')
        if coordinates['sourceSha256'] != report['sourceSha256']:
            raise ValueError(name + ': coordinate and count provenance differ')
        if len(coordinates['observationIds']) != expected_bins or any(
                obs != f'T462_{int(a)}_{int(b)}' for obs, a, b in zip(coordinates['observationIds'], x, y)):
            raise ValueError(name + ': observation IDs disagree with coordinates')
        if name == 'Cortex':
            if x != cortex_viewer['x'] or y != cortex_viewer['y']:
                raise ValueError('Current viewer cortical coordinates differ')
            viewer_regions = [cortex_viewer['region']['categories'][i] for i in cortex_viewer['region']['values']]
            if coordinates['region'] != viewer_regions:
                raise ValueError('Current viewer cortical regions differ')
            layers.extend(cortex_viewer['layer']['categories'][i] for i in cortex_viewer['layer']['values'])
        else:
            layers.extend(['対象外（皮質下）'] * expected_bins)
        regions.extend(coordinates['region'])
        manifest['x'].extend(int(value) for value in x)
        manifest['y'].extend(int(value) for value in y)
        manifest['sources'].append({'id': name, 'label': labels[name], 'offset': offset, 'n': expected_bins,
                                    'genes': genes, 'sha256': report['sourceSha256'], 'url': report['sourceUrl'],
                                    'totalCounts': expected_counts, 'nonzeroEntries': int(matrix.nnz),
                                    'nCounts': np.asarray(matrix.sum(axis=1)).ravel().astype(int).tolist(),
                                    'nFeatures': np.diff(matrix.tocsr().indptr).astype(int).tolist()})
        matrices[name] = matrix
        gene_indices[name] = {gene: index for index, gene in enumerate(genes)}
        offset += expected_bins
    if offset != manifest['n'] or len(set(zip(manifest['x'], manifest['y']))) != offset:
        raise ValueError('Duplicate or inconsistent combined spatial coordinates')
    manifest['region'], manifest['layer'] = categorized(regions), categorized(layers)
    manifest['genes'] = sorted(set().union(*(set(indices) for indices in gene_indices.values())))
    if len(manifest['genes']) != 32891 or len(manifest['genes']) != audit['geneCatalogUnionSize']:
        raise ValueError('The combined feature catalog differs from the source audit')

    def sparse_gene(gene):
        indices, values = [], []
        for source in manifest['sources']:
            name = source['id']
            index = gene_indices[name].get(gene)
            if index is None:
                continue
            matrix = matrices[name]
            start, end = matrix.indptr[index:index + 2]
            indices.extend((matrix.indices[start:end] + source['offset']).astype(int).tolist())
            values.extend(matrix.data[start:end].astype(int).tolist())
        return {'deltaIndices': [index - (indices[i - 1] if i else 0) for i, index in enumerate(indices)], 'values': values}

    for gene, old_values in cortex_viewer['genes'].items():
        values = []
        for source in manifest['sources']:
            values.extend(([0] if gene in gene_indices[source['id']] else [None]) * source['n'])
        sparse_values = sparse_gene(gene)
        index = 0
        for delta, value in zip(sparse_values['deltaIndices'], sparse_values['values']):
            index += delta
            values[index] = value
        if values[:expected['Cortex'][0]] != old_values:
            raise ValueError(gene + ': current viewer cortical expression differs')
        manifest['initialGenes'][gene] = values
    if len(manifest['initialGenes']) != 20:
        raise ValueError('Expected exactly the existing 20 initial genes')
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    expected_shard_names = set()
    for number, start in enumerate(range(0, len(manifest['genes']), args.genes_per_chunk)):
        selected = manifest['genes'][start:start + args.genes_per_chunk]
        name = f'chunk-{number:03d}.json.gz'
        shard = {'format': 'marmoset-st-counts-v1', 'section': 'T462', 'n': manifest['n'],
                 'genes': {gene: sparse_gene(gene) for gene in selected}}
        compressed = gzip.compress(json_bytes(shard), compresslevel=6, mtime=0)
        (output / name).write_bytes(compressed)
        expected_shard_names.add(name)
        manifest['chunks'][name] = {'sha256': hashlib.sha256(compressed).hexdigest(), 'bytes': len(compressed)}
        for gene in selected:
            manifest['geneChunks'][gene] = name
        if number % 32 == 0:
            print(json.dumps({'chunk': number, 'genesPacked': start + len(selected)}), flush=True)
    # Remove only obsolete generated shards in the explicit output directory.
    for old in output.glob('chunk-*.json.gz'):
        if old.name not in expected_shard_names and re.fullmatch(r'chunk-\d+\.json\.gz', old.name):
            old.unlink()
    (output / 'manifest.js').write_text('window.MSI_ST_T462=' + json_bytes(manifest).decode('utf-8') + ';\n', encoding='utf-8', newline='\n')
    print(json.dumps({'output': str(output), 'bins': offset, 'genes': len(manifest['genes']),
                      'shards': len(manifest['chunks']), 'compressedBytes': sum(item['bytes'] for item in manifest['chunks'].values()),
                      'manifestBytes': (output / 'manifest.js').stat().st_size}), flush=True)


if __name__ == '__main__':
    main()
