#!/usr/bin/env python3
# -*- coding: utf-8 -*-

import argparse
import json
import re
from pathlib import Path
from datetime import datetime, timedelta, timezone

import numpy as np


# ============================================================
# SWAN L2 grid: user validation code 기준
# CGRID REGular 117.50000 28.66667 0.0 15.00000 14.83333 719 711
# nx = MXC + 1 = 720
# ny = MYC + 1 = 712
# ============================================================

X0 = 117.50000
Y0 = 28.66667
XLEN = 15.00000
YLEN = 14.83333
MXC = 719
MYC = 711
NX = MXC + 1
NY = MYC + 1
N_PER_FRAME = NX * NY
FLIP_Y = True
FRAME_INTERVAL_HOURS = 1


def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("--swan-dir", default="/home/koos_mohid/FORECAST_UST/DOUT/SWAN/L2")
    p.add_argument("--out-dir", default="data/swan")
    p.add_argument("--cycle", default=None, help="예: 2026051212. 생략하면 Hs/Tp/Dr 공통 최신 cycle 자동 선택")
    p.add_argument("--drop-last", action="store_true", help="마지막 중복 frame 제거")
    p.add_argument("--dir-convention", choices=["to", "from"], default="to",
                   help="Dr 방향 convention. 입자가 반대면 from으로 다시 생성")
    return p.parse_args()


def collect_cycles(swan_dir, prefix):
    swan_dir = Path(swan_dir)
    cycles = set()

    for f in sorted(swan_dir.glob(f"{prefix}_*")):
        m = re.search(rf"{prefix}_(\d{{10}})", f.name)
        if m:
            cycles.add(m.group(1))

    return cycles


def choose_cycle(swan_dir, cycle):
    if cycle:
        return cycle

    hs = collect_cycles(swan_dir, "Hs")
    tp = collect_cycles(swan_dir, "Tp")
    dr = collect_cycles(swan_dir, "Dr")

    common = sorted(hs & tp & dr)

    if not common:
        raise RuntimeError(
            "No common SWAN cycle found among Hs_*, Tp_*, Dr_* in {}".format(swan_dir)
        )

    return common[-1]


def find_file(swan_dir, prefix, cycle):
    swan_dir = Path(swan_dir)

    patterns = [
        f"{prefix}_{cycle}.L2",
        f"{prefix}_{cycle}*.L2",
        f"{prefix}_{cycle}*",
    ]

    for pat in patterns:
        hits = sorted(swan_dir.glob(pat))
        if hits:
            return hits[0]

    raise FileNotFoundError(f"missing {prefix}_{cycle}* in {swan_dir}")


def read_swan_block_nohead_ascii(path):
    """
    사용자 검증 코드 방식 그대로:
      values = np.loadtxt(path).ravel()
      nt = values.size // (nx*ny)
      arr = values.reshape(nt, ny, nx)
      if FLIP_Y: arr = arr[:, ::-1, :]
    """
    path = Path(path)

    values = np.loadtxt(str(path), dtype=np.float32).ravel()

    if values.size % N_PER_FRAME != 0:
        raise ValueError(
            "{}: Unexpected value count. values.size={:,}, nx*ny={:,} (= {}*{})".format(
                path, values.size, N_PER_FRAME, NX, NY
            )
        )

    nt = values.size // N_PER_FRAME
    arr = values.reshape(nt, NY, NX).astype(np.float32, copy=False)

    arr[~np.isfinite(arr)] = np.nan

    if FLIP_Y:
        arr = arr[:, ::-1, :].copy()

    return arr


def clean_hs(arr):
    out = arr.astype(np.float32, copy=True)
    out[~np.isfinite(out)] = np.nan

    # 홈페이지 표출용: 육지/결측으로 보이는 0 이하 제거
    out[out <= 0.0] = np.nan
    out[out > 100.0] = np.nan

    return out


def clean_tp(arr):
    out = arr.astype(np.float32, copy=True)
    out[~np.isfinite(out)] = np.nan

    # Tp는 컬러바 1~10s. 1 미만은 결측/육지로 처리
    out[out < 1.0] = np.nan
    out[out > 100.0] = np.nan

    return out


def clean_dr(arr):
    out = arr.astype(np.float32, copy=True)
    out[~np.isfinite(out)] = np.nan
    out[out < -360.0] = np.nan
    out[out > 720.0] = np.nan
    return out


def build_lonlat_and_corners():
    lon1d = np.linspace(X0, X0 + XLEN, NX, dtype=np.float32)
    lat1d = np.linspace(Y0, Y0 + YLEN, NY, dtype=np.float32)

    # IMPORTANT:
    # The user's verified SWAN quicklook uses:
    #   lon = linspace(X0, X0+XLEN)
    #   lat = linspace(Y0, Y0+YLEN)
    #   data = flipud(raw_frame)
    # Therefore coordinates must stay ascending.
    lon2d, lat2d = np.meshgrid(lon1d, lat1d)

    dx = XLEN / MXC
    dy = YLEN / MYC

    lonc1d = np.linspace(X0 - dx / 2.0, X0 + XLEN + dx / 2.0, NX + 1, dtype=np.float32)
    latc1d = np.linspace(Y0 - dy / 2.0, Y0 + YLEN + dy / 2.0, NY + 1, dtype=np.float32)

    # Same rule for corners: keep coordinates ascending.
    lonc2d, latc2d = np.meshgrid(lonc1d, latc1d)

    return lon2d, lat2d, lonc2d, latc2d


