#!/usr/bin/env python3
import argparse
from pathlib import Path
from datetime import datetime, timezone

import h5py
import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt


def center_from_corners(a):
    return 0.25 * (
        a[:-1, :-1] +
        a[1:, :-1] +
        a[:-1, 1:] +
        a[1:, 1:]
    )


def to_2d(a):
    a = np.asarray(a)
    if a.ndim == 3 and a.shape[0] == 1:
        return a[0]
    if a.ndim == 2:
        return a
    raise ValueError(f"Unsupported shape: {a.shape}")


def read_time_iso(h5, name):
    t = np.asarray(h5[f"Time/{name}"][:], dtype=float).astype(int)
    yyyy, mm, dd, hh, mi, ss = t.tolist()
    dt = datetime(yyyy, mm, dd, hh, mi, ss, tzinfo=timezone.utc)
    return dt.strftime("%Y-%m-%d %H:%M UTC")


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
    elif varname == "water_level":
        bad |= a < -20.0
        bad |= a > 20.0
    elif varname in ("u", "v"):
        bad |= np.abs(a) > 10.0

    a[bad] = np.nan
    return a


def finite_range(arrs, qmin=2, qmax=98):
    vals = []
    for a in arrs:
        x = np.asarray(a)
        x = x[np.isfinite(x)]
        if x.size:
            vals.append(x)

    if not vals:
        return 0.0, 1.0

    vals = np.concatenate(vals)
    return float(np.nanpercentile(vals, qmin)), float(np.nanpercentile(vals, qmax))


def plot_one(ax, lon, lat, data, title, unit, vmin=None, vmax=None, cmap="turbo"):
    m = ax.pcolormesh(lon, lat, data, shading="auto", cmap=cmap, vmin=vmin, vmax=vmax)
    ax.set_title(title, fontsize=11)
    ax.set_xlabel("Longitude")
    ax.set_ylabel("Latitude")
    ax.set_aspect("equal", adjustable="box")
    cb = plt.colorbar(m, ax=ax, fraction=0.046, pad=0.04)
    cb.set_label(unit)
    return m


def main():
    parser = argparse.ArgumentParser(
        description="Plot all 25 MOHID Surface timesteps directly from HDF5."
    )
    parser.add_argument("--hydro", required=True, help="L2_Hydrodynamic_1_Surface_*.hdf5")
    parser.add_argument("--wq", required=True, help="L2_WaterProperties_1_Surface_*.hdf5")
    parser.add_argument("--output", default="quicklook_mohid", help="Output PNG directory")
    parser.add_argument("--dpi", type=int, default=160)
    args = parser.parse_args()

    hydro_path = Path(args.hydro)
    wq_path = Path(args.wq)
    outdir = Path(args.output)
    outdir.mkdir(parents=True, exist_ok=True)

    with h5py.File(hydro_path, "r") as hydro, h5py.File(wq_path, "r") as wq:
        lon_corner = np.asarray(hydro["Grid/Longitude"][:], dtype=np.float64)
        lat_corner = np.asarray(hydro["Grid/Latitude"][:], dtype=np.float64)

        lon = center_from_corners(lon_corner)
        lat = center_from_corners(lat_corner)

        mask = to_2d(hydro["Grid/WaterPoints3D"][:]).astype(np.int32)

        time_names = sorted(set(hydro["Time"].keys()) & set(wq["Time"].keys()))

        print(f"[INFO] hydro: {hydro_path}")
        print(f"[INFO] wq: {wq_path}")
        print(f"[INFO] frame count: {len(time_names)}")
        print(f"[INFO] output: {outdir}")

        # 먼저 전체 timestep을 읽어서 공통 color range 계산
        temps = []
        salts = []
        waters = []
        speeds = []

        cached = []

        for time_name in time_names:
            num = time_name.split("_")[-1]

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
            water = clean_var(
                to_2d(hydro[f"Results/water level/water level_{num}"][:]),
                mask,
                "water_level",
            )
            u = clean_var(
                to_2d(hydro[f"Results/velocity U/velocity U_{num}"][:]),
                mask,
                "u",
            )
            v = clean_var(
                to_2d(hydro[f"Results/velocity V/velocity V_{num}"][:]),
                mask,
                "v",
            )
            speed = np.sqrt(u * u + v * v).astype(np.float32)
            speed[~np.isfinite(speed)] = np.nan

            temps.append(temp)
            salts.append(salt)
            waters.append(water)
            speeds.append(speed)
            cached.append((time_name, temp, salt, water, speed))

        temp_vmin, temp_vmax = finite_range(temps)
        salt_vmin, salt_vmax = finite_range(salts)
        water_vmin, water_vmax = finite_range(waters)
        speed_vmin, speed_vmax = 0.0, finite_range(speeds, 2, 99)[1]

        print("[INFO] color ranges")
        print(f"  temperature : {temp_vmin:.3f} ~ {temp_vmax:.3f}")
        print(f"  salinity    : {salt_vmin:.3f} ~ {salt_vmax:.3f}")
        print(f"  water level : {water_vmin:.3f} ~ {water_vmax:.3f}")
        print(f"  speed       : {speed_vmin:.3f} ~ {speed_vmax:.3f}")

        for idx, (time_name, temp, salt, water, speed) in enumerate(cached):
            tstr = read_time_iso(hydro, time_name)

            fig, axes = plt.subplots(2, 2, figsize=(13, 11), constrained_layout=True)

            plot_one(
                axes[0, 0], lon, lat, temp,
                "Temperature", "degC",
                temp_vmin, temp_vmax, "turbo"
            )
            plot_one(
                axes[0, 1], lon, lat, salt,
                "Salinity", "psu",
                salt_vmin, salt_vmax, "viridis"
            )
            plot_one(
                axes[1, 0], lon, lat, water,
                "Water Level", "m",
                water_vmin, water_vmax, "coolwarm"
            )
            plot_one(
                axes[1, 1], lon, lat, speed,
                "Current Speed", "m/s",
                speed_vmin, speed_vmax, "plasma"
            )

            fig.suptitle(f"MOHID Surface Quicklook — {tstr}", fontsize=15)

            out = outdir / f"mohid_surface_{idx:04d}_{time_name}.png"
            fig.savefig(out, dpi=args.dpi)
            plt.close(fig)

            print(f"[WRITE] {out}")

    print("[DONE]")


if __name__ == "__main__":
    main()
