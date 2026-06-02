#!/usr/bin/env python3
import argparse
import json
from pathlib import Path

import numpy as np


def load_float32(path, shape=None):
    arr = np.fromfile(path, dtype=np.float32)
    if shape is not None:
        arr = arr.reshape(shape)
    return arr


def try_kdtree_build(points, queries, max_dist):
    try:
        from scipy.spatial import cKDTree
    except Exception:
        return None

    tree = cKDTree(points)
    dist, idx = tree.query(queries, k=1)

    out = idx.astype(np.int32)
    out[dist > max_dist] = -1
    return out


def fallback_binned_build(
    valid_cells,
    lon_flat,
    lat_flat,
    lookup_nx,
    lookup_ny,
    lon_min,
    lon_max,
    lat_min,
    lat_max,
    max_dist,
):
    bins = [[] for _ in range(lookup_nx * lookup_ny)]

    def to_bin(lon, lat):
        if lon < lon_min or lon > lon_max or lat < lat_min or lat > lat_max:
            return -1, -1, -1

        ix = int((lon - lon_min) / (lon_max - lon_min) * lookup_nx)
        iy = int((lat - lat_min) / (lat_max - lat_min) * lookup_ny)

        ix = max(0, min(lookup_nx - 1, ix))
        iy = max(0, min(lookup_ny - 1, iy))

        return ix, iy, iy * lookup_nx + ix

    for cell in valid_cells:
        ix, iy, b = to_bin(lon_flat[cell], lat_flat[cell])
        if b >= 0:
            bins[b].append(int(cell))

    lookup = np.full(lookup_nx * lookup_ny, -1, dtype=np.int32)

    mid_lat = 0.5 * (lat_min + lat_max)
    cos0 = max(0.2, np.cos(np.deg2rad(mid_lat)))

    for jy in range(lookup_ny):
        if jy % 50 == 0:
            print(f"[fallback] row {jy}/{lookup_ny}")

        qlat = lat_min + (jy + 0.5) / lookup_ny * (lat_max - lat_min)

        for ix in range(lookup_nx):
            qlon = lon_min + (ix + 0.5) / lookup_nx * (lon_max - lon_min)

            best_cell = -1
            best_d2 = 1.0e30

            for r in range(0, 12):
                found_any = False

                for dy in range(-r, r + 1):
                    for dx in range(-r, r + 1):
                        if abs(dx) != r and abs(dy) != r:
                            continue

                        bx = ix + dx
                        by = jy + dy

                        if bx < 0 or by < 0 or bx >= lookup_nx or by >= lookup_ny:
                            continue

                        cand = bins[by * lookup_nx + bx]
                        if not cand:
                            continue

                        found_any = True

                        for cell in cand:
                            dlon = (lon_flat[cell] - qlon) * cos0
                            dlat = lat_flat[cell] - qlat
                            d2 = dlon * dlon + dlat * dlat

                            if d2 < best_d2:
                                best_d2 = d2
                                best_cell = cell

                if found_any:
                    break

            if best_cell >= 0 and np.sqrt(best_d2) <= max_dist:
                lookup[jy * lookup_nx + ix] = best_cell

    return lookup


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-dir", default="data/mohid")
    parser.add_argument("--lookup-nx", type=int, default=600)
    parser.add_argument("--lookup-ny", type=int, default=600)
    parser.add_argument("--max-distance-deg", type=float, default=0.12)
    args = parser.parse_args()

    data_dir = Path(args.data_dir)
    meta_path = data_dir / "meta.json"

    meta = json.loads(meta_path.read_text(encoding="utf-8"))

    nx = int(meta["grid"]["nx"])
    ny = int(meta["grid"]["ny"])

    lon_min = float(meta["grid"]["lon_min"])
    lon_max = float(meta["grid"]["lon_max"])
    lat_min = float(meta["grid"]["lat_min"])
    lat_max = float(meta["grid"]["lat_max"])

    lon = load_float32(data_dir / meta["grid"]["lon_file"], (ny, nx))
    lat = load_float32(data_dir / meta["grid"]["lat_file"], (ny, nx))
    mask = load_float32(data_dir / meta["grid"]["mask_file"], (ny, nx))

    lon_flat = lon.ravel()
    lat_flat = lat.ravel()
    mask_flat = mask.ravel()

    valid = (
        np.isfinite(lon_flat)
        & np.isfinite(lat_flat)
        & np.isfinite(mask_flat)
        & (mask_flat > 0)
    )

    valid_cells = np.where(valid)[0].astype(np.int32)

    print(f"[INFO] valid cells: {valid_cells.size}")
    print(f"[INFO] lookup grid: {args.lookup_nx} x {args.lookup_ny}")
    print(f"[INFO] max distance deg: {args.max_distance_deg}")

    mid_lat = 0.5 * (lat_min + lat_max)
    cos0 = max(0.2, np.cos(np.deg2rad(mid_lat)))

    points = np.column_stack([
        lon_flat[valid_cells] * cos0,
        lat_flat[valid_cells],
    ]).astype(np.float64)

    qlon = lon_min + (np.arange(args.lookup_nx) + 0.5) / args.lookup_nx * (lon_max - lon_min)
    qlat = lat_min + (np.arange(args.lookup_ny) + 0.5) / args.lookup_ny * (lat_max - lat_min)

    qlon2, qlat2 = np.meshgrid(qlon, qlat)
    queries = np.column_stack([
        qlon2.ravel() * cos0,
        qlat2.ravel(),
    ]).astype(np.float64)

    lookup_local = try_kdtree_build(points, queries, args.max_distance_deg)

    if lookup_local is None:
        print("[INFO] scipy not available. using fallback binned search.")
        lookup_cell = fallback_binned_build(
            valid_cells,
            lon_flat,
            lat_flat,
            args.lookup_nx,
            args.lookup_ny,
            lon_min,
            lon_max,
            lat_min,
            lat_max,
            args.max_distance_deg,
        )
    else:
        print("[INFO] scipy cKDTree lookup complete.")
        lookup_cell = np.full(args.lookup_nx * args.lookup_ny, -1, dtype=np.int32)
        ok = lookup_local >= 0
        lookup_cell[ok] = valid_cells[lookup_local[ok]]

    out_file = data_dir / "grid" / "particle_lookup_cell.bin"
    lookup_cell.astype(np.int32).tofile(out_file)

    covered = int(np.count_nonzero(lookup_cell >= 0))
    total = int(lookup_cell.size)
    print(f"[INFO] covered lookup pixels: {covered}/{total} ({covered / total * 100:.2f}%)")
    print(f"[DONE] {out_file}")

    meta["grid"]["particle_lookup_file"] = "grid/particle_lookup_cell.bin"
    meta["grid"]["particle_lookup_nx"] = int(args.lookup_nx)
    meta["grid"]["particle_lookup_ny"] = int(args.lookup_ny)
    meta["grid"]["particle_lookup_max_distance_deg"] = float(args.max_distance_deg)

    meta_path.write_text(
        json.dumps(meta, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )

    print(f"[DONE] updated {meta_path}")


if __name__ == "__main__":
    main()
