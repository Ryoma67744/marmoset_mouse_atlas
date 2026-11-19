#!/usr/bin/env python3
"""Test calibration of a spatial-block variance estimator on the T503 geometry.

Usage: python scripts/validate-t503-spatial.py T503.h5ad report.json
Requires Python >= 3.11, NumPy, SciPy >= 1.11 and h5py. Also accepts a lossless JSON panel extracted from
the identical H5AD (x, y, layer, region, total_umi and 29 raw count arrays).
The calibration report alone contains no observed gene P values. To build the
real-data result files for contrasts passing all gates, use the full H5AD and
add --publish comparison/data/layer-analysis. This reruns the calibration
before writing contrast files and links them to the existing summary.
"""
import argparse
import hashlib
import json
from pathlib import Path

import numpy as np
from scipy import ndimage, sparse, stats

SOURCE_SHA = 'd314a439da9352895aef9c6f7fbf280e65903eed47fb218db74605270936a8ef'
GENES = ('HTR1A HTR2A DRD1 DRD2 ADRA1A ADRB2 SLC17A7 GAD1 GAD2 CHRM1 CHRNA4 '
         'SST VIP NPY PVALB GRIA1 GRIN1 GABRA1 TH TPH2 HTR2C RORB BCL11B CUX2 '
         'HTR3A TLE4 RELN LAMP5 FOXP2').split()
LAYERS = ['L1', 'L2', 'L3', 'L4', 'L5', 'L6']
GROUPS = LAYERS + ['V1', 'V2']
CONTRASTS = [layer + '_vs_other5' for layer in LAYERS] + ['V1_vs_V2']
BLOCK_SIDES = [6, 12, 24]
SCALES = [1.5, 6.0, 15.0]
RATES = [0.002, 0.5, 3.0]
DRAWS = 384
ALPHA = 0.05
SEED = 50319
# Fixed before computing calibration. Upper endpoint of a two-sided 95% exact
# binomial interval must be <= 0.075 in every null scenario.
MAX_UPPER = 0.075
MIN_EFFECTIVE_BLOCKS = 10
MIN_ESTIMABLE = 0.95
CALIBRATION_SCOPE = (
    'Exploratory inference about bins of this T503 section. The simulations check '
    'the marginal false-positive rate at nominal alpha 0.05 for the specified fields. '
    'Smaller P-value tails, genome-wide FDR, and between-animal reproducibility '
    'were not assessed.'
)


def raw_input(path):
    if path.suffix == '.json':
        panel = json.loads(path.read_text())
        if panel['source_sha256'] != SOURCE_SHA or panel['section'] != 'T503':
            raise ValueError('Unexpected input provenance')
        return (np.asarray(panel['x']), np.asarray(panel['y']), np.asarray(panel['layer']),
                np.asarray(panel['region']), np.asarray(panel['total_umi']),
                np.column_stack([panel['genes'][g] for g in GENES]))

    import h5py
    with path.open('rb') as f:
        if hashlib.file_digest(f, 'sha256').hexdigest() != SOURCE_SHA:
            raise ValueError('Unexpected H5AD checksum')
    with h5py.File(path) as f:
        def labels(group, field):
            node = group[field]
            if isinstance(node, h5py.Group):
                codes = np.asarray(node['codes'])
                if np.any(codes < 0):
                    raise ValueError('Missing annotation')
                return node['categories'].asstr()[:][codes]
            return node.asstr()[:]
        obs = f['obs']
        x, y = np.asarray(obs['x']), np.asarray(obs['y'])
        layer, region = labels(obs, 'annotation'), labels(obs, 'region')
        var = f['var']
        key = var.attrs['_index']
        symbols = labels(var, key.decode() if isinstance(key, bytes) else key).tolist()
        sel = [symbols.index(g) for g in GENES]
        mat = f['X']
        indptr = mat['indptr'][:]
        cnt = np.empty((len(x), len(sel)), dtype=np.int64)
        total = np.empty(len(x), dtype=np.int64)
        for start in range(0, len(x), 128):
            end = min(start + 128, len(x))
            ptr = indptr[start:end + 1]
            sl = slice(ptr[0], ptr[-1])
            block = sparse.csr_matrix((mat['data'][sl], mat['indices'][sl], ptr - ptr[0]),
                                      shape=(end - start, len(symbols)))
            cnt[start:end] = block[:, sel].toarray()
            total[start:end] = np.asarray(block.sum(axis=1)).ravel()
        np.testing.assert_array_equal(total, obs['nCounts_RNA'][:])
        return x, y, layer, region, total, cnt


