#!/usr/bin/env python3
import argparse
import json
import re
import shutil
from datetime import datetime, timezone
from pathlib import Path

import h5py
import numpy as np


HYDRO_PATTERN = "L2_Hydrodynamic_1_Surface_*.hdf5"
WQ_PATTERN = "L2_WaterProperties_1_Surface_*.hdf5"

# SCHISM viewer 기준 컬러바 범위
DISPLAY_RANGES = {
    "temperature": {"vmin": 0.0, "vmax": 32.0, "cmap": "jet"},
    "salinity": {"vmin": 25.0, "vmax": 35.0, "cmap": "ylgnbu"},
    "ssh": {"vmin": -1.0, "vmax": 1.0, "cmap": "bwr"},
    "current_speed": {"vmin": 0.0, "vmax": 1.0, "cmap": "jet"},
}


def parse_cycle_from_name(path: Path) -> str:
    m = re.search(r"(\d{10})", path.name)
    if not m:
        raise ValueError(f"Cannot parse cycle from filename: {path.name}")
    return m.group(1)


def cycle_to_iso(cycle: str) -> str:
    dt = datetime.strptime(cycle, "%Y%m%d%H").replace(tzinfo=timezone.utc)
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def find_latest_pair(input_dir: Path, cycle=None):
    hydro_files = sorted(input_dir.glob(HYDRO_PATTERN))
    wq_files = sorted(input_dir.glob(WQ_PATTERN))

    hydro_by_cycle = {parse_cycle_from_name(p): p for p in hydro_files}
    wq_by_cycle = {parse_cycle_from_name(p): p for p in wq_files}
    common = sorted(set(hydro_by_cycle) & set(wq_by_cycle))

    if not common:
        raise FileNotFoundError(f"No common MOHID Surface pair in {input_dir}")

    if cycle is None:
        cycle = common[-1]

    if cycle not in common:
        raise FileNotFoundError(f"Cycle {cycle} does not have both Surface files.")

    return cycle, hydro_by_cycle[cycle], wq_by_cycle[cycle]


def center_from_corners(a):
    return 0.25 * (
        a[:-1, :-1]
        + a[1:, :-1]
        + a[:-1, 1:]
        + a[1:, 1:]
    )


def to_2d(a):
    a = np.asarray(a)
    if a.ndim == 3 and a.shape[0] == 1:
        return a[0]
    if a.ndim == 2:
        return a
    raise ValueError(f"Unsupported shape: {a.shape}")


def read_time_iso(h5, time_name):
    t = np.asarray(h5[f"Time/{time_name}"][:], dtype=float).astype(int)
    yyyy, mm, dd, hh, mi, ss = t.tolist()
    dt = datetime(yyyy, mm, dd, hh, mi, ss, tzinfo=timezone.utc)
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def clean_var(a, mask=None, varname=""):
    a = np.asarray(a, dtype=np.float32)

    bad = ~np.isfinite(a)
    bad |= a < -1.0e10
    bad |= a > 1.0e10

    if mask is not None:
        bad |= mask <= 0

    if varname == "temperature":
        bad |= a < -5.0
        bad |= a > 45.0
    elif varname == "salinity":
        bad |= a < 0.1
        bad |= a > 45.0
    elif varname == "ssh":
        bad |= a < -20.0
        bad |= a > 20.0
    elif varname in ("current_u", "current_v"):
        bad |= np.abs(a) > 10.0
    elif varname == "bathymetry":
        bad |= a < 0.0
        bad |= a > 12000.0

    a[bad] = np.nan
    return a.astype(np.float32)


def write_bin(path, arr):
    arr = np.asarray(arr, dtype=np.float32)
    arr.tofile(path)


def finite_minmax(arr):
    x = np.asarray(arr, dtype=np.float32)
    x = x[np.isfinite(x)]
    if x.size == 0:
        return None
    return {"min": float(np.nanmin(x)), "max": float(np.nanmax(x))}


def update_actual_range(ranges, key, arr):
    r = finite_minmax(arr)
    if r is None:
        return

    if key not in ranges:
        ranges[key] = r
    else:
        ranges[key]["min"] = min(ranges[key]["min"], r["min"])
        ranges[key]["max"] = max(ranges[key]["max"], r["max"])


