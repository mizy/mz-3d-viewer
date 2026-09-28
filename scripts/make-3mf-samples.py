#!/usr/bin/env python3
"""Generates the committed 3MF samples: one in millimetres, one declaring the same numbers as inches.

Both describe the same 20mm cube as samples/obj/cube.obj (8 corners, 12 outward-wound triangles),
so the acceptance run can pin the unit conversion by comparing the two bounding-box readouts.

Run: python3 scripts/make-3mf-samples.py
"""

from pathlib import Path
import zipfile

CORNERS = [
    (-10, -10, -10), (10, -10, -10), (10, 10, -10), (-10, 10, -10),
    (-10, -10, 10), (10, -10, 10), (10, 10, 10), (-10, 10, 10),
]

# Counter-clockwise seen from outside, two triangles per face.
TRIANGLES = [
    (4, 5, 6), (4, 6, 7),      # +Z
    (1, 0, 3), (1, 3, 2),      # -Z
    (5, 1, 2), (5, 2, 6),      # +X
    (0, 4, 7), (0, 7, 3),      # -X
    (7, 6, 2), (7, 2, 3),      # +Y
    (0, 1, 5), (0, 5, 4),      # -Y
]

CONTENT_TYPES = """<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml" />
  <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml" />
</Types>
"""

RELS = """<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rel0" Target="/3D/3dmodel.model" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel" />
</Relationships>
"""


def model_xml(unit: str) -> str:
    vertices = "\n".join(f'          <vertex x="{x}" y="{y}" z="{z}" />' for x, y, z in CORNERS)
    triangles = "\n".join(f'          <triangle v1="{a}" v2="{b}" v3="{c}" />' for a, b, c in TRIANGLES)
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<model unit="{unit}" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
  <metadata name="Title">20mm cube ({unit})</metadata>
  <resources>
    <object id="1" type="model">
      <mesh>
        <vertices>
{vertices}
        </vertices>
        <triangles>
{triangles}
        </triangles>
      </mesh>
    </object>
  </resources>
  <build>
    <item objectid="1" />
  </build>
</model>
"""


def write_sample(path: Path, unit: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as package:
        # 3MF is an OPC package: content types and relationships first, then the model part.
        package.writestr("[Content_Types].xml", CONTENT_TYPES)
        package.writestr("_rels/.rels", RELS)
        package.writestr("3D/3dmodel.model", model_xml(unit))
    print(f"{path} ({path.stat().st_size} bytes, unit={unit})")


if __name__ == "__main__":
    target = Path(__file__).resolve().parent.parent / "samples" / "3mf"
    write_sample(target / "cube-10x10.3mf", "millimeter")
    write_sample(target / "inches.3mf", "inch")
