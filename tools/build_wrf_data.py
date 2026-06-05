#!/usr/bin/env python3
# -*- coding: utf-8 -*-

import argparse
import json
import re
from pathlib import Path
from datetime import datetime, timedelta, timezone

import numpy as np


def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument(
        "--wrf-file",
        default="/home/koos_wrf/OUTPUT/WRF/Op_out/202605/wrfout_d02_2026051212.nc",
    )
    p.add_argument("--out-dir", default="data/wrf")
    p.add_argument("--cycle", default=None, help="예: 2026051212. 생략하면 파일명에서 추정")
    p.add_argument("--hours", type=int, default=24, help="하루면 24. frame 수는 hours+1")
    return p.parse_args()


def infer_cycle(path):
    m = re.search(r"(\d{10})", Path(path).name)
    if not m:
        raise ValueError(f"Cannot infer cycle from filename: {path}")
    return m.group(1)


def read_nc_var(ds, name):
    if name not in ds.variables:
        raise KeyError(f"missing variable: {name}")
    return np.asarray(ds.variables[name][:], dtype=np.float32)


def clean_float(arr):
    out = arr.astype(np.float32, copy=True)
    out[~np.isfinite(out)] = np.nan
    out[np.abs(out) > 1.0e30] = np.nan
    return out


def centers_to_corners(a):
    """
    Build approximate corner grid from center grid.
    Good enough for WebGL cell rendering.
    Shape:
      center: ny,nx
      corner: ny+1,nx+1
    """
    a = np.asarray(a, dtype=np.float32)
    ny, nx = a.shape

    pad = np.pad(a, ((1, 1), (1, 1)), mode="edge")

    c = 0.25 * (
        pad[0:ny + 1, 0:nx + 1] +
        pad[1:ny + 2, 0:nx + 1] +
        pad[0:ny + 1, 1:nx + 2] +
        pad[1:ny + 2, 1:nx + 2]
    )

    return c.astype(np.float32)


def write_bin(path, arr):
    path.parent.mkdir(parents=True, exist_ok=True)
    arr.astype(np.float32).ravel().tofile(path)


def write_timeseries_bin(path, arr3d):
    """
    Cell-major time-series:
      [cell0_t0, cell0_t1, ..., cell0_tN,
       cell1_t0, cell1_t1, ...]
    arr3d shape = nt,ny,nx
    """
    nt, ny, nx = arr3d.shape
    out = arr3d.reshape(nt, ny * nx).T.copy()
    path.parent.mkdir(parents=True, exist_ok=True)
    out.astype(np.float32).tofile(path)


