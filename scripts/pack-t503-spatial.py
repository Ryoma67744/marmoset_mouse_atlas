"""Pack T503 cortical raw RNA counts for offline lookup in the comparison viewer.

Usage: python scripts/pack-t503-spatial.py /path/to/T503.h5ad
Requires scipy, numpy, h5py. The catalogue order and native spatial bins are
checked against the packaged viewer; no MSI data is read.
"""
import argparse
import gzip
import hashlib
import json
from pathlib import Path
import runpy

import h5py
import numpy as np
from scipy import sparse

ROOT = Path(__file__).resolve().parents[1]
SHARD_SIZE = 256


def encode(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode()


def pack(source, output):
    shared = runpy.run_path(str(ROOT / 'scripts' / 'build-st-layer-data.py'))
    with source.open('rb') as stream:
        digest = hashlib.file_digest(stream, 'sha256').hexdigest()
    if digest != shared['SOURCE_SHA256']['T503']:
        raise ValueError('Unexpected T503 source checksum')
    viewer, catalog = shared['read_viewer'](ROOT / 'comparison' / 'bootstrap.js', 'T503')
    with h5py.File(source, 'r') as h:
        locations = np.column_stack([viewer['x'], viewer['y']])
        np.testing.assert_array_equal(locations, h['obsm/spatial'][:])
        genes = h['var/_index'].asstr()[:].tolist()
        indices = {g: i for i, g in enumerate(genes)}
        if len(indices) != len(genes) or len(catalog) != len(genes) or set(catalog) != set(genes):
            raise ValueError('Native catalog differs from source genes')
        block = h['X']
        shape = tuple(map(int, block.attrs['shape']))
        if shape != (len(locations), len(catalog)):
            raise ValueError('Source and viewer dimensions differ')
        mat = sparse.csr_matrix((block['data'][:], block['indices'][:], block['indptr'][:]), shape=shape)
        if mat.dtype.kind not in 'iu' or np.min(mat.data) < 1:
            raise ValueError('Expected positive integer sparse counts')
        mat.sum_duplicates()
        np.testing.assert_array_equal(np.asarray(mat.sum(axis=1)).ravel(), h['obs/nCounts_RNA'][:])
        np.testing.assert_array_equal(mat.getnnz(axis=1), h['obs/nFeature_RNA'][:])
        mat = mat.tocsc()
    for gene, values in viewer['genes'].items():
        np.testing.assert_array_equal(mat[:, indices[gene]].toarray().ravel(), values)
    output.mkdir(parents=True, exist_ok=True)
    headers = {}
    for start in range(0, len(catalog), SHARD_SIZE):
        names = catalog[start:start + SHARD_SIZE]
        vectors = {}
        for gene in names:
            j = indices[gene]
            a, b = mat.indptr[j:j + 2]
            delta = np.diff(mat.indices[a:b], prepend=0).tolist()
            vectors[gene] = {'deltaIndices': delta, 'values': mat.data[a:b].tolist()}
        chunk = {'format': 'marmoset-st-counts-v1', 'section': 'T503', 'n': shape[0], 'genes': vectors}
        content = gzip.compress(encode(chunk), compresslevel=6, mtime=0)
        filename = f'chunk-{start // SHARD_SIZE:03}.json.gz'
        if len(content) > 16 * 1024 * 1024:
            raise ValueError('Shard exceeds runtime size limit')
        (output / filename).write_bytes(content)
        headers[filename] = {'sha256': hashlib.sha256(content).hexdigest(), 'bytes': len(content)}
    manifest = {'section': 'T503', 'sourceSha256': digest, 'sourceUrl': shared['SOURCE_ROOT'] + 'T503.h5ad',
                'genesPerChunk': SHARD_SIZE, 'nGenes': len(catalog), 'nBins': shape[0],
                'catalogSha256': hashlib.sha256(encode(catalog)).hexdigest(), 'chunks': headers}
    (output / 'manifest.js').write_bytes(b'window.MSI_ST_T503_COUNTS=' + encode(manifest) + b';\n')
    print(len(headers), 'shards;', sum(h['bytes'] for h in headers.values()), 'compressed bytes')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path)
    parser.add_argument('--output', type=Path, default=ROOT / 'comparison' / 'data' / 't503')
    args = parser.parse_args()
    pack(args.source, args.output)
