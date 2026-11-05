"""Baseline B0: the stratified ratio method.

VIIRS / MODIS count ratio per stratum (land cover x calendar month), fitted on
training years and applied to MODIS counts. This mirrors the pipeline's
"calibrate on the overlap, month by month" rule (Method tab, step 3). When the
pipeline's own implementation is available, import it here instead; its
interface is the same two functions.

Sparse strata shrink towards the land-cover ratio, then the global ratio
(pseudo-count PRIOR), so no stratum divides by ~0.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
import pandas as pd

PRIOR = 20.0


def modis_for(df: pd.DataFrame, head: str) -> np.ndarray:
    return (df["modis_terra"].fillna(0) if head == "t" else df["modis_n"]).to_numpy(dtype=float)


@dataclass
class StratifiedRatio:
    head: str = "ta"
    global_ratio: float = 1.0
    by_lc: dict[float, float] = field(default_factory=dict)
    by_stratum: dict[tuple[float, int], float] = field(default_factory=dict)

    def fit(self, df: pd.DataFrame) -> "StratifiedRatio":
        d = pd.DataFrame({"lc": df["lc_code"].to_numpy(), "month": df["month"].to_numpy(), "m": modis_for(df, self.head), "v": df["y_h"].to_numpy(dtype=float)})
        self.global_ratio = float(d["v"].sum() / max(d["m"].sum(), 1e-9))
        lc = d.groupby("lc")[["m", "v"]].sum()
        self.by_lc = {k: float((r.v + PRIOR * self.global_ratio) / (r.m + PRIOR)) for k, r in lc.iterrows()}
        st = d.groupby(["lc", "month"])[["m", "v"]].sum()
        self.by_stratum = {k: float((r.v + PRIOR * self.by_lc.get(k[0], self.global_ratio)) / (r.m + PRIOR)) for k, r in st.iterrows()}
        return self

    def ratio(self, df: pd.DataFrame) -> np.ndarray:
        keys = zip(df["lc_code"].to_numpy(), df["month"].to_numpy())
        return np.array([self.by_stratum.get(k, self.by_lc.get(k[0], self.global_ratio)) for k in keys])

    def predict(self, df: pd.DataFrame) -> np.ndarray:
        return self.ratio(df) * modis_for(df, self.head)
