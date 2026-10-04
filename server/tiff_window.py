"""Read a lat/lon window out of a remote GeoTIFF using HTTP range requests.

Population rasters (e.g. HRSL tiles) are hundreds of MB each; a city only needs a few hundred
rows of them. This reads the TIFF header, finds the strips/tiles that overlap
the requested window, downloads only those byte ranges and decodes them.

Supports: classic TIFF and BigTIFF, strips or tiles, compression none / LZW /
Deflate, predictor none / horizontal / floating-point, 32-bit float or int.
"""
from __future__ import annotations

import struct
import urllib.request
import zlib
from concurrent.futures import ProcessPoolExecutor

import numpy as np

UA = "ZombieSim/1.0 (local epidemic simulation research tool)"

TYPE_SIZES = {1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 16: 8, 17: 8, 18: 8}
TYPE_FMT = {1: "B", 2: "c", 3: "H", 4: "I", 5: "II", 6: "b", 7: "B", 8: "h", 9: "i", 10: "ii", 11: "f", 12: "d", 16: "Q", 17: "q", 18: "Q"}


def http_range(url: str, start: int, length: int, timeout: int = 120) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Range": f"bytes={start}-{start + length - 1}"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        data = r.read()
    if len(data) != length:
        # Server ignored the Range header and sent the whole file; slice it.
        if len(data) > start + length - 1:
            data = data[start:start + length]
        else:
            raise IOError(f"short range read: wanted {length} got {len(data)}")
    return data


# --------------------------------------------------------------------------- LZW

def lzw_decode(data: bytes, max_out: int | None = None) -> bytes:
    """TIFF-flavour LZW (MSB-first, 9-12 bit codes, 'early change')."""
    out = bytearray()
    table = [bytes([i]) for i in range(256)] + [b"", b""]
    code_len = 9
    bitbuf = 0
    bitcnt = 0
    prev = None
    n = len(data)
    pos = 0
    limit = max_out if max_out is not None else 1 << 62
    append = table.append
    while True:
        while bitcnt < code_len:
            if pos >= n:
                return bytes(out)
            bitbuf = (bitbuf << 8) | data[pos]
            pos += 1
            bitcnt += 8
        bitcnt -= code_len
        code = (bitbuf >> bitcnt) & ((1 << code_len) - 1)
        bitbuf &= (1 << bitcnt) - 1
        if code == 256:  # clear
            del table[258:]
            code_len = 9
            prev = None
            continue
        if code == 257:  # end of information
            break
        if prev is None:
            entry = table[code]
            out += entry
            prev = entry
        else:
            if code < len(table):
                entry = table[code]
                append(prev + entry[:1])
            else:
                entry = prev + prev[:1]
                append(entry)
            out += entry
            prev = entry
            nt = len(table)
            if nt >= 511 and code_len == 9:
                code_len = 10
            elif nt >= 1023 and code_len == 10:
                code_len = 11
            elif nt >= 2047 and code_len == 11:
                code_len = 12
        if len(out) >= limit:
            break
    return bytes(out)


def _decompress(args):
    blob, compression, max_out = args
    if compression == 1:
        return blob
    if compression == 5:
        return lzw_decode(blob, max_out)
    if compression in (8, 32946):
        d = zlib.decompressobj()
        return d.decompress(blob, max_out or 0)
    raise ValueError(f"unsupported TIFF compression {compression}")


# ----------------------------------------------------------------------- header