def direction_to_unit_uv(dr_deg, convention="to"):
    """
    Dr degree를 wave direction 입자용 unit vector로 변환.
    가정:
      0 deg = North
      90 deg = East

    입자 방향이 반대로 보이면 --dir-convention from 으로 재생성.
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


def write_bin(path, arr):
    arr.astype(np.float32).ravel().tofile(path)


def main():
    args = parse_args()

    swan_dir = Path(args.swan_dir)
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    cycle = choose_cycle(swan_dir, args.cycle)

    hs_file = find_file(swan_dir, "Hs", cycle)
    tp_file = find_file(swan_dir, "Tp", cycle)
    dr_file = find_file(swan_dir, "Dr", cycle)

    print("[INFO] cycle:", cycle)
    print("[INFO] Hs:", hs_file)
    print("[INFO] Tp:", tp_file)
    print("[INFO] Dr:", dr_file)

    hs_raw = read_swan_block_nohead_ascii(hs_file)
    tp_raw = read_swan_block_nohead_ascii(tp_file)
    dr_raw = read_swan_block_nohead_ascii(dr_file)

    nt = min(hs_raw.shape[0], tp_raw.shape[0], dr_raw.shape[0])

    if args.drop_last and nt > 1:
        nt -= 1

    hs = clean_hs(hs_raw[:nt])
    tp = clean_tp(tp_raw[:nt])
    dr = clean_dr(dr_raw[:nt])

    print("[INFO] raw frame counts:", hs_raw.shape[0], tp_raw.shape[0], dr_raw.shape[0])
    print("[INFO] using frames:", nt)
    print("[INFO] grid:", NX, NY, "flip_y:", FLIP_Y)

    lon2d, lat2d, lonc2d, latc2d = build_lonlat_and_corners()

    # 육지 mask: Hs가 전체 예측기간 중 한 번이라도 유효한 곳만 wet
    wet = np.any(np.isfinite(hs), axis=0)
    mask = wet.astype(np.float32)

    # particle lookup은 regular grid identity. land는 u/v가 NaN이라 vectorAt에서 자동 제외됨.
    lookup = np.arange(N_PER_FRAME, dtype=np.int32).reshape(NY, NX)
    lookup[~wet] = -1

    write_bin(out_dir / "lon.bin", lon2d)
    write_bin(out_dir / "lat.bin", lat2d)
    write_bin(out_dir / "mask.bin", mask)
    write_bin(out_dir / "lon_corner.bin", lonc2d)
    write_bin(out_dir / "lat_corner.bin", latc2d)
    lookup.astype(np.int32).ravel().tofile(out_dir / "particle_lookup_cell.bin")

    frames = []
    cycle_dt = datetime.strptime(cycle, "%Y%m%d%H").replace(tzinfo=timezone.utc)

    for it in range(nt):
        t = cycle_dt + timedelta(hours=it * FRAME_INTERVAL_HOURS)

        hs_frame = hs[it].copy()
        tp_frame = tp[it].copy()
        dr_frame = dr[it].copy()

        # mask 밖은 무조건 NaN
        hs_frame[~wet] = np.nan
        tp_frame[~wet] = np.nan
        dr_frame[~wet] = np.nan

        u, v = direction_to_unit_uv(dr_frame, args.dir_convention)
        u[~wet] = np.nan
        v[~wet] = np.nan

        hs_name = f"hs_{it:04d}.bin"
        tp_name = f"tp_{it:04d}.bin"
        wu_name = f"current_u_{it:04d}.bin"
        wv_name = f"current_v_{it:04d}.bin"

        write_bin(out_dir / hs_name, hs_frame)
        write_bin(out_dir / tp_name, tp_frame)
        write_bin(out_dir / wu_name, u)
        write_bin(out_dir / wv_name, v)

        frames.append({
            "index": it,
            "time_utc": t.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "label": t.strftime("%Y-%m-%d %H:%M UTC"),
            "files": {
                "hs": hs_name,
                "tp": tp_name,
                "current_u": wu_name,
                "current_v": wv_name
            }
        })

    meta = {
        "model": "swan",
        "cycle": cycle,
        "forecast_start_utc": frames[0]["time_utc"] if frames else None,
        "forecast_end_utc": frames[-1]["time_utc"] if frames else None,
        "grid": {
            "nx": NX,
            "ny": NY,
            "corner_nx": NX + 1,
            "corner_ny": NY + 1,
            "n": N_PER_FRAME,
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
        },
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

    print("[INFO] wet cells:", int(wet.sum()), "/", wet.size)
    print("[INFO] hs min/max:", float(np.nanmin(hs)), float(np.nanmax(hs)))
    print("[INFO] tp min/max:", float(np.nanmin(tp)), float(np.nanmax(tp)))
    print("[DONE]", out_dir / "meta.json")


if __name__ == "__main__":
    main()
