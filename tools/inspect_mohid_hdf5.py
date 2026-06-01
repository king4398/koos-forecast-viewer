#!/usr/bin/env python3
import argparse
from pathlib import Path

import h5py


def print_attrs(obj, indent="    "):
    if not obj.attrs:
        return

    for key, value in obj.attrs.items():
        try:
            print(f"{indent}@{key}: {value}")
        except Exception:
            print(f"{indent}@{key}: <unprintable>")


def inspect_file(path, show_attrs=False, max_items=None):
    path = Path(path)

    if not path.exists():
        raise FileNotFoundError(path)

    print("=" * 100)
    print(f"FILE: {path}")
    print("=" * 100)

    count = 0

    with h5py.File(path, "r") as f:
        if show_attrs:
            print("[ROOT ATTRIBUTES]")
            print_attrs(f)
            print()

        def visitor(name, obj):
            nonlocal count

            if max_items is not None and count >= max_items:
                return

            count += 1

            if isinstance(obj, h5py.Dataset):
                print(f"[DATASET] {name}")
                print(f"    shape: {obj.shape}")
                print(f"    dtype: {obj.dtype}")

                if show_attrs:
                    print_attrs(obj)

            elif isinstance(obj, h5py.Group):
                print(f"[GROUP]   {name}")

                if show_attrs:
                    print_attrs(obj)

        f.visititems(visitor)

    print()
    print(f"Total printed items: {count}")


def main():
    parser = argparse.ArgumentParser(
        description="Inspect MOHID HDF5 structure."
    )
    parser.add_argument(
        "files",
        nargs="+",
        help="MOHID HDF5 file paths."
    )
    parser.add_argument(
        "--attrs",
        action="store_true",
        help="Print HDF5 attributes."
    )
    parser.add_argument(
        "--max-items",
        type=int,
        default=None,
        help="Maximum number of HDF5 items to print per file."
    )

    args = parser.parse_args()

    for file_path in args.files:
        inspect_file(file_path, show_attrs=args.attrs, max_items=args.max_items)


if __name__ == "__main__":
    main()
