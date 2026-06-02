#!/usr/bin/env python3
# -*- coding: utf-8 -*-

import argparse
import json
import re
from pathlib import Path
from datetime import datetime, timedelta, timezone

import numpy as np


def parse_args():
    ap = argparse.ArgumentParser()
    ap.add_argument("--swan-dir", default="/home/koos_mohid/FORECAST_UST/DOUT/SWAN/L2")
    ap.add_argument("--out-dir", default="data/swan")
    ap.add_argument("--cycle", required=True, help="예: 2026051212")
    ap.add_argument("--drop-last", action="store_true", help="마지막 중복 frame 제거")
    ap.add_argument("--dir-convention", choices=["to", "from"], default="to",
                    help="Dr 방향. 반대로 보이면 from으로 다시 생성")
    return ap.parse_args()


# SWAN L2 grid
X0 = 117.50000
Y0 = 28.66667
XLEN = 15.00000
YLEN = 14.83333
MXC = 719
MYC = 711
NX = MXC + 1
NY = MYC + 1
N = NX * NY
FLIP_Y = True
FRAME_INTERVAL_HOURS = 1


def read_swan_ascii(path):
    values = np.loadtxt(str(path), dtype=np.float32).ravel()

    if values.size % N != 0:
        raise ValueError(
            f"{path}: value count mismatch, values={values.size}, nx*ny={N}"
        )

    nt = values.size // N
    arr = values.reshape(nt, NY, NX).astype(np.float32, copy=False)

    arr[~np.isfinite(arr)] = np.nan
    arr[arr < -1.0e20] = np.nan
    arr[arr > 1.0e20] = np.nan

    if FLIP_Y:
        arr = arr[:, ::-1, :]

    return arr


def find_file(swan_dir, prefix, cycle):
    hits = sorted(Path(swan_dir).glob(f"{prefix}_{cycle}*"))
    if not hits:
        raise FileNotFoundError(f"missing {prefix}_{cycle}* in {swan_dir}")
    return hits[0]


def make_grid(out_dir):
    lon1d = np.linspace(X0, X0 + XLEN, NX, dtype=np.float32)
    lat1d = np.linspace(Y0, Y0 + YLEN, NY, dtype=np.float32)

    if FLIP_Y:
        lat1d = lat1d[::-1].copy()

    lon2d, lat2d = np.meshgrid(lon1d, lat1d)

    mask = np.ones((NY, NX), dtype=np.float32)

    # corner grid for existing MOHID renderer
    dx = float(XLEN) / float(MXC)
    dy = float(YLEN) / float(MYC)

    lon_corner_1d = np.linspace(X0 - dx / 2, X0 + XLEN + dx / 2, NX + 1, dtype=np.float32)
    lat_corner_1d = np.linspace(Y0 - dy / 2, Y0 + YLEN + dy / 2, NY + 1, dtype=np.float32)

    if FLIP_Y:
        lat_corner_1d = lat_corner_1d[::-1].copy()

    lonc2d, latc2d = np.meshgrid(lon_corner_1d, lat_corner_1d)

    # particle lookup: regular grid identity
    lookup = np.arange(N, dtype=np.int32)

    lon2d.ravel().astype(np.float32).tofile(out_dir / "lon.bin")
    lat2d.ravel().astype(np.float32).tofile(out_dir / "lat.bin")
    mask.ravel().astype(np.float32).tofile(out_dir / "mask.bin")
    lonc2d.ravel().astype(np.float32).tofile(out_dir / "lon_corner.bin")
    latc2d.ravel().astype(np.float32).tofile(out_dir / "lat_corner.bin")
    lookup.tofile(out_dir / "particle_lookup_cell.bin")

    return {
        "nx": NX,
        "ny": NY,
        "corner_nx": NX + 1,
        "corner_ny": NY + 1,
        "n": N,
        "lon_min": float(np.nanmin(lon2d)),
        "lon_max": float(np.nanmax(lon2d)),
        "lat_min": float(np.nanmin(lat2d)),
        "lat_max": float(np.nanmax(lat2d)),
        "lon_file": "lon.bin",
        "lat_file": "lat.bin",
        "mask_file": "mask.bin",
        "lon_corner_file": "lon_corner.bin",
        "lat_corner_file": "lat_corner.bin",
        "particle_lookup_cell_file": "particle_lookup_cell.bin",
        "particle_lookup_nx": NX,
        "particle_lookup_ny": NY,
    }