class SpatialBlockTest:
    """Delta-method variance of log2(target mean / reference mean) using spatial blocks."""

    def __init__(self, x, y, layer, region):
        n = len(x)
        groups = np.column_stack([layer == name if name in LAYERS else region == name for name in GROUPS])
        self.n = groups.sum(axis=0)
        self.groups = sparse.csr_matrix(groups.T.astype(float))
        self.tilings = []
        bins, group = np.nonzero(groups)
        for side in BLOCK_SIDES:
            for shift in (0, side // 2):
                grid = np.column_stack([(x - x.min() + shift) // side, (y - y.min() + shift) // side])
                blocks, block_id = np.unique(grid, axis=0, return_inverse=True)
                membership = sparse.csr_matrix((np.ones(len(bins)), (block_id[bins] * 8 + group, bins)),
                                               shape=(len(blocks) * 8, n))
                block_n = np.asarray(membership.sum(axis=1)).reshape(-1, 8)
                proportions = block_n / self.n
                eff = []
                for k in range(7):
                    others = self.reference(k)
                    weight = np.column_stack((proportions[:, k], proportions[:, others].mean(axis=1)))
                    eff.append(float(np.min(1 / np.sum(weight ** 2, axis=0))))
                self.tilings.append((membership, block_n, np.array(eff)))

    @staticmethod
    def reference(k):
        return [7] if k == 6 else [i for i in range(6) if i != k]

    def run(self, cp10k):
        means = (self.groups @ cp10k) / self.n[:, None]
        p = []
        with np.errstate(divide='ignore', invalid='ignore'):
            for membership, block_n, eff in self.tilings:
                sums = (membership @ cp10k).reshape(-1, 8, cp10k.shape[1])
                # Centre residuals within each of the eight reporting groups.
                scores = (sums - block_n[:, :, None] * means) / self.n[:, None]
                tile = []
                for k in range(7):
                    others = self.reference(k)
                    target, ref = means[k], means[others].mean(axis=0)
                    # The common change-of-base factor cancels in the t statistic.
                    contrast = np.log(target / ref)
                    influence = scores[:, k] / target - scores[:, others].mean(axis=1) / ref
                    df = eff[k] - 1
                    se = np.sqrt(eff[k] / df * np.sum(influence ** 2, axis=0))
                    valid = (target > 0) & (ref > 0) & (se > 0)
                    tile.append(np.where(valid, 2 * stats.t.sf(np.abs(contrast / se), df), np.nan))
                p.append(tile)
        return np.asarray(p)


def smooth_null(rng, n_draws, sigma_yx, x, y, log_sd):
    # Convolution of Gaussian white noise by a Gaussian kernel. The padded
    # periodic lattice keeps the boundary outside the biopsy; exact kernel
    # L2 scaling yields a stationary field without centring on the specimen.
    sy, sx = sigma_yx
    pad_x, pad_y = int(4 * sx + 1), int(4 * sy + 1)
    xs, ys = x - x.min() + pad_x, y - y.min() + pad_y
    noise = rng.normal(size=(n_draws, int(ys.max() + pad_y + 1), int(xs.max() + pad_x + 1)))
    field = ndimage.gaussian_filter(noise, sigma=(0, sy, sx), mode='wrap')
    variance = 1.
    for scale in (sy, sx):
        radius = int(4 * scale + 0.5)
        kernel = np.exp(-(np.arange(-radius, radius + 1) ** 2) / (2 * scale ** 2))
        variance *= np.sum((kernel / kernel.sum()) ** 2)
    return np.exp(log_sd * field[:, ys, xs].T / np.sqrt(variance) - log_sd ** 2 / 2)


def observed_residual_correlations(x, y, layer, region, total, counts):
    # Gene-level heterogeneity that remains even after centring each measured
    # region-by-layer domain. These diagnostics do not require asymptotic P values.
    residual = np.log1p(counts * (10000 / total[:, None]))
    domains = np.array([r + '/' + l for r, l in zip(region, layer)])
    for domain in np.unique(domains):
        mask = domains == domain
        residual[mask] -= residual[mask].mean(axis=0)
    locations = dict(zip(zip(x, y), range(len(x))))
    records = []
    for lag in (1, 6, 15):
        for axis, (dx, dy) in [('x', (lag, 0)), ('y', (0, lag))]:
            pairs = [(i, locations[(a + dx, b + dy)]) for i, (a, b) in enumerate(zip(x, y))
                     if (a + dx, b + dy) in locations and domains[i] == domains[locations[(a + dx, b + dy)]]]
            i, j = np.asarray(pairs).T
            a, b = residual[i], residual[j]
            a, b = a - a.mean(axis=0), b - b.mean(axis=0)
            denominator = np.sqrt((a * a).sum(axis=0) * (b * b).sum(axis=0))
            corr = np.divide((a * b).sum(axis=0), denominator, out=np.full(len(GENES), np.nan), where=denominator > 0)
            records.append({'axis': axis, 'lag_bins': lag, 'within_domain_pairs': len(pairs),
                            'genes_with_defined_r': int(np.isfinite(corr).sum()),
                            'r_min_median_max': np.round(np.nanquantile(corr, [0, .5, 1]), 3).tolist()})
    return records



def encode_json(value):
    return (json.dumps(value, ensure_ascii=False, separators=(',', ':'), allow_nan=False) + '\n').encode()


def publish_models(source, output, report, test, total):
    """Release per-contrast exploratory statistics only on the calibrated geometry."""
    import h5py

    manifest_path = output / 't503.json'
    manifest = json.loads(manifest_path.read_bytes())
    if (source.suffix != '.h5ad' or manifest['section'] != 'T503' or
            manifest['sourceSha256'] != SOURCE_SHA or manifest['groups'] != GROUPS):
        raise ValueError('Publishing requires the audited T503 H5AD and its matching layer summary')
    packed = (output / manifest['dataFile']).read_bytes()
    if hashlib.sha256(packed).hexdigest() != manifest['dataSha256']:
        raise ValueError('Summary hash mismatch')
    genes = manifest['genes']
    expected_means = np.frombuffer(packed, dtype='<f8', count=len(genes) * 8).reshape(-1, 8)
    np.testing.assert_array_equal(test.n, manifest['counts'])
    accepted = [k for k, name in enumerate(CONTRASTS) if report['results'][name]['calibration_gate_passed']]
    raw_p = {k: np.full(len(genes), np.nan) for k in accepted}
    effects = {k: np.full(len(genes), np.nan) for k in accepted}

    with h5py.File(source, 'r') as f:
        np.testing.assert_array_equal(f['var/_index'].asstr()[:], genes)
        x = f['X']
        shape = tuple(map(int, x.attrs['shape']))
        matrix = sparse.csr_matrix((x['data'][:], x['indices'][:], x['indptr'][:]), shape=shape).tocsc()
    for start in range(0, len(genes), 96):
        end = min(start + 96, len(genes))
        cp10k = matrix[:, start:end].toarray() * (10000 / total[:, None])
        means = (test.groups @ cp10k) / test.n[:, None]
        np.testing.assert_allclose(means.T, expected_means[start:end], rtol=1e-11, atol=0.)
        # Independently of group labels, restrict the observed pooled abundance
        # to the envelope studied in the null simulations. Each contrast is a
        # separate BH family. Unestimable log-ratios have no model result.
        pooled = cp10k.mean(axis=0)
        in_range = (pooled >= min(RATES)) & (pooled <= max(RATES))
        if not accepted or not np.any(in_range):
            continue
        p = test.run(cp10k[:, in_range]).max(axis=0)
        for k in accepted:
            cols = np.flatnonzero(in_range)[np.isfinite(p[k])]
            raw_p[k][start + cols] = p[k, np.isfinite(p[k])]
            effects[k][start + cols] = np.log2(means[k, cols] / means[test.reference(k)][:, cols].mean(axis=0))

    tests = {}
    for k in accepted:
        contrast = GROUPS[k]
        eligible = np.flatnonzero(np.isfinite(raw_p[k]))
        if len(eligible) == 0:
            continue
        adjusted = np.full(len(genes), np.nan)
        adjusted[eligible] = stats.false_discovery_control(raw_p[k][eligible], method='bh')
        calibration = report['results'][CONTRASTS[k]]
        analysis = {
            'method': report['method'], 'modelVersion': 'spatial-block-v1', 'scope': CALIBRATION_SCOPE,
            'adjustment': 'BH', 'nTested': int(len(eligible)), 'qcStatus': 'accepted',
            'filter': 'Whole-section mean CP10k in [0.002, 3.0], both contrast means positive and SE estimable on all six tilings.',
            'calibration': (f"{calibration['null_scenarios_passed']}/{len(calibration['calibration'])} simulated null "
                            f"scenarios passed at alpha={ALPHA}; min effective spatial blocks "
                            f"{calibration['minimum_effective_spatial_blocks']}."),
            'reportFile': 't503-spatial-validation.json',
            'reportSha256': hashlib.sha256((output / 't503-spatial-validation.json').read_bytes()).hexdigest()
        }
        def nullable(values):
            return [float(v) if np.isfinite(v) else None for v in values]
        result = {'format': 'marmoset-st-contrast-tests-v1', 'section': 'T503', 'contrast': contrast,
                  'genes': genes, 'sourceSha256': SOURCE_SHA, 'summarySha256': manifest['dataSha256'],
                  'analysis': analysis, 'p': nullable(raw_p[k]), 'q': nullable(adjusted),
                  'modelLog2FC': nullable(effects[k])}
        content = encode_json(result)
        digest = hashlib.sha256(content).hexdigest()
        filename = f't503-{contrast.lower()}-{digest[:16]}.json'
        (output / filename).write_bytes(content)
        tests[contrast] = {'file': filename, 'sha256': digest}
    manifest['tests'] = tests
    manifest['testStatus'] = 'partial' if tests else 'not_tested'
    manifest_path.write_bytes(encode_json(manifest))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('input', type=Path)
    parser.add_argument('output', type=Path)
    parser.add_argument('--publish', type=Path, help='Layer asset directory containing the matching t503.json')
    args = parser.parse_args()
    if args.publish and (args.input.suffix != '.h5ad' or
                         args.output.resolve() != (args.publish / 't503-spatial-validation.json').resolve()):
        parser.error('Use the public H5AD and write the calibration report into the layer asset directory when publishing')
    x, y, layer, region, total, counts = raw_input(args.input)
    if (len(x) != 7205 or len(set(zip(x, y))) != 7205 or set(layer) != set(LAYERS)
            or set(region) != {'V1', 'V2', 'V3', 'A19DI'} or total.sum() != 172964194
            or np.any(total <= 0) or np.any(counts < 0) or not np.issubdtype(counts.dtype, np.integer)):
        raise ValueError('The input is not the audited T503 cortical bin panel')
    x, y = x.astype(int), y.astype(int)
    test = SpatialBlockTest(x, y, layer, region)
    observed = test.run(counts * (10000 / total[:, None]))
    effective = np.min([item[2] for item in test.tilings], axis=0)
    calibration = {name: [] for name in CONTRASTS}
    rng = np.random.default_rng(SEED)
    profiles = [('isotropic', (s, s), RATES, 0.7, rng) for s in SCALES]
    # Independent confirmatory stress settings, evaluated for every contrast.
    stress_rng = np.random.default_rng(SEED + 1)
    profiles.extend(('long_range_or_anisotropic', s, [0.5, 3.0], 1., stress_rng)
                    for s in ((3., 20.), (20., 3.), (30., 30.)))
    for family, scales, rates, log_sd, generator in profiles:
        by_rate = {rate: [] for rate in rates}
        for start in range(0, DRAWS, 16):
            field = smooth_null(generator, min(16, DRAWS - start), scales, x, y, log_sd)
            for rate in rates:
                null_counts = generator.poisson(rate * total[:, None] / 10000 * field)
                # Conservative pre-specified combination across sizes and origins.
                by_rate[rate].append(test.run(null_counts * (10000 / total[:, None])).max(axis=0))
        for rate, batches in by_rate.items():
            for name, p in zip(CONTRASTS, np.concatenate(batches, axis=1)):
                n = int(np.isfinite(p).sum())
                hits = int(np.sum(p < ALPHA))
                interval = stats.binomtest(hits, n).proportion_ci(confidence_level=.95) if n else (0., 1.)
                calibration[name].append({'family': family, 'kernel_sigma_yx_bins': list(scales), 'kernel_log_rate_sd': log_sd,
                    'mean_cp10k_under_null': rate,
                    'estimable': n, 'draws': DRAWS, 'false_positives': hits,
                    'fpr': round(hits / n, 4) if n else None,
                    'fpr_ci_95': [round(float(v), 4) for v in interval],
                    'passes': bool(n >= MIN_ESTIMABLE * DRAWS and interval[1] <= MAX_UPPER)})
    results = {}
    for k, name in enumerate(CONTRASTS):
        eligible = np.all(np.isfinite(observed[:, k]), axis=0)
        sensitive = (observed[:, k].min(axis=0) < ALPHA) & (observed[:, k].max(axis=0) >= ALPHA)
        scenarios = calibration[name]
        results[name] = {'calibration': scenarios, 'null_scenarios_passed': sum(s['passes'] for s in scenarios),
            'minimum_effective_spatial_blocks': round(float(effective[k]), 3),
            'pilot_genes_estimable_all_tilings': int(eligible.sum()),
            'pilot_genes_nominal_classification_changes_with_tiling': int(np.sum(sensitive & eligible)),
            'calibration_gate_passed': bool(effective[k] >= MIN_EFFECTIVE_BLOCKS and all(s['passes'] for s in scenarios))}
    result = {'schema_version': 1, 'section': 'T503', 'source_sha256': SOURCE_SHA, 'spatial_bins': len(x),
        'pilot_genes': GENES, 'method': 'Spatial-block delta-method SE for CP10k log mean ratio; t degrees of freedom from effective spatial block count; maximum P over all grid tilings.',
        'null': 'Independent Poisson counts conditional on spatially correlated lognormal rates, mean CP10k constant across regions, fixed observed UMI per bin; stationary Gaussian kernel fields on padded native grid.',
        'observed_within_domain_residual_correlations': observed_residual_correlations(x, y, layer, region, total, counts),
        'block_side_bins': BLOCK_SIDES, 'grid_shifts_fraction': [0., .5],
        'seed': SEED, 'stress_seed': SEED + 1, 'calibration_nominal_alpha': ALPHA, 'required_estimable_fraction': MIN_ESTIMABLE,
        'required_minimum_effective_spatial_blocks': MIN_EFFECTIVE_BLOCKS, 'maximum_allowed_upper_fpr_ci': MAX_UPPER,
        'contrast_order': CONTRASTS, 'results': results,
        'scope': CALIBRATION_SCOPE}
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False) + '\n')
    if args.publish:
        publish_models(args.input, args.publish, result, test, total)


if __name__ == '__main__':
    main()