class RemoteTiff:
    def __init__(self, url: str):
        self.url = url
        head = http_range(url, 0, 1 << 16)
        self.bo = "<" if head[:2] == b"II" else ">"
        magic = struct.unpack(self.bo + "H", head[2:4])[0]
        self.big = magic == 43
        if self.big:
            ifd = struct.unpack(self.bo + "Q", head[8:16])[0]
        else:
            ifd = struct.unpack(self.bo + "I", head[4:8])[0]
        if ifd + 16 > len(head):
            head = http_range(url, 0, ifd + (1 << 16))
        self._head = head
        self.tags = self._parse_ifd(ifd)
        t = self.tags
        self.width = self._scalar(256)
        self.height = self._scalar(257)
        self.bps = self._scalar(258)
        self.compression = self._scalar(259, 1)
        self.predictor = self._scalar(317, 1)
        self.sample_format = self._scalar(339, 1)
        self.spp = self._scalar(277, 1)
        if self.spp != 1:
            raise ValueError("only single-band rasters supported")
        self.tiled = 322 in t
        if self.tiled:
            self.cw = self._scalar(322)
            self.ch = self._scalar(323)
            self.off_tag, self.cnt_tag = 324, 325
        else:
            self.cw = self.width
            self.ch = self._scalar(278, self.height)
            self.off_tag, self.cnt_tag = 273, 279
        sx, sy, _ = self._values(33550)
        tie = self._values(33922)
        self.sx, self.sy = sx, sy
        self.x0 = tie[3] - tie[0] * sx  # lon of left edge of pixel column 0
        self.y0 = tie[4] + tie[1] * sy  # lat of top edge of pixel row 0
        nd = self._values(42113) if 42113 in t else None
        self.nodata = float(nd.strip("\x00 ")) if nd else None
        if self.sample_format == 3:
            self.dtype = np.dtype(self.bo + {32: "f4", 64: "f8"}[self.bps])
        elif self.sample_format == 2:
            self.dtype = np.dtype(self.bo + {8: "i1", 16: "i2", 32: "i4"}[self.bps])
        else:
            self.dtype = np.dtype(self.bo + {8: "u1", 16: "u2", 32: "u4"}[self.bps])

    def _parse_ifd(self, off):
        bo, h = self.bo, self._head
        if self.big:
            n = struct.unpack(bo + "Q", h[off:off + 8])[0]
            p, esz = off + 8, 20
        else:
            n = struct.unpack(bo + "H", h[off:off + 2])[0]
            p, esz = off + 2, 12
        tags = {}
        for i in range(n):
            e = h[p + i * esz:p + (i + 1) * esz]
            if self.big:
                tag, typ, cnt = struct.unpack(bo + "HHQ", e[:12])
                raw = e[12:20]
                inline = TYPE_SIZES[typ] * cnt <= 8
                ptr = None if inline else struct.unpack(bo + "Q", raw)[0]
            else:
                tag, typ, cnt = struct.unpack(bo + "HHI", e[:8])
                raw = e[8:12]
                inline = TYPE_SIZES[typ] * cnt <= 4
                ptr = None if inline else struct.unpack(bo + "I", raw)[0]
            tags[tag] = (typ, cnt, raw, ptr)
        return tags

    def _bytes_for(self, tag, first=0, count=None):
        typ, cnt, raw, ptr = self.tags[tag]
        sz = TYPE_SIZES[typ]
        count = cnt - first if count is None else count
        if ptr is None:
            return raw[first * sz:(first + count) * sz]
        start = ptr + first * sz
        if start + count * sz <= len(self._head):
            return self._head[start:start + count * sz]
        return http_range(self.url, start, count * sz)

    def _values(self, tag, first=0, count=None):
        typ, cnt, _, _ = self.tags[tag]
        b = self._bytes_for(tag, first, count)
        if typ == 2:
            return b.decode("latin1")
        n = len(b) // TYPE_SIZES[typ]
        return list(struct.unpack(self.bo + TYPE_FMT[typ] * n, b))

    def _scalar(self, tag, default=None):
        if tag not in self.tags:
            return default
        return self._values(tag, 0, 1)[0]

    # ------------------------------------------------------------------ window
    def read_window(self, lat_min, lat_max, lon_min, lon_max, workers=6):
        """Return (array, lat_top, lon_left) covering the bbox; nodata -> NaN."""
        c0 = max(0, int((lon_min - self.x0) / self.sx))
        c1 = min(self.width - 1, int((lon_max - self.x0) / self.sx) + 1)
        r0 = max(0, int((self.y0 - lat_max) / self.sy))
        r1 = min(self.height - 1, int((self.y0 - lat_min) / self.sy) + 1)
        if c1 < c0 or r1 < r0:
            raise ValueError("bbox outside raster")
        out = np.full((r1 - r0 + 1, c1 - c0 + 1), np.nan, dtype=np.float32)

        chunks_across = (self.width + self.cw - 1) // self.cw
        cr0, cr1 = r0 // self.ch, r1 // self.ch
        cc0, cc1 = c0 // self.cw, c1 // self.cw
        ids = []
        for cr in range(cr0, cr1 + 1):
            for cc in range(cc0, cc1 + 1):
                ids.append((cr, cc, cr * chunks_across + cc))

        # offsets / counts for just these chunks, fetched as contiguous runs
        idx_min = min(i for _, _, i in ids)
        idx_max = max(i for _, _, i in ids)
        offs = self._values(self.off_tag, idx_min, idx_max - idx_min + 1)
        cnts = self._values(self.cnt_tag, idx_min, idx_max - idx_min + 1)
        info = [(cr, cc, offs[i - idx_min], cnts[i - idx_min]) for cr, cc, i in ids]

        # download: group chunks into large contiguous byte runs (<= 64 MB)
        info.sort(key=lambda t: t[2])
        blobs = {}
        run = []
        def flush(run):
            if not run:
                return
            start = run[0][2]
            end = max(o + n for _, _, o, n in run)
            data = http_range(self.url, start, end - start, timeout=600)
            for cr, cc, o, n in run:
                blobs[(cr, cc)] = data[o - start:o - start + n]
        for item in info:
            if item[3] == 0:
                continue
            if run and (item[2] - (run[-1][2] + run[-1][3]) > (1 << 20) or item[2] + item[3] - run[0][2] > (64 << 20)):
                flush(run)
                run = []
            run.append(item)
        flush(run)

        itemsize = self.dtype.itemsize
        jobs, keys = [], []
        for (cr, cc), blob in blobs.items():
            rows_in_chunk = min(self.ch, self.height - cr * self.ch) if not self.tiled else self.ch
            if not self.tiled and rows_in_chunk == 1 and self.predictor == 1:
                max_out = (c1 + 1) * itemsize  # we can stop decoding past our last column
            else:
                max_out = rows_in_chunk * self.cw * itemsize
            jobs.append((blob, self.compression, max_out))
            keys.append((cr, cc, rows_in_chunk))
        if self.compression == 5 and len(jobs) > 8:
            with ProcessPoolExecutor(max_workers=workers) as ex:
                decoded = list(ex.map(_decompress, jobs, chunksize=16))
        else:
            decoded = [_decompress(j) for j in jobs]

        for (cr, cc, nrows), raw in zip(keys, decoded):
            full_w = self.cw
            if self.predictor == 1 and not self.tiled and nrows == 1:
                ncols = len(raw) // itemsize
                arr = np.frombuffer(raw[:ncols * itemsize], dtype=self.dtype).reshape(1, ncols)
            else:
                need = nrows * full_w * itemsize
                raw = raw[:need].ljust(need, b"\0")
                arr = self._unpredict(raw, nrows, full_w)
            gr0, gc0 = cr * self.ch, cc * self.cw
            # intersect chunk with window
            a_r0, a_r1 = max(r0, gr0), min(r1, gr0 + arr.shape[0] - 1)
            a_c0, a_c1 = max(c0, gc0), min(c1, gc0 + arr.shape[1] - 1)
            if a_r1 < a_r0 or a_c1 < a_c0:
                continue
            out[a_r0 - r0:a_r1 - r0 + 1, a_c0 - c0:a_c1 - c0 + 1] = \
                arr[a_r0 - gr0:a_r1 - gr0 + 1, a_c0 - gc0:a_c1 - gc0 + 1].astype(np.float32)

        if self.nodata is not None:
            out[out == np.float32(self.nodata)] = np.nan
        out[out < -1e30] = np.nan
        lat_top = self.y0 - r0 * self.sy
        lon_left = self.x0 + c0 * self.sx
        return out, lat_top, lon_left

    def _unpredict(self, raw, nrows, w):
        isz = self.dtype.itemsize
        if self.predictor == 1:
            return np.frombuffer(raw, dtype=self.dtype).reshape(nrows, w)
        if self.predictor == 2:
            a = np.frombuffer(raw, dtype=self.dtype).reshape(nrows, w)
            return np.cumsum(a, axis=1, dtype=self.dtype)
        if self.predictor == 3:
            b = np.frombuffer(raw, dtype=np.uint8).reshape(nrows, w * isz)
            b = np.cumsum(b, axis=1, dtype=np.uint8)
            b = b.reshape(nrows, isz, w).transpose(0, 2, 1)  # byte planes -> per-sample
            b = np.ascontiguousarray(b).reshape(nrows, w * isz)
            return np.frombuffer(b.tobytes(), dtype=np.dtype(">" + self.dtype.str[1:])).reshape(nrows, w)
        raise ValueError(f"unsupported predictor {self.predictor}")