def direction_to_uv(dr_deg, convention):
    """
    Dr degree를 입자 이동용 unit vector로 변환.
    현재는 0도=북, 90도=동 기준으로 처리.
    반대로 보이면 --dir-convention from 으로 다시 생성.
    """
    theta = np.deg2rad(dr_deg.astype(np.float32))

    u = np.sin(theta)
    v = np.cos(theta)

    if convention == "from":
        u = -u
        v = -v

    u = np.where(np.isfinite(dr_deg), u, np.nan).astype(np.float32)
    v = np.where(np.isfinite(dr_deg), v, np.nan).astype(np.float32)

    return u, v


def clean_var(arr, vmin, vmax):
    out = arr.astype(np.float32, copy=True)
    out[~np.isfinite(out)] = np.nan
    out[out < vmin] = np.nan
    out[out > vmax] = np.nan
    return out


def main():
    args = parse_args()

    swan_dir = Path(args.swan_dir)
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    hs_file = find_file(swan_dir, "Hs", args.cycle)
    tp_file = find_file(swan_dir, "Tp", args.cycle)
    dr_file = find_file(swan_dir, "Dr", args.cycle)

    print("[INFO] Hs:", hs_file)
    print("[INFO] Tp:", tp_file)
    print("[INFO] Dr:", dr_file)

    hs = clean_var(read_swan_ascii(hs_file), 0.0, 100.0)
    tp = clean_var(read_swan_ascii(tp_file), 0.0, 100.0)
    dr = clean_var(read_swan_ascii(dr_file), -360.0, 720.0)

    nt = min(hs.shape[0], tp.shape[0], dr.shape[0])

    if args.drop_last and nt > 1:
        nt -= 1

    hs = hs[:nt]
    tp = tp[:nt]
    dr = dr[:nt]

    grid_meta = make_grid(out_dir)

    cycle_dt = datetime.strptime(args.cycle, "%Y%m%d%H").replace(tzinfo=timezone.utc)

    frames = []

    for it in range(nt):
        t = cycle_dt + timedelta(hours=FRAME_INTERVAL_HOURS * it)
        stamp = t.strftime("%Y%m%d%H")

        hs_name = f"hs_{it:04d}.bin"
        tp_name = f"tp_{it:04d}.bin"
        u_name = f"wave_u_{it:04d}.bin"
        v_name = f"wave_v_{it:04d}.bin"

        u, v = direction_to_uv(dr[it], args.dir_convention)

        hs[it].ravel().astype(np.float32).tofile(out_dir / hs_name)
        tp[it].ravel().astype(np.float32).tofile(out_dir / tp_name)
        u.ravel().astype(np.float32).tofile(out_dir / u_name)
        v.ravel().astype(np.float32).tofile(out_dir / v_name)

        frames.append({
            "index": it,
            "time_utc": t.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "label": t.strftime("%Y-%m-%d %H:%M UTC"),
            "files": {
                "hs": hs_name,
                "tp": tp_name,
                "current_u": u_name,
                "current_v": v_name
            }
        })

    meta = {
        "model": "swan",
        "cycle": args.cycle,
        "forecast_start_utc": frames[0]["time_utc"] if frames else None,
        "forecast_end_utc": frames[-1]["time_utc"] if frames else None,
        "grid": grid_meta,
        "variables": {
            "hs": {
                "label": "Significant Wave Height",
                "unit": "m",
                "vmin": 0.0,
                "vmax": 5.0,
                "cmap": "turbo"
            },
            "tp": {
                "label": "Peak Wave Period",
                "unit": "s",
                "vmin": 1.0,
                "vmax": 10.0,
                "cmap": "viridis"
            }
        },
        "particles": {
            "kind": "wave_direction",
            "color_by_speed": False,
            "direction_convention": args.dir_convention
        },
        "frames": frames
    }

    (out_dir / "meta.json").write_text(
        json.dumps(meta, indent=2, ensure_ascii=False),
        encoding="utf-8"
    )

    print("[DONE]", out_dir / "meta.json")
    print("[INFO] frames:", nt)


if __name__ == "__main__":
    main()
