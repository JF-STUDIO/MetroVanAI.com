from pathlib import Path

import rawpy
import imageio.v2 as imageio

raw_path = Path("/Users/macbook/Desktop/40/_DSC0009.ARW")
out_path = raw_path.with_suffix(".test.jpg")

print("Decoding RAW:", raw_path)

with rawpy.imread(str(raw_path)) as raw:
    rgb = raw.postprocess()

imageio.imwrite(out_path, rgb, quality=95)
print("Saved JPG to:", out_path)
