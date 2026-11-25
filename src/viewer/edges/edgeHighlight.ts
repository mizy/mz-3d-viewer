import * as THREE from "three/webgpu";
import { LineSegments2 } from "three/addons/lines/webgpu/LineSegments2.js";
import { LineSegmentsGeometry } from "three/addons/lines/LineSegmentsGeometry.js";
import { createEdgeMaterial, sameEdge, type EdgeHit } from "./buildEdges";

/** @entry Own the small overlay for one picked edge. It borrows the source line's transform. */
export class EdgeHighlight {
  private hit: EdgeHit | null = null;
  private line: LineSegments2 | null = null;
  private readonly material: THREE.Line2NodeMaterial;

  constructor(private readonly root: THREE.Object3D, color: number, private readonly width: number) {
    this.material = createEdgeMaterial(width, color);
    this.material.polygonOffsetFactor = -3;
    this.material.polygonOffsetUnits = -8;
  }

  set(hit: EdgeHit | null, visible: boolean, edgeWidth: number): void {
    if (!sameEdge(this.hit, hit)) {
      this.clear();
      this.hit = hit;
      if (hit !== null) {
        const start = hit.line.geometry.getAttribute("instanceStart");
        const end = hit.line.geometry.getAttribute("instanceEnd");
        const positions = new Float32Array(hit.count * 6);
        for (let i = 0; i < hit.count; i++) {
          const segment = hit.start + i;
          positions.set([start.getX(segment), start.getY(segment), start.getZ(segment),
            end.getX(segment), end.getY(segment), end.getZ(segment)], i * 6);
        }
        const geometry = new LineSegmentsGeometry().setPositions(positions);
        const line = new LineSegments2(geometry, this.material);
        line.matrixAutoUpdate = false;
        line.matrixWorldAutoUpdate = false;
        line.matrixWorld = hit.line.matrixWorld;
        line.renderOrder = 2;
        this.root.add(line);
        this.line = line;
      }
    }
    if (this.line !== null) {
      this.line.visible = visible;
      this.material.linewidth = Math.max(this.width, edgeWidth + 1);
    }
  }

  private clear(): void {
    this.hit = null;
    if (this.line === null) return;
    this.root.remove(this.line);
    this.line.geometry.dispose();
    this.line = null;
  }

  dispose(): void {
    this.clear();
    this.material.dispose();
  }
}