def reset_output(output_dir: Path):
    output_dir.mkdir(parents=True, exist_ok=True)

    for sub in [
        "grid",
        "temperature",
        "salinity",
        "ssh",
        "current_u",
        "current_v",
        "current_speed",
    ]:
        d = output_dir / sub
        if d.exists():
            shutil.rmtree(d)
        d.mkdir(parents=True, exist_ok=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--cycle", default=None)
    args = parser.parse_args()

    input_dir = Path(args.input)
    output_dir = Path(args.output)

    cycle, hydro_path, wq_path = find_latest_pair(input_dir, args.cycle)

    print(f"[INFO] cycle: {cycle}")
    print(f"[INFO] hydro: {hydro_path}")
    print(f"[INFO] wq: {wq_path}")

    reset_output(output_dir)

    actual_ranges = {}
    frames = []

    with h5py.File(hydro_path, "r") as hydro, h5py.File(wq_path, "r") as wq:
        lon_corner = np.asarray(hydro["Grid/Longitude"][:], dtype=np.float64)
        lat_corner = np.asarray(hydro["Grid/Latitude"][:], dtype=np.float64)

        lon = center_from_corners(lon_corner).astype(np.float32)
        lat = center_from_corners(lat_corner).astype(np.float32)

        mask = to_2d(hydro["Grid/WaterPoints3D"][:]).astype(np.int32)
        mask = (mask > 0).astype(np.float32)

        bathy = clean_var(hydro["Grid/Bathymetry"][:], mask, "bathymetry")

        ny, nx = mask.shape

        write_bin(output_dir / "grid" / "lon.bin", lon)
        write_bin(output_dir / "grid" / "lat.bin", lat)
        write_bin(output_dir / "grid" / "mask.bin", mask)
        write_bin(output_dir / "grid" / "bathymetry.bin", bathy)

        time_names = sorted(set(hydro["Time"].keys()) & set(wq["Time"].keys()))

        for idx, time_name in enumerate(time_names):
            num = time_name.split("_")[-1]
            time_utc = read_time_iso(hydro, time_name)

            u = clean_var(
                to_2d(hydro[f"Results/velocity U/velocity U_{num}"][:]),
                mask,
                "current_u",
            )
            v = clean_var(
                to_2d(hydro[f"Results/velocity V/velocity V_{num}"][:]),
                mask,
                "current_v",
            )
            ssh = clean_var(
                to_2d(hydro[f"Results/water level/water level_{num}"][:]),
                mask,
                "ssh",
            )
            temp = clean_var(
                to_2d(wq[f"Results/temperature/temperature_{num}"][:]),
                mask,
                "temperature",
            )
            salt = clean_var(
                to_2d(wq[f"Results/salinity/salinity_{num}"][:]),
                mask,
                "salinity",
            )

            speed = np.sqrt(u * u + v * v).astype(np.float32)
            speed[~np.isfinite(speed)] = np.nan

            frame_file = f"frame_{idx:04d}.bin"

            write_bin(output_dir / "temperature" / frame_file, temp)
            write_bin(output_dir / "salinity" / frame_file, salt)
            write_bin(output_dir / "ssh" / frame_file, ssh)
            write_bin(output_dir / "current_u" / frame_file, u)
            write_bin(output_dir / "current_v" / frame_file, v)
            write_bin(output_dir / "current_speed" / frame_file, speed)

            update_actual_range(actual_ranges, "temperature", temp)
            update_actual_range(actual_ranges, "salinity", salt)
            update_actual_range(actual_ranges, "ssh", ssh)
            update_actual_range(actual_ranges, "current_u", u)
            update_actual_range(actual_ranges, "current_v", v)
            update_actual_range(actual_ranges, "current_speed", speed)

            frames.append({
                "index": idx,
                "name": time_name,
                "time_utc": time_utc,
                "label": time_utc.replace("T", " ").replace("Z", " UTC"),
                "files": {
                    "temperature": f"temperature/{frame_file}",
                    "salinity": f"salinity/{frame_file}",
                    "ssh": f"ssh/{frame_file}",
                    "current_u": f"current_u/{frame_file}",
                    "current_v": f"current_v/{frame_file}",
                    "current_speed": f"current_speed/{frame_file}"
                }
            })

            print(f"[WRITE] {idx:04d} {time_utc}")

    meta = {
        "format": "koos-mohid-regular-grid-v1",
        "system": "KOOS",
        "model": "MOHID",
        "cycle": cycle,
        "cycle_utc": cycle_to_iso(cycle),
        "forecast_start_utc": frames[0]["time_utc"] if frames else None,
        "forecast_end_utc": frames[-1]["time_utc"] if frames else None,
        "source_files": {
            "hydrodynamic": hydro_path.name,
            "water_properties": wq_path.name
        },
        "grid": {
            "nx": int(nx),
            "ny": int(ny),
            "lon_min": float(np.nanmin(lon)),
            "lon_max": float(np.nanmax(lon)),
            "lat_min": float(np.nanmin(lat)),
            "lat_max": float(np.nanmax(lat)),
            "lon_file": "grid/lon.bin",
            "lat_file": "grid/lat.bin",
            "mask_file": "grid/mask.bin",
            "bathymetry_file": "grid/bathymetry.bin"
        },
        "frames": frames,
        "variables": {
            "temperature": {
                "label": "Temperature",
                "label_ko": "수온",
                "unit": "degC",
                "vmin": DISPLAY_RANGES["temperature"]["vmin"],
                "vmax": DISPLAY_RANGES["temperature"]["vmax"],
                "cmap": DISPLAY_RANGES["temperature"]["cmap"],
                "actual_range": actual_ranges.get("temperature")
            },
            "salinity": {
                "label": "Salinity",
                "label_ko": "염분",
                "unit": "psu",
                "vmin": DISPLAY_RANGES["salinity"]["vmin"],
                "vmax": DISPLAY_RANGES["salinity"]["vmax"],
                "cmap": DISPLAY_RANGES["salinity"]["cmap"],
                "actual_range": actual_ranges.get("salinity")
            },
            "ssh": {
                "label": "Elevation",
                "label_ko": "수위",
                "unit": "m",
                "vmin": DISPLAY_RANGES["ssh"]["vmin"],
                "vmax": DISPLAY_RANGES["ssh"]["vmax"],
                "cmap": DISPLAY_RANGES["ssh"]["cmap"],
                "actual_range": actual_ranges.get("ssh")
            },
            "current_speed": {
                "label": "Current Speed",
                "label_ko": "유속",
                "unit": "m/s",
                "vmin": DISPLAY_RANGES["current_speed"]["vmin"],
                "vmax": DISPLAY_RANGES["current_speed"]["vmax"],
                "cmap": DISPLAY_RANGES["current_speed"]["cmap"],
                "actual_range": actual_ranges.get("current_speed")
            },
            "current_u": {
                "label": "Current U",
                "label_ko": "동서 유속",
                "unit": "m/s",
                "actual_range": actual_ranges.get("current_u")
            },
            "current_v": {
                "label": "Current V",
                "label_ko": "남북 유속",
                "unit": "m/s",
                "actual_range": actual_ranges.get("current_v")
            }
        }
    }

    (output_dir / "meta.json").write_text(
        json.dumps(meta, indent=2, ensure_ascii=False),
        encoding="utf-8"
    )

    latest = {
        "system": "KOOS",
        "latest_model": "mohid",
        "latest_cycle_utc": meta["cycle_utc"],
        "models": {
            "mohid": {
                "enabled": True,
                "meta": "data/mohid/meta.json"
            },
            "wrf": {
                "enabled": False,
                "meta": "data/wrf/meta.json"
            },
            "swan": {
                "enabled": False,
                "meta": "data/swan/meta.json"
            }
        }
    }

    latest_path = output_dir.parent / "latest.json"
    latest_path.write_text(
        json.dumps(latest, indent=2, ensure_ascii=False),
        encoding="utf-8"
    )

    print(f"[DONE] {output_dir / 'meta.json'}")
    print(f"[DONE] {latest_path}")


if __name__ == "__main__":
    main()