def main():
    args = parse_args()

    wrf_file = Path(args.wrf_file)
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    cycle = args.cycle or infer_cycle(wrf_file)
    cycle_dt = datetime.strptime(cycle, "%Y%m%d%H").replace(tzinfo=timezone.utc)

    try:
        from netCDF4 import Dataset
    except Exception as e:
        raise RuntimeError("netCDF4 is required: pip install netCDF4") from e

    print("[INFO] WRF file:", wrf_file)
    print("[INFO] cycle:", cycle)

    with Dataset(str(wrf_file), "r") as ds:
        xlat_all = read_nc_var(ds, "XLAT")
        xlon_all = read_nc_var(ds, "XLON")

        u10_all = clean_float(read_nc_var(ds, "U10"))
        v10_all = clean_float(read_nc_var(ds, "V10"))
        t2_all = clean_float(read_nc_var(ds, "T2"))
        slp_all = clean_float(read_nc_var(ds, "SLP"))

        nt_src = min(u10_all.shape[0], v10_all.shape[0], t2_all.shape[0], slp_all.shape[0])
        nt = min(nt_src, int(args.hours) + 1)

        # XLAT/XLON may have time dimension. Use first frame.
        lon2d = clean_float(xlon_all[0] if xlon_all.ndim == 3 else xlon_all)
        lat2d = clean_float(xlat_all[0] if xlat_all.ndim == 3 else xlat_all)

        u10 = u10_all[:nt]
        v10 = v10_all[:nt]
        t2 = t2_all[:nt] - 273.15
        slp = slp_all[:nt]

    ny, nx = lon2d.shape
    ncell = nx * ny

    print("[INFO] source frames:", nt_src)
    print("[INFO] using frames:", nt)
    print("[INFO] grid:", nx, ny)

    wind_speed = np.hypot(u10, v10).astype(np.float32)

    # 전체 WRF domain 표출
    mask = np.ones((ny, nx), dtype=np.float32)

    lonc2d = centers_to_corners(lon2d)
    latc2d = centers_to_corners(lat2d)

    grid_dir = out_dir / "grid"
    write_bin(grid_dir / "lon.bin", lon2d)
    write_bin(grid_dir / "lat.bin", lat2d)
    write_bin(grid_dir / "mask.bin", mask)
    write_bin(grid_dir / "lon_corner.bin", lonc2d)
    write_bin(grid_dir / "lat_corner.bin", latc2d)

    # WRF regular-ish grid: direct identity lookup
    lookup = np.arange(ncell, dtype=np.int32)
    lookup.tofile(grid_dir / "particle_lookup_cell.bin")

    frames = []

    for it in range(nt):
        t = cycle_dt + timedelta(hours=it)

        wind_name = f"wind_speed/frame_{it:04d}.bin"
        t2_name = f"t2/frame_{it:04d}.bin"
        slp_name = f"slp/frame_{it:04d}.bin"
        u_name = f"current_u/frame_{it:04d}.bin"
        v_name = f"current_v/frame_{it:04d}.bin"

        write_bin(out_dir / wind_name, wind_speed[it])
        write_bin(out_dir / t2_name, t2[it])
        write_bin(out_dir / slp_name, slp[it])
        write_bin(out_dir / u_name, u10[it])
        write_bin(out_dir / v_name, v10[it])

        frames.append({
            "index": it,
            "time_utc": t.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "label": t.strftime("%Y-%m-%d %H:%M:%S UTC"),
            "files": {
                "wind_speed": wind_name,
                "t2": t2_name,
                "slp": slp_name,
                "current_u": u_name,
                "current_v": v_name
            }
        })

    # Fast point time-series files
    write_timeseries_bin(out_dir / "timeseries/wind_speed_ts.bin", wind_speed)
    write_timeseries_bin(out_dir / "timeseries/t2_ts.bin", t2)
    write_timeseries_bin(out_dir / "timeseries/slp_ts.bin", slp)

    meta = {
        "format": "koos-wrf-grid-v1",
        "system": "KOOS",
        "model": "WRF",
        "cycle": cycle,
        "cycle_utc": cycle_dt.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "forecast_start_utc": frames[0]["time_utc"],
        "forecast_end_utc": frames[-1]["time_utc"],
        "source_files": {
            "wrfout": str(wrf_file)
        },
        "grid": {
            "nx": int(nx),
            "ny": int(ny),
            "corner_nx": int(nx + 1),
            "corner_ny": int(ny + 1),
            "n": int(ncell),
            "lon_min": float(np.nanmin(lon2d)),
            "lon_max": float(np.nanmax(lon2d)),
            "lat_min": float(np.nanmin(lat2d)),
            "lat_max": float(np.nanmax(lat2d)),
            "lon_file": "grid/lon.bin",
            "lat_file": "grid/lat.bin",
            "mask_file": "grid/mask.bin",
            "lon_corner_file": "grid/lon_corner.bin",
            "lat_corner_file": "grid/lat_corner.bin",
            "particle_lookup_file": "grid/particle_lookup_cell.bin",
            "particle_lookup_nx": int(nx),
            "particle_lookup_ny": int(ny),
        },
        "variables": {
            "wind_speed": {
                "label": "Wind",
                "unit": "m/s",
                "vmin": 0.0,
                "vmax": 20.0,
                "cmap": "turbo"
            },
            "t2": {
                "label": "2m Temperature",
                "unit": "degC",
                "vmin": 0.0,
                "vmax": 32.0,
                "cmap": "turbo"
            },
            "slp": {
                "label": "SLP",
                "unit": "hPa",
                "vmin": 990.0,
                "vmax": 1030.0,
                "cmap": "bwr"
            }
        },
        "timeseries": {
            "layout": "cell_major",
            "dtype": "float32",
            "n": int(ncell),
            "nt": int(nt),
            "variables": {
                "wind_speed": {
                    "file": "timeseries/wind_speed_ts.bin",
                    "count": int(nt)
                },
                "t2": {
                    "file": "timeseries/t2_ts.bin",
                    "count": int(nt)
                },
                "slp": {
                    "file": "timeseries/slp_ts.bin",
                    "count": int(nt)
                }
            }
        },
        "particles": {
            "kind": "wind",
            "color_by_speed": True
        },
        "frames": frames
    }

    (out_dir / "meta.json").write_text(
        json.dumps(meta, indent=2, ensure_ascii=False),
        encoding="utf-8"
    )

    print("[INFO] wind min/max:", float(np.nanmin(wind_speed)), float(np.nanmax(wind_speed)))
    print("[INFO] t2 min/max:", float(np.nanmin(t2)), float(np.nanmax(t2)))
    print("[INFO] slp min/max:", float(np.nanmin(slp)), float(np.nanmax(slp)))
    print("[DONE]", out_dir / "meta.json")


if __name__ == "__main__":
    main()
