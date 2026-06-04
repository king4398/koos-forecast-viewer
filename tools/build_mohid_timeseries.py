#!/usr/bin/env python3
# -*- coding: utf-8 -*-

import argparse
import json
from pathlib import Path

import numpy as np


def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("--data-dir", default="data/mohid")
    p.add_argument(
        "--variables",
        nargs="+",
        default=["temperature", "salinity", "ssh", "current_speed"],
        help="Variables to build point time-series bins for",
    )
    return p.parse_args()


def read_float32(path, expected_len=None):
    arr = np.fromfile(path, dtype=np.float32)

    if expected_len is not None and arr.size != expected_len:
        raise ValueError(f"{path}: {arr.size} != {expected_len}")

    return arr


def write_variable_timeseries(data_dir, meta, var_name, out_dir):
    frames = meta.get("frames", [])
    grid = meta.get("grid", {})

    nx = int(grid["nx"])
    ny = int(grid["ny"])
    ncell = nx * ny
    nt = len(frames)

    if nt <= 0:
        raise RuntimeError("No frames in meta.json")

    print(f"[INFO] variable={var_name}, nt={nt}, ncell={ncell}")

    stack = np.empty((nt, ncell), dtype=np.float32)

    for it, frame in enumerate(frames):
        files = frame.get("files", {})

        if var_name not in files:
            raise KeyError(f"frame {it}: missing files['{var_name}']")

        f = data_dir / files[var_name]
        arr = read_float32(f, ncell)

        stack[it, :] = arr

        if it % 24 == 0 or it == nt - 1:
            print(f"  [READ] {var_name} frame {it + 1}/{nt}")

    # cell-major:
    # [cell0_t0, cell0_t1, ... cell0_tN,
    #  cell1_t0, cell1_t1, ...]
    out = stack.T.copy()

    out_file = out_dir / f"{var_name}_ts.bin"
    out.tofile(out_file)

    print(f"  [DONE] {out_file} ({out_file.stat().st_size / 1024 / 1024:.2f} MB)")

    return {
        "file": f"timeseries/{var_name}_ts.bin",
        "count": int(nt),
    }


def main():
    args = parse_args()

    data_dir = Path(args.data_dir)
    meta_path = data_dir / "meta.json"
    out_dir = data_dir / "timeseries"

    out_dir.mkdir(parents=True, exist_ok=True)

    meta = json.loads(meta_path.read_text(encoding="utf-8"))

    grid = meta.get("grid", {})
    nx = int(grid["nx"])
    ny = int(grid["ny"])
    ncell = nx * ny
    nt = len(meta.get("frames", []))

    variables_meta = {}

    for var_name in args.variables:
      if var_name not in meta.get("variables", {}):
          print(f"[WARN] skip {var_name}: not found in meta.variables")
          continue

      variables_meta[var_name] = write_variable_timeseries(
          data_dir=data_dir,
          meta=meta,
          var_name=var_name,
          out_dir=out_dir,
      )

    meta["timeseries"] = {
        "layout": "cell_major",
        "dtype": "float32",
        "n": int(ncell),
        "nt": int(nt),
        "variables": variables_meta,
    }

    meta_path.write_text(
        json.dumps(meta, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )

    print("[DONE] updated", meta_path)
    print("[INFO] variables:", ", ".join(variables_meta.keys()))


if __name__ == "__main__":
    main()
